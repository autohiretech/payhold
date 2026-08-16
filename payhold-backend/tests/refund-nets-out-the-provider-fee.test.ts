/**
 * A provider's own fee never comes back on a refund — confirmed against
 * PayPal's real behaviour, and it is why `provider_fee` stays booked on the
 * ledger forever, never reversed (see money-breakdown.test.ts). Until this
 * change, `refund_deal`'s default "everything still refundable" asked for
 * the fee too, which the rail either refuses or grants while the tenant's
 * own provider balance quietly absorbs the difference on every refund.
 *
 * `refund_deal`'s default now nets it out. An amount named explicitly is
 * untouched — an operator can still choose to eat the fee deliberately by
 * naming the full, un-netted number.
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { migrated, rejects, type Harness } from './harness'

let h: Harness
let tenant: string
let seller: string

beforeAll(async () => {
  h = await migrated()

  const { rows: [t] } = await h.db.query<{ id: string }>(
    `insert into tenants (name, slug) values ('Fee Refund Co', 'fee-refund-co') returning id`,
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

/** A funded deal, in USD, with a genuine provider fee booked at funding. */
async function fundedWithFee(amount: number, providerFee: number): Promise<string> {
  const { rows: [d] } = await h.db.query<{ id: string }>(
    `insert into deals (tenant_id, buyer_ref, seller_id, description, amount, currency,
                        presentment_currency, presentment_amount, buyer_country,
                        provider, fee_amount)
     values ($1, 'buyer_1', $2, 'A rental', $3, 'USD', 'USD', $3, 'US', 'fake', 0)
     returning id`,
    [tenant, seller, amount],
  )
  await h.db.query(
    `select fund_deal($1, 'fake', $2, 'card', null, $3, 'USD', null, 3, $4)`,
    [d.id, `ref-${d.id.slice(0, 8)}`, amount, providerFee],
  )
  return d.id
}

async function statusOf(deal: string): Promise<string> {
  const { rows: [d] } = await h.db.query<{ status: string }>(
    `select status from deals where id = $1`, [deal],
  )
  return d.status
}

async function refundAmounts(deal: string): Promise<number[]> {
  const { rows } = await h.db.query<{ amount: string }>(
    `select amount from refunds where deal_id = $1 order by created_at`, [deal],
  )
  return rows.map((r) => Number(r.amount))
}

describe('a full refund nets out the provider fee', () => {
  test('no amount named refunds paid minus the fee, and still closes the deal', async () => {
    const deal = await fundedWithFee(600, 56)

    await h.db.query(`select refund_deal($1, 'Cancelled by host before pickup', 'dashboard')`, [deal])

    expect(await statusOf(deal)).toBe('refunded')
    expect(await refundAmounts(deal)).toEqual([544]) // 600 - 56
  })

  test('an amount named explicitly is honoured exactly, fee or no fee', async () => {
    const deal = await fundedWithFee(600, 56)

    // The operator names the full, un-netted 600 deliberately — eating the
    // fee themselves rather than passing it to the buyer.
    await h.db.query(
      `select refund_deal($1, 'Goodwill — full refund, fee absorbed by us', 'dashboard', 600)`,
      [deal],
    )

    expect(await statusOf(deal)).toBe('refunded')
    expect(await refundAmounts(deal)).toEqual([600])
  })

  test('a fee that meets or exceeds what remains still closes the deal, with no refund record', async () => {
    // A tiny deal where the provider fee alone would consume the whole thing —
    // exactly the shape of PayHold's own $0.07–$0.38 test deals this session.
    // `refunds.amount` requires a positive value (a refund record means money
    // moved), so nothing is inserted — the deal still closes.
    const deal = await fundedWithFee(50, 56)

    await h.db.query(`select refund_deal($1, 'Cancelled by host before pickup', 'dashboard')`, [deal])

    expect(await statusOf(deal)).toBe('refunded')
    expect(await refundAmounts(deal)).toEqual([])
  })

  test('a caller-supplied non-positive amount is still refused', async () => {
    const deal = await fundedWithFee(600, 56)

    await rejects(
      () => h.db.query(`select refund_deal($1, 'Bad request', 'dashboard', 0)`, [deal]),
      /a refund must be a positive amount/,
    )
  })

  test('a partial refund is unaffected by the fee, and does not close the deal', async () => {
    const deal = await fundedWithFee(600, 56)

    await h.db.query(`select refund_deal($1, 'Partial goodwill credit', 'dashboard', 100)`, [deal])

    expect(await statusOf(deal)).not.toBe('refunded')
    expect(await refundAmounts(deal)).toEqual([100])
  })

  test('a partial refund followed by "the rest" still nets the fee exactly once', async () => {
    const deal = await fundedWithFee(600, 56)

    await h.db.query(`select refund_deal($1, 'First bit', 'dashboard', 100)`, [deal])
    await h.db.query(`select refund_deal($1, 'The rest', 'dashboard')`, [deal])

    expect(await statusOf(deal)).toBe('refunded')
    // 100 first, then 600 - 56 - 100 = 444 — the fee is a deal-level figure,
    // not something each partial call subtracts its own share of.
    expect(await refundAmounts(deal)).toEqual([100, 444])
  })
})
