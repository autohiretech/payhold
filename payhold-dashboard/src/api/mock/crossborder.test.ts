/**
 * The cross-border case, end to end.
 *
 * A buyer in India rents a car from a host in Kigali. The host quotes RWF and
 * wants RWF — it is all they can receive. An Indian card cannot be charged RWF.
 *
 * This is the ordinary case for a tourism marketplace, not an edge case, and it
 * exercises the one thing most payment integrations get wrong: settlement
 * currency and presentment currency are not the same thing.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { MockClient } from './index'
import { resetDb } from './store'
import { seedDb } from './seed'
import { convert } from '@/lib/fx'

let api: MockClient

beforeEach(() => {
  localStorage.clear()
  resetDb(seedDb)
  api = new MockClient()
})

/** The Rwandan host from the fixtures — MoMo, paid in RWF. */
const KIGALI_HOST = 'sel_0001'

describe('an Indian buyer renting a Rwandan car priced in RWF', () => {
  async function createIt() {
    return api.createDeal({
      seller_id: KIGALI_HOST,
      buyer_ref: 'bk_india_1',
      description: 'Toyota RAV4 — 4 days, Kigali',
      amount: 140_000_00, // RWF 140,000
      currency: 'RWF',
      buyer_country: 'IN',
    })
  }

  it('creates the deal instead of refusing it', async () => {
    const { deal } = await createIt()

    expect(deal.currency).toBe('RWF')
    expect(deal.amount).toBe(140_000_00)
  })

  it('charges the buyer in a currency their card can actually take', async () => {
    const { deal } = await createIt()

    // India has no local rail, so the buyer pays on the international card
    // rail — which cannot be charged RWF.
    expect(deal.presentment_currency).toBe('USD')
    expect(deal.presentment_amount).toBeGreaterThan(0)
    expect(deal.provider).toBe('stripe')
  })

  it('keeps the host owed exactly what they quoted', async () => {
    const { deal } = await createIt()

    // Whatever the buyer pays, the seller's side of the deal is untouched.
    expect(deal.amount).toBe(140_000_00)
    expect(deal.currency).toBe('RWF')
  })

  it('converts at a sane rate', async () => {
    const { deal } = await createIt()
    const expected = convert(140_000_00, 'RWF', 'USD')!

    expect(deal.presentment_amount).toBe(expected.amount)
    // RWF 140,000 is roughly USD 100 — a sanity bound, not a precise assertion.
    expect(deal.presentment_amount).toBeGreaterThan(50_00)
    expect(deal.presentment_amount).toBeLessThan(200_00)
  })

  it('locks the rate when the buyer pays, not before', async () => {
    const { deal } = await createIt()
    expect(deal.fx_rate).toBeNull()

    const funded = await api.sim.simulateFunding(deal.id, 'card')
    expect(funded.fx_rate).toBeGreaterThan(0)
  })

  it('holds the money in the currency actually collected', async () => {
    const { deal } = await createIt()
    await api.sim.simulateFunding(deal.id, 'card')

    const ledger = await api.listLedger(deal.id)
    const hold = ledger.find((e) => e.entry_type === 'hold')

    expect(hold?.currency).toBe('USD')
    expect(hold?.provider).toBe('stripe')
  })

  it('shows the held funds on the Stripe rail, in USD', async () => {
    const { deal } = await createIt()
    await api.sim.simulateFunding(deal.id, 'card')

    const rails = await api.getRailBalances()
    const stripeUsd = rails.find((r) => r.provider === 'stripe' && r.currency === 'USD')

    expect(stripeUsd).toBeDefined()
    expect(stripeUsd!.held).toBeGreaterThanOrEqual(deal.presentment_amount)
  })

  it('pays the host in RWF, on Flutterwave, to their mobile money wallet', async () => {
    const { deal } = await createIt()
    await api.sim.simulateFunding(deal.id, 'card')
    await api.confirmDeal(deal.id, 'buyer')
    await api.confirmDeal(deal.id, 'seller')

    const payouts = await api.listPayouts()
    const payout = payouts.find((p) => p.deal_id === deal.id)

    expect(payout).toBeDefined()
    // Collected on Stripe in USD, paid out on Flutterwave in RWF. This is the
    // whole point of splitting the two currencies.
    expect(payout!.currency).toBe('RWF')
    expect(payout!.amount).toBe(deal.amount - deal.fee_amount)
  })

  it('completes the full lifecycle without stranding the money', async () => {
    const { deal } = await createIt()
    await api.sim.simulateFunding(deal.id, 'card')
    await api.confirmDeal(deal.id, 'buyer')
    await api.confirmDeal(deal.id, 'seller')

    await api.sim.advanceTime(24 * 30)

    const settled = await api.getDeal(deal.id)
    expect(settled.status).toBe('paid_out')

    // Nothing left held against this deal on any rail.
    const ledger = await api.listLedger(deal.id)
    const heldNet = ledger
      .filter((e) => ['hold', 'release', 'refund'].includes(e.entry_type))
      .reduce((sum, e) => sum + e.amount, 0)
    expect(heldNet).toBe(0)
  })

  it('refunds the buyer in what they actually paid', async () => {
    const { deal } = await createIt()
    await api.sim.simulateFunding(deal.id, 'card')
    await api.refundDeal(deal.id, 'Host cancelled')

    const ledger = await api.listLedger(deal.id)
    const refund = ledger.find((e) => e.entry_type === 'refund')

    expect(refund?.currency).toBe('USD')
    expect(Math.abs(refund!.amount)).toBe(deal.presentment_amount)
  })
})

describe('the same deal from a market that can pay locally', () => {
  it('does not convert when the buyer is in Rwanda', async () => {
    const { deal } = await api.createDeal({
      seller_id: KIGALI_HOST,
      buyer_ref: 'bk_local_1',
      description: 'Toyota RAV4 — 4 days, Kigali',
      amount: 140_000_00,
      currency: 'RWF',
      buyer_country: 'RW',
    })

    expect(deal.presentment_currency).toBe('RWF')
    expect(deal.presentment_amount).toBe(deal.amount)
    expect(deal.provider).toBe('flutterwave')
  })

  it('charges a Kenyan buyer in USD, on their own local card rail', async () => {
    const { deal } = await api.createDeal({
      seller_id: KIGALI_HOST,
      buyer_ref: 'bk_ke_1',
      description: 'Toyota RAV4 — 4 days, Kigali',
      amount: 140_000_00,
      currency: 'RWF',
      buyer_country: 'KE',
    })

    // Kenya has local rails but none of them take RWF, so the buyer is charged
    // USD. Kenya's own Flutterwave card rail accepts USD, so it wins over
    // Stripe — local acquiring beats shipping the charge abroad.
    expect(deal.presentment_currency).toBe('USD')
    expect(deal.provider).toBe('flutterwave')
  })
})
