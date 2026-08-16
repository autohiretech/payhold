/**
 * Run with: deno test --allow-env supabase/functions/_shared/fx.test.ts
 *
 * The rates themselves are indicative and will be wrong tomorrow — testing
 * their values would be testing the calendar. What these pin is the arithmetic
 * around them: that money stays integral, that a locked rate is honoured
 * afterwards, and that an unpriceable pair refuses rather than inventing a
 * number and moving money against it.
 */

import { assert, assertEquals, assertThrows } from 'jsr:@std/assert@1'
import {
  atLockedRate,
  canConvert,
  convert,
  convertOrThrow,
  presentmentCurrencyFor,
} from './fx.ts'
import { PayHoldError } from './types.ts'

Deno.test('the same currency converts to itself, untouched', () => {
  assertEquals(convert(123_456, 'RWF', 'RWF'), { amount: 123_456, rate: 1 })
})

Deno.test('a converted amount is always a whole number of minor units', () => {
  for (const amount of [1, 7, 99, 100, 12_345, 999_999]) {
    for (const [from, to] of [['USD', 'RWF'], ['RWF', 'USD'], ['KES', 'EUR']]) {
      const result = convert(amount, from, to)
      assert(result, `${from}→${to} should be priceable`)
      assert(
        Number.isInteger(result.amount),
        `${amount} ${from}→${to} produced ${result.amount}`,
      )
    }
  }
})

Deno.test('a zero-decimal amount converts into real cents, not raw minor units', () => {
  // Live bug: an hourly AutoHire booking, RWF 53,892 (~$38.49), quoted a
  // renter paying by US card presentment_amount: 38 — thirty-eight *cents*,
  // not thirty-eight dollars — because the old convert() applied a
  // major-to-major rate straight to RWF's minor units (RWF has none to
  // convert past) without ever multiplying back up to USD's.
  const result = convert(53_892, 'RWF', 'USD')
  assert(result)
  // 53,892 / 1400 ≈ 38.49 major dollars = 3849 minor units (cents).
  assertEquals(result.amount, 3_849)
})

Deno.test('an unknown currency refuses rather than guessing', () => {
  assertEquals(convert(1000, 'USD', 'XXX'), null)
  assertEquals(convert(1000, 'XXX', 'USD'), null)
  assertEquals(canConvert('USD', 'XXX'), false)
})

Deno.test('convertOrThrow turns that refusal into a client error', () => {
  assertThrows(
    () => convertOrThrow(1000, 'USD', 'XXX'),
    PayHoldError,
    'No exchange rate',
  )
})

Deno.test('a locked rate is honoured in both directions', () => {
  // A deal quoted at 140,000 RWF, charged to a foreign card as 100.00 USD —
  // 10,000 minor units, RWF being zero-decimal and USD not.
  const rate = 100 / 140_000

  assertEquals(atLockedRate(140_000, rate, 'RWF', 'USD', 'settlement_to_presentment'), 10_000)
  assertEquals(atLockedRate(10_000, rate, 'RWF', 'USD', 'presentment_to_settlement'), 140_000)
})

Deno.test('a locked rate does not drift with the table', () => {
  // The point of storing the rate: a deal funded last week must convert the
  // same way today, whatever the current table says.
  const stale = 0.0005
  assertEquals(atLockedRate(140_000, stale, 'RWF', 'USD', 'settlement_to_presentment'), 7_000)
})

Deno.test('a locked rate between two decimal currencies needs no unit crossing', () => {
  // Both minor units are cents, so this is the case the old signature
  // happened to get right — pinned so the currency-aware rewrite cannot
  // regress the case nobody noticed was ever correct.
  const rate = 0.92 // USD -> EUR, indicative
  assertEquals(atLockedRate(10_000, rate, 'USD', 'EUR', 'settlement_to_presentment'), 9_200)
})

Deno.test('a buyer who can pay the settlement currency is charged it', () => {
  assertEquals(presentmentCurrencyFor(['RWF', 'USD'], 'RWF'), 'RWF')
})

Deno.test('a buyer who cannot is charged USD by preference', () => {
  // An Indian card cannot be charged RWF. Refusing the deal would turn away a
  // legitimate customer over a mechanical detail they cannot control.
  assertEquals(presentmentCurrencyFor(['INR', 'USD', 'EUR'], 'RWF'), 'USD')
})

Deno.test('EUR is taken when USD is not on offer', () => {
  assertEquals(presentmentCurrencyFor(['EUR'], 'RWF'), 'EUR')
})

Deno.test('a market with nothing convertible gets no presentment currency', () => {
  assertEquals(presentmentCurrencyFor([], 'RWF'), null)
  assertEquals(presentmentCurrencyFor(['XXX'], 'RWF'), null)
})
