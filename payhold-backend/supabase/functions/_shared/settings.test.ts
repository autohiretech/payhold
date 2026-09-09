/**
 * The `country` setting — the sender country on a transfer.
 *
 * Flutterwave refuses a Kenya M-Pesa payout that does not name where the money
 * is coming from, and `tenants` has no country column. This is the one place
 * the fact is recorded, so it has to be either a real country or empty — a
 * typo stored here would be sent on a money transfer.
 */

import { assertEquals, assertThrows } from 'jsr:@std/assert@1'
import { decodeSetting, encodeSetting } from './settings.ts'

Deno.test('country is stored upper-case and must be one PayHold knows', () => {
  assertEquals(encodeSetting('country', 'rw'), 'RW')
  assertEquals(encodeSetting('country', ' ke '), 'KE')
  assertThrows(() => encodeSetting('country', 'XX'), Error, 'not a country PayHold knows')
  assertThrows(() => encodeSetting('country', 12), Error, 'two-letter country code')
})

Deno.test('an empty string clears the country rather than being refused', () => {
  assertEquals(encodeSetting('country', ''), '')
})

Deno.test('a missing or unknown stored value reads back as unset, never as a guess', () => {
  assertEquals(decodeSetting('country', null), '')
  assertEquals(decodeSetting('country', undefined), '')
  assertEquals(decodeSetting('country', 'ZZ'), '')
  assertEquals(decodeSetting('country', 'rw'), 'RW')
})
