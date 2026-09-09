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
 * This is the middle claim, and it is per row. On 2026-09-09 every provider and
 * every direction was read against the provider's own published page — the
 * Flutterwave transfer guides country by country, its mobile-money transfer
 * table, its collection channel list and per-country collection pages, Stripe's
 * cross-border-payout and currency pages, and PayPal's country-feature table —
 * and each row was given one of three states, kept apart because the old binary
 * collapsed two of them into "Unverified":
 *
 *   documented   — the provider's own documentation supports the row as written
 *   unsupported  — the row was checked and the documentation does not support
 *                  it, or supports it only on terms this system does not meet
 *   unchecked    — nobody has looked yet; the row is still the original plan
 *
 * After that reading the only `unchecked` rows are PayPal collection in markets
 * outside PayPal's Payouts recipient table (see `PROVENANCE_UNCHECKED_NOTES`).
 * Any other unchecked row means the registry gained a row after the pages were
 * read, and the answer is to read the page, not to relabel the row.
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
 * Two tables, deliberately. `PROVENANCE_CLAIMS` is everything that was read,
 * keyed by direction, provider and country, optionally method — including
 * claims about rows the registry does not currently build (a Flutterwave card
 * row for Benin, say, which `countries.ts` may drop on its next regeneration).
 * `PROVENANCE` is the same table pruned to keys that name a row `RAILS`
 * actually contains, so the screen and its tests only ever see claims about
 * rows that exist, and a claim recorded ahead of a registry change is kept
 * rather than lost. `provenanceFor` reads the pruned one.
 *
 * Three honesty notes on the documented claims, because "documented" is doing
 * different amounts of work in different sections:
 *
 *   - Stripe card collection is documented country-wide from Stripe's currency
 *     and global pages: card acquiring is by the *merchant's* account, and Stripe
 *     processes internationally issued cards. Stripe does not publish a
 *     per-cardholder-country list, so the claim is exactly that and no more.
 *   - PayPal wallet rows were read against PayPal's Payouts country-feature
 *     table, which is the one PayPal country page a fetch can read (the
 *     consumer availability page is script-rendered). It lists the markets
 *     where a PayPal account can send, receive and withdraw. A market absent
 *     from it stays `unchecked`, with a note saying why: that table is the
 *     Payouts product's recipient list, and a buyer's ability to pay is a
 *     different question its absence does not answer.
 *   - Where Flutterwave documents a corridor but only "on request" or only
 *     with fields PayHold does not collect, the row is `unsupported`, and the
 *     note says which — that is the sentence a person can act on.
 */

import type { Country, PaymentMethod, Provider } from '@/api/types'
import { COUNTRIES, RAILS, type Rail } from './rails'

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

// --- Pages -------------------------------------------------------------------

const FW_DOCS = 'https://developer.flutterwave.com/v3.0.0/docs/'
const fw = (slug: string) => FW_DOCS + slug
const FW_BANK = fw('bank-account')
const FW_MOMO_TRANSFERS = fw('mobile-money')
const FW_MOMO_COLLECT = fw('mobile-money-1')
const FW_FRANCO = fw('francophone')
const FW_MPESA_COLLECT = fw('m-pesa')
const FW_ZAMBIA_COLLECT = fw('zambia-mobile-money')
const FW_BANK_COLLECT = fw('bank-transfer-1')
const FW_PAYMENT_METHODS = fw('payment-methods')
const FW_CHANNELS = 'https://flutterwave.com/gb/support/payment-methods/payment-channels'

const STRIPE_CROSS_BORDER = 'https://docs.stripe.com/connect/cross-border-payouts'
const STRIPE_EXPRESS = 'https://docs.stripe.com/connect/express-accounts'
const STRIPE_CURRENCIES = 'https://docs.stripe.com/currencies'
const STRIPE_GLOBAL = 'https://stripe.com/global'

const PAYPAL_COUNTRIES = 'https://developer.paypal.com/docs/payouts/standard/reference/country-feature/'
const PAYPAL_CURRENCIES = 'https://developer.paypal.com/api/rest/reference/currency-codes/'

/**
 * Flutterwave's per-country bank-transfer guides. This is the complete list —
 * there is no guide for any other African country, which is itself a finding.
 */
const FW_BANK_GUIDE: Partial<Record<Country, string>> = {
  BF: 'burkina-faso',
  CM: 'cameroon',
  CI: 'c%C3%B4te-divoire',
  SN: 'senegal',
  GH: 'ghana-2',
  UG: 'uganda-2',
  ZM: 'zambia-1',
  RW: 'rwanda-1',
  NG: 'nigerian-bank-account-transfer',
  ET: 'ethiopian-bank-account-transfers',
  ZA: 'south-africa-1',
  TZ: 'tanzanian-bank-account-transfers',
  KE: 'kenya-1',
  MW: 'malawi-bank-account-transfers-1',
  EG: 'egypt',
  SL: 'sierra-leone',
}
const fwBankGuide = (c: Country) => fw(FW_BANK_GUIDE[c]!)

// --- Helpers -----------------------------------------------------------------

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

/** One record per country, from a function of the country. */
function each(
  direction: Direction,
  provider: Provider,
  countries: readonly string[],
  record: (c: Country) => ProvenanceRecord,
  method?: PaymentMethod,
): Record<string, ProvenanceRecord> {
  const out: Record<string, ProvenanceRecord> = {}
  for (const c of countries) out[keyOf(direction, provider, c as Country, method)] = record(c as Country)
  return out
}

const AFRICAN = COUNTRIES.filter((c) => c.region.endsWith('Africa')).map((c) => c.code)
const MOMO = COUNTRIES.filter((c) => c.momo).map((c) => c.code)
const FW_LOCAL = COUNTRIES.filter((c) => c.flutterwaveLocal).map((c) => c.code)
const UNRESTRICTED = COUNTRIES.filter((c) => !c.restricted).map((c) => c.code)
const without = (all: readonly string[], named: readonly string[]) => all.filter((c) => !named.includes(c))

// --- Stripe Connect payouts ------------------------------------------------
//
// Inside Stripe's self-serve cross-border region — US, UK, EEA, Canada,
// Switzerland — a platform in any of those can transfer to a full-agreement
// connected account in any other. Outside it, the platform account would have
// to be in the recipient's own country.
//
// HR and LI used to be marked "not on Stripe's Express list". That was wrong:
// Stripe's platform-country endpoint lists both with a full service agreement,
// and both are EEA, so they are documented on the same terms as the rest of
// the region.
const STRIPE_IN_REGION = [
  'US', 'CA', 'GB', 'CH',
  'AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'HU', 'IE', 'IT',
  'LI', 'LT', 'LU', 'LV', 'MT', 'NL', 'NO', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK',
]
const STRIPE_OUT_OF_REGION = ['AU', 'BR', 'GI', 'HK', 'JP', 'MX', 'MY', 'NZ', 'SG', 'TH']

// --- Flutterwave bank-transfer payouts -------------------------------------

const FW_BANK_DOCUMENTED_NOTE: Partial<Record<Country, string>> = {
  RW: 'Transfer guide exists; account_bank, account_number, amount, currency and beneficiary_name are enough.',
  NG: 'Transfer guide exists for NGN; USD domiciliary transfers are marked “currently unavailable”.',
  ET: 'Transfer guide exists for ETB with no extra fields — new since the table was first written.',
  CI: 'Transfer guide exists; destination_branch_code is optional.',
  SN: 'Transfer guide exists; destination_branch_code is optional.',
  BF: 'Transfer guide exists; its example sends destination_branch_code, which varies by bank — plumb it before launch.',
  CM: 'Transfer guide exists; its example sends destination_branch_code, which varies by bank — plumb it before launch.',
  GH: 'Transfer guide exists; destination_branch_code is “required for banks that have branches” — plumb it before launch.',
  UG: 'Transfer guide exists; its example sends destination_branch_code, which varies by bank — plumb it before launch.',
  ZM: 'Transfer guide exists; its example sends destination_branch_code, which varies by bank — plumb it before launch.',
}
const FW_BANK_DOCUMENTED = Object.keys(FW_BANK_DOCUMENTED_NOTE)

const FW_BANK_UNSUPPORTED_NOTE: Partial<Record<Country, string>> = {
  KE: 'Documented as “not available by default — submit a request”; also needs sender_id_number and sender_id_type in meta.',
  TZ: 'Documented as “only available to businesses registered in Tanzania”, with sender, sender_country and sender_address in meta.',
  EG: 'Documented as “not available by default — submit a request”, for Class A/B merchants with extensive meta.',
  MW: 'Documented as “not available by default — submit a request”; destination_branch_code is required.',
  SL: 'Flutterwave documents transfers in SLL; PayHold’s currency and FX tables know only SLE.',
  ZA: 'Documented, but requires meta first_name, last_name, email, mobile_number and recipient_address, which PayHold does not collect — a transfer as sent today would fail.',
}
const FW_BANK_UNSUPPORTED = Object.keys(FW_BANK_UNSUPPORTED_NOTE)

// --- Flutterwave mobile-money payouts --------------------------------------

const FW_MOMO_PAYOUT_NOTE: Partial<Record<Country, string>> = {
  CM: 'Codes MTN and ORANGEMONEY are listed verbatim in Flutterwave’s supported-networks table.',
  CI: 'Codes MOOV, MTN, ORANGE and WAVE are listed verbatim in Flutterwave’s supported-networks table.',
  ET: 'Code AMOLEMONEY (Amole Money) is listed verbatim in Flutterwave’s supported-networks table.',
  GH: 'Codes AIRTELTIGO and MTN are listed; Telecel is named as an operator but its code is not shown in the table.',
  KE: 'M-Pesa code MPS is listed; requires sender, sender_country and mobile_number (plus first_name and last_name) in meta, and Flutterwave asks that the feature be requested on the account.',
  RW: 'Codes MPS and MTN are listed; Flutterwave does not name the operator behind MPS — Airtel Money is PayHold’s inference.',
  SN: 'Codes ORANGEMONEY and WAVE are listed verbatim in Flutterwave’s supported-networks table.',
  TZ: 'Codes AIRTEL, HALOPESA, TIGO and VODACOM are listed; Flutterwave asks that the feature be requested via support, with sender_id_type and sender_id_number in meta.',
  UG: 'Codes AIRTEL and MTN are listed verbatim in Flutterwave’s supported-networks table.',
  ZM: 'Code MPS is listed as “M-Pesa”; which operators it reaches is PayHold’s inference.',
}
const FW_MOMO_PAYOUT_DOCUMENTED = Object.keys(FW_MOMO_PAYOUT_NOTE)

// --- Flutterwave collection ------------------------------------------------

const FW_CARD_NOTE: Partial<Record<Country, string>> = {
  NG: 'Listed as a card market (NGN) on Flutterwave’s payment-channels table and v3 payment-methods page.',
  GH: 'Listed as a card market (GHS) on Flutterwave’s payment-channels table and v3 payment-methods page.',
  KE: 'Listed as a card market (KES) on Flutterwave’s payment-channels table and v3 payment-methods page.',
  UG: 'Listed as a card market (UGX) on Flutterwave’s payment-channels table and v3 payment-methods page.',
  RW: 'Listed as a card market (RWF) on Flutterwave’s payment-channels table and v3 payment-methods page.',
  TZ: 'Listed as a card market (TZS) on Flutterwave’s payment-channels table and v3 payment-methods page.',
  ZA: 'Listed as a card market (ZAR) on Flutterwave’s payment-channels table and v3 payment-methods page.',
  MW: 'Listed as a card market (MWK) on Flutterwave’s payment-channels table and v3 payment-methods page.',
  EG: 'Listed as a card market (EGP) on Flutterwave’s payment-channels table and v3 payment-methods page.',
  BF: 'Card is listed for the XOF (West Africa) market; Burkina Faso is one of the three XOF countries Flutterwave names.',
  CI: 'Card is listed for the XOF (West Africa) market; Côte d’Ivoire is one of the three XOF countries Flutterwave names.',
  SN: 'Card is listed for the XOF (West Africa) market; Senegal is one of the three XOF countries Flutterwave names.',
  CM: 'Card is listed for the XAF (Central Africa) market; Cameroon is the only XAF country Flutterwave names.',
}
const FW_CARD_DOCUMENTED = Object.keys(FW_CARD_NOTE)

const FW_MOMO_COLLECT_RECORD: Partial<Record<Country, ProvenanceRecord>> = {
  RW: doc(FW_MOMO_COLLECT, 'A Rwanda collection page is linked from Flutterwave’s mobile-money index (charge type mobile_money_rwanda).'),
  GH: doc(FW_MOMO_COLLECT, 'A Ghana collection page is linked from Flutterwave’s mobile-money index (charge type mobile_money_ghana).'),
  UG: doc(FW_MOMO_COLLECT, 'A Uganda collection page is linked from Flutterwave’s mobile-money index (charge type mobile_money_uganda).'),
  TZ: doc(FW_MOMO_COLLECT, 'A Tanzania collection page is linked from Flutterwave’s mobile-money index (charge type mobile_money_tanzania).'),
  KE: doc(FW_MPESA_COLLECT, 'M-Pesa collection in KES is documented; test mode auto-authorises.'),
  ZM: doc(FW_ZAMBIA_COLLECT, 'Charge type mobile_money_zambia is documented; non-Zambian merchants must request the feature on their account.'),
  BF: doc(FW_FRANCO, 'Orange Money and Mobicash are named on the francophone page; Orange Burkina Faso needs a USSD authorization code.'),
  CI: doc(FW_FRANCO, 'MTN, Orange Money, Moov and Wave are named on the francophone page.'),
  SN: doc(FW_FRANCO, 'Orange Money and Wave are named on the francophone page.'),
  CM: doc(FW_FRANCO, 'MTN and Orange Money are named on the francophone page.'),
  MW: no(FW_MOMO_COLLECT, 'No collection page for Malawi; the entry is commented out in Flutterwave’s own mobile-money index.'),
  ET: no(FW_MOMO_COLLECT, 'Flutterwave documents no Ethiopian mobile-money collection channel; Amole Money appears on the transfers side only.'),
}

// --- PayPal ------------------------------------------------------------------
//
// PayPal's Payouts country-feature table, read 2026-09-09. Four tiers; a
// country absent from the table is absent from PayPal's published coverage.
// BM, KY, FO, GL and RE are on the table but not in the registry, so they are
// not listed here.
const PAYPAL_FULLY_LOCALIZED = [
  'AU', 'AT', 'BE', 'BR', 'CA', 'CN', 'DK', 'FR', 'DE', 'HK', 'IL', 'IT', 'JP', 'NL', 'NO',
  'PL', 'PT', 'SG', 'ES', 'SE', 'CH', 'TR', 'GB', 'US',
]
const PAYPAL_LOCAL_CURRENCY = ['CY', 'CZ', 'EC', 'FI', 'GR', 'HU', 'LI', 'LU', 'MY', 'MT', 'NZ', 'PH', 'SM', 'SI']
const PAYPAL_SEND_RECEIVE_WITHDRAW = [
  'AD', 'AR', 'BS', 'BH', 'BW', 'BG', 'CL', 'CO', 'CR', 'HR', 'DO', 'SV', 'EE', 'GE', 'GI', 'GT',
  'HN', 'IS', 'ID', 'IE', 'JM', 'JO', 'KZ', 'KE', 'KW', 'LV', 'LS', 'LT', 'MU', 'MD', 'MC', 'MA',
  'MZ', 'NI', 'OM', 'PA', 'PE', 'QA', 'RO', 'SA', 'SN', 'RS', 'SK', 'ZA', 'AE', 'UY', 'VE', 'VN',
]
const PAYPAL_RECEIVE_WITHDRAW = ['IN', 'MX']
const PAYPAL_LISTED = [
  ...PAYPAL_FULLY_LOCALIZED, ...PAYPAL_LOCAL_CURRENCY, ...PAYPAL_SEND_RECEIVE_WITHDRAW, ...PAYPAL_RECEIVE_WITHDRAW,
]
const PAYPAL_FOOTNOTE: Partial<Record<Country, string>> = {
  BR: ' BRL is supported for in-country PayPal accounts only; a foreign recipient is converted automatically.',
  MY: ' MYR can be exchanged only between Malaysian users.',
  CO: ' PayPal limits this market to cross-border transactions.',
  MC: ' PayPal limits this market to cross-border transactions.',
  CN: ' Listed as “China (C2)” — the PayPal China Platform, with cross-border settlement in CNY.',
}
const paypalNote = (tier: string) => (c: Country) =>
  doc(PAYPAL_COUNTRIES, `Listed as “${tier}” on PayPal’s Payouts country table; USD and EUR are supported PayPal currencies.${PAYPAL_FOOTNOTE[c] ?? ''}`)

// --- The claims --------------------------------------------------------------

export const PROVENANCE_CLAIMS: Record<string, ProvenanceRecord> = {
  // --- Stripe Connect payouts -----------------------------------------------
  ...many('payout', 'stripe', STRIPE_IN_REGION,
    doc(STRIPE_CROSS_BORDER, 'Full service agreement; inside Stripe’s self-serve cross-border region (US, UK, EEA, CA, CH) — requires PayHold’s own Stripe account to be in that region.'), 'bank_transfer'),
  ...many('payout', 'stripe', STRIPE_OUT_OF_REGION,
    no(STRIPE_CROSS_BORDER, `Outside Stripe’s self-serve cross-border region — the platform account would have to be in this country (see also ${STRIPE_EXPRESS}).`), 'bank_transfer'),
  [keyOf('payout', 'stripe', 'AE', 'bank_transfer')]:
    no(STRIPE_CROSS_BORDER, `Outside Stripe’s self-serve cross-border region, and Stripe onboards licensed businesses only in the UAE — no individuals (see also ${STRIPE_EXPRESS}).`),

  // --- Flutterwave bank-transfer payouts ------------------------------------
  ...each('payout', 'flutterwave', FW_BANK_DOCUMENTED,
    (c) => doc(fwBankGuide(c), FW_BANK_DOCUMENTED_NOTE[c]), 'bank_transfer'),
  ...each('payout', 'flutterwave', FW_BANK_UNSUPPORTED,
    (c) => no(fwBankGuide(c), FW_BANK_UNSUPPORTED_NOTE[c]!), 'bank_transfer'),
  ...many('payout', 'flutterwave', without(AFRICAN, [...FW_BANK_DOCUMENTED, ...FW_BANK_UNSUPPORTED]),
    no(FW_BANK, 'No Flutterwave transfer guide exists for this country.'), 'bank_transfer'),

  // --- Flutterwave mobile-money payouts -------------------------------------
  ...each('payout', 'flutterwave', FW_MOMO_PAYOUT_DOCUMENTED,
    (c) => doc(FW_MOMO_TRANSFERS, FW_MOMO_PAYOUT_NOTE[c]), 'mobile_money'),
  ...many('payout', 'flutterwave', without([...MOMO, 'BF', 'MW'].filter((c, i, a) => a.indexOf(c) === i), FW_MOMO_PAYOUT_DOCUMENTED),
    no(FW_MOMO_TRANSFERS, 'No network codes for this country in Flutterwave’s transfer table; a wallet here could not be registered.'), 'mobile_money'),

  // --- Flutterwave card collection ------------------------------------------
  ...each('collect', 'flutterwave', FW_CARD_DOCUMENTED,
    (c) => doc(FW_CHANNELS, `${FW_CARD_NOTE[c]} (${FW_PAYMENT_METHODS})`), 'card'),
  [keyOf('collect', 'flutterwave', 'SL', 'card')]:
    no(FW_CHANNELS, 'SLL is on Flutterwave’s accepted-currency list, but Sierra Leone is not named on any collection channel page.'),
  ...many('collect', 'flutterwave', without(FW_LOCAL, [...FW_CARD_DOCUMENTED, 'SL']),
    no(FW_CHANNELS, 'Not named on Flutterwave’s channel list; the XOF and XAF markets it documents are Burkina Faso, Côte d’Ivoire, Senegal and Cameroon.'), 'card'),

  // --- Flutterwave mobile-money collection ----------------------------------
  ...each('collect', 'flutterwave', Object.keys(FW_MOMO_COLLECT_RECORD),
    (c) => FW_MOMO_COLLECT_RECORD[c]!, 'mobile_money'),
  ...many('collect', 'flutterwave', without(MOMO, Object.keys(FW_MOMO_COLLECT_RECORD)),
    no(FW_MOMO_COLLECT, 'No collection page for this country in Flutterwave’s mobile-money index.'), 'mobile_money'),

  // --- Flutterwave bank-transfer collection ---------------------------------
  ...many('collect', 'flutterwave', ['NG', 'GH'],
    doc(FW_BANK_COLLECT, 'Pay-by-bank-transfer collection is documented for NGN and GHS.'), 'bank_transfer'),
  ...many('collect', 'flutterwave', without(FW_LOCAL, ['NG', 'GH']),
    no(FW_BANK_COLLECT, 'Flutterwave documents bank-transfer collection for NGN and GHS only.'), 'bank_transfer'),

  // --- Stripe card collection -----------------------------------------------
  ...many('collect', 'stripe', UNRESTRICTED,
    doc(STRIPE_CURRENCIES, `Card acquiring is by the merchant’s account, not the cardholder’s country; Stripe processes internationally issued cards and charges in over 135 currencies (see also ${STRIPE_GLOBAL}). Sanctioned countries are excluded by PayHold.`), 'card'),

  // --- PayPal wallet collection ---------------------------------------------
  ...each('collect', 'paypal', PAYPAL_FULLY_LOCALIZED, paypalNote('Fully localized'), 'wallet'),
  ...each('collect', 'paypal', PAYPAL_LOCAL_CURRENCY, paypalNote('Send, receive, and withdraw in local currency'), 'wallet'),
  ...each('collect', 'paypal', PAYPAL_SEND_RECEIVE_WITHDRAW, paypalNote('Send, receive, and withdraw'), 'wallet'),
  ...many('collect', 'paypal', PAYPAL_RECEIVE_WITHDRAW,
    doc(PAYPAL_COUNTRIES, `Listed as “Receive and withdraw” only on PayPal’s Payouts country table — accounts here cannot initiate payouts; confirm a buyer here can pay a foreign merchant before launch (currencies: ${PAYPAL_CURRENCIES}).`), 'wallet'),
}

/**
 * Rows that were looked for and not found, with the reason — `unchecked` with
 * a sentence rather than `unsupported`, because the page that would settle
 * them could not be read and absence from a different product's table is not
 * a finding. Kept out of `PROVENANCE` so that table stays "every entry has a
 * page behind it"; `provenanceFor` reads this map after it.
 *
 * Today that is PayPal collection outside the Payouts recipient table. That
 * table is the PAYOUTS product's recipient list, not where a buyer can hold a
 * PayPal account and pay a merchant — Nigeria, Kenya and Rwanda, for instance,
 * have send-capable PayPal accounts and are absent from it. PayPal's
 * buyer-country page (paypal.com/…/country-worldwide) is script-rendered and
 * could not be read on 2026-09-09.
 */
export const PROVENANCE_UNCHECKED_NOTES: Record<string, ProvenanceRecord> = {
  ...many('collect', 'paypal', without(UNRESTRICTED, PAYPAL_LISTED), {
    state: 'unchecked',
    source: '',
    checked: D,
    note: 'PayPal’s buyer-country list (paypal.com/…/country-worldwide) is JS-rendered and could not be read; absent from the Payouts recipient table, which is a different product.',
  }, 'wallet'),
}

/** True when some row in the registry is what this key describes. */
function namesARow(key: string): boolean {
  const [direction, provider, country, method] = key.split(':')
  return RAILS.some((r) =>
    r.provider === provider && r.country === country &&
    (direction === 'collect' ? r.collect : r.payout) &&
    (method === undefined || r.method === method))
}

/**
 * The claims about rows the registry actually builds today. `countries.ts` is
 * generated and changes under this file; a claim about a row it no longer
 * builds stays in `PROVENANCE_CLAIMS` and drops out of here, so nothing on the
 * screen ever cites a row that does not exist.
 */
export const PROVENANCE: Record<string, ProvenanceRecord> = Object.fromEntries(
  Object.entries(PROVENANCE_CLAIMS).filter(([key]) => namesARow(key)),
)

const UNCHECKED: ProvenanceRecord = { state: 'unchecked', source: '', checked: '' }

/**
 * The row's provenance for one direction. Method-specific entries win over
 * country-wide ones; a row nobody has looked at is `unchecked`.
 */
export function provenanceFor(rail: Rail, direction: Direction): ProvenanceRecord {
  const exact = keyOf(direction, rail.provider, rail.country, rail.method)
  const wide = keyOf(direction, rail.provider, rail.country)
  return PROVENANCE[exact] ?? PROVENANCE[wide] ??
    PROVENANCE_UNCHECKED_NOTES[exact] ?? PROVENANCE_UNCHECKED_NOTES[wide] ??
    UNCHECKED
}

/** Every (row, direction) pair the registry builds, with its provenance. */
export function provenanceRows(): { rail: Rail; direction: Direction; record: ProvenanceRecord }[] {
  const out: { rail: Rail; direction: Direction; record: ProvenanceRecord }[] = []
  for (const rail of RAILS) {
    if (rail.collect) out.push({ rail, direction: 'collect', record: provenanceFor(rail, 'collect') })
    if (rail.payout) out.push({ rail, direction: 'payout', record: provenanceFor(rail, 'payout') })
  }
  return out
}

export const PROVENANCE_LABEL: Record<ProvenanceState, string> = {
  documented: 'Documented',
  unsupported: 'Not supported',
  unchecked: 'Unchecked',
}
