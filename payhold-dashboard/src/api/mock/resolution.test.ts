/**
 * §8 — the Resolution Center.
 *
 * The mirror of `payhold-backend/tests/resolution-center.test.ts`, case for
 * case. The acceptance criterion is §15 phase 4: funds cannot be released while
 * a dispute is active, and the 48-hour window resolves without a human — where
 * "resolves" means the window closes, not that money moves. Silence lapses a
 * request; it never accepts one.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { PayHoldError } from '../types'
import {
  computeDealAmounts,
  fundDeal,
  openDispute,
  requireDeal,
  resolveDispute,
} from './engine'
import {
  addDisputeEvidence,
  disputeTimeline,
  expireDisputeOffers,
  makeDisputeOffer,
  respondDisputeOffer,
  withdrawDisputeOffer,
} from './resolution'
import { seedDb } from './seed'
import { advanceClock, loadDb, resetDb, type MockDb } from './store'

const AUTOHIRE = 'ten_0001'
const OPS = 'user:ops@payhold.test'

let db: MockDb

beforeEach(() => {
  localStorage.clear()
  db = resetDb(seedDb)
  loadDb(seedDb)
})

/** A funded deal with nothing else attached to it. */
function funded(): string {
  const deal = db.deals.find(
    (d) => d.status === 'created' && d.tenant_id === AUTOHIRE && !d.deposit_amount,
  )
  if (!deal) throw new Error('fixture missing an unfunded deal')
  fundDeal(db, deal.id, 'card', 'Visa')
  return deal.id
}

/** The mock's `resolveDispute` takes the converted figures the same way. */
function resolve(
  disputeId: string,
  resolution: 'release' | 'refund' | 'partial_refund',
  note: string,
  opts: { refundAmount?: number | null; decidedBy?: string } = {},
) {
  return resolveDispute(db, disputeId, resolution, note, {
    refundAmount: opts.refundAmount ?? null,
    decidedBy: opts.decidedBy ?? OPS,
  })
}

describe('§8 — opening a dispute', () => {
  it('records a structured code, an amount and the person who filed it', () => {
    const deal = funded()
    const dispute = openDispute(db, deal, 'buyer', 'The panel is scratched', {
      reasonCode: 'damaged',
      actor: 'user:buyer@example.com',
      disputedAmount: 30_000,
    })

    expect(dispute.reason_code).toBe('damaged')
    expect(dispute.disputed_amount).toBe(30_000)
    expect(dispute.raised_by_actor).toBe('user:buyer@example.com')
    expect(requireDeal(db, deal).status).toBe('disputed')
  })

  it('defaults the code rather than forcing a wrong one', () => {
    const deal = funded()
    const dispute = openDispute(db, deal, 'buyer', 'Never arrived')
    expect(dispute.reason_code).toBe('other')
    expect(dispute.disputed_amount).toBeNull()
  })

  it('cannot dispute more than the buyer paid', () => {
    const deal = funded()
    const amount = requireDeal(db, deal).presentment_amount
    expect(() =>
      openDispute(db, deal, 'buyer', 'Everything', { disputedAmount: amount + 1 })
    ).toThrow(PayHoldError)
  })

  it('cannot open while a request on the order is still outstanding', () => {
    const deal = funded()
    const dispute = openDispute(db, deal, 'buyer', 'First')
    makeDisputeOffer(db, dispute.id, 'seller', 'user:seller', 'update')

    dispute.status = 'resolved_released'
    dispute.resolved_at = new Date().toISOString()

    expect(() => openDispute(db, deal, 'seller', 'Second')).toThrow(
      /request on this order is still open/,
    )
  })
})

describe('§8 — the five requests', () => {
  it('allows only one open per order at a time', () => {
    const deal = funded()
    const dispute = openDispute(db, deal, 'buyer', 'Damaged')
    makeDisputeOffer(db, dispute.id, 'seller', 'user:seller', 'update')

    expect(() =>
      makeDisputeOffer(db, dispute.id, 'buyer', 'user:buyer', 'cancellation')
    ).toThrow(/still open/)
  })

  it('refuses a partial refund with no amount, or one that is the whole payment', () => {
    const deal = funded()
    const dispute = openDispute(db, deal, 'buyer', 'Damaged')
    const paid = requireDeal(db, deal).presentment_amount

    expect(() =>
      makeDisputeOffer(db, dispute.id, 'seller', 'user:seller', 'partial_refund')
    ).toThrow(/must name an amount/)
    expect(() =>
      makeDisputeOffer(db, dispute.id, 'seller', 'user:seller', 'partial_refund', {
        amount: paid,
      })
    ).toThrow(/whole payment/)
  })

  it('refuses one larger than what was put in dispute', () => {
    const deal = funded()
    const dispute = openDispute(db, deal, 'buyer', 'Part of it', {
      disputedAmount: 30_000,
    })

    expect(() =>
      makeDisputeOffer(db, dispute.id, 'seller', 'user:seller', 'partial_refund', {
        amount: 50_000,
      })
    ).toThrow(/more than the 30000 in dispute/)
  })

  it('will not let the offering side answer its own request', () => {
    const deal = funded()
    const dispute = openDispute(db, deal, 'buyer', 'Damaged')
    const offer = makeDisputeOffer(db, dispute.id, 'seller', 'user:seller', 'update')

    expect(() =>
      respondDisputeOffer(db, offer.id, 'seller', 'user:seller', true, () => {})
    ).toThrow(/other party answers/)
  })

  it('moves the completion date on an accepted extension, and leaves the dispute open', () => {
    const deal = funded()
    const dispute = openDispute(db, deal, 'buyer', 'Running late')
    const when = new Date(Date.now() + 6 * 86_400_000).toISOString()
    const offer = makeDisputeOffer(db, dispute.id, 'seller', 'user:seller', 'extension', {
      extendTo: when,
    })

    respondDisputeOffer(db, offer.id, 'buyer', 'user:buyer', true, () => {
      throw new Error('an extension must not touch money')
    })

    expect(requireDeal(db, deal).expected_complete_at).toBe(when)
    // Agreeing to finish on Friday is not agreeing about the money.
    expect(dispute.status).toBe('open')
    expect(requireDeal(db, deal).status).toBe('disputed')
  })

  it('records a decline as declined, and frees the order for the next request', () => {
    const deal = funded()
    const dispute = openDispute(db, deal, 'buyer', 'Damaged')
    const offer = makeDisputeOffer(db, dispute.id, 'seller', 'user:seller', 'update')

    respondDisputeOffer(db, offer.id, 'buyer', 'user:buyer', false, () => {})
    expect(offer.status).toBe('declined')

    expect(() =>
      makeDisputeOffer(db, dispute.id, 'seller', 'user:seller', 'cancellation')
    ).not.toThrow()
  })

  it('settles the deal on an accepted full refund, decided by nobody in particular', () => {
    const deal = funded()
    const dispute = openDispute(db, deal, 'buyer', 'Never arrived')
    const offer = makeDisputeOffer(db, dispute.id, 'seller', 'user:seller', 'full_refund')

    respondDisputeOffer(db, offer.id, 'buyer', 'user:buyer', true, (id, res, note, amt, by) => {
      resolveDispute(db, id, res, note, { refundAmount: amt, decidedBy: by })
    })

    expect(requireDeal(db, deal).status).toBe('refunded')
    expect(dispute.status).toBe('resolved_refunded')
    // The two sides agreed with each other; nobody ruled on it.
    expect(dispute.decided_by).toBe('both-parties')
  })

  it('splits it on an accepted partial refund', () => {
    const deal = funded()
    const dispute = openDispute(db, deal, 'buyer', 'Two days unused')
    const offer = makeDisputeOffer(db, dispute.id, 'seller', 'user:seller', 'partial_refund', {
      amount: 40_000,
    })

    respondDisputeOffer(db, offer.id, 'buyer', 'user:buyer', true, (id, res, note, amt, by) => {
      resolveDispute(db, id, res, note, { refundAmount: amt, decidedBy: by })
    })

    expect(dispute.status).toBe('resolved_split')
    expect(computeDealAmounts(db, deal).refunded).toBe(40_000)
  })

  it('a withdrawn request is not a declined one', () => {
    const deal = funded()
    const dispute = openDispute(db, deal, 'buyer', 'Damaged')
    const offer = makeDisputeOffer(db, dispute.id, 'seller', 'user:seller', 'update')

    withdrawDisputeOffer(db, offer.id, 'user:seller')
    expect(offer.status).toBe('withdrawn')
  })
})

describe('§15 phase 4 — the 48-hour window resolves without a human', () => {
  it('lapses an unanswered request and moves nothing', () => {
    const deal = funded()
    const dispute = openDispute(db, deal, 'buyer', 'Never arrived')
    const offer = makeDisputeOffer(db, dispute.id, 'seller', 'user:seller', 'full_refund')

    advanceClock(49)
    expect(expireDisputeOffers(db)).toBe(1)
    expect(offer.status).toBe('expired')

    // The part worth pinning: silence is not agreement.
    expect(requireDeal(db, deal).status).toBe('disputed')
    expect(dispute.status).toBe('open')
    expect(computeDealAmounts(db, deal).refunded).toBe(0)
  })

  it('leaves nobody recorded as having answered', () => {
    const deal = funded()
    const dispute = openDispute(db, deal, 'buyer', 'Damaged')
    const offer = makeDisputeOffer(db, dispute.id, 'seller', 'user:seller', 'update')

    advanceClock(49)
    expireDisputeOffers(db)

    expect(offer.status).toBe('expired')
    expect(offer.responded_by_actor).toBeNull()
  })

  it('will not let a lapsed request be answered afterwards', () => {
    const deal = funded()
    const dispute = openDispute(db, deal, 'buyer', 'Damaged')
    const offer = makeDisputeOffer(db, dispute.id, 'seller', 'user:seller', 'full_refund')

    advanceClock(49)
    expect(() =>
      respondDisputeOffer(db, offer.id, 'buyer', 'user:buyer', true, () => {})
    ).toThrow(/expired at/)
  })

  it('is idempotent — a second pass expires nothing', () => {
    const deal = funded()
    const dispute = openDispute(db, deal, 'buyer', 'Damaged')
    makeDisputeOffer(db, dispute.id, 'seller', 'user:seller', 'update')

    advanceClock(49)
    expireDisputeOffers(db)
    expect(expireDisputeOffers(db)).toBe(0)
  })

  it('does not lapse one still inside its window', () => {
    const deal = funded()
    const dispute = openDispute(db, deal, 'buyer', 'Damaged')
    makeDisputeOffer(db, dispute.id, 'seller', 'user:seller', 'update')

    advanceClock(47)
    expect(expireDisputeOffers(db)).toBe(0)
  })
})

describe('§8 — the disputed amount bounds the resolution', () => {
  it('refuses a full refund when only part was disputed', () => {
    const deal = funded()
    const dispute = openDispute(db, deal, 'buyer', 'Part of it', {
      disputedAmount: 30_000,
    })

    expect(() => resolve(dispute.id, 'refund', 'All of it')).toThrow(
      /Only 30000 of this payment is in dispute/,
    )
  })

  it('refuses a split larger than what was disputed', () => {
    const deal = funded()
    const dispute = openDispute(db, deal, 'buyer', 'Part of it', {
      disputedAmount: 30_000,
    })

    expect(() =>
      resolve(dispute.id, 'partial_refund', 'Too much', { refundAmount: 50_000 })
    ).toThrow(/more than the 30000 in dispute/)
  })

  it('allows one inside it', () => {
    const deal = funded()
    const dispute = openDispute(db, deal, 'buyer', 'Part of it', {
      disputedAmount: 30_000,
    })

    resolve(dispute.id, 'partial_refund', 'Agreed', { refundAmount: 25_000 })
    expect(computeDealAmounts(db, deal).refunded).toBe(25_000)
  })

  it('treats a dispute naming no amount as the whole payment', () => {
    const deal = funded()
    const dispute = openDispute(db, deal, 'buyer', 'Never arrived')

    resolve(dispute.id, 'refund', 'Buyer wins')
    expect(requireDeal(db, deal).status).toBe('refunded')
  })
})

describe('§8 — conflict of interest', () => {
  it('refuses whoever raised the dispute', () => {
    const deal = funded()
    const dispute = openDispute(db, deal, 'buyer', 'Damaged', {
      actor: 'user:sam@example.com',
    })

    expect(() =>
      resolve(dispute.id, 'release', 'Fine', { decidedBy: 'user:sam@example.com' })
    ).toThrow(/acted for a party in this dispute/)
  })

  it('refuses whoever made a request on it', () => {
    const deal = funded()
    const dispute = openDispute(db, deal, 'buyer', 'Damaged')
    makeDisputeOffer(db, dispute.id, 'seller', 'user:alex@example.com', 'update')

    expect(() =>
      resolve(dispute.id, 'release', 'Fine', { decidedBy: 'user:alex@example.com' })
    ).toThrow(/acted for a party in this dispute/)
  })

  it('refuses whoever answered one', () => {
    const deal = funded()
    const dispute = openDispute(db, deal, 'buyer', 'Damaged')
    const offer = makeDisputeOffer(db, dispute.id, 'seller', 'user:seller', 'update')
    respondDisputeOffer(db, offer.id, 'buyer', 'user:jo@example.com', false, () => {})

    expect(() =>
      resolve(dispute.id, 'release', 'Fine', { decidedBy: 'user:jo@example.com' })
    ).toThrow(/acted for a party in this dispute/)
  })

  it('lets an uninvolved administrator decide, and records them', () => {
    const deal = funded()
    const dispute = openDispute(db, deal, 'buyer', 'Damaged', {
      actor: 'user:sam@example.com',
    })
    makeDisputeOffer(db, dispute.id, 'seller', 'user:alex@example.com', 'update')

    resolve(dispute.id, 'release', 'Seller provided proof', {
      decidedBy: 'user:dana@example.com',
    })

    expect(dispute.status).toBe('resolved_released')
    expect(dispute.decided_by).toBe('user:dana@example.com')
  })

  it('refuses a resolution with no decider at all', () => {
    const deal = funded()
    const dispute = openDispute(db, deal, 'buyer', 'Damaged')

    expect(() =>
      resolveDispute(db, dispute.id, 'release', 'Fine', { decidedBy: '' })
    ).toThrow(/must record who decided it/)
  })

  it('withdraws any request still open when it resolves', () => {
    const deal = funded()
    const dispute = openDispute(db, deal, 'buyer', 'Damaged')
    const offer = makeDisputeOffer(db, dispute.id, 'seller', 'user:seller', 'update')

    resolve(dispute.id, 'release', 'Sorted')
    // Otherwise the next dispute on this order is blocked by a request about a
    // dispute that is over.
    expect(offer.status).toBe('withdrawn')
  })
})

describe('§8 — evidence', () => {
  it('records who filed it and when it was captured', () => {
    const deal = funded()
    const dispute = openDispute(db, deal, 'buyer', 'Damaged')
    const captured = new Date(Date.now() - 2 * 86_400_000).toISOString()

    const e = addDisputeEvidence(db, dispute.id, 'buyer', 'user:buyer', {
      kind: 'inspection_photo',
      description: 'Scratch on the left panel at pickup',
      url: 'https://client.example/a.jpg',
      capturedAt: captured,
    })

    expect(e.kind).toBe('inspection_photo')
    expect(e.captured_at).toBe(captured)
    expect(dispute.evidence).toHaveLength(1)
  })

  it('needs a description — it is what a person and the assistant read', () => {
    const deal = funded()
    const dispute = openDispute(db, deal, 'buyer', 'Damaged')

    expect(() =>
      addDisputeEvidence(db, dispute.id, 'buyer', 'user:buyer', {
        kind: 'photo',
        description: '   ',
      })
    ).toThrow(/needs a description/)
  })

  it('cannot be filed after the dispute is decided', () => {
    const deal = funded()
    const dispute = openDispute(db, deal, 'buyer', 'Damaged')
    resolve(dispute.id, 'release', 'Done')

    expect(() =>
      addDisputeEvidence(db, dispute.id, 'buyer', 'user:buyer', {
        kind: 'photo',
        description: 'Late',
      })
    ).toThrow(/already resolved/)
  })
})

describe('§8 — the timeline', () => {
  it('carries the opening, the requests, the evidence and the decision, in order', () => {
    const deal = funded()
    const dispute = openDispute(db, deal, 'buyer', 'Damaged', {
      actor: 'user:buyer@example.com',
    })
    addDisputeEvidence(db, dispute.id, 'buyer', 'user:buyer@example.com', {
      kind: 'photo',
      description: 'The damage',
    })
    const offer = makeDisputeOffer(db, dispute.id, 'seller', 'user:seller', 'partial_refund', {
      amount: 20_000,
    })
    respondDisputeOffer(db, offer.id, 'buyer', 'user:buyer@example.com', false, () => {})
    resolve(dispute.id, 'release', 'Proof accepted')

    const kinds = disputeTimeline(db, dispute.id).map((e) => e.kind)
    expect(kinds).toContain('dispute_opened')
    expect(kinds).toContain('evidence_photo')
    expect(kinds).toContain('offer_partial_refund')
    expect(kinds).toContain('offer_declined')
    expect(kinds).toContain('resolved')

    const times = disputeTimeline(db, dispute.id).map((e) => Date.parse(e.at))
    expect(times).toEqual([...times].sort((a, b) => a - b))
  })
})
