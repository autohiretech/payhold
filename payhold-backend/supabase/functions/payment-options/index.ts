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
import { convert, presentmentCurrencyFor } from '../_shared/fx.ts'
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
import { COUNTRIES } from '../_shared/countries.ts'
import { allMarketsVerified, marketVerified } from '../_shared/launch.ts'
import { closedMarkets, liveProviders } from '../_shared/matrix.ts'
import { loadSettings } from '../_shared/settings.ts'
import { PayHoldError, type Currency, type PaymentMethod } from '../_shared/types.ts'

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
      : { ...payoutRoute(payoutCountry, currency), verified }

    return json(req, {
      country: { code: info.code, name: info.name, flag: flag(info.code) },
      payout: route,
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
        can_payout: !payoutRoute(info.code, info.currency).blocked &&
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
    // tenant has enabled.
    currencies: payable.filter((c) => enabled.includes(c)),
    presentment,
    rails_verified: railsVerified,
  })
}))
