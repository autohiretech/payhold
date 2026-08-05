/**
 * Payment rails: which provider handles which payment method, in which market,
 * for collection and for payout.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IMPORTANT — this table is a routing *policy*, not a verified capability list.
 * The entries below encode the plan from the build spec. Before any rail goes
 * live, confirm each row against the provider's own country/method
 * documentation and your signed account agreement, and mark it `verified`.
 * A wrong row here means a charge that cannot be collected, or worse, money
 * collected that cannot be paid out.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The one rule that is structural rather than configurable: Stripe cannot pay
 * out to Rwandan recipients, so African payouts always ride Flutterwave. That
 * is why collection and payout are separate flags — a rail can be able to take
 * money and unable to send it.
 */

// Imported from the types module directly, not the `@/api` barrel: the mock
// engine imports this file, and the barrel imports the mock.
import type { Country, Currency, PaymentMethod, Provider } from '@/api/types'

export interface Rail {
  method: PaymentMethod
  country: Country
  currencies: Currency[]
  provider: Provider
  /** Can take money in on this rail. */
  collect: boolean
  /** Can send money out on this rail. */
  payout: boolean
  /** Set true only once checked against provider docs for that market. */
  verified: boolean
  /** Shown in the dashboard where the distinction matters. */
  note?: string
}

export const RAILS: Rail[] = [
  // --- Rwanda — the launch market -------------------------------------------
  {
    method: 'mtn_momo',
    country: 'RW',
    currencies: ['RWF'],
    provider: 'flutterwave',
    collect: true,
    payout: true,
    verified: false,
  },
  {
    method: 'airtel_money',
    country: 'RW',
    currencies: ['RWF'],
    provider: 'flutterwave',
    collect: true,
    payout: true,
    verified: false,
  },
  {
    method: 'card',
    country: 'RW',
    currencies: ['RWF', 'USD'],
    provider: 'flutterwave',
    collect: true,
    payout: false,
    verified: false,
    note:
      'Cards collect only — refunds go back to the card, payouts do not. ' +
      'USD collection is supported and lands in a separate USD balance, but ' +
      'whether a Rwandan-issued card can be charged in USD is the issuing ' +
      "bank's decision, not Flutterwave's. Offer USD to international " +
      'cardholders; expect local cards to decline it.',
  },
  {
    method: 'bank_transfer',
    country: 'RW',
    currencies: ['RWF'],
    provider: 'flutterwave',
    collect: true,
    payout: true,
    verified: false,
  },

  // --- Kenya ----------------------------------------------------------------
  {
    method: 'mpesa',
    country: 'KE',
    currencies: ['KES'],
    provider: 'flutterwave',
    collect: true,
    payout: true,
    verified: false,
    note: 'The dominant method in Kenya — offer it first, not the card.',
  },
  {
    method: 'card',
    country: 'KE',
    currencies: ['KES', 'USD'],
    provider: 'flutterwave',
    collect: true,
    payout: false,
    verified: false,
  },
  {
    method: 'bank_transfer',
    country: 'KE',
    currencies: ['KES'],
    provider: 'flutterwave',
    collect: true,
    payout: true,
    verified: false,
  },

  // --- Uganda ---------------------------------------------------------------
  {
    method: 'mtn_momo',
    country: 'UG',
    currencies: ['UGX'],
    provider: 'flutterwave',
    collect: true,
    payout: true,
    verified: false,
  },
  {
    method: 'airtel_money',
    country: 'UG',
    currencies: ['UGX'],
    provider: 'flutterwave',
    collect: true,
    payout: true,
    verified: false,
  },

  // --- International cards --------------------------------------------------
  {
    method: 'card',
    country: 'INTL',
    currencies: ['USD', 'EUR'],
    provider: 'stripe',
    collect: true,
    payout: false,
    verified: false,
    note: 'Stripe collects internationally but cannot pay Rwandan or Kenyan sellers — those payouts ride Flutterwave.',
  },
]

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export const METHOD_LABEL: Record<PaymentMethod, string> = {
  card: 'Card',
  mtn_momo: 'MTN Mobile Money',
  airtel_money: 'Airtel Money',
  mpesa: 'M-Pesa',
  bank_transfer: 'Bank transfer',
}

export const METHOD_BLURB: Record<PaymentMethod, string> = {
  card: 'Visa, Mastercard. 3D Secure is requested on every charge.',
  mtn_momo: 'Pay from your MTN wallet. You will get a prompt on your phone.',
  airtel_money: 'Pay from your Airtel wallet. You will get a prompt on your phone.',
  mpesa: 'Pay with M-Pesa. You will get an STK prompt on your phone.',
  bank_transfer: 'Transfer from your bank account.',
}

export const COUNTRY_LABEL: Record<Country, string> = {
  RW: 'Rwanda',
  KE: 'Kenya',
  UG: 'Uganda',
  TZ: 'Tanzania',
  GH: 'Ghana',
  NG: 'Nigeria',
  INTL: 'International',
}

export const PROVIDER_LABEL: Record<Provider, string> = {
  flutterwave: 'Flutterwave',
  stripe: 'Stripe',
  fake: 'Demo mode',
}

export const PROVIDER_BLURB: Record<Provider, string> = {
  flutterwave:
    'The launch rail. Cards and mobile money across East and West Africa, and the only rail that can pay African sellers.',
  stripe:
    'International cards. Activates when keys are configured. Collects worldwide but cannot pay out to Rwanda or Kenya.',
  fake: 'No provider keys configured. Payments are simulated end to end so the product works without a live account.',
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Methods a buyer in this market can actually pay with, in the order to show them. */
export function collectionRails(country: Country, currency: Currency): Rail[] {
  const local = RAILS.filter(
    (r) =>
      r.collect && r.country === country && r.currencies.includes(currency),
  )

  // Anyone can pay by international card if the currency supports it, even
  // where we have no local rail at all.
  const intl = RAILS.filter(
    (r) =>
      r.collect &&
      r.country === 'INTL' &&
      r.currencies.includes(currency) &&
      !local.some((l) => l.method === r.method && l.provider === r.provider),
  )

  // Mobile money before cards: it is what most buyers in these markets use,
  // and it costs the tenant less.
  const order: PaymentMethod[] = [
    'mpesa',
    'mtn_momo',
    'airtel_money',
    'card',
    'bank_transfer',
  ]
  return [...local, ...intl].sort(
    (a, b) => order.indexOf(a.method) - order.indexOf(b.method),
  )
}

/** Which provider a given charge routes to, or null if we cannot take it. */
export function providerFor(
  country: Country,
  currency: Currency,
  method: PaymentMethod,
): Provider | null {
  const rail = collectionRails(country, currency).find((r) => r.method === method)
  return rail?.provider ?? null
}

/** The rail a deal will provisionally use before the buyer chooses a method. */
export function defaultProviderFor(country: Country, currency: Currency): Provider {
  const first = collectionRails(country, currency)[0]
  return first?.provider ?? 'flutterwave'
}

/** Rails that can actually send money to a seller in this market. */
export function payoutRails(country: Country): Rail[] {
  return RAILS.filter((r) => r.payout && r.country === country)
}

/**
 * Why a payout can or cannot use a given provider. The Rwanda/Stripe case is
 * the one that bites, so it is stated rather than implied.
 */
export function payoutCapability(country: Country): {
  provider: Provider | null
  reason: string
} {
  const rails = payoutRails(country)
  if (!rails.length) {
    return {
      provider: null,
      reason: `No payout rail is configured for ${COUNTRY_LABEL[country]} yet.`,
    }
  }
  return {
    provider: 'flutterwave',
    reason:
      country === 'INTL'
        ? 'Paid via Stripe Connect where the seller is in a supported country.'
        : `Paid via Flutterwave — Stripe cannot send funds to ${COUNTRY_LABEL[country]}.`,
  }
}

/** True when a market has at least one collection rail we can take money on. */
export function isMarketSupported(country: Country, currency: Currency): boolean {
  return collectionRails(country, currency).length > 0
}

// ---------------------------------------------------------------------------
// Settlement
// ---------------------------------------------------------------------------

/**
 * Collecting a currency is not the same as being able to withdraw it.
 *
 * Flutterwave holds each collected currency in its own balance. Getting a
 * foreign-currency balance out to a bank account has conditions the local
 * currency does not — which is why `available` on the Rails screen can be
 * non-zero and still not be withdrawable this week.
 *
 * Verified against Flutterwave's settlement documentation, August 2026.
 * Re-check before launch: thresholds change.
 */
export interface SettlementNote {
  currency: Currency
  /** Minimum balance, in minor units, before a settlement will run. */
  minimum: number | null
  detail: string
}

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
    detail:
      `${currency} is held as its own balance and settles separately from ` +
      'your local currency.',
  }
}
