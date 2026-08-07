/**
 * The schema's own invariants.
 *
 * These are not the acceptance suite — that is the port of the dashboard's
 * `engine.test.ts`, and it comes with the Edge Functions. These are the
 * narrower claims the *database* makes on its own: that the migrations apply,
 * that append-only means append-only, and that the guards in the money
 * functions cannot be talked out of.
 */

import { beforeAll, afterAll, describe, expect, test } from 'vitest'
import { migrated, rejects, type Harness } from './harness'

let h: Harness

/** ids created by `seedDeal`, so tests can reach into the fixture. */
interface Seeded {
  tenant: string
  seller: string
  deal: string
}

async function seedDeal(opts: {
  amount?: number
  deposit?: number | null
  status?: string
  clearanceDays?: number
} = {}): Promise<Seeded> {
  const amount = opts.amount ?? 100_000
  const { rows: [tenant] } = await h.db.query<{ id: string }>(
    `insert into tenants (name, slug) values ('Acme', 'acme-' || gen_random_uuid()) returning id`,
  )
  await h.db.query(
    `insert into settings (tenant_id, key, value) values ($1, 'clearance_days', $2::text::jsonb)`,
    [tenant.id, String(opts.clearanceDays ?? 7)],
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
                        presentment_currency, presentment_amount, deposit_amount,
                        buyer_country, provider, provider_ref, status, fee_amount,
                        released_at)
     values ($1, 'buyer-1', $2, 'Excavator hire', $3, 'RWF', 'RWF', $3, $4,
             'RW', 'fake', 'ref-' || gen_random_uuid(), $5::deal_status, $6,
             case when $5 in ('released','paid_out') then now() else null end)
     returning id`,
    [tenant.id, seller.id, amount, opts.deposit ?? null, opts.status ?? 'funded_held',
     Math.round(amount * 0.1)],
  )

  return { tenant: tenant.id, seller: seller.id, deal: deal.id }
}

/**
 * Book the hold a funded deal implies.
 *
 * `seedDeal` writes a status without the ledger entry that status would have
 * come with, which most tests want — they build the exact entries they are
 * asserting on. Refunds are the exception: what is refundable is derived from
 * the ledger, because you cannot send back money that never arrived, so a
 * refund test has to say the money arrived.
 */
const fund = (s: Seeded, amount = 100_000) =>
  h.db.query(
    `insert into ledger (tenant_id, deal_id, entry_type, amount, currency, provider)
     values ($1, $2, 'hold', $3, 'RWF', 'fake')`,
    [s.tenant, s.deal, amount],
  )

const confirm = (deal: string, side: 'buyer' | 'seller') =>
  h.db.query(`insert into confirmations (deal_id, side) values ($1, $2)`, [deal, side])

/** The normal release call, with fee and payout already converted by a caller. */
const release = (deal: string, payout = 90_000, fee = 10_000) =>
  h.db.query(`select * from release_deal($1, $2, 'RWF', $3)`, [deal, payout, fee])

beforeAll(async () => { h = await migrated() }, 120_000)
afterAll(async () => { await h?.close() })

describe('migrations', () => {
  test('all migrations apply to an empty database', async () => {
    const { rows } = await h.db.query<{ table_name: string }>(
      `select table_name from information_schema.tables
       where table_schema = 'public' order by table_name`,
    )
    const names = rows.map((r) => r.table_name)
    // Every table spec §5 names, plus the ones the invariants require.
    expect(names).toEqual(expect.arrayContaining([
      'api_keys', 'audit_log', 'confirmations', 'deals', 'disputes', 'ledger',
      'payouts', 'provider_events', 'reconciliation_alerts', 'sellers',
      'settings', 'tenant_provider_accounts', 'tenant_users', 'tenants',
      'webhook_deliveries', 'webhook_endpoints',
    ]))
  })

  test('RLS is enabled on every table that holds tenant data', async () => {
    const { rows } = await h.db.query<{ tablename: string }>(
      `select tablename from pg_tables
       where schemaname = 'public' and not rowsecurity`,
    )
    expect(rows.map((r) => r.tablename)).toEqual([])
  })
})

describe('append-only storage', () => {
  test('ledger entries cannot be updated or deleted', async () => {
    const s = await seedDeal()
    await h.db.query(
      `insert into ledger (tenant_id, deal_id, entry_type, amount, currency, provider)
       values ($1, $2, 'hold', 100000, 'RWF', 'fake')`,
      [s.tenant, s.deal],
    )
    await rejects(
      () => h.db.query(`update ledger set amount = 1 where deal_id = $1`, [s.deal]),
      /append-only/,
    )
    await rejects(
      () => h.db.query(`delete from ledger where deal_id = $1`, [s.deal]),
      /append-only/,
    )
  })

  test('audit rows cannot be rewritten after the fact', async () => {
    const s = await seedDeal()
    await h.db.query(`select write_audit($1, $2, 'system', 'deal.funded_held')`,
                     [s.tenant, s.deal])
    await rejects(
      () => h.db.query(`update audit_log set action = 'nothing.happened'`),
      /append-only/,
    )
  })
})

describe('idempotency constraints', () => {
  test('one provider reference backs at most one deal', async () => {
    const s = await seedDeal()
    const { rows: [d] } = await h.db.query<{ provider_ref: string }>(
      `select provider_ref from deals where id = $1`, [s.deal],
    )
    await rejects(
      () => h.db.query(
        `insert into deals (tenant_id, buyer_ref, seller_id, description, amount, currency,
                            presentment_currency, presentment_amount, buyer_country,
                            provider, provider_ref)
         values ($1, 'buyer-2', $2, 'Duplicate webhook', 100000, 'RWF', 'RWF', 100000,
                 'RW', 'fake', $3)`,
        [s.tenant, s.seller, d.provider_ref],
      ),
      /deals_provider_ref_key/,
    )
  })

  test('unfunded deals do not collide on a null provider reference', async () => {
    const s = await seedDeal()
    for (const ref of ['a', 'b']) {
      await h.db.query(
        `insert into deals (tenant_id, buyer_ref, seller_id, description, amount, currency,
                            presentment_currency, presentment_amount, buyer_country, provider)
         values ($1, $2, $3, 'Unfunded', 100000, 'RWF', 'RWF', 100000, 'RW', 'fake')`,
        [s.tenant, ref, s.seller],
      )
    }
    const { rows } = await h.db.query<{ n: number }>(
      `select count(*)::int as n from deals where tenant_id = $1 and provider_ref is null`,
      [s.tenant],
    )
    expect(rows[0].n).toBe(2)
  })

  test('a side can only confirm once', async () => {
    const s = await seedDeal()
    await confirm(s.deal, 'buyer')
    await rejects(
      () => confirm(s.deal, 'buyer'),
      /confirmations_deal_id_side_key/,
    )
  })
})

describe('release', () => {
  test('requires both confirmations', async () => {
    const s = await seedDeal()
    await confirm(s.deal, 'buyer')
    await rejects(() => release(s.deal), /release requires both confirmations/)
  })

  test('books the hold out, takes the fee, and schedules exactly one payout', async () => {
    const s = await seedDeal()
    await confirm(s.deal, 'buyer')
    await confirm(s.deal, 'seller')
    await release(s.deal)

    // Ordered as text: an enum column sorts by the order the type declares its
    // values, which would make this assertion depend on migration authoring.
    const { rows: entries } = await h.db.query<{ entry_type: string; amount: string }>(
      `select entry_type, amount from ledger where deal_id = $1 order by entry_type::text`,
      [s.deal],
    )
    expect(entries).toEqual([
      { entry_type: 'fee', amount: -10_000 },
      { entry_type: 'release', amount: -100_000 },
    ])

    const { rows: payouts } = await h.db.query(
      `select amount, currency, status from payouts where deal_id = $1`, [s.deal],
    )
    expect(payouts).toEqual([{ amount: 90_000, currency: 'RWF', status: 'scheduled' }])
  })

  test('is idempotent — a second call books nothing further', async () => {
    const s = await seedDeal()
    await confirm(s.deal, 'buyer')
    await confirm(s.deal, 'seller')
    await release(s.deal)
    await release(s.deal)

    const { rows } = await h.db.query<{ n: number }>(
      `select count(*)::int as n from ledger where deal_id = $1`, [s.deal],
    )
    expect(rows[0].n).toBe(2)

    const { rows: payouts } = await h.db.query<{ n: number }>(
      `select count(*)::int as n from payouts where deal_id = $1`, [s.deal],
    )
    expect(payouts[0].n).toBe(1)
  })

  test('sets the clearance window from the tenant\'s own setting', async () => {
    const s = await seedDeal({ clearanceDays: 14 })
    await confirm(s.deal, 'buyer')
    await confirm(s.deal, 'seller')
    await release(s.deal)

    const { rows } = await h.db.query<{ days: number }>(
      `select round(extract(epoch from (payout_due_at - released_at)) / 86400)::int as days
       from deals where id = $1`,
      [s.deal],
    )
    expect(rows[0].days).toBe(14)
  })

  test('a refunded deal can never be released', async () => {
    const s = await seedDeal()
    await fund(s)
    await h.db.query(`select refund_deal($1, 'buyer cancelled')`, [s.deal])
    await confirm(s.deal, 'buyer')
    await confirm(s.deal, 'seller')
    await rejects(() => release(s.deal), /was refunded and cannot be released/)
  })

  test('returns an unsettled deposit to the buyer', async () => {
    const s = await seedDeal({ deposit: 50_000 })
    await confirm(s.deal, 'buyer')
    await confirm(s.deal, 'seller')
    await release(s.deal)

    const { rows } = await h.db.query<{ amount: string }>(
      `select amount from ledger where deal_id = $1 and entry_type = 'deposit_release'`,
      [s.deal],
    )
    expect(rows).toEqual([{ amount: -50_000 }])
  })
})

describe('confirm', () => {
  test('the second side releases in the same call', async () => {
    const s = await seedDeal()
    await h.db.query(`select confirm_deal($1, 'buyer', 'user', 90000, 'RWF', 10000)`, [s.deal])
    const { rows: mid } = await h.db.query<{ status: string }>(
      `select status from deals where id = $1`, [s.deal],
    )
    expect(mid[0].status).toBe('confirmed_buyer')

    await h.db.query(`select confirm_deal($1, 'seller', 'user', 90000, 'RWF', 10000)`, [s.deal])
    const { rows: after } = await h.db.query<{ status: string }>(
      `select status from deals where id = $1`, [s.deal],
    )
    // The second confirmation releases the money from the hold and starts the
    // clearance window — which is what `clearing` names. `released` is the far
    // side of that window; see `20260807000002_lifecycle.sql`.
    expect(after[0].status).toBe('clearing')
  })

  test('confirming twice from the same side is a no-op, not an error', async () => {
    const s = await seedDeal()
    await h.db.query(`select confirm_deal($1, 'buyer', 'user', 90000, 'RWF', 10000)`, [s.deal])
    await h.db.query(`select confirm_deal($1, 'buyer', 'user', 90000, 'RWF', 10000)`, [s.deal])

    const { rows } = await h.db.query<{ n: number }>(
      `select count(*)::int as n from confirmations where deal_id = $1`, [s.deal],
    )
    expect(rows[0].n).toBe(1)
  })

  test('a disputed deal cannot be confirmed', async () => {
    const s = await seedDeal()
    await h.db.query(`select open_dispute($1, 'buyer', 'Machine never arrived')`, [s.deal])
    await rejects(
      () => h.db.query(`select confirm_deal($1, 'seller', 'user', 90000, 'RWF', 10000)`, [s.deal]),
      /deal is disputed/,
    )
  })
})

describe('refund', () => {
  test('after release, the seller payable is reversed rather than refused', async () => {
    // V1 refused this outright. §7.1.3 says reverse the payable and refund the
    // buyer, and §29.6 adopts it — so the guard moved from the lifecycle to the
    // cumulative amount.
    const s = await seedDeal()
    await fund(s)
    await confirm(s.deal, 'buyer')
    await confirm(s.deal, 'seller')
    await release(s.deal)

    await h.db.query(`select refund_deal($1, 'Damaged on arrival')`, [s.deal])

    const { rows: [d] } = await h.db.query<{ status: string }>(
      `select status from deals where id = $1`, [s.deal],
    )
    expect(d.status).toBe('refunded')

    // The un-release keeps `held` at zero rather than driving it negative.
    const { rows: [b] } = await h.db.query<{ held: string }>(
      `select held from rail_balances($1)`, [s.tenant],
    )
    expect(Number(b.held)).toBe(0)
  })

  test('is a no-op the second time', async () => {
    const s = await seedDeal()
    await fund(s)
    await h.db.query(`select refund_deal($1, 'buyer cancelled')`, [s.deal])
    await h.db.query(`select refund_deal($1, 'buyer cancelled')`, [s.deal])
    const { rows } = await h.db.query<{ n: number }>(
      `select count(*)::int as n from ledger where deal_id = $1 and entry_type = 'refund'`,
      [s.deal],
    )
    expect(rows[0].n).toBe(1)
  })

  test('an uncollected deal has nothing to refund', async () => {
    const s = await seedDeal({ status: 'created' })
    await rejects(
      () => h.db.query(`select refund_deal($1, 'never paid')`, [s.deal]),
      /nothing has been collected/,
    )
  })
})

describe('deposits', () => {
  test('capture is capped at the amount held', async () => {
    const s = await seedDeal({ deposit: 50_000 })
    await rejects(
      () => h.db.query(`select capture_deposit($1, 60000)`, [s.deal]),
      /between 1 and the held deposit/,
    )
  })

  test('a partial capture returns the remainder', async () => {
    const s = await seedDeal({ deposit: 50_000 })
    await h.db.query(`select capture_deposit($1, 20000)`, [s.deal])
    const { rows } = await h.db.query<{ entry_type: string; amount: string }>(
      `select entry_type, amount from ledger where deal_id = $1 order by entry_type::text`,
      [s.deal],
    )
    expect(rows).toEqual([
      { entry_type: 'deposit_capture', amount: 20_000 },
      { entry_type: 'deposit_release', amount: -30_000 },
    ])
  })

  test('a settled deposit cannot be captured again', async () => {
    const s = await seedDeal({ deposit: 50_000 })
    await h.db.query(`select capture_deposit($1, 50000)`, [s.deal])
    await rejects(
      () => h.db.query(`select capture_deposit($1, 10000)`, [s.deal]),
      /already been settled/,
    )
  })

  test('a deal with no deposit rejects both deposit calls', async () => {
    const s = await seedDeal()
    await rejects(() => h.db.query(`select capture_deposit($1, 100)`, [s.deal]),
                  /no security deposit/)
    await rejects(() => h.db.query(`select release_deposit($1)`, [s.deal]),
                  /no security deposit/)
  })
})

describe('balances are derived from the ledger', () => {
  test('a funded deal is held and nothing else', async () => {
    const s = await seedDeal()
    await h.db.query(
      `insert into ledger (tenant_id, deal_id, entry_type, amount, currency, provider)
       values ($1, $2, 'hold', 100000, 'RWF', 'fake')`,
      [s.tenant, s.deal],
    )
    const { rows } = await h.db.query(
      `select held, pending_clearance, available, paid_out from tenant_balances($1)`,
      [s.tenant],
    )
    expect(rows).toEqual([
      { held: 100_000, pending_clearance: 0, available: 0, paid_out: 0 },
    ])
  })

  test('release moves money out of held and into clearance', async () => {
    const s = await seedDeal()
    await h.db.query(
      `insert into ledger (tenant_id, deal_id, entry_type, amount, currency, provider)
       values ($1, $2, 'hold', 100000, 'RWF', 'fake')`,
      [s.tenant, s.deal],
    )
    await confirm(s.deal, 'buyer')
    await confirm(s.deal, 'seller')
    await release(s.deal)

    const { rows } = await h.db.query(
      `select held, pending_clearance, available, paid_out from tenant_balances($1)`,
      [s.tenant],
    )
    // 100k held out, 90k owed to the seller and still inside the window.
    expect(rows).toEqual([
      { held: 0, pending_clearance: 90_000, available: 0, paid_out: 0 },
    ])
  })

  test('clearance elapsing makes the money available', async () => {
    const s = await seedDeal({ clearanceDays: 0 })
    await h.db.query(
      `insert into ledger (tenant_id, deal_id, entry_type, amount, currency, provider)
       values ($1, $2, 'hold', 100000, 'RWF', 'fake')`,
      [s.tenant, s.deal],
    )
    await confirm(s.deal, 'buyer')
    await confirm(s.deal, 'seller')
    await release(s.deal)

    const { rows } = await h.db.query(
      `select pending_clearance, available from tenant_balances($1)`, [s.tenant],
    )
    expect(rows).toEqual([{ pending_clearance: 0, available: 90_000 }])
  })

  test('security deposits are excluded from the tenant balance', async () => {
    const s = await seedDeal({ deposit: 50_000 })
    await h.db.query(
      `insert into ledger (tenant_id, deal_id, entry_type, amount, currency, provider)
       values ($1, $2, 'hold', 100000, 'RWF', 'fake'),
              ($1, $2, 'deposit_hold', 50000, 'RWF', 'fake')`,
      [s.tenant, s.deal],
    )
    const { rows } = await h.db.query(
      `select held from tenant_balances($1)`, [s.tenant],
    )
    expect(rows).toEqual([{ held: 100_000 }])
  })

  test('rail balances split by the provider that actually holds the money', async () => {
    const s = await seedDeal()
    const { rows: [second] } = await h.db.query<{ id: string }>(
      `insert into deals (tenant_id, buyer_ref, seller_id, description, amount, currency,
                          presentment_currency, presentment_amount, buyer_country,
                          provider, provider_ref)
       values ($1, 'buyer-intl', $2, 'Card from abroad', 50000, 'RWF', 'USD', 4000,
               'IN', 'stripe', 'pi_' || gen_random_uuid())
       returning id`,
      [s.tenant, s.seller],
    )
    await h.db.query(
      `insert into ledger (tenant_id, deal_id, entry_type, amount, currency, provider)
       values ($1, $2, 'hold', 100000, 'RWF', 'fake'),
              ($1, $3, 'hold', 4000, 'USD', 'stripe')`,
      [s.tenant, s.deal, second.id],
    )
    const { rows } = await h.db.query(
      `select provider, currency, held from rail_balances($1)`, [s.tenant],
    )
    expect(rows).toEqual([
      { provider: 'fake', currency: 'RWF', held: 100_000 },
      { provider: 'stripe', currency: 'USD', held: 4_000 },
    ])
  })
})

describe('payouts', () => {
  test('may never exceed the available balance', async () => {
    const s = await seedDeal({ clearanceDays: 0 })
    await h.db.query(
      `insert into ledger (tenant_id, deal_id, entry_type, amount, currency, provider)
       values ($1, $2, 'hold', 100000, 'RWF', 'fake')`,
      [s.tenant, s.deal],
    )
    await confirm(s.deal, 'buyer')
    await confirm(s.deal, 'seller')
    await release(s.deal)

    const { rows: [p] } = await h.db.query<{ id: string }>(
      `select id from payouts where deal_id = $1`, [s.deal],
    )
    await rejects(
      () => h.db.query(`select settle_payout($1, 95000, 'trf_1')`, [p.id]),
      /insufficient_balance/,
    )
  })

  test('settling debits the vault and closes the deal', async () => {
    const s = await seedDeal({ clearanceDays: 0 })
    await h.db.query(
      `insert into ledger (tenant_id, deal_id, entry_type, amount, currency, provider)
       values ($1, $2, 'hold', 100000, 'RWF', 'fake')`,
      [s.tenant, s.deal],
    )
    await confirm(s.deal, 'buyer')
    await confirm(s.deal, 'seller')
    await release(s.deal)

    const { rows: [p] } = await h.db.query<{ id: string }>(
      `select id from payouts where deal_id = $1`, [s.deal],
    )
    await h.db.query(`select settle_payout($1, 90000, 'trf_1')`, [p.id])

    const { rows: [deal] } = await h.db.query<{ status: string }>(
      `select status from deals where id = $1`, [s.deal],
    )
    expect(deal.status).toBe('paid_out')

    const { rows: bal } = await h.db.query(
      `select held, pending_clearance, available, paid_out from tenant_balances($1)`,
      [s.tenant],
    )
    expect(bal).toEqual([
      { held: 0, pending_clearance: 0, available: 0, paid_out: 90_000 },
    ])
  })

  test('settling twice pays once', async () => {
    const s = await seedDeal({ clearanceDays: 0 })
    await h.db.query(
      `insert into ledger (tenant_id, deal_id, entry_type, amount, currency, provider)
       values ($1, $2, 'hold', 100000, 'RWF', 'fake')`,
      [s.tenant, s.deal],
    )
    await confirm(s.deal, 'buyer')
    await confirm(s.deal, 'seller')
    await release(s.deal)
    const { rows: [p] } = await h.db.query<{ id: string }>(
      `select id from payouts where deal_id = $1`, [s.deal],
    )
    await h.db.query(`select settle_payout($1, 90000, 'trf_1')`, [p.id])
    await h.db.query(`select settle_payout($1, 90000, 'trf_1')`, [p.id])

    const { rows } = await h.db.query<{ n: number }>(
      `select count(*)::int as n from ledger where deal_id = $1 and entry_type = 'payout'`,
      [s.deal],
    )
    expect(rows[0].n).toBe(1)
  })

  test('one deal can never schedule two payouts', async () => {
    const s = await seedDeal()
    await confirm(s.deal, 'buyer')
    await confirm(s.deal, 'seller')
    await release(s.deal)
    await rejects(
      () => h.db.query(
        `insert into payouts (tenant_id, deal_id, seller_id, amount, currency, scheduled_for)
         values ($1, $2, $3, 90000, 'RWF', now())`,
        [s.tenant, s.deal, s.seller],
      ),
      /payouts_deal_key/,
    )
  })
})

describe('disputes', () => {
  test('resolving to release pays the seller through the normal path', async () => {
    const s = await seedDeal()
    const { rows: [d] } = await h.db.query<{ open_dispute: string }>(
      `select (open_dispute($1, 'buyer', 'Late delivery')).id as open_dispute`, [s.deal],
    )
    await h.db.query(
      `select resolve_dispute($1, 'release', 'Seller provided proof', 90000, 'RWF', 10000)`,
      [d.open_dispute],
    )
    const { rows: [deal] } = await h.db.query<{ status: string }>(
      `select status from deals where id = $1`, [s.deal],
    )
    expect(deal.status).toBe('clearing')
  })

  test('resolving to refund returns the buyer\'s money', async () => {
    const s = await seedDeal()
    await fund(s)
    const { rows: [d] } = await h.db.query<{ open_dispute: string }>(
      `select (open_dispute($1, 'buyer', 'Never arrived')).id as open_dispute`, [s.deal],
    )
    await h.db.query(
      `select resolve_dispute($1, 'refund', 'No proof of delivery', 0, 'RWF', 0)`,
      [d.open_dispute],
    )
    const { rows: [deal] } = await h.db.query<{ status: string }>(
      `select status from deals where id = $1`, [s.deal],
    )
    expect(deal.status).toBe('refunded')
  })

  test('a dispute resolves only once', async () => {
    const s = await seedDeal()
    const { rows: [d] } = await h.db.query<{ open_dispute: string }>(
      `select (open_dispute($1, 'buyer', 'Late')).id as open_dispute`, [s.deal],
    )
    await h.db.query(
      `select resolve_dispute($1, 'release', 'ok', 90000, 'RWF', 10000)`, [d.open_dispute],
    )
    await rejects(
      () => h.db.query(`select resolve_dispute($1, 'refund', 'again', 0, 'RWF', 0)`,
                       [d.open_dispute]),
      /already resolved/,
    )
  })

  test('a deal carries at most one open dispute', async () => {
    const s = await seedDeal()
    await h.db.query(`select open_dispute($1, 'buyer', 'First')`, [s.deal])
    await rejects(
      () => h.db.query(`select open_dispute($1, 'seller', 'Second')`, [s.deal]),
      /disputes_one_open_per_deal/,
    )
  })
})

describe('data integrity', () => {
  test('an fx rate cannot be recorded on a same-currency deal', async () => {
    const s = await seedDeal()
    await rejects(
      () => h.db.query(`update deals set fx_rate = 1.5 where id = $1`, [s.deal]),
      /fx_rate_only_when_converting/,
    )
  })

  test('a deal cannot skip the clearance window', async () => {
    const s = await seedDeal()
    // The transition guard is a BEFORE trigger, so it now answers this before
    // the constraint gets a chance to. That ordering is the point: the reason
    // a held deal cannot be `released` is that the window has not run, not
    // that a timestamp column is empty.
    await rejects(
      () => h.db.query(`update deals set status = 'released' where id = $1`, [s.deal]),
      /invalid_transition/,
    )
  })

  test('a deal past the hold must carry its release time', async () => {
    const s = await seedDeal()
    // `funded_held -> clearing` is a legal shape, so the guard passes it
    // through and the constraint is what refuses a clearing deal with no
    // `released_at`.
    await rejects(
      () => h.db.query(`update deals set status = 'clearing' where id = $1`, [s.deal]),
      /released_at_matches_status/,
    )
  })

  test('country and currency codes are format-checked', async () => {
    const s = await seedDeal()
    await rejects(
      () => h.db.query(`update sellers set country = 'RWA' where id = $1`, [s.seller]),
      /country_code/,
    )
    await rejects(
      () => h.db.query(`update sellers set payout_currency = 'RW' where id = $1`, [s.seller]),
      /currency_code/,
    )
  })

  test('a paid payout must carry its paid time', async () => {
    const s = await seedDeal()
    await rejects(
      () => h.db.query(
        `insert into payouts (tenant_id, deal_id, seller_id, amount, currency, status, scheduled_for)
         values ($1, $2, $3, 90000, 'RWF', 'paid', now())`,
        [s.tenant, s.deal, s.seller],
      ),
      /paid_at_matches_status/,
    )
  })
})
