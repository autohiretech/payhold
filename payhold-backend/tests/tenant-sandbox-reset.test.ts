/**
 * `reset_tenant_sandbox` — a tenant's own "start over".
 *
 * Three things worth pinning: it actually clears what it claims to, it
 * refuses permanently once `went_live_at` is stamped, and the bypass it
 * opens in the ledger's append-only trigger does not leak to an ordinary
 * caller once the function returns.
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { migrated, rejects, type Harness } from './harness'

let h: Harness

beforeAll(async () => {
  h = await migrated()
})

afterAll(() => h.close())

async function newTenant(slug: string): Promise<string> {
  const { rows: [t] } = await h.db.query<{ id: string }>(
    `insert into tenants (name, slug) values ($1, $1) returning id`,
    [slug],
  )
  return t.id
}

async function newSeller(tenant: string): Promise<string> {
  const { rows: [s] } = await h.db.query<{ id: string }>(
    `insert into sellers (tenant_id, name, country, payout_currency,
                          payout_provider, beneficiary_token, masked_destination)
     values ($1, 'Seller', 'RW', 'RWF', 'flutterwave_momo',
             'tok_' || gen_random_uuid(), 'MTN •••• 4821')
     returning id`,
    [tenant],
  )
  return s.id
}

/** A funded, released, paid-out deal — the full shape, ledger and all. */
async function fullDeal(tenant: string, seller: string): Promise<string> {
  const { rows: [d] } = await h.db.query<{ id: string }>(
    `insert into deals (tenant_id, buyer_ref, seller_id, description, amount, currency,
                        presentment_currency, presentment_amount, buyer_country,
                        provider, fee_amount, status, released_at)
     values ($1, 'buyer_1', $2, 'A rental', 100000, 'RWF', 'RWF', 100000, 'RW',
             'fake', 10000, 'released', now())
     returning id`,
    [tenant, seller],
  )
  await h.db.query(
    `select write_ledger(d, 'hold', 100000) from deals d where d.id = $1`,
    [d.id],
  )
  await h.db.query(
    `select write_audit($1, $2, 'user:test@example.com', 'deal.created', '{}'::jsonb)`,
    [tenant, d.id],
  )
  return d.id
}

async function counts(tenant: string) {
  const tables = ['deals', 'sellers', 'ledger', 'audit_log', 'payouts', 'refunds']
  const out: Record<string, number> = {}
  for (const table of tables) {
    const { rows: [r] } = await h.db.query<{ n: string }>(
      `select count(*)::text as n from ${table} where tenant_id = $1`,
      [tenant],
    )
    out[table] = Number(r.n)
  }
  return out
}

describe('reset_tenant_sandbox', () => {
  test('clears a tenant\'s deals, sellers and ledger, and leaves one audit row behind', async () => {
    const tenant = await newTenant('reset-me')
    const seller = await newSeller(tenant)
    await fullDeal(tenant, seller)

    const before = await counts(tenant)
    expect(before.deals).toBe(1)
    expect(before.sellers).toBe(1)
    expect(before.ledger).toBeGreaterThan(0)
    expect(before.audit_log).toBeGreaterThan(0)

    await h.db.query(`select reset_tenant_sandbox($1, 'user:owner@example.com')`, [tenant])

    const after = await counts(tenant)
    expect(after.deals).toBe(0)
    expect(after.sellers).toBe(0)
    expect(after.ledger).toBe(0)
    expect(after.payouts).toBe(0)
    expect(after.refunds).toBe(0)
    // Exactly the reset's own record — the wipe cleared the old audit trail
    // and then wrote the one row saying it happened.
    expect(after.audit_log).toBe(1)

    const { rows: [row] } = await h.db.query<{ action: string; actor: string }>(
      `select action, actor from audit_log where tenant_id = $1`,
      [tenant],
    )
    expect(row.action).toBe('tenant.sandbox_reset')
    expect(row.actor).toBe('user:owner@example.com')
  })

  test('leaves the tenant, its users and its settings untouched', async () => {
    const tenant = await newTenant('reset-keeps-config')
    await h.db.query(
      `insert into settings (tenant_id, key, value) values ($1, 'service_fee_rate', '0.2')`,
      [tenant],
    )
    await h.db.query(
      `insert into tenant_provider_accounts (tenant_id, provider, encrypted_credentials, mode)
       values ($1, 'flutterwave', 'sealed', 'test')`,
      [tenant],
    )

    await h.db.query(`select reset_tenant_sandbox($1, 'user:owner@example.com')`, [tenant])

    const { rows: [t] } = await h.db.query<{ id: string }>(
      `select id from tenants where id = $1`, [tenant],
    )
    expect(t.id).toBe(tenant)

    const { rows: settingsRows } = await h.db.query(
      `select 1 from settings where tenant_id = $1`, [tenant],
    )
    expect(settingsRows.length).toBe(1)

    const { rows: providerRows } = await h.db.query(
      `select 1 from tenant_provider_accounts where tenant_id = $1`, [tenant],
    )
    expect(providerRows.length).toBe(1)
  })

  test('refuses permanently once the tenant has ever gone live', async () => {
    const tenant = await newTenant('went-live')
    await h.db.query(
      `update tenants set went_live_at = now() - interval '1 day' where id = $1`,
      [tenant],
    )

    await rejects(
      () => h.db.query(`select reset_tenant_sandbox($1, 'user:owner@example.com')`, [tenant]),
      /policy_violation.*live/,
    )
  })

  test('refuses a blank actor', async () => {
    const tenant = await newTenant('blank-actor')
    await rejects(
      () => h.db.query(`select reset_tenant_sandbox($1, '')`, [tenant]),
      /policy_violation.*named actor/,
    )
  })

  test('does not touch another tenant\'s rows', async () => {
    const a = await newTenant('reset-a')
    const b = await newTenant('reset-b')
    const sellerA = await newSeller(a)
    const sellerB = await newSeller(b)
    await fullDeal(a, sellerA)
    await fullDeal(b, sellerB)

    await h.db.query(`select reset_tenant_sandbox($1, 'user:owner@example.com')`, [a])

    expect((await counts(a)).deals).toBe(0)
    expect((await counts(b)).deals).toBe(1)
  })

  test('the ledger stays append-only for everybody else once the reset returns', async () => {
    const tenant = await newTenant('bypass-does-not-leak')
    const seller = await newSeller(tenant)
    await fullDeal(tenant, seller)
    await h.db.query(`select reset_tenant_sandbox($1, 'user:owner@example.com')`, [tenant])

    // A fresh entry, then an ordinary delete attempt — the bypass this
    // function used must not still be armed.
    const { rows: [d] } = await h.db.query<{ id: string }>(
      `insert into deals (tenant_id, buyer_ref, seller_id, description, amount, currency,
                          presentment_currency, presentment_amount, buyer_country,
                          provider, fee_amount, status)
       values ($1, 'buyer_2', $2, 'Another rental', 50000, 'RWF', 'RWF', 50000, 'RW',
               'fake', 0, 'created')
       returning id`,
      [tenant, await newSeller(tenant)],
    )
    await h.db.query(
      `select write_ledger(d, 'hold', 50000) from deals d where d.id = $1`, [d.id],
    )

    await rejects(
      () => h.db.query(`delete from ledger where deal_id = $1`, [d.id]),
      /append-only/,
    )
  })
})
