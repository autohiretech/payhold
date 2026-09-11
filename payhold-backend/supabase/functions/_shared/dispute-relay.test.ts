/**
 * `dispute_decision_relay` at the edge — which status each refusal answers with,
 * and what a well-formed relayed decision is.
 *
 * The functions themselves start a server on import, so what is pinned here is
 * the part they share: `POST /v1/disputes/:id/resolve` from an API key reads a
 * 422 when the account has not opted in, a 400 when the body is missing the
 * decider or the reason, a 409 carrying the stored outcome when a different
 * decision was already recorded, and `ai-decisions` answers any key with a 403.
 * The money half — that nothing moves on a refusal, or twice on a retry — is
 * `tests/dispute-decision-relay.test.ts`, against Postgres.
 */

import { assert, assertEquals, assertThrows } from 'jsr:@std/assert@1'
import {
  alreadyResolved,
  assertDisputeRelayOn,
  DECIDED_BY_MAX_LENGTH,
  DISPUTE_RELAY_SETTING_LABEL,
  parseRelayedResolution,
  refuseApiKeyOnAiDecisions,
  storedResolution,
} from './dispute-relay.ts'
import { errorResponse } from './http.ts'
import { decodeSetting } from './settings.ts'
import { ERROR_STATUS, PayHoldError } from './types.ts'

/** The refusal a call raised, so its code and status can both be asserted. */
function refusal(fn: () => unknown): PayHoldError {
  try {
    fn()
  } catch (err) {
    if (err instanceof PayHoldError) return err
    throw err
  }
  throw new Error('expected a refusal, but the call succeeded')
}

const VALID = {
  resolution: 'release',
  note: 'Return photos show no damage',
  decided_by: 'autohire-admin:jane@example.com',
}

// ---------------------------------------------------------------------------
// The setting
// ---------------------------------------------------------------------------

Deno.test('relay off is a 422 with its own code, naming the Settings checkbox', () => {
  const err = refusal(() => assertDisputeRelayOn(false))
  assertEquals(err.code, 'dispute_relay_off')
  assertEquals(ERROR_STATUS[err.code], 422)
  assert(err.message.includes(DISPUTE_RELAY_SETTING_LABEL), err.message)
})

Deno.test('relay on lets the call through to the body', () => {
  assertDisputeRelayOn(true)
})

Deno.test('the relay is off for an account that never saved it', () => {
  // Must match `dispute_decision_relay()`'s 0 in SQL and the dashboard's
  // unticked checkbox — the dashboard saves every setting it holds, so a
  // mismatch would be stored permanently on the first Save.
  assertEquals(decodeSetting('dispute_decision_relay', undefined), false)
  assertEquals(decodeSetting('dispute_decision_relay', null), false)
  assertEquals(decodeSetting('dispute_decision_relay', 1), true)
  assertEquals(decodeSetting('dispute_decision_relay', 0), false)
})

Deno.test('the verification relay keeps its own default, which is on', () => {
  // Two relays, two defaults on purpose. This one only unblocks paperwork.
  assertEquals(decodeSetting('seller_verification_relay', undefined), true)
})

// ---------------------------------------------------------------------------
// The body — every gap is a 400
// ---------------------------------------------------------------------------

function assertBadRequest(body: unknown, mentioning: string): void {
  const err = refusal(() => parseRelayedResolution(body))
  assertEquals(err.code, 'invalid_request')
  assertEquals(ERROR_STATUS[err.code], 400)
  assert(err.message.includes(mentioning), `"${err.message}" should mention ${mentioning}`)
}

Deno.test('a missing decided_by is a 400', () => {
  const { decided_by: _omit, ...rest } = VALID
  assertBadRequest(rest, 'decided_by')
})

Deno.test('a blank decided_by is a 400, not a nameless decision', () => {
  assertBadRequest({ ...VALID, decided_by: '   ' }, 'decided_by')
  assertBadRequest({ ...VALID, decided_by: 42 }, 'decided_by')
})

Deno.test('decided_by is a name, not a document', () => {
  assertBadRequest({ ...VALID, decided_by: 'x'.repeat(DECIDED_BY_MAX_LENGTH + 1) }, '200')
  // Exactly the limit is fine.
  const ok = parseRelayedResolution({ ...VALID, decided_by: 'x'.repeat(DECIDED_BY_MAX_LENGTH) })
  assertEquals(ok.decided_by.length, DECIDED_BY_MAX_LENGTH)
})

Deno.test('decided_by cannot be the reserved agreement name or a credential', () => {
  // `both-parties` is the one name the conflict check lets through; a credential
  // is not a person. Reporting either would report nobody.
  assertBadRequest({ ...VALID, decided_by: 'both-parties' }, 'both-parties')
  assertBadRequest({ ...VALID, decided_by: 'api_key:AutoHire live' }, 'api_key:')
})

Deno.test('a missing or blank note is a 400', () => {
  const { note: _omit, ...rest } = VALID
  assertBadRequest(rest, 'note')
  assertBadRequest({ ...VALID, note: '  ' }, 'note')
})

Deno.test('an unknown resolution is a 400', () => {
  assertBadRequest({ ...VALID, resolution: 'escalate' }, 'resolution')
  const { resolution: _omit, ...rest } = VALID
  assertBadRequest(rest, 'resolution')
})

Deno.test('a body that is not an object is a 400', () => {
  assertBadRequest(null, 'JSON object')
  assertBadRequest([VALID], 'JSON object')
  assertBadRequest('release', 'JSON object')
})

Deno.test('a partial refund needs a positive whole number of minor units', () => {
  const partial = { ...VALID, resolution: 'partial_refund' }
  assertBadRequest(partial, 'refund_amount')
  assertBadRequest({ ...partial, refund_amount: 0 }, 'refund_amount')
  assertBadRequest({ ...partial, refund_amount: -5 }, 'refund_amount')
  assertBadRequest({ ...partial, refund_amount: 25.5 }, 'refund_amount')
  assertBadRequest({ ...partial, refund_amount: '25000' }, 'refund_amount')
})

Deno.test('an amount sent with a release or a full refund is refused, not ignored', () => {
  // A server sending one believes it matters. A full refund quietly going out
  // instead is the wrong way to learn it did not.
  assertBadRequest({ ...VALID, refund_amount: 25_000 }, 'only for partial_refund')
  assertBadRequest({ ...VALID, resolution: 'refund', refund_amount: 25_000 }, 'only for partial_refund')
  // Null is absent.
  assertEquals(parseRelayedResolution({ ...VALID, refund_amount: null }).refund_amount, null)
})

Deno.test('a well-formed decision comes back trimmed, with the amount only on a split', () => {
  assertEquals(
    parseRelayedResolution({
      resolution: 'partial_refund',
      note: '  Scratch on the bumper  ',
      refund_amount: 25_000,
      decided_by: '  autohire-admin:jane@example.com ',
    }),
    {
      resolution: 'partial_refund',
      note: 'Scratch on the bumper',
      refund_amount: 25_000,
      decided_by: 'autohire-admin:jane@example.com',
    },
  )
  assertEquals(parseRelayedResolution({ ...VALID, resolution: 'refund' }).refund_amount, null)
})

// ---------------------------------------------------------------------------
// A different decision already recorded
// ---------------------------------------------------------------------------

Deno.test('each stored status names the resolution that produced it', () => {
  assertEquals(storedResolution('resolved_released'), 'release')
  assertEquals(storedResolution('resolved_refunded'), 'refund')
  assertEquals(storedResolution('resolved_split'), 'partial_refund')
  assertEquals(storedResolution('open'), null)
})

Deno.test('already resolved is a 409 that carries what was recorded', async () => {
  const err = alreadyResolved({
    id: 'dsp_1',
    status: 'resolved_split',
    resolution_refund_amount: 25_000,
    resolved_at: '2026-09-11T10:00:00.000Z',
    decided_by: 'api_key:AutoHire live',
    reported_decider: 'autohire-admin:jane@example.com',
    decider_source: 'platform_reported',
  })
  assertEquals(err.code, 'dispute_already_resolved')
  assertEquals(ERROR_STATUS[err.code], 409)

  const response = errorResponse(
    new Request('https://payhold.test/disputes/dsp_1/resolve'),
    err.code,
    err.message,
    err.details,
  )
  assertEquals(response.status, 409)

  const body = await response.json()
  assertEquals(body.error.code, 'dispute_already_resolved')
  assertEquals(body.error.message, err.message)
  assertEquals(body.error.dispute, {
    id: 'dsp_1',
    status: 'resolved_split',
    resolution: 'partial_refund',
    refund_amount: 25_000,
    resolved_at: '2026-09-11T10:00:00.000Z',
    decided_by: 'api_key:AutoHire live',
    reported_decider: 'autohire-admin:jane@example.com',
    decider_source: 'platform_reported',
  })
})

Deno.test('extra error fields can never overwrite the code or the message', async () => {
  const response = errorResponse(
    new Request('https://payhold.test/x'),
    'invalid_request',
    'the real message',
    { code: 'not_it', message: 'not it either', extra: true },
  )
  const body = await response.json()
  assertEquals(body.error, { code: 'invalid_request', message: 'the real message', extra: true })
  assertEquals(response.status, 400)
})

// ---------------------------------------------------------------------------
// The AI back door
// ---------------------------------------------------------------------------

Deno.test('ai-decisions answers an API key with a 403, relay or no relay', () => {
  const err = refusal(() => refuseApiKeyOnAiDecisions({ kind: 'api_key' }))
  assertEquals(err.code, 'forbidden')
  assertEquals(ERROR_STATUS[err.code], 403)
  // It points a platform at the door it is allowed to use.
  assert(err.message.includes('/v1/disputes/:id/resolve'), err.message)
})

Deno.test('a signed-in person reaches ai-decisions exactly as before', () => {
  refuseApiKeyOnAiDecisions({ kind: 'dashboard' })
  assertThrows(() => refuseApiKeyOnAiDecisions({ kind: 'api_key' }), PayHoldError)
})
