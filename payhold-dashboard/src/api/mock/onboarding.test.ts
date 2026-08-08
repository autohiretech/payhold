/**
 * §12's seller onboarding, from the dashboard's side of the seam.
 *
 * The mirror of `payhold-backend/tests/seller-onboarding.test.ts` for the two
 * things Phase 10 put on a screen: `sellerCapabilities`, which is what the
 * onboarding card renders, and `verifySeller`, which is what its button calls.
 *
 * The property worth pinning is that these are **the same arithmetic as the
 * gate**. A capabilities read that disagreed with `screen_payout` would be a
 * page telling a seller they are fine while their payout sits held, which is
 * precisely the failure §10.1's endpoint exists to prevent — so the tests check
 * the two against each other rather than against a hand-written list.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { PayHoldError } from '../types'
import {
  confirmDeal,
  fundDeal,
  requireDeal,
  runCron,
  sellerCapabilities,
  sellerEligibility,
  verifySeller,
} from './engine'
import { primaryDestination } from './routing'
import { seedDb } from './seed'
import { advanceClock, loadDb, resetDb, type MockDb } from './store'

const AUTOHIRE = 'ten_0001'

let db: MockDb

beforeEach(() => {
  localStorage.clear()
  db = resetDb(seedDb)
  loadDb(seedDb)
})

/** An unfunded deal whose seller we can put into any onboarding state. */
function newDeal(): string {
  const deal = db.deals.find(
    (d) => d.status === 'created' && d.tenant_id === AUTOHIRE && !d.deposit_amount,
  )
  if (!deal) throw new Error('fixture missing an unfunded deal')
  return deal.id
}

/** Put a seller back where a freshly registered one starts. */
function unverify(sellerId: string) {
  const seller = db.sellers.find((s) => s.id === sellerId)!
  seller.kyc_status = 'pending'
  seller.sanctions_checked_at = null
  primaryDestination(db, sellerId)!.verified_at = null
}

/** Drive one deal all the way to a scheduled payout. */
function payoutFor(sellerId: string) {
  const dealId = newDeal()
  requireDeal(db, dealId).seller_id = sellerId

  fundDeal(db, dealId, 'mobile_money', 'MTN')
  confirmDeal(db, dealId, 'buyer')
  confirmDeal(db, dealId, 'seller')
  advanceClock(24 * 20)
  runCron(db)

  return db.payouts.find((p) => p.deal_id === dealId)!
}

// ---------------------------------------------------------------------------

describe('seller capabilities — §10.1', () => {
  it('tells a fresh seller everything that is missing, not just the first', () => {
    const seller = db.sellers.find((s) => s.tenant_id === AUTOHIRE)!
    unverify(seller.id)

    const capabilities = sellerCapabilities(db, seller.id)

    expect(capabilities.can_receive_payouts).toBe(false)
    expect(capabilities.kyc_status).toBe('pending')
    expect(capabilities.reasons).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/not verified/),
        expect.stringMatching(/[Ss]anctions screening has not been run/),
        expect.stringMatching(/destination has not been verified/),
      ]),
    )
  })

  it('asks exactly the questions the gate holds a payout for', () => {
    // The whole point of the endpoint. If these two ever diverge, a seller is
    // shown a clean page and then discovers a held payout three weeks later.
    const seller = db.sellers.find((s) => s.tenant_id === AUTOHIRE)!
    unverify(seller.id)

    expect(sellerCapabilities(db, seller.id).reasons).toEqual(
      sellerEligibility(db, seller.id),
    )
  })

  it('keeps a routing failure out of `reasons`', () => {
    // §5.2's second case: a verified seller on a rail we cannot reach must be
    // told *that*, not told to verify themselves again. A routing reason in the
    // first list would hold the payout as `needs_verification` and hide it from
    // the routing engine entirely.
    const seller = db.sellers.find((s) => s.tenant_id === AUTOHIRE)!
    verifySeller(db, seller.id, 'compliance@payhold', true)

    const destination = primaryDestination(db, seller.id)!
    destination.payout_provider = 'venmo'

    const capabilities = sellerCapabilities(db, seller.id)

    expect(capabilities.reasons).toEqual([])
    expect(capabilities.route_reasons.length).toBeGreaterThan(0)
    expect(capabilities.can_receive_payouts).toBe(false)
  })

  it('says a verified, routable seller can be paid', () => {
    const seller = db.sellers.find((s) => s.tenant_id === AUTOHIRE)!
    verifySeller(db, seller.id, 'compliance@payhold', true)
    // The attestation stamps the destination; a recent move is the one thing
    // left that would still hold them.
    seller.destination_changed_at = null

    const capabilities = sellerCapabilities(db, seller.id)

    expect(capabilities.reasons).toEqual([])
    expect(capabilities.route_reasons).toEqual([])
    expect(capabilities.can_receive_payouts).toBe(true)
  })
})

describe('verifying a seller — §12', () => {
  it('refuses to record an attestation nobody made', () => {
    const seller = db.sellers.find((s) => s.tenant_id === AUTOHIRE)!
    unverify(seller.id)

    expect(() => verifySeller(db, seller.id, '   ', true)).toThrow(PayHoldError)
    expect(seller.kyc_status).toBe('pending')
  })

  it('moves three things together, because a caller would get one wrong', () => {
    const seller = db.sellers.find((s) => s.tenant_id === AUTOHIRE)!
    unverify(seller.id)

    verifySeller(db, seller.id, 'grace@autohire.rw', true)

    expect(seller.kyc_status).toBe('verified')
    expect(seller.sanctions_checked_at).not.toBeNull()
    expect(primaryDestination(db, seller.id)!.verified_at).not.toBeNull()
  })

  it('records who made it', () => {
    const seller = db.sellers.find((s) => s.tenant_id === AUTOHIRE)!
    verifySeller(db, seller.id, 'grace@autohire.rw', true)

    const entry = db.audit.find(
      (a) =>
        a.action === 'seller.verified' &&
        (a.details as { seller_id?: string }).seller_id === seller.id,
    )
    expect(entry?.actor).toBe('grace@autohire.rw')
  })

  it('does not restart the clock on a destination already verified', () => {
    const seller = db.sellers.find((s) => s.tenant_id === AUTOHIRE)!
    verifySeller(db, seller.id, 'grace@autohire.rw', true)
    const first = primaryDestination(db, seller.id)!.verified_at

    advanceClock(48)
    verifySeller(db, seller.id, 'grace@autohire.rw', true)

    expect(primaryDestination(db, seller.id)!.verified_at).toBe(first)
  })

  it('withdrawing a verification holds their payouts again', () => {
    const seller = db.sellers.find((s) => s.tenant_id === AUTOHIRE)!
    verifySeller(db, seller.id, 'grace@autohire.rw', true)
    seller.destination_changed_at = null

    verifySeller(db, seller.id, 'grace@autohire.rw', false)

    expect(seller.kyc_status).toBe('review_required')
    expect(sellerCapabilities(db, seller.id).can_receive_payouts).toBe(false)

    // And the gate, not just the read, has to agree — an approval nobody can
    // give is the point of `needs_verification`.
    expect(payoutFor(seller.id).status).toBe('needs_verification')
  })

  it('moves nothing', () => {
    // Invariant 11's shape, applied to the attestation: it changes who may be
    // paid and pays nobody. No ledger entry, no payout status, no deal.
    const seller = db.sellers.find((s) => s.tenant_id === AUTOHIRE)!
    const before = JSON.stringify({
      ledger: db.ledger,
      payouts: db.payouts,
      deals: db.deals,
    })

    verifySeller(db, seller.id, 'grace@autohire.rw', true)

    expect(
      JSON.stringify({ ledger: db.ledger, payouts: db.payouts, deals: db.deals }),
    ).toBe(before)
  })
})
