/**
 * Run with: deno test --allow-env supabase/functions/_shared/flutterwave.test.ts
 *
 * The unit conversion is the dangerous part of this file. PayHold stores minor
 * units; Flutterwave quotes major. For USD that is a factor of 100, and for
 * RWF — the launch currency — it is a factor of 1. Applying the USD rule to
 * RWF would charge a buyer 1/100th of the price and pay a seller 1/100th of
 * what they are owed, on every single transaction, silently.
 */

import { assert, assertEquals } from 'jsr:@std/assert@1'
import { FlutterwaveProvider, toMajor, toMinor, type FlutterwaveCredentials } from './flutterwave.ts'

const CREDS: FlutterwaveCredentials = {
  secret_key: 'FLWSECK_TEST-x',
  public_key: 'FLWPUBK_TEST-x',
  encryption_key: 'enc',
  webhook_hash: 'super-secret-hash',
}

Deno.test('zero-decimal currencies are not divided', () => {
  // RWF 1000 is one thousand francs, not ten.
  assertEquals(toMajor(1000, 'RWF'), 1000)
  assertEquals(toMinor(1000, 'RWF'), 1000)

  for (const currency of ['UGX', 'XOF', 'XAF', 'BIF', 'JPY']) {
    assertEquals(toMajor(5000, currency), 5000, currency)
    assertEquals(toMinor(5000, currency), 5000, currency)
  }
})

Deno.test('decimal currencies convert by 100', () => {
  assertEquals(toMajor(1000, 'USD'), 10)
  assertEquals(toMinor(10, 'USD'), 1000)
  assertEquals(toMajor(150_050, 'EUR'), 1500.5)
  assertEquals(toMinor(1500.5, 'EUR'), 150_050)
})

Deno.test('conversion round-trips without drift', () => {
  // Float multiplication is why toMinor rounds. 19.99 * 100 is 1998.9999…
  for (const [minor, currency] of [
    [1999, 'USD'], [1, 'USD'], [999_999_99, 'USD'],
    [1000, 'RWF'], [1, 'RWF'], [123_456_789, 'RWF'],
    [70, 'GBP'], [3333, 'KES'],
  ] as [number, string][]) {
    assertEquals(toMinor(toMajor(minor, currency), currency), minor, `${minor} ${currency}`)
  }
})

Deno.test('a webhook with no verif-hash is refused', () => {
  const p = new FlutterwaveProvider(CREDS, '')
  assert(!p.verifySignature('{}', new Headers()))
})

Deno.test('a webhook with the wrong verif-hash is refused', () => {
  const p = new FlutterwaveProvider(CREDS, '')
  assert(!p.verifySignature('{}', new Headers({ 'verif-hash': 'wrong' })))
  // Same length, one character different — the constant-time path.
  assert(!p.verifySignature('{}', new Headers({ 'verif-hash': 'super-secret-hasX' })))
})

Deno.test('a webhook with the right verif-hash is accepted', () => {
  const p = new FlutterwaveProvider(CREDS, '')
  assert(p.verifySignature('{}', new Headers({ 'verif-hash': 'super-secret-hash' })))
})

Deno.test('a provider with no configured hash accepts nothing', () => {
  // An unconfigured webhook secret must fail closed. Accepting everything
  // because nothing was set is how the forged-webhook test starts passing 200.
  const p = new FlutterwaveProvider({ ...CREDS, webhook_hash: '' }, '')
  assert(!p.verifySignature('{}', new Headers({ 'verif-hash': '' })))
  assert(!p.verifySignature('{}', new Headers({ 'verif-hash': 'anything' })))
})
