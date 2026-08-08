/**
 * The Resolution Center — spec §8.
 *
 * The mirror of `payhold-backend/supabase/migrations/20260807000017_resolution_center.sql`,
 * same functions and same refusals in the same order. A change to either is a
 * change to both.
 *
 * Two things here carry the phase's design and are worth not "simplifying":
 *
 * **Silence lapses a request; it never accepts one.** §8 says an unanswered
 * request "may be auto-resolved by platform rule", and the rule is that at 48
 * hours the offer expires and the dispute stays open. Auto-accepting would make
 * a clock the thing that refunds a buyer or pays a seller — a machine deciding,
 * which invariants 9 and 11 both forbid. The window closing without a human is
 * what §15 phase 4 asks for, and it is satisfied by the offer reaching a
 * terminal state, not by the money moving.
 *
 * **`disputed_amount` bounds the resolution rather than splitting the payout.**
 * One payout row exists per deal, so paying a seller the undisputed two thirds
 * now would leave nothing to send the last third with if the dispute later went
 * their way. So the amount is enforced where it can be honestly enforced: a
 * resolution may not take more from the seller than was ever in dispute.
 */

import { PayHoldError } from '../types'
import type {
  ConfirmSide,
  Dispute,
  DisputeEvidence,
  DisputeOffer,
  DisputeOfferKind,
  DisputeTimelineEvent,
  Money,
} from '../types'
import { audit, nextId, now, nowIso, type MockDb } from './store'
import { emitWebhook } from './webhooks'
import { requireDeal, touch } from './engine'

/** §8's 48 hours. */
export const OFFER_WINDOW_MS = 48 * 60 * 60 * 1000

export function requireDispute(db: MockDb, id: string): Dispute {
  const dispute = db.disputes.find((d) => d.id === id)
  if (!dispute) throw new PayHoldError('not_found', `Dispute ${id} not found`)
  return dispute
}

function requireOffer(db: MockDb, id: string): DisputeOffer {
  const offer = db.dispute_offers.find((o) => o.id === id)
  if (!offer) throw new PayHoldError('not_found', `Request ${id} not found`)
  return offer
}

/** §8: one live request per order, whichever dispute it belongs to. */
export function openOfferForDeal(db: MockDb, dealId: string): DisputeOffer | undefined {
  return db.dispute_offers.find((o) => o.deal_id === dealId && o.status === 'open')
}

export function makeDisputeOffer(
  db: MockDb,
  disputeId: string,
  offeredBy: ConfirmSide,
  actor: string,
  kind: DisputeOfferKind,
  opts: { amount?: Money | null; extendTo?: string | null; note?: string | null } = {},
): DisputeOffer {
  if (!actor.trim()) {
    throw new PayHoldError('policy_violation', 'A request must record who made it')
  }

  const dispute = requireDispute(db, disputeId)
  if (dispute.status !== 'open') {
    throw new PayHoldError('invalid_state', 'This dispute is already resolved')
  }

  const deal = requireDeal(db, dispute.deal_id)

  if (kind === 'partial_refund') {
    const amount = opts.amount ?? 0
    if (amount <= 0) {
      throw new PayHoldError('policy_violation', 'A partial refund must name an amount')
    }
    if (amount >= deal.presentment_amount) {
      throw new PayHoldError(
        'policy_violation',
        'That is the whole payment — request a full refund',
      )
    }
    if (dispute.disputed_amount !== null && amount > dispute.disputed_amount) {
      throw new PayHoldError(
        'policy_violation',
        `${amount} is more than the ${dispute.disputed_amount} in dispute`,
      )
    }
  }

  if (kind === 'extension' && !opts.extendTo) {
    throw new PayHoldError('policy_violation', 'An extension must name a new date')
  }

  if (openOfferForDeal(db, dispute.deal_id)) {
    throw new PayHoldError('invalid_state', 'A request on this order is still open')
  }

  const offer: DisputeOffer = {
    id: nextId('off'),
    tenant_id: dispute.tenant_id,
    dispute_id: dispute.id,
    deal_id: dispute.deal_id,
    offered_by: offeredBy,
    offered_by_actor: actor,
    kind,
    amount: kind === 'partial_refund' ? (opts.amount ?? null) : null,
    extend_to: kind === 'extension' ? (opts.extendTo ?? null) : null,
    note: opts.note ?? null,
    status: 'open',
    expires_at: new Date(now().getTime() + OFFER_WINDOW_MS).toISOString(),
    created_at: nowIso(),
    responded_at: null,
    responded_by_actor: null,
  }
  db.dispute_offers.push(offer)

  audit(db, dispute.tenant_id, dispute.deal_id, actor, 'dispute.offer_made', {
    offer_id: offer.id,
    kind,
    amount: offer.amount,
    expires_at: offer.expires_at,
  })
  emitWebhook(db, dispute.tenant_id, 'dispute.offer_made', dispute.deal_id, {
    offer_id: offer.id,
    kind,
    offered_by: offeredBy,
    amount: offer.amount,
    expires_at: offer.expires_at,
  })

  return offer
}

export function withdrawDisputeOffer(
  db: MockDb,
  offerId: string,
  actor: string,
): DisputeOffer {
  const offer = requireOffer(db, offerId)
  if (offer.status !== 'open') {
    throw new PayHoldError('invalid_state', `That request is already ${offer.status}`)
  }

  offer.status = 'withdrawn'
  offer.responded_at = nowIso()
  offer.responded_by_actor = actor

  audit(db, offer.tenant_id, offer.deal_id, actor, 'dispute.offer_withdrawn', {
    offer_id: offer.id,
  })
  emitWebhook(db, offer.tenant_id, 'dispute.offer_withdrawn', offer.deal_id, {
    offer_id: offer.id,
    kind: offer.kind,
  })
  return offer
}

/**
 * Accept or decline, within the window.
 *
 * `resolve` is passed in rather than imported so this file does not depend on
 * the money path — the same separation the backend gets for free by having
 * `respond_dispute_offer` call `resolve_dispute` under one lock.
 */
export function respondDisputeOffer(
  db: MockDb,
  offerId: string,
  side: ConfirmSide,
  actor: string,
  accept: boolean,
  resolve: (
    disputeId: string,
    resolution: 'release' | 'refund' | 'partial_refund',
    note: string,
    amount: Money | null,
    decidedBy: string,
  ) => void,
): DisputeOffer {
  if (!actor.trim()) {
    throw new PayHoldError('policy_violation', 'An answer must record who gave it')
  }

  const offer = requireOffer(db, offerId)
  if (offer.status !== 'open') {
    throw new PayHoldError('invalid_state', `That request is already ${offer.status}`)
  }
  if (now().getTime() >= Date.parse(offer.expires_at)) {
    throw new PayHoldError('invalid_state', `That request expired at ${offer.expires_at}`)
  }
  if (side === offer.offered_by) {
    throw new PayHoldError('policy_violation', 'The other party answers a request')
  }

  offer.responded_at = nowIso()
  offer.responded_by_actor = actor

  if (!accept) {
    offer.status = 'declined'
    audit(db, offer.tenant_id, offer.deal_id, actor, 'dispute.offer_declined', {
      offer_id: offer.id,
      kind: offer.kind,
    })
    emitWebhook(db, offer.tenant_id, 'dispute.offer_declined', offer.deal_id, {
      offer_id: offer.id,
      kind: offer.kind,
    })
    return offer
  }

  offer.status = 'accepted'
  audit(db, offer.tenant_id, offer.deal_id, actor, 'dispute.offer_accepted', {
    offer_id: offer.id,
    kind: offer.kind,
    amount: offer.amount,
  })
  emitWebhook(db, offer.tenant_id, 'dispute.offer_accepted', offer.deal_id, {
    offer_id: offer.id,
    kind: offer.kind,
  })

  // Agreeing to send a photo or to finish on Friday is not agreeing about the
  // money. The dispute stays open, or a side conversation would unfreeze the
  // payout.
  if (offer.kind === 'extension') {
    const deal = requireDeal(db, offer.deal_id)
    deal.expected_complete_at = offer.extend_to
    touch(deal)
    audit(db, offer.tenant_id, offer.deal_id, actor, 'deal.extended', {
      expected_complete_at: offer.extend_to,
    })
    return offer
  }

  if (offer.kind === 'update') return offer

  // The three that end the deal. The decider is `both-parties` and not the
  // person clicking: they are a party, and the conflict-of-interest check would
  // refuse them — rightly. An agreement between the two sides is recorded as one.
  if (offer.kind === 'cancellation' || offer.kind === 'full_refund') {
    resolve(
      offer.dispute_id,
      'refund',
      `Agreed by both parties: ${offer.kind} accepted by ${actor}.`,
      null,
      'both-parties',
    )
  } else {
    resolve(
      offer.dispute_id,
      'partial_refund',
      `Agreed by both parties: partial refund accepted by ${actor}.`,
      offer.amount,
      'both-parties',
    )
  }

  return offer
}

export function addDisputeEvidence(
  db: MockDb,
  disputeId: string,
  side: ConfirmSide,
  actor: string,
  input: {
    kind: DisputeEvidence['kind']
    description: string
    url?: string | null
    capturedAt?: string | null
  },
): DisputeEvidence {
  if (!actor.trim()) {
    throw new PayHoldError('policy_violation', 'Evidence must record who filed it')
  }

  const dispute = requireDispute(db, disputeId)
  // Evidence after the decision cannot have informed it, and a case file that
  // grew afterwards is not the one anybody read.
  if (dispute.status !== 'open') {
    throw new PayHoldError('invalid_state', 'This dispute is already resolved')
  }
  if (!input.description.trim()) {
    throw new PayHoldError(
      'policy_violation',
      'Evidence needs a description — it is what a person and the assistant read',
    )
  }

  const evidence: DisputeEvidence = {
    side,
    kind: input.kind,
    description: input.description,
    url: input.url ?? null,
    captured_at: input.capturedAt ?? null,
    submitted_at: nowIso(),
  }
  dispute.evidence.push(evidence)

  audit(db, dispute.tenant_id, dispute.deal_id, actor, 'dispute.evidence_added', {
    kind: input.kind,
  })
  emitWebhook(db, dispute.tenant_id, 'dispute.evidence_added', dispute.deal_id, {
    kind: input.kind,
    uploaded_by: side,
  })
  return evidence
}

/**
 * The 48 hours running out. Moves no money and touches no deal — which is what
 * makes it safe to run from the timer cron beside auto-release.
 */
export function expireDisputeOffers(db: MockDb): number {
  let n = 0
  for (const offer of db.dispute_offers) {
    if (offer.status !== 'open') continue
    if (now().getTime() < Date.parse(offer.expires_at)) continue

    offer.status = 'expired'
    offer.responded_at = nowIso()
    // Nobody answered, so nobody is recorded as having answered.
    offer.responded_by_actor = null

    audit(db, offer.tenant_id, offer.deal_id, 'system', 'dispute.offer_expired', {
      offer_id: offer.id,
      kind: offer.kind,
      expired_at: offer.expires_at,
    })
    emitWebhook(db, offer.tenant_id, 'dispute.offer_expired', offer.deal_id, {
      offer_id: offer.id,
      kind: offer.kind,
    })
    n += 1
  }
  return n
}

/**
 * §8's timeline, and the "communication export" that is the same list with the
 * deal alongside. Derived rather than stored: every row already exists somewhere
 * else, and a second copy would be free to disagree with the first.
 */
export function disputeTimeline(db: MockDb, disputeId: string): DisputeTimelineEvent[] {
  const dispute = requireDispute(db, disputeId)
  const events: DisputeTimelineEvent[] = []

  events.push({
    at: dispute.opened_at,
    kind: 'dispute_opened',
    actor: dispute.raised_by_actor ?? `user:${dispute.raised_by}`,
    side: dispute.raised_by,
    summary: dispute.reason,
    details: {
      reason_code: dispute.reason_code,
      disputed_amount: dispute.disputed_amount,
    },
  })

  for (const offer of db.dispute_offers.filter((o) => o.dispute_id === dispute.id)) {
    events.push({
      at: offer.created_at,
      kind: `offer_${offer.kind}`,
      actor: offer.offered_by_actor,
      side: offer.offered_by,
      summary: offer.note ?? offer.kind,
      details: {
        offer_id: offer.id,
        amount: offer.amount,
        extend_to: offer.extend_to,
        expires_at: offer.expires_at,
      },
    })

    if (offer.responded_at) {
      events.push({
        at: offer.responded_at,
        kind: `offer_${offer.status}`,
        actor: offer.responded_by_actor ?? 'system',
        side: null,
        summary: offer.kind,
        details: { offer_id: offer.id },
      })
    }
  }

  for (const e of dispute.evidence) {
    events.push({
      at: e.submitted_at,
      kind: `evidence_${e.kind}`,
      actor: `user:${e.side}`,
      side: e.side,
      summary: e.description,
      details: { captured_at: e.captured_at, url: e.url },
    })
  }

  if (dispute.resolved_at) {
    events.push({
      at: dispute.resolved_at,
      kind: 'resolved',
      actor: dispute.decided_by ?? 'payhold-staff',
      side: null,
      summary: dispute.resolution_note ?? dispute.status,
      details: { status: dispute.status },
    })
  }

  return events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
}

/**
 * §8's conflict-of-interest control.
 *
 * The obvious implementation — join the deciding user to the buyer or seller —
 * cannot be written: PayHold stores no buyer PII and a seller has no login, so
 * there is no identity to join to. What *is* recorded is who acted, so the rule
 * is that whoever spoke for a side cannot be the one who rules on it.
 */
export function assertMayDecide(db: MockDb, dispute: Dispute, decidedBy: string): void {
  if (!decidedBy.trim()) {
    throw new PayHoldError(
      'policy_violation',
      'A resolution must record who decided it',
    )
  }
  // What `respondDisputeOffer` writes when the two sides agreed with each other.
  // Refusing it would make agreement unexecutable.
  if (decidedBy === 'both-parties') return

  const acted = dispute.raised_by_actor === decidedBy ||
    db.dispute_offers.some(
      (o) =>
        o.dispute_id === dispute.id &&
        (o.offered_by_actor === decidedBy || o.responded_by_actor === decidedBy),
    )

  if (acted) {
    throw new PayHoldError(
      'policy_violation',
      `${decidedBy} acted for a party in this dispute and cannot decide it`,
    )
  }
}

/** The ceiling `disputed_amount` puts on a resolution. */
export function assertWithinDisputedAmount(
  dispute: Dispute,
  resolution: 'release' | 'refund' | 'partial_refund',
  refundAmount: Money | null,
  presentmentAmount: Money,
): void {
  if (dispute.disputed_amount === null) return
  if (dispute.disputed_amount >= presentmentAmount) return

  if (resolution === 'refund') {
    throw new PayHoldError(
      'policy_violation',
      `Only ${dispute.disputed_amount} of this payment is in dispute — resolve it as a partial refund`,
    )
  }
  if (resolution === 'partial_refund' && (refundAmount ?? 0) > dispute.disputed_amount) {
    throw new PayHoldError(
      'policy_violation',
      `${refundAmount} is more than the ${dispute.disputed_amount} in dispute`,
    )
  }
}
