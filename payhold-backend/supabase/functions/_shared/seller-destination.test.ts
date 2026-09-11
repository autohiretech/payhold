/**
 * One live destination per seller, at the edge — which status each refusal
 * answers with, and which request shapes stay valid for the client already live.
 *
 * The rule itself is `tests/one-destination-per-seller.test.ts`, against
 * Postgres. What is pinned here is the contract AutoHire depends on while it
 * catches up: `role: 'primary'` and an absent role are both accepted, a
 * withdrawal with no `destination_id` is valid, and every refusal is a 4xx with
 * its own code rather than a 500.
 */

import { assertEquals, assertThrows } from 'jsr:@std/assert@1'
import {
  assertDestinationRole,
  destinationRefusal,
  ONE_DESTINATION_MESSAGE,
  withdrawalDestination,
} from './seller-destination.ts'
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

Deno.test('an absent role and primary are the same request', () => {
  assertDestinationRole(undefined)
  assertDestinationRole(null)
  assertDestinationRole('primary')
})

Deno.test('backup, or any other role, is a 400 with its own code', () => {
  for (const role of ['backup', 'preferred', '', 'PRIMARY', 1]) {
    const err = refusal(() => assertDestinationRole(role))
    assertEquals(err.code, 'backup_destination_removed')
    assertEquals(ERROR_STATUS[err.code], 400)
    assertEquals(err.message, ONE_DESTINATION_MESSAGE)
  }
})

Deno.test('a withdrawal with no destination is valid and means the live one', () => {
  assertEquals(withdrawalDestination(undefined), null)
  assertEquals(withdrawalDestination(null), null)
  const id = '8a4f0f52-3c1e-4c1b-9a0e-5f3b2d7c1e90'
  assertEquals(withdrawalDestination(id), id)
})

Deno.test('a destination id that could never be the live row is a 400, not a parser error', () => {
  for (const bad of ['not-a-uuid', '', 42, { id: 'x' }]) {
    const err = refusal(() => withdrawalDestination(bad))
    assertEquals(err.code, 'destination_not_live')
    assertEquals(ERROR_STATUS[err.code], 400)
  }
})

Deno.test('the SQL refusals map to their codes and statuses, prefix stripped', () => {
  const archived = destinationRefusal(
    'destination_archived: This payout destination was replaced, so it can no longer be verified.',
  )!
  assertEquals(archived.code, 'destination_archived')
  assertEquals(ERROR_STATUS[archived.code], 409)
  assertEquals(archived.message.startsWith('This payout destination'), true)

  const notLive = destinationRefusal(
    'destination_not_live: destination 1 is not this seller\'s current payout destination.',
  )!
  assertEquals(notLive.code, 'destination_not_live')
  assertEquals(ERROR_STATUS[notLive.code], 400)

  const role = destinationRefusal(`backup_destination_removed: ${ONE_DESTINATION_MESSAGE}`)!
  assertEquals(role.code, 'backup_destination_removed')
  assertEquals(role.message, ONE_DESTINATION_MESSAGE)
})

Deno.test('anything else is left to the caller', () => {
  assertEquals(destinationRefusal('policy_violation: destination x has not been verified'), null)
  assertEquals(destinationRefusal('invalid_state: seller x has nothing cleared to withdraw'), null)
  assertThrows(() => {
    throw destinationRefusal('nope') ?? new Error('fell through')
  }, Error, 'fell through')
})
