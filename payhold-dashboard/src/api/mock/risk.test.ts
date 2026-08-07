/**
 * The deterministic risk rules, and the line they sit on.
 *
 * Two claims are being made here and both are load-bearing:
 *
 *   a rule can stop a payout, and nothing else — it cannot send one, release a
 *   deal, or refund one; and
 *
 *   a held payout moves only when a person approves it. Not cron, not a retry,
 *   not a second run of the rules.
 *
 * The rest is bookkeeping around those two.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { PayHoldError, type Payout } from '../types'
import {
  approvePayoutReview,
  confirmDeal,
  fundDeal,
  holdPayout,
  requireDeal,
  retryPayout,
  runCron,
  settingsFor,
} from './engine'
import { payoutFindings } from './risk'
import { seedPrimaryDestination } from './routing'
import { seedDb } from './seed'
import { advanceClock, loadDb, nowIso, resetDb, type MockDb } from './store'

const AUTOHIRE = 'ten_0001'

let db: MockDb

beforeEach(() => {
  localStorage.clear()
  db = resetDb(seedDb)
  loadDb(seedDb)
})

function newDeal(): string {
  const deal = db.deals.find(
    (d) => d.status === 'created' && d.tenant_id === AUTOHIRE && !d.deposit_amount,
  )
  if (!deal) throw new Error('fixture missing an unfunded deal')
  return deal.id
}

/** Run a deal to the point where its payout is about to be dispatched. */
function releaseToPayout(dealId: string): Payout {
  fundDeal(db, dealId)
  confirmDeal(db, dealId, 'buyer')
  confirmDeal(db, dealId, 'seller')
  advanceClock(24 * 30)
  runCron(db)

  const payout = db.payouts.find((p) => p.deal_id === dealId)
  if (!payout) throw new Error('release did not queue a payout')
  return payout
}

/**
 * Point a deal at a seller who registered a day before taking it — a
 * destination we have never sent to, which is the pattern the rules exist for.
 */
function useBrandNewSeller(dealId: string): string {
  const deal = requireDeal(db, dealId)
  const template = db.sellers.find((s) => s.tenant_id === AUTOHIRE)!
  const seller = {
    ...template,
    id: 'sel_brand_new',
    name: 'Freshly Registered Ltd',
    beneficiary_token: 'ben_fw_new',
    masked_destination: 'MTN •••• 9999',
    created_at: new Date(
      new Date(deal.created_at).getTime() - 86_400_000,
    ).toISOString(),
  }
  db.sellers.push(seller)
  // A seller arrives with their destination or not at all — the mirror of
  // `sellers_seed_primary_destination`. Verified, because these tests are about
  // the discretionary rules; §12's gate has its own suite below and would
  // otherwise stop every payout here before a rule got to look at it.
  seedPrimaryDestination(db, seller).verified_at = seller.created_at
  deal.seller_id = seller.id
  return seller.id
}

describe('a rule can hold a payout', () => {
  it('holds the first payout to a seller registered days ago', () => {
    const id = newDeal()
    useBrandNewSeller(id)

    const payout = releaseToPayout(id)

    expect(payout.status).toBe('held_for_review')
    expect(payout.review_held_at).toBeTruthy()
    expect(payout.paid_at).toBeNull()
    expect(requireDeal(db, id).status).toBe('released')
  })

  it('records why, in terms someone can check', () => {
    const id = newDeal()
    useBrandNewSeller(id)
    releaseToPayout(id)

    const signals = db.risk_signals.filter((s) => s.deal_id === id)
    const blocking = signals.filter((s) => s.severity === 'review')

    expect(blocking.length).toBeGreaterThan(0)
    expect(blocking[0]!.explanation).toBeTruthy()
    expect(blocking[0]!.value).toMatchObject({ prior_payouts: 0 })
  })

  it('holds when the seller lost a dispute recently', () => {
    const id = newDeal()
    const deal = requireDeal(db, id)

    // A dispute resolved in the buyer's favour, against this seller, today.
    const otherDeal = db.deals.find(
      (d) => d.seller_id === deal.seller_id && d.id !== id,
    )!
    db.disputes.push({
      id: 'dsp_recent_loss',
      tenant_id: AUTOHIRE,
      deal_id: otherDeal.id,
      raised_by: 'buyer',
      reason: 'Vehicle never arrived',
      counter_statement: null,
      evidence: [],
      status: 'resolved_refunded',
      opened_at: nowIso(),
      resolved_at: nowIso(),
      resolution_note: 'Refunded',
    })

    expect(releaseToPayout(id).status).toBe('held_for_review')
  })

  it('lets an ordinary payout through untouched', () => {
    const id = newDeal()
    const payout = releaseToPayout(id)

    expect(payout.status).toBe('paid')
    expect(requireDeal(db, id).status).toBe('paid_out')
  })
})

describe('only a person releases a hold', () => {
  function heldPayout(): Payout {
    const id = newDeal()
    useBrandNewSeller(id)
    return releaseToPayout(id)
  }

  it('is not dispatched by a later cron pass', () => {
    const payout = heldPayout()

    advanceClock(24 * 14)
    runCron(db)

    expect(payout.status).toBe('held_for_review')
  })

  it('cannot be sent by retrying it', () => {
    const payout = heldPayout()

    expect(() => retryPayout(db, payout.id)).toThrow(/held for review/i)
    expect(payout.status).toBe('held_for_review')
  })

  it('goes out on approval, recorded against the approver', () => {
    const payout = heldPayout()

    approvePayoutReview(db, payout.id, 'admin@autohiretech.com')

    expect(payout.status).toBe('paid')
    expect(payout.review_approved_by).toBe('admin@autohiretech.com')
    expect(
      db.audit.some(
        (a) =>
          a.action === 'payout.review_approved' &&
          a.actor === 'admin@autohiretech.com',
      ),
    ).toBe(true)
  })

  it('does not re-hold what a person already approved', () => {
    const payout = heldPayout()
    approvePayoutReview(db, payout.id, 'admin@autohiretech.com')

    // The rules would still fire — the seller is still new. A second screening
    // that overruled the human would make approval meaningless.
    expect(payout.status).toBe('paid')
  })

  it('refuses to approve a payout that was never held', () => {
    const id = newDeal()
    const payout = releaseToPayout(id)

    expect(() => approvePayoutReview(db, payout.id, 'admin')).toThrow(PayHoldError)
  })
})

describe('the rules are configuration, not code', () => {
  it('records signals but holds nothing when a tenant turns them off', () => {
    settingsFor(db, AUTOHIRE).risk_rules_enabled = false

    const id = newDeal()
    useBrandNewSeller(id)
    const payout = releaseToPayout(id)

    expect(payout.status).toBe('paid')
    // Still noticed, still written down. The history is what a fraud model of
    // our own trains on later, and it cannot be reconstructed after the fact.
    expect(db.risk_signals.filter((s) => s.deal_id === id).length).toBeGreaterThan(0)
  })

  it('reads the threshold from settings rather than a constant', () => {
    const id = newDeal()
    const deal = requireDeal(db, id)
    fundDeal(db, id)
    confirmDeal(db, id, 'buyer')
    confirmDeal(db, id, 'seller')

    const payout = db.payouts.find((p) => p.deal_id === id)!
    const cfg = settingsFor(db, AUTOHIRE)

    // Below the tenant's threshold, an established seller is unremarkable.
    expect(payoutFindings(db, payout, cfg).some((f) => f.severity === 'review')).toBe(
      false,
    )

    // Drop the threshold under this payout and the same facts now warrant a
    // look — nothing about the deal changed, only the tenant's policy. This
    // deal was funded and released in the same breath, which is unremarkable
    // for a small booking and worth a glance for a large one.
    const tiny = { ...cfg, risk_review_threshold_usd: 1 }
    const findings = payoutFindings(db, payout, tiny)

    expect(findings.some((f) => f.severity === 'review')).toBe(true)
    expect(findings.map((f) => f.signal)).toContain('fast_release')
    expect(deal.amount).toBeGreaterThan(0)
  })
})

describe('rules cannot move money', () => {
  it('never releases, refunds or pays out on its own', () => {
    const id = newDeal()
    useBrandNewSeller(id)

    const entries = () => db.ledger.filter((e) => e.deal_id === id)

    fundDeal(db, id)
    confirmDeal(db, id, 'buyer')
    confirmDeal(db, id, 'seller')
    advanceClock(24 * 30)

    // Count this deal's entries only: the same cron pass legitimately settles
    // other fixtures, and a global count would measure them instead.
    const afterRelease = entries().length
    runCron(db)

    // The hold happened during that pass. Nothing was written for this deal,
    // because nothing left.
    expect(entries().length).toBe(afterRelease)
    expect(entries().some((e) => e.entry_type === 'payout')).toBe(false)
  })

  it('leaves the deal in released, not some risk-specific state', () => {
    const id = newDeal()
    useBrandNewSeller(id)
    releaseToPayout(id)

    expect(requireDeal(db, id).status).toBe('released')
  })
})

/**
 * A person stopping one payout.
 *
 * The narrow lever beside the account-wide freeze. It is the acceptance spec
 * for `hold_payout` in `20260806000006_manual_hold.sql`, and its shape argues
 * one thing: a person may stop, in the same safe direction a rule may, and
 * unlike a rule they have to sign it.
 */
describe('a person can hold one payout', () => {
  /** A deal run to a payout that nothing has stopped. */
  function scheduledPayout(): Payout {
    const id = newDeal()
    fundDeal(db, id)
    confirmDeal(db, id, 'buyer')
    confirmDeal(db, id, 'seller')
    advanceClock(24 * 8)

    const payout = db.payouts.find((p) => p.deal_id === id)
    if (!payout) throw new Error('release did not queue a payout')
    return payout
  }

  it('stops it, and says who and why', () => {
    const payout = scheduledPayout()
    holdPayout(db, payout.id, 'grace@autohire.rw', 'Seller unreachable by phone')

    expect(payout.status).toBe('held_for_review')
    expect(payout.review_held_by).toBe('grace@autohire.rw')
    expect(payout.review_hold_reason).toBe('Seller unreachable by phone')
  })

  it('moves no money — the same guarantee a rule hold carries', () => {
    const payout = scheduledPayout()
    const entries = () => db.ledger.filter((e) => e.deal_id === payout.deal_id)
    const before = entries().length

    holdPayout(db, payout.id, 'grace@autohire.rw', 'Checking with the buyer')

    expect(entries().length).toBe(before)
    expect(entries().some((e) => e.entry_type === 'payout')).toBe(false)
  })

  it('is attributable — no name and no reason are both refused', () => {
    const payout = scheduledPayout()

    expect(() => holdPayout(db, payout.id, '  ', 'because')).toThrow(PayHoldError)
    expect(() => holdPayout(db, payout.id, 'grace@autohire.rw', '')).toThrow(PayHoldError)
    expect(payout.status).toBe('scheduled')
  })

  it('cannot stop money that has already gone', () => {
    const payout = scheduledPayout()
    runCron(db)
    expect(payout.status).toBe('paid')

    expect(() => holdPayout(db, payout.id, 'grace@autohire.rw', 'too late')).toThrow(
      /already been sent/i,
    )
  })

  it('survives a cron pass, exactly as a rule hold does', () => {
    const payout = scheduledPayout()
    holdPayout(db, payout.id, 'grace@autohire.rw', 'Checking with the buyer')

    advanceClock(24 * 14)
    runCron(db)

    expect(payout.status).toBe('held_for_review')
  })

  it('is cleared through the same door, and remembers who stopped it', () => {
    const payout = scheduledPayout()
    holdPayout(db, payout.id, 'grace@autohire.rw', 'Checking with the buyer')
    approvePayoutReview(db, payout.id, 'owner@autohire.rw')

    expect(payout.status).toBe('paid')
    expect(payout.review_approved_by).toBe('owner@autohire.rw')
    // Both halves are the record: who stopped it, and who let it go.
    expect(payout.review_held_by).toBe('grace@autohire.rw')
  })

  it('records the decision against the person, with their reason', () => {
    const payout = scheduledPayout()
    holdPayout(db, payout.id, 'grace@autohire.rw', 'Seller unreachable by phone')

    const row = db.audit.find(
      (a) => a.deal_id === payout.deal_id && a.action === 'payout.held_by_person',
    )
    expect(row?.actor).toBe('grace@autohire.rw')
    expect(row?.details.reason).toBe('Seller unreachable by phone')
  })

  it('tells the client, on the same event a rule hold sends', () => {
    const payout = scheduledPayout()
    holdPayout(db, payout.id, 'grace@autohire.rw', 'Checking with the buyer')

    // A client cannot act on the difference between a rule stopping a payout
    // and a person stopping it — either way their seller is not paid today.
    expect(
      db.webhook_deliveries.some(
        (d) => d.deal_id === payout.deal_id && d.event === 'payout.held_for_review',
      ),
    ).toBe(true)
  })
})

describe('the eligibility gate — §12', () => {
  it('an unverified seller cannot be paid, whatever the rules setting says', () => {
    const deal = db.deals.find(
      (d) => d.status === 'created' && d.tenant_id === AUTOHIRE && !d.deposit_amount,
    )!
    const id = deal.id

    // This deal's own seller — the fixtures have several, and mutating the
    // wrong one tests nothing.
    db.sellers.find((s) => s.id === deal.seller_id)!.kyc_status = 'pending'

    // The distinction this phase turns on: the discretionary rules are
    // arithmetic a tenant may decline to act on; eligibility is not.
    settingsFor(db, AUTOHIRE).risk_rules_enabled = false

    fundDeal(db, id)
    confirmDeal(db, id, 'buyer')
    confirmDeal(db, id, 'seller')
    advanceClock(24 * 30)
    runCron(db)

    const payout = db.payouts.find((p) => p.deal_id === id)!
    // §5.1 gave the gate its own status. `held_for_review` is a queue an
    // operator can clear; this is not one, deliberately — see below.
    expect(payout.status).toBe('needs_verification')
    // Null means arithmetic did it, not a person — invariant 11's distinction.
    expect(payout.review_held_by).toBeNull()
  })

  it('an operator cannot approve past the gate, and a retry cannot skip it', () => {
    // §12's sentence, made structural. While eligibility produced
    // `held_for_review`, "we have never verified this seller" sat in the same
    // queue as "this payout is unusually large", and the approve button cleared
    // both. The way out is a verification with somebody's name on it.
    const deal = db.deals.find(
      (d) => d.status === 'created' && d.tenant_id === AUTOHIRE && !d.deposit_amount,
    )!
    db.sellers.find((s) => s.id === deal.seller_id)!.kyc_status = 'pending'

    fundDeal(db, deal.id)
    confirmDeal(db, deal.id, 'buyer')
    confirmDeal(db, deal.id, 'seller')
    advanceClock(24 * 30)
    runCron(db)

    const payout = db.payouts.find((p) => p.deal_id === deal.id)!
    expect(() => approvePayoutReview(db, payout.id, 'admin')).toThrow(PayHoldError)
    expect(() => retryPayout(db, payout.id)).toThrow(/outstanding/i)
    expect(payout.status).toBe('needs_verification')
  })

  it('verifying the seller puts the payout back in the queue by itself', () => {
    // The other half of the same decision. `needs_verification` is
    // machine-recoverable — a rule that re-screens and finds the reason gone is
    // not *sending* anything, so invariant 11 is untouched — and it has to be,
    // or a verified seller would sit in a state no pass would ever move.
    const deal = db.deals.find(
      (d) => d.status === 'created' && d.tenant_id === AUTOHIRE && !d.deposit_amount,
    )!
    const seller = db.sellers.find((s) => s.id === deal.seller_id)!
    seller.kyc_status = 'pending'

    fundDeal(db, deal.id)
    confirmDeal(db, deal.id, 'buyer')
    confirmDeal(db, deal.id, 'seller')
    advanceClock(24 * 30)
    runCron(db)

    const payout = db.payouts.find((p) => p.deal_id === deal.id)!
    expect(payout.status).toBe('needs_verification')

    seller.kyc_status = 'verified'
    runCron(db)

    expect(payout.status).toBe('paid')
  })

  it('an earlier approval does not skip the eligibility gate', () => {
    // The hole the gate inherited when it landed above `screenPayout`'s
    // approval short-circuit. That early return was right while everything
    // below it was a discretionary rule; a seller whose verification was
    // revoked after an approval would otherwise have been paid.
    const id = newDeal()
    const sellerId = useBrandNewSeller(id)
    const payout = releaseToPayout(id)
    expect(payout.status).toBe('held_for_review')

    // Approving normally dispatches, so the tenant is frozen first: the
    // approval is recorded and the money stays put, which is the only state in
    // which "approved but not yet sent" is observable.
    db.tenants.find((t) => t.id === AUTOHIRE)!.status = 'payouts_frozen'
    approvePayoutReview(db, payout.id, 'admin@autohiretech.com')
    expect(payout.review_approved_by).toBe('admin@autohiretech.com')
    expect(payout.status).toBe('frozen')

    db.sellers.find((s) => s.id === sellerId)!.kyc_status = 'restricted'
    db.tenants.find((t) => t.id === AUTOHIRE)!.status = 'active'
    runCron(db)

    expect(payout.status).toBe('needs_verification')
  })
})
