/**
 * Payment rails, derived from the country registry.
 *
 * Rails are generated from `COUNTRIES` rather than hand-listed, so adding a
 * market is one row in one table and no rail can be silently forgotten.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * The guarantee: **every country can pay.** Card acquiring is global, so each
 * of the 55 markets gets at least an international card rail, in USD or EUR,
 * even where neither provider has any local presence.
 *
 * The limit: **not every country can be paid.** Sending money is licensed
 * per-corridor. Most African markets can be collected from and cannot be paid
 * into, and `payoutRoute()` says so plainly rather than queuing a transfer
 * that will never land.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Nothing here is verified against a signed provider agreement. See
 * `RAILS_VERIFIED`.
 */

// Imported from the types module directly, not the `@/api` barrel: the mock
// engine imports this file, and the barrel imports the mock.
import type { Country, Currency, PaymentMethod, Provider } from '@/api/types'
import { COUNTRIES, countryInfo } from './countries'

export { COUNTRIES, countryInfo, countryName, countriesByRegion } from './countries'
export type { CountryInfo } from './countries'

/**
 * Flips to true only when every row has been checked against provider
 * documentation and the account agreement. The dashboard shows a warning
 * while it is false, and a test asserts it stays false until deliberately
 * changed.
 */
export const RAILS_VERIFIED = false

/** Card networks. Which are accepted is market-dependent, not universal. */
export type CardScheme = 'visa' | 'mastercard' | 'amex' | 'verve'

export const SCHEME_LABEL: Record<CardScheme, string> = {
  visa: 'Visa',
  mastercard: 'Mastercard',
  amex: 'American Express',
  verve: 'Verve',
}

export interface Rail {
  method: PaymentMethod
  country: Country
  currencies: Currency[]
  provider: Provider
  /** Wallets or schemes behind this rail, e.g. ["MTN", "Airtel Money"]. */
  networks: string[]
  collect: boolean
  payout: boolean
  schemes?: CardScheme[]
  note?: string
}

/** Currencies an international card rail can be charged in. */
const INTERNATIONAL_CURRENCIES: Currency[] = ['USD', 'EUR']

/**
 * Build the rail list from the registry.
 *
 * Per country, in the order a buyer should see them:
 *   1. Mobile money, where a real wallet exists — cheapest and most used.
 *   2. Local-currency card, where Flutterwave supports the currency.
 *   3. Bank transfer, where Flutterwave supports the currency.
 *   4. International card via Stripe — the universal floor, always present.
 */
function buildRails(): Rail[] {
  const rails: Rail[] = []

  for (const info of COUNTRIES) {
    const { code, currency } = info

    if (info.momo) {
      rails.push({
        method: 'mobile_money',
        country: code,
        currencies: [currency],
        provider: 'flutterwave',
        networks: info.momoNetworks,
        collect: true,
        payout: info.flutterwavePayout,
        note: info.momoNetworks.length
          ? undefined
          : 'Flutterwave lists mobile money here but does not name the networks — confirm which wallets work before launch.',
      })
    }

    if (info.flutterwaveLocal) {
      rails.push({
        method: 'card',
        country: code,
        // Nigeria is quoted in Naira only: a Naira card settles in Naira
        // whatever currency it is charged, so a foreign price only misleads.
        currencies: code === 'NG' ? [currency] : [currency, 'USD'],
        provider: 'flutterwave',
        networks: [],
        collect: true,
        payout: false,
        schemes:
          code === 'NG'
            ? ['visa', 'mastercard', 'verve']
            : ['visa', 'mastercard'],
        note:
          code === 'NG'
            ? 'A Naira card always settles in Naira regardless of the currency charged.'
            : 'Cards collect only — a refund returns to the card, but a payout never does.',
      })

      rails.push({
        method: 'bank_transfer',
        country: code,
        currencies: [currency],
        provider: 'flutterwave',
        networks: [],
        collect: true,
        payout: info.flutterwavePayout,
      })
    }

    // The near-universal floor. Present for every country except the
    // sanctioned ones, including markets with a full local stack — a
    // visitor's foreign card still has to work.
    if (!info.restricted) {
      rails.push({
        method: 'card',
        country: code,
        currencies: INTERNATIONAL_CURRENCIES,
        provider: 'stripe',
        networks: [],
        collect: true,
        payout: false,
        schemes: ['visa', 'mastercard', 'amex'],
        note: 'International card acquiring. Works from almost anywhere, but cannot pay anyone.',
      })
    }

    if (info.stripePayout) {
      rails.push({
        method: 'bank_transfer',
        country: code,
        currencies: [currency],
        provider: 'stripe',
        networks: [],
        collect: false,
        payout: true,
      })
    }
  }

  return rails
}

export const RAILS: Rail[] = buildRails()

/**
 * Every currency any rail can actually take. This is what a tenant may enable
 * — offering a currency no rail supports would create uncollectable deals.
 */
export const SUPPORTED_CURRENCIES: Currency[] = [
  ...new Set(RAILS.filter((r) => r.collect).flatMap((r) => r.currencies)),
].sort()

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export const METHOD_LABEL: Record<PaymentMethod, string> = {
  card: 'Card',
  mobile_money: 'Mobile money',
  bank_transfer: 'Bank transfer',
}

export const METHOD_BLURB: Record<PaymentMethod, string> = {
  card: 'Visa or Mastercard. Verified with 3D Secure.',
  mobile_money: 'Pay from your wallet. You will get a prompt on your phone.',
  bank_transfer: 'Transfer directly from your bank account.',
}

export const COUNTRY_LABEL: Record<string, string> = Object.fromEntries(
  COUNTRIES.map((info) => [info.code, info.name]),
)

/** Regional-indicator flag emoji, derived from the ISO code. */
export function countryFlag(code: Country): string {
  return String.fromCodePoint(
    ...[...code].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65),
  )
}

export const PROVIDER_LABEL: Record<Provider, string> = {
  flutterwave: 'Flutterwave',
  stripe: 'Stripe',
  fake: 'Demo mode',
}

export const PROVIDER_BLURB: Record<Provider, string> = {
  flutterwave:
    'Local rails across Africa — mobile money, local-currency cards and bank transfers, and the only way to pay an African seller.',
  stripe:
    'International card acquiring. Charges a card issued anywhere in the world, but can only pay out in the countries Stripe operates in.',
  fake: 'No provider keys configured. Payments are simulated end to end so the product works without a live account.',
}

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

const METHOD_ORDER: PaymentMethod[] = ['mobile_money', 'card', 'bank_transfer']

/**
 * What a buyer in this market can pay with, in the order to show them.
 *
 * Mobile money leads where it exists: it is what most buyers in these markets
 * actually use, and it costs the tenant less than a card. Local rails come
 * before the international card rail.
 */
export function collectionRails(country: Country, currency: Currency): Rail[] {
  const matching = RAILS.filter(
    (r) => r.collect && r.country === country && r.currencies.includes(currency),
  )

  return matching.sort((a, b) => {
    // Local provider first, then by method preference.
    const localness = Number(b.provider === 'flutterwave') - Number(a.provider === 'flutterwave')
    if (localness !== 0) return localness
    return METHOD_ORDER.indexOf(a.method) - METHOD_ORDER.indexOf(b.method)
  })
}

/** Which provider a given charge routes to, or null if we cannot take it. */
export function providerFor(
  country: Country,
  currency: Currency,
  method: PaymentMethod,
): Provider | null {
  return collectionRails(country, currency).find((r) => r.method === method)?.provider ?? null
}

/** The rail a deal provisionally uses before the buyer chooses a method. */
export function defaultProviderFor(country: Country, currency: Currency): Provider {
  return collectionRails(country, currency)[0]?.provider ?? 'stripe'
}

/** What a buyer in this market pays in by default. */
export function defaultCurrencyFor(country: Country): Currency {
  return countryInfo(country).currency
}

/** Every currency a buyer in this market can be charged. */
export function currenciesFor(country: Country): Currency[] {
  return [
    ...new Set(
      RAILS.filter((r) => r.collect && r.country === country).flatMap(
        (r) => r.currencies,
      ),
    ),
  ]
}

/**
 * True when a buyer in this market can pay in this currency.
 *
 * True for USD and EUR everywhere except the sanctioned markets — which is the
 * point. Almost no buyer is ever turned away.
 */
export function isMarketSupported(country: Country, currency: Currency): boolean {
  return collectionRails(country, currency).length > 0
}

// ---------------------------------------------------------------------------
// Payout
// ---------------------------------------------------------------------------

/** Rails that can actually send money to someone in this market. */
export function payoutRails(country: Country): Rail[] {
  return RAILS.filter((r) => r.payout && r.country === country)
}

export type PayoutKind = 'momo' | 'bank' | 'connect'

export interface PayoutRoute {
  provider: Provider | null
  kind: PayoutKind | null
  currency: Currency
  /** True when there is no way to send this money at all. */
  blocked: boolean
  reason: string
  verified: boolean
}

/**
 * Where a seller's money goes, given where they are and what they want paid in.
 *
 *   1. Local currency, in a market Flutterwave can reach → mobile money or bank.
 *   2. A market Stripe can reach → Stripe, in any currency.
 *   3. Foreign currency in a Flutterwave market → foreign-currency bank
 *      account, flagged for confirmation.
 *   4. Otherwise blocked, and the dashboard says so.
 */
export function payoutRoute(country: Country, currency: Currency): PayoutRoute {
  const info = countryInfo(country)
  const local = info.currency
  const rails = payoutRails(country)
  const wantsLocal = currency === local

  if (info.restricted) {
    return {
      provider: null,
      kind: null,
      currency,
      blocked: true,
      verified: false,
      reason:
        `${info.name} is under sanctions or embargo. PayHold can neither ` +
        'collect from nor pay anyone there. This needs legal review before ' +
        'it is changed.',
    }
  }

  if (wantsLocal && info.flutterwavePayout) {
    const hasWallet = rails.some((r) => r.method === 'mobile_money')
    return {
      provider: 'flutterwave',
      kind: hasWallet ? 'momo' : 'bank',
      currency,
      blocked: false,
      verified: RAILS_VERIFIED,
      reason: `Paid in ${currency} via Flutterwave, to a ${
        hasWallet ? 'mobile money wallet or bank account' : 'bank account'
      } in ${info.name}.`,
    }
  }

  if (info.stripePayout) {
    return {
      provider: 'stripe',
      kind: 'connect',
      currency,
      blocked: false,
      verified: RAILS_VERIFIED,
      reason: `Paid in ${currency} via Stripe, to a bank account in ${info.name}.`,
    }
  }

  // Flutterwave can hold a foreign currency, but paying a third-party
  // beneficiary in it is a different capability from settling it to your own
  // account — offered as a route to confirm, not a promise.
  if (!wantsLocal && info.flutterwavePayout) {
    return {
      provider: 'flutterwave',
      kind: 'bank',
      currency,
      blocked: false,
      verified: false,
      reason:
        `Stripe cannot pay anyone in ${info.name}, so ${currency} would have ` +
        `to go out on Flutterwave to a ${currency} bank account. Confirm with ` +
        'Flutterwave that your account can send it to a third-party ' +
        `beneficiary there — otherwise convert to ${local} and pay locally.`,
    }
  }

  return {
    provider: null,
    kind: null,
    currency,
    blocked: true,
    verified: false,
    reason:
      `PayHold cannot send money to ${info.name} yet. Neither provider is ` +
      'licensed for that corridor. Buyers there can still pay — collection ' +
      'works everywhere — but a seller needs an account somewhere we can reach.' +
      (info.stripePreview
        ? ' Stripe lists this market as preview only; contact their sales team to enable it.'
        : ''),
  }
}

/** Summary of payout capability in a market, for the seller's local currency. */
export function payoutCapability(country: Country): {
  provider: Provider | null
  reason: string
} {
  const route = payoutRoute(country, defaultCurrencyFor(country))
  return { provider: route.provider, reason: route.reason }
}

// ---------------------------------------------------------------------------
// Market summary — everything that follows from picking a country
// ---------------------------------------------------------------------------

export interface MarketSummary {
  country: Country
  name: string
  /** The rail serving local collection, or null where only cards work. */
  provider: Provider | null
  currency: Currency
  currencies: Currency[]
  /** Local wallets and bank transfer — everything that is not a card. */
  localMethods: Rail[]
  cardRail: Rail | null
  schemes: CardScheme[]
  /** Wallets available here, e.g. ["MTN", "Airtel Money"]. */
  networks: string[]
  payout: ReturnType<typeof payoutCapability>
  /** True when a buyer here has a local option, not just a foreign card. */
  hasLocalRails: boolean
  /** True when sanctions mean no payment is possible at all. */
  restricted: boolean
  notes: string[]
}

export function marketSummary(country: Country): MarketSummary {
  const info = countryInfo(country)
  const localRails = RAILS.filter(
    (r) => r.collect && r.country === country && r.provider === 'flutterwave',
  )
  const all = RAILS.filter((r) => r.collect && r.country === country)
  const cardRail = localRails.find((r) => r.method === 'card') ?? null

  return {
    country,
    name: info.name,
    provider: localRails[0]?.provider ?? null,
    currency: info.currency,
    currencies: currenciesFor(country),
    localMethods: localRails.filter((r) => r.method !== 'card'),
    cardRail,
    schemes: cardRail?.schemes ?? ['visa', 'mastercard', 'amex'],
    networks: info.momoNetworks,
    payout: payoutCapability(country),
    hasLocalRails: localRails.length > 0,
    restricted: info.restricted,
    notes: [...new Set(all.map((r) => r.note).filter((n): n is string => !!n))],
  }
}

// ---------------------------------------------------------------------------
// Settlement
// ---------------------------------------------------------------------------

export interface SettlementNote {
  currency: Currency
  /** Minimum balance, in minor units, before a settlement will run. */
  minimum: number | null
  detail: string
}

/**
 * Collecting a currency is not the same as being able to withdraw it.
 * Verified against Flutterwave's settlement documentation, August 2026.
 */
export function settlementNote(
  currency: Currency,
  homeCurrency: Currency,
): SettlementNote | null {
  if (currency === homeCurrency) return null

  if (currency === 'USD') {
    return {
      currency,
      minimum: 1000_00,
      detail:
        'USD settles to a USD bank account only once the balance reaches ' +
        '$1,000, and that account must be added to your Flutterwave profile ' +
        'first. Settling the same balance into your local currency instead ' +
        'has no such threshold.',
    }
  }

  return {
    currency,
    minimum: null,
    detail: `${currency} is held as its own balance and settles separately from your local currency.`,
  }
}
