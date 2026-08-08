/**
 * Payout retry with capped backoff — spec §13.
 *
 * The mirror of `payhold-backend/tests/payout-retry.test.ts`, and the claim is
 * the same one twice: a refused transfer is re-sent on a ladder rather than on
 * every pass, and when the budget is spent nothing automatic touches it again.
 *
 * The mechanism is `next_attempt_at`, and **null is the interesting value** —
 * it means no machine may try this payout, which is how "then move to blocked
 * for operator action" is said without a second status meaning "blocked, but
 * really blocked". The retry and approve buttons go through the same
 * `dispatchPayout` on purpose: a person is not a machine.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import type { Payout } from '../types'
import {
  confirmDeal,
  fundDeal,
  refundDeal,
  retryPayout,
  runCron,
  settingsFor,
} from './engine'
import { seedDb } from './seed'
import { advanceClock, loadDb, now, resetDb, type MockDb } from './store'

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

/**
 * A deal released and past its clearance window, with nothing attempted yet.
 *
 * Deliberately does *not* run the cron: the first dispatch is the thing under
 * test here, and a helper that quietly paid the seller first would leave every
 * case below testing a retry of a payout that had already gone.
 */
function releaseToPayout(dealId: string): Payout {
  fundDeal(db, dealId)
  confirmDeal(db, dealId, 'buyer')
  confirmDeal(db, dealId, 'seller')
  advanceClock(24 * 30)

  const payout = db.payouts.find((p) => p.deal_id === dealId)
  if (!payout) throw new Error('release did not queue a payout')
  return payout
}

/**
 * One cron pass in which the provider refuses *this* payout.
 *
 * The other payouts are parked for the duration, and that is a limitation of
 * the dev-panel lever rather than of the engine: `fail_next_payout` is one flag
 * and the first payout dispatched in the pass consumes it, so the fixture
 * account's own due payouts would eat it before this one was reached. Parking
 * them uses the same clock the backoff does — a null `next_attempt_at` is
 * exactly "no machine may try this now".
 */
function failOnce(payout: Payout): void {
  const others = db.payouts.filter((p) => p.id !== payout.id)
  const parked = others.map((p) => p.next_attempt_at)
  for (const other of others) other.next_attempt_at = null

  db.fail_next_payout = true
  // Due now. The clock is what the pass filters on, so a payout still inside
  // its backoff would simply be skipped — which is the behaviour under test,
  // not a way around it.
  payout.next_attempt_at = new Date(now().getTime() - 1000).toISOString()
  runCron(db)

  others.forEach((other, i) => {
    other.next_attempt_at = parked[i] ?? null
  })
}

/**
 * Minutes until the next attempt, rounded, on the **simulated** clock — which
 * is the one the engine schedules against. Measuring against the real one
 * reads the whole 30-day `advanceClock` as part of the backoff.
 */
function waitMinutes(payout: Payout): number | null {
  if (payout.next_attempt_at === null) return null
  return Math.round((Date.parse(payout.next_attempt_at) - now().getTime()) / 60_000)
}

describe('the backoff ladder', () => {
  it('waits longer after each refusal, and the wait is capped', () => {
    settingsFor(db, AUTOHIRE).payout_retry_max_attempts = 9

    const payout = releaseToPayout(newDeal())
    const waits: (number | null)[] = []
    for (let i = 0; i < 5; i += 1) {
      failOnce(payout)
      waits.push(waitMinutes(payout))
    }

    expect(waits).toEqual([1, 5, 30, 120, 120])
    expect(payout.status).toBe('failed')
  })

  it('a payout waiting out its backoff is not attempted again', () => {
    const payout = releaseToPayout(newDeal())
    failOnce(payout)

    const attempts = payout.attempts
    runCron(db)

    expect(payout.attempts).toBe(attempts)
    expect(payout.status).toBe('failed')
  })

  it('and is attempted again once the wait is over', () => {
    const payout = releaseToPayout(newDeal())
    failOnce(payout)

    advanceClock(1)
    runCron(db)

    expect(payout.status).toBe('paid')
  })
})

describe('when the budget is spent', () => {
  function exhaust(payout: Payout, max = 5): void {
    for (let i = 0; i < max; i += 1) failOnce(payout)
  }

  it('the payout is blocked with no clock', () => {
    const payout = releaseToPayout(newDeal())
    exhaust(payout)

    expect(payout.status).toBe('blocked')
    expect(payout.attempts).toBe(5)
    expect(payout.next_attempt_at).toBeNull()
    expect(payout.failure_reason).toMatch(/no further automatic attempts after 5 tries/)
  })

  it('and cron leaves it alone from then on', () => {
    // This is the whole point of the null: `blocked` is otherwise dispatchable,
    // because §5.1's no-route case is re-asked every pass and the answer can
    // change without anyone doing anything. A rail that refused us five times
    // is not that.
    const payout = releaseToPayout(newDeal())
    exhaust(payout)

    const attempts = payout.attempts
    advanceClock(24)
    runCron(db)

    expect(payout.attempts).toBe(attempts)
    expect(payout.status).toBe('blocked')
  })

  it('says so in the audit log, separately from the failure', () => {
    const payout = releaseToPayout(newDeal())
    exhaust(payout)

    expect(
      db.audit.filter(
        (a) => a.deal_id === payout.deal_id && a.action === 'payout.retries_exhausted',
      ),
    ).toHaveLength(1)
  })

  it('a tenant can narrow the budget', () => {
    settingsFor(db, AUTOHIRE).payout_retry_max_attempts = 2

    const payout = releaseToPayout(newDeal())
    failOnce(payout)
    expect(payout.status).toBe('failed')
    failOnce(payout)
    expect(payout.status).toBe('blocked')
  })

  it('a budget of zero still buys one attempt', () => {
    // Otherwise the first transient error a rail has blocks every payout on the
    // account, which is a setting nobody would choose on purpose.
    settingsFor(db, AUTOHIRE).payout_retry_max_attempts = 0

    const payout = releaseToPayout(newDeal())
    failOnce(payout)

    expect(payout.status).toBe('blocked')
  })
})

describe('a person putting the clock back', () => {
  it('sends an exhausted payout, and does not spend the counter to do it', () => {
    const payout = releaseToPayout(newDeal())
    for (let i = 0; i < 5; i += 1) failOnce(payout)
    expect(payout.next_attempt_at).toBeNull()

    retryPayout(db, payout.id)

    expect(payout.status).toBe('paid')
    // The counter is untouched deliberately: `routePayout` reads it to decide
    // whether the seller's verified backup destination may be used, and zeroing
    // it would send the next attempt back to the primary that has been failing.
    expect(payout.attempts).toBeGreaterThanOrEqual(5)
  })

  it('is recorded as a request by a person', () => {
    const payout = releaseToPayout(newDeal())
    failOnce(payout)
    retryPayout(db, payout.id)

    expect(
      db.audit.some(
        (a) => a.deal_id === payout.deal_id && a.action === 'payout.retry_requested',
      ),
    ).toBe(true)
  })

  it('one more attempt, not a fresh series', () => {
    // The clock goes back so the machine can see it again; the budget does not.
    // If this attempt fails too, nothing about the destination has changed and
    // it is exhausted again immediately.
    const payout = releaseToPayout(newDeal())
    for (let i = 0; i < 5; i += 1) failOnce(payout)

    db.fail_next_payout = true
    retryPayout(db, payout.id)

    expect(payout.status).toBe('blocked')
    expect(payout.next_attempt_at).toBeNull()
  })
})

describe('a deal that is over stops being retried', () => {
  it('a refunded deal cancels the payout and clears its clock', () => {
    // `refundDeal` cancels a scheduled payout by writing `failed`. That was
    // inert while `failed` was undispatchable; the cleared clock is what keeps
    // the cron from re-attempting a transfer nobody is owed.
    const payout = releaseToPayout(newDeal())
    refundDeal(db, payout.deal_id, 'Buyer cancelled')

    expect(payout.status).toBe('failed')
    expect(payout.next_attempt_at).toBeNull()

    const attempts = payout.attempts
    advanceClock(24)
    runCron(db)

    expect(payout.attempts).toBe(attempts)
  })
})
