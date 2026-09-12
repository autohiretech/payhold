/**
 * A payout the rail cannot fund yet — `hold_payout_unfunded`.
 *
 * The preflight that calls this lives in `_shared/dispatch.ts` and the
 * question it asks is tested in `_shared/payout-funding.test.ts`. What is
 * tested here is the half that touches money's own bookkeeping: the status it
 * writes, the clock it must not spend, the ledger it must not touch, and the
 * audit trail it must not flood.
 *
 * The distinction that matters throughout: nothing here was *refused* by
 * anybody. We declined to ask, on a condition that comes good by itself. So
 * this must behave like §5.1's no-route `blocked` — kept, re-asked, costing
 * nobody an attempt — and not like `fail_payout`, which spends §13's budget
 * and lands a payout somewhere only a person can move it from.
 */

import { beforeAll, afterAll, describe, expect, test } from 'vitest'
import { migrated, rejects, type Harness } from './harness'

let h: Harness

interface Seeded {
  tenant: string
  seller: string
  deal: string
  payout: string
}

/** A tenant with one released deal and the payout it queued. */
async function seed(): Promise<Seeded> {
  const { rows: [tenant] } = await h.db.query<{ id: string }>(
    `insert into tenants (name, slug) values ('Acme', 'acme-' || gen_random_uuid())
     returning id`,
  )
  const { rows: [seller] } = await h.db.query<{ id: string }>(
    `insert into sellers (tenant_id, name, country, payout_currency, payout_provider,
                          beneficiary_token, masked_destination, created_at)
     values ($1, 'Host', 'RW', 'RWF', 'flutterwave_momo', 'tok_1', 'MTN •••• 4821',
             now() - interval '400 days')
     returning id`,
    [tenant.id],
  )
  const { rows: [deal] } = await h.db.query<{ id: string }>(
    `insert into deals (tenant_id, buyer_ref, seller_id, description, amount, currency,
                        presentment_currency, presentment_amount, buyer_country,
                        provider, provider_ref, status, fee_amount)
     values ($1, 'buyer-1', $2, 'Excavator hire', 100000, 'RWF', 'RWF', 100000, 'RW',
             'flutterwave', 'ref-' || gen_random_uuid(), 'funded_held', 10000)
     returning id`,
    [tenant.id, seller.id],
  )

  await h.db.query(
    `insert into ledger (tenant_id, deal_id, entry_type, amount, currency, provider)
     values ($1, $2, 'hold', 100000, 'RWF', 'flutterwave')`,
    [tenant.id, deal.id],
  )
  await h.db.query(`insert into confirmations (deal_id, side) values ($1, 'buyer')`, [deal.id])
  await h.db.query(`insert into confirmations (deal_id, side) values ($1, 'seller')`, [deal.id])
  await h.db.query(`select release_deal($1, 90000, 'RWF', 10000)`, [deal.id])

  const { rows: [payout] } = await h.db.query<{ id: string }>(
    `select id from payouts where deal_id = $1`, [deal.id],
  )
  return { tenant: tenant.id, seller: seller.id, deal: deal.id, payout: payout.id }
}

const REASON = 'Not sent: flutterwave reports 0 RWF withdrawable and this payout ' +
  'needs 90000 RWF (short by 90000). Nothing has been sent and the payout is ' +
  're-checked every pass.'

const hold = (payout: string, reason = REASON) =>
  h.db.query(`select hold_payout_unfunded($1, $2)`, [payout, reason])

const payoutRow = async (id: string) => {
  const { rows: [p] } = await h.db.query<{
    status: string
    failure_reason: string | null
    next_attempt_at: string | null
    attempts: number
    review_held_by: string | null
  }>(
    `select status, failure_reason, next_attempt_at, attempts, review_held_by
       from payouts where id = $1`,
    [id],
  )
  return p
}

const auditRows = async (deal: string) => {
  const { rows } = await h.db.query<{ action: string; details: Record<string, unknown> }>(
    `select action, details from audit_log
      where deal_id = $1 and action = 'payout.blocked' order by created_at`,
    [deal],
  )
  return rows
}

beforeAll(async () => { h = await migrated() })
afterAll(async () => { await h.close() })

describe('a payout the rail cannot fund', () => {
  test('is blocked, carrying what the rail said', async () => {
    const s = await seed()
    await hold(s.payout)

    const p = await payoutRow(s.payout)
    expect(p.status).toBe('blocked')
    expect(p.failure_reason).toBe(REASON)
  })

  test('does not spend the retry budget', async () => {
    // The whole reason this is not `fail_payout`. Five refusals from a rail is
    // evidence about that rail; a settlement that has not landed yet is not,
    // and a seller must not lose an attempt to it.
    const s = await seed()
    const before = await payoutRow(s.payout)

    await hold(s.payout)
    await hold(s.payout)
    await hold(s.payout)

    const after = await payoutRow(s.payout)
    expect(after.attempts).toBe(before.attempts)
  })

  test('leaves the clock alone, so a machine re-asks', async () => {
    // `fail_payout` clears `next_attempt_at` once the budget is spent, and a
    // null clock means no machine may try again. This condition resolves with
    // nobody doing anything, so the clock has to survive.
    const s = await seed()
    const before = await payoutRow(s.payout)
    await hold(s.payout)
    const after = await payoutRow(s.payout)

    expect(after.next_attempt_at).toEqual(before.next_attempt_at)
  })

  test('names nobody, because nobody decided it', async () => {
    // Invariant 11's tell: `review_held_by` null means arithmetic did this. A
    // name here would make it look like a person's hold, which
    // `approve_payout_review` is the way out of — and this needs no approval.
    const s = await seed()
    await hold(s.payout)

    expect((await payoutRow(s.payout)).review_held_by).toBeNull()
  })

  test('moves no money', async () => {
    const s = await seed()
    const { rows: [before] } = await h.db.query<{ n: string }>(
      `select count(*) as n from ledger where deal_id = $1`, [s.deal],
    )
    await hold(s.payout)
    const { rows: [after] } = await h.db.query<{ n: string }>(
      `select count(*) as n from ledger where deal_id = $1`, [s.deal],
    )

    expect(after.n).toBe(before.n)
  })

  describe('the audit trail', () => {
    test('records it once, not once per pass', async () => {
      // `blocked` is dispatchable, so this is re-asked every pass for as long
      // as the balance is short. An unconditional insert would write a row an
      // hour for days, and §24.3's labels cannot be thinned out afterwards.
      const s = await seed()
      await hold(s.payout)
      await hold(s.payout)
      await hold(s.payout)

      const rows = await auditRows(s.deal)
      expect(rows).toHaveLength(1)
      expect(rows[0].details.reason_code).toBe('rail_balance_short')
      expect(rows[0].details.reason).toBe(REASON)
    })

    test('records again when the figures change', async () => {
      // A shortfall that shrank is news: it says a settlement is arriving,
      // which is exactly what somebody watching a stuck payout wants to see.
      const s = await seed()
      await hold(s.payout)
      await hold(s.payout, REASON.replace('0 RWF', '40000 RWF'))

      expect(await auditRows(s.deal)).toHaveLength(2)
    })
  })

  describe('what it refuses', () => {
    test('a payout already with the rail', async () => {
      // Recalling an in-flight transfer is a conversation with the provider.
      // `hold_payout` refuses the same two statuses for the same reason.
      const s = await seed()
      await h.db.query(`update payouts set status = 'processing' where id = $1`, [s.payout])

      await rejects(() => hold(s.payout), /invalid_state.*cannot be held for funding/)
    })

    test('a payout already paid', async () => {
      const s = await seed()
      await h.db.query(
        `update payouts set status = 'paid', paid_at = now(), provider_ref = 'FLW-1'
          where id = $1`,
        [s.payout],
      )

      await rejects(() => hold(s.payout), /invalid_state.*cannot be held for funding/)
    })

    test('a hold with nothing to say', async () => {
      // The figures are the entire value of the row. A blank reason would be a
      // blocked payout with no explanation, which is the state this exists to
      // prevent.
      const s = await seed()

      await rejects(() => hold(s.payout, '   '), /invalid_request.*what the rail reported/)
    })

    test('a payout that does not exist', async () => {
      await rejects(
        () => hold('00000000-0000-0000-0000-000000000000'),
        /not_found: payout .* does not exist/,
      )
    })
  })

  test('the AI role cannot reach it', async () => {
    // Invariant 9 as a grant list: a recreated function is granted to PUBLIC by
    // default, which is the trap `refund_deal` and `resolve_dispute` both fell
    // into. This one stops a payout, and the AI layer may stop nothing.
    const { rows } = await h.db.query<{ ok: boolean }>(
      `select has_function_privilege('payhold_ai',
         'hold_payout_unfunded(uuid, text)', 'execute') as ok`,
    )
    expect(rows[0].ok).toBe(false)
  })

  test('there is exactly one of it', async () => {
    const { rows } = await h.db.query<{ n: number }>(
      `select count(*)::int as n from pg_proc where proname = 'hold_payout_unfunded'`,
    )
    expect(rows[0].n).toBe(1)
  })
})
