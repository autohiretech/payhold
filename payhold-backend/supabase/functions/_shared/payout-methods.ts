/**
 * Which destinations a market can actually be paid into — `payout.methods`.
 *
 * Lifted out of `payment-options/index.ts` on 2026-09-10 so it can be pinned
 * without a handler. The handler runs under `Deno.serve`, so nothing can
 * import it, and this list is the one a client renders its payout-setup form
 * from: what it says and what `sellers/rail-adapter.ts` then accepts have to
 * be the same set, or the form offers a method registration refuses. That is
 * exactly the bug this file was extracted during — a US host was shown PayPal
 * and refused it — and the two are now pinned against each other in
 * `tests/paypal-alongside-stripe.test.ts` rather than by eye.
 *
 * **`kind` is not this.** `payout.kind` names the *preferred* destination and
 * is a single value; a market is not. Kenya, Tanzania and Malawi take a wallet
 * while their bank corridor sits behind a Flutterwave request; the United
 * States takes a Stripe Connect account **or** a PayPal one. `kind` sorts
 * first in `methods`, and that is the whole of its authority here.
 */

import type { PayoutKind } from './rails.ts'

/**
 * Which destination each rail is, in the vocabulary `kind` already uses. The
 * declared-and-disabled wallets (§29.3) map to nothing: they never appear in
 * `methods` because they can never be eligible.
 */
export const RAIL_KIND: Record<string, PayoutKind> = {
  flutterwave_momo: 'momo',
  flutterwave_bank: 'bank',
  stripe_connect: 'connect',
  paypal: 'paypal',
}

/**
 * `route_evaluation` verdicts that mean "this rail pays this corridor".
 *
 * The same three `sellers/rail-adapter.ts`'s `RAIL_ON` holds, and deliberately
 * so: a seller is registered against a corridor, not an amount, so a route
 * whose minimum this particular payout is under is still a corridor somebody
 * can be set up in. The two lists agreeing is what makes this endpoint's
 * answer and registration's answer the same answer.
 */
const COVERED = new Set(['eligible', 'below_route_minimum', 'above_route_maximum'])

/**
 * Every destination this market can be paid into, preferred one first.
 *
 * Derived from `route_evaluation` rather than from the registry, so it is what
 * the routing table will actually carry this second: a rail switched off,
 * risk-held or missing its adapter drops out here without anything needing to
 * remember to remove it.
 */
export function payoutMethods(rows: unknown, preferred: PayoutKind | null): PayoutKind[] {
  const eligible = (Array.isArray(rows) ? rows : []).filter((r) =>
    COVERED.has((r as { reason_code?: string })?.reason_code ?? '')
  ) as { payout_provider: string }[]

  return [...new Set(eligible.map((r) => RAIL_KIND[r.payout_provider]).filter(Boolean))]
    .sort((a, b) => Number(b === preferred) - Number(a === preferred))
}

/** One rail's row as the coverage read returns it, already filtered to live rails. */
export interface CoverageRow {
  payout_provider: string
  countries: string[]
  currencies: string[]
  local_currency_only: boolean
}

/** A currency a market can be paid in, and what it can be paid into there. */
export interface PayableCurrency {
  currency: string
  methods: PayoutKind[]
  default: boolean
}

/**
 * Every currency a seller in this market can actually be paid in — the other
 * half of `methods`, and the half a payout form cannot invent.
 *
 * **Eligibility is per (country, currency), not per country**, and until this
 * existed nothing said so out loud. A client asking about Kenya was answered
 * for KE/KES because that is the country's own currency, got `['momo']`, and
 * concluded PayPal does not reach Kenya. It does — KE/**USD** routes it. The
 * same is true of Nigeria, Ghana, Rwanda and South Africa: PayPal's route row
 * carries those countries and does not carry their local currencies, so a
 * client that can only ever ask in the local currency can never reach it, and
 * no amount of enabling rails on our side changes that.
 *
 * So the list is returned rather than left to be guessed, and it is derived
 * from the same rows `payoutCoverage` judges — not from `countries.ts`, which
 * says what is *possible*. A rail switched off, risk-held or missing its
 * adapter drops out of here for free.
 *
 * **The default sorts first and is flagged**, for the reason `kind` sorts
 * first in `methods`: a chooser that preselected something other than what a
 * host gets today would silently move existing sellers onto a different
 * currency, which is a change to what they are paid, made by a dropdown's
 * default. The country's own currency is the default when it is payable at
 * all; when it is not — which is every market PayPal reaches and Flutterwave
 * does not — the first remaining currency leads and nothing is preselected on
 * a host's behalf that they were not already on.
 *
 * Amount limits are deliberately absent, exactly as they are from `methods`:
 * a seller is registered against a corridor, not against a payout.
 */
export function payableCurrencies(
  rows: CoverageRow[],
  country: string,
  localCurrency: string,
): PayableCurrency[] {
  const byCurrency = new Map<string, Set<PayoutKind>>()

  for (const row of rows) {
    if (!row.countries.includes(country)) continue
    const kind = RAIL_KIND[row.payout_provider]
    if (!kind) continue

    // `countries` × `currencies` is a cross product, and for a local rail most
    // of it is fiction — `flutterwave_momo` carries nine countries and eight
    // currencies, which taken literally offers a Kenyan wallet Rwandan francs.
    // `local_currency_only` (`20260910000007`) is the fact that collapses it:
    // a wallet or a domestic bank account is denominated in the country's own
    // money and receives nothing else.
    const reachable = row.local_currency_only
      ? row.currencies.filter((c) => c === localCurrency)
      : row.currencies

    for (const currency of reachable) {
      const set = byCurrency.get(currency) ?? new Set<PayoutKind>()
      set.add(kind)
      byCurrency.set(currency, set)
    }
  }

  const payable = [...byCurrency].map(([currency, kinds]) => ({
    currency,
    methods: [...kinds].sort(),
    default: currency === localCurrency,
  }))

  // The local currency first when it is payable, then the rest alphabetically
  // so the order is total — a list whose tail order came from Map insertion
  // would reshuffle when a rail's row was edited, for no reason a reader could
  // see. Same argument as `route_evaluation`'s tie-breaker on `payout_provider`.
  return payable.sort((a, b) =>
    Number(b.default) - Number(a.default) || a.currency.localeCompare(b.currency)
  )
}
