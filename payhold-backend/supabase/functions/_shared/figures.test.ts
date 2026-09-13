/**
 * `overageFor` — the one piece of installment billing that is pure enough to
 * test without a database. `balanceFigures` and `settle_deal_balance` (the
 * SQL side) are covered in `tests/migrations.test.ts`, against a real
 * Postgres, because they need FX and settings that only exist there.
 */

import { assertEquals, assertRejects } from 'jsr:@std/assert@1'
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

/**
 * Enough of a Supabase client for the two reads `releaseFigures` makes: the
 * seller's payout currency, and the deal's refunds.
 *
 * The refunds read exists because the pool is what is left after money already
 * sent back, and `release_deal` subtracts the identical set under its row lock
 * — two figures describing the same money have to be built from the same facts.
 */
function dbWithSellerCurrency(currency: string | null, refunds: { amount: number }[] = []) {
  return {
    from(table: string) {
      if (table === 'refunds') {
        return {
          select: () => ({
            eq: () => ({
              neq: () => Promise.resolve({ data: refunds, error: null }),
            }),
          }),
        }
      }
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

/**
 * An RWF deal presented in USD, funded at a rate locked well away from the
 * table.
 *
 * The three money fields are mutually consistent, which they were not before
 * 2026-09-13: `presentment_amount` said 35,000 minor USD for 500,000 RWF at
 * 0.00007, which is ten times the 3,500 that rate gives. Nothing read it, so
 * nothing caught it. Now the payout is computed from the presentment side and
 * an inconsistent fixture would prove whatever it was written to prove.
 */
function crossCurrencyDeal(fxRate: number | null, extra: Partial<Deal> = {}): Deal {
  return {
    id: 'deal-1',
    seller_id: 'seller-1',
    amount: 500_000,
    currency: 'RWF',
    presentment_currency: 'USD',
    // 500,000 RWF major-unit × 0.00007 = 35.00 USD = 3,500 minor units.
    presentment_amount: 3_500,
    fee_amount: 50_000,
    provider_fee_amount: 0,
    tax_amount: 0,
    fx_rate: fxRate,
    ...extra,
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
  const d = crossCurrencyDeal(null, {
    presentment_currency: 'RWF',
    presentment_amount: 500_000,
  })

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
  // The pool is 3,500 - 350 = 3,150 minor USD, and the seller banks in USD, so
  // it is handed over exactly as it stands with no rate applied at all.
  assertEquals(figures.p_payout_amount, 3150)
})

Deno.test('releaseFigures: the provider\'s fee comes out of the seller\'s payout', async () => {
  // The bug of 2026-09-12, in miniature. The payout used to be
  // `amount - fee_amount` — the platform's fee only — while the ledger pool
  // also struck off what the rail charged. On a live Kigali deal the two came
  // out RWF 19,273 apart and the difference left our own provider balance.
  const d = crossCurrencyDeal(0.00007, { provider_fee_amount: 100, tax_amount: 50 })
  const figures = await releaseFigures(dbWithSellerCurrency('USD'), d)

  // 3,500 - 350 fee - 100 rail - 50 tax = 3,000 minor USD.
  assertEquals(figures.p_payout_amount, 3_000)
})

Deno.test('releaseFigures: money already refunded is not paid out again', async () => {
  const d = crossCurrencyDeal(0.00007)
  const figures = await releaseFigures(dbWithSellerCurrency('USD', [{ amount: 500 }]), d)

  // 3,500 - 500 refunded - 350 fee = 2,650 minor USD.
  assertEquals(figures.p_payout_amount, 2_650)
})

Deno.test('releaseFigures: a deal with nothing left for the seller is refused, not paid zero', async () => {
  const d = crossCurrencyDeal(0.00007, { provider_fee_amount: 3_200 })
  await assertRejects(() => releaseFigures(dbWithSellerCurrency('USD'), d))
})

Deno.test('releaseFigures: no conversion when the seller banks in the settlement currency', async () => {
  // The common case, and the one that must never touch a rate at all: a
  // Rwandan host with an RWF listing.
  const d = crossCurrencyDeal(0.00007)
  const figures = await releaseFigures(dbWithSellerCurrency('RWF'), d)
  assertEquals(figures.p_payout_amount, 450_000)
})
