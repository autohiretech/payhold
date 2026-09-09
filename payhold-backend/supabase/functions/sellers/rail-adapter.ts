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
  type Currency,
  PayHoldError,
  type PayoutProvider,
  type Provider,
} from '../_shared/types.ts'

/** The one sentence every refusal in this file ends on. */
function listMethods(country: Country): string {
  return `GET /v1/payment-options?payout_country=${country} lists the methods that can be paid.`
}

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

/**
 * Corridors the routing table carries that the adapter cannot actually
 * satisfy, refused at registration with the provider's own requirement quoted.
 *
 * Read from Flutterwave's per-country transfer guides on 2026-09-09
 * (developer.flutterwave.com/v3.0.0/docs/south-africa-1 and
 * …/tanzanian-bank-account-transfers). Both are bank corridors the table still
 * lists — `flutterwave_bank` for ZA stays on because the corridor is real —
 * but a transfer sent the way `release` sends one fails at the rail with the
 * buyer's money already collected, which is the failure every check in this
 * file exists to move to registration time.
 *
 *   ZA  every ZAR bank transfer must carry the recipient's first name, last
 *       name, email, mobile number and address in `meta`. PayHold collects a
 *       name and nothing else about a seller, deliberately (§12 stores no
 *       seller PII beyond what a payout needs), so the fields do not exist to
 *       send.
 *   TZ  "Payouts to Tanzania are only available to businesses registered in
 *       Tanzania", plus sender meta. Not a field we could add; a fact about
 *       the tenant's Flutterwave account that PayHold cannot know.
 *
 * Bank only. Neither refusal touches a mobile money destination in these
 * countries (Tanzania's wallets are a separate, documented corridor; South
 * Africa has none in the table) and neither has anything to do with
 * collecting a payment there.
 *
 * Kept in code rather than as a table edit because the table says where a
 * corridor *exists*; this says what the adapter can *send*. When the fields
 * are collected, the entry is deleted and nothing else changes.
 */
const UNSATISFIABLE: Partial<Record<PayoutProvider, Record<string, string>>> = {
  flutterwave_bank: {
    ZA: "Flutterwave requires the recipient's first name, last name, email, mobile " +
      'number and address on every South African bank transfer, and PayHold does ' +
      'not collect an email or address yet.',
    TZ: 'Flutterwave pays Tanzanian bank accounts only for businesses registered in ' +
      'Tanzania.',
  },
}

/**
 * Refuse a destination whose corridor exists but whose transfer the adapter
 * cannot build — see `UNSATISFIABLE`. Pure, so it can run before anything is
 * asked of a database or a rail.
 */
export function assertRailRequirementsMet(rail: string, country: Country): void {
  const cc = country.toUpperCase()
  const why = UNSATISFIABLE[rail as PayoutProvider]?.[cc]
  if (!why) return
  throw new PayHoldError(
    'policy_violation',
    `${rail} cannot pay a bank account in ${cc} yet. ${why} ${listMethods(cc)}`,
  )
}

/**
 * The slice of a Supabase client this file needs, so the check can be
 * exercised from the vitest suite over PGlite — where the handler itself, and
 * `npm:@supabase/supabase-js`, cannot be imported — with the same SQL the
 * function calls in production.
 */
export interface RouteEvaluator {
  rpc(
    fn: 'route_evaluation',
    args: {
      p_tenant: string
      p_country: string
      p_currency: string
      p_amount: number
      p_rail: string | null
    },
  ): PromiseLike<{ data: unknown; error: { message: string } | null }>
}

/**
 * `route_evaluation` verdicts that mean "this rail pays this corridor". The
 * two amount reasons count: a seller is registered against a corridor, not an
 * amount, and `payment-options`'s `routedOrBlocked` draws the line in the
 * same place. Everything else — no adapter, disabled, suspended, under review,
 * country or currency not in the row, no row at all — fails closed.
 */
const RAIL_ON = new Set(['eligible', 'below_route_minimum', 'above_route_maximum'])

/**
 * Whether one rail's row in a `route_evaluation` result says the rail is on.
 * The pure half of `assertRailSwitchedOn`, kept separate so the judgement can
 * be pinned without a database.
 */
export function railVerdict(
  rows: unknown,
  rail: string,
): { on: boolean; reason_code: string | null } {
  const row = (Array.isArray(rows) ? rows : [])
    .find((r) => (r as { payout_provider?: string })?.payout_provider === rail) as
      | { reason_code?: string }
      | undefined
  const reason_code = row?.reason_code ?? null
  return { on: reason_code !== null && RAIL_ON.has(reason_code), reason_code }
}

/**
 * Refuse a destination on a rail the routing table does not carry for its
 * country.
 *
 * The third check on a new destination, and the one the other two cannot
 * make. `payoutRoute(...).blocked` asks the **registry** whether the corridor
 * exists at all; `assertRailOnRoute` asks whether the rail the caller named is
 * carried by the corridor's **adapter**. Neither asks the **table** — the
 * thing `route_payout` will actually consult when the money is due — whether
 * *this rail* is on for *this country*. So a Kenyan seller could register a
 * `flutterwave_bank` destination the day the KE bank row was pruned (Flutterwave
 * gates Kenyan bank transfers behind a request), because the registry still
 * says Kenya is payable and Flutterwave is still the adapter. It would be
 * accepted here and `blocked` at the first payout, with the buyer's money
 * held. The same class of hole `8c3386e` closed for Stripe Connect in Rwanda,
 * one layer down.
 *
 * Asked of `route_evaluation` — the engine's own judgement, tenant override
 * included — and never of a copy of the table's rules kept on this side. The
 * sentence names the fix the way `assertRailOnRoute`'s does.
 */
export async function assertRailSwitchedOn(
  db: RouteEvaluator,
  tenant: string,
  rail: string,
  country: Country,
  currency: Currency,
): Promise<void> {
  const cc = country.toUpperCase()
  const { data, error } = await db.rpc('route_evaluation', {
    p_tenant: tenant,
    p_country: cc,
    p_currency: currency.toUpperCase(),
    p_amount: 0,
    p_rail: rail,
  })
  if (error) throw new Error(`route_evaluation failed: ${error.message}`)

  if (!railVerdict(data, rail).on) {
    throw new PayHoldError(
      'policy_violation',
      `${rail} is not switched on for ${cc} — ${listMethods(cc)}`,
    )
  }
}
