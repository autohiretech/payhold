/**
 * Currency conversion.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * A deal has two currencies, and conflating them is how cross-border payments
 * go wrong:
 *
 *   settlement  — what the seller is owed. The host in Kigali quotes RWF and
 *                 wants RWF. This is `Deal.currency`.
 *   presentment — what the buyer is actually charged. A card in Mumbai cannot
 *                 be charged RWF, so the buyer pays USD.
 *
 * PayHold collects the presentment currency, holds it on whichever rail took
 * it, and converts at payout so the seller receives their settlement currency.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * THE RATES BELOW ARE INDICATIVE PLACEHOLDERS. They exist so the mock can show
 * plausible numbers. The real system must take its rate from the provider at
 * charge time and store it on the deal — never from a table in the codebase,
 * and never re-derived later, because the rate moves between charge and payout
 * and the difference is real money someone has to absorb.
 */

import type { Currency } from '@/api/types'

/** Units of each currency per 1 USD. Indicative, August 2026. */
const PER_USD: Partial<Record<Currency, number>> = {
  USD: 1,
  EUR: 0.92,
  GBP: 0.79,
  // East Africa
  RWF: 1400,
  KES: 129,
  UGX: 3700,
  TZS: 2650,
  BIF: 2900,
  ETB: 122,
  // West and Central Africa
  NGN: 1580,
  GHS: 15.2,
  XOF: 605,
  XAF: 605,
  SLE: 22.8,
  // Southern Africa
  ZAR: 18.1,
  ZMW: 26.4,
  MWK: 1740,
  MZN: 63.5,
  BWP: 13.6,
  // North Africa
  EGP: 48.5,
  MAD: 9.9,
  TND: 3.1,
  DZD: 134,
  // Elsewhere, for buyers paying from these markets
  INR: 85,
  AED: 3.67,
  CNY: 7.2,
  JPY: 150,
  CAD: 1.36,
  AUD: 1.52,
  BRL: 5.4,
  MXN: 18.5,
  CHF: 0.88,
  SGD: 1.34,
  ZWG: 26,
}

export interface Conversion {
  amount: number
  /** Units of `to` per 1 unit of `from`, as applied. */
  rate: number
}

/** True when both currencies have a rate, so a conversion is possible. */
export function canConvert(from: Currency, to: Currency): boolean {
  return PER_USD[from] !== undefined && PER_USD[to] !== undefined
}

/**
 * Convert between currencies, both in minor units.
 *
 * Returns null when either side has no rate — better to surface "we cannot
 * price this" than to invent a number and move money against it.
 */
export function convert(
  amount: number,
  from: Currency,
  to: Currency,
): Conversion | null {
  if (from === to) return { amount, rate: 1 }

  const fromRate = PER_USD[from]
  const toRate = PER_USD[to]
  if (fromRate === undefined || toRate === undefined) return null

  const rate = toRate / fromRate
  return { amount: Math.round(amount * rate), rate }
}

/** How the rate reads to a person: "1 USD ≈ 1,400 RWF". */
export function formatRate(from: Currency, to: Currency, rate: number): string {
  const shown =
    rate >= 100
      ? Math.round(rate).toLocaleString('en-GB')
      : rate.toFixed(rate < 1 ? 4 : 2)
  return `1 ${from} ≈ ${shown} ${to}`
}
