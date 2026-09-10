import { assertEquals, assertStringIncludes, assertThrows } from 'jsr:@std/assert@1'
import {
  countryLabel,
  defaultedCountryNote,
  resolveSellerMarket,
  withCountryProvenance,
} from './seller-market.ts'
import { PayHoldError } from './types.ts'

/**
 * The seller this file exists for: registered years ago against a Rwandan
 * mobile money wallet, since moved to the United States, and asking to be paid
 * somewhere else. Their row still says RW/RWF and nothing refreshes it.
 */
const MOVED = { country: 'RW', payout_currency: 'RWF' }

Deno.test('country omitted — the stored pair is used, unchanged, and says it was ours', () => {
  // The fallback is a client contract and this is the assertion that it did
  // not quietly change: a call with no `country` still resolves RW/RWF, exactly
  // as before. Only `country_source` is new.
  assertEquals(resolveSellerMarket({}, MOVED), {
    country: 'RW',
    currency: 'RWF',
    country_source: 'seller',
  })
})

Deno.test('country stated — its own currency comes with it, never the stored one', () => {
  // `country: US` with `currency: RWF` is the pair that produced the report
  // this was traced from: a US destination priced in RWF routes on a corridor
  // the destination is not in. A stated country brings its own currency.
  assertEquals(resolveSellerMarket({ country: 'US' }, MOVED), {
    country: 'US',
    currency: 'USD',
    country_source: 'request',
  })
})

Deno.test('a blank country is refused, not read as absent', () => {
  // The one input that could pair a stated country with a stored currency:
  // `??` keeps `''` as the country while `body.country ? …` reads it as
  // missing, so this resolved to a country that is not a country, priced in
  // RWF. Refused on both spellings of blank — `required` catches `''` and this
  // has to catch `'  '` too.
  //
  // The wording is pinned as well as the refusal: a blank field is an empty box
  // on a host's payout screen, and `country cannot be blank` is our name for
  // their box, phrased as though they had broken something.
  for (const country of ['', '   ']) {
    assertThrows(
      () => resolveSellerMarket({ country }, MOVED),
      PayHoldError,
      'Please choose the country your payout account is in.',
    )
  }
})

Deno.test('a blank payout_currency is refused for the same reason', () => {
  assertThrows(
    () => resolveSellerMarket({ payout_currency: ' ' }, MOVED),
    PayHoldError,
    'Please choose the currency you want to be paid in.',
  )
})

Deno.test('a stated currency still wins — a non-local payout currency is a real corridor', () => {
  // `rails.ts` routes `!wantsLocal && flutterwavePayout` deliberately, so this
  // must stay possible; refusing it here would close a corridor from the wrong
  // end.
  assertEquals(resolveSellerMarket({ country: 'RW', payout_currency: 'USD' }, MOVED), {
    country: 'RW',
    currency: 'USD',
    country_source: 'request',
  })
})

Deno.test('a stored country with no stored currency falls back to that country\'s own', () => {
  // Not reachable through today's writers — `sync_primary_destination` writes
  // country and currency in one statement — but the column is nullable, and the
  // alternative was handing `undefined` to `payoutRoute` as a currency.
  assertEquals(resolveSellerMarket({}, { country: 'RW', payout_currency: null }), {
    country: 'RW',
    currency: 'RWF',
    country_source: 'seller',
  })
})

Deno.test('no country anywhere is null, for the caller to phrase', () => {
  // A seller registered with no destination at all. The two callers say this
  // differently — a first destination, or starting Stripe onboarding — and a
  // shared sentence would name the wrong endpoint in one of them.
  assertEquals(resolveSellerMarket({}, { country: null, payout_currency: null }), null)
})

Deno.test('a defaulted country says which country we hold, and what to do about it', () => {
  const market = resolveSellerMarket({}, MOVED)!
  // `assertRailOnRoute`'s sentence as it now reads. It was
  // `paypal cannot pay a destination in RW.` on the day a host was shown it,
  // and both halves of that were fixed in the same change: the rail's own name
  // and the country's, here, and where the country came from, below.
  const refused = withCountryProvenance(
    new PayHoldError(
      'policy_violation',
      'PayPal payouts are not available in Rwanda. Paid in RWF via Flutterwave, ' +
        'to a mobile money wallet or bank account in Rwanda. Choose one of the ' +
        'other payout methods offered for Rwanda.',
    ),
    market,
  ) as PayHoldError

  // Whatever the refusal said is kept verbatim — this only adds to it.
  assertStringIncludes(refused.message, 'PayPal payouts are not available in Rwanda.')

  // This message is shown to a car owner, unedited, by the tenant's own app.
  // So: the country by name, ours rather than theirs, and the one thing they
  // can do — and none of the machinery. A host has not seen the call their app
  // made, does not know what a record or a field is, and did not do anything
  // wrong by having moved.
  assertStringIncludes(refused.message, 'We still have Rwanda as your payout country.')
  assertStringIncludes(
    refused.message,
    'If you have moved, update your payout country and try again.',
  )
  for (const jargon of ['record', 'field', 'request', 'seller', 'country"', 'RW,']) {
    assertEquals(
      refused.message.slice(refused.message.indexOf('We still have')).includes(jargon),
      false,
      `the note should not say "${jargon}": ${refused.message}`,
    )
  }
  assertEquals(refused.code, 'policy_violation')
})

Deno.test('a stated country adds nothing — the caller already knows what they sent', () => {
  const market = resolveSellerMarket({ country: 'US' }, MOVED)!
  const original = new PayHoldError('policy_violation', 'paypal cannot pay a destination in US.')
  assertEquals(withCountryProvenance(original, market), original)
})

Deno.test('a non-PayHoldError passes through untouched', () => {
  // A provider timeout or a bug reaches `handler`, which replaces its text
  // wholesale. A note about a country would be noise on a 500 — and rewrapping
  // it would lose the stack.
  const market = resolveSellerMarket({}, MOVED)!
  const boom = new Error('fetch failed')
  assertEquals(withCountryProvenance(boom, market), boom)
})

Deno.test('the country is named, not coded', () => {
  // `RW` is our shorthand. On a host's screen it is two letters they have to
  // decode before they can act, and the decoding is the whole difficulty this
  // message exists to remove.
  const note = defaultedCountryNote({ country: 'RW', currency: 'RWF', country_source: 'seller' })
  assertStringIncludes(note, 'Rwanda')
  assertEquals(note.includes('RW '), false, note)
})

Deno.test('names that take an article get one, and the rest do not', () => {
  // `We still have United States as your payout country` is the kind of wrong
  // that makes a sentence look machine-written, on the screen where a host is
  // deciding whether to trust us with where their money goes.
  assertEquals(countryLabel('US'), 'the United States')
  assertEquals(countryLabel('AE'), 'the United Arab Emirates')
  assertEquals(countryLabel('NL'), 'the Netherlands')
  assertEquals(countryLabel('CF'), 'the Central African Republic')
  assertEquals(countryLabel('RW'), 'Rwanda')
  assertEquals(countryLabel('KE'), 'Kenya')
  // Nothing to article-ise, and `the ZZ` would be worse than `ZZ`.
  assertEquals(countryLabel('ZZ'), 'ZZ')
})

Deno.test('the note survives a country the registry does not carry', () => {
  // A code stored before a registry regeneration would otherwise throw from
  // inside the sentence explaining the refusal, replacing a 422 a client can
  // act on with a 500 it cannot. The code is a worse label than a name and a
  // much better one than a sentence with a hole in it.
  const note = defaultedCountryNote({ country: 'ZZ', currency: 'USD', country_source: 'seller' })
  assertStringIncludes(note, 'ZZ')
  assertStringIncludes(note, 'update your payout country')
})

Deno.test('no refusal sends a host to the screen they are already on', () => {
  // Every one of these renders as a toast **on** the payout screen, so "update
  // your payout country on your payout screen" tells somebody to go where they
  // are standing. Same class of uselessness as naming an API path: true, and
  // not an instruction. PayHold owns the fact and the action; where to do it
  // belongs to whoever drew the screen, who can put the control a tap away.
  const note = defaultedCountryNote({ country: 'RW', currency: 'RWF', country_source: 'seller' })
  assertEquals(note.includes('payout screen'), false, note)
  assertEquals(note.includes('update your payout country'), true, note)
})
