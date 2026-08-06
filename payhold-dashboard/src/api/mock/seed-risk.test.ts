/**
 * The fixtures the Fraud screen is read against.
 *
 * A demo whose fraud screen is empty teaches the wrong thing twice: that the
 * rules never fire, and that the screen has nothing on it worth looking at. So
 * the seed screens its due payouts through the real rules, and these are the
 * assertions that the result is a *real* hold rather than a hand-written row —
 * the wording has to be `risk.ts`'s own, and the payout has to be stopped in
 * the only way a rule is allowed to stop one.
 */

import { describe, expect, it } from 'vitest'
import { seedDb } from './seed'
import { payoutFindings } from './risk'

describe('seeded risk fixtures', () => {
  it('holds a payout for review, so the Fraud screen has a row', () => {
    const db = seedDb()
    const held = db.payouts.filter((p) => p.status === 'held_for_review')

    expect(held.length).toBeGreaterThan(0)
    for (const payout of held) {
      // A hold is a wait, never a loss: nothing left, and no person has signed
      // for it yet.
      expect(payout.paid_at).toBeNull()
      expect(payout.review_held_at).not.toBeNull()
      expect(payout.review_approved_by).toBeNull()
      expect(
        db.ledger.some(
          (e) => e.deal_id === payout.deal_id && e.entry_type === 'payout',
        ),
      ).toBe(false)
    }
  })

  it('records the signal the rules actually produce, not a copy of it', () => {
    const db = seedDb()
    const payout = db.payouts.find((p) => p.status === 'held_for_review')!
    const cfg = db.settings.find((s) => s.tenant_id === payout.tenant_id)!

    const signals = db.risk_signals.filter((s) => s.deal_id === payout.deal_id)
    expect(signals.length).toBeGreaterThan(0)

    // Re-deriving from the same tables must reproduce the stored wording. If it
    // does not, a fixture has drifted from the rule it illustrates.
    const rerun = payoutFindings(db, { ...payout, status: 'scheduled' }, cfg)
    expect(rerun.map((f) => f.explanation)).toEqual(
      expect.arrayContaining(signals.map((s) => s.explanation)),
    )
  })

  it('names a seller and a buyer, so a reviewer can open both', () => {
    const db = seedDb()
    const payout = db.payouts.find((p) => p.status === 'held_for_review')!

    expect(db.sellers.some((s) => s.id === payout.seller_id)).toBe(true)
    expect(db.deals.find((d) => d.id === payout.deal_id)?.buyer_ref).toBeTruthy()
  })
})
