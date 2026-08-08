/**
 * Payout retry with capped backoff — spec §13, migration `20260807000014`.
 *
 * Two things are being pinned here, and the second matters more than the first.
 *
 * The ladder: a refused transfer is re-attempted on 1m / 5m / 30m / 2h and then
 * stops. The same shape `record_webhook_attempt` uses, because two backoff
 * curves in one system are two things to reason about at 3am for no gain.
 *
 * The stop: when the budget is spent the payout is `blocked` with **no clock**,
 * and `next_attempt_at is null` is what the cron's `lte` filter excludes. That
 * is how "then move to blocked for operator action" is expressed without a
 * second status meaning "blocked, but really blocked" — and the tests below
 * treat a null clock as the assertion, because it is the actual mechanism.
 */

import { beforeAll, afterAll, describe, expect, test } from 'vitest'
import { migrated, rejects, type Harness } from './harness'

let h: Harness

beforeAll(async () => {
  h = await migrated()
}, 120_000)

afterAll(async () => {
  await h?.close()
})

interface Seeded {
  tenant: string
  seller: string
  deal: string
  payout: string
}

/** A released deal with a scheduled payout — the state a dispatch pass finds. */
async function seedPayout(): Promise<Seeded> {
  const { rows: [tenant] } = await h.db.query<{ id: string }>(
    `insert into tenants (name, slug) values ('Acme', 'acme-' || gen_random_uuid())
     returning id`,
  )
  const { rows: [seller] } = await h.db.query<{ id: string }>(
    `insert into sellers (tenant_id, name, country, payout_currency, payout_provider,
                          beneficiary_token, masked_destination)
     values ($1, 'Host', 'RW', 'RWF', 'flutterwave_momo', 'tok_1', 'MTN •••• 4821')
     returning id`,
    [tenant.id],
  )
  const { rows: [deal] } = await h.db.query<{ id: string }>(
    `insert into deals (tenant_id, buyer_ref, seller_id, description, amount, currency,
                        presentment_currency, presentment_amount, buyer_country,
                        provider, status, fee_amount, expected_complete_at)
     values ($1, 'buyer-1', $2, 'Excavator hire', 100000, 'RWF', 'RWF', 100000, 'RW',
             'flutterwave', 'created', 10000, now() + interval '2 days')
     returning id`,
    [tenant.id, seller.id],
  )

  await h.db.query(
    `select * from fund_deal($1, 'flutterwave', $2, 'mobile_money', 'MTN', 100000, 'RWF', null, 3)`,
    [deal.id, `FLW-${crypto.randomUUID()}`],
  )
  for (const side of ['buyer', 'seller']) {
    await h.db.query(
      `select * from confirm_deal($1, $2::confirm_side, 'user', 90000, 'RWF', 10000)`,
      [deal.id, side],
    )
  }

  const { rows: [payout] } = await h.db.query<{ id: string }>(
    `select id from payouts where deal_id = $1`, [deal.id],
  )

  return { tenant: tenant.id, seller: seller.id, deal: deal.id, payout: payout.id }
}

interface PayoutRow {
  status: string
  attempts: number
  failure_reason: string | null
  next_attempt_at: Date | null
}

const payoutRow = async (id: string): Promise<PayoutRow> => {
  const { rows: [p] } = await h.db.query<PayoutRow>(
    `select status::text, attempts, failure_reason, next_attempt_at
       from payouts where id = $1`,
    [id],
  )
  return p
}

const fail = (id: string, reason = 'Provider refused the transfer') =>
  h.db.query(`select fail_payout($1, $2)`, [id, reason])

/** Minutes from now until the next attempt, rounded — the ladder, readably. */
const waitMinutes = async (id: string): Promise<number | null> => {
  const { rows: [row] } = await h.db.query<{ minutes: number | null }>(
    `select round(extract(epoch from (next_attempt_at - now())) / 60)::int as minutes
       from payouts where id = $1`,
    [id],
  )
  return row.minutes
}

describe('the backoff ladder', () => {
  test('each failure waits longer, and the wait is capped', async () => {
    const s = await seedPayout()
    // A budget wide enough to see the whole ladder, including its flat top.
    await h.db.query(
      `insert into settings (tenant_id, key, value) values ($1, 'payout_retry_max_attempts', '9')`,
      [s.tenant],
    )

    const waits: (number | null)[] = []
    for (let i = 0; i < 5; i += 1) {
      await fail(s.payout)
      waits.push(await waitMinutes(s.payout))
    }

    expect(waits).toEqual([1, 5, 30, 120, 120])
    expect((await payoutRow(s.payout)).status).toBe('failed')
  })

  test('a failed payout keeps its clock and stays retryable', async () => {
    const s = await seedPayout()
    await fail(s.payout)

    const p = await payoutRow(s.payout)
    expect(p.status).toBe('failed')
    expect(p.attempts).toBe(1)
    expect(p.next_attempt_at).not.toBeNull()
    expect(p.failure_reason).toBe('Provider refused the transfer')
  })

  test('the deal comes back out of payout_pending', async () => {
    // §5.1: a failed payout does not lose funds, and the deal must not sit
    // claiming a transfer is in flight when none is.
    const s = await seedPayout()
    await h.db.query(`update deals set status = 'released' where id = $1`, [s.deal])
    await h.db.query(`select mark_payout_processing($1, 'FLW-TRANSFER-1')`, [s.payout])
    expect((await h.db.query<{ status: string }>(
      `select status::text from deals where id = $1`, [s.deal],
    )).rows[0].status).toBe('payout_pending')

    await fail(s.payout)

    const { rows: [d] } = await h.db.query<{ status: string }>(
      `select status::text from deals where id = $1`, [s.deal],
    )
    expect(d.status).toBe('released')
  })
})

describe('when the budget is spent', () => {
  const exhaust = async (s: Seeded, max = 5) => {
    for (let i = 0; i < max; i += 1) await fail(s.payout)
  }

  test('the payout is blocked with no clock, which is what stops the cron', async () => {
    const s = await seedPayout()
    await exhaust(s)

    const p = await payoutRow(s.payout)
    expect(p.status).toBe('blocked')
    expect(p.attempts).toBe(5)
    expect(p.next_attempt_at).toBeNull()
    expect(p.failure_reason).toMatch(/no further automatic attempts after 5 tries/)
  })

  test('it says so in the audit log, separately from the failure', async () => {
    const s = await seedPayout()
    await exhaust(s)

    const { rows } = await h.db.query<{ action: string }>(
      `select action from audit_log
        where deal_id = $1 and action = 'payout.retries_exhausted'`,
      [s.deal],
    )
    expect(rows).toHaveLength(1)
  })

  test('the client is told, once, on the status change', async () => {
    const s = await seedPayout()
    await h.db.query(
      `insert into webhook_endpoints (tenant_id, url, secret_encrypted, masked_secret)
       values ($1, 'https://client.example/hooks', 'enc', 'whsec_••••1')`,
      [s.tenant],
    )
    await exhaust(s)

    const { rows } = await h.db.query<{ event: string }>(
      `select event from webhook_deliveries where deal_id = $1 and event = 'payout.blocked'`,
      [s.deal],
    )
    expect(rows).toHaveLength(1)
  })

  test('a tenant can widen or narrow the budget', async () => {
    const s = await seedPayout()
    await h.db.query(
      `insert into settings (tenant_id, key, value) values ($1, 'payout_retry_max_attempts', '2')`,
      [s.tenant],
    )

    await fail(s.payout)
    expect((await payoutRow(s.payout)).status).toBe('failed')
    await fail(s.payout)
    expect((await payoutRow(s.payout)).status).toBe('blocked')
  })

  test('a budget of zero still buys one attempt', async () => {
    // Otherwise the first transient error a rail has blocks every payout on the
    // account, which is a setting nobody would choose on purpose.
    const s = await seedPayout()
    await h.db.query(
      `insert into settings (tenant_id, key, value) values ($1, 'payout_retry_max_attempts', '0')`,
      [s.tenant],
    )

    await fail(s.payout)
    expect((await payoutRow(s.payout)).status).toBe('blocked')
  })
})

describe('a person putting the clock back', () => {
  test('reset makes it visible to the machine again without spending the counter', async () => {
    const s = await seedPayout()
    for (let i = 0; i < 5; i += 1) await fail(s.payout)
    expect((await payoutRow(s.payout)).next_attempt_at).toBeNull()

    await h.db.query(`select reset_payout_retry($1, 'grace@payhold.io')`, [s.payout])

    const p = await payoutRow(s.payout)
    expect(p.next_attempt_at).not.toBeNull()
    // Untouched on purpose: `route_payout` reads it to decide whether the
    // seller's verified backup destination may be used, and zeroing it would
    // send this attempt back to the primary that has been failing.
    expect(p.attempts).toBe(5)
  })

  test('it is audited against them', async () => {
    const s = await seedPayout()
    await fail(s.payout)
    await h.db.query(`select reset_payout_retry($1, 'grace@payhold.io')`, [s.payout])

    const { rows: [log] } = await h.db.query<{ actor: string }>(
      `select actor from audit_log where deal_id = $1 and action = 'payout.retry_requested'`,
      [s.deal],
    )
    expect(log.actor).toBe('grace@payhold.io')
  })

  test('an anonymous reset is refused', async () => {
    const s = await seedPayout()
    await fail(s.payout)

    await rejects(
      () => h.db.query(`select reset_payout_retry($1, '   ')`, [s.payout]),
      /needs a name/,
    )
  })

  test('a paid payout cannot be re-attempted', async () => {
    const s = await seedPayout()
    // The clearance window has to be over for the pool to be payable at all.
    await h.db.query(
      `update deals set payout_due_at = now() - interval '1 minute' where id = $1`, [s.deal],
    )
    await h.db.query(`select mature_clearing_deals()`)
    await h.db.query(`select settle_payout($1, 90000, 'FLW-DONE')`, [s.payout])

    await rejects(
      () => h.db.query(`select reset_payout_retry($1, 'grace@payhold.io')`, [s.payout]),
      /already paid/,
    )
  })
})

describe('a deal that is over stops being retried', () => {
  test('a refunded deal cancels the payout and clears its clock', async () => {
    // `refund_deal` cancels a scheduled payout by writing `failed` directly.
    // That was inert while `failed` was undispatchable; now the clock is what
    // keeps the cron from re-attempting a transfer nobody is owed.
    const s = await seedPayout()
    await h.db.query(`select refund_deal($1, 'Buyer cancelled', 'dashboard')`, [s.deal])

    const p = await payoutRow(s.payout)
    expect(p.status).toBe('failed')
    expect(p.next_attempt_at).toBeNull()
  })

  test('a person cannot put the clock back on a finished deal either', async () => {
    const s = await seedPayout()
    await h.db.query(`select refund_deal($1, 'Buyer cancelled', 'dashboard')`, [s.deal])
    await h.db.query(`select reset_payout_retry($1, 'grace@payhold.io')`, [s.payout])

    expect((await payoutRow(s.payout)).next_attempt_at).toBeNull()
  })

  test('a disputed deal keeps its clock — a dispute ends', async () => {
    const s = await seedPayout()
    await h.db.query(
      `insert into disputes (tenant_id, deal_id, raised_by, reason)
       values ($1, $2, 'buyer', 'Not as described')`,
      [s.tenant, s.deal],
    )
    await h.db.query(`update deals set status = 'disputed' where id = $1`, [s.deal])
    await fail(s.payout)

    expect((await payoutRow(s.payout)).next_attempt_at).not.toBeNull()
  })
})

describe('an async rail retried', () => {
  test('a second attempt can be marked processing from failed', async () => {
    // The first attempt left it `failed`; `route_payout` only rewrites
    // `blocked`, so the retry arrives here from `failed`. Before phase 9 this
    // raised `cannot be marked processing`, and nothing reached it because the
    // only retry was a person on a synchronous rail.
    const s = await seedPayout()
    await fail(s.payout)

    await h.db.query(`select mark_payout_processing($1, 'FLW-TRANSFER-2')`, [s.payout])

    const p = await payoutRow(s.payout)
    expect(p.status).toBe('processing')
  })
})
