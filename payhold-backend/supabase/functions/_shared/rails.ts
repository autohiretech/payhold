/**
 * Payment rails — which provider can take money where, and send it where.
 *
 * The counterpart of `payhold-dashboard/src/lib/rails.ts`. The two build the
 * same table from the same generated registry (`countries.ts`, emitted into
 * both repos by one generator), and describe the same routing from opposite
 * ends: the dashboard so a checkout can offer the right methods, this side so
 * a charge is routed and a payout destination is refused before it is stored.
 *
 * **A change to either is a change to both, in the same commit** — the rule
 * `types.ts` already sets for the wire contract. The registry cannot drift,
 * because it is generated; this logic can, so it must not be edited alone.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Two rules are structural rather than configurable:
 *
 *   Collection and payout are separate capabilities. A rail that can take
 *   money cannot always send it. Cards collect only — a refund goes back to
 *   the card, a payout never does.
 *
 *   African payouts always ride Flutterwave. Stripe collects internationally
 *   and cannot send funds to Rwanda or Kenya, so a deal can be collected on
 *   Stripe and paid out on Flutterwave. This is why balances are reconciled
 *   per rail: "held" is never one pot.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Nothing here is verified against a signed provider agreement — see
 * `RAILS_VERIFIED`. A wrong row means a charge that cannot be collected, or
 * money collected that cannot be paid out.
 */

import { COUNTRIES, type CountryInfo } from './countries.ts'
import {
  PayHoldError,
  type Country,
  type Currency,
  type PaymentMethod,
  type Provider,
} from './types.ts'

/**
 * Flips to true only when every row has been checked against provider
 * documentation and the account agreement. `rails.test.ts` in the dashboard
 * asserts it stays false until someone deliberately changes it.
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

export const METHOD_LABEL: Record<PaymentMethod, string> = {
  wallet: 'Wallet',
  card: 'Card',
  mobile_money: 'Mobile money',
  bank_transfer: 'Bank transfer',
}

/** What a buyer is told about a method, in their words rather than ours. */
export const METHOD_BLURB: Record<PaymentMethod, string> = {
  card: 'Visa or Mastercard. Verified with 3D Secure.',
  wallet: 'Pay from your PayPal, Cash App or Alipay balance.',
  mobile_money: 'Pay from your wallet. You will get a prompt on your phone.',
  bank_transfer: 'Transfer directly from your bank account.',
}

export interface Rail {
  method: PaymentMethod
  country: Country
  currencies: Currency[]
  provider: Provider
  /** Wallets behind this rail, e.g. ["MTN", "Airtel Money"]. */
  networks: string[]
  collect: boolean
  payout: boolean
  /** Card schemes this rail accepts. Absent on non-card rails. */
  schemes?: CardScheme[]
  /** A limitation worth surfacing to whoever is integrating. */
  note?: string
}

/** Currencies an international card rail can be charged in. */
const INTERNATIONAL_CURRENCIES: Currency[] = ['USD', 'EUR']

const BY_CODE = new Map(COUNTRIES.map((info) => [info.code, info]))

/** A country we do not know is a client error, not a 500. */
export function countryInfo(code: Country): CountryInfo {
  const info = BY_CODE.get(code)
  if (!info) {
    throw new PayHoldError('policy_violation', `Unknown country code "${code}"`)
  }
  return info
}

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
          : 'Flutterwave lists mobile money here but does not name the ' +
            'networks — confirm which wallets work before launch.',
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
        schemes: code === 'NG'
          ? ['visa', 'mastercard', 'verve']
          : ['visa', 'mastercard'],
        note: code === 'NG'
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
    // sanctioned ones, including markets with a full local stack — a visitor's
    // foreign card still has to work.
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
        note: 'International card acquiring. Works from almost anywhere, but ' +
          'cannot pay anyone.',
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
 * Every currency any rail can actually take. A tenant enabling a currency
 * outside this would only create deals nobody can pay.
 */
export const SUPPORTED_CURRENCIES: Currency[] = [
  ...new Set(RAILS.filter((r) => r.collect).flatMap((r) => r.currencies)),
].sort()

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

const METHOD_ORDER: PaymentMethod[] = ['mobile_money', 'card', 'bank_transfer']

/**
 * What a buyer in this market can pay with, in the order to offer them.
 *
 * Mobile money leads where it exists: it is what most buyers in these markets
 * actually use, and it costs the tenant less than a card.
 */
export function collectionRails(country: Country, currency: Currency): Rail[] {
  return RAILS
    .filter((r) => r.collect && r.country === country && r.currencies.includes(currency))
    .sort((a, b) => {
      const localness = Number(b.provider === 'flutterwave') -
        Number(a.provider === 'flutterwave')
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
  return collectionRails(country, currency).find((r) => r.method === method)
    ?.provider ?? null
}

/** The rail a deal provisionally uses before the buyer chooses a method. */
export function defaultProviderFor(country: Country, currency: Currency): Provider {
  return collectionRails(country, currency)[0]?.provider ?? 'stripe'
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

// ---------------------------------------------------------------------------
// Payout
// ---------------------------------------------------------------------------

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
 * How a seller in this market would actually be paid.
 *
 * Called before a payout destination is stored, so a corridor we cannot reach
 * is refused at registration rather than discovered when the first payout is
 * due and the money is already collected.
 */
export function payoutRoute(country: Country, currency: Currency): PayoutRoute {
  const info = countryInfo(country)
  const local = info.currency
  const wantsLocal = currency === local
  const hasWallet = RAILS.some(
    (r) => r.payout && r.country === country && r.method === 'mobile_money',
  )

  if (info.restricted) {
    return {
      provider: null,
      kind: null,
      currency,
      blocked: true,
      verified: false,
      reason: `${info.name} is under sanctions or embargo. PayHold can neither ` +
        'collect from nor pay anyone there.',
    }
  }

  if (wantsLocal && info.flutterwavePayout) {
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
  // account — a route to confirm, not a promise.
  if (!wantsLocal && info.flutterwavePayout) {
    return {
      provider: 'flutterwave',
      kind: 'bank',
      currency,
      blocked: false,
      verified: false,
      reason: `Stripe cannot pay anyone in ${info.name}, so ${currency} would ` +
        `have to go out on Flutterwave. Confirm your account can send it to a ` +
        `third-party beneficiary there — otherwise convert to ${local}.`,
    }
  }

  return {
    provider: null,
    kind: null,
    currency,
    blocked: true,
    verified: false,
    reason: `PayHold cannot send money to ${info.name} yet. Neither provider is ` +
      'licensed for that corridor. Buyers there can still pay — collection ' +
      'works everywhere — but a seller needs an account somewhere we can reach.',
  }
}

/** The rail that will carry a seller's payout, refusing the corridor outright. */
export function payoutProviderFor(country: Country, currency: Currency): Provider {
  const route = payoutRoute(country, currency)
  if (route.blocked || !route.provider) {
    throw new PayHoldError('policy_violation', route.reason)
  }
  return route.provider
}
