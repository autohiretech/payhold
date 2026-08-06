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
