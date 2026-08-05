/**
 * Every country PayHold serves, and what each provider can actually do there.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * The one structural fact that makes "works for anyone, anywhere" possible:
 * **card acquiring is global**. A card issued in Namibia can be charged by a
 * Stripe merchant even though Stripe has no Namibian presence at all. So every
 * country below has at least one way to pay.
 *
 * Everything else is local and patchy:
 *   - `flutterwaveLocal`  Flutterwave supports this country's own currency
 *   - `momoNetworks`      mobile money wallets that actually work there
 *   - `flutterwavePayout` Flutterwave can send money TO someone there
 *   - `stripePayout`      Stripe can send money TO someone there
 *
 * Collecting and paying out are different capabilities in different places.
 * Most of Africa can be collected from and cannot be paid into.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Sources, checked August 2026 — re-check before launch, coverage changes:
 *   flutterwave.com/gb/support/payment-methods/payment-channels
 *   flutterwave.com/mw/support/payment-methods/pay-with-mobile-money
 *   flutterwave.com/mu/support/general/what-are-the-currencies-accepted-on-flutterwave
 *   stripe.com/global
 *
 * Nothing here is `verified` until someone confirms it against a signed
 * account agreement. See `RAILS_VERIFIED` in rails.ts.
 */

import type { Country, Currency } from '@/api/types'

export interface CountryInfo {
  code: Country
  name: string
  /** ISO code of the local currency. */
  currency: Currency
  region: 'North' | 'West' | 'Central' | 'East' | 'Southern' | 'Americas'
  /** Flutterwave supports collection in this country's own currency. */
  flutterwaveLocal: boolean
  /**
   * Mobile money wallets Flutterwave supports here. Empty means either no
   * mobile money, or supported but the network list is unconfirmed — check
   * `momo` for which.
   */
  momo: boolean
  momoNetworks: string[]
  /** Flutterwave can send funds to a beneficiary here. */
  flutterwavePayout: boolean
  /** Stripe supports a business account with payouts here. */
  stripePayout: boolean
}

/**
 * Ordered alphabetically within Africa, with the United States last.
 *
 * Where `flutterwaveLocal` is false the country still gets a card rail — it is
 * simply acquired internationally in USD or EUR rather than in local currency.
 */
export const COUNTRIES: CountryInfo[] = [
  // --- North Africa ---------------------------------------------------------
  c('DZ', 'Algeria', 'DZD', 'North'),
  c('EG', 'Egypt', 'EGP', 'North', { flutterwaveLocal: true, flutterwavePayout: true }),
  c('LY', 'Libya', 'LYD', 'North'),
  c('MA', 'Morocco', 'MAD', 'North'),
  c('SD', 'Sudan', 'SDG', 'North'),
  c('TN', 'Tunisia', 'TND', 'North'),

  // --- West Africa ----------------------------------------------------------
  c('BJ', 'Benin', 'XOF', 'West', { flutterwaveLocal: true, flutterwavePayout: true }),
  c('BF', 'Burkina Faso', 'XOF', 'West', {
    flutterwaveLocal: true,
    flutterwavePayout: true,
    momoNetworks: ['Orange Money', 'Mobicash'],
  }),
  c('CV', 'Cabo Verde', 'CVE', 'West'),
  c('CI', "Côte d'Ivoire", 'XOF', 'West', {
    flutterwaveLocal: true,
    flutterwavePayout: true,
    momoNetworks: ['MTN', 'Orange Money', 'Wave'],
  }),
  c('GM', 'Gambia', 'GMD', 'West'),
  c('GH', 'Ghana', 'GHS', 'West', {
    flutterwaveLocal: true,
    flutterwavePayout: true,
    momoNetworks: ['MTN', 'Telecel', 'AirtelTigo'],
  }),
  c('GN', 'Guinea', 'GNF', 'West'),
  c('GW', 'Guinea-Bissau', 'XOF', 'West', {
    flutterwaveLocal: true,
    flutterwavePayout: true,
  }),
  c('LR', 'Liberia', 'LRD', 'West'),
  c('ML', 'Mali', 'XOF', 'West', { flutterwaveLocal: true, flutterwavePayout: true }),
  c('MR', 'Mauritania', 'MRU', 'West'),
  c('NE', 'Niger', 'XOF', 'West', { flutterwaveLocal: true, flutterwavePayout: true }),
  c('NG', 'Nigeria', 'NGN', 'West', {
    flutterwaveLocal: true,
    flutterwavePayout: true,
  }),
  c('SN', 'Senegal', 'XOF', 'West', {
    flutterwaveLocal: true,
    flutterwavePayout: true,
    momoNetworks: ['Orange Money', 'Free Money', 'Wave'],
  }),
  c('SL', 'Sierra Leone', 'SLE', 'West', {
    flutterwaveLocal: true,
    flutterwavePayout: true,
  }),
  c('TG', 'Togo', 'XOF', 'West', { flutterwaveLocal: true, flutterwavePayout: true }),

  // --- Central Africa -------------------------------------------------------
  c('CM', 'Cameroon', 'XAF', 'Central', {
    flutterwaveLocal: true,
    flutterwavePayout: true,
    momoNetworks: ['MTN', 'Orange Money'],
  }),
  c('CF', 'Central African Republic', 'XAF', 'Central', {
    flutterwaveLocal: true,
    flutterwavePayout: true,
  }),
  c('TD', 'Chad', 'XAF', 'Central', {
    flutterwaveLocal: true,
    flutterwavePayout: true,
  }),
  c('CG', 'Congo', 'XAF', 'Central', {
    flutterwaveLocal: true,
    flutterwavePayout: true,
  }),
  c('CD', 'DR Congo', 'CDF', 'Central'),
  c('GQ', 'Equatorial Guinea', 'XAF', 'Central', {
    flutterwaveLocal: true,
    flutterwavePayout: true,
  }),
  c('GA', 'Gabon', 'XAF', 'Central', {
    flutterwaveLocal: true,
    flutterwavePayout: true,
  }),
  c('ST', 'São Tomé and Príncipe', 'STN', 'Central'),

  // --- East Africa ----------------------------------------------------------
  c('BI', 'Burundi', 'BIF', 'East'),
  c('KM', 'Comoros', 'KMF', 'East'),
  c('DJ', 'Djibouti', 'DJF', 'East'),
  c('ER', 'Eritrea', 'ERN', 'East'),
  c('ET', 'Ethiopia', 'ETB', 'East'),
  c('KE', 'Kenya', 'KES', 'East', {
    flutterwaveLocal: true,
    flutterwavePayout: true,
    momoNetworks: ['M-Pesa'],
  }),
  c('MG', 'Madagascar', 'MGA', 'East'),
  c('MU', 'Mauritius', 'MUR', 'East'),
  c('RW', 'Rwanda', 'RWF', 'East', {
    flutterwaveLocal: true,
    flutterwavePayout: true,
    momoNetworks: ['MTN', 'Airtel Money'],
  }),
  c('SC', 'Seychelles', 'SCR', 'East'),
  c('SO', 'Somalia', 'SOS', 'East'),
  c('SS', 'South Sudan', 'SSP', 'East'),
  c('TZ', 'Tanzania', 'TZS', 'East', {
    flutterwaveLocal: true,
    flutterwavePayout: true,
    momoNetworks: ['Airtel Money', 'Tigo Pesa', 'HaloPesa'],
  }),
  c('UG', 'Uganda', 'UGX', 'East', {
    flutterwaveLocal: true,
    flutterwavePayout: true,
    momoNetworks: ['MTN', 'Airtel Money'],
  }),

  // --- Southern Africa ------------------------------------------------------
  c('AO', 'Angola', 'AOA', 'Southern'),
  c('BW', 'Botswana', 'BWP', 'Southern'),
  c('SZ', 'Eswatini', 'SZL', 'Southern'),
  c('LS', 'Lesotho', 'LSL', 'Southern'),
  c('MW', 'Malawi', 'MWK', 'Southern', {
    flutterwaveLocal: true,
    flutterwavePayout: true,
    // Flutterwave documents "Mobile Money Malawi" as a channel but does not
    // name the networks — left blank rather than guessed.
    momo: true,
  }),
  c('MZ', 'Mozambique', 'MZN', 'Southern'),
  c('NA', 'Namibia', 'NAD', 'Southern'),
  c('ZA', 'South Africa', 'ZAR', 'Southern', {
    flutterwaveLocal: true,
    flutterwavePayout: true,
  }),
  c('ZM', 'Zambia', 'ZMW', 'Southern', {
    flutterwaveLocal: true,
    flutterwavePayout: true,
    momoNetworks: ['MTN', 'Airtel Money', 'Zamtel'],
  }),
  c('ZW', 'Zimbabwe', 'ZWG', 'Southern'),

  // --- Americas -------------------------------------------------------------
  c('US', 'United States', 'USD', 'Americas', {
    stripePayout: true,
  }),
]

/** Terse constructor so the table above stays readable. */
function c(
  code: Country,
  name: string,
  currency: Currency,
  region: CountryInfo['region'],
  extra: Partial<
    Pick<
      CountryInfo,
      'flutterwaveLocal' | 'momo' | 'momoNetworks' | 'flutterwavePayout' | 'stripePayout'
    >
  > = {},
): CountryInfo {
  const momoNetworks = extra.momoNetworks ?? []
  return {
    code,
    name,
    currency,
    region,
    flutterwaveLocal: extra.flutterwaveLocal ?? false,
    momo: extra.momo ?? momoNetworks.length > 0,
    momoNetworks,
    flutterwavePayout: extra.flutterwavePayout ?? false,
    stripePayout: extra.stripePayout ?? false,
  }
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

const BY_CODE = new Map(COUNTRIES.map((info) => [info.code, info]))

export function countryInfo(code: Country): CountryInfo {
  const info = BY_CODE.get(code)
  if (!info) throw new Error(`Unknown country: ${code}`)
  return info
}

export function countryName(code: Country): string {
  return BY_CODE.get(code)?.name ?? code
}

export const REGIONS: CountryInfo['region'][] = [
  'East',
  'West',
  'Central',
  'North',
  'Southern',
  'Americas',
]

/** Countries grouped for a picker, so a 55-item list stays navigable. */
export function countriesByRegion(): { region: string; countries: CountryInfo[] }[] {
  return REGIONS.map((region) => ({
    region: region === 'Americas' ? 'Americas' : `${region} Africa`,
    countries: COUNTRIES.filter((info) => info.region === region),
  })).filter((group) => group.countries.length > 0)
}

/** Currencies with no minor unit — formatting must not divide these by 100. */
export const ZERO_DECIMAL_CURRENCIES: Currency[] = [
  'RWF',
  'UGX',
  'XOF',
  'XAF',
  'BIF',
  'KMF',
  'DJF',
  'GNF',
  'MGA',
  'VUV',
  'CLP',
  'JPY',
  'KRW',
  'PYG',
]
