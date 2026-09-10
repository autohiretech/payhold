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

import { countryInfo, type PayoutRoute, RAILS_VERIFIED } from '../_shared/rails.ts'
import { RAIL_KIND } from '../_shared/payout-methods.ts'
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
 *
 * ---
 *
 * **2026-09-10: it compared against the wrong thing, and PayPal is what showed
 * it.** The check was `railAdapterFor(rail) !== route.provider`, and
 * `route.provider` is the **one preferred** adapter `payoutRoute` ranks first
 * for a corridor — Flutterwave local, then Stripe, then Flutterwave foreign,
 * then PayPal. That was indistinguishable from "the only adapter this corridor
 * has" for as long as every market had exactly one live rail. The day PayPal's
 * 88 markets were switched on it stopped being true: a host in the United
 * States, where `payoutRoute` answers `stripe`/`connect`, was refused PayPal —
 * an enabled rail whose route row carries US and USD — for no reason except
 * that it is not the rail PayHold would have picked for them. `payout.methods`
 * on `/v1/payment-options` had already been widened to list every rail the
 * table carries; this was the check that then refused what that list offered.
 *
 * So the comparison is now against the rail's **own row** in
 * `route_evaluation` — the same rows `assertRailSwitchedOn` reads, the same
 * judgement `route_payout` will make when the money is due, tenant override
 * included. `payoutRoute` is untouched and PayPal stays last in it: it still
 * decides the *default*, so nobody already being paid on a local rail moves.
 * What changed is that the default stopped being the only permitted choice.
 *
 * **The Rwanda incident is refused by exactly the same sentence as before.**
 * `stripe_connect`'s row is evaluated for RW as `country_not_supported`, so
 * the rail is not on, so this still throws "stripe_connect cannot pay a
 * destination in RW" before anything is tokenized. Three things are refused
 * here and all three were refused before: a rail with no adapter, a rail the
 * table does not carry for this country and currency, and a rail whose row
 * names a different adapter from the one `RAIL_ADAPTER` says mints its tokens
 * — because that token would be minted on the wrong provider.
 */
export function assertRailOnRoute(
  rail: string,
  country: Country,
  route: PayoutRoute,
  rails: unknown,
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

  const row = railRow(rails, rail)

  // The table carries the rail but says a different adapter mints its tokens.
  // Neither side is trustworthy on its own here — `loadProvider` is asked for
  // `railAdapterFor(rail)` and `route_payout` will send on the row's
  // `provider` — so a disagreement is refused rather than resolved in favour
  // of either. `tests/seller-destination-rail.test.ts` pins the two against
  // each other so this cannot be the first place anybody notices.
  if (row !== null && row.provider !== null && row.provider !== adapter) {
    throw new PayHoldError(
      'policy_violation',
      `${rail} is carried by ${row.provider} in the routing table but PayHold ` +
        `mints its destinations on ${adapter}. This is a routing-table fault, ` +
        `not something the request can fix. ${list}`,
    )
  }

  if (row === null || !RAIL_ON.has(row.reason_code ?? '')) {
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
 * The sentence each rail's own route reads, keyed by rail rather than by
 * `kind`, because `kind` does not name an adapter: `bank` is Flutterwave's
 * today and would not have to be forever, and a sentence keyed on it would go
 * quietly wrong the day it is not. The wording is `payoutRoute`'s own, so a
 * client that has been reading `reason` on the corridor's route does not meet
 * a second dialect on the destination's.
 *
 * Same key set as `RAIL_KIND`, deliberately — the two describe the same four
 * live rails, and `tests/paypal-alongside-stripe.test.ts` pins that set against
 * what registration accepts, so neither can grow a rail the other has not.
 */
const RAIL_SENTENCE: Record<string, (currency: string, market: string) => string> = {
  flutterwave_momo: (c, m) => `Paid in ${c} via Flutterwave, to a mobile money wallet in ${m}.`,
  flutterwave_bank: (c, m) => `Paid in ${c} via Flutterwave, to a bank account in ${m}.`,
  stripe_connect: (c, m) => `Paid in ${c} via Stripe, to a bank account in ${m}.`,
  paypal: (c, m) => `Paid in ${c} to a PayPal account in ${m}.`,
}

/**
 * How the destination that was just registered will actually be paid — the
 * `payout_route` both `POST /v1/sellers` and `POST /v1/sellers/:id/destinations`
 * return.
 *
 * **Found 2026-09-10, alongside the refusal above and from the same root.**
 * Both handlers returned `payoutRoute(country, currency)` — the corridor's one
 * **preferred** rail — as the description of a destination the caller had just
 * named a rail for. While a market had exactly one live payout rail those were
 * the same fact wearing two names. The day PayPal's 88 markets were switched on
 * they stopped being: a US seller registering a PayPal destination was handed
 * `provider: 'stripe'`, `kind: 'connect'` and "Paid in USD via Stripe, to a bank
 * account in United States." — a correct sentence about a route their money will
 * not travel on. A client storing that field, or showing it to the host it just
 * onboarded, is being told the wrong rail about a row it can read the right one
 * off two fields away, which is the sort of disagreement that is only noticed
 * once a payout has gone somewhere unexpected.
 *
 * So the rail the caller passed is what gets described. `payoutRoute` is
 * untouched and still decides the *default* — this is only which of the
 * corridor's rails the response is about, and when the seller picked the
 * preferred one the corridor's own route is returned unchanged, so nothing
 * about the common case moves.
 *
 * The currency comes off the corridor's route rather than being passed again:
 * it is a property of the corridor, both `assertRailOnRoute` and
 * `route_evaluation` have already judged this rail against it, and a second
 * copy is a second thing that can disagree.
 *
 * `blocked` is false without asking. Every caller has already run
 * `route.blocked`, `assertRailRequirementsMet`, `assertRailOnRoute` and
 * `assertRailSwitchedOnRows` against this rail, and the last of those is
 * `route_evaluation`'s own verdict — the same judgement `route_payout` will
 * make when the money is due. A rail that reached here is one the table pays.
 *
 * `verified` is `RAILS_VERIFIED` less the one rail-specific downgrade
 * `payoutRoute` itself makes: Flutterwave holding a currency that is not the
 * market's own can settle it to your own account and still not pay a
 * third-party beneficiary in it, which is a route to confirm rather than a
 * promise. That caveat belongs to the rail and the currency, not to the
 * corridor, so it survives being asked about a rail the corridor does not
 * prefer — and the sentence that carries it is repeated verbatim for the same
 * reason the others are.
 */
export function railRoute(rail: string, country: Country, route: PayoutRoute): PayoutRoute {
  const adapter = railAdapterFor(rail)
  const kind = RAIL_KIND[rail] ?? null
  const sentence = RAIL_SENTENCE[rail]

  // Unreachable through a handler: a rail with no adapter is refused by
  // `assertRailOnRoute` and the four declared-and-disabled wallets (§29.3) can
  // never be `eligible`, so nothing without a `RAIL_KIND` entry gets this far.
  // It is a fallback rather than a throw because the caller has by then
  // tokenized a beneficiary and written a row — failing the response would
  // report a registration that happened as one that did not — and it can only
  // be reached at all by `RAIL_KIND` drifting from the set of rails the table
  // enables, which is what the pinning test above exists to stop.
  if (adapter === null || kind === null || sentence === undefined) return route

  // The seller picked the corridor's own preferred rail, which is still the
  // overwhelmingly common case: hand back exactly what `payoutRoute` said, so
  // this cannot restate that answer in slightly different words.
  if (adapter === route.provider && kind === route.kind) return route

  const info = countryInfo(country)
  const foreignFlutterwave = adapter === 'flutterwave' && route.currency !== info.currency

  return {
    provider: adapter,
    kind,
    currency: route.currency,
    blocked: false,
    verified: RAILS_VERIFIED && !foreignFlutterwave,
    reason: sentence(route.currency, info.name) +
      (foreignFlutterwave
        ? ` Confirm your account can send ${route.currency} to a third-party ` +
          `beneficiary there — otherwise convert to ${info.currency}.`
        : ''),
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

/** One rail's line in a `route_evaluation` result. */
export interface RailRow {
  provider: Provider | null
  reason_code: string | null
}

/**
 * One rail's own row out of a `route_evaluation` result, or null when the
 * table returned none for it. Null is not "unknown": `route_evaluation`
 * judges every declared rail, so a missing row means the rail is not one.
 */
export function railRow(rows: unknown, rail: string): RailRow | null {
  const row = (Array.isArray(rows) ? rows : [])
    .find((r) => (r as { payout_provider?: string })?.payout_provider === rail) as
      | { provider?: string | null; reason_code?: string | null }
      | undefined
  if (row === undefined) return null
  return {
    provider: (row.provider ?? null) as Provider | null,
    reason_code: row.reason_code ?? null,
  }
}

/**
 * Whether one rail's row in a `route_evaluation` result says the rail is on.
 * The pure half of `assertRailSwitchedOn`, kept separate so the judgement can
 * be pinned without a database.
 */
export function railVerdict(
  rows: unknown,
  rail: string,
): { on: boolean; reason_code: string | null } {
  const reason_code = railRow(rows, rail)?.reason_code ?? null
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
  const rails = await evaluateRails(db, tenant, country, currency)
  assertRailSwitchedOnRows(rails, rail, country)
}

/**
 * Every rail's verdict for one corridor, asked once.
 *
 * `p_rail` is null on purpose. It only marks a row `preferred` and sorts it
 * first — it changes no `reason_code` — so one call answers for every rail a
 * registration has to check, and `assertRailOnRoute` and
 * `assertRailSwitchedOnRows` judge the same rows rather than asking the same
 * question twice and being able to get two answers.
 */
export async function evaluateRails(
  db: RouteEvaluator,
  tenant: string,
  country: Country,
  currency: Currency,
): Promise<unknown> {
  const { data, error } = await db.rpc('route_evaluation', {
    p_tenant: tenant,
    p_country: country.toUpperCase(),
    p_currency: currency.toUpperCase(),
    p_amount: 0,
    p_rail: null,
  })
  if (error) throw new Error(`route_evaluation failed: ${error.message}`)
  return data
}

/** `assertRailSwitchedOn` against rows already read. Same sentence. */
export function assertRailSwitchedOnRows(
  rails: unknown,
  rail: string,
  country: Country,
): void {
  const cc = country.toUpperCase()
  if (!railVerdict(rails, rail).on) {
    throw new PayHoldError(
      'policy_violation',
      `${rail} is not switched on for ${cc} — ${listMethods(cc)}`,
    )
  }
}
