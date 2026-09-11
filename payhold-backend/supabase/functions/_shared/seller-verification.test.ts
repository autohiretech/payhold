/**
 * `platform_owns_verification` at the edge — every refusal's code and status,
 * the relayed body AutoHire's half is built against, and the setting's default.
 *
 * The rule itself — that the setting is re-read under the row lock, supersedes
 * the relay, and makes auto-verify inert — is
 * `tests/platform-owns-verification.test.ts`, against Postgres.
 */

import { assertEquals } from 'jsr:@std/assert@1'
import {
  assertAutoVerifyAllowed,
  assertEndHoldCaller,
  assertDestinationRelayAllowed,
  assertSellerRelayAllowed,
  parseRelayedVerification,
  refusePersonWhilePlatformOwns,
  requireSellerWriter,
  VERIFIED_BY_MAX_LENGTH,
  verificationPath,
  verificationRefusal,
} from './seller-verification.ts'
import { decodeSetting } from './settings.ts'
import { ERROR_STATUS, PayHoldError } from './types.ts'

function refusal(fn: () => unknown): PayHoldError {
  try {
    fn()
  } catch (err) {
    if (err instanceof PayHoldError) return err
    throw err
  }
  throw new Error('expected a refusal, but the call succeeded')
}

Deno.test('ownership is on for an account that never saved it', () => {
  // Must match `platform_owns_verification()`'s 1 in SQL and the dashboard's
  // ticked checkbox — the dashboard saves every setting it holds.
  assertEquals(decodeSetting('platform_owns_verification', undefined), true)
  assertEquals(decodeSetting('platform_owns_verification', null), true)
  assertEquals(decodeSetting('platform_owns_verification', 0), false)
  assertEquals(decodeSetting('platform_owns_verification', 1), true)
})

Deno.test('a relayed body names a decision and a person', () => {
  assertEquals(
    parseRelayedVerification({ verified: true, verified_by: '  jane@autohire.rw ' }),
    { verified: true, verified_by: 'jane@autohire.rw' },
  )
  assertEquals(
    parseRelayedVerification({ verified: false, verified_by: 'jane@autohire.rw' }).verified,
    false,
  )
})

Deno.test('a relayed body that is not one is a 400', () => {
  const bad: unknown[] = [
    null,
    [],
    'yes',
    { verified_by: 'jane' },
    { verified: 'true', verified_by: 'jane' },
    { verified: true },
    { verified: true, verified_by: '   ' },
    { verified: true, verified_by: 'x'.repeat(VERIFIED_BY_MAX_LENGTH + 1) },
    { verified: true, verified_by: 'api_key:AutoHire live' },
    { verified: true, verified_by: 'API_KEY:shouting' },
    { verified: true, verified_by: 'system' },
    { verified: true, verified_by: 'System:auto' },
  ]
  for (const body of bad) {
    const err = refusal(() => parseRelayedVerification(body))
    assertEquals(err.code, 'invalid_request', JSON.stringify(body))
    assertEquals(ERROR_STATUS[err.code], 400)
  }
  // Exactly the limit is fine.
  parseRelayedVerification({ verified: true, verified_by: 'x'.repeat(VERIFIED_BY_MAX_LENGTH) })
})

Deno.test('a person verifying while the platform owns it is a 409', () => {
  refusePersonWhilePlatformOwns(false)
  const err = refusal(() => refusePersonWhilePlatformOwns(true))
  assertEquals(err.code, 'verification_owned_by_platform')
  assertEquals(ERROR_STATUS[err.code], 409)
})

Deno.test('ownership supersedes the seller relay; both off is a 422', () => {
  assertSellerRelayAllowed(true, false)
  assertSellerRelayAllowed(true, true)
  assertSellerRelayAllowed(false, true)
  const err = refusal(() => assertSellerRelayAllowed(false, false))
  assertEquals(err.code, 'verification_relay_off')
  assertEquals(ERROR_STATUS[err.code], 422)
})

Deno.test('a destination is relayed only while the platform owns verification', () => {
  assertDestinationRelayAllowed(true)
  const err = refusal(() => assertDestinationRelayAllowed(false))
  assertEquals(err.code, 'destination_relay_off')
  assertEquals(ERROR_STATUS[err.code], 422)
})

Deno.test('turning auto-verify on is refused while ownership is, or will be, on', () => {
  const on = { platform_owns_verification: true }
  const off = { platform_owns_verification: false }

  for (const [patch, current] of [
    [{ seller_auto_verify: true }, on],
    [{ seller_auto_verify: true, platform_owns_verification: true }, off],
  ] as const) {
    const err = refusal(() => assertAutoVerifyAllowed(patch, current))
    assertEquals(err.code, 'auto_verify_owned_by_platform')
    assertEquals(ERROR_STATUS[err.code], 400)
  }

  // Off, absent, or turned on in the same save that hands ownership back.
  assertAutoVerifyAllowed({ seller_auto_verify: false }, on)
  assertAutoVerifyAllowed({ service_fee_rate: 0.1 }, on)
  assertAutoVerifyAllowed({ seller_auto_verify: true }, off)
  assertAutoVerifyAllowed({ seller_auto_verify: true, platform_owns_verification: false }, on)
})

Deno.test('a viewer cannot change a seller; owner, staff and an API key may reach the route', () => {
  requireSellerWriter({ kind: 'api_key' })
  requireSellerWriter({ kind: 'dashboard', role: 'owner' })
  requireSellerWriter({ kind: 'dashboard', role: 'staff' })
  const err = refusal(() => requireSellerWriter({ kind: 'dashboard', role: 'viewer' }))
  assertEquals(err.code, 'forbidden')
  assertEquals(ERROR_STATUS[err.code], 403)
})

Deno.test('the SQL refusals map to their codes and statuses, prefix stripped', () => {
  const cases: [string, string, number][] = [
    ['verification_owned_by_platform: Your platform verifies', 'verification_owned_by_platform', 409],
    ['verification_relay_off: This account has not', 'verification_relay_off', 422],
    ['destination_relay_off: This account verifies', 'destination_relay_off', 422],
    ['invalid_request: a relayed verification must name', 'invalid_request', 400],
  ]
  for (const [message, code, status] of cases) {
    const err = verificationRefusal(message)!
    assertEquals(err.code, code)
    assertEquals(ERROR_STATUS[err.code], status)
    assertEquals(err.message.includes(':'), false, err.message)
  }
  assertEquals(verificationRefusal('policy_violation: a verification must record who made it'), null)
  assertEquals(verificationRefusal('destination_archived: replaced'), null)
})

const KEY = { kind: 'api_key' } as const
const OWNER = { kind: 'dashboard', role: 'owner' } as const
const STAFF = { kind: 'dashboard', role: 'staff' } as const
const VIEWER = { kind: 'dashboard', role: 'viewer' } as const

Deno.test('ending a hold refuses an API key, and a viewer', () => {
  assertEndHoldCaller(OWNER)
  assertEndHoldCaller(STAFF)

  const key = refusal(() => assertEndHoldCaller(KEY))
  assertEquals(key.code, 'policy_violation')
  assertEquals(ERROR_STATUS[key.code], 422)

  // Anything that is not a dashboard session, not only a key.
  const other = refusal(() =>
    assertEndHoldCaller({ kind: 'service' as unknown as 'api_key' })
  )
  assertEquals(other.code, 'policy_violation')

  const viewer = refusal(() => assertEndHoldCaller(VIEWER))
  assertEquals(viewer.code, 'forbidden')
  assertEquals(ERROR_STATUS[viewer.code], 403)
})

Deno.test('with ownership off, an API key is refused on the person-only verifications', () => {
  // The destination has no relay setting to open it.
  const destination = refusal(() =>
    verificationPath(KEY, { owned: false, relaying: true, target: 'destination' })
  )
  assertEquals(destination.code, 'destination_relay_off')
  assertEquals(ERROR_STATUS[destination.code], 422)

  // The seller is person-only unless the owner turned the relay on.
  const seller = refusal(() =>
    verificationPath(KEY, { owned: false, relaying: false, target: 'seller' })
  )
  assertEquals(seller.code, 'verification_relay_off')
  assertEquals(ERROR_STATUS[seller.code], 422)
  assertEquals(verificationPath(KEY, { owned: false, relaying: true, target: 'seller' }), 'relayed')
})

Deno.test('with ownership on, a key relays and a person is refused', () => {
  for (const target of ['seller', 'destination'] as const) {
    assertEquals(verificationPath(KEY, { owned: true, relaying: false, target }), 'relayed')
    for (const person of [OWNER, STAFF]) {
      const err = refusal(() => verificationPath(person, { owned: true, relaying: true, target }))
      assertEquals(err.code, 'verification_owned_by_platform')
    }
  }
})

Deno.test('a viewer is refused on both verifications whatever the settings say', () => {
  for (const owned of [true, false]) {
    for (const target of ['seller', 'destination'] as const) {
      const err = refusal(() => verificationPath(VIEWER, { owned, relaying: true, target }))
      assertEquals(err.code, 'forbidden')
      assertEquals(ERROR_STATUS[err.code], 403)
    }
  }
  assertEquals(verificationPath(STAFF, { owned: false, relaying: false, target: 'seller' }), 'person')
})
