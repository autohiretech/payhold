/**
 * Invariant 7 — signed outbound webhooks.
 *
 * Like `engine.test.ts`, these are the backend's acceptance spec rather than
 * tests of the mock. The one that matters most is `verifySignature` passing
 * from the client's side: everything else is bookkeeping, but that assertion is
 * the actual promise we make to a client's server.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { verifySignature } from '@/lib/hmac'
import {
  captureDeposit,
  confirmDeal,
  fundDeal,
  openDispute,
  refundDeal,
  requireDeal,
  runCron,
} from './engine'
import { seedDb } from './seed'
import { advanceClock, loadDb, resetDb, type MockDb } from './store'
import { attemptDelivery, deliverPending, emitWebhook } from './webhooks'

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

/** The secret the client was handed at registration. */
function endpointSecret(tenantId = AUTOHIRE): string {
  const endpoint = db.webhook_endpoints.find((e) => e.tenant_id === tenantId)
  if (!endpoint) throw new Error('fixture missing a webhook endpoint')
  return endpoint.secret
}

function deliveriesFor(dealId: string) {
  return db.webhook_deliveries.filter((d) => d.deal_id === dealId)
}

describe('signing', () => {
  it('produces a signature the client can verify with their secret', () => {
    const id = newDeal()
    fundDeal(db, id)

    const delivery = deliveriesFor(id)[0]!
    expect(verifySignature(endpointSecret(), delivery.signature, delivery.body)).toBe(
      true,
    )
  })

  it('does not verify under another tenant secret', () => {
    const id = newDeal()
    fundDeal(db, id)

    const delivery = deliveriesFor(id)[0]!
    expect(
      verifySignature(endpointSecret('ten_0002'), delivery.signature, delivery.body),
    ).toBe(false)
  })

  it('signs the exact bytes it sends, not a re-encoding of the payload', () => {
    const id = newDeal()
    fundDeal(db, id)

    const delivery = deliveriesFor(id)[0]!
    // A client verifies against the raw body. If we ever sign an object and
    // serialise it again on the way out, key order can differ and every
    // delivery fails verification on their side while looking fine on ours.
    expect(JSON.parse(delivery.body)).toEqual(delivery.payload)
    expect(verifySignature(endpointSecret(), delivery.signature, delivery.body)).toBe(
      true,
    )
  })

  it('re-signs on retry so the timestamp stays current', () => {
    const id = newDeal()
    fundDeal(db, id)
    const delivery = deliveriesFor(id)[0]!
    const first = delivery.signature

    db.fail_next_webhook = true
    attemptDelivery(db, delivery)
    advanceClock(2)
    attemptDelivery(db, delivery)

    expect(delivery.signature).not.toBe(first)
    expect(verifySignature(endpointSecret(), delivery.signature, delivery.body)).toBe(
      true,
    )
  })
})

describe('what gets notified', () => {
  it('emits on every state change of a deal that runs to completion', () => {
    const id = newDeal()
    fundDeal(db, id)
    confirmDeal(db, id, 'buyer')
    confirmDeal(db, id, 'seller')

    advanceClock(24 * 30)
    runCron(db)

    const events = deliveriesFor(id).map((d) => d.event)
    // §10.2's vocabulary, and one more event than V1 emitted: the clearance
    // window now has an end a client can see as well as a start.
    expect(events).toEqual([
      'order.funded_held',
      'order.accepted',
      'order.delivered',
      'order.clearing_started',
      'order.released',
      'payout.paid',
    ])
  })

  // One unfunded fixture per shape, so each of these takes the deal it needs
  // from a freshly reseeded database rather than competing for the same row.
  it('emits on refund', () => {
    const id = newDeal()
    fundDeal(db, id)
    refundDeal(db, id, 'Host cancelled')

    expect(deliveriesFor(id).map((d) => d.event)).toContain('refund.succeeded')
  })

  it('emits on dispute', () => {
    const id = newDeal()
    fundDeal(db, id)
    openDispute(db, id, 'buyer', 'Never delivered')

    expect(deliveriesFor(id).map((d) => d.event)).toContain('dispute.opened')
  })

  it('emits on deposit capture', () => {
    const id = db.deals.find(
      (d) => d.status === 'created' && d.deposit_amount && d.tenant_id === AUTOHIRE,
    )!.id
    fundDeal(db, id)
    captureDeposit(db, id, 100)

    expect(deliveriesFor(id).map((d) => d.event)).toContain('deposit.captured')
  })

  it('does not emit twice for a repeated confirmation', () => {
    const id = newDeal()
    fundDeal(db, id)
    confirmDeal(db, id, 'buyer')
    confirmDeal(db, id, 'buyer')

    const confirmed = deliveriesFor(id).filter((d) => d.event === 'order.accepted')
    expect(confirmed).toHaveLength(1)
  })

  it('tells nobody when the tenant has registered no endpoint', () => {
    db.webhook_endpoints = []
    const id = newDeal()
    fundDeal(db, id)

    expect(deliveriesFor(id)).toHaveLength(0)
  })

  it('scopes deliveries to the tenant whose deal moved', () => {
    const id = newDeal()
    fundDeal(db, id)

    expect(deliveriesFor(id).every((d) => d.tenant_id === AUTOHIRE)).toBe(true)
  })

  it('skips a disabled endpoint without touching the history', () => {
    const endpoint = db.webhook_endpoints.find((e) => e.tenant_id === AUTOHIRE)!
    const before = db.webhook_deliveries.length
    endpoint.disabled_at = new Date().toISOString()

    fundDeal(db, newDeal())
    expect(db.webhook_deliveries.length).toBe(before)
  })
})

describe('delivery, retry and backoff', () => {
  it('delivers queued notifications on the cron pass', () => {
    const id = newDeal()
    fundDeal(db, id)
    expect(deliveriesFor(id).every((d) => d.status === 'pending')).toBe(true)

    runCron(db)
    expect(deliveriesFor(id).every((d) => d.status === 'delivered')).toBe(true)
  })

  it('backs off after a failure instead of hammering the endpoint', () => {
    const id = newDeal()
    fundDeal(db, id)
    const delivery = deliveriesFor(id)[0]!

    db.fail_next_webhook = true
    attemptDelivery(db, delivery)

    expect(delivery.status).toBe('pending')
    expect(delivery.attempts).toBe(1)
    expect(delivery.next_attempt_at).toBeTruthy()

    // Not yet due — a second pass right away must leave it alone.
    deliverPending(db)
    expect(delivery.attempts).toBe(1)

    advanceClock(1)
    deliverPending(db)
    expect(delivery.status).toBe('delivered')
    expect(delivery.attempts).toBe(2)
  })

  it('gives up after five attempts and leaves the record', () => {
    const id = newDeal()
    fundDeal(db, id)
    const delivery = deliveriesFor(id)[0]!

    for (let i = 0; i < 5; i++) {
      db.fail_next_webhook = true
      attemptDelivery(db, delivery)
      advanceClock(6)
    }

    expect(delivery.status).toBe('failed')
    expect(delivery.attempts).toBe(5)
    expect(delivery.next_attempt_at).toBeNull()
    expect(delivery.error).toBeTruthy()
  })

  it('never re-sends something already delivered', () => {
    const id = newDeal()
    fundDeal(db, id)
    runCron(db)

    const delivery = deliveriesFor(id)[0]!
    const attempts = delivery.attempts
    attemptDelivery(db, delivery)

    expect(delivery.attempts).toBe(attempts)
  })
})

describe('a failing endpoint cannot affect money', () => {
  it('releases and pays out even when every notification fails', () => {
    const id = newDeal()
    fundDeal(db, id)
    confirmDeal(db, id, 'buyer')
    confirmDeal(db, id, 'seller')

    advanceClock(24 * 30)
    for (let i = 0; i < 6; i++) {
      db.fail_next_webhook = true
      runCron(db)
      advanceClock(3)
    }

    expect(requireDeal(db, id).status).toBe('paid_out')
    expect(db.payouts.find((p) => p.deal_id === id)!.status).toBe('paid')
  })

  it('records an audit row for each delivery outcome', () => {
    const id = newDeal()
    fundDeal(db, id)
    runCron(db)

    const delivered = db.audit.filter(
      (a) => a.deal_id === id && a.action === 'webhook.delivered',
    )
    expect(delivered.length).toBeGreaterThan(0)
  })
})

describe('the envelope', () => {
  it('carries the event, the deal and when it happened', () => {
    const id = newDeal()
    fundDeal(db, id)

    const { payload } = deliveriesFor(id)[0]!
    expect(payload.event).toBe('order.funded_held')
    expect(payload.deal_id).toBe(id)
    expect(payload.occurred_at).toBeTruthy()
    expect(payload.data.amount).toBe(requireDeal(db, id).amount)
  })

  it('can be emitted without a deal, for account-level events', () => {
    const [delivery] = emitWebhook(db, AUTOHIRE, 'payout.failed', null, {
      note: 'account level',
    })
    expect(delivery!.deal_id).toBeNull()
    expect(verifySignature(endpointSecret(), delivery!.signature, delivery!.body)).toBe(
      true,
    )
  })
})
