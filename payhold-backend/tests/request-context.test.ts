/**
 * Where a payment came from, against a real Postgres — spec §6.
 *
 * The parsing that guards the `inet` column is a Deno test
 * (`functions/_shared/request-context.test.ts`). What is here is what only the
 * database can be asked: that the tenant is derived rather than trusted, that
 * recording is incapable of failing a payment, and that the model's read role
 * cannot see any of it.
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { migrated, type Harness } from './harness'

let h: Harness

interface Seeded {
  tenant: string
  seller: string
  deal: string
}

async function seed(): Promise<Seeded> {
  const { rows: [tenant] } = await h.db.query<{ id: string }>(
    `insert into tenants (name, slug) values ('Acme', 'acme-' || gen_random_uuid())
     returning id`,
  )
  const { rows: [seller] } = await h.db.query<{ id: string }>(
    `insert into sellers (tenant_id, name, country, payout_currency, payout_provider,
                          beneficiary_token, masked_destination)
     values ($1, 'Host', 'RW', 'RWF', 'flutterwave_momo', 'tok_1', 'MTN •••• 4821')
     returning id`,
    [tenant.id],
  )
  const { rows: [deal] } = await h.db.query<{ id: string }>(
    `insert into deals (tenant_id, buyer_ref, seller_id, description, amount, currency,
                        presentment_currency, presentment_amount, buyer_country,
                        provider, provider_ref, status, fee_amount)
     values ($1, 'buyer-1', $2, 'Excavator hire', 100000, 'RWF', 'RWF', 100000, 'RW',
             'fake', 'ref-' || gen_random_uuid(), 'funded_held', 10000)
     returning id`,
    [tenant.id, seller.id],
  )
  return { tenant: tenant.id, seller: seller.id, deal: deal.id }
}

const contextFor = async (deal: string) => {
  const { rows } = await h.db.query<{
    tenant_id: string
    source: string
    event: string
    ip: string | null
    ip_country: string | null
    user_agent: string | null
  }>(
    `select tenant_id, source, event, host(ip) as ip, ip_country, user_agent
       from request_context where deal_id = $1 order by created_at, source`,
    [deal],
  )
  return rows
}

beforeAll(async () => { h = await migrated() }, 120_000)
afterAll(async () => { await h?.close() })

describe('recording an observation', () => {
  test('the tenant comes from the deal, not from the caller', async () => {
    const mine = await seed()
    const theirs = await seed()

    await h.db.query(
      `select record_request_context($1, 'provider', 'charge_confirmed', '41.186.0.42', 'RW', 'curl/8')`,
      [mine.deal],
    )

    const rows = await contextFor(mine.deal)
    expect(rows).toHaveLength(1)
    // Nothing in the signature lets a caller file a buyer's address under
    // somebody else's account.
    expect(rows[0].tenant_id).toBe(mine.tenant)
    expect(rows[0].tenant_id).not.toBe(theirs.tenant)
  })

  test('all three sources are recorded distinctly', async () => {
    const s = await seed()

    for (const source of ['provider', 'hosted_page', 'client_attested']) {
      await h.db.query(
        `select record_request_context($1, $2::request_context_source, 'pay_started', '41.186.0.42')`,
        [s.deal, source],
      )
    }

    const rows = await contextFor(s.deal)
    // A client can tell us anything; a provider is reporting what it saw. The
    // difference has to survive into the row or no rule can weigh them apart.
    expect(rows.map((r) => r.source).sort()).toEqual([
      'client_attested',
      'hosted_page',
      'provider',
    ])
  })

  test('a deal that has gone away is silent, not an error', async () => {
    // This runs beside a payment. A charge that succeeded must not become a 500
    // because a telemetry insert had nothing to attach to.
    await expect(
      h.db.query(
        `select record_request_context(gen_random_uuid(), 'provider', 'charge_confirmed', '41.186.0.42')`,
      ),
    ).resolves.toBeTruthy()
  })

  test('a missing address is recorded as an event with no address', async () => {
    const s = await seed()
    await h.db.query(
      `select record_request_context($1, 'hosted_page', 'pay_started', null, null, 'Mozilla/5.0')`,
      [s.deal],
    )

    const rows = await contextFor(s.deal)
    expect(rows[0].ip).toBeNull()
    // The attempt is still worth having: "nothing was reported" and "nothing
    // happened" are different facts on a fraud screen.
    expect(rows[0].user_agent).toBe('Mozilla/5.0')
  })

  test('an unbounded user agent is truncated rather than rejected', async () => {
    const s = await seed()
    await h.db.query(
      `select record_request_context($1, 'provider', 'charge_confirmed', null, null, $2)`,
      [s.deal, 'A'.repeat(5_000)],
    )

    const rows = await contextFor(s.deal)
    expect(rows[0].user_agent).toHaveLength(300)
  })

  test('v6 addresses round-trip', async () => {
    const s = await seed()
    await h.db.query(
      `select record_request_context($1, 'provider', 'charge_confirmed', '2001:db8::1')`,
      [s.deal],
    )

    const rows = await contextFor(s.deal)
    expect(rows[0].ip).toBe('2001:db8::1')
  })

  test('several observations accumulate against one deal', async () => {
    const s = await seed()
    await h.db.query(
      `select record_request_context($1, 'hosted_page', 'pay_started', '41.186.0.42')`,
      [s.deal],
    )
    await h.db.query(
      `select record_request_context($1, 'provider', 'charge_confirmed', '41.186.0.51')`,
      [s.deal],
    )

    // A payment is a sequence, not a single moment — the address at checkout
    // and the one the provider saw are both worth keeping.
    expect(await contextFor(s.deal)).toHaveLength(2)
  })
})

describe('who can see it', () => {
  test('the model role has no access at all', async () => {
    // The case file is PII-minimised on purpose: `buyer_ref` is already left
    // out for being frequently an email, and an address is the same class of
    // thing. A risk brief is not improved by containing one.
    const { rows } = await h.db.query<{ allowed: boolean }>(
      `select has_table_privilege('payhold_ai', 'request_context', 'select') or
              has_table_privilege('payhold_ai', 'request_context', 'insert') as allowed`,
    )
    expect(rows[0].allowed).toBe(false)
  })

  test('nothing but the service role may write one', async () => {
    for (const role of ['anon', 'authenticated']) {
      const { rows } = await h.db.query<{ allowed: boolean }>(
        `select has_function_privilege($1, p.oid, 'execute') as allowed
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'record_request_context'`,
        [role],
      )
      expect(rows[0].allowed, role).toBe(false)
    }
  })

  test('row-level security is on, so a session sees only its own tenant', async () => {
    const { rows } = await h.db.query<{ enabled: boolean }>(
      `select relrowsecurity as enabled from pg_class where relname = 'request_context'`,
    )
    expect(rows[0].enabled).toBe(true)
  })
})

describe('the retention decision stays reversible', () => {
  test('nothing depends on the address, so it can be dropped later', async () => {
    const s = await seed()
    await h.db.query(
      `select record_request_context($1, 'provider', 'charge_confirmed', '41.186.0.42')`,
      [s.deal],
    )

    // Addresses are kept indefinitely by decision, not by accident. The schema
    // is shaped so a retention pass stays one statement: no foreign key, no
    // view and no constraint reads `ip`.
    await expect(
      h.db.query(`update request_context set ip = null where deal_id = $1`, [s.deal]),
    ).resolves.toBeTruthy()

    const rows = await contextFor(s.deal)
    expect(rows[0].ip).toBeNull()
    expect(rows[0].source).toBe('provider')
  })
})
