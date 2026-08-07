/**
 * Spec §7 — fees, tax, reserve, and what the buckets add up to.
 *
 * The first suite is a regression test. Everything after it is the §7
 * breakdown and §6.1's reserve.
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { migrated, rejects, type Harness } from './harness'

let h: Harness
let tenant: string
let seller: string

beforeAll(async () => {
  h = await migrated()

  const { rows: [t] } = await h.db.query<{ id: string }>(
    `insert into tenants (name, slug) values ('Breakdown Co', 'breakdown-co')
     returning id`,
  )
  tenant = t.id

  const { rows: [s] } = await h.db.query<{ id: string }>(
    `insert into sellers (tenant_id, name, country, payout_currency,
                          payout_provider, beneficiary_token, masked_destination)
     values ($1, 'Seller', 'RW', 'RWF', 'flutterwave_momo', 'tok_1', '•••1234')
     returning id`,
    [tenant],
  )
  seller = s.id
})

afterAll(() => h.close())

async function setting(key: string, value: string): Promise<void> {
  await h.db.query(
    `insert into settings (tenant_id, key, value) values ($1, $2, $3)
     on conflict (tenant_id, key) do update set value = excluded.value`,
    [tenant, key, value],
  )
}

async function clearSetting(key: string): Promise<void> {
  await h.db.query(`delete from settings where tenant_id = $1 and key = $2`, [tenant, key])
}

/** A funded deal. `fee` is settlement; `tax` and `providerFee` are presentment. */
async function fundedDeal(
  opts: { amount?: number; fee?: number; tax?: number; providerFee?: number } = {},
): Promise<string> {
  const amount = opts.amount ?? 100_000
  const { rows: [d] } = await h.db.query<{ id: string }>(
    `insert into deals (
       tenant_id, buyer_ref, seller_id, description, amount, currency,
       presentment_currency, presentment_amount, buyer_country, provider,
       fee_amount, tax_amount
     )
     values ($1, 'buyer_1', $2, 'A rental', $3, 'RWF', 'RWF', $3, 'RW', 'fake', $4, $5)
     returning id`,
    [tenant, seller, amount, opts.fee ?? 10_000, opts.tax ?? 0],
  )

  await h.db.query(
    `select fund_deal($1, 'fake', $2, 'mobile_money', 'MTN', $3, 'RWF', null, 3, $4)`,
    [d.id, `ref-${d.id.slice(0, 8)}`, amount, opts.providerFee ?? 0],
  )
  return d.id
}

async function release(deal: string, fee = 10_000): Promise<void> {
  await h.db.query(`select confirm_deal($1, 'buyer', 'user', 90000, 'RWF', $2)`, [deal, fee])
  await h.db.query(`select confirm_deal($1, 'seller', 'user', 90000, 'RWF', $2)`, [deal, fee])
}

interface Buckets {
  held: number
  pending_clearance: number
  available: number
  reserved: number
  fees_retained: number
  paid_out: number
}

async function buckets(): Promise<Buckets> {
  const { rows } = await h.db.query<Record<string, string>>(
    `select held, pending_clearance, available, reserved, fees_retained, paid_out
       from rail_balances($1)`,
    [tenant],
  )
  const zero: Buckets = {
    held: 0, pending_clearance: 0, available: 0,
    reserved: 0, fees_retained: 0, paid_out: 0,
  }
  for (const r of rows) {
    for (const k of Object.keys(zero) as (keyof Buckets)[]) zero[k] += Number(r[k])
  }
  return zero
}

/** What `reconcile` will ask the provider to confirm it is holding. */
function stillWithProvider(b: Buckets): number {
  return b.held + b.pending_clearance + b.available + b.reserved + b.fees_retained
}

// ---------------------------------------------------------------------------

describe('the platform fee is not drift — regression', () => {
  test('a released deal expects the provider to hold everything that arrived', async () => {
    // The bug this pins: `fee` is a debit in the clearing pool, so before V2
    // the expected figure was the amount *minus our commission* — while the
    // provider still held the whole thing, because nothing sweeps PayHold's
    // fee out of a tenant's own balance under bring-your-own-keys.
    //
    // Drift freezes that tenant's payouts automatically, so this fired on the
    // first released deal of the sandbox walkthrough.
    const deal = await fundedDeal({ amount: 100_000, fee: 10_000 })
    await release(deal)

    const b = await buckets()
    expect(b.fees_retained).toBe(10_000)
    expect(stillWithProvider(b)).toBe(100_000)
  })

  test('and still does once the seller has been paid', async () => {
    const before = await buckets()
    const deal = await fundedDeal({ amount: 50_000, fee: 5_000 })
    await release(deal, 5_000)

    const { rows: [p] } = await h.db.query<{ id: string }>(
      `select id from payouts where deal_id = $1`, [deal],
    )
    await h.db.query(
      `update deals set payout_due_at = now() - interval '1 hour' where id = $1`, [deal],
    )
    await h.db.query(`select * from mature_clearing_deals()`)
    await h.db.query(`select settle_payout($1, 45000, 'FLW-1')`, [p.id])

    const b = await buckets()
    // The commission stays in the tenant's provider balance. It is ours and it
    // has not moved, so the pass must still expect to see it.
    expect(b.fees_retained - before.fees_retained).toBe(5_000)
    expect(stillWithProvider(b) - stillWithProvider(before)).toBe(5_000)
  })

  test('a provider fee is the opposite case — it really left', async () => {
    const before = await buckets()
    const deal = await fundedDeal({ amount: 20_000, fee: 0, providerFee: 600 })

    const b = await buckets()
    // The rail took 600 of the 20,000, so 19,400 is what it still holds.
    expect(stillWithProvider(b) - stillWithProvider(before)).toBe(19_400)
    expect(b.fees_retained).toBe(before.fees_retained)
    await h.db.query(`delete from deals where id = $1`, [deal]).catch(() => {})
  })
})

describe('the §7 breakdown', () => {
  test('every value is separate, and they add up to what the buyer paid', async () => {
    const deal = await fundedDeal({
      amount: 100_000, fee: 10_000, tax: 5_000, providerFee: 3_000,
    })
    await release(deal)

    const { rows: [a] } = await h.db.query<Record<string, string>>(
      `select * from deal_amounts($1)`, [deal],
    )
    const n = (k: string) => Number(a[k])

    expect(n('buyer_paid')).toBe(100_000)
    expect(n('platform_fee')).toBe(10_000)
    expect(n('provider_fee')).toBe(3_000)
    expect(n('tax')).toBe(5_000)
    expect(n('refunded')).toBe(0)
    expect(n('paid_out')).toBe(0)

    // The identity §7 exists for: nothing is unaccounted for.
    expect(
      n('platform_fee') + n('provider_fee') + n('tax') +
      n('reserve') + n('paid_out') + n('refunded') + n('seller_net'),
    ).toBe(n('buyer_paid'))
  })

  test('an unfunded deal has a breakdown of zeroes rather than no breakdown', async () => {
    const { rows: [d] } = await h.db.query<{ id: string }>(
      `insert into deals (tenant_id, buyer_ref, seller_id, description, amount,
                          currency, presentment_currency, presentment_amount,
                          buyer_country, provider, fee_amount)
       values ($1, 'b', $2, 'Not paid', 10000, 'RWF', 'RWF', 10000, 'RW', 'fake', 1000)
       returning id`,
      [tenant, seller],
    )

    const { rows } = await h.db.query<Record<string, string>>(
      `select * from deal_amounts($1)`, [d.id],
    )
    // One row, all zeroes — a client rendering a breakdown should not have to
    // handle "no row" differently from "nothing has happened yet".
    expect(rows).toHaveLength(1)
    expect(Number(rows[0].buyer_paid)).toBe(0)
    expect(rows[0].currency).toBe('RWF')
  })

  test('the tax is not the seller\'s money', async () => {
    const deal = await fundedDeal({ amount: 60_000, fee: 6_000, tax: 4_000 })
    await release(deal, 6_000)

    const { rows: [a] } = await h.db.query<Record<string, string>>(
      `select * from deal_amounts($1)`, [deal],
    )
    // 60,000 less our 6,000 and the 4,000 owed onward.
    expect(Number(a.seller_net)).toBe(50_000)
  })
})

describe('the new-seller reserve — §6.1', () => {
  test('no reserve unless the tenant has configured a rate', async () => {
    const deal = await fundedDeal({ amount: 40_000, fee: 4_000 })
    await release(deal, 4_000)

    const { rows: [d] } = await h.db.query<{ reserve_amount: string }>(
      `select reserve_amount from deals where id = $1`, [deal],
    )
    expect(Number(d.reserve_amount)).toBe(0)
  })

  test('a reserve is carved out of the pool and cannot be paid', async () => {
    await setting('reserve_rate', '0.2')
    await setting('reserve_days', '30')

    const deal = await fundedDeal({ amount: 100_000, fee: 10_000 })
    await release(deal)

    const { rows: [a] } = await h.db.query<Record<string, string>>(
      `select * from deal_amounts($1)`, [deal],
    )
    // 20% of the 90,000 pool.
    expect(Number(a.reserve)).toBe(18_000)
    expect(Number(a.seller_net)).toBe(72_000)

    // And the payout cannot reach it: `settle_payout` compares against
    // `available`, which the reserve is deliberately not part of.
    const { rows: [p] } = await h.db.query<{ id: string }>(
      `select id from payouts where deal_id = $1`, [deal],
    )
    await h.db.query(
      `update deals set payout_due_at = now() - interval '1 hour' where id = $1`, [deal],
    )
    await h.db.query(`select * from mature_clearing_deals()`)

    await rejects(
      () => h.db.query(`select settle_payout($1, 90000, 'FLW-RESERVE')`, [p.id]),
      /insufficient_balance/,
    )

    await clearSetting('reserve_rate')
    await clearSetting('reserve_days')
  })

  test('the reserve ends exactly when the payout comes due', async () => {
    await setting('reserve_rate', '0.2')
    await setting('reserve_days', '30')

    const deal = await fundedDeal({ amount: 100_000, fee: 10_000 })
    await release(deal)

    const { rows: [d] } = await h.db.query<{ same: boolean; days: number }>(
      `select reserve_until = payout_due_at as same,
              round(extract(epoch from (payout_due_at - released_at)) / 86400)::int as days
         from deals where id = $1`,
      [deal],
    )
    // A reserve that outlived the payout would need a second transfer for this
    // deal, and `payouts_deal_key` exists to make that impossible.
    expect(d.same).toBe(true)
    // 14 days of clearance plus 30 of reserve.
    expect(d.days).toBe(44)

    await clearSetting('reserve_rate')
    await clearSetting('reserve_days')
  })

  test('returning the reserve moves no money in or out of the vault', async () => {
    await setting('reserve_rate', '0.25')

    const deal = await fundedDeal({ amount: 80_000, fee: 8_000 })
    await release(deal, 8_000)

    const before = await buckets()

    await h.db.query(
      `update deals set reserve_until = now() - interval '1 hour' where id = $1`, [deal],
    )
    await h.db.query(`select * from release_due_reserves()`)

    const after = await buckets()
    expect(stillWithProvider(after)).toBe(stillWithProvider(before))
    // It moved between two of our own buckets: out of `reserved`, back into the
    // pool where a payout can see it. Deltas rather than absolutes — these
    // buckets are the whole tenant's, and earlier tests left reserves standing.
    expect(before.reserved - after.reserved).toBe(18_000)

    await clearSetting('reserve_rate')
  })

  test('returning it twice is a no-op', async () => {
    await setting('reserve_rate', '0.25')
    const deal = await fundedDeal({ amount: 80_000, fee: 8_000 })
    await release(deal, 8_000)

    await h.db.query(
      `update deals set reserve_until = now() - interval '1 hour' where id = $1`, [deal],
    )
    await h.db.query(`select * from release_due_reserves()`)
    await h.db.query(`select * from release_due_reserves()`)

    const { rows } = await h.db.query(
      `select 1 from ledger where deal_id = $1 and entry_type = 'reserve_release'`,
      [deal],
    )
    expect(rows).toHaveLength(1)

    await clearSetting('reserve_rate')
  })

  test('an established seller is not reserved against', async () => {
    await setting('reserve_rate', '0.2')
    await setting('reserve_after_payouts', '1')

    // One payout already paid for this seller.
    const first = await fundedDeal({ amount: 30_000, fee: 3_000 })
    await release(first, 3_000)
    const { rows: [p] } = await h.db.query<{ id: string }>(
      `select id from payouts where deal_id = $1`, [first],
    )
    await h.db.query(
      `update deals set payout_due_at = now() - interval '1 hour' where id = $1`, [first],
    )
    await h.db.query(`select * from mature_clearing_deals()`)
    // The first deal was reserved against, so only the un-reserved part is
    // payable; that is enough to make the seller established.
    await h.db.query(`select settle_payout($1, 21600, 'FLW-EST')`, [p.id])

    const second = await fundedDeal({ amount: 30_000, fee: 3_000 })
    await release(second, 3_000)

    const { rows: [d] } = await h.db.query<{ reserve_amount: string }>(
      `select reserve_amount from deals where id = $1`, [second],
    )
    expect(Number(d.reserve_amount)).toBe(0)

    await clearSetting('reserve_rate')
    await clearSetting('reserve_after_payouts')
  })
})
