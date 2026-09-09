/**
 * Run with: deno test --allow-env supabase/functions/_shared/rails.test.ts
 *
 * The claims worth pinning are the two structural ones from CLAUDE.md:
 * **every country can pay**, and **not every country can be paid**. A routing
 * bug in either direction means money collected that cannot be delivered, or a
 * legitimate buyer turned away.
 */

import { assert, assertEquals, assertThrows } from 'jsr:@std/assert@1'
import {
  collectionRails,
  countryInfo,
  currenciesFor,
  defaultProviderFor,
  METHOD_SUPPORTS_REUSE,
  payoutProviderFor,
  payoutRoute,
  providerFor,
  RAILS,
  RAILS_VERIFIED,
  SUPPORTED_CURRENCIES,
} from './rails.ts'
import { COUNTRIES } from './countries.ts'
import { PayHoldError } from './types.ts'

Deno.test('nothing is marked verified against a provider agreement', () => {
  // Flipping this must be a deliberate act, not something that drifts true.
  assertEquals(RAILS_VERIFIED, false)
})

Deno.test('only card can fund a split deal\'s automatic second charge', () => {
  // A silent flip of any of these to true would let availableMethods offer
  // a split deal a method that is certain to strand its second installment.
  assertEquals(METHOD_SUPPORTS_REUSE.card, true)
  assertEquals(METHOD_SUPPORTS_REUSE.mobile_money, false)
  assertEquals(METHOD_SUPPORTS_REUSE.wallet, false)
  assertEquals(METHOD_SUPPORTS_REUSE.bank_transfer, false)
})

Deno.test('every country that is not sanctioned can pay by card', () => {
  for (const info of COUNTRIES) {
    if (info.restricted) continue

    const usd = collectionRails(info.code, 'USD')
    assert(
      usd.some((r) => r.method === 'card'),
      `${info.code} has no USD card rail`,
    )
  }
})

Deno.test('a sanctioned market can neither collect nor be paid', () => {
  const restricted = COUNTRIES.find((c) => c.restricted)
  assert(restricted, 'the registry should list at least one restricted market')

  assertEquals(collectionRails(restricted.code, 'USD'), [])
  assertEquals(payoutRoute(restricted.code, 'USD').blocked, true)
})

Deno.test('most markets can collect but cannot be paid', () => {
  const payable = COUNTRIES.filter((c) => !payoutRoute(c.code, c.currency).blocked)

  // The asymmetry is the point: card acquiring is near-universal, sending
  // money is licensed per corridor.
  assert(payable.length < COUNTRIES.length / 2, 'payout coverage looks too broad')
  assert(payable.length > 40, 'payout coverage looks too narrow')
})

Deno.test('an African seller is paid by Flutterwave, never Stripe', () => {
  for (const code of ['RW', 'KE', 'UG', 'GH', 'NG']) {
    const route = payoutRoute(code, countryInfo(code).currency)
    assertEquals(route.provider, 'flutterwave', `${code} routed to ${route.provider}`)
  }
})

Deno.test('a deal can be collected on Stripe and paid out on Flutterwave', () => {
  // The reason RailBalance exists: "held" is never one pot.
  assertEquals(providerFor('US', 'USD', 'card'), 'stripe')
  assertEquals(payoutRoute('RW', 'RWF').provider, 'flutterwave')
})

Deno.test('mobile money leads where it exists', () => {
  const rails = collectionRails('RW', 'RWF')
  assertEquals(rails[0].method, 'mobile_money')
  assertEquals(rails[0].provider, 'flutterwave')
})

Deno.test('cards collect and never pay out', () => {
  for (const rail of RAILS) {
    if (rail.method === 'card') assertEquals(rail.payout, false)
  }
})

Deno.test('a currency no rail collects is not offered', () => {
  // A tenant enabling one would only be able to create uncollectable deals.
  assert(SUPPORTED_CURRENCIES.includes('RWF'))
  assert(SUPPORTED_CURRENCIES.includes('USD'))
  assert(!SUPPORTED_CURRENCIES.includes('XXX'))
})

Deno.test('a buyer in Rwanda can be charged their own currency or USD', () => {
  const payable = currenciesFor('RW')
  assert(payable.includes('RWF'))
  assert(payable.includes('USD'))
})

Deno.test('an unknown country is a client error, not a crash', () => {
  assertThrows(() => countryInfo('ZZ'), PayHoldError, 'Unknown country')
})

Deno.test('a corridor we cannot reach is refused rather than queued', () => {
  const unreachable = COUNTRIES.find((c) =>
    !c.restricted && payoutRoute(c.code, c.currency).blocked
  )
  assert(unreachable, 'expected at least one collect-only market')

  // Better to refuse at registration than to discover it when the first payout
  // is due and the buyer's money is already held.
  assertThrows(
    () => payoutProviderFor(unreachable.code, unreachable.currency),
    PayHoldError,
  )
})

Deno.test('a market Flutterwave pays out to but does not collect in gets a payout-only bank rail', () => {
  // Ethiopia: a transfer guide and a momo transfer code, no collection page.
  // The registry says so with `flutterwavePayout` and not `flutterwaveLocal`,
  // and the rail table has to carry that shape or `payoutRoute` promises a
  // corridor no row describes.
  const et = RAILS.filter((r) => r.country === 'ET' && r.provider === 'flutterwave')
  assertEquals(et.length, 1)
  assertEquals(et[0].method, 'bank_transfer')
  assertEquals(et[0].collect, false)
  assertEquals(et[0].payout, true)

  // …and it never leaks into a checkout.
  assertEquals(collectionRails('ET', 'ETB'), [])
  assert(!currenciesFor('ET').includes('ETB'))
  assert(!SUPPORTED_CURRENCIES.includes('ETB'))

  const route = payoutRoute('ET', 'ETB')
  assertEquals(route.provider, 'flutterwave')
  assertEquals(route.kind, 'bank')
  assertEquals(route.blocked, false)
})

Deno.test('a market Flutterwave collects in but cannot pay out to is refused at registration', () => {
  // Egypt: card and Fawry collection, and transfers "not available by default
  // — submit a request". Buyers there pay locally; the money cannot go back
  // out, and the seller hears that before a destination is stored.
  assert(collectionRails('EG', 'EGP').some((r) => r.provider === 'flutterwave'))
  const route = payoutRoute('EG', 'EGP')
  assertEquals(route.blocked, true)
  assertEquals(route.provider, null)
  assertThrows(() => payoutProviderFor('EG', 'EGP'), PayHoldError)
})

Deno.test('Kenya and Tanzania are paid by mobile money — the bank corridor is gated', () => {
  // The registry flag is per country; the SQL `payout_routes` rows carry the
  // bank-vs-wallet split and have both off the bank row. Here the wallet wins
  // because one exists, which is also what the transfer table documents.
  for (const [country, currency] of [['KE', 'KES'], ['TZ', 'TZS']]) {
    const route = payoutRoute(country, currency)
    assertEquals(route.provider, 'flutterwave', country)
    assertEquals(route.kind, 'momo', country)
  }
})

Deno.test('the default rail for a market is one that can actually take money', () => {
  for (const info of COUNTRIES) {
    if (info.restricted) continue

    const provider = defaultProviderFor(info.code, 'USD')
    const rails = collectionRails(info.code, 'USD')
    assert(
      rails.some((r) => r.provider === provider),
      `${info.code} defaults to ${provider}, which has no USD rail there`,
    )
  }
})
