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
