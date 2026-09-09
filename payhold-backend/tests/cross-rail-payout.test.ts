/**
 * A deal collected on one rail and paid out on another.
 *
 * This is the shape every international booking takes — a foreign renter's card
 * charged by Stripe in USD, a Rwandan host paid by Flutterwave in RWF — and
 * until `20260817000004` it froze the tenant's payouts on the first one. The
 * `payout` entry was booked through `write_ledger`, which stamps the *deal's*
 * rail, so the ledger said USD left Stripe: it had not, and RWF had left
 * Flutterwave instead. `reconcile` found drift on both rails at once and
 * `record_reconciliation` freezes on any drift.
 *
 * The test that matters is the last one — that both rails reconcile — because
 * the entries are only interesting insofar as they add up.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { migrated, rejects, type Harness } from './harness'

let h: Harness
/**
 * A tenant per test, because `rail_balances` sums every deal an account has
 * and these assertions are about one deal's arithmetic. Sharing one would make
 * each expectation the running total of everything above it.
 */
let tenant: string
let seller: string
let n = 0

/** Buyer pays $400.00; we keep $40.00; the rail took $5.00. */
const BUYER_PAID = 40_000
const OUR_FEE = 4_000
const RAIL_FEE = 500
/** What leaves the deal's clearing pool, in the presentment currency. */
const LEAVING = BUYER_PAID - OUR_FEE - RAIL_FEE
/** What the seller is actually sent, in their own currency. */
const PAYOUT_RWF = 490_000

beforeAll(async () => {
  h = await migrated()
})

beforeEach(async () => {
  const slug = `cross-rail-${++n}`
  const { rows: [t] } = await h.db.query<{ id: string }>(
    `insert into tenants (name, slug) values ($1, $1) returning id`,
    [slug],
  )
  tenant = t.id

  const { rows: [s] } = await h.db.query<{ id: string }>(
    `insert into sellers (tenant_id, name, country, payout_currency, payout_provider,
                          beneficiary_token, masked_destination, kyc_status,
                          sanctions_checked_at, created_at)
     values ($1, 'Kigali Host', 'RW', 'RWF', 'flutterwave_momo', 'tok_x',
             'MTN •••• 4821', 'verified', now(), now() - interval '400 days')
     returning id`,
    [tenant],
  )
  seller = s.id
})

afterAll(() => h.close())

/**
 * A deal collected on `rail`, released, with a payout scheduled in RWF.
 *
 * The ledger is written the way the money path writes it: the hold, then at
 * release the negative release entry, our fee and the rail's own fee.
 */
async function releasedDeal(rail: string) {
  const { rows: [d] } = await h.db.query<{ id: string }>(
    `insert into deals (tenant_id, buyer_ref, seller_id, description, amount, currency,
                        presentment_currency, presentment_amount, buyer_country,
                        provider, fee_amount, status, released_at, payout_due_at)
     values ($1, 'buyer_1', $2, 'A rental', 500000, 'RWF', 'USD', $3, 'US',
             $4, $5, 'released', now(), now() - interval '1 day')
     returning id`,
    [tenant, seller, BUYER_PAID, rail, OUR_FEE],
  )

  // Every amount is cast: an unadorned `-$3` leaves the parameter `unknown`
  // and Postgres cannot resolve which unary minus was meant.
  await h.db.query(
    `insert into ledger (tenant_id, deal_id, entry_type, amount, currency, provider) values
       ($1, $2, 'hold',          $3::bigint, 'USD', $4),
       ($1, $2, 'release',      -$3::bigint, 'USD', $4),
       ($1, $2, 'fee',          -$5::bigint, 'USD', $4),
       ($1, $2, 'provider_fee', -$6::bigint, 'USD', $4)`,
    [tenant, d.id, BUYER_PAID, rail, OUR_FEE, RAIL_FEE],
  )

  const { rows: [p] } = await h.db.query<{ id: string }>(
    `insert into payouts (tenant_id, deal_id, seller_id, amount, currency, status, scheduled_for)
     values ($1, $2, $3, $4, 'RWF', 'scheduled', now())
     returning id`,
    [tenant, d.id, seller, PAYOUT_RWF],
  )

  return { deal: d.id, payout: p.id }
}

/** Record the routing decision `settle_payout` cross-checks against. */
async function routedTo(payout: string, rail: string) {
  await h.db.query(
    `insert into payout_decisions (tenant_id, payout_id, provider, payout_provider,
                                   currency, amount, reason_code)
     values ($1, $2, $3, 'flutterwave_momo', 'RWF', $4, 'routed')`,
    [tenant, payout, rail, PAYOUT_RWF],
  )
}

async function railBalance(provider: string, currency: string) {
  const { rows: [r] } = await h.db.query<Record<string, string>>(
    `select * from rail_balances($1) where provider = $2 and currency = $3`,
    [tenant, provider, currency],
  )
  // A rail with no entries has a zero balance rather than no balance — which
  // is also what `expected()` should compute for one.
  if (!r) {
    return {
      held: 0,
      pending_clearance: 0,
      available: 0,
      reserved: 0,
      fees_retained: 0,
      tenant_funds: 0,
      paid_out: 0,
    }
  }
  return {
    held: Number(r.held),
    pending_clearance: Number(r.pending_clearance),
    available: Number(r.available),
    reserved: Number(r.reserved),
    fees_retained: Number(r.fees_retained),
    tenant_funds: Number(r.tenant_funds),
    paid_out: Number(r.paid_out),
  }
}

/** What `_shared/reconciliation.ts`'s `expected()` computes, in SQL. */
function expected(b: NonNullable<Awaited<ReturnType<typeof railBalance>>>): number {
  return b.held + b.pending_clearance + b.available + b.reserved +
    b.fees_retained + b.tenant_funds
}

describe('same rail — unchanged', () => {
  test('one payout entry, and no cross-rail pair', async () => {
    const { payout } = await releasedDeal('stripe')
    await routedTo(payout, 'stripe')

    await h.db.query(`select * from settle_payout($1, $2, 'tr_1', 'stripe')`, [payout, LEAVING])

    const { rows } = await h.db.query<{ entry_type: string }>(
      `select entry_type::text from ledger
        where tenant_id = $1 and entry_type in ('cross_rail_offset', 'cross_rail_payout')`,
      [tenant],
    )
    expect(rows.length).toBe(0)

    const stripe = (await railBalance('stripe', 'USD'))!
    expect(stripe.paid_out).toBe(LEAVING)
    expect(stripe.tenant_funds).toBe(0)
    // The money really did leave this rail, so what Stripe should still hold
    // is our own fee and nothing else.
    expect(expected(stripe)).toBe(OUR_FEE)
  })
})

describe('cross rail', () => {
  test('the money is booked where it actually moved', async () => {
    const { deal, payout } = await releasedDeal('stripe')
    await routedTo(payout, 'flutterwave')

    await h.db.query(
      `select * from settle_payout($1, $2, 'FLW-TRF-9', 'flutterwave')`,
      [payout, LEAVING],
    )

    const { rows } = await h.db.query<{
      entry_type: string
      amount: string
      currency: string
      provider: string
    }>(
      `select entry_type::text, amount::text, currency, provider::text
         from ledger where deal_id = $1
          and entry_type in ('payout', 'cross_rail_offset', 'cross_rail_payout')
        order by entry_type::text`,
      [deal],
    )

    const byType = Object.fromEntries(rows.map((r) => [r.entry_type, r]))

    // The seller's claim on the pool is discharged, on the rail that collected
    // it and in the presentment currency. This entry does not move — §7's
    // identity and `deal_amounts.paid_out` both read it.
    expect(byType.payout.provider).toBe('stripe')
    expect(byType.payout.currency).toBe('USD')
    expect(Number(byType.payout.amount)).toBe(-LEAVING)

    // Nothing physical: the collected money is still at Stripe, and now it is
    // simply the tenant's.
    expect(byType.cross_rail_offset.provider).toBe('stripe')
    expect(byType.cross_rail_offset.currency).toBe('USD')
    expect(Number(byType.cross_rail_offset.amount)).toBe(LEAVING)

    // Physical, and in the seller's own currency — a genuinely different
    // number, which is why it is not a conversion of `leaving`.
    expect(byType.cross_rail_payout.provider).toBe('flutterwave')
    expect(byType.cross_rail_payout.currency).toBe('RWF')
    expect(Number(byType.cross_rail_payout.amount)).toBe(-PAYOUT_RWF)
  })

  test('both rails reconcile — the drift that used to freeze the account', async () => {
    const { payout } = await releasedDeal('stripe')
    await routedTo(payout, 'flutterwave')
    await h.db.query(
      `select * from settle_payout($1, $2, 'FLW-TRF-10', 'flutterwave')`,
      [payout, LEAVING],
    )

    // Stripe still holds everything the buyer paid less what Stripe itself
    // took. Nothing swept our fee out, and nothing swept the payout out
    // either — it went from a different account.
    const stripe = (await railBalance('stripe', 'USD'))!
    expect(expected(stripe)).toBe(BUYER_PAID - RAIL_FEE)
    // Our fee, plus the seller's money that is still sitting here because it
    // went out of a different account entirely.
    expect(stripe.fees_retained).toBe(OUR_FEE)
    expect(stripe.tenant_funds).toBe(LEAVING)

    // Flutterwave is down by exactly what was sent, and nothing else.
    const flw = (await railBalance('flutterwave', 'RWF'))!
    expect(expected(flw)).toBe(-PAYOUT_RWF)
    expect(flw.held).toBe(0)
    expect(flw.available).toBe(0)
  })

  test('a top-up the tenant made themselves is explicable', async () => {
    const before = (await railBalance('flutterwave', 'RWF'))!

    await h.db.query(
      `select * from record_external_transfer($1, 'flutterwave', 'RWF', $2,
                                              'BK-REF-778', 'user:owner@example.com')`,
      [tenant, 2_000_000],
    )

    const after = (await railBalance('flutterwave', 'RWF'))!
    expect(expected(after)).toBe(expected(before) + 2_000_000)
    // It is the tenant's own money, not a seller's: no other bucket moves.
    expect(after.held).toBe(before.held)
    expect(after.available).toBe(before.available)
    expect(after.paid_out).toBe(before.paid_out)
  })

  test('a transfer with no reference, no actor or no amount is refused', async () => {
    await rejects(
      () =>
        h.db.query(
          `select record_external_transfer($1, 'flutterwave', 'RWF', 100, '', 'user:o@e.com')`,
          [tenant],
        ),
      /policy_violation.*reference/,
    )
    await rejects(
      () =>
        h.db.query(
          `select record_external_transfer($1, 'flutterwave', 'RWF', 100, 'REF', '  ')`,
          [tenant],
        ),
      /policy_violation.*who reported/,
    )
    await rejects(
      () =>
        h.db.query(
          `select record_external_transfer($1, 'flutterwave', 'RWF', 0, 'REF', 'user:o@e.com')`,
          [tenant],
        ),
      /policy_violation.*moves nothing/,
    )
  })
})

describe('the rail cannot be chosen by the caller', () => {
  test('settling on a rail the payout was not routed to is refused', async () => {
    const { payout } = await releasedDeal('stripe')
    await routedTo(payout, 'flutterwave')

    await rejects(
      () => h.db.query(`select * from settle_payout($1, $2, 'X', 'stripe')`, [payout, LEAVING]),
      /policy_violation.*routed to flutterwave/,
    )
  })

  test('with no routing decision at all, only the collecting rail settles', async () => {
    const { payout } = await releasedDeal('fake')

    await rejects(
      () =>
        h.db.query(`select * from settle_payout($1, $2, 'X', 'flutterwave')`, [payout, LEAVING]),
      /policy_violation.*no routing decision/,
    )

    // The fixture case, and every payout that predates this migration.
    await h.db.query(`select * from settle_payout($1, $2, 'ok', 'fake')`, [payout, LEAVING])
    const { rows: [p] } = await h.db.query<{ status: string }>(
      `select status::text from payouts where id = $1`, [payout],
    )
    expect(p.status).toBe('paid')
  })

  test('there is exactly one settle_payout', async () => {
    // A recreated function that gained a parameter leaves the old signature
    // behind as a sibling, and every existing caller keeps hitting it. The
    // trap `fund_deal`'s header names.
    const { rows: [r] } = await h.db.query<{ n: string }>(
      `select count(*)::text as n from pg_proc where proname = 'settle_payout'`,
    )
    expect(Number(r.n)).toBe(1)
  })

  test('the AI role cannot execute any of the new writers', async () => {
    for (
      const fn of ['settle_payout', 'write_rail_ledger', 'record_external_transfer']
    ) {
      const { rows } = await h.db.query<{ ok: boolean }>(
        `select has_function_privilege('payhold_ai', p.oid, 'execute') as ok
           from pg_proc p where p.proname = $1`,
        [fn],
      )
      for (const row of rows) expect(row.ok).toBe(false)
    }
  })
})
