/**
 * What we have actually checked about each rail, row by row.
 *
 * `rails.ts` is the registry: where money can go, transcribed from provider
 * documentation when the table was first written. `RAILS_VERIFIED` beside it is
 * a different and stronger claim — that a row has been checked against a signed
 * provider agreement and watched carry live money — and it is false for every
 * row, deliberately. Between "we typed this in once" and "we have a contract and
 * a settled transfer" there was nothing, so the screen printed one word,
 * Unverified, on all 489 rows, and a badge that says the same thing everywhere
 * is a badge nobody reads.
 *
 * This is the middle claim, and it is per row: on 2026-09-09 the payout and
 * mobile-money corridors were read against Stripe's and Flutterwave's published
 * documentation, one at a time, with the page cited. Three things can be true
 * of a row afterwards and they are kept apart, because the old binary collapsed
 * two of them into "Unverified":
 *
 *   documented   — the provider's own documentation supports the row as written
 *   unsupported  — the row was checked and the documentation does not support
 *                  it, or supports it only on terms this system does not meet
 *   unchecked    — nobody has looked yet; the row is still the original plan
 *
 * `unsupported` rows are kept in the registry on purpose. The registry says
 * what is *possible*; the routing table says what is *on*, and `payout_routes`
 * on the backend was pruned to the documented set the same day. A row marked
 * unsupported here and absent there is the two halves agreeing.
 *
 * None of this is the launch checklist. That gates live money per market and
 * is signed by a person; this records whether we believe our own table. Two
 * claims sharing the word "verified" is how both got misread, so this file does
 * not use the word.
 *
 * Keyed by direction, provider and country, optionally method. A row with no
 * entry is `unchecked` — which is the honest answer for every international
 * card row, since Stripe's and PayPal's per-country card acceptance was not
 * read per country.
 */

import type { Country, PaymentMethod, Provider } from '@/api/types'
import type { Rail } from './rails'

export type ProvenanceState = 'documented' | 'unsupported' | 'unchecked'
export type Direction = 'collect' | 'payout'

export interface ProvenanceRecord {
  state: ProvenanceState
  /** The page the claim was read against. Required for anything but `unchecked`. */
  source: string
  /** ISO date the page was read. */
  checked: string
  /** One sentence a person on the Rails screen can act on. */
  note?: string
}

/** What was read on 2026-09-09. */
export const PROVENANCE_CHECKED_ON = '2026-09-09'

const STRIPE_ACCOUNTS = 'https://docs.stripe.com/connect/accounts'
const STRIPE_CAPABILITIES = 'https://docs.stripe.com/connect/account-capabilities'
const STRIPE_UAE = 'https://support.stripe.com/questions/connect-availability-in-the-uae'
const FW_BANK = 'https://developer.flutterwave.com/v3.0/docs/bank-account'
const FW_MOMO_TRANSFERS = 'https://developer.flutterwave.com/v3.0/docs/mobile-money'
const FW_MOMO_COLLECT = 'https://developer.flutterwave.com/v3.0/docs/mobile-money-1'
const FW_FRANCO = 'https://developer.flutterwave.com/v3.0/docs/francophone'
const FW_MALAWI = 'https://developer.flutterwave.com/v3.0/docs/malawi-bank-account-transfers-1'
const FW_SIERRA_LEONE = 'https://developer.flutterwave.com/v3.0/docs/sierra-leone'
const FW_EGYPT = 'https://developer.flutterwave.com/v3.0/docs/egypt-2'
const FW_MW_SUPPORT = 'https://flutterwave.com/mw/support/payment-methods/pay-with-mobile-money'

const D = PROVENANCE_CHECKED_ON
const doc = (source: string, note?: string): ProvenanceRecord =>
  ({ state: 'documented', source, checked: D, ...(note ? { note } : {}) })
const no = (source: string, note: string): ProvenanceRecord =>
  ({ state: 'unsupported', source, checked: D, note })

function keyOf(direction: Direction, provider: Provider, country: Country, method?: PaymentMethod): string {
  return method ? `${direction}:${provider}:${country}:${method}` : `${direction}:${provider}:${country}`
}

function many(
  direction: Direction,
  provider: Provider,
  countries: readonly string[],
  record: ProvenanceRecord,
  method?: PaymentMethod,
): Record<string, ProvenanceRecord> {
  const out: Record<string, ProvenanceRecord> = {}
  for (const c of countries) out[keyOf(direction, provider, c as Country, method)] = record
  return out
}

export const PROVENANCE: Record<string, ProvenanceRecord> = {
  // --- Stripe Connect payouts -------------------------------------------------
  // On the Express/Custom availability list, and inside the region where Stripe
  // allows self-serve cross-border transfers (US, CA, UK, EEA, CH).
  ...many('payout', 'stripe', [
    'US', 'GB', 'CA', 'CH',
    'DE', 'FR', 'NL', 'IE', 'ES', 'IT', 'AT', 'BE', 'CY', 'EE', 'FI', 'GR', 'LT', 'LU', 'LV', 'MT', 'PT', 'SI', 'SK',
  ], doc(STRIPE_ACCOUNTS, 'On Stripe’s Express/Custom list and inside its self-serve cross-border region.')),
  ...many('payout', 'stripe', ['HR', 'LI', 'BR'],
    no(STRIPE_ACCOUNTS, 'Not on Stripe’s Express/Custom availability list; PayHold creates Express accounts.')),
  ...many('payout', 'stripe', ['JP', 'SG', 'MX', 'AU'],
    no(STRIPE_CAPABILITIES, 'Outside Stripe’s self-serve cross-border region — the platform account would have to be in this country.')),
  [keyOf('payout', 'stripe', 'AE')]:
    no(STRIPE_UAE, 'Outside the self-serve region, and Stripe onboards only licensed businesses in the UAE — no individuals.'),

  // --- Flutterwave bank transfers ----------------------------------------------
  ...many('payout', 'flutterwave', ['RW', 'KE', 'UG', 'TZ', 'GH', 'NG', 'ZA', 'ZM', 'CI', 'SN', 'CM', 'BF'],
    doc(FW_BANK, 'A Flutterwave transfer guide exists for this country.'), 'bank_transfer'),
  ...many('payout', 'flutterwave', ['BJ', 'CF', 'CG', 'GA', 'GQ', 'GW', 'ML', 'NE', 'TD', 'TG'],
    no(FW_BANK, 'No transfer guide; Flutterwave documents XOF for Côte d’Ivoire, Senegal and Burkina Faso only, XAF for Cameroon only.'), 'bank_transfer'),
  [keyOf('payout', 'flutterwave', 'MW', 'bank_transfer')]:
    no(FW_MALAWI, 'Documented as “not available by default — submit a request”.'),
  [keyOf('payout', 'flutterwave', 'SL', 'bank_transfer')]:
    no(FW_SIERRA_LEONE, 'Flutterwave documents transfers in SLL; PayHold’s currency and FX tables know only SLE.'),
  [keyOf('payout', 'flutterwave', 'EG', 'bank_transfer')]:
    no(FW_EGYPT, 'Documented as available only to IMTO merchants, on request.'),

  // --- Flutterwave mobile-money transfers ---------------------------------------
  ...many('payout', 'flutterwave', ['KE', 'UG', 'TZ', 'GH', 'CI', 'SN', 'CM'],
    doc(FW_MOMO_TRANSFERS, 'Network codes are listed verbatim in Flutterwave’s supported-networks table.'), 'mobile_money'),
  [keyOf('payout', 'flutterwave', 'RW', 'mobile_money')]:
    doc(FW_MOMO_TRANSFERS, 'MTN is documented. Airtel Money → MPS is PayHold’s inference; the table lists MPS without naming its operator.'),
  [keyOf('payout', 'flutterwave', 'ZM', 'mobile_money')]:
    doc(FW_MOMO_TRANSFERS, 'MPS is documented as the only Zambian code; which operators it reaches is PayHold’s inference.'),
  ...many('payout', 'flutterwave', ['BF', 'MW'],
    no(FW_MOMO_TRANSFERS, 'No network codes in Flutterwave’s transfer table; a wallet here could not be registered.'), 'mobile_money'),

  // --- Flutterwave mobile-money collection -------------------------------------
  ...many('collect', 'flutterwave', ['RW', 'KE', 'UG', 'TZ', 'GH', 'ZM', 'CI', 'SN', 'CM'],
    doc(FW_MOMO_COLLECT, 'A v3 charge type is documented for this country.'), 'mobile_money'),
  [keyOf('collect', 'flutterwave', 'BF', 'mobile_money')]:
    doc(FW_FRANCO, 'Collection documented on the francophone page (Orange Money needs a USSD authorization code).'),
  [keyOf('collect', 'flutterwave', 'MW', 'mobile_money')]:
    no(FW_MW_SUPPORT, 'No v3 collection page for Malawi, and the help centre’s mobile-money list omits it.'),
}

const UNCHECKED: ProvenanceRecord = { state: 'unchecked', source: '', checked: '' }

/**
 * The row's provenance for one direction. Method-specific entries win over
 * country-wide ones; a row nobody has looked at is `unchecked`.
 */
export function provenanceFor(rail: Rail, direction: Direction): ProvenanceRecord {
  return PROVENANCE[keyOf(direction, rail.provider, rail.country, rail.method)] ??
    PROVENANCE[keyOf(direction, rail.provider, rail.country)] ??
    UNCHECKED
}

export const PROVENANCE_LABEL: Record<ProvenanceState, string> = {
  documented: 'Documented',
  unsupported: 'Not supported',
  unchecked: 'Unchecked',
}
