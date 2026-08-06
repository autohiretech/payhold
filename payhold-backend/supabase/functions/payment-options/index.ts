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
  RAILS_VERIFIED,
  SCHEME_LABEL,
  SUPPORTED_CURRENCIES,
  type CardScheme,
} from '../_shared/rails.ts'
import { COUNTRIES } from '../_shared/countries.ts'
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

function methodsFor(country: string, currency: Currency): MethodOption[] {
  return collectionRails(country, currency).map((rail) => ({
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

  // --- Seller onboarding: can we pay someone here at all? ------------------
  if (payoutCountry) {
    const info = countryInfo(payoutCountry)
    const currency = params.get('payout_currency') ?? info.currency
    const route = payoutRoute(payoutCountry, currency)

    return json(req, {
      country: { code: info.code, name: info.name, flag: flag(info.code) },
      payout: route,
      // Not verified against a signed provider agreement — a client should
      // treat an unverified route as "probably" rather than "yes".
      rails_verified: RAILS_VERIFIED,
    })
  }

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
        can_collect: !info.restricted,
        can_payout: !payoutRoute(info.code, info.currency).blocked,
        restricted: info.restricted,
      })),
      currencies: enabled,
      rails_verified: RAILS_VERIFIED,
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
      rails_verified: RAILS_VERIFIED,
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
    methods: methodsFor(country, currency),
    // Everything this market could be charged in, intersected with what the
    // tenant has enabled.
    currencies: payable.filter((c) => enabled.includes(c)),
    presentment,
    rails_verified: RAILS_VERIFIED,
  })
}))
