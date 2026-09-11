/**
 * `dispute_decision_relay` — what a relayed dispute decision must look like, and
 * the refusals a caller reads when it does not.
 *
 * A tenant whose own platform decides disputes (AutoHire's admin screen) may,
 * once its owner has turned the setting on, resolve one over its API key and
 * name the person who decided. PayHold still holds the money and still moves it;
 * what changes is whose judgement it moves on.
 *
 * Pure on purpose. `functions/disputes` and `functions/ai-decisions` start a
 * server when imported, so the parts worth pinning — which status each refusal
 * answers with, and what a well-formed relayed decision is — live here where a
 * test can call them. **None of this is the rule.** `resolve_dispute` re-checks
 * the setting under the dispute's row lock and re-validates the reported decider,
 * and `decide_ai_suggestion` refuses an API key on its own; this file produces
 * the sentences.
 */

import type { Caller } from './auth.ts'
import { PayHoldError } from './types.ts'

export const RESOLUTIONS = ['release', 'refund', 'partial_refund'] as const
export type Resolution = typeof RESOLUTIONS[number]

/** A name and an address, not a document. */
export const DECIDED_BY_MAX_LENGTH = 200

/**
 * The Settings checkbox, word for word. The refusal quotes it so the person
 * reading an integration log knows exactly which box their owner has not ticked.
 */
export const DISPUTE_RELAY_SETTING_LABEL =
  'My platform decides disputes and tells PayHold the outcome'

/** A relayed decision, validated. `decided_by` is the platform's claim. */
export interface RelayedResolution {
  resolution: Resolution
  note: string
  /** Presentment minor units. Set for `partial_refund` and nothing else. */
  refund_amount: number | null
  decided_by: string
}

function invalid(message: string): PayHoldError {
  return new PayHoldError('invalid_request', message)
}

/**
 * The account has not opted in. 422 rather than 401 or 403: the key is valid and
 * the caller is who it says, and what is missing is a statement the owner has
 * not made — the same kind of refusal the verification relay gives.
 */
export function assertDisputeRelayOn(relaying: boolean): void {
  if (relaying) return
  throw new PayHoldError(
    'dispute_relay_off',
    `This account has not turned on "${DISPUTE_RELAY_SETTING_LABEL}" in PayHold ` +
      'Settings, so a dispute can only be decided by a signed-in person there. ' +
      'The account owner can turn it on under Settings.',
  )
}

/**
 * Validate the body of `POST /v1/disputes/:id/resolve` from an API key.
 *
 * Stricter than the dashboard path, which reads a missing `refund_amount` as
 * absent and a stray one as ignorable. A person on that path is looking at a form
 * that cannot send either. A server that sends `refund_amount` with
 * `resolution: "refund"` believes it is sending a number that matters, and a
 * full refund quietly going out instead is the wrong way to find out it did not.
 */
export function parseRelayedResolution(raw: unknown): RelayedResolution {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw invalid('Request body must be a JSON object')
  }
  const body = raw as Record<string, unknown>

  const resolution = body.resolution
  if (typeof resolution !== 'string' || !RESOLUTIONS.includes(resolution as Resolution)) {
    throw invalid(`resolution must be one of: ${RESOLUTIONS.join(', ')}`)
  }

  const note = typeof body.note === 'string' ? body.note.trim() : ''
  if (!note) {
    throw invalid('note is required — say why, because it is what both parties are told')
  }

  const decidedBy = typeof body.decided_by === 'string' ? body.decided_by.trim() : ''
  if (!decidedBy) {
    throw invalid(
      'decided_by is required — name the person on your platform who decided this dispute',
    )
  }
  if (decidedBy.length > DECIDED_BY_MAX_LENGTH) {
    throw invalid(`decided_by must be ${DECIDED_BY_MAX_LENGTH} characters or fewer`)
  }
  // `both-parties` is the one name the conflict check lets through, and a
  // credential is not a person. Reporting either reports nobody.
  if (decidedBy === 'both-parties' || decidedBy.startsWith('api_key:')) {
    throw invalid(`decided_by must name the person who decided, not "${decidedBy}"`)
  }

  const amount = body.refund_amount
  let refundAmount: number | null = null

  if (resolution === 'partial_refund') {
    if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount <= 0) {
      throw invalid(
        'refund_amount is required for a partial refund, as a positive whole number of minor units',
      )
    }
    refundAmount = amount
  } else if (amount !== undefined && amount !== null) {
    throw invalid(
      'refund_amount is only for partial_refund — a release refunds nothing, and a ' +
        'refund returns everything still refundable',
    )
  }

  return {
    resolution: resolution as Resolution,
    note,
    refund_amount: refundAmount,
    decided_by: decidedBy,
  }
}

/** The resolution a stored dispute status records, or null while it is open. */
export function storedResolution(status: unknown): Resolution | null {
  switch (status) {
    case 'resolved_released':
      return 'release'
    case 'resolved_refunded':
      return 'refund'
    case 'resolved_split':
      return 'partial_refund'
    default:
      return null
  }
}

/**
 * A relayed decision that disagrees with the one already recorded. The stored
 * outcome travels with the refusal, because the caller's next question is "then
 * what did happen" and making it ask again is a round trip for nothing.
 */
export function alreadyResolved(dispute: Record<string, unknown>): PayHoldError {
  const resolution = storedResolution(dispute.status)

  return new PayHoldError(
    'dispute_already_resolved',
    `This dispute was already resolved${resolution ? ` as ${resolution}` : ''}. ` +
      'Nothing was moved again. Sending the same outcome returns it unchanged; a ' +
      'different one is refused.',
    {
      dispute: {
        id: dispute.id,
        status: dispute.status,
        resolution,
        refund_amount: dispute.resolution_refund_amount ?? null,
        resolved_at: dispute.resolved_at ?? null,
        decided_by: dispute.decided_by ?? null,
        reported_decider: dispute.reported_decider ?? null,
        decider_source: dispute.decider_source ?? null,
      },
    },
  )
}

/**
 * `ai-decisions` refuses an API key outright, relay or no relay.
 *
 * `requireRole` lets every API key through by design, and approving a dispute
 * draft calls `resolve_dispute` — so until this, an approved AI draft was an
 * API-key route to a resolution that recorded no reported decider and asked no
 * setting. The relay is the only such route, and it is the one that does both.
 */
export function refuseApiKeyOnAiDecisions(caller: Pick<Caller, 'kind'>): void {
  if (caller.kind !== 'api_key') return
  throw new PayHoldError(
    'forbidden',
    'An AI draft is approved or rejected by a signed-in person in PayHold, never by ' +
      'an API key. A platform that decides its own disputes resolves them through ' +
      'POST /v1/disputes/:id/resolve.',
  )
}
