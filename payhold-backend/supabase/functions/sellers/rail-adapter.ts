/**
 * Which adapter carries each payout rail, and the refusal that depends on it.
 *
 * `types.ts` draws the line: `PayoutProvider` names a **rail** — the shape of
 * destination a token was minted for — and `Provider` names the adapter that
 * talks to it. One adapter carries several rails. `payout_routes.provider` is
 * the same fact in SQL, and `20260807000011` made it not null because a rail
 * with nothing built behind it still has a *named* adapter — `loadProvider` is
 * what refuses the unbuilt ones, with a reason, which is why this map is total
 * rather than `null` for the declared-and-disabled five.
 *
 * Until this file existed the relationship was written down nowhere on the
 * function side. `payoutRoute` answers "which adapter pays this corridor", the
 * caller's `payout_provider` answers "which rail is this destination", and
 * nothing compared the two. `assertRailOnRoute` is that comparison. It lives
 * beside the sellers handler rather than in `_shared/rails.ts` only because the
 * handler itself cannot be imported by a test — `Deno.serve` runs at module
 * load — and the map has to be pinned against the seeded routes somewhere.
 */

import type { PayoutRoute } from '../_shared/rails.ts'
import {
  type Country,
  PayHoldError,
  type PayoutProvider,
  type Provider,
} from '../_shared/types.ts'

export const RAIL_ADAPTER: Record<PayoutProvider, Provider> = {
  flutterwave_momo: 'flutterwave',
  flutterwave_bank: 'flutterwave',
  stripe_connect: 'stripe',
  paypal: 'paypal',
  venmo: 'paypal',
  cash_app_pay: 'cash_app_pay',
  alipay: 'china_wallet_partner',
  wechat_pay: 'china_wallet_partner',
}

/**
 * The adapter behind a rail, or null for a string that is not a rail at all.
 * The request body is untrusted JSON whatever `PayoutProvider` says it is, and
 * the SQL enum that would refuse a made-up rail sits *after* the tokenize call.
 */
export function railAdapterFor(rail: string): Provider | null {
  return Object.hasOwn(RAIL_ADAPTER, rail) ? RAIL_ADAPTER[rail as PayoutProvider] : null
}

/**
 * Refuse a destination whose rail is not the one its corridor is paid on.
 *
 * Found live. A Rwandan seller's primary destination was `Card •••• 4538` with
 * `payout_provider = 'stripe_connect'` and country `RW`, and their Earnings
 * page read "Payouts are on hold — stripe_connect cannot pay a destination in
 * RW". That sentence was `route_payout` being right about a row that should
 * never have been written: the seeded `payout_routes` for `stripe_connect`
 * stop at `US, AE, GB, …` by design, because Stripe cannot pay a Rwandan
 * recipient.
 *
 * How it was written: `addDestination` checked `route.blocked` and nothing
 * else, and `create` before it did the same. For RW/RWF `payoutRoute` returns
 * a perfectly good route — Flutterwave's — so nothing was blocked. The
 * beneficiary was then tokenized on `route.provider`, which is Flutterwave, and
 * the row stored `body.payout_provider`, which was Stripe. A destination
 * naming a rail its own token does not belong to, and payable on neither.
 * `startConnectOnboarding` had the right guard from the start
 * (`route.provider !== 'stripe' || route.kind !== 'connect'`); it was the
 * general path that leaked.
 *
 * Refused rather than corrected. Substituting the corridor's own rail would
 * hand a client that asked for Stripe a Flutterwave destination without
 * telling it, and its records would then disagree with ours about where its
 * seller is paid — the same reason `create` refuses a known `external_user_id`
 * instead of returning the seller it already has. The message carries the
 * corridor's own sentence and where to list its methods, so the caller is told
 * what to send rather than only what not to.
 *
 * Callers still check `route.blocked` first, and this does not replace that: a
 * blocked corridor has no rail to compare against and a better sentence of its
 * own.
 */
export function assertRailOnRoute(
  rail: string,
  country: Country,
  route: PayoutRoute,
): void {
  const list =
    `GET /v1/payment-options?payout_country=${country} lists the methods that can.`

  const adapter = railAdapterFor(rail)
  if (adapter === null) {
    throw new PayHoldError(
      'policy_violation',
      `${rail} is not a payout method PayHold knows. ${list}`,
    )
  }

  if (adapter !== route.provider) {
    // The same opening words `route_payout` uses when it meets one of these
    // rows, so a reader who has seen the sentence on an Earnings page
    // recognises it here — one fact, one sentence.
    throw new PayHoldError(
      'policy_violation',
      `${rail} cannot pay a destination in ${country}. ${route.reason} ` +
        `Use that corridor's own method instead — ${list}`,
    )
  }
}
