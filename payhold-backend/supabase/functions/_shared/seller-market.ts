/**
 * Which market a seller's destination is being registered in — and, the half
 * that was missing until 2026-09-10, where that answer came from.
 *
 * `POST /sellers/:id/destinations` and both Stripe Connect onboarding routes
 * let a client omit `country`, and each then falls back to `sellers.country`.
 * The fallback itself is right and stays: a seller moving from a wallet to a
 * bank account has not moved country, and a client made to restate it on every
 * call could restate it wrongly. What it costs is that the stored country is
 * the country of that seller's *first* destination and nothing refreshes it —
 * so a host who has since moved is judged in the market they left, and every
 * refusal names that market as though the request had asked for it. A US host
 * reading `paypal cannot pay a destination in RW. Paid in RWF via
 * Flutterwave…` has no way to get from there to the fix: nothing in the
 * sentence says RW was ours to supply, or that sending `country` is what
 * changes it.
 *
 * So the resolution and its provenance are one value, and
 * `defaultedCountryNote` is the sentence a refusal carries when the country was
 * ours rather than theirs. **Which country gets chosen is unchanged.** That
 * fallback is a client contract, and quietly resolving a different market would
 * trade a confusing refusal for a payout to the wrong place — the one failure
 * worse than the one being fixed here.
 *
 * The currency is resolved beside it and from the same source, deliberately.
 * A stated country brings its own currency with it because the pair has to
 * agree; a defaulted one brings the stored currency, which was written
 * alongside the stored country by the same statement (`sync_primary_destination`
 * writes country, currency and provider together) and so agrees with it. An
 * explicitly stated `payout_currency` still wins over both, because a non-local
 * payout currency is a real corridor rather than a mistake — `rails.ts` routes
 * `!wantsLocal && flutterwavePayout` on purpose.
 */

import { countryInfo } from './rails.ts'
import { PayHoldError } from './types.ts'

/** Whose answer the country is: the request's, or the seller's row. */
export type CountrySource = 'request' | 'seller'

export interface SellerMarket {
  country: string
  currency: string
  /** Read this before quoting the country back at anybody. */
  country_source: CountrySource
}

/** The two columns this reads, so a caller can select exactly them. */
export interface SellerMarketRow {
  country: string | null
  payout_currency: string | null
}

export interface SellerMarketInput {
  country?: string | null
  payout_currency?: string | null
}

/**
 * Resolve the market, or `null` when neither the request nor the row names a
 * country.
 *
 * `null` rather than a throw because the two callers say it differently — one
 * is registering a first destination, the other is starting Stripe onboarding
 * — and a shared sentence would name the wrong endpoint in one of them.
 *
 * **A blank `country` is refused, not treated as absent.** It is the single
 * input that could pair a stated country with a stored currency: `??` keeps
 * `''` as the country while every `body.country ? …` test reads it as missing,
 * so `{ country: '' }` on a Rwandan seller resolved to a country that is not a
 * country, priced in RWF, and went to `payoutRoute` like that. Refusing is also
 * what `?external_user_id=` already does with a blank value, and for the same
 * reason: a parameter that silently did nothing is worse than one that says so.
 */
export function resolveSellerMarket(
  body: SellerMarketInput,
  seller: SellerMarketRow,
): SellerMarket | null {
  const stated = blankRefused(
    body.country,
    'Please choose the country your payout account is in.',
  )
  const statedCurrency = blankRefused(
    body.payout_currency,
    'Please choose the currency you want to be paid in.',
  )

  if (stated) {
    return {
      country: stated,
      currency: statedCurrency ?? countryInfo(stated).currency,
      country_source: 'request',
    }
  }

  if (!seller.country) return null

  return {
    country: seller.country,
    // The stored currency, falling back to the stored country's own — a seller
    // can hold a country with no currency beside it only through rows written
    // before both columns moved together, and refusing them here would strand
    // a destination change on a fact the caller cannot supply.
    currency: statedCurrency ?? seller.payout_currency ?? countryInfo(seller.country).currency,
    country_source: 'seller',
  }
}

/**
 * Present and non-blank, or absent. Whitespace counts as blank — `required`
 * catches `''` and this catches `'  '`, which reaches `countryInfo` as an
 * unknown code and reads to the caller as though they had sent something.
 *
 * The value itself is passed through untrimmed: `' RW '` is still an unknown
 * country and still says so. Accepting it here would be a widening nobody
 * asked for, in the one place that decides where money goes.
 *
 * `ask` rather than the field name for the same reason `defaultedCountryNote`
 * is worded the way it is: an empty box on a host's payout screen arrives here
 * as a blank field, and `payout_currency cannot be blank` is our name for their
 * box. It reads as a refusal of something they did wrong, when what happened is
 * that a question was not answered yet.
 */
function blankRefused(
  value: string | null | undefined,
  ask: string,
): string | null {
  if (value === undefined || value === null) return null
  if (!value.trim()) {
    throw new PayHoldError('policy_violation', ask)
  }
  return value
}

/**
 * The sentence that makes a refusal actionable when the country was ours.
 *
 * **This is read by a car owner, not by the developer who called the API.** A
 * tenant's app puts our `message` straight into a toast on the host's own payout
 * screen — that is how the sentence this whole file exists for reached somebody:
 * `paypal cannot pay a destination in RW`, unedited, on the screen of a host
 * whose profile says the United States. So the rule for the wording is name the
 * fact, then name the thing they can do about it, and nothing else: a host has
 * never seen the call their app made, does not know what a record or a field is,
 * and cannot act on either. It also must not read as their mistake. A country of
 * ours that has gone out of date is our state, not something they typed wrong.
 */
export function defaultedCountryNote(market: SellerMarket): string {
  return `We still have ${countryLabel(market.country)} as your payout country. ` +
    `If you have moved, update your payout country on your payout screen and try again.`
}

/**
 * Add that sentence to a refusal raised while the defaulted country was being
 * checked, and leave every other failure exactly as it was.
 *
 * A wrapper rather than a parameter threaded through `rail-adapter.ts` because
 * the sentences being extended are `payoutRoute`'s and `route_payout`'s own,
 * shared verbatim with the Earnings screen and the routing table — one fact,
 * one sentence, and provenance is a fact about *this request* rather than about
 * the corridor. Non-`PayHoldError` throws pass through untouched: they are
 * bugs or provider failures, `handler` replaces their text anyway, and a note
 * about a country would be noise on top of a 500.
 */
export function withCountryProvenance(err: unknown, market: SellerMarket): unknown {
  if (market.country_source !== 'seller') return err
  if (!(err instanceof PayHoldError)) return err
  return new PayHoldError(err.code, `${err.message} ${defaultedCountryNote(market)}`)
}

/**
 * `Rwanda`, not `RW` — a two-letter code is our shorthand and means nothing on
 * a host's screen. The code is the fallback rather than the first choice, and
 * only for a country the registry has no name for, where saying `RW` is still
 * better than a sentence with a hole in it.
 *
 * The article comes with it, because these names only ever appear inside a
 * sentence: *we still have United States as your payout country* is the kind of
 * wrong that makes a message look machine-written, on the one screen where a
 * host is deciding whether to trust us with where their money goes. The rule is
 * the four shapes English puts a `the` in front of — a plural, an `…Islands`, a
 * `…Republic`, and the `United …`s — plus the handful of singulars that take
 * one anyway. Every name is checked against the registry's own list; the
 * generator is what adds to it, so this stays a rule rather than a second copy.
 */
const THE_ANYWAY = new Set(['Bahamas', 'Gambia', 'Netherlands', 'Philippines', 'Maldives'])

export function countryLabel(country: string): string {
  let name: string
  try {
    name = countryInfo(country).name
  } catch {
    // No name to article-ise, and `the ZZ` would be worse than `ZZ`.
    return country
  }

  const takesThe = name.startsWith('United ') ||
    name.endsWith(' Islands') ||
    name.endsWith(' Republic') ||
    name.startsWith('DR ') ||
    THE_ANYWAY.has(name)

  return takesThe ? `the ${name}` : name
}
