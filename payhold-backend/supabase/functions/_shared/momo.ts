/**
 * Mobile money destinations: which wallet, and the number in the shape a rail
 * will accept.
 *
 * Two facts live here, and both were missing when the first live payout was
 * attempted. `FlutterwaveProvider.tokenize` sent
 * `account_bank: currency === 'RWF' ? 'MPS' : undefined` and a hardcoded
 * `beneficiary_name`, which meant every MoMo seller outside Rwanda — and every
 * bank seller anywhere — was registered against a beneficiary Flutterwave
 * refuses to transfer to. Nothing caught it because no test to date has made
 * a live transfer — they run against an intercepted `fetch` or PGlite.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE CODES BELOW ARE TRANSCRIBED FROM FLUTTERWAVE'S DOCUMENTATION AND ARE NOT
 * VERIFIED AGAINST A LIVE TRANSFER.
 *
 * `MOMO_UNVERIFIED` says so in one place, the same way `RAILS_VERIFIED` does in
 * `rails.ts`. A wrong code is a payout that fails at the rail with the money
 * already collected, so an unknown (country, network) pair **refuses** rather
 * than falling back to a plausible-looking default — the loud failure is the
 * feature. Check each corridor against Flutterwave's own docs and one sandbox
 * transfer before that market takes live money.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { PayHoldError, type Country } from './types.ts'

/** Flips only when every row below has survived a real transfer. */
export const MOMO_UNVERIFIED = true

export interface MomoNetwork {
  /**
   * What a seller recognises, and what the registry in `countries.ts` calls it.
   * This is what a client renders in a picker.
   */
  label: string
  /**
   * Flutterwave's own `account_bank` value for this wallet. `MPS` is their
   * generic mobile-payment-service code and is what several markets use
   * instead of naming a carrier.
   */
  code: string
}

/**
 * Country → the wallets Flutterwave can pay into there.
 *
 * The labels deliberately match `countries.ts`'s `momoNetworks`, because that
 * is the list a client already renders and two spellings of one wallet is a
 * seller picking the one that does not work. Where the two disagree the note
 * says why.
 */
export const MOMO_NETWORKS: Record<Country, MomoNetwork[]> = {
  // Flutterwave documents `MPS` and `MTN` for Rwanda. `MPS` is what the
  // original hardcoded RWF branch sent, so it is the one code here with any
  // live history at all.
  RW: [
    { label: 'MTN', code: 'MTN' },
    { label: 'Airtel Money', code: 'MPS' },
  ],
  // One wallet, and Flutterwave routes it through the generic code rather than
  // naming Safaricom.
  KE: [{ label: 'M-Pesa', code: 'MPS' }],
  UG: [
    { label: 'MTN', code: 'MTN' },
    { label: 'Airtel Money', code: 'AIRTEL' },
  ],
  // Telecel bought Vodafone Ghana and the registry uses the new name;
  // Flutterwave's code is still `VODAFONE`. Keeping the seller-facing label
  // current and the wire value as the rail expects it is the whole reason
  // these are two fields.
  GH: [
    { label: 'MTN', code: 'MTN' },
    { label: 'Telecel', code: 'VODAFONE' },
    { label: 'AirtelTigo', code: 'AIRTELTIGO' },
  ],
  // `VODACOM` is M-Pesa Tanzania. It is absent from the registry's list and
  // present in Flutterwave's, and a seller on it would otherwise have no way
  // to be paid.
  TZ: [
    { label: 'Airtel Money', code: 'AIRTEL' },
    { label: 'Tigo Pesa', code: 'TIGO' },
    { label: 'HaloPesa', code: 'HALOPESA' },
    { label: 'M-Pesa', code: 'VODACOM' },
  ],
  // Flutterwave documents only the generic code here, so all three wallets go
  // out the same way.
  ZM: [
    { label: 'MTN', code: 'MPS' },
    { label: 'Airtel Money', code: 'MPS' },
    { label: 'Zamtel', code: 'MPS' },
  ],
  CM: [
    { label: 'MTN', code: 'MTN' },
    { label: 'Orange Money', code: 'ORANGEMONEY' },
  ],
  // Transfers only. Flutterwave's transfer table names Amole Money for
  // Ethiopia and there is no v3 collection page behind it, which is why the
  // registry marks ET `momoPayout` without `momo`.
  ET: [{ label: 'Amole Money', code: 'AMOLEMONEY' }],
  // Flutterwave's own supported-networks table omits Malawi, and that omission
  // is what kept the registry saying "networks not named" — but both doc trees
  // carry an un-gated MWK mobile money payout sample naming `AIRTELMW`
  // (bank_name "Airtel Malawi"). The table is stale, not the corridor. The
  // *collection* code for the same wallet is plain `AIRTEL`; they are different
  // strings for the same operator and only the payout one belongs here.
  MW: [{ label: 'Airtel Money', code: 'AIRTELMW' }],
  CI: [
    { label: 'MTN', code: 'MTN' },
    { label: 'Orange Money', code: 'ORANGE' },
    { label: 'Wave', code: 'WAVE' },
    { label: 'Moov', code: 'MOOV' },
  ],
  // The registry also lists Free Money, which Flutterwave does not document a
  // transfer code for. It is deliberately absent: offering it would register a
  // beneficiary nothing can send to.
  SN: [
    { label: 'Orange Money', code: 'ORANGEMONEY' },
    { label: 'Wave', code: 'WAVE' },
  ],
}

/**
 * International dialling prefixes, for the markets we can actually pay into.
 *
 * Kept here rather than in the generated registry because this is the only
 * thing that needs them, and `gen-countries.py` writes that file into two
 * repositories — a column nobody reads is a column that goes stale silently.
 */
const DIAL_CODE: Record<Country, string> = {
  RW: '250',
  KE: '254',
  UG: '256',
  TZ: '255',
  GH: '233',
  ZM: '260',
  CM: '237',
  CI: '225',
  SN: '221',
  NG: '234',
  ZA: '27',
  EG: '20',
  BF: '226',
  ET: '251',
  MW: '265',
  ML: '223',
}

/** The wallets a seller in this market can pick. Empty means none. */
export function momoNetworksFor(country: Country): MomoNetwork[] {
  return MOMO_NETWORKS[country.toUpperCase()] ?? []
}

/**
 * The `account_bank` value for one wallet in one market.
 *
 * Refuses rather than guessing. An unknown pair here means either a market we
 * have not mapped or a client sending a label from a stale build, and both
 * produce the same outcome if we send something plausible instead: a
 * beneficiary that looks registered and cannot be paid.
 */
export function momoBankCode(country: Country, network: string): string {
  const available = momoNetworksFor(country)

  if (available.length === 0) {
    throw new PayHoldError(
      'policy_violation',
      `PayHold cannot pay a mobile money wallet in ${country.toUpperCase()} yet`,
    )
  }

  const wanted = network.trim().toLowerCase()
  const match = available.find((n) => n.label.toLowerCase() === wanted) ??
    // Accept the wire code itself, so a client that stored `MTN` rather than
    // the label is not broken by a label being reworded.
    available.find((n) => n.code.toLowerCase() === wanted)

  if (!match) {
    throw new PayHoldError(
      'policy_violation',
      `"${network}" is not a mobile money network in ${country.toUpperCase()}. ` +
        `Available: ${available.map((n) => n.label).join(', ')}`,
    )
  }

  return match.code
}

/**
 * A mobile number in the shape a transfer API takes: digits only, led by the
 * country's dialling code.
 *
 * Every real-world spelling arrives here — `+250 788 123 456` is literally the
 * placeholder AutoHire's payout form shows — and Flutterwave wants
 * `250788123456`. Getting this wrong is not a validation nicety: the
 * beneficiary is created against whatever we send, and the failure surfaces
 * weeks later as a transfer to a number that does not exist.
 */
export function normalizeMsisdn(raw: string, country: Country): string {
  const dial = DIAL_CODE[country.toUpperCase()]
  if (!dial) {
    throw new PayHoldError(
      'policy_violation',
      `PayHold does not know the dialling code for ${country.toUpperCase()}`,
    )
  }

  const digits = raw.replace(/\D/g, '')
  if (digits.length < 6) {
    throw new PayHoldError('policy_violation', 'That does not look like a mobile number')
  }

  // Already international, in either of the two ways people write it: with the
  // dialling code, or with the code *and* a trunk zero after it.
  let national = digits.startsWith(dial) ? digits.slice(dial.length) : digits
  // A national trunk prefix — `0788…` — is not part of the international form.
  national = national.replace(/^0+/, '')

  if (national.length < 6 || national.length > 12) {
    throw new PayHoldError(
      'policy_violation',
      `That does not look like a mobile number in ${country.toUpperCase()}`,
    )
  }

  return `${dial}${national}`
}
