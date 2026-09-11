/**
 * Who decided a dispute, in words that do not claim more than PayHold knows.
 *
 * A signed-in person here was authenticated, and the actor the backend recorded
 * is theirs. A decision a platform relayed over its API key is a different kind
 * of fact (`dispute_decision_relay`, migration 20260911000002): PayHold
 * authenticated the *key*, and the name came from the platform. So that name
 * always reads as reported, beside the key it arrived on — never as
 * "Decided by", which is how a PayHold user reads.
 */

import type { Dispute, DisputeTimelineEvent } from '@/api/types'

const KEY_PREFIX = 'api_key:'

/** `api_key:AutoHire live` → `AutoHire live` — what the key was named. */
export function platformOf(credential: string | null | undefined): string {
  if (!credential) return 'your platform'
  return credential.startsWith(KEY_PREFIX) ? credential.slice(KEY_PREFIX.length) : credential
}

export function reportedBy(credential: string | null | undefined, reported: string): string {
  return `Reported by ${platformOf(credential)} via API key: ${reported}`
}

/** The sentence under a resolved dispute's outcome. */
export function deciderSentence(
  dispute: Pick<Dispute, 'decided_by' | 'decider_source' | 'reported_decider'>,
): string {
  if (dispute.decider_source === 'platform_reported' && dispute.reported_decider) {
    return `${reportedBy(dispute.decided_by, dispute.reported_decider)}.`
  }
  if (dispute.decided_by === 'both-parties') return 'The two sides agreed with each other.'
  return `Decided by ${dispute.decided_by ?? 'nobody recorded'}.`
}

/** Who a timeline row is attributed to. Only a relayed resolution changes. */
export function timelineActor(
  event: Pick<DisputeTimelineEvent, 'kind' | 'actor' | 'details'>,
): string {
  const reported = event.details?.reported_decider
  if (
    event.kind === 'resolved' &&
    event.details?.decider_source === 'platform_reported' &&
    typeof reported === 'string' &&
    reported !== ''
  ) {
    return reportedBy(event.actor, reported)
  }
  return event.actor
}
