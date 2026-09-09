import { assert, assertEquals, assertThrows } from 'jsr:@std/assert@1'
import { COUNTRIES } from './countries.ts'
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

// ---------------------------------------------------------------------------
// The registry and this table have to agree, or a host is offered a corridor
// that cannot be registered.
//
// This is the check that was missing. `countries.ts` said Burkina Faso could
// be paid to a wallet; `MOMO_NETWORKS` had no Burkinabe entry, so
// `momoNetworksFor` returned nothing, `momoBankCode` refused every wallet name
// a host could type, and the bank list was empty too — a market advertised as
// payable with no way to be paid. Nothing failed until someone in Ouagadougou
// tried.

Deno.test('every market with a payable wallet names its wallets and its dialling code', () => {
  for (const info of COUNTRIES.filter((c) => c.momoPayout)) {
    const networks = momoNetworksFor(info.code)
    assert(
      networks.length > 0,
      `${info.code} is marked momoPayout and MOMO_NETWORKS names no wallet for it`,
    )
    for (const network of networks) {
      // Refuses rather than guessing, so this is the whole registration path.
      assert(momoBankCode(info.code, network.label), `${info.code}/${network.label}`)
    }
    // A beneficiary cannot be created without the number in the rail's shape.
    assertEquals(
      normalizeMsisdn('0788123456', info.code).startsWith('0'),
      false,
      `${info.code} has no dialling code`,
    )
  }
})

Deno.test('this table claims no market the registry does not', () => {
  const payable = COUNTRIES.filter((c) => c.momoPayout).map((c) => c.code).sort()
  const mapped = Object.keys(MOMO_NETWORKS).sort()
  assertEquals(mapped, payable)
})
