/**
 * Spec §8 — the Resolution Center.
 *
 * The acceptance criterion is §15 phase 4: funds cannot be released while a
 * dispute or payout block is active, and the 48-hour window resolves without a
 * human. Both have a test of their own below, and the second one is the more
 * interesting: what "resolves" means here is that the *window* closes, not that
 * the money moves. See the migration header — silence lapses a request, it never
 * accepts one.
 *
 * The counterpart in the dashboard's mock is `src/api/mock/engine.test.ts`.
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { migrated, rejects, type Harness } from './harness'

let h: Harness
let tenant: string
let seller: string

beforeAll(async () => {
  h = await migrated()

  const { rows: [t] } = await h.db.query<{ id: string }>(
    `insert into tenants (name, slug) values ('Resolution Co', 'resolution-co') returning id`,
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

async function openDispute(
  deal: string,
  opts: { side?: string; code?: string; actor?: string; amount?: number | null } = {},
): Promise<string> {
  const { rows: [d] } = await h.db.query<{ id: string }>(
    `select (open_dispute($1, $2, 'Something is wrong', $3, $4, $5)).id as id`,
    [
      deal,
      opts.side ?? 'buyer',
      opts.code ?? 'not_as_described',
      opts.actor ?? 'user:buyer',
      opts.amount ?? null,
    ],
  )
  return d.id
}

async function offer(
  dispute: string,
  kind: string,
  opts: { by?: string; actor?: string; amount?: number | null; extendTo?: string | null } = {},
): Promise<string> {
  const { rows: [o] } = await h.db.query<{ id: string }>(
    `select (make_dispute_offer($1, $2, $3, $4, $5, $6, 'note')).id as id`,
    [
      dispute,
      opts.by ?? 'seller',
      opts.actor ?? 'user:seller',
      kind,
      opts.amount ?? null,
      opts.extendTo ?? null,
    ],
  )
  return o.id
}

async function statusOf(deal: string): Promise<string> {
  const { rows: [d] } = await h.db.query<{ status: string }>(
    `select status from deals where id = $1`, [deal],
  )
  return d.status
}

async function offerStatus(id: string): Promise<string> {
  const { rows: [o] } = await h.db.query<{ status: string }>(
    `select status from dispute_offers where id = $1`, [id],
  )
  return o.status
}

describe('§8 — opening a dispute', () => {
  test('records a structured code, an amount and the person who filed it', async () => {
    const deal = await funded()
    const dispute = await openDispute(deal, {
      code: 'damaged',
      actor: 'user:buyer@example.com',
      amount: 30_000,
    })

    const { rows: [d] } = await h.db.query<Record<string, string>>(
      `select reason_code, disputed_amount, raised_by_actor from disputes where id = $1`,
      [dispute],
    )
    expect(d.reason_code).toBe('damaged')
    expect(Number(d.disputed_amount)).toBe(30_000)
    expect(d.raised_by_actor).toBe('user:buyer@example.com')
    expect(await statusOf(deal)).toBe('disputed')
  })

  test('the three-argument form still works and defaults the code', async () => {
    // Every V1 caller meant this, and the migration keeps it legal rather than
    // rewriting call sites that were never wrong.
    const deal = await funded()
    await h.db.query(`select open_dispute($1, 'buyer', 'Never arrived')`, [deal])

    const { rows: [d] } = await h.db.query<{ reason_code: string }>(
      `select reason_code from disputes where deal_id = $1`, [deal],
    )
    expect(d.reason_code).toBe('other')
  })

  test('a dispute cannot be for more than the buyer paid', async () => {
    const deal = await funded()
    await rejects(
      () => h.db.query(
        `select open_dispute($1, 'buyer', 'Everything', 'other', 'user:buyer', 500000)`,
        [deal],
      ),
      /more than the buyer paid/,
    )
  })

  test('a new dispute cannot open while a request on the order is still open', async () => {
    // §8 is explicit about this, and the existing unique index only said it for
    // disputes. An outstanding offer is the same sentence about the same order.
    const deal = await funded()
    const dispute = await openDispute(deal)
    await offer(dispute, 'extension', { extendTo: new Date(Date.now() + 8.64e7).toISOString() })

    await h.db.query(
      `update disputes set status = 'resolved_released', resolved_at = now() where id = $1`,
      [dispute],
    )

    await rejects(
      () => h.db.query(`select open_dispute($1, 'seller', 'Second thoughts')`, [deal]),
      /request on this order is still open/,
    )
  })
})

describe('§8 — the five requests', () => {
  test('only one may be open per order at a time', async () => {
    const deal = await funded()
    const dispute = await openDispute(deal)
    await offer(dispute, 'update')

    await rejects(
      () => h.db.query(
        `select make_dispute_offer($1, 'buyer', 'user:buyer', 'cancellation')`,
        [dispute],
      ),
      /request on this order is still open/,
    )
  })

  test('a partial refund must name an amount, and one inside the payment', async () => {
    const deal = await funded()
    const dispute = await openDispute(deal)

    await rejects(
      () => h.db.query(
        `select make_dispute_offer($1, 'seller', 'user:seller', 'partial_refund')`,
        [dispute],
      ),
      /must name an amount/,
    )
    await rejects(
      () => h.db.query(
        `select make_dispute_offer($1, 'seller', 'user:seller', 'partial_refund', 100000)`,
        [dispute],
      ),
      /whole payment/,
    )
  })

  test('and cannot exceed what was actually put in dispute', async () => {
    const deal = await funded()
    const dispute = await openDispute(deal, { amount: 30_000 })

    await rejects(
      () => h.db.query(
        `select make_dispute_offer($1, 'seller', 'user:seller', 'partial_refund', 50000)`,
        [dispute],
      ),
      /more than the 30000 in dispute/,
    )
  })

  test('the offering side cannot answer its own request', async () => {
    const deal = await funded()
    const dispute = await openDispute(deal)
    const o = await offer(dispute, 'update', { by: 'seller' })

    await rejects(
      () => h.db.query(
        `select respond_dispute_offer($1, 'seller', 'user:seller', true)`, [o],
      ),
      /other party answers/,
    )
  })

  test('an accepted extension moves the completion date and leaves the dispute open', async () => {
    // Agreeing to finish on Friday is not agreeing about the money. Closing the
    // dispute here would unfreeze the payout on a side conversation.
    const deal = await funded()
    const dispute = await openDispute(deal)
    const when = new Date(Date.now() + 6 * 8.64e7).toISOString()
    const o = await offer(dispute, 'extension', { extendTo: when })

    await h.db.query(`select respond_dispute_offer($1, 'buyer', 'user:buyer', true)`, [o])

    expect(await offerStatus(o)).toBe('accepted')

    const { rows: [d] } = await h.db.query<{ expected_complete_at: Date; status: string }>(
      `select d.expected_complete_at, di.status
         from deals d join disputes di on di.deal_id = d.id
        where d.id = $1`,
      [deal],
    )
    expect(d.expected_complete_at).not.toBeNull()
    expect(d.status).toBe('open')
    expect(await statusOf(deal)).toBe('disputed')
  })

  test('a declined request is recorded as declined, not withdrawn', async () => {
    const deal = await funded()
    const dispute = await openDispute(deal)
    const o = await offer(dispute, 'update')

    await h.db.query(`select respond_dispute_offer($1, 'buyer', 'user:buyer', false)`, [o])
    expect(await offerStatus(o)).toBe('declined')

    // And the order is free for the next request.
    await expect(offer(dispute, 'cancellation')).resolves.toBeTruthy()
  })

  test('an accepted full refund settles the deal', async () => {
    const deal = await funded()
    const dispute = await openDispute(deal)
    const o = await offer(dispute, 'full_refund', { by: 'seller' })

    await h.db.query(
      `select respond_dispute_offer($1, 'buyer', 'user:buyer', true, 0, 'RWF', 0)`, [o],
    )

    expect(await statusOf(deal)).toBe('refunded')
    const { rows: [d] } = await h.db.query<{ status: string; decided_by: string }>(
      `select status, decided_by from disputes where id = $1`, [dispute],
    )
    expect(d.status).toBe('resolved_refunded')
    // Nobody ruled on this: the two sides agreed with each other.
    expect(d.decided_by).toBe('both-parties')
  })

  test('an accepted partial refund splits it', async () => {
    const deal = await funded()
    const dispute = await openDispute(deal)
    const o = await offer(dispute, 'partial_refund', { by: 'seller', amount: 40_000 })

    await h.db.query(
      `select respond_dispute_offer($1, 'buyer', 'user:buyer', true, 90000, 'RWF', 10000)`,
      [o],
    )

    const { rows: [a] } = await h.db.query<Record<string, string>>(
      `select * from deal_amounts($1)`, [deal],
    )
    expect(Number(a.refunded)).toBe(40_000)

    const { rows: [d] } = await h.db.query<{ status: string }>(
      `select status from disputes where id = $1`, [dispute],
    )
    expect(d.status).toBe('resolved_split')
  })
})

describe('§15 phase 4 — the 48-hour window resolves without a human', () => {
  test('an unanswered request expires, and nothing moves', async () => {
    const deal = await funded()
    const dispute = await openDispute(deal)
    const o = await offer(dispute, 'full_refund', { by: 'seller' })

    // Reach back past the window rather than waiting two days for it.
    await h.db.query(
      `update dispute_offers set expires_at = now() - interval '1 minute' where id = $1`,
      [o],
    )

    const { rows: [r] } = await h.db.query<{ expire_dispute_offers: number }>(
      `select expire_dispute_offers()`,
    )
    expect(Number(r.expire_dispute_offers)).toBe(1)
    expect(await offerStatus(o)).toBe('expired')

    // This is the part worth pinning. Silence is not agreement: the money is
    // exactly where it was, and the dispute is still somebody's to decide.
    expect(await statusOf(deal)).toBe('disputed')
    const { rows: [d] } = await h.db.query<{ status: string }>(
      `select status from disputes where id = $1`, [dispute],
    )
    expect(d.status).toBe('open')

    const { rows: [a] } = await h.db.query<Record<string, string>>(
      `select * from deal_amounts($1)`, [deal],
    )
    expect(Number(a.refunded)).toBe(0)
    expect(Number(a.paid_out)).toBe(0)
  })

  test('expired is not declined — the difference is who ended it', async () => {
    const deal = await funded()
    const dispute = await openDispute(deal)
    const o = await offer(dispute, 'update')

    await h.db.query(
      `update dispute_offers set expires_at = now() - interval '1 second' where id = $1`,
      [o],
    )
    await h.db.query(`select expire_dispute_offers()`)

    const { rows: [row] } = await h.db.query<{ status: string; responded_by_actor: string }>(
      `select status, responded_by_actor from dispute_offers where id = $1`, [o],
    )
    expect(row.status).toBe('expired')
    // Nobody answered, so nobody is recorded as having answered.
    expect(row.responded_by_actor).toBeNull()
  })

  test('a request cannot be answered after its window closed', async () => {
    const deal = await funded()
    const dispute = await openDispute(deal)
    const o = await offer(dispute, 'full_refund', { by: 'seller' })

    await h.db.query(
      `update dispute_offers set expires_at = now() - interval '1 second' where id = $1`,
      [o],
    )

    await rejects(
      () => h.db.query(
        `select respond_dispute_offer($1, 'buyer', 'user:buyer', true, 0, 'RWF', 0)`, [o],
      ),
      /expired at/,
    )
  })

  test('the pass is idempotent — a second run expires nothing', async () => {
    const deal = await funded()
    const dispute = await openDispute(deal)
    const o = await offer(dispute, 'update')
    await h.db.query(
      `update dispute_offers set expires_at = now() - interval '1 second' where id = $1`,
      [o],
    )

    await h.db.query(`select expire_dispute_offers()`)
    const { rows: [again] } = await h.db.query<{ expire_dispute_offers: number }>(
      `select expire_dispute_offers()`,
    )
    expect(Number(again.expire_dispute_offers)).toBe(0)
  })
})

describe('§15 phase 4 — funds cannot be released while a dispute is active', () => {
  test('a disputed deal refuses both confirmations', async () => {
    const deal = await funded()
    await openDispute(deal)

    await rejects(
      () => h.db.query(`select confirm_deal($1, 'buyer', 'user', 90000, 'RWF', 10000)`, [deal]),
      /disputed|can no longer be confirmed/,
    )
    expect(await statusOf(deal)).toBe('disputed')
  })

  test('and its payout is blocked rather than sent', async () => {
    const deal = await funded()
    await h.db.query(`select confirm_deal($1, 'buyer', 'user', 90000, 'RWF', 10000)`, [deal])
    await h.db.query(`select confirm_deal($1, 'seller', 'user', 90000, 'RWF', 10000)`, [deal])
    expect(await statusOf(deal)).toBe('clearing')

    // §6's `clearing -> disputed`: a chargeback does not wait for the window.
    await openDispute(deal)

    const { rows: [p] } = await h.db.query<{ id: string }>(
      `select id from payouts where deal_id = $1`, [deal],
    )
    await h.db.query(`select screen_payout($1)`, [p.id])

    const { rows: [after] } = await h.db.query<{ status: string; failure_reason: string }>(
      `select status, failure_reason from payouts where id = $1`, [p.id],
    )
    expect(after.status).toBe('blocked')
    expect(after.failure_reason).toMatch(/disputed/)
  })
})

describe('§8 — the disputed amount bounds the resolution', () => {
  test('a dispute over part of the payment cannot resolve as a full refund', async () => {
    const deal = await funded()
    const dispute = await openDispute(deal, { amount: 30_000 })

    await rejects(
      () => h.db.query(
        `select resolve_dispute($1, 'refund', 'All of it', 0, 'RWF', 0, null, 'ops@payhold.test')`,
        [dispute],
      ),
      /only 30000 of this payment is in dispute/,
    )
  })

  test('nor as a split larger than what was disputed', async () => {
    const deal = await funded()
    const dispute = await openDispute(deal, { amount: 30_000 })

    await rejects(
      () => h.db.query(
        `select resolve_dispute($1, 'partial_refund', 'Too much', 90000, 'RWF', 10000, 50000,
                                'ops@payhold.test')`,
        [dispute],
      ),
      /more than the 30000 in dispute/,
    )
  })

  test('a split inside the disputed amount goes through', async () => {
    const deal = await funded()
    const dispute = await openDispute(deal, { amount: 30_000 })

    await h.db.query(
      `select resolve_dispute($1, 'partial_refund', 'Agreed', 90000, 'RWF', 10000, 25000,
                              'ops@payhold.test')`,
      [dispute],
    )

    const { rows: [a] } = await h.db.query<Record<string, string>>(
      `select * from deal_amounts($1)`, [deal],
    )
    expect(Number(a.refunded)).toBe(25_000)
  })

  test('a dispute naming no amount is the whole payment, not none of it', async () => {
    const deal = await funded()
    const dispute = await openDispute(deal)

    await h.db.query(
      `select resolve_dispute($1, 'refund', 'Buyer wins', 0, 'RWF', 0, null, 'ops@payhold.test')`,
      [dispute],
    )
    expect(await statusOf(deal)).toBe('refunded')
  })
})

describe('§8 — conflict of interest', () => {
  test('whoever raised the dispute cannot decide it', async () => {
    const deal = await funded()
    const dispute = await openDispute(deal, { actor: 'user:sam@example.com' })

    await rejects(
      () => h.db.query(
        `select resolve_dispute($1, 'release', 'Fine', 90000, 'RWF', 10000, null,
                                'user:sam@example.com')`,
        [dispute],
      ),
      /acted for a party in this dispute/,
    )
  })

  test('nor whoever made a request on it', async () => {
    const deal = await funded()
    const dispute = await openDispute(deal)
    await offer(dispute, 'update', { actor: 'user:alex@example.com' })

    await rejects(
      () => h.db.query(
        `select resolve_dispute($1, 'release', 'Fine', 90000, 'RWF', 10000, null,
                                'user:alex@example.com')`,
        [dispute],
      ),
      /acted for a party in this dispute/,
    )
  })

  test('nor whoever answered one', async () => {
    const deal = await funded()
    const dispute = await openDispute(deal)
    const o = await offer(dispute, 'update', { by: 'seller' })
    await h.db.query(
      `select respond_dispute_offer($1, 'buyer', 'user:jo@example.com', false)`, [o],
    )

    await rejects(
      () => h.db.query(
        `select resolve_dispute($1, 'release', 'Fine', 90000, 'RWF', 10000, null,
                                'user:jo@example.com')`,
        [dispute],
      ),
      /acted for a party in this dispute/,
    )
  })

  test('an uninvolved administrator can, and is recorded', async () => {
    const deal = await funded()
    const dispute = await openDispute(deal, { actor: 'user:sam@example.com' })
    await offer(dispute, 'update', { actor: 'user:alex@example.com' })

    await h.db.query(
      `select resolve_dispute($1, 'release', 'Seller provided proof', 90000, 'RWF', 10000,
                              null, 'user:dana@example.com')`,
      [dispute],
    )

    const { rows: [d] } = await h.db.query<{ status: string; decided_by: string }>(
      `select status, decided_by from disputes where id = $1`, [dispute],
    )
    expect(d.status).toBe('resolved_released')
    expect(d.decided_by).toBe('user:dana@example.com')
  })

  test('a resolution with no decider is refused', async () => {
    const deal = await funded()
    const dispute = await openDispute(deal)

    await rejects(
      () => h.db.query(
        `select resolve_dispute($1, 'release', 'Fine', 90000, 'RWF', 10000)`, [dispute],
      ),
      /must record who decided it/,
    )
  })

  test('resolving withdraws any request still outstanding', async () => {
    // Otherwise the next dispute on this order is blocked forever by an offer
    // about a dispute that is over.
    const deal = await funded()
    const dispute = await openDispute(deal)
    const o = await offer(dispute, 'update')

    await h.db.query(
      `select resolve_dispute($1, 'release', 'Sorted', 90000, 'RWF', 10000, null,
                              'ops@payhold.test')`,
      [dispute],
    )
    expect(await offerStatus(o)).toBe('withdrawn')
  })
})

describe('§8 — evidence', () => {
  test('is recorded with who filed it and when it was captured', async () => {
    const deal = await funded()
    const dispute = await openDispute(deal)

    await h.db.query(
      `select add_dispute_evidence($1, 'buyer', 'user:buyer', 'inspection_photo',
                                   'Scratch on the left panel at pickup', 'r2://a.jpg',
                                   now() - interval '2 days')`,
      [dispute],
    )

    const { rows: [e] } = await h.db.query<Record<string, string>>(
      `select uploaded_by, kind, description, storage_ref, captured_at
         from dispute_evidence where dispute_id = $1`,
      [dispute],
    )
    expect(e.uploaded_by).toBe('buyer')
    expect(e.kind).toBe('inspection_photo')
    expect(e.storage_ref).toBe('r2://a.jpg')
    expect(e.captured_at).not.toBeNull()
  })

  test('needs a description — it is what a person and the assistant read', async () => {
    const deal = await funded()
    const dispute = await openDispute(deal)

    await rejects(
      () => h.db.query(
        `select add_dispute_evidence($1, 'buyer', 'user:buyer', 'photo', '   ')`, [dispute],
      ),
      /violates check constraint|description/,
    )
  })

  test('cannot be added after the dispute is decided', async () => {
    const deal = await funded()
    const dispute = await openDispute(deal)
    await h.db.query(
      `select resolve_dispute($1, 'release', 'Done', 90000, 'RWF', 10000, null,
                              'ops@payhold.test')`,
      [dispute],
    )

    await rejects(
      () => h.db.query(
        `select add_dispute_evidence($1, 'buyer', 'user:buyer', 'photo', 'Late')`, [dispute],
      ),
      /already resolved/,
    )
  })
})

describe('§8 — the timeline', () => {
  test('carries the opening, the requests, the evidence and the decision, in order', async () => {
    const deal = await funded()
    const dispute = await openDispute(deal, { actor: 'user:buyer@example.com' })
    await h.db.query(
      `select add_dispute_evidence($1, 'buyer', 'user:buyer@example.com', 'photo',
                                   'The damage')`,
      [dispute],
    )
    const o = await offer(dispute, 'partial_refund', { by: 'seller', amount: 20_000 })
    await h.db.query(
      `select respond_dispute_offer($1, 'buyer', 'user:buyer@example.com', false)`, [o],
    )
    await h.db.query(
      `select resolve_dispute($1, 'release', 'Proof accepted', 90000, 'RWF', 10000, null,
                              'ops@payhold.test')`,
      [dispute],
    )

    const { rows } = await h.db.query<{ kind: string; at: Date }>(
      `select kind, at from dispute_timeline($1)`, [dispute],
    )
    const kinds = rows.map((r) => r.kind)

    expect(kinds).toContain('dispute_opened')
    expect(kinds).toContain('evidence_photo')
    expect(kinds).toContain('offer_partial_refund')
    expect(kinds).toContain('offer_declined')
    expect(kinds).toContain('resolved')

    // Ordered, which is the whole point of a timeline.
    const times = rows.map((r) => new Date(r.at).getTime())
    expect(times).toEqual([...times].sort((a, b) => a - b))
  })
})

describe('the grants that keep invariant 9 true', () => {
  test('the AI role can read the case file and execute nothing that resolves it', async () => {
    const { rows: [read] } = await h.db.query<{ ok: boolean }>(
      `select has_table_privilege('payhold_ai', 'dispute_evidence', 'select') as ok`,
    )
    expect(read.ok).toBe(true)

    for (const fn of ['resolve_dispute', 'respond_dispute_offer', 'make_dispute_offer']) {
      const { rows } = await h.db.query<{ ok: boolean }>(
        `select has_function_privilege('payhold_ai', p.oid, 'execute') as ok
           from pg_proc p where p.proname = $1`,
        [fn],
      )
      expect(rows.length).toBeGreaterThan(0)
      for (const r of rows) expect(r.ok).toBe(false)
    }
  })

  test('dropping and recreating left exactly one of each', async () => {
    // `create or replace` cannot change a signature — it adds a sibling, and a
    // caller then binds to whichever one matches. `20260807000004` records the
    // draft that learned this.
    for (const fn of ['resolve_dispute', 'open_dispute']) {
      const { rows: [c] } = await h.db.query<{ n: string }>(
        `select count(*) as n from pg_proc where proname = $1`, [fn],
      )
      expect(Number(c.n)).toBe(1)
    }
  })
})
