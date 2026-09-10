/**
 * Run with: deno test --allow-env supabase/functions/_shared/payment-options.test.ts
 *
 * The shaping behind `GET /payment-options`. The handler itself is a thin
 * wrapper around these, and needs a database and a caller to exercise; what
 * matters and what can be pinned here is that the answers are market-specific
 * rather than a single hardcoded list — which is the entire reason a client
 * asks instead of baking it in.
 */

import { assert, assertEquals } from 'jsr:@std/assert@1'
import {
  collectionRails,
  countryInfo,
  currenciesFor,
  METHOD_BLURB,
  METHOD_LABEL,
  payoutRoute,
  SCHEME_LABEL,
} from './rails.ts'
import { presentmentCurrencyFor } from './fx.ts'
import { type CoverageRow, payableCurrencies, payoutMethods, unavailableCurrencies } from './payout-methods.ts'
import type { CardScheme } from './rails.ts'
import { COUNTRIES } from './countries.ts'

Deno.test('Rwanda offers mobile money with named wallets', () => {
  const rails = collectionRails('RW', 'RWF')
  const momo = rails.find((r) => r.method === 'mobile_money')

  assert(momo, 'Rwanda should have a mobile money rail')
  assert(momo.networks.length > 0, 'the wallets should be named, not implied')
  assert(momo.networks.includes('MTN'))
})

Deno.test('Nigeria takes Verve, and nowhere else does', () => {
  const nigeria = collectionRails('NG', 'NGN').find((r) => r.method === 'card')
  assert(nigeria?.schemes?.includes('verve'), 'a Naira card rail should take Verve')

  // The reason this endpoint exists: a client that hardcoded Visa/Mastercard
  // would silently refuse a large share of Nigerian cards.
  const kenya = collectionRails('KE', 'KES').find((r) => r.method === 'card')
  assertEquals(kenya?.schemes?.includes('verve'), false)
})

Deno.test('the international card rail takes Amex, the local ones do not', () => {
  const international = collectionRails('RW', 'USD').find(
    (r) => r.method === 'card' && r.provider === 'stripe',
  )
  assert(international?.schemes?.includes('amex'))

  const local = collectionRails('RW', 'RWF').find(
    (r) => r.method === 'card' && r.provider === 'flutterwave',
  )
  assertEquals(local?.schemes?.includes('amex'), false)
})

Deno.test('every card rail names its schemes', () => {
  for (const country of ['RW', 'KE', 'NG', 'GH', 'US', 'IN']) {
    for (const currency of currenciesFor(country)) {
      for (const rail of collectionRails(country, currency)) {
        if (rail.method !== 'card') continue
        assert(
          rail.schemes && rail.schemes.length > 0,
          `${country}/${currency} has a card rail with no schemes`,
        )
      }
    }
  }
})

Deno.test('every scheme a rail names has a label to show a buyer', () => {
  const schemes = new Set<CardScheme>()
  for (const country of ['RW', 'KE', 'NG', 'US']) {
    for (const currency of currenciesFor(country)) {
      for (const rail of collectionRails(country, currency)) {
        for (const scheme of rail.schemes ?? []) schemes.add(scheme)
      }
    }
  }

  assert(schemes.size > 0)
  for (const scheme of schemes) {
    assert(SCHEME_LABEL[scheme], `${scheme} has no label`)
  }
})

Deno.test('every method has a label and a line a buyer can read', () => {
  for (const method of ['card', 'mobile_money', 'bank_transfer'] as const) {
    assert(METHOD_LABEL[method])
    assert(METHOD_BLURB[method])
    // Buyer-facing copy: no jargon, no status codes.
    assert(!METHOD_BLURB[method].includes('_'))
  }
})

Deno.test('an Indian buyer of a Rwandan deal is quoted in USD', () => {
  // The question a checkout actually asks: what will this person be charged?
  const payable = currenciesFor('IN')
  assertEquals(presentmentCurrencyFor(payable, 'RWF'), 'USD')

  // And their options are the ones that can take USD, not the Rwandan ones.
  const methods = collectionRails('IN', 'USD').map((r) => r.method)
  assert(methods.includes('card'))
  assertEquals(methods.includes('mobile_money'), false)
})

Deno.test('a Rwandan buyer of a Rwandan deal keeps their own currency', () => {
  assertEquals(presentmentCurrencyFor(currenciesFor('RW'), 'RWF'), 'RWF')
})

Deno.test('a market that can collect but not be paid says so both ways', () => {
  // Found from the registry rather than named: which corridors are open
  // changes with provider coverage, and a hardcoded example goes stale.
  const collectOnly = COUNTRIES.find(
    (info) => !info.restricted && payoutRoute(info.code, info.currency).blocked,
  )
  assert(collectOnly, 'expected at least one collect-only market')

  // A buyer there can pay — collection is near-universal.
  assert(collectionRails(collectOnly.code, 'USD').length > 0)

  // A seller there cannot be paid, and the reason says why rather than
  // failing silently when the first payout comes due.
  const route = payoutRoute(collectOnly.code, collectOnly.currency)
  assertEquals(route.provider, null)
  assert(route.reason.includes('cannot send money'))
})

Deno.test('a sanctioned market answers with a reason, not an empty list', () => {
  // The handler returns `restricted: true` plus prose. What it must never do
  // is return an empty method list that reads like a temporary glitch.
  const restricted = ['KP', 'IR', 'SY', 'CU'].map((c) => countryInfo(c))
    .filter((i) => i.restricted)

  assert(restricted.length > 0)
  for (const info of restricted) {
    assertEquals(collectionRails(info.code, 'USD'), [])
  }
})

// ---------------------------------------------------------------------------
// `payout.methods` — what a seller may pick, as against what leads
// ---------------------------------------------------------------------------

Deno.test('methods is every eligible rail, preferred first', () => {
  // The United States as the routing table carries it since PayPal was
  // switched on: a Connect account *or* a PayPal one. `kind` is `connect`, and
  // its whole authority over this list is that it sorts first — a client that
  // read `kind` as the only choice showed a US host one option and refused the
  // other, which is the 2026-09-10 report.
  const rows = [
    { payout_provider: 'paypal', reason_code: 'eligible' },
    { payout_provider: 'stripe_connect', reason_code: 'eligible' },
    { payout_provider: 'flutterwave_momo', reason_code: 'country_not_supported' },
    { payout_provider: 'venmo', reason_code: 'provider_disabled' },
  ]
  assertEquals(payoutMethods(rows, 'connect'), ['connect', 'paypal'])
})

Deno.test('the two amount verdicts count, because a seller registers against a corridor', () => {
  // The same three `sellers/rail-adapter.ts` accepts. A route whose minimum
  // this particular payout is under is still a corridor somebody can be set
  // up in, and the two lists agreeing is what keeps this endpoint's answer and
  // registration's answer the same answer.
  const rows = [
    { payout_provider: 'flutterwave_momo', reason_code: 'below_route_minimum' },
    { payout_provider: 'flutterwave_bank', reason_code: 'above_route_maximum' },
  ]
  assertEquals(payoutMethods(rows, 'momo'), ['momo', 'bank'])
})

Deno.test('a rail with no live adapter never appears, whatever its row says', () => {
  // §29.3's declared-and-disabled wallets map to no kind at all, so they
  // cannot reach the list even by a route row being switched on by mistake.
  const rows = [
    { payout_provider: 'alipay', reason_code: 'eligible' },
    { payout_provider: 'wechat_pay', reason_code: 'eligible' },
    { payout_provider: 'cash_app_pay', reason_code: 'eligible' },
  ]
  assertEquals(payoutMethods(rows, null), [])
})

Deno.test('nothing eligible is an empty list rather than a guess', () => {
  assertEquals(payoutMethods([], 'connect'), [])
  assertEquals(payoutMethods(null, 'connect'), [])
})

// ---------------------------------------------------------------------------
// payableCurrencies — the half of the answer that decides whether PayPal is
// reachable in a market whose own currency it does not carry.
// ---------------------------------------------------------------------------

const COVERAGE: CoverageRow[] = [
  // Shaped like the real rows: a local rail carries many countries and many
  // currencies, and taken as a cross product would offer a Kenyan wallet
  // Rwandan francs. `local_currency_only` is what stops that.
  { payout_provider: 'flutterwave_momo', countries: ['KE', 'RW'], currencies: ['KES', 'RWF'], local_currency_only: true, cross_border_currencies: [] },
  { payout_provider: 'flutterwave_bank', countries: ['RW'], currencies: ['RWF'], local_currency_only: true, cross_border_currencies: [] },
  { payout_provider: 'stripe_connect', countries: ['US'], currencies: ['USD'], local_currency_only: false, cross_border_currencies: [] },
  { payout_provider: 'paypal', countries: ['KE', 'US'], currencies: ['USD', 'EUR'], local_currency_only: false, cross_border_currencies: [] },
]

Deno.test('a Kenyan seller can be paid in USD, which is where PayPal lives', () => {
  const list = payableCurrencies(COVERAGE, 'KE', 'KES')

  // The whole reason this function exists: asking about Kenya in Kenya's own
  // currency answers `['momo']` — correctly — and a client that can ask
  // nothing else concludes PayPal does not reach Kenya at all.
  // KES from the wallet, EUR and USD from PayPal — and **no RWF**, which the
  // raw cross product would have offered because the momo row carries both
  // Kenya and Rwandan francs. That is the corridor a chooser would otherwise
  // have let a host pick and the rail would have refused after collection.
  assertEquals(list.map((c) => c.currency), ['KES', 'EUR', 'USD'])
  assertEquals(list[0].methods, ['momo'])
  assertEquals(list[2].methods, ['paypal'])
  assertEquals(list.some((c) => c.currency === 'RWF'), false)
})

Deno.test('the local currency leads and is the only one flagged default', () => {
  const list = payableCurrencies(COVERAGE, 'KE', 'KES')

  // A chooser preselecting anything else would move an existing seller onto a
  // different payout currency by dropdown default.
  assertEquals(list[0].default, true)
  assertEquals(list.filter((c) => c.default).length, 1)
})

Deno.test('a market whose own currency no rail carries flags no default', () => {
  // Every market PayPal reaches and Flutterwave does not. Nothing may be
  // preselected on a host's behalf when they were not already on it.
  const list = payableCurrencies(COVERAGE, 'US', 'USD')
  assertEquals(list.map((c) => c.currency), ['USD', 'EUR'])
  assertEquals(list[0].default, true)

  const noLocal = payableCurrencies(COVERAGE, 'KE', 'XOF')
  assertEquals(noLocal.every((c) => !c.default), true)
})

Deno.test('one currency reached by two rails reports both destinations', () => {
  const list = payableCurrencies(COVERAGE, 'US', 'USD')
  assertEquals(list[0].methods, ['connect', 'paypal'])
})

Deno.test('a country no row carries is payable in nothing', () => {
  assertEquals(payableCurrencies(COVERAGE, 'BF', 'XOF'), [])
})

// ---------------------------------------------------------------------------
// unavailableCurrencies — why a currency a host expected is not on the list.
// ---------------------------------------------------------------------------

const DARK: CoverageRow[] = [
  ...COVERAGE,
  // Carried for Rwanda, in USD, and not live — the "temporarily dark" case.
  { payout_provider: 'stripe_connect', countries: ['RW'], currencies: ['USD'], local_currency_only: false, cross_border_currencies: [] },
]

Deno.test('a market nobody pays in this currency says so permanently', () => {
  const [usd] = unavailableCurrencies(COVERAGE, COVERAGE, 'RW', 'Rwanda', 'RWF', ['USD'])
  assertEquals(usd.reason_code, 'no_rail_reaches_market')
  assertEquals(usd.permanence, 'permanent')
  // The market's NAME, never its code — a host reads this in a toast.
  assertEquals(usd.message, 'Nobody can be paid in USD in Rwanda yet.')
})

Deno.test('a rail that would have carried it but is dark reads as temporary', () => {
  // `live` does not carry RW/USD; `all` does. That difference is the whole
  // distinction between "nobody serves this" and "this is off right now", and
  // they are different sentences to the person waiting on the money.
  const [usd] = unavailableCurrencies(COVERAGE, DARK, 'RW', 'Rwanda', 'RWF', ['USD'])
  assertEquals(usd.reason_code, 'rail_unavailable')
  assertEquals(usd.permanence, 'temporary')
  assertEquals(usd.message.includes('on us'), true)
})

Deno.test('a currency blocked only by the account kind is method-dependent', () => {
  // The wallet row carries KE and RWF, but pays local money only. Once
  // `cross_border_currencies` is filled this is the live case for a bank.
  const [rwf] = unavailableCurrencies(COVERAGE, COVERAGE, 'KE', 'Kenya', 'KES', ['RWF'])
  assertEquals(rwf.reason_code, 'local_currency_only')
  assertEquals(rwf.permanence, 'method_dependent')
})

Deno.test('a payable currency is never explained away', () => {
  // KES and USD are both on offer in Kenya — KES by wallet, USD by PayPal —
  // so asking about them returns nothing rather than a reason they are
  // missing. The two lists can never contradict each other, which is the
  // property worth pinning: whatever `payableCurrencies` offers, this refuses
  // to explain away.
  assertEquals(unavailableCurrencies(COVERAGE, COVERAGE, 'KE', 'Kenya', 'KES', ['KES', 'USD']), [])
  assertEquals(unavailableCurrencies(COVERAGE, COVERAGE, 'KE', 'Kenya', 'KES', ['KES', 'GBP'])
    .map((c) => c.currency), ['GBP'])
})

Deno.test('the caller bounds the list, so a market cannot flood it', () => {
  // The complement would be seven rows about Ugandan shillings. Nothing is
  // returned that was not asked for.
  assertEquals(unavailableCurrencies(COVERAGE, COVERAGE, 'RW', 'Rwanda', 'RWF', []), [])
})

Deno.test('no message names a country code or blames the host', () => {
  const all = unavailableCurrencies(DARK, DARK, 'RW', 'Rwanda', 'RWF', ['USD', 'EUR', 'GBP'])
  for (const entry of all) {
    // A stale corridor is our state, never something the host got wrong, and
    // "yet" is the strongest promise we may make — §16 confirmation per market
    // is a real gate and "coming soon" is a promise we cannot keep.
    assertEquals(/\byou (did|entered|chose) /i.test(entry.message), false, entry.message)
    assertEquals(/coming soon|shortly|we are working/i.test(entry.message), false, entry.message)
    assertEquals(entry.message.includes(' RW '), false, entry.message)
  }
})

Deno.test('a bank rail offers the settlement currency its row names', () => {
  // The confirmed dollar corridor (`20260910000010`). A Rwandan host is
  // offered RWF by wallet or bank, and USD by bank — and still not Kenyan
  // shillings, which the raw cross product would have handed them.
  const rows: CoverageRow[] = [
    {
      payout_provider: 'flutterwave_momo',
      countries: ['RW', 'KE'],
      currencies: ['RWF', 'KES'],
      local_currency_only: true,
      cross_border_currencies: [],
    },
    {
      payout_provider: 'flutterwave_bank',
      countries: ['RW', 'KE'],
      currencies: ['RWF', 'KES', 'USD'],
      local_currency_only: true,
      cross_border_currencies: ['USD'],
    },
  ]

  const rw = payableCurrencies(rows, 'RW', 'RWF')
  assertEquals(rw.map((c) => c.currency), ['RWF', 'USD'])
  assertEquals(rw[0].methods, ['bank', 'momo'])
  assertEquals(rw[1].methods, ['bank'])
  assertEquals(rw[0].default, true)
  assertEquals(rw.some((c) => c.currency === 'KES'), false)
})

Deno.test('a wallet never gains a settlement currency, whatever the bank does', () => {
  // There is no dollar mobile money wallet to pay into. This is what the
  // instrument is, not a gate waiting on a provider, so the wallet's own row
  // keeps an empty `cross_border_currencies` and USD reaches it through no
  // other route.
  const walletOnly: CoverageRow[] = [{
    payout_provider: 'flutterwave_momo',
    countries: ['RW'],
    currencies: ['RWF', 'USD'],
    local_currency_only: true,
    cross_border_currencies: [],
  }]
  assertEquals(payableCurrencies(walletOnly, 'RW', 'RWF').map((c) => c.currency), ['RWF'])
})
