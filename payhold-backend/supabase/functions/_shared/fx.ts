/**
 * Currency conversion — the one FX table in the system.
 *
 * A deal has two currencies and conflating them is how cross-border payments go
 * wrong:
 *
 *   settlement  — what the seller is owed. A host in Kigali quotes RWF and
 *                 wants RWF. This is `deals.currency`.
 *   presentment — what the buyer is actually charged. A card in Mumbai cannot
 *                 be charged RWF, so that buyer pays USD.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE RATES BELOW ARE INDICATIVE AND MUST NOT PRICE A LIVE CHARGE.
 *
 * They exist so a deal can be quoted before the buyer picks a rail, and so demo
 * mode has plausible numbers. The rate that matters is the provider's, taken at
 * charge time and **locked onto the deal** (`deals.fx_rate`) — because the rate
 * moves between charge and payout, and the difference is real money somebody
 * has to absorb. `lockedRate()` is how a funded deal is converted afterwards;
 * nothing should re-derive a rate for a deal that has already been paid.
 *
 * The table lives in TypeScript rather than the database on purpose: SQL owns
 * atomicity and the ledger, TypeScript owns FX and fee policy, and the money
 * functions take already-converted figures. See payhold-backend/CLAUDE.md.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { PayHoldError, type Currency, type Money } from './types.ts'

/** Units of each currency per 1 USD. Indicative, August 2026. */
const PER_USD: Record<string, number> = {
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
  amount: Money
  /** Units of `to` per 1 unit of `from`, as applied. */
  rate: number
}

/**
 * ISO 4217 currencies with no minor unit — 1 unit is the smallest, there is no
 * "cents" to divide into. `PER_USD` above is quoted in **major** units either
 * way (1400 RWF per USD is a fact about whole Francs), and `Money` is minor
 * units everywhere else in PayHold — RWF's happen to be the same number, a
 * card-charged USD's do not. `convert` has to know which currencies collapse
 * that distinction and which don't, or a conversion crossing the boundary is
 * short by exactly this set's multiplier.
 */
const ZERO_DECIMAL = new Set(['RWF', 'UGX', 'XAF', 'XOF', 'JPY', 'BIF'])

function toMajor(amount: number, currency: Currency): number {
  return ZERO_DECIMAL.has(currency) ? amount : amount / 100
}

function toMinor(major: number, currency: Currency): Money {
  return Math.round(ZERO_DECIMAL.has(currency) ? major : major * 100)
}

export function canConvert(from: Currency, to: Currency): boolean {
  return PER_USD[from] !== undefined && PER_USD[to] !== undefined
}

/**
 * Convert between currencies, both in minor units.
 *
 * Returns null when either side has no rate. "We cannot price this" is a better
 * answer than a number we invented and then moved money against.
 *
 * `PER_USD`'s rate is major-to-major, so the amount has to cross into major
 * units before it is applied and back into `to`'s minor units after —
 * skipping that (as this used to) is invisible between two currencies with
 * the same decimal convention and silently short by 100× crossing into or
 * out of a `ZERO_DECIMAL` one. Found on a live RWF→USD deal: RWF 53,892
 * (~$38.49) priced as `presentment_amount: 38` — thirty-eight *cents*.
 */
export function convert(amount: Money, from: Currency, to: Currency): Conversion | null {
  if (from === to) return { amount, rate: 1 }

  const fromRate = PER_USD[from]
  const toRate = PER_USD[to]
  if (fromRate === undefined || toRate === undefined) return null

  const rate = toRate / fromRate
  return { amount: toMinor(toMajor(amount, from) * rate, to), rate }
}

/** Same, but a missing rate is a refusal rather than a null to forget to check. */
export function convertOrThrow(
  amount: Money,
  from: Currency,
  to: Currency,
): Conversion {
  const result = convert(amount, from, to)
  if (!result) {
    throw new PayHoldError(
      'policy_violation',
      `No exchange rate is available between ${from} and ${to}`,
    )
  }
  return result
}

/**
 * Convert using the rate a deal locked when it was funded.
 *
 * `rate` is presentment per settlement, in major units — the same figure
 * `convert`'s own `.rate` returns — so settlement → presentment multiplies
 * and the reverse divides. Using today's rate on a deal funded last week
 * would silently reprice money that has already been collected.
 *
 * Both currencies are required for the same reason `convert` needs them:
 * the rate is major-to-major, and `amount` is minor units of whichever side
 * is the input, so crossing a `ZERO_DECIMAL` boundary needs the same
 * toMajor/toMinor step `convert` applies.
 */
export function atLockedRate(
  amount: Money,
  rate: number,
  settlementCurrency: Currency,
  presentmentCurrency: Currency,
  direction: 'settlement_to_presentment' | 'presentment_to_settlement',
): Money {
  if (direction === 'settlement_to_presentment') {
    return toMinor(toMajor(amount, settlementCurrency) * rate, presentmentCurrency)
  }
  return toMinor(toMajor(amount, presentmentCurrency) / rate, settlementCurrency)
}

/**
 * What currency to charge a buyer in, given what the seller is owed.
 *
 * Their own settlement currency when the buyer's market can be charged it,
 * otherwise the best international currency that market can pay — USD first,
 * since it is the most widely accepted and the one every rate table has.
 */
export function presentmentCurrencyFor(
  payable: Currency[],
  settlement: Currency,
): Currency | null {
  if (payable.includes(settlement)) return settlement

  const preferred = ['USD', 'EUR', 'GBP']
  return (
    preferred.find((c) => payable.includes(c) && canConvert(settlement, c)) ??
      payable.find((c) => canConvert(settlement, c)) ??
      null
  )
}
