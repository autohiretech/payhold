/**
 * Spec §7.1 — full, partial and line-item refunds.
 *
 * This is the suite for the decision V2 overrode: V1 recorded refunds as
 * all-or-nothing on purpose, and §29.6 reverses it. The counterpart in the
 * dashboard's mock is `src/api/mock/engine.test.ts`.
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { migrated, rejects, type Harness } from './harness'

let h: Harness
let tenant: string
let seller: string

beforeAll(async () => {
  h = await migrated()

  const { rows: [t] } = await h.db.query<{ id: string }>(
    `insert into tenants (name, slug) values ('Refund Co', 'refund-co') returning id`,
  )
  tenant = t.id

  const { rows: [s] } = await h.db.query<{ id: string }>(
    `insert into sellers (tenant_id, name, country, payout_currency,
                          payout_provider, beneficiary_token, masked_destination)
     values ($1, 'Seller', 'RW', 'RWF', 'flutterwave_momo', 'tok_1', '•••1234')
     returning id`,
    [tenant],
  )
  seller = s.id
})

afterAll(() => h.close())

/** A funded deal of 100,000 with a 10,000 fee. */
async function funded(amount = 100_000): Promise<string> {
  const { rows: [d] } = await h.db.query<{ id: string }>(
    `insert into deals (tenant_id, buyer_ref, seller_id, description, amount, currency,
                        presentment_currency, presentment_amount, buyer_country,
                        provider, fee_amount)
     values ($1, 'buyer_1', $2, 'A rental', $3, 'RWF', 'RWF', $3, 'RW', 'fake', $4)
     returning id`,
    [tenant, seller, amount, Math.round(amount * 0.1)],
  )
  await h.db.query(
    `select fund_deal($1, 'fake', $2, 'mobile_money', 'MTN', $3, 'RWF')`,
    [d.id, `ref-${d.id.slice(0, 8)}`, amount],
  )
  return d.id
}

async function release(deal: string, fee = 10_000): Promise<void> {
  await h.db.query(`select confirm_deal($1, 'buyer', 'user', 90000, 'RWF', $2)`, [deal, fee])
  await h.db.query(`select confirm_deal($1, 'seller', 'user', 90000, 'RWF', $2)`, [deal, fee])
}

async function amounts(deal: string): Promise<Record<string, number>> {
  const { rows: [a] } = await h.db.query<Record<string, string>>(
    `select * from deal_amounts($1)`, [deal],
  )
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(a)) out[k] = Number(v)
  return out
}

async function statusOf(deal: string): Promise<string> {
  const { rows: [d] } = await h.db.query<{ status: string }>(
    `select status from deals where id = $1`, [deal],
  )
  return d.status
}

describe('§7.1.2 — after capture, before release', () => {
  test('a partial refund leaves the rest held and the deal running', async () => {
    const deal = await funded()
    await h.db.query(`select refund_deal($1, 'One day cut short', 'dashboard', 30000)`, [deal])

    // The status does not move. §29.8: a partial refund is an amount, not a
    // lifecycle position — this deal still has to be delivered and paid out
    // for the other 70,000.
    expect(await statusOf(deal)).toBe('funded_held')

    const a = await amounts(deal)
    expect(a.refunded).toBe(30_000)

    const { rows: [b] } = await h.db.query<{ held: string }>(
      `select held from rail_balances($1) where provider = 'fake'`, [tenant],
    )
    expect(Number(b.held)).toBeGreaterThan(0)
  })

  test('the remainder still releases, and the seller is paid the rest', async () => {
    const deal = await funded()
    await h.db.query(`select refund_deal($1, 'Partial', 'dashboard', 40000)`, [deal])
    await release(deal, 6_000)

    expect(await statusOf(deal)).toBe('clearing')
    const a = await amounts(deal)
    // 100,000 in, 40,000 back, 6,000 our fee.
    expect(a.seller_net).toBe(54_000)
  })

  test('refunding everything in pieces ends as refunded', async () => {
    const deal = await funded()
    await h.db.query(`select refund_deal($1, 'First', 'dashboard', 60000)`, [deal])
    expect(await statusOf(deal)).toBe('funded_held')

    await h.db.query(`select refund_deal($1, 'Rest', 'dashboard', 40000)`, [deal])
    expect(await statusOf(deal)).toBe('refunded')
  })

  test('a full refund with no amount is what every V1 caller meant', async () => {
    const deal = await funded()
    await h.db.query(`select refund_deal($1, 'Host cancelled')`, [deal])

    expect(await statusOf(deal)).toBe('refunded')
    expect((await amounts(deal)).refunded).toBe(100_000)
  })
})

describe('the cumulative guard', () => {
  test('refunds cannot exceed what the buyer paid', async () => {
    const deal = await funded()
    await h.db.query(`select refund_deal($1, 'First', 'dashboard', 70000)`, [deal])

    await rejects(
      () => h.db.query(`select refund_deal($1, 'Too much', 'dashboard', 40000)`, [deal]),
      /exceeds the 30000 still refundable/,
    )
  })

  test('and are measured against the ledger, not against the deal amount', async () => {
    // What is refundable comes from `hold` entries. A deal whose payment never
    // arrived has nothing to send back however large the price is.
    const { rows: [d] } = await h.db.query<{ id: string }>(
      `insert into deals (tenant_id, buyer_ref, seller_id, description, amount, currency,
                          presentment_currency, presentment_amount, buyer_country,
                          provider, fee_amount, status)
       values ($1, 'b', $2, 'Never paid', 500000, 'RWF', 'RWF', 500000, 'RW',
               'fake', 50000, 'funded_held')
       returning id`,
      [tenant, seller],
    )
    await rejects(
      () => h.db.query(`select refund_deal($1, 'Nothing there')`, [d.id]),
      /nothing further is refundable/,
    )
  })

  test('a zero or negative refund is refused', async () => {
    const deal = await funded()
    await rejects(
      () => h.db.query(`select refund_deal($1, 'Nothing', 'dashboard', 0)`, [deal]),
      /must be a positive amount/,
    )
    await rejects(
      () => h.db.query(`select refund_deal($1, 'Negative', 'dashboard', -100)`, [deal]),
      /must be a positive amount/,
    )
  })

  test('refunding a fully refunded deal is a no-op, not an error', async () => {
    const deal = await funded()
    await h.db.query(`select refund_deal($1, 'All of it')`, [deal])
    await h.db.query(`select refund_deal($1, 'Again')`, [deal])

    const { rows } = await h.db.query(`select 1 from refunds where deal_id = $1`, [deal])
    expect(rows).toHaveLength(1)
  })
})

describe('§7.1.3 — after release, before payout', () => {
  test('the payable is reversed and `held` does not go negative', async () => {
    const deal = await funded()
    await release(deal)
    await h.db.query(`select refund_deal($1, 'Damaged', 'dashboard', 25000)`, [deal])

    const a = await amounts(deal)
    expect(a.refunded).toBe(25_000)
    // 100,000 less our 10,000 fee less the 25,000 returned.
    expect(a.seller_net).toBe(65_000)

    // The un-release is what keeps this at zero: booking only the refund would
    // drive it to −25,000, because the hold has already been cancelled.
    // Scoped to this deal — the buckets are the whole tenant's.
    const { rows: [held] } = await h.db.query<{ held: string }>(
      `select deal_held_amount($1) as held`, [deal],
    )
    expect(Number(held.held)).toBe(0)
  })

  test('the scheduled payout shrinks with the pool', async () => {
    const deal = await funded()
    await release(deal)

    const { rows: [before] } = await h.db.query<{ amount: string }>(
      `select amount from payouts where deal_id = $1`, [deal],
    )
    await h.db.query(`select refund_deal($1, 'Half a day', 'dashboard', 45000)`, [deal])

    const { rows: [after] } = await h.db.query<{ amount: string }>(
      `select amount from payouts where deal_id = $1`, [deal],
    )
    // The seller was going to get 90,000; half the pool went back.
    expect(Number(after.amount)).toBeLessThan(Number(before.amount))
    expect(Number(after.amount)).toBe(45_000)
  })

  test('a full refund after release cancels the payout', async () => {
    const deal = await funded()
    await release(deal)
    await h.db.query(`select refund_deal($1, 'All of it')`, [deal])

    const { rows: [p] } = await h.db.query<{ status: string; reason: string }>(
      `select status::text, failure_reason as reason from payouts where deal_id = $1`,
      [deal],
    )
    expect(p.status).toBe('failed')
    expect(p.reason).toMatch(/refunded/i)
  })

  test('a transfer already with the provider cannot be unwound from here', async () => {
    const deal = await funded()
    await release(deal)
    await h.db.query(
      `update deals set payout_due_at = now() - interval '1 hour' where id = $1`, [deal],
    )
    await h.db.query(`select * from mature_clearing_deals()`)

    const { rows: [p] } = await h.db.query<{ id: string }>(
      `select id from payouts where deal_id = $1`, [deal],
    )
    await h.db.query(`select mark_payout_processing($1, 'FLW-INFLIGHT')`, [p.id])

    await rejects(
      () => h.db.query(`select refund_deal($1, 'Too late', 'dashboard', 1000)`, [deal]),
      /in flight/,
    )
  })
})

describe('§7.1.4 — after payout', () => {
  async function paidOut(): Promise<string> {
    const deal = await funded()
    await release(deal)
    await h.db.query(
      `update deals set payout_due_at = now() - interval '1 hour' where id = $1`, [deal],
    )
    await h.db.query(`select * from mature_clearing_deals()`)
    const { rows: [p] } = await h.db.query<{ id: string }>(
      `select id from payouts where deal_id = $1`, [deal],
    )
    await h.db.query(`select settle_payout($1, 90000, 'FLW-PAID')`, [p.id])
    return deal
  }

  test('books what the seller owes rather than moving money we do not have', async () => {
    const deal = await paidOut()
    await h.db.query(`select refund_deal($1, 'Chargeback', 'dashboard', 20000)`, [deal])

    const a = await amounts(deal)
    expect(a.receivable).toBe(20_000)
    // No refund entry: nothing left the provider, because there was nothing
    // there to send.
    expect(a.refunded).toBe(0)
    expect(await statusOf(deal)).toBe('paid_out')
  })

  test('the refund is left pending, so it reads as work rather than as done', async () => {
    const deal = await paidOut()
    await h.db.query(`select refund_deal($1, 'Chargeback', 'dashboard', 15000)`, [deal])

    const { rows: [r] } = await h.db.query<{ status: string; settled_at: string | null }>(
      `select status::text, settled_at from refunds where deal_id = $1`, [deal],
    )
    expect(r.status).toBe('pending')
    expect(r.settled_at).toBeNull()
  })

  test('a receivable is in no balance bucket', async () => {
    const deal = await paidOut()
    const before = await h.db.query<Record<string, string>>(
      `select * from rail_balances($1)`, [tenant],
    )
    await h.db.query(`select refund_deal($1, 'Chargeback', 'dashboard', 10000)`, [deal])
    const after = await h.db.query<Record<string, string>>(
      `select * from rail_balances($1)`, [tenant],
    )

    // A receivable is an asset owed to us. The buckets say what a provider is
    // holding, and no provider is holding this.
    expect(after.rows).toEqual(before.rows)
  })
})

describe('the record — §11 refunds', () => {
  test('every refund carries a reason, an actor and its line items', async () => {
    const deal = await funded()
    await h.db.query(
      `select refund_deal($1, 'Late delivery', 'grace@autohire.rw', 20000,
                          '[{"label": "One day", "amount": 20000}]'::jsonb)`,
      [deal],
    )

    const { rows: [r] } = await h.db.query<{
      reason: string; actor: string; line_items: unknown; amount: string
    }>(`select reason, actor, line_items, amount from refunds where deal_id = $1`, [deal])

    expect(r.reason).toBe('Late delivery')
    expect(r.actor).toBe('grace@autohire.rw')
    expect(Number(r.amount)).toBe(20_000)
    expect(r.line_items).toEqual([{ label: 'One day', amount: 20_000 }])
  })

  test('a failed refund does not count against what is still refundable', async () => {
    const deal = await funded()
    await h.db.query(`select refund_deal($1, 'First try', 'dashboard', 60000)`, [deal])
    // §7.1.6: async rails report the outcome later, and this one did not work.
    await h.db.query(`update refunds set status = 'failed' where deal_id = $1`, [deal])

    // The money never left, so the whole amount is refundable again.
    await h.db.query(`select refund_deal($1, 'Second try', 'dashboard', 100000)`, [deal])

    const { rows } = await h.db.query<{ status: string; amount: string }>(
      `select status::text, amount from refunds where deal_id = $1 order by created_at`,
      [deal],
    )
    expect(rows.map((r) => r.status)).toEqual(['failed', 'succeeded'])
    expect(Number(rows[1].amount)).toBe(100_000)
  })
})

describe('invariant 9 survives the new signature', () => {
  test('payhold_ai holds no execute on the new refund_deal', async () => {
    // A dropped-and-recreated function is granted to PUBLIC by default. This is
    // the check that the revoke block was not forgotten.
    const { rows } = await h.db.query<{ allowed: boolean }>(
      `select bool_or(has_function_privilege('payhold_ai', p.oid, 'execute')) as allowed
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'refund_deal'`,
    )
    expect(rows[0].allowed).toBe(false)
  })

  test('there is exactly one refund_deal', async () => {
    const { rows } = await h.db.query<{ n: number }>(
      `select count(*)::int as n from pg_proc where proname = 'refund_deal'`,
    )
    expect(rows[0].n).toBe(1)
  })
})

describe('§24.2 — a dispute can resolve as a split', () => {
  async function disputed(): Promise<{ deal: string; dispute: string }> {
    const deal = await funded()
    const { rows: [d] } = await h.db.query<{ id: string }>(
      `select open_dispute($1, 'buyer', 'Returned two days early') as id`, [deal],
    )
    const { rows: [dsp] } = await h.db.query<{ id: string }>(
      `select id from disputes where deal_id = $1 and status = 'open'`, [deal],
    )
    return { deal, dispute: dsp.id }
  }

  test('part goes back to the buyer and the rest releases to the seller', async () => {
    const { deal, dispute } = await disputed()

    await h.db.query(
      `select resolve_dispute($1, 'partial_refund', 'Two of five days unused',
                              90000, 'RWF', 10000, 40000)`,
      [dispute],
    )

    const a = await amounts(deal)
    expect(a.refunded).toBe(40_000)
    // 100,000 in, 40,000 back, and the fee scaled to what was actually earned.
    expect(a.seller_net).toBe(54_000)
    expect(await statusOf(deal)).toBe('clearing')

    const { rows: [dsp] } = await h.db.query<{ status: string }>(
      `select status::text from disputes where id = $1`, [dispute],
    )
    expect(dsp.status).toBe('resolved_split')
  })

  test('the seller receives less than they would have', async () => {
    const { deal, dispute } = await disputed()
    await h.db.query(
      `select resolve_dispute($1, 'partial_refund', 'Half', 90000, 'RWF', 10000, 50000)`,
      [dispute],
    )
    const { rows: [p] } = await h.db.query<{ amount: string }>(
      `select amount from payouts where deal_id = $1`, [deal],
    )
    expect(Number(p.amount)).toBe(45_000)
  })

  test('a split is labelled a split, not a refund — §24.4', async () => {
    const { deal, dispute } = await disputed()
    await h.db.query(
      `select resolve_dispute($1, 'partial_refund', 'Some of it', 90000, 'RWF', 10000, 30000)`,
      [dispute],
    )

    const { rows: [o] } = await h.db.query<{ outcome: string; disputed: string }>(
      `select outcome::text, amount_disputed as disputed
         from deal_outcomes where deal_id = $1`,
      [deal],
    )
    // A split filed as `dispute_refunded` would teach a future model that the
    // buyer won outright, which is the one thing it is not.
    expect(o.outcome).toBe('dispute_split')
    expect(Number(o.disputed)).toBe(30_000)
  })

  test('a split naming the whole payment is refused', async () => {
    const { dispute } = await disputed()
    await rejects(
      () => h.db.query(
        `select resolve_dispute($1, 'partial_refund', 'All', 90000, 'RWF', 10000, 100000)`,
        [dispute],
      ),
      /cannot be the whole payment/,
    )
  })

  test('a split with no amount is refused', async () => {
    const { dispute } = await disputed()
    await rejects(
      () => h.db.query(
        `select resolve_dispute($1, 'partial_refund', 'Unclear', 90000, 'RWF', 10000, null)`,
        [dispute],
      ),
      /must name an amount/,
    )
  })
})
