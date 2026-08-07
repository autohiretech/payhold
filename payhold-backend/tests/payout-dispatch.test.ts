/**
 * The end of the lifecycle: the auto-release timer, and clearance → payout.
 *
 * These are the two paths that move money without anybody pressing anything,
 * so what they must not do matters more than what they do:
 *
 *   a timer must go through the same lock and the same both-confirmations
 *   re-check as a human confirmation, rather than having a release path of its
 *   own that could drift from it;
 *
 *   a payout must leave the clearing pool at exactly zero, or `available`
 *   never returns to zero and the reconciliation pass reads the residue as
 *   drift — which freezes the tenant over a rounding error; and
 *
 *   nothing automatic may move a payout a rule stopped.
 *
 * The Edge Functions own the ordering and the provider calls; this file owns
 * the transactional half they call into.
 */

import { beforeAll, afterAll, describe, expect, test } from 'vitest'
import { migrated, rejects, type Harness } from './harness'

let h: Harness

interface Seeded {
  tenant: string
  seller: string
  deal: string
}

/**
 * A funded deal, ready to be confirmed.
 *
 * `presentment` defaults to the settlement amount — the same-currency case.
 * Passing a different one is the cross-border case, which is where the payout
 * arithmetic can go wrong without anybody noticing.
 */
async function seedFunded(opts: {
  amount?: number
  presentment?: number
  presentmentCurrency?: string
  payoutCurrency?: string
} = {}): Promise<Seeded> {
  const amount = opts.amount ?? 100_000
  const presentment = opts.presentment ?? amount

  const { rows: [tenant] } = await h.db.query<{ id: string }>(
    `insert into tenants (name, slug) values ('Acme', 'acme-' || gen_random_uuid())
     returning id`,
  )
  const { rows: [seller] } = await h.db.query<{ id: string }>(
    `insert into sellers (tenant_id, name, country, payout_currency, payout_provider,
                          beneficiary_token, masked_destination)
     values ($1, 'Host', 'RW', $2, 'flutterwave_momo', 'tok_1', 'MTN •••• 4821')
     returning id`,
    [tenant.id, opts.payoutCurrency ?? 'RWF'],
  )
  const { rows: [deal] } = await h.db.query<{ id: string }>(
    `insert into deals (tenant_id, buyer_ref, seller_id, description, amount, currency,
                        presentment_currency, presentment_amount, buyer_country,
                        provider, status, fee_amount, expected_complete_at)
     values ($1, 'buyer-1', $2, 'Excavator hire', $3, 'RWF', $4, $5, 'RW',
             'flutterwave', 'created', $6, now() + interval '2 days')
     returning id`,
    [
      tenant.id, seller.id, amount,
      opts.presentmentCurrency ?? 'RWF',
      presentment,
      Math.round(amount * 0.1),
    ],
  )

  await h.db.query(
    `select * from fund_deal($1, 'flutterwave', $2, 'mobile_money', 'MTN', $3, $4, null, 3)`,
    [deal.id, `FLW-${crypto.randomUUID()}`, presentment, opts.presentmentCurrency ?? 'RWF'],
  )

  return { tenant: tenant.id, seller: seller.id, deal: deal.id }
}

/** Confirm one side, supplying the figures the Edge Function would convert. */
const confirm = (
  s: Seeded,
  side: 'buyer' | 'seller',
  actor: 'user' | 'auto',
  figures: { payout: number; currency: string; fee: number },
) =>
  h.db.query(
    `select * from confirm_deal($1, $2::confirm_side, $3::confirm_actor, $4, $5, $6)`,
    [s.deal, side, actor, figures.payout, figures.currency, figures.fee],
  )

const payoutFor = async (deal: string) => {
  const { rows: [p] } = await h.db.query<{
    id: string
    amount: number
    currency: string
    status: string
    attempts: number
    provider_ref: string | null
    review_approved_by: string | null
  }>(
    `select id, amount, currency, status, attempts, provider_ref, review_approved_by
     from payouts where deal_id = $1`,
    [deal],
  )
  return p
}

/**
 * The clearing pool for one deal, by the same arithmetic `rail_balances` uses.
 *
 * This is the number the Edge Function's `amountLeaving` reads back, and after
 * a settlement it must be exactly zero.
 */
const clearing = async (deal: string) => {
  const { rows: [row] } = await h.db.query<{ clearing: number }>(
    `select coalesce(sum(
       case entry_type
         when 'release' then -amount
         when 'fee'     then  amount
         when 'payout'  then  amount
         else 0
       end), 0)::int as clearing
     from ledger where deal_id = $1`,
    [deal],
  )
  return row.clearing
}

/**
 * Close the clearance window.
 *
 * Both dates, because two different guards read two different columns:
 * the dispatch cron selects on `payouts.scheduled_for`, and the balance guard
 * inside `settle_payout` counts a deal as `available` only once its
 * `payout_due_at` has passed. `release_deal` sets them from the same clearance
 * setting, so they agree in production — a fixture that moved only one would
 * be testing a state the engine never produces.
 */
const closeClearance = async (deal: string) => {
  await h.db.query(
    `update deals set payout_due_at = now() - interval '1 day' where id = $1`,
    [deal],
  )
  await h.db.query(
    `update payouts set scheduled_for = now() - interval '1 day' where deal_id = $1`,
    [deal],
  )
}

const confirmations = async (deal: string) => {
  const { rows } = await h.db.query<{ side: string; actor: string }>(
    `select side, actor from confirmations where deal_id = $1 order by side`,
    [deal],
  )
  return rows
}

const auditActions = async (deal: string) => {
  const { rows } = await h.db.query<{ action: string }>(
    `select action from audit_log where deal_id = $1 order by created_at, id`,
    [deal],
  )
  return rows.map((r) => r.action)
}

beforeAll(async () => { h = await migrated() }, 120_000)
afterAll(async () => { await h?.close() })

// ---------------------------------------------------------------------------
// The timer
// ---------------------------------------------------------------------------

describe('the auto-release timer', () => {
  test('releases through confirm_deal, recording the silent sides as auto', async () => {
    const s = await seedFunded()
    const figures = { payout: 90_000, currency: 'RWF', fee: 10_000 }

    // What the cron does: both sides, in order.
    await confirm(s, 'buyer', 'auto', figures)
    await confirm(s, 'seller', 'auto', figures)

    const { rows: [d] } = await h.db.query<{ status: string }>(
      `select status from deals where id = $1`,
      [s.deal],
    )
    expect(d.status).toBe('clearing')
    expect(await confirmations(s.deal)).toEqual([
      { side: 'buyer', actor: 'auto' },
      { side: 'seller', actor: 'auto' },
    ])
  })

  test('leaves a side that really confirmed attributed to the person', async () => {
    const s = await seedFunded()
    const figures = { payout: 90_000, currency: 'RWF', fee: 10_000 }

    await confirm(s, 'buyer', 'user', figures)
    // The timer fires and sweeps both sides; the buyer's own confirmation must
    // survive it, or the audit trail stops distinguishing a buyer who agreed
    // from one who went quiet.
    await confirm(s, 'buyer', 'auto', figures)
    await confirm(s, 'seller', 'auto', figures)

    expect(await confirmations(s.deal)).toEqual([
      { side: 'buyer', actor: 'user' },
      { side: 'seller', actor: 'auto' },
    ])
  })

  test('cannot fire on a disputed deal', async () => {
    const s = await seedFunded()
    await h.db.query(
      `select * from open_dispute($1, 'buyer', 'Machine never arrived')`,
      [s.deal],
    )

    await rejects(
      () => confirm(s, 'buyer', 'auto', { payout: 90_000, currency: 'RWF', fee: 10_000 }),
      /disputed/,
    )
  })

  test('a released deal refuses a second pass, and keeps one payout', async () => {
    const s = await seedFunded()
    const figures = { payout: 90_000, currency: 'RWF', fee: 10_000 }

    await confirm(s, 'buyer', 'auto', figures)
    await confirm(s, 'seller', 'auto', figures)

    // Two cron passes overlapping, or one retried after a timeout. The second
    // is refused under the lock rather than releasing again — which is why the
    // cron treats this message as "already done" instead of an error.
    await rejects(() => confirm(s, 'buyer', 'auto', figures), /can no longer be confirmed/)

    const { rows } = await h.db.query(
      `select id from payouts where deal_id = $1`,
      [s.deal],
    )
    expect(rows).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

describe('payout dispatch', () => {
  /** Release a deal and return its payout, with the clearance window closed. */
  async function readyToPay(opts: Parameters<typeof seedFunded>[0] = {}) {
    const s = await seedFunded(opts)
    const amount = opts.amount ?? 100_000
    const fee = Math.round(amount * 0.1)
    const presentment = opts.presentment ?? amount

    // The figures the Edge Function converts: the seller is owed the net in
    // their currency, the fee leaves the balance we actually hold.
    const feePresentment = Math.round(fee * (presentment / amount))
    const figures = {
      payout: Math.round((amount - fee) * (presentment / amount)),
      currency: opts.payoutCurrency ?? 'RWF',
      fee: feePresentment,
    }

    await confirm(s, 'buyer', 'user', figures)
    await confirm(s, 'seller', 'user', figures)
    await closeClearance(s.deal)
    return { ...s, feePresentment, presentment }
  }

  test('settling drains the clearing pool to exactly zero', async () => {
    const s = await readyToPay()
    const p = await payoutFor(s.deal)

    // What `amountLeaving` computes, read off the ledger.
    const leaving = await clearing(s.deal)
    expect(leaving).toBe(s.presentment - s.feePresentment)

    await h.db.query(`select * from settle_payout($1, $2, 'FLW-TRF-1')`, [p.id, leaving])

    expect(await clearing(s.deal)).toBe(0)
  })

  test('drains to zero cross-border too, where a conversion would not', async () => {
    // A Rwandan seller owed RWF, a buyer charged USD. Converting the payout
    // amount back would land near the right number but not on it, and the
    // difference would sit in `available` forever.
    const s = await readyToPay({
      amount: 1_400_000,
      presentment: 100_00,
      presentmentCurrency: 'USD',
      payoutCurrency: 'RWF',
    })
    const p = await payoutFor(s.deal)

    const leaving = await clearing(s.deal)
    await h.db.query(`select * from settle_payout($1, $2, 'FLW-TRF-2')`, [p.id, leaving])

    expect(await clearing(s.deal)).toBe(0)

    const { rows: [bal] } = await h.db.query<{ available: number }>(
      `select available::int from rail_balances($1) where currency = 'USD'`,
      [s.tenant],
    )
    expect(bal.available).toBe(0)
  })

  test('marks the deal paid out and books the debit', async () => {
    const s = await readyToPay()
    const p = await payoutFor(s.deal)

    await h.db.query(
      `select * from settle_payout($1, $2, 'FLW-TRF-3')`,
      [p.id, await clearing(s.deal)],
    )

    const { rows: [d] } = await h.db.query<{ status: string }>(
      `select status from deals where id = $1`,
      [s.deal],
    )
    expect(d.status).toBe('paid_out')

    const after = await payoutFor(s.deal)
    expect(after.status).toBe('paid')
    expect(after.provider_ref).toBe('FLW-TRF-3')
    expect(after.attempts).toBe(1)
  })

  test('settling twice is a no-op, not a second debit', async () => {
    const s = await readyToPay()
    const p = await payoutFor(s.deal)
    const leaving = await clearing(s.deal)

    await h.db.query(`select * from settle_payout($1, $2, 'FLW-TRF-4')`, [p.id, leaving])
    // The retry a timed-out cron pass makes. The provider returns the same
    // transfer on the same idempotency key; this must return the same payout.
    await h.db.query(`select * from settle_payout($1, $2, 'FLW-TRF-4')`, [p.id, leaving])

    const { rows } = await h.db.query<{ n: number }>(
      `select count(*)::int as n from ledger where deal_id = $1 and entry_type = 'payout'`,
      [s.deal],
    )
    expect(rows[0].n).toBe(1)
    expect((await payoutFor(s.deal)).attempts).toBe(1)
  })

  test('a payout may never exceed the available balance', async () => {
    const s = await readyToPay()
    const p = await payoutFor(s.deal)
    const tooMuch = (await clearing(s.deal)) + 1

    await rejects(
      () => h.db.query(`select * from settle_payout($1, $2, 'FLW-TRF-5')`, [p.id, tooMuch]),
      /insufficient_balance/,
    )
  })

  test('a failure records a reason and leaves it retryable', async () => {
    const s = await readyToPay()
    const p = await payoutFor(s.deal)

    await h.db.query(`select * from fail_payout($1, 'Provider rejected the transfer')`, [p.id])

    const failed = await payoutFor(s.deal)
    expect(failed.status).toBe('failed')
    expect(failed.attempts).toBe(1)

    // The retry succeeds and the attempt counter carries.
    await h.db.query(
      `select * from settle_payout($1, $2, 'FLW-TRF-6')`,
      [p.id, await clearing(s.deal)],
    )
    expect((await payoutFor(s.deal)).status).toBe('paid')
    expect((await payoutFor(s.deal)).attempts).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// The in-flight state
// ---------------------------------------------------------------------------

describe('mark_payout_processing', () => {
  async function scheduled() {
    const s = await seedFunded()
    const figures = { payout: 90_000, currency: 'RWF', fee: 10_000 }
    await confirm(s, 'buyer', 'user', figures)
    await confirm(s, 'seller', 'user', figures)
    await closeClearance(s.deal)
    return { s, p: await payoutFor(s.deal) }
  }

  test('records the transfer reference without booking the money', async () => {
    const { s, p } = await scheduled()

    await h.db.query(`select * from mark_payout_processing($1, 'FLW-TRF-P1')`, [p.id])

    const after = await payoutFor(s.deal)
    expect(after.status).toBe('processing')
    expect(after.provider_ref).toBe('FLW-TRF-P1')
    // Nothing has left yet. A pending transfer that books a debit is a payout
    // credited to a seller who may still not be paid.
    expect(await clearing(s.deal)).toBe(90_000)
    expect(await auditActions(s.deal)).toContain('payout.processing')
  })

  test('a polled transfer that settles still books exactly once', async () => {
    const { s, p } = await scheduled()

    await h.db.query(`select * from mark_payout_processing($1, 'FLW-TRF-P2')`, [p.id])
    // The next pass re-sends on the same idempotency key and the provider now
    // reports it settled.
    await h.db.query(
      `select * from settle_payout($1, $2, 'FLW-TRF-P2')`,
      [p.id, await clearing(s.deal)],
    )

    expect((await payoutFor(s.deal)).status).toBe('paid')
    expect(await clearing(s.deal)).toBe(0)
  })

  test('cannot walk a paid payout backwards', async () => {
    const { s, p } = await scheduled()
    await h.db.query(
      `select * from settle_payout($1, $2, 'FLW-TRF-P3')`,
      [p.id, await clearing(s.deal)],
    )

    await rejects(
      () => h.db.query(`select * from mark_payout_processing($1, 'FLW-TRF-P4')`, [p.id]),
      /invalid_state/,
    )
  })

  test('cannot send a payout a rule is holding', async () => {
    const { p } = await scheduled()
    await h.db.query(
      `update payouts set status = 'held_for_review', review_held_at = now() where id = $1`,
      [p.id],
    )

    // The guard that matters: no machine path may take a held payout to the
    // provider. Only `approve_payout_review` moves it, and only a person calls
    // that — invariant 11.
    await rejects(
      () => h.db.query(`select * from mark_payout_processing($1, 'FLW-TRF-P5')`, [p.id]),
      /invalid_state/,
    )
  })
})
