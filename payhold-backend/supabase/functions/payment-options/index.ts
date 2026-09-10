/**
 * What a buyer in a given market can actually do — the catalogue endpoint.
 *
 *   GET /payment-options
 *       every market PayHold knows about, and every currency it can collect
 *
 *   GET /payment-options?country=RW
 *       the methods, wallets, card schemes and currencies available there
 *
 *   GET /payment-options?country=IN&currency=RWF&amount=14000000
 *       the same, plus what that buyer would actually be charged: an Indian
 *       card cannot be charged RWF, so this answers "you will pay $100.00"
 *
 *   GET /payment-options?payout_country=RW&payout_currency=RWF
 *       whether a seller there can be paid at all, and on which rail
 *
 * This exists so a client's checkout never hardcodes a payment method. Which
 * wallets exist in Uganda, whether Nigerian cards take Verve, which markets can
 * be paid into — all of that changes when provider coverage changes, and a
 * client site that had it baked in would be wrong the day it did.
 *
 * Authenticated like the rest of v1. The data is not tenant-specific except for
 * the enabled-currency filter, but a key means it is rate-limited per client
 * and a browser cannot call it directly — the client's own server asks, and
 * renders the checkout from the answer.
 */

import { resolveCaller, serviceClient } from '../_shared/auth.ts'
import { canConvert, convert, presentmentCurrencyFor } from '../_shared/fx.ts'
import { handler, json } from '../_shared/http.ts'
import {
  collectionRails,
  countryInfo,
  currenciesFor,
  METHOD_BLURB,
  METHOD_LABEL,
  payoutRoute,
  SCHEME_LABEL,
  SUPPORTED_CURRENCIES,
  type CardScheme,
} from '../_shared/rails.ts'
import { payoutMethods } from '../_shared/payout-methods.ts'
import { COUNTRIES } from '../_shared/countries.ts'
import { loadProvider } from '../_shared/load-provider.ts'
import { momoNetworksFor } from '../_shared/momo.ts'
import { allMarketsVerified, marketVerified } from '../_shared/launch.ts'
import { closedMarkets, liveProviders } from '../_shared/matrix.ts'
import { loadSettings } from '../_shared/settings.ts'
import { type Country, type Currency, PayHoldError, type PaymentMethod } from '../_shared/types.ts'
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'

/** Regional-indicator flag emoji, derived from the ISO code. */
function flag(code: string): string {
  return String.fromCodePoint(
    ...[...code].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65),
  )
}

interface MethodOption {
  method: PaymentMethod
  label: string
  blurb: string
  provider: string
  currencies: Currency[]
  /** Wallets, e.g. ["MTN", "Airtel Money"]. Empty on card and bank rails. */
  networks: string[]
  schemes: { code: CardScheme; label: string }[]
  note: string | null
}

function methodsFor(
  country: string,
  currency: Currency,
  live: Set<string>,
): MethodOption[] {
  return collectionRails(country, currency)
    // §15 phase 3: a provider outage disables only its own routes. The rail
    // table says what each provider *can* do here; `provider_capabilities` says
    // whether that provider is answering the phone today, and the two are
    // separate questions on purpose.
    .filter((rail) => live.has(rail.provider))
    .map((rail) => ({
    method: rail.method,
    label: METHOD_LABEL[rail.method],
    blurb: METHOD_BLURB[rail.method],
    provider: rail.provider,
    currencies: rail.currencies,
    networks: rail.networks,
    schemes: (rail.schemes ?? []).map((code) => ({ code, label: SCHEME_LABEL[code] })),
    note: rail.note ?? null,
  }))
}

/**
 * The routing table's coverage, as a predicate, read once per request.
 *
 * The catalogue branch below answers for every country in one response, and it
 * used to derive `can_payout` from `payoutRoute()` alone — the registry — while
 * the single-country branch had already been made to defer to `route_evaluation`
 * — the table. So the country list said Poland could be paid and the country's
 * own answer said it could not, and a client that rendered its "where do you get
 * paid?" picker from the list offered a market it would then refuse. The same
 * divergence this file had just closed, one branch over.
 *
 * Two hundred `route_evaluation` calls per request is not the fix. The rows are
 * few — one platform row per rail plus a tenant's overrides — so they are read
 * once and judged here with the same conditions `route_evaluation` applies
 * before it reaches the amount: an adapter behind the rail, enabled, approved,
 * supports payouts, country and currency in the row. Amount limits are a
 * per-payout question, not a coverage one, and are left out on purpose, as
 * `routedOrBlocked` leaves them out. A tenant row replaces the platform row for
 * the same rail, exactly as `route_evaluation`'s `distinct on` does.
 */
async function loadPayoutCoverage(
  db: SupabaseClient,
  tenant: string,
): Promise<(country: string, currency: string) => boolean> {
  const { data, error } = await db
    .from('payout_routes')
    .select('tenant_id, payout_provider, provider, enabled, supports_payouts, risk_status, countries, currencies')
    .or(`tenant_id.is.null,tenant_id.eq.${tenant}`)
  if (error) throw new Error(`payout_routes read failed: ${error.message}`)

  type Row = {
    tenant_id: string | null
    payout_provider: string
    provider: string | null
    enabled: boolean
    supports_payouts: boolean
    risk_status: string
    countries: string[]
    currencies: string[]
  }
  const byRail = new Map<string, Row>()
  for (const r of (data ?? []) as Row[]) {
    const current = byRail.get(r.payout_provider)
    if (!current || (r.tenant_id !== null && current.tenant_id === null)) byRail.set(r.payout_provider, r)
  }
  const rows = [...byRail.values()].filter((r) =>
    r.provider !== null && r.enabled && r.risk_status === 'approved' && r.supports_payouts
  )
  return (country, currency) =>
    rows.some((r) => r.countries.includes(country) && r.currencies.includes(currency))
}

/**
 * The registry's answer, checked against the table that actually routes.
 *
 * `payoutRoute()` is `rails.ts` — the generated registry of where money *can*
 * go. `route_payout` reads `payout_routes` — where it may go today. On
 * 2026-09-09 the two disagreed by ~46 countries (Stripe 44 vs 11, Flutterwave
 * 25 vs 12), and this endpoint answered from the registry alone. So a client
 * rendering its payout-method picker from this response — which is the only
 * thing a client is allowed to render it from — told a host in Austria or
 * Sierra Leone "choose how you want to be paid", tokenized a real destination,
 * and every payout after that was `blocked: no route`. The Rwandan
 * stripe_connect primary refused earlier the same day, forty-six corridors
 * wide, from the other direction.
 *
 * `route_evaluation` is the engine's own judgement, tenant overrides included.
 * Amount limits are deliberately not part of the question: a corridor with a
 * route whose minimum this particular payout is under is still a corridor a
 * seller can be set up in, so `p_amount` is 0 and the two amount reasons count
 * as covered. Everything else — no row for the country or currency, a disabled
 * or suspended rail — is not, and the answer fails closed.
 *
 * `verified` is orthogonal and stays as it was: per market, from §16's
 * checklist. A corridor can be verified and still have no route row, and a
 * client that read `rails_verified` as "this will work" would be wrong twice.
 * `blocked` is the field that answers "will a payout find a route".
 */
async function routedOrBlocked(
  db: SupabaseClient,
  tenant: string,
  country: string,
  currency: string,
  verified: boolean,
): Promise<Record<string, unknown>> {
  const route = payoutRoute(country as Country, currency as Currency)
  if (route.blocked) return { ...route, verified, methods: [] }

  const { data, error } = await db.rpc('route_evaluation', {
    p_tenant: tenant,
    p_country: country,
    p_currency: currency,
    p_amount: 0,
    p_rail: null,
  })
  if (error) throw new Error(`route_evaluation failed: ${error.message}`)

  // Every destination this market can actually be paid into, not just the
  // preferred one. `kind` is a single value and a market is not: Kenya and
  // Tanzania take a wallet while their bank corridor sits behind a Flutterwave
  // request, Malawi is the same shape, Ethiopia takes either, and the United
  // States takes a Stripe Connect account or a PayPal one. A client reading
  // `kind: 'momo'` and offering wallet-and-bank — which is the obvious reading,
  // and what one was doing — shows a Kenyan host a Bank option that
  // `assertRailOnRoute` then refuses. `_shared/payout-methods.ts` is where the
  // derivation lives, so what this offers and what registration accepts can be
  // pinned against each other.
  const methods = payoutMethods(data, route.kind)

  if (methods.length > 0) return { ...route, verified, methods }

  // `reason` is shown to a seller verbatim by at least one client, so it says
  // only what a seller can act on — that payouts into this market are not open
  // yet. The mechanism (the registry claims a corridor the routing table does
  // not carry) is this comment's job and `reason_code`'s, not the sentence's.
  return {
    ...route,
    blocked: true,
    verified,
    methods: [],
    reason: `PayHold has no enabled payout route into ${countryInfo(country as Country).name} in ${currency} yet.`,
    reason_code: 'no_payout_route',
  }
}

Deno.serve(handler(async (req) => {
  if (req.method !== 'GET') {
    throw new PayHoldError('policy_violation', `${req.method} is not supported here`)
  }

  const db = serviceClient()
  const caller = await resolveCaller(db, req)
  const params = new URL(req.url).searchParams

  const country = params.get('country')
  const payoutCountry = params.get('payout_country')

  // Which currencies this tenant has turned on. Empty means no restriction
  // recorded, in which case every collectable currency is on offer.
  const settings = await loadSettings(db, caller.tenant_id)
  const enabled = settings.currencies.length > 0
    ? settings.currencies
    : SUPPORTED_CURRENCIES

  // §12's two switches, both data. `closed` is which markets we have turned
  // off; `live` is which adapters are built and answering. Neither is in
  // `countries.ts`, which records what is *possible* — see `matrix.ts`.
  const [closed, live] = await Promise.all([
    closedMarkets(db, caller.tenant_id),
    liveProviders(db),
  ])

  // --- Seller onboarding: can we pay someone here at all? ------------------
  if (payoutCountry) {
    const info = countryInfo(payoutCountry)
    const currency = params.get('payout_currency') ?? info.currency
    const closure = closed.get(payoutCountry)

    // §16 wants written provider confirmation for marketplace payouts, market
    // by market, and this is the flag that reports whether we have it. Asked
    // per country here because the four conversations have four outcomes —
    // telling a seller in Kigali that the corridor is confirmed because a
    // different one was is the wrong answer confidently given.
    const verified = await marketVerified(db, payoutCountry)

    // A closed market outranks the registry: the corridor may exist and still
    // be shut, and telling a seller "Flutterwave can pay you" when we have
    // switched their country off would be the wrong answer confidently given.
    const route = closure && !closure.payout
      ? {
        provider: null,
        kind: null,
        currency,
        blocked: true,
        verified: false,
        reason: closure.reason,
      }
      : await routedOrBlocked(db, caller.tenant_id, payoutCountry, currency, verified)

    // What a seller here actually has to *pick*, which is the half of this
    // answer a payout-setup form needs. A beneficiary is registered against a
    // named carrier or a bank code — there is no default that is safe to
    // assume — so a client that cannot list them can only guess, and a guess
    // registers a destination the rail will not transfer to.
    const networks = momoNetworksFor(payoutCountry).map((n) => n.label)

    // Banks are a provider round trip and most callers only want the route, so
    // they are opt-in. Their failure is not fatal: a rail we cannot reach right
    // now should not make the corridor look shut.
    let banks: { code: string; name: string }[] | null = null
    if (params.get('banks') && route.provider === 'flutterwave') {
      try {
        const { provider } = await loadProvider(db, caller.tenant_id, 'flutterwave')
        banks = provider.banks ? await provider.banks(payoutCountry) : null
      } catch (err) {
        console.error('bank list unavailable', {
          country: payoutCountry,
          message: err instanceof Error ? err.message : String(err),
        })
      }
    }

    return json(req, {
      country: { code: info.code, name: info.name, flag: flag(info.code) },
      payout: route,
      // The wallets a mobile money destination may name here, in the words a
      // seller would use for them. Empty means this market has none.
      networks,
      // Null means "not asked for", or "asked for and the rail was
      // unreachable" — distinct from `[]`, which would claim there are none.
      banks,
      // False until §16's written confirmation for this market is signed off —
      // a client should treat an unverified route as "probably" rather than
      // "yes".
      rails_verified: verified,
    })
  }

  // Everything below answers about collection rather than about one payout
  // corridor, so it reports the set: anything short of all four of §16's
  // markets being confirmed is not "verified rails" to a client reading one
  // flag. Asked after the payout branch has returned, so a seller-onboarding
  // call does not pay for a question it did not ask.
  const railsVerified = await allMarketsVerified(db)

  // --- The whole catalogue -------------------------------------------------
  if (!country) {
    const coveredByTable = await loadPayoutCoverage(db, caller.tenant_id)
    return json(req, {
      countries: COUNTRIES.map((info) => ({
        code: info.code,
        name: info.name,
        flag: flag(info.code),
        region: info.region,
        currency: info.currency,
        // Every market can pay unless sanctions say otherwise; far fewer can
        // be paid. A client picking a seller's country needs both facts.
        can_collect: !info.restricted && (closed.get(info.code)?.collect ?? true),
        // Registry, table and market switch all have to agree — the same
        // three the single-country branch consults, so the list a client
        // renders a country picker from cannot offer a market the country's
        // own answer then refuses.
        can_payout: !payoutRoute(info.code, info.currency).blocked &&
          coveredByTable(info.code, info.currency) &&
          (closed.get(info.code)?.payout ?? true),
        restricted: info.restricted,
        // Why we closed it, when we did. Absent for the great majority, which
        // is what makes `payment_markets` an overlay rather than a copy of the
        // registry — a market nobody has ruled on is open.
        closed_reason: closed.get(info.code)?.reason ?? null,
      })),
      currencies: enabled,
      rails_verified: railsVerified,
    })
  }

  // --- One market ----------------------------------------------------------
  const info = countryInfo(country)

  if (info.restricted) {
    return json(req, {
      country: { code: info.code, name: info.name, flag: flag(info.code) },
      restricted: true,
      methods: [],
      currencies: [],
      reason: `${info.name} is under sanctions or embargo. No acquirer will ` +
        'process a payment from there.',
      rails_verified: railsVerified,
    })
  }

  const closure = closed.get(country)

  if (closure && !closure.collect) {
    // Switched off in data, with no deploy behind it — §12, and §15 phase 3's
    // acceptance case. The shape matches the sanctions answer because to a
    // client they are the same fact: nobody here can pay today.
    return json(req, {
      country: { code: info.code, name: info.name, flag: flag(info.code) },
      restricted: false,
      closed: true,
      methods: [],
      currencies: [],
      reason: closure.reason,
      rails_verified: railsVerified,
    })
  }

  const payable = currenciesFor(country)

  // What the seller is owed, when the caller says. Without it we can only list
  // what the market can pay in, not which of those applies to this deal.
  const settlement = params.get('currency')
  const amountParam = params.get('amount')

  let presentment: Record<string, unknown> | null = null

  if (settlement) {
    const presentmentCurrency = presentmentCurrencyFor(payable, settlement)

    if (!presentmentCurrency) {
      throw new PayHoldError(
        'policy_violation',
        `PayHold cannot take a ${settlement} payment from ${info.name}`,
      )
    }

    const amount = amountParam === null ? null : Number(amountParam)
    if (amount !== null && (!Number.isInteger(amount) || amount <= 0)) {
      throw new PayHoldError(
        'policy_violation',
        'amount must be a positive integer in minor units',
      )
    }

    const converted = amount === null
      ? null
      : convert(amount, settlement, presentmentCurrency)

    presentment = {
      settlement_currency: settlement,
      presentment_currency: presentmentCurrency,
      converts: presentmentCurrency !== settlement,
      amount: converted?.amount ?? null,
      rate: converted?.rate ?? null,
      // The rate that will actually apply comes from the provider at charge
      // time and is locked onto the deal. Quoting this as final would promise
      // a number that moves.
      indicative: true,
    }
  }

  const currency = (presentment?.presentment_currency as Currency | undefined) ??
    (payable.includes(info.currency) ? info.currency : payable[0])

  return json(req, {
    country: {
      code: info.code,
      name: info.name,
      flag: flag(info.code),
      region: info.region,
      currency: info.currency,
    },
    restricted: false,
    /** The currency the methods below are quoted in. */
    charged_in: currency,
    methods: methodsFor(country, currency, live),
    // Everything this market could be charged in, intersected with what the
    // tenant has enabled — and, when the caller named the deal's settlement
    // currency, with what PayHold can actually convert it into. `POST /deals`
    // checks a chosen `presentment_currency` against exactly this set now, so
    // a picker rendered from this list can never offer a currency that
    // creation then refuses. Without `?currency=` there is nothing to convert
    // from, and the list stays the market's own.
    currencies: payable.filter((c) =>
      enabled.includes(c) &&
      (settlement === null || c === settlement || canConvert(settlement, c))
    ),
    presentment,
    rails_verified: railsVerified,
  })
}))
