/**
 * §10.1 and §15 phase 2 — hosted checkout sessions.
 *
 * The mirror of `payhold-backend/tests/checkout-sessions.test.ts`. The first
 * suite is the acceptance criterion and the reason the file exists: *"test
 * payments cannot be marked successful without verified provider events."* That
 * already held before sessions, so what is tested here is that a session did not
 * become the way around it.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { PayHoldError } from '../types'
import { requireDeal } from './engine'
import {
  cancelCheckoutSession,
  checkoutSessionState,
  completeCheckoutSession,
  openCheckoutSession,
  sessionByToken,
} from './checkout'
import { seedDb } from './seed'
import { advanceClock, loadDb, resetDb, type MockDb } from './store'

const AUTOHIRE = 'ten_0001'

let db: MockDb

beforeEach(() => {
  localStorage.clear()
  db = resetDb(seedDb)
  loadDb(seedDb)
})

/** An unfunded deal, which is the only kind a payment link can be issued for. */
function newDeal(): string {
  const deal = db.deals.find(
    (d) => d.status === 'created' && d.tenant_id === AUTOHIRE && !d.deposit_amount,
  )
  if (!deal) throw new Error('fixture missing an unfunded deal')
  return deal.id
}

function complete(sessionId: string) {
  return completeCheckoutSession(db, sessionId, {
    method: 'card',
    network: 'Visa',
    provider: 'flutterwave',
    providerRef: 'flw_ref_1',
    paymentLink: 'https://pay/x',
  })
}

// ---------------------------------------------------------------------------
// §15 phase 2
// ---------------------------------------------------------------------------

describe('§15 phase 2 — a session cannot mark a payment successful', () => {
  it('completing one leaves the deal at payment_pending, never funded', () => {
    const id = newDeal()
    const session = openCheckoutSession(db, id)

    expect(requireDeal(db, id).status).toBe('checkout_started')

    complete(session.id)

    // The furthest a session goes. `funded_held` is the provider webhook's, and
    // in the mock that is the dev panel's `simulateFunding` — a stand-in for a
    // rail, not a shortcut through one.
    expect(requireDeal(db, id).status).toBe('payment_pending')
  })

  it('and writes no ledger entry at all', () => {
    const id = newDeal()
    const before = db.ledger.length

    complete(openCheckoutSession(db, id).id)

    expect(db.ledger.length).toBe(before)
    expect(db.ledger.filter((e) => e.deal_id === id)).toHaveLength(0)
  })

  it('queues checkout.completed, which is not the funding event', () => {
    // §10.2. One says the buyer is done with our page, the other says money
    // arrived; a client that conflated them would ship goods against a card
    // that has not settled.
    const id = newDeal()
    complete(openCheckoutSession(db, id).id)

    const events = db.webhook_deliveries
      .filter((d) => d.deal_id === id)
      .map((d) => d.event)

    expect(events).toContain('checkout.completed')
    expect(events).not.toContain('order.funded_held')
  })
})

// ---------------------------------------------------------------------------
// Opening
// ---------------------------------------------------------------------------

describe('opening a session', () => {
  it('gives checkout_started its first writer', () => {
    // Declared in Phase 1 and unreachable since. §6 keeps it separate from
    // `payment_pending` so "the buyer has somewhere to pay" and "the buyer's
    // card is being charged" are not the same fact.
    const id = newDeal()
    expect(requireDeal(db, id).status).toBe('created')

    openCheckoutSession(db, id)
    expect(requireDeal(db, id).status).toBe('checkout_started')
  })

  it('a second call returns the same session rather than a second link', () => {
    const id = newDeal()
    const first = openCheckoutSession(db, id)
    const second = openCheckoutSession(db, id)

    expect(second.id).toBe(first.id)
    expect(second.token).toBe(first.token)
    expect(db.checkout_sessions.filter((s) => s.deal_id === id)).toHaveLength(1)
  })

  it('a deal mid-payment is refused', () => {
    // A buyer mid-payment on one rail must not be handed a second link, or two
    // charges race for one hold.
    const id = newDeal()
    complete(openCheckoutSession(db, id).id)

    expect(() => openCheckoutSession(db, id)).toThrow(PayHoldError)
    expect(() => openCheckoutSession(db, id)).toThrow(/payment_pending/)
  })

  it('tokens are long and unique', () => {
    const tokens = new Set<string>()

    for (const deal of db.deals.filter((d) => d.status === 'created').slice(0, 4)) {
      const session = openCheckoutSession(db, deal.id)
      // 32 bytes hex. A uuid would be 122 bits wearing a recognisable shape,
      // and this is the only thing between a stranger and a payment page.
      expect(session.token).toMatch(/^[0-9a-f]{64}$/)
      tokens.add(session.token)
    }

    expect(tokens.size).toBeGreaterThan(1)
  })
})

// ---------------------------------------------------------------------------
// Expiry, derived
// ---------------------------------------------------------------------------

describe('expiry is derived, not stored', () => {
  it('a session past its expiry reads as expired with nothing having run', () => {
    const session = openCheckoutSession(db, newDeal(), { hours: 1 })
    expect(checkoutSessionState(session)).toBe('open')

    advanceClock(2)

    expect(checkoutSessionState(session)).toBe('expired')
    // The stored column is untouched, which is what "derived" means.
    expect(session.status).toBe('open')
  })

  it('an expired link cannot be resolved or used', () => {
    const session = openCheckoutSession(db, newDeal(), { hours: 1 })
    advanceClock(2)

    expect(() => sessionByToken(db, session.token)).toThrow(/expired or has already been used/)
    expect(() => complete(session.id)).toThrow(/is expired/)
  })

  it('an expired session is replaced rather than blocking a new one', () => {
    const id = newDeal()
    const stale = openCheckoutSession(db, id, { hours: 1 })
    advanceClock(2)

    const fresh = openCheckoutSession(db, id)

    expect(fresh.id).not.toBe(stale.id)
    expect(stale.status).toBe('canceled')
  })
})

// ---------------------------------------------------------------------------
// The token is the credential
// ---------------------------------------------------------------------------

describe('resolving a token', () => {
  it('refuses an unknown token the same way it refuses an expired one', () => {
    // Distinguishing the two would let somebody probe for real tokens.
    const session = openCheckoutSession(db, newDeal(), { hours: 1 })
    advanceClock(2)

    const unknown = () => sessionByToken(db, 'f'.repeat(64))
    const expired = () => sessionByToken(db, session.token)

    let unknownMessage = ''
    let expiredMessage = ''
    try { unknown() } catch (e) { unknownMessage = (e as Error).message }
    try { expired() } catch (e) { expiredMessage = (e as Error).message }

    expect(unknownMessage).toBe(expiredMessage)
  })

  it('a withdrawn link stops working immediately', () => {
    const session = openCheckoutSession(db, newDeal())
    cancelCheckoutSession(db, session.id, 'ops@payhold')

    expect(() => sessionByToken(db, session.token)).toThrow(PayHoldError)
  })
})

// ---------------------------------------------------------------------------
// Completing
// ---------------------------------------------------------------------------

describe('completing a session', () => {
  it('records what the buyer chose, on the session and on the deal', () => {
    const id = newDeal()
    const session = complete(openCheckoutSession(db, id).id)

    expect(session.status).toBe('completed')
    expect(session.completed_at).not.toBeNull()
    expect(session.method).toBe('card')

    const deal = requireDeal(db, id)
    expect(deal.provider).toBe('flutterwave')
    expect(deal.payment_method).toBe('card')
  })

  it('the provisional rail is replaced by the one the buyer used', () => {
    // A deal routed to Flutterwave at creation becomes a Stripe deal if the
    // buyer pays by international card, and the ledger follows the rail that
    // holds the money.
    const id = newDeal()
    const session = openCheckoutSession(db, id)

    completeCheckoutSession(db, session.id, {
      method: 'card',
      network: 'Visa',
      provider: 'stripe',
      providerRef: 'cs_1',
      paymentLink: 'https://pay/y',
    })

    expect(requireDeal(db, id).provider).toBe('stripe')
  })

  it('a session cannot be used twice', () => {
    const session = openCheckoutSession(db, newDeal())
    complete(session.id)

    expect(() => complete(session.id)).toThrow(/is completed/)
  })
})

// ---------------------------------------------------------------------------
// Cancelling
// ---------------------------------------------------------------------------

describe('cancelling a session', () => {
  it('withdraws the link and puts the deal back', () => {
    const id = newDeal()
    const session = openCheckoutSession(db, id)

    cancelCheckoutSession(db, session.id, 'ops@payhold')

    // The one backwards edge in the machine, and it is legal precisely because
    // nothing happened: no provider was called and no money moved.
    expect(requireDeal(db, id).status).toBe('created')
    expect(session.status).toBe('canceled')
  })

  it('a used session cannot be withdrawn', () => {
    const session = openCheckoutSession(db, newDeal())
    complete(session.id)

    expect(() => cancelCheckoutSession(db, session.id, 'ops@payhold'))
      .toThrow(/already been used/)
  })

  it('cancelling frees the deal for a new link', () => {
    const id = newDeal()
    const first = openCheckoutSession(db, id)
    cancelCheckoutSession(db, first.id, 'ops@payhold')

    expect(openCheckoutSession(db, id).id).not.toBe(first.id)
  })
})
