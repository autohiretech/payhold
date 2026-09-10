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
