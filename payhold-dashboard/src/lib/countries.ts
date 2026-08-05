/**
 * Every country in the world, and what each provider can actually do there.
 *
 * GENERATED FILE — see scripts/gen-countries.py. Edit the generator, not this.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Two facts shape everything downstream:
 *
 *   1. **Card acquiring is near-universal.** A card issued in Vanuatu can be
 *      charged by a Stripe merchant even though Stripe has no presence there.
 *      So almost every country can pay — `restricted` marks the handful where
 *      sanctions mean no acquirer will process, and nothing else.
 *
 *   2. **Paying out is licensed per corridor, and narrow.** Stripe reaches 44
 *      countries. Flutterwave reaches its African markets. Between them that
 *      is well under half the world, and the rest can pay but cannot be paid.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Sources, checked August 2026 — re-check before launch, coverage changes:
 *   stripe.com/global
 *   flutterwave.com/gb/support/payment-methods/payment-channels
 *   flutterwave.com/mw/support/payment-methods/pay-with-mobile-money
 *   flutterwave.com/mu/support/general/what-are-the-currencies-accepted-on-flutterwave
 *
 * Nothing here is verified against a signed provider agreement. See
 * `RAILS_VERIFIED` in rails.ts.
 */

export interface CountryInfo {
  code: Country
  name: string
  /** ISO-4217 code of the local currency. */
  currency: Currency
  region: Region
  /** Flutterwave supports collection in this country's own currency. */
  flutterwaveLocal: boolean
  /** Mobile money is available here. */
  momo: boolean
  /** Named wallets. Empty with `momo: true` means the list is unconfirmed. */
  momoNetworks: string[]
  /** Flutterwave can send funds to a beneficiary here. */
  flutterwavePayout: boolean
  /** Stripe supports a business account with payouts here. */
  stripePayout: boolean
  /** Stripe lists this market as preview / contact-sales only. */
  stripePreview: boolean
  /** Sanctioned or embargoed — no card acquirer will process. */
  restricted: boolean
}

export type Region =
  | 'North Africa'
  | 'West Africa'
  | 'Central Africa'
  | 'East Africa'
  | 'Southern Africa'
  | 'Europe'
  | 'Middle East'
  | 'Asia'
  | 'Oceania'
  | 'North America'
  | 'South America'

export const REGIONS: Region[] = [
  'North Africa',
  'West Africa',
  'Central Africa',
  'East Africa',
  'Southern Africa',
  'Europe',
  'Middle East',
  'Asia',
  'Oceania',
  'North America',
  'South America',
]

/** ISO-3166 alpha-2 for every country PayHold knows about. */
export type Country =
  | 'DZ' | 'EG' | 'LY' | 'MA' | 'SD' | 'TN' | 'BJ' | 'BF' | 'CV' | 'CI'
  | 'GM' | 'GH' | 'GN' | 'GW' | 'LR' | 'ML' | 'MR' | 'NE' | 'NG' | 'SN'
  | 'SL' | 'TG' | 'CM' | 'CF' | 'TD' | 'CG' | 'CD' | 'GQ' | 'GA' | 'ST'
  | 'BI' | 'KM' | 'DJ' | 'ER' | 'ET' | 'KE' | 'MG' | 'MU' | 'RW' | 'SC'
  | 'SO' | 'SS' | 'TZ' | 'UG' | 'AO' | 'BW' | 'SZ' | 'LS' | 'MW' | 'MZ'
  | 'NA' | 'ZA' | 'ZM' | 'ZW' | 'AL' | 'AD' | 'AT' | 'BY' | 'BE' | 'BA'
  | 'BG' | 'HR' | 'CY' | 'CZ' | 'DK' | 'EE' | 'FI' | 'FR' | 'DE' | 'GI'
  | 'GR' | 'HU' | 'IS' | 'IE' | 'IT' | 'LV' | 'LI' | 'LT' | 'LU' | 'MT'
  | 'MD' | 'MC' | 'ME' | 'NL' | 'MK' | 'NO' | 'PL' | 'PT' | 'RO' | 'RU'
  | 'SM' | 'RS' | 'SK' | 'SI' | 'ES' | 'SE' | 'CH' | 'UA' | 'GB' | 'BH'
  | 'IR' | 'IQ' | 'IL' | 'JO' | 'KW' | 'LB' | 'OM' | 'PS' | 'QA' | 'SA'
  | 'SY' | 'TR' | 'AE' | 'YE' | 'AF' | 'AM' | 'AZ' | 'BD' | 'BT' | 'BN'
  | 'KH' | 'CN' | 'GE' | 'HK' | 'IN' | 'ID' | 'JP' | 'KZ' | 'KG' | 'LA'
  | 'MO' | 'MY' | 'MV' | 'MN' | 'MM' | 'NP' | 'KP' | 'PK' | 'PH' | 'SG'
  | 'KR' | 'LK' | 'TW' | 'TJ' | 'TH' | 'TL' | 'TM' | 'UZ' | 'VN' | 'AU'
  | 'FJ' | 'KI' | 'MH' | 'FM' | 'NR' | 'NZ' | 'PW' | 'PG' | 'WS' | 'SB'
  | 'TO' | 'TV' | 'VU' | 'AG' | 'BS' | 'BB' | 'BZ' | 'CA' | 'CR' | 'CU'
  | 'DM' | 'DO' | 'SV' | 'GD' | 'GT' | 'HT' | 'HN' | 'JM' | 'MX' | 'NI'
  | 'PA' | 'KN' | 'LC' | 'VC' | 'TT' | 'US' | 'AR' | 'BO' | 'BR' | 'CL'
  | 'CO' | 'EC' | 'GY' | 'PY' | 'PE' | 'SR' | 'UY' | 'VE'

/** ISO-4217 for every currency any of those countries uses. */
export type Currency =
  | 'AED' | 'AFN' | 'ALL' | 'AMD' | 'AOA' | 'ARS' | 'AUD' | 'AZN' | 'BAM' | 'BBD'
  | 'BDT' | 'BGN' | 'BHD' | 'BIF' | 'BND' | 'BOB' | 'BRL' | 'BSD' | 'BTN' | 'BWP'
  | 'BYN' | 'BZD' | 'CAD' | 'CDF' | 'CHF' | 'CLP' | 'CNY' | 'COP' | 'CRC' | 'CUP'
  | 'CVE' | 'CZK' | 'DJF' | 'DKK' | 'DOP' | 'DZD' | 'EGP' | 'ERN' | 'ETB' | 'EUR'
  | 'FJD' | 'GBP' | 'GEL' | 'GHS' | 'GIP' | 'GMD' | 'GNF' | 'GTQ' | 'GYD' | 'HKD'
  | 'HNL' | 'HTG' | 'HUF' | 'IDR' | 'ILS' | 'INR' | 'IQD' | 'IRR' | 'ISK' | 'JMD'
  | 'JOD' | 'JPY' | 'KES' | 'KGS' | 'KHR' | 'KMF' | 'KPW' | 'KRW' | 'KWD' | 'KZT'
  | 'LAK' | 'LBP' | 'LKR' | 'LRD' | 'LSL' | 'LYD' | 'MAD' | 'MDL' | 'MGA' | 'MKD'
  | 'MMK' | 'MNT' | 'MOP' | 'MRU' | 'MUR' | 'MVR' | 'MWK' | 'MXN' | 'MYR' | 'MZN'
  | 'NAD' | 'NGN' | 'NIO' | 'NOK' | 'NPR' | 'NZD' | 'OMR' | 'PAB' | 'PEN' | 'PGK'
  | 'PHP' | 'PKR' | 'PLN' | 'PYG' | 'QAR' | 'RON' | 'RSD' | 'RUB' | 'RWF' | 'SAR'
  | 'SBD' | 'SCR' | 'SDG' | 'SEK' | 'SGD' | 'SLE' | 'SOS' | 'SRD' | 'SSP' | 'STN'
  | 'SYP' | 'SZL' | 'THB' | 'TJS' | 'TMT' | 'TND' | 'TOP' | 'TRY' | 'TTD' | 'TWD'
  | 'TZS' | 'UAH' | 'UGX' | 'USD' | 'UYU' | 'UZS' | 'VES' | 'VND' | 'VUV' | 'WST'
  | 'XAF' | 'XCD' | 'XOF' | 'YER' | 'ZAR' | 'ZMW' | 'ZWG'

export const COUNTRIES: CountryInfo[] = [
  // --- North Africa ------------------------------------------------------
  { code: 'DZ', name: 'Algeria', currency: 'DZD', region: 'North Africa', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'EG', name: 'Egypt', currency: 'EGP', region: 'North Africa', flutterwaveLocal: true, momo: false, momoNetworks: [], flutterwavePayout: true, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'LY', name: 'Libya', currency: 'LYD', region: 'North Africa', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'MA', name: 'Morocco', currency: 'MAD', region: 'North Africa', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'SD', name: 'Sudan', currency: 'SDG', region: 'North Africa', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'TN', name: 'Tunisia', currency: 'TND', region: 'North Africa', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  // --- West Africa -------------------------------------------------------
  { code: 'BJ', name: 'Benin', currency: 'XOF', region: 'West Africa', flutterwaveLocal: true, momo: false, momoNetworks: [], flutterwavePayout: true, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'BF', name: 'Burkina Faso', currency: 'XOF', region: 'West Africa', flutterwaveLocal: true, momo: true, momoNetworks: ['Orange Money', 'Mobicash'], flutterwavePayout: true, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'CV', name: 'Cabo Verde', currency: 'CVE', region: 'West Africa', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'CI', name: 'Côte d\'Ivoire', currency: 'XOF', region: 'West Africa', flutterwaveLocal: true, momo: true, momoNetworks: ['MTN', 'Orange Money', 'Wave'], flutterwavePayout: true, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'GM', name: 'Gambia', currency: 'GMD', region: 'West Africa', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'GH', name: 'Ghana', currency: 'GHS', region: 'West Africa', flutterwaveLocal: true, momo: true, momoNetworks: ['MTN', 'Telecel', 'AirtelTigo'], flutterwavePayout: true, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'GN', name: 'Guinea', currency: 'GNF', region: 'West Africa', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'GW', name: 'Guinea-Bissau', currency: 'XOF', region: 'West Africa', flutterwaveLocal: true, momo: false, momoNetworks: [], flutterwavePayout: true, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'LR', name: 'Liberia', currency: 'LRD', region: 'West Africa', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'ML', name: 'Mali', currency: 'XOF', region: 'West Africa', flutterwaveLocal: true, momo: false, momoNetworks: [], flutterwavePayout: true, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'MR', name: 'Mauritania', currency: 'MRU', region: 'West Africa', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'NE', name: 'Niger', currency: 'XOF', region: 'West Africa', flutterwaveLocal: true, momo: false, momoNetworks: [], flutterwavePayout: true, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'NG', name: 'Nigeria', currency: 'NGN', region: 'West Africa', flutterwaveLocal: true, momo: false, momoNetworks: [], flutterwavePayout: true, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'SN', name: 'Senegal', currency: 'XOF', region: 'West Africa', flutterwaveLocal: true, momo: true, momoNetworks: ['Orange Money', 'Free Money', 'Wave'], flutterwavePayout: true, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'SL', name: 'Sierra Leone', currency: 'SLE', region: 'West Africa', flutterwaveLocal: true, momo: false, momoNetworks: [], flutterwavePayout: true, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'TG', name: 'Togo', currency: 'XOF', region: 'West Africa', flutterwaveLocal: true, momo: false, momoNetworks: [], flutterwavePayout: true, stripePayout: false, stripePreview: false, restricted: false },
  // --- Central Africa ----------------------------------------------------
  { code: 'CM', name: 'Cameroon', currency: 'XAF', region: 'Central Africa', flutterwaveLocal: true, momo: true, momoNetworks: ['MTN', 'Orange Money'], flutterwavePayout: true, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'CF', name: 'Central African Republic', currency: 'XAF', region: 'Central Africa', flutterwaveLocal: true, momo: false, momoNetworks: [], flutterwavePayout: true, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'TD', name: 'Chad', currency: 'XAF', region: 'Central Africa', flutterwaveLocal: true, momo: false, momoNetworks: [], flutterwavePayout: true, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'CG', name: 'Congo', currency: 'XAF', region: 'Central Africa', flutterwaveLocal: true, momo: false, momoNetworks: [], flutterwavePayout: true, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'CD', name: 'DR Congo', currency: 'CDF', region: 'Central Africa', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'GQ', name: 'Equatorial Guinea', currency: 'XAF', region: 'Central Africa', flutterwaveLocal: true, momo: false, momoNetworks: [], flutterwavePayout: true, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'GA', name: 'Gabon', currency: 'XAF', region: 'Central Africa', flutterwaveLocal: true, momo: false, momoNetworks: [], flutterwavePayout: true, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'ST', name: 'São Tomé and Príncipe', currency: 'STN', region: 'Central Africa', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  // --- East Africa -------------------------------------------------------
  { code: 'BI', name: 'Burundi', currency: 'BIF', region: 'East Africa', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'KM', name: 'Comoros', currency: 'KMF', region: 'East Africa', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'DJ', name: 'Djibouti', currency: 'DJF', region: 'East Africa', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'ER', name: 'Eritrea', currency: 'ERN', region: 'East Africa', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'ET', name: 'Ethiopia', currency: 'ETB', region: 'East Africa', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'KE', name: 'Kenya', currency: 'KES', region: 'East Africa', flutterwaveLocal: true, momo: true, momoNetworks: ['M-Pesa'], flutterwavePayout: true, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'MG', name: 'Madagascar', currency: 'MGA', region: 'East Africa', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'MU', name: 'Mauritius', currency: 'MUR', region: 'East Africa', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'RW', name: 'Rwanda', currency: 'RWF', region: 'East Africa', flutterwaveLocal: true, momo: true, momoNetworks: ['MTN', 'Airtel Money'], flutterwavePayout: true, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'SC', name: 'Seychelles', currency: 'SCR', region: 'East Africa', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'SO', name: 'Somalia', currency: 'SOS', region: 'East Africa', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'SS', name: 'South Sudan', currency: 'SSP', region: 'East Africa', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'TZ', name: 'Tanzania', currency: 'TZS', region: 'East Africa', flutterwaveLocal: true, momo: true, momoNetworks: ['Airtel Money', 'Tigo Pesa', 'HaloPesa'], flutterwavePayout: true, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'UG', name: 'Uganda', currency: 'UGX', region: 'East Africa', flutterwaveLocal: true, momo: true, momoNetworks: ['MTN', 'Airtel Money'], flutterwavePayout: true, stripePayout: false, stripePreview: false, restricted: false },
  // --- Southern Africa ---------------------------------------------------
  { code: 'AO', name: 'Angola', currency: 'AOA', region: 'Southern Africa', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'BW', name: 'Botswana', currency: 'BWP', region: 'Southern Africa', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'SZ', name: 'Eswatini', currency: 'SZL', region: 'Southern Africa', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'LS', name: 'Lesotho', currency: 'LSL', region: 'Southern Africa', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'MW', name: 'Malawi', currency: 'MWK', region: 'Southern Africa', flutterwaveLocal: true, momo: true, momoNetworks: [], flutterwavePayout: true, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'MZ', name: 'Mozambique', currency: 'MZN', region: 'Southern Africa', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'NA', name: 'Namibia', currency: 'NAD', region: 'Southern Africa', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'ZA', name: 'South Africa', currency: 'ZAR', region: 'Southern Africa', flutterwaveLocal: true, momo: false, momoNetworks: [], flutterwavePayout: true, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'ZM', name: 'Zambia', currency: 'ZMW', region: 'Southern Africa', flutterwaveLocal: true, momo: true, momoNetworks: ['MTN', 'Airtel Money', 'Zamtel'], flutterwavePayout: true, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'ZW', name: 'Zimbabwe', currency: 'ZWG', region: 'Southern Africa', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  // --- Europe ------------------------------------------------------------
  { code: 'AL', name: 'Albania', currency: 'ALL', region: 'Europe', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'AD', name: 'Andorra', currency: 'EUR', region: 'Europe', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'AT', name: 'Austria', currency: 'EUR', region: 'Europe', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: true, stripePreview: false, restricted: false },
  { code: 'BY', name: 'Belarus', currency: 'BYN', region: 'Europe', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: true },
  { code: 'BE', name: 'Belgium', currency: 'EUR', region: 'Europe', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: true, stripePreview: false, restricted: false },
  { code: 'BA', name: 'Bosnia and Herzegovina', currency: 'BAM', region: 'Europe', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'BG', name: 'Bulgaria', currency: 'BGN', region: 'Europe', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: true, stripePreview: false, restricted: false },
  { code: 'HR', name: 'Croatia', currency: 'EUR', region: 'Europe', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: true, stripePreview: false, restricted: false },
  { code: 'CY', name: 'Cyprus', currency: 'EUR', region: 'Europe', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: true, stripePreview: false, restricted: false },
  { code: 'CZ', name: 'Czechia', currency: 'CZK', region: 'Europe', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: true, stripePreview: false, restricted: false },
  { code: 'DK', name: 'Denmark', currency: 'DKK', region: 'Europe', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: true, stripePreview: false, restricted: false },
  { code: 'EE', name: 'Estonia', currency: 'EUR', region: 'Europe', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: true, stripePreview: false, restricted: false },
  { code: 'FI', name: 'Finland', currency: 'EUR', region: 'Europe', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: true, stripePreview: false, restricted: false },
  { code: 'FR', name: 'France', currency: 'EUR', region: 'Europe', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: true, stripePreview: false, restricted: false },
  { code: 'DE', name: 'Germany', currency: 'EUR', region: 'Europe', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: true, stripePreview: false, restricted: false },
  { code: 'GI', name: 'Gibraltar', currency: 'GIP', region: 'Europe', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: true, stripePreview: false, restricted: false },
  { code: 'GR', name: 'Greece', currency: 'EUR', region: 'Europe', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: true, stripePreview: false, restricted: false },
  { code: 'HU', name: 'Hungary', currency: 'HUF', region: 'Europe', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: true, stripePreview: false, restricted: false },
  { code: 'IS', name: 'Iceland', currency: 'ISK', region: 'Europe', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'IE', name: 'Ireland', currency: 'EUR', region: 'Europe', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: true, stripePreview: false, restricted: false },
  { code: 'IT', name: 'Italy', currency: 'EUR', region: 'Europe', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: true, stripePreview: false, restricted: false },
  { code: 'LV', name: 'Latvia', currency: 'EUR', region: 'Europe', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: true, stripePreview: false, restricted: false },
  { code: 'LI', name: 'Liechtenstein', currency: 'CHF', region: 'Europe', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: true, stripePreview: false, restricted: false },
  { code: 'LT', name: 'Lithuania', currency: 'EUR', region: 'Europe', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: true, stripePreview: false, restricted: false },
  { code: 'LU', name: 'Luxembourg', currency: 'EUR', region: 'Europe', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: true, stripePreview: false, restricted: false },
  { code: 'MT', name: 'Malta', currency: 'EUR', region: 'Europe', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: true, stripePreview: false, restricted: false },
  { code: 'MD', name: 'Moldova', currency: 'MDL', region: 'Europe', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'MC', name: 'Monaco', currency: 'EUR', region: 'Europe', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'ME', name: 'Montenegro', currency: 'EUR', region: 'Europe', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'NL', name: 'Netherlands', currency: 'EUR', region: 'Europe', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: true, stripePreview: false, restricted: false },
  { code: 'MK', name: 'North Macedonia', currency: 'MKD', region: 'Europe', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'NO', name: 'Norway', currency: 'NOK', region: 'Europe', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: true, stripePreview: false, restricted: false },
  { code: 'PL', name: 'Poland', currency: 'PLN', region: 'Europe', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: true, stripePreview: false, restricted: false },
  { code: 'PT', name: 'Portugal', currency: 'EUR', region: 'Europe', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: true, stripePreview: false, restricted: false },
  { code: 'RO', name: 'Romania', currency: 'RON', region: 'Europe', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: true, stripePreview: false, restricted: false },
  { code: 'RU', name: 'Russia', currency: 'RUB', region: 'Europe', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: true },
  { code: 'SM', name: 'San Marino', currency: 'EUR', region: 'Europe', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'RS', name: 'Serbia', currency: 'RSD', region: 'Europe', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'SK', name: 'Slovakia', currency: 'EUR', region: 'Europe', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: true, stripePreview: false, restricted: false },
  { code: 'SI', name: 'Slovenia', currency: 'EUR', region: 'Europe', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: true, stripePreview: false, restricted: false },
  { code: 'ES', name: 'Spain', currency: 'EUR', region: 'Europe', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: true, stripePreview: false, restricted: false },
  { code: 'SE', name: 'Sweden', currency: 'SEK', region: 'Europe', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: true, stripePreview: false, restricted: false },
  { code: 'CH', name: 'Switzerland', currency: 'CHF', region: 'Europe', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: true, stripePreview: false, restricted: false },
  { code: 'UA', name: 'Ukraine', currency: 'UAH', region: 'Europe', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'GB', name: 'United Kingdom', currency: 'GBP', region: 'Europe', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: true, stripePreview: false, restricted: false },
  // --- Middle East -------------------------------------------------------
  { code: 'BH', name: 'Bahrain', currency: 'BHD', region: 'Middle East', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'IR', name: 'Iran', currency: 'IRR', region: 'Middle East', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: true },
  { code: 'IQ', name: 'Iraq', currency: 'IQD', region: 'Middle East', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'IL', name: 'Israel', currency: 'ILS', region: 'Middle East', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'JO', name: 'Jordan', currency: 'JOD', region: 'Middle East', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'KW', name: 'Kuwait', currency: 'KWD', region: 'Middle East', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'LB', name: 'Lebanon', currency: 'LBP', region: 'Middle East', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'OM', name: 'Oman', currency: 'OMR', region: 'Middle East', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'PS', name: 'Palestine', currency: 'ILS', region: 'Middle East', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'QA', name: 'Qatar', currency: 'QAR', region: 'Middle East', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'SA', name: 'Saudi Arabia', currency: 'SAR', region: 'Middle East', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'SY', name: 'Syria', currency: 'SYP', region: 'Middle East', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: true },
  { code: 'TR', name: 'Türkiye', currency: 'TRY', region: 'Middle East', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'AE', name: 'United Arab Emirates', currency: 'AED', region: 'Middle East', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: true, stripePreview: false, restricted: false },
  { code: 'YE', name: 'Yemen', currency: 'YER', region: 'Middle East', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  // --- Asia --------------------------------------------------------------
  { code: 'AF', name: 'Afghanistan', currency: 'AFN', region: 'Asia', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'AM', name: 'Armenia', currency: 'AMD', region: 'Asia', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'AZ', name: 'Azerbaijan', currency: 'AZN', region: 'Asia', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'BD', name: 'Bangladesh', currency: 'BDT', region: 'Asia', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'BT', name: 'Bhutan', currency: 'BTN', region: 'Asia', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'BN', name: 'Brunei', currency: 'BND', region: 'Asia', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'KH', name: 'Cambodia', currency: 'KHR', region: 'Asia', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'CN', name: 'China', currency: 'CNY', region: 'Asia', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'GE', name: 'Georgia', currency: 'GEL', region: 'Asia', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'HK', name: 'Hong Kong', currency: 'HKD', region: 'Asia', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: true, stripePreview: false, restricted: false },
  { code: 'IN', name: 'India', currency: 'INR', region: 'Asia', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: true, restricted: false },
  { code: 'ID', name: 'Indonesia', currency: 'IDR', region: 'Asia', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: true, restricted: false },
  { code: 'JP', name: 'Japan', currency: 'JPY', region: 'Asia', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: true, stripePreview: false, restricted: false },
  { code: 'KZ', name: 'Kazakhstan', currency: 'KZT', region: 'Asia', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'KG', name: 'Kyrgyzstan', currency: 'KGS', region: 'Asia', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'LA', name: 'Laos', currency: 'LAK', region: 'Asia', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'MO', name: 'Macao', currency: 'MOP', region: 'Asia', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'MY', name: 'Malaysia', currency: 'MYR', region: 'Asia', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: true, stripePreview: false, restricted: false },
  { code: 'MV', name: 'Maldives', currency: 'MVR', region: 'Asia', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'MN', name: 'Mongolia', currency: 'MNT', region: 'Asia', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'MM', name: 'Myanmar', currency: 'MMK', region: 'Asia', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'NP', name: 'Nepal', currency: 'NPR', region: 'Asia', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'KP', name: 'North Korea', currency: 'KPW', region: 'Asia', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: true },
  { code: 'PK', name: 'Pakistan', currency: 'PKR', region: 'Asia', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'PH', name: 'Philippines', currency: 'PHP', region: 'Asia', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'SG', name: 'Singapore', currency: 'SGD', region: 'Asia', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: true, stripePreview: false, restricted: false },
  { code: 'KR', name: 'South Korea', currency: 'KRW', region: 'Asia', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'LK', name: 'Sri Lanka', currency: 'LKR', region: 'Asia', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'TW', name: 'Taiwan', currency: 'TWD', region: 'Asia', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'TJ', name: 'Tajikistan', currency: 'TJS', region: 'Asia', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'TH', name: 'Thailand', currency: 'THB', region: 'Asia', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: true, stripePreview: false, restricted: false },
  { code: 'TL', name: 'Timor-Leste', currency: 'USD', region: 'Asia', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'TM', name: 'Turkmenistan', currency: 'TMT', region: 'Asia', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'UZ', name: 'Uzbekistan', currency: 'UZS', region: 'Asia', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'VN', name: 'Vietnam', currency: 'VND', region: 'Asia', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  // --- Oceania -----------------------------------------------------------
  { code: 'AU', name: 'Australia', currency: 'AUD', region: 'Oceania', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: true, stripePreview: false, restricted: false },
  { code: 'FJ', name: 'Fiji', currency: 'FJD', region: 'Oceania', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'KI', name: 'Kiribati', currency: 'AUD', region: 'Oceania', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'MH', name: 'Marshall Islands', currency: 'USD', region: 'Oceania', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'FM', name: 'Micronesia', currency: 'USD', region: 'Oceania', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'NR', name: 'Nauru', currency: 'AUD', region: 'Oceania', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'NZ', name: 'New Zealand', currency: 'NZD', region: 'Oceania', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: true, stripePreview: false, restricted: false },
  { code: 'PW', name: 'Palau', currency: 'USD', region: 'Oceania', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'PG', name: 'Papua New Guinea', currency: 'PGK', region: 'Oceania', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'WS', name: 'Samoa', currency: 'WST', region: 'Oceania', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'SB', name: 'Solomon Islands', currency: 'SBD', region: 'Oceania', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'TO', name: 'Tonga', currency: 'TOP', region: 'Oceania', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'TV', name: 'Tuvalu', currency: 'AUD', region: 'Oceania', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'VU', name: 'Vanuatu', currency: 'VUV', region: 'Oceania', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  // --- North America -----------------------------------------------------
  { code: 'AG', name: 'Antigua and Barbuda', currency: 'XCD', region: 'North America', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'BS', name: 'Bahamas', currency: 'BSD', region: 'North America', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'BB', name: 'Barbados', currency: 'BBD', region: 'North America', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'BZ', name: 'Belize', currency: 'BZD', region: 'North America', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'CA', name: 'Canada', currency: 'CAD', region: 'North America', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: true, stripePreview: false, restricted: false },
  { code: 'CR', name: 'Costa Rica', currency: 'CRC', region: 'North America', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'CU', name: 'Cuba', currency: 'CUP', region: 'North America', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: true },
  { code: 'DM', name: 'Dominica', currency: 'XCD', region: 'North America', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'DO', name: 'Dominican Republic', currency: 'DOP', region: 'North America', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'SV', name: 'El Salvador', currency: 'USD', region: 'North America', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'GD', name: 'Grenada', currency: 'XCD', region: 'North America', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'GT', name: 'Guatemala', currency: 'GTQ', region: 'North America', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'HT', name: 'Haiti', currency: 'HTG', region: 'North America', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'HN', name: 'Honduras', currency: 'HNL', region: 'North America', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'JM', name: 'Jamaica', currency: 'JMD', region: 'North America', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'MX', name: 'Mexico', currency: 'MXN', region: 'North America', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: true, stripePreview: false, restricted: false },
  { code: 'NI', name: 'Nicaragua', currency: 'NIO', region: 'North America', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'PA', name: 'Panama', currency: 'PAB', region: 'North America', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'KN', name: 'Saint Kitts and Nevis', currency: 'XCD', region: 'North America', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'LC', name: 'Saint Lucia', currency: 'XCD', region: 'North America', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'VC', name: 'Saint Vincent and the Grenadines', currency: 'XCD', region: 'North America', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'TT', name: 'Trinidad and Tobago', currency: 'TTD', region: 'North America', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'US', name: 'United States', currency: 'USD', region: 'North America', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: true, stripePreview: false, restricted: false },
  // --- South America -----------------------------------------------------
  { code: 'AR', name: 'Argentina', currency: 'ARS', region: 'South America', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'BO', name: 'Bolivia', currency: 'BOB', region: 'South America', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'BR', name: 'Brazil', currency: 'BRL', region: 'South America', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: true, stripePreview: false, restricted: false },
  { code: 'CL', name: 'Chile', currency: 'CLP', region: 'South America', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'CO', name: 'Colombia', currency: 'COP', region: 'South America', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'EC', name: 'Ecuador', currency: 'USD', region: 'South America', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'GY', name: 'Guyana', currency: 'GYD', region: 'South America', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'PY', name: 'Paraguay', currency: 'PYG', region: 'South America', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'PE', name: 'Peru', currency: 'PEN', region: 'South America', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'SR', name: 'Suriname', currency: 'SRD', region: 'South America', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'UY', name: 'Uruguay', currency: 'UYU', region: 'South America', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
  { code: 'VE', name: 'Venezuela', currency: 'VES', region: 'South America', flutterwaveLocal: false, momo: false, momoNetworks: [], flutterwavePayout: false, stripePayout: false, stripePreview: false, restricted: false },
]

/** Currencies with no minor unit — never render a decimal point. */
export const ZERO_DECIMAL_CURRENCIES: Currency[] = [
  'BIF',
  'CLP',
  'DJF',
  'GNF',
  'JPY',
  'KMF',
  'KRW',
  'MGA',
  'PYG',
  'RWF',
  'UGX',
  'VND',
  'VUV',
  'XAF',
  'XOF',
]

const BY_CODE = new Map(COUNTRIES.map((info) => [info.code, info]))

export function countryInfo(code: Country): CountryInfo {
  const info = BY_CODE.get(code)
  if (!info) throw new Error(`Unknown country: ${code}`)
  return info
}

export function countryName(code: Country): string {
  return BY_CODE.get(code)?.name ?? code
}

/** Grouped for a picker — a flat list of nearly 200 is unusable. */
export function countriesByRegion(): { region: string; countries: CountryInfo[] }[] {
  return REGIONS.map((region) => ({
    region,
    countries: COUNTRIES.filter((info) => info.region === region),
  })).filter((group) => group.countries.length > 0)
}

