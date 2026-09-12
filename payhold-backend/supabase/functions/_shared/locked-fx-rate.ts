/**
 * The rate a cross-currency deal locks at funding.
 *
 * A deal is quoted before the buyer picks a rail, priced off `fx.ts`'s
 * indicative table because there is nothing else to price it with yet. Once
 * the rail has actually taken the money, that guess should be thrown away:
 * the provider told us, in the same webhook/poll that confirms the charge,
 * exactly how much of `verified.currency` it collected against a deal
 * denominated in `deal.currency`. That ratio — what genuinely arrived,
 * against what the seller is owed — *is* the realised rate. There is no
 * reason to ask the stale table for a number the transaction already answered.
 *
 * This used to read `convert(1_000_000, deal.currency, verified.currency)`
 * unconditionally, which is the indicative table dressed up as a "locked"
 * rate — the comment at each call site said "locked from what actually
 * arrived" while the code never looked at `verified.amount` at all. Every
 * cross-currency `seller_net` and every presentment-currency fee derived from
 * it (`figures.ts`'s `atLockedRate` call sites) has been carrying that stale
 * guess since. See PayHold_Spec_V2.md and the FX bug report for the fuller
 * story; this file is the fix, called from the four places that lock a rate:
 * `settle.ts`, and the Flutterwave/Stripe/PayPal webhooks.
 *
 * A deal whose payment mismatched — `verified.amount` differs from the
 * deal's `presentment_amount`, which sends it to `disputed` rather than
 * `funded_held` — still gets the realised rate of what genuinely happened.
 * `fund_deal` decides `disputed` vs `funded_held`; this only ever describes
 * the ratio between the two amounts it was handed, whichever way the deal
 * ends up.
 */

import { convert, toMajor } from './fx.ts'
import type { Currency, Money } from './types.ts'

/**
 * Presentment units per one settlement unit — the same shape `convert()`'s
 * own `.rate` returns, so `atLockedRate` and `deal_amounts()` need no change
 * to keep consuming `deals.fx_rate`.
 *
 * `null` for a same-currency deal: there is nothing to lock. Otherwise the
 * realised rate — `verified.amount` against `deal.amount`, both first
 * crossed into major units, because a ratio of raw minor units is wrong
 * whenever the two currencies keep a different number of decimal places
 * (RWF/UGX have none, USD/EUR have two).
 *
 * Falls back to `convert()`'s indicative-table rate — today's behaviour,
 * unchanged — only when the realised rate cannot be computed at all: a zero
 * or otherwise non-finite settlement amount, which is a data problem
 * upstream and not something this function should turn into a silent null
 * for an otherwise-ordinary cross-currency deal.
 */
export function lockedFxRate(
  deal: { amount: Money; currency: Currency },
  verified: { amount: Money; currency: Currency },
): number | null {
  if (verified.currency === deal.currency) return null

  const settlementMajor = toMajor(deal.amount, deal.currency)
  const presentmentMajor = toMajor(verified.amount, verified.currency)
  const realised = presentmentMajor / settlementMajor

  if (Number.isFinite(realised) && realised > 0) return realised

  return convert(1_000_000, deal.currency, verified.currency)?.rate ?? null
}
