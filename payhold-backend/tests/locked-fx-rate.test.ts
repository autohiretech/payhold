/**
 * `lockedFxRate` (`_shared/locked-fx-rate.ts`) — the rate a cross-currency
 * deal actually locks at funding.
 *
 * The bug this replaces: every one of the four call sites (`_shared/settle.ts`
 * and the three inbound webhooks) computed `deals.fx_rate` from `fx.ts`'s
 * static, indicative `PER_USD` table — `convert(1_000_000, deal.currency,
 * verified.currency)?.rate` — never once looking at `verified.amount`, the
 * real money the provider actually reported. The comment above every one of
 * those call sites claimed the rate was "locked from what actually arrived";
 * it was locked from a table dated August 2026.
 *
 * `lockedFxRate` is the fix: presentment major units actually collected,
 * divided by settlement major units the deal is denominated in. The first
 * `describe` block below is a pure unit test of that arithmetic — no
 * database needed, since the function takes plain `{amount, currency}` pairs.
 * The second block wires it through the real `fund_deal` SQL function against
 * real Postgres (PGlite, via `tests/harness.ts` — no mocks, per this
 * project's own rule) and through `atLockedRate` (`_shared/fx.ts`, imported
 * unchanged) to prove the stored rate round-trips to the amount that
 * genuinely landed, which the old table-based rate never did.
 */

import { beforeAll, afterAll, describe, expect, test } from 'vitest'
import { atLockedRate, convert } from '../supabase/functions/_shared/fx.ts'
import { lockedFxRate } from '../supabase/functions/_shared/locked-fx-rate.ts'
import { migrated, type Harness } from './harness'

describe('lockedFxRate — pure arithmetic', () => {
  test('a same-currency deal locks no rate at all', () => {
    expect(lockedFxRate({ amount: 100_000, currency: 'RWF' }, { amount: 100_000, currency: 'RWF' }))
      .toBeNull()
  })

  test('is derived from the real amounts, not the indicative table', () => {
    // A Rwandan host's RWF 145,000 price, actually collected as exactly
    // USD 100.00 (10,000 cents) — a real-world rate of 1450 RWF/USD, not the
    // table's stale 1400.
    const rate = lockedFxRate(
      { amount: 145_000, currency: 'RWF' },
      { amount: 10_000, currency: 'USD' },
    )

    // presentment major (100) / settlement major (145,000 — RWF is
    // zero-decimal, so major === minor).
    expect(rate).toBeCloseTo(100 / 145_000, 12)

    // And it must NOT equal the table's rate for this corridor — proving the
    // real amounts, not `PER_USD`, drove the result.
    const tableRate = convert(1_000_000, 'RWF', 'USD')!.rate
    expect(rate).not.toBeCloseTo(tableRate, 6)
  })

  test('crosses a zero-decimal boundary correctly (RWF settlement, USD presentment)', () => {
    // RWF has no minor unit; USD does. A ratio of raw minor units (10_000 minor
    // USD / 140_000 minor RWF) would be wrong by 100x versus the correct
    // major-unit ratio.
    const rate = lockedFxRate(
      { amount: 140_000, currency: 'RWF' },
      { amount: 10_000, currency: 'USD' },
    )
    // major USD (100) / major RWF (140,000)
    expect(rate).toBeCloseTo(100 / 140_000, 12)
    // Not the (wrong) raw-minor-unit ratio.
    expect(rate).not.toBeCloseTo(10_000 / 140_000, 6)
  })

  test('crosses the boundary the other way (USD settlement, RWF presentment)', () => {
    const rate = lockedFxRate(
      { amount: 10_000, currency: 'USD' }, // $100.00
      { amount: 140_000, currency: 'RWF' }, // RWF 140,000
    )
    // major RWF (140,000) / major USD (100)
    expect(rate).toBeCloseTo(140_000 / 100, 12)
  })

  test('two decimal currencies need no unit crossing', () => {
    const rate = lockedFxRate(
      { amount: 10_000, currency: 'USD' }, // $100.00
      { amount: 9_200, currency: 'EUR' }, // €92.00
    )
    expect(rate).toBeCloseTo(92 / 100, 12)
  })

  test('a zero settlement amount falls back to the indicative table rather than a wrong number', () => {
    const rate = lockedFxRate(
      { amount: 0, currency: 'RWF' },
      { amount: 10_000, currency: 'USD' },
    )
    expect(rate).toBe(convert(1_000_000, 'RWF', 'USD')!.rate)
  })

  test('a zero presentment amount (0/0) also falls back rather than storing NaN', () => {
    const rate = lockedFxRate(
      { amount: 0, currency: 'RWF' },
      { amount: 0, currency: 'USD' },
    )
    expect(rate).toBe(convert(1_000_000, 'RWF', 'USD')!.rate)
    expect(Number.isNaN(rate)).toBe(false)
  })

  test('a corridor the table cannot price either falls back to null, not a crash', () => {
    const rate = lockedFxRate(
      { amount: 0, currency: 'RWF' },
      { amount: 10_000, currency: 'ZZZ' },
    )
    expect(rate).toBeNull()
  })

  test('a negative or otherwise invalid realised ratio also falls back', () => {
    // Not a real scenario a verified charge can produce, but the guard exists
    // for exactly this: `Number.isFinite(realised) && realised > 0` refuses to
    // store something a real transaction could never mean.
    const rate = lockedFxRate(
      { amount: -145_000, currency: 'RWF' },
      { amount: 10_000, currency: 'USD' },
    )
    expect(rate).toBe(convert(1_000_000, 'RWF', 'USD')!.rate)
  })
})

describe('lockedFxRate — wired through fund_deal and atLockedRate, against real Postgres', () => {
  let h: Harness
  let tenant: string
  let seller: string

  beforeAll(async () => {
    h = await migrated()

    const { rows: [t] } = await h.db.query<{ id: string }>(
      `insert into tenants (name, slug) values ('Locked Rate Co', 'locked-rate-co')
       returning id`,
    )
    tenant = t.id

    const { rows: [s] } = await h.db.query<{ id: string }>(
      `insert into sellers (tenant_id, name, country, payout_currency, payout_provider,
                            beneficiary_token, masked_destination)
       values ($1, 'Host', 'RW', 'RWF', 'flutterwave_momo', 'tok_1', 'MTN •••• 4821')
       returning id`,
      [tenant],
    )
    seller = s.id
  })

  afterAll(() => h.close())

  async function seedDeal(opts: {
    amount: number
    presentmentCurrency: string
    presentmentAmount: number
  }): Promise<string> {
    const { rows: [deal] } = await h.db.query<{ id: string }>(
      `insert into deals (tenant_id, buyer_ref, seller_id, description, amount, currency,
                          presentment_currency, presentment_amount, buyer_country, provider,
                          status, fee_amount, expected_complete_at)
       values ($1, 'buyer-1', $2, 'Car hire', $3, 'RWF', $4, $5,
               'RW', 'stripe', 'created', 0, now() + interval '2 days')
       returning id`,
      [tenant, seller, opts.amount, opts.presentmentCurrency, opts.presentmentAmount],
    )
    return deal.id
  }

  const dealRow = async (id: string) => {
    const { rows: [d] } = await h.db.query<{
      status: string
      presentment_amount: number
      presentment_currency: string
      fx_rate: string | null
    }>(
      `select status, presentment_amount, presentment_currency, fx_rate
       from deals where id = $1`,
      [id],
    )
    return d
  }

  test('a clean cross-currency funding stores a rate that reproduces exactly what was charged', async () => {
    // Quoted at RWF 145,000 ≈ USD 100.00 (whatever the indicative table said
    // when the deal was created); the buyer's card was actually charged
    // USD 100.00 too, so this is a matched, ordinary funding.
    const deal = await seedDeal({
      amount: 145_000,
      presentmentCurrency: 'USD',
      presentmentAmount: 10_000,
    })

    const verified = { amount: 10_000, currency: 'USD' }
    const rate = lockedFxRate({ amount: 145_000, currency: 'RWF' }, verified)
    expect(rate).not.toBeNull()

    await h.db.query(
      `select * from fund_deal($1, 'stripe', 'pi_clean', 'card', 'Visa', $2, $3, $4, 3)`,
      [deal, verified.amount, verified.currency, rate],
    )

    const d = await dealRow(deal)
    expect(d.status).toBe('funded_held')
    expect(Number(d.fx_rate)).toBeCloseTo(rate!, 9)

    // The point of the fix: applying the stored rate back to the settlement
    // amount reproduces exactly what the provider actually collected.
    const reproduced = atLockedRate(145_000, Number(d.fx_rate), 'RWF', 'USD', 'settlement_to_presentment')
    expect(reproduced).toBe(verified.amount)
  })

  test('the OLD table-based rate would NOT have reproduced the real charge (regression evidence)', async () => {
    // Same deal shape as above, but computing the rate the old, buggy way —
    // straight off `convert()`'s indicative table — to document the bug this
    // file fixes: it does not round-trip to the money that actually moved.
    const oldRate = convert(1_000_000, 'RWF', 'USD')!.rate
    const reproducedByOldRate = atLockedRate(145_000, oldRate, 'RWF', 'USD', 'settlement_to_presentment')

    // The real charge was USD 100.00 (10,000 cents); the table's stale rate
    // prices the same settlement amount differently.
    expect(reproducedByOldRate).not.toBe(10_000)
  })

  test('a mismatched payment (verified.amount differs from presentment_amount) still locks the realised rate of what genuinely happened', async () => {
    // Quoted/expected USD 95.00, but the card actually settled at USD 100.00 —
    // `fund_deal` sends this to `disputed`, never `funded_held`. The realised
    // rate must still reflect the true $100, not the $95 that was merely
    // expected.
    const deal = await seedDeal({
      amount: 145_000,
      presentmentCurrency: 'USD',
      presentmentAmount: 9_500,
    })

    const verified = { amount: 10_000, currency: 'USD' }
    const rate = lockedFxRate({ amount: 145_000, currency: 'RWF' }, verified)

    await h.db.query(
      `select * from fund_deal($1, 'stripe', 'pi_mismatch', 'card', 'Visa', $2, $3, $4, 3)`,
      [deal, verified.amount, verified.currency, rate],
    )

    const d = await dealRow(deal)
    expect(d.status).toBe('disputed')
    // presentment_amount is rewritten to what actually arrived.
    expect(d.presentment_amount).toBe(10_000)
    expect(Number(d.fx_rate)).toBeCloseTo(rate!, 9)

    // Reproducing off the stored rate gives the true $100 charged, not the
    // $95 that was merely quoted — the deal still "gets the realised rate of
    // what genuinely happened".
    const reproduced = atLockedRate(145_000, Number(d.fx_rate), 'RWF', 'USD', 'settlement_to_presentment')
    expect(reproduced).toBe(10_000)
    expect(reproduced).not.toBe(9_500)
  })

  test('a same-currency deal still stores no rate at all, wired end to end', async () => {
    const deal = await seedDeal({
      amount: 145_000,
      presentmentCurrency: 'RWF',
      presentmentAmount: 145_000,
    })

    const verified = { amount: 145_000, currency: 'RWF' }
    const rate = lockedFxRate({ amount: 145_000, currency: 'RWF' }, verified)
    expect(rate).toBeNull()

    await h.db.query(
      `select * from fund_deal($1, 'flutterwave', 'flw_same_ccy', 'mobile_money'::payment_method,
                               'MTN', $2, $3, $4, 3)`,
      [deal, verified.amount, verified.currency, rate],
    )

    const d = await dealRow(deal)
    expect(d.status).toBe('funded_held')
    expect(d.fx_rate).toBeNull()
  })
})
