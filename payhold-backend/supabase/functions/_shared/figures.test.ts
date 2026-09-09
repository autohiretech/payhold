/**
 * `overageFor` — the one piece of installment billing that is pure enough to
 * test without a database. `balanceFigures` and `settle_deal_balance` (the
 * SQL side) are covered in `tests/migrations.test.ts`, against a real
 * Postgres, because they need FX and settings that only exist there.
 */

import { assertEquals } from 'jsr:@std/assert@1'
import { clampOverage, overageFor, releaseFigures } from './figures.ts'
import type { Deal } from './types.ts'

/** Just enough of `Deal` for `overageFor`, which reads four fields only. */
function deal(fields: Partial<Deal>): Deal {
  return {
    overage_rate: null,
    overage_unit_seconds: null,
    expected_complete_at: null,
    ...fields,
  } as Deal
}

Deno.test('no rate set — always zero, whatever the time', () => {
  const d = deal({ expected_complete_at: '2026-01-01T00:00:00Z' })
  assertEquals(overageFor(d, new Date('2026-06-01T00:00:00Z')), 0)
})

Deno.test('no expected_complete_at — always zero, even with a rate set', () => {
  const d = deal({ overage_rate: 500, overage_unit_seconds: 3600 })
  assertEquals(overageFor(d, new Date()), 0)
})

Deno.test('on time — zero', () => {
  const d = deal({
    overage_rate: 500,
    overage_unit_seconds: 3600,
    expected_complete_at: '2026-01-01T12:00:00Z',
  })
  assertEquals(overageFor(d, new Date('2026-01-01T11:00:00Z')), 0)
  assertEquals(overageFor(d, new Date('2026-01-01T12:00:00Z')), 0)
})

Deno.test('a started unit is a whole unit — hourly', () => {
  const d = deal({
    overage_rate: 500,
    overage_unit_seconds: 3600,
    expected_complete_at: '2026-01-01T12:00:00Z',
  })
  // One second late still owes a full hour, the way a rental desk rounds.
  assertEquals(overageFor(d, new Date('2026-01-01T12:00:01Z')), 500)
  // Exactly one hour late: exactly one unit, not two.
  assertEquals(overageFor(d, new Date('2026-01-01T13:00:00Z')), 500)
  // One second into the second hour: two units.
  assertEquals(overageFor(d, new Date('2026-01-01T13:00:01Z')), 1_000)
})

Deno.test('daily unit works the same way, at its own scale', () => {
  const d = deal({
    overage_rate: 5_000,
    overage_unit_seconds: 86_400,
    expected_complete_at: '2026-01-01T00:00:00Z',
  })
  assertEquals(overageFor(d, new Date('2026-01-02T00:00:00Z')), 5_000)
  assertEquals(overageFor(d, new Date('2026-01-03T12:00:00Z')), 15_000)
})

Deno.test('clampOverage: no override at all leaves the computed number alone', () => {
  assertEquals(clampOverage(15_000, undefined), 15_000)
  assertEquals(clampOverage(15_000, null), 15_000)
})

Deno.test('clampOverage: a smaller override wins', () => {
  assertEquals(clampOverage(15_000, 5_000), 5_000)
})

Deno.test('clampOverage: zero waives the charge entirely', () => {
  assertEquals(clampOverage(15_000, 0), 0)
})

Deno.test('clampOverage: a bigger override has no effect — it can only reduce', () => {
  assertEquals(clampOverage(5_000, 50_000), 5_000)
})

Deno.test('clampOverage: a negative override floors at zero rather than adding money', () => {
  assertEquals(clampOverage(5_000, -1_000), 0)
})

Deno.test('clampOverage: a non-numeric value (bad metadata) is ignored, not thrown', () => {
  assertEquals(clampOverage(15_000, 'nope'), 15_000)
})

// ---------------------------------------------------------------------------
// `releaseFigures` — the fee, converted at the rate the deal actually locked
// ---------------------------------------------------------------------------
//
// Untested until the live-rate work made the gap dangerous. `p_fee_presentment`
// used to go through `convertOrThrow`, which reads the indicative table, so a
// deal funded in January had its fee repriced at release against whatever that
// table said today — against money collected once, months earlier, that has not
// moved since. Now that the creation rate is a live quote rather than the same
// table, the two could differ by anything at all, and the difference lands in
// `fees_retained`, which reconciliation checks against a real provider balance.

/** Enough of a Supabase client for the one seller lookup this makes. */
function dbWithSellerCurrency(currency: string | null) {
  return {
    from() {
      return {
        select() {
          return {
            eq() {
              return {
                maybeSingle: () =>
                  Promise.resolve({ data: currency ? { payout_currency: currency } : null }),
              }
            },
          }
        },
      }
    },
    // deno-lint-ignore no-explicit-any
  } as any
}

/** An RWF deal presented in USD, funded at a rate locked well away from the table. */
function crossCurrencyDeal(fxRate: number | null): Deal {
  return {
    seller_id: 'seller-1',
    amount: 500_000,
    currency: 'RWF',
    presentment_currency: 'USD',
    // 500,000 RWF at this rate. The table's own guess is ~1400 RWF/USD.
    presentment_amount: 35_000,
    fee_amount: 50_000,
    fx_rate: fxRate,
  } as Deal
}

Deno.test('releaseFigures: the fee uses the deal\'s locked rate, not today\'s table', async () => {
  // 0.00007 USD per RWF — 1 USD to about 14,285 RWF, an order of magnitude off
  // the table, so a figure computed either way is unmistakable.
  const d = crossCurrencyDeal(0.00007)
  const figures = await releaseFigures(dbWithSellerCurrency('RWF'), d)

  // 50,000 RWF major-unit × 0.00007 = 3.50 USD = 350 minor units.
  assertEquals(figures.p_fee_presentment, 350)
  // The seller is owed the settlement currency, untouched by any of this.
  assertEquals(figures.p_payout_currency, 'RWF')
  assertEquals(figures.p_payout_amount, 450_000)
})

Deno.test('releaseFigures: a deal with no locked rate had no conversion to undo', async () => {
  const d = {
    ...crossCurrencyDeal(null),
    presentment_currency: 'RWF',
    presentment_amount: 500_000,
  } as Deal

  const figures = await releaseFigures(dbWithSellerCurrency('RWF'), d)
  // Passed through rather than run past a rate table that would invent one.
  assertEquals(figures.p_fee_presentment, 50_000)
})

Deno.test('releaseFigures: a seller with no payout currency falls back to settlement', async () => {
  const d = crossCurrencyDeal(0.00007)
  const figures = await releaseFigures(dbWithSellerCurrency(null), d)
  assertEquals(figures.p_payout_currency, 'RWF')
})

Deno.test('releaseFigures: a seller banking in what the buyer paid uses the locked rate', async () => {
  // Settlement RWF, presented in USD, and the host banks in USD — so the
  // payout corridor IS the corridor the deal locked at funding. Exact, and no
  // rate is fetched at release.
  const d = crossCurrencyDeal(0.00007)
  const figures = await releaseFigures(dbWithSellerCurrency('USD'), d)

  assertEquals(figures.p_payout_currency, 'USD')
  // 450,000 RWF × 0.00007 = 31.50 USD = 3150 minor units.
  assertEquals(figures.p_payout_amount, 3150)
})

Deno.test('releaseFigures: no conversion when the seller banks in the settlement currency', async () => {
  // The common case, and the one that must never touch a rate at all: a
  // Rwandan host with an RWF listing.
  const d = crossCurrencyDeal(0.00007)
  const figures = await releaseFigures(dbWithSellerCurrency('RWF'), d)
  assertEquals(figures.p_payout_amount, 450_000)
})
