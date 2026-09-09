import { assertEquals, assertThrows } from 'jsr:@std/assert@1'
import {
  MOMO_NETWORKS,
  momoBankCode,
  momoNetworksFor,
  normalizeMsisdn,
} from './momo.ts'
import { PayHoldError } from './types.ts'

Deno.test('every network carries a wire code', () => {
  for (const [country, networks] of Object.entries(MOMO_NETWORKS)) {
    assertEquals(networks.length > 0, true, `${country} has no networks`)
    for (const n of networks) {
      assertEquals(n.code.trim().length > 0, true, `${country}/${n.label} has no code`)
      // Flutterwave's codes are uppercase and unpunctuated. A lowercase one
      // would be sent verbatim and refused at the rail.
      assertEquals(n.code, n.code.toUpperCase())
    }
  }
})

Deno.test('the launch market resolves both of its wallets', () => {
  assertEquals(momoBankCode('RW', 'MTN'), 'MTN')
  assertEquals(momoBankCode('RW', 'Airtel Money'), 'MPS')
})

Deno.test('a label is matched however it is cased or spaced', () => {
  assertEquals(momoBankCode('UG', 'airtel money'), 'AIRTEL')
  assertEquals(momoBankCode('UG', '  MTN  '), 'MTN')
})

Deno.test('the wire code is accepted as well as the label', () => {
  // A client that stored `VODAFONE` rather than "Telecel" must not break when
  // the seller-facing label is reworded.
  assertEquals(momoBankCode('GH', 'VODAFONE'), 'VODAFONE')
  assertEquals(momoBankCode('GH', 'Telecel'), 'VODAFONE')
})

Deno.test('an unknown wallet refuses, and names what is available', () => {
  const err = assertThrows(
    () => momoBankCode('RW', 'M-Pesa'),
    PayHoldError,
  ) as PayHoldError
  assertEquals(err.code, 'policy_violation')
  // The seller has to be told what to pick instead.
  assertEquals(err.message.includes('MTN'), true)
  assertEquals(err.message.includes('Airtel Money'), true)
})

Deno.test('a market with no mobile money refuses rather than defaulting', () => {
  // The old code sent `undefined` for every non-RWF corridor, which is exactly
  // the silent-wrong this refusal replaces.
  assertThrows(() => momoBankCode('US', 'MTN'), PayHoldError)
  assertThrows(() => momoBankCode('NG', 'MTN'), PayHoldError)
})

Deno.test('Senegal deliberately omits a wallet Flutterwave cannot send to', () => {
  assertEquals(momoNetworksFor('SN').map((n) => n.label), ['Orange Money', 'Wave'])
  // The registry lists Free Money; offering it would register a beneficiary
  // nothing can pay.
  assertThrows(() => momoBankCode('SN', 'Free Money'), PayHoldError)
})

Deno.test('normalizeMsisdn: every spelling of one Rwandan number', () => {
  const want = '250788123456'
  assertEquals(normalizeMsisdn('+250 788 123 456', 'RW'), want)
  assertEquals(normalizeMsisdn('250788123456', 'RW'), want)
  assertEquals(normalizeMsisdn('0788123456', 'RW'), want)
  assertEquals(normalizeMsisdn('788123456', 'RW'), want)
  assertEquals(normalizeMsisdn('+250-788-123-456', 'RW'), want)
  // The trunk zero survives the dialling code in plenty of address books.
  assertEquals(normalizeMsisdn('2500788123456', 'RW'), want)
})

Deno.test('normalizeMsisdn: other markets keep their own code', () => {
  assertEquals(normalizeMsisdn('0712345678', 'KE'), '254712345678')
  assertEquals(normalizeMsisdn('+233 24 123 4567', 'GH'), '233241234567')
})

Deno.test('normalizeMsisdn: nonsense refuses', () => {
  assertThrows(() => normalizeMsisdn('12', 'RW'), PayHoldError)
  assertThrows(() => normalizeMsisdn('not a number', 'RW'), PayHoldError)
  // A country we cannot pay has no dialling code here, and guessing one would
  // produce a beneficiary that looks fine.
  assertThrows(() => normalizeMsisdn('0788123456', 'JP'), PayHoldError)
})
