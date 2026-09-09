/**
 * `cancel_deal` — the writer `canceled` never had (migration 20260909000002).
 *
 * The lifecycle allowed the edge and the trigger queued `order.canceled` for
 * it, and nothing ever wrote it, so every abandoned checkout was a permanent
 * `created` row. These pin what the function may and may not touch: only a
 * deal holding no money, never one with a charge in flight, and never twice
 * under two names.
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { migrated, rejects, type Harness } from './harness'

let h: Harness
let tenant: string
let otherTenant: string
let seller: string

beforeAll(async () => {
  h = await migrated()
  const { rows: [t] } = await h.db.query<{ id: string }>(
    `insert into tenants (name, slug) values ('Cancel Co', 'cancel-co') returning id`,
  )
  tenant = t.id
  const { rows: [o] } = await h.db.query<{ id: string }>(
    `insert into tenants (name, slug) values ('Other Co', 'other-co') returning id`,
  )
  otherTenant = o.id
  const { rows: [s] } = await h.db.query<{ id: string }>(
    `insert into sellers (tenant_id, name, country, payout_currency,
                          payout_provider, beneficiary_token, masked_destination)
     values ($1, 'Seller', 'RW', 'RWF', 'flutterwave_momo', 'tok_c', '•••1234')
     returning id`,
    [tenant],
  )
  seller = s.id
})

afterAll(() => h.close())

async function newDeal(status = 'created'): Promise<string> {
  const { rows: [d] } = await h.db.query<{ id: string }>(
    `insert into deals (
       tenant_id, buyer_ref, seller_id, description, amount, currency,
       presentment_currency, presentment_amount, buyer_country, provider,
       fee_amount, status
     )
     values ($1, 'buyer_1', $2, 'A rental', 100000, 'RWF',
             'RWF', 100000, 'RW', 'fake', 10000, $3)
     returning id`,
    [tenant, seller, status],
  )
  return d.id
}

async function statusOf(deal: string): Promise<string> {
  const { rows: [d] } = await h.db.query<{ status: string }>(
    `select status from deals where id = $1`, [deal],
  )
  return d.status
}

async function cancel(deal: string, t = tenant, actor = 'renter-app', reason: string | null = null) {
  return h.db.query(`select cancel_deal($1, $2, $3, $4)`, [deal, t, actor, reason])
}

async function auditCount(deal: string): Promise<number> {
  const { rows: [r] } = await h.db.query<{ n: string }>(
    `select count(*) as n from audit_log where deal_id = $1 and action = 'deal.canceled'`,
    [deal],
  )
  return Number(r.n)
}

describe('cancel_deal — a deal holding no money can be withdrawn', () => {
  test.each(['created', 'checkout_started', 'payment_failed'])(
    'from %s it becomes canceled, audited once, with the reason',
    async (from) => {
      const deal = await newDeal(from)
      await cancel(deal, tenant, 'renter-app', 'closed the payment sheet')
      expect(await statusOf(deal)).toBe('canceled')
      expect(await auditCount(deal)).toBe(1)
      const { rows: [a] } = await h.db.query<{ details: { from_status: string; reason: string } }>(
        `select details from audit_log where deal_id = $1 and action = 'deal.canceled'`, [deal],
      )
      expect(a.details.reason).toBe('closed the payment sheet')
    },
  )

  test('a payment in flight is refused — a settlement must still have somewhere to land', async () => {
    const deal = await newDeal('payment_pending')
    await rejects(() => cancel(deal), /invalid_state.*in flight/)
    expect(await statusOf(deal)).toBe('payment_pending')
  })

  test('a funded deal is refused — that is a refund, not a cancel', async () => {
    const deal = await newDeal('funded_held')
    await rejects(() => cancel(deal), /invalid_state.*refund/)
    expect(await statusOf(deal)).toBe('funded_held')
  })

  test('a second press writes no second name', async () => {
    const deal = await newDeal()
    await cancel(deal, tenant, 'first@autohire.rw')
    await cancel(deal, tenant, 'second@autohire.rw')
    expect(await statusOf(deal)).toBe('canceled')
    expect(await auditCount(deal)).toBe(1)
  })

  test('a blank actor is refused', async () => {
    const deal = await newDeal()
    await rejects(() => cancel(deal, tenant, '   '), /policy_violation/)
  })

  test("another tenant's deal is not found, not refused", async () => {
    const deal = await newDeal()
    await rejects(() => cancel(deal, otherTenant), /not_found/)
    expect(await statusOf(deal)).toBe('created')
  })

  test('canceled is terminal — nothing moves it afterwards', async () => {
    const deal = await newDeal()
    await cancel(deal)
    await rejects(
      () => h.db.query(`update deals set status = 'funded_held' where id = $1`, [deal]),
      /./,
    )
  })
})
