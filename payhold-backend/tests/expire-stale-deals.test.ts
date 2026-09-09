/**
 * `expire_stale_deals` — the writer `expired` never had (migration
 * 20260909000005).
 *
 * `cancel_deal` closed the abandoned-checkout hole for buyers who say they
 * are leaving. This is the silent half: the tab that closed, the phone that
 * died. Nothing is dispatched, so only elapsed time can notice.
 *
 * What these pin down is mostly what it must NOT touch. A sweep that runs
 * unattended every five minutes and moves deals to a terminal status is one
 * bad predicate away from expiring a live payment, so the refusals matter
 * more here than the happy path: `payment_pending` above all, because a MoMo
 * push the buyer is still approving would land on a deal that can no longer
 * accept it.
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { migrated, rejects, type Harness } from './harness'

let h: Harness
let tenant: string
let seller: string

beforeAll(async () => {
  h = await migrated()
  const { rows: [t] } = await h.db.query<{ id: string }>(
    `insert into tenants (name, slug) values ('Expire Co', 'expire-co') returning id`,
  )
  tenant = t.id
  const { rows: [s] } = await h.db.query<{ id: string }>(
    `insert into sellers (tenant_id, name, country, payout_currency,
                          payout_provider, beneficiary_token, masked_destination)
     values ($1, 'Seller', 'RW', 'RWF', 'flutterwave_momo', 'tok_e', '•••1234')
     returning id`,
    [tenant],
  )
  seller = s.id
  // `enqueue_webhooks` inserts one delivery per registered endpoint, so with
  // none registered the trigger fires and writes nothing — and the
  // delivered-once assertion below would pass for the wrong reason.
  await h.db.query(
    `insert into webhook_endpoints (tenant_id, url, secret_encrypted, masked_secret)
     values ($1, 'https://example.test/hook', 'enc', '•••abcd')`,
    [tenant],
  )
})

afterAll(() => h.close())

/**
 * Backdate a deal's clock.
 *
 * The trigger has to come off to do it. `deals_set_updated_at` runs BEFORE
 * UPDATE and assigns `new.updated_at = now()` unconditionally, so it
 * overwrites an explicit value in the same statement — a fixture that just
 * sets the column produces a row stamped `now()` and nothing ever looks
 * stale. The function measures `greatest(created_at, updated_at)`, so both
 * have to move together.
 */
async function setAge(deal: string, minutes: number): Promise<void> {
  await h.db.query(`alter table deals disable trigger deals_set_updated_at`)
  try {
    await h.db.query(
      `update deals set created_at = now() - ($2 || ' minutes')::interval,
                        updated_at = now() - ($2 || ' minutes')::interval
        where id = $1`,
      [deal, String(minutes)],
    )
  } finally {
    await h.db.query(`alter table deals enable trigger deals_set_updated_at`)
  }
}

async function newDeal(status = 'checkout_started', ageMinutes = 120): Promise<string> {
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
  await setAge(d.id, ageMinutes)
  return d.id
}

async function statusOf(deal: string): Promise<string> {
  const { rows: [d] } = await h.db.query<{ status: string }>(
    `select status from deals where id = $1`, [deal],
  )
  return d.status
}

async function openSession(deal: string, expiresInMinutes: number): Promise<string> {
  const { rows: [s] } = await h.db.query<{ id: string }>(
    `insert into checkout_sessions (tenant_id, deal_id, token, expires_at)
     values ($1, $2, encode(gen_random_bytes(32), 'hex'),
             now() + ($3 || ' minutes')::interval)
     returning id`,
    [tenant, deal, String(expiresInMinutes)],
  )
  return s.id
}

async function sessionStatus(id: string): Promise<string> {
  const { rows: [s] } = await h.db.query<{ status: string }>(
    `select status from checkout_sessions where id = $1`, [id],
  )
  return s.status
}

async function sweep(maxAge = '60 minutes', limit = 500): Promise<string[]> {
  const { rows } = await h.db.query<{ deal_id: string }>(
    `select deal_id from expire_stale_deals($1::interval, $2)`,
    [maxAge, limit],
  )
  return rows.map((r) => r.deal_id)
}

describe('expire_stale_deals — an abandoned checkout stops being open forever', () => {
  test.each(['created', 'checkout_started', 'payment_failed'])(
    'a stale %s deal becomes expired',
    async (from) => {
      const deal = await newDeal(from)
      expect(await sweep()).toContain(deal)
      expect(await statusOf(deal)).toBe('expired')
    },
  )

  test('the audit row records the status it came FROM, not the one it went to', async () => {
    const deal = await newDeal('payment_failed')
    await sweep()
    const { rows } = await h.db.query<{ actor: string; details: { from_status: string } }>(
      `select actor, details from audit_log where deal_id = $1 and action = 'deal.expired'`,
      [deal],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].actor).toBe('system:cron')
    // The trap: `returning * into d` overwrites the record, so reading the
    // status after the update reports 'expired' for every deal ever swept.
    expect(rows[0].details.from_status).toBe('payment_failed')
  })

  test('order.expired is delivered once — the trigger queues it, the function must not', async () => {
    const deal = await newDeal()
    await sweep()
    const { rows: [w] } = await h.db.query<{ n: string }>(
      `select count(*) as n from webhook_deliveries
        where deal_id = $1 and event = 'order.expired'`,
      [deal],
    )
    expect(Number(w.n)).toBe(1)
  })
})

describe('expire_stale_deals — what it must never touch', () => {
  test('a payment in flight is left alone — a MoMo push may still be approved', async () => {
    const deal = await newDeal('payment_pending')
    expect(await sweep()).not.toContain(deal)
    expect(await statusOf(deal)).toBe('payment_pending')
  })

  test('a funded deal is left alone — money exists, and that is a refund', async () => {
    const deal = await newDeal('funded_held')
    expect(await sweep()).not.toContain(deal)
    expect(await statusOf(deal)).toBe('funded_held')
  })

  test('a young deal is left alone', async () => {
    const deal = await newDeal('checkout_started', 5)
    expect(await sweep()).not.toContain(deal)
    expect(await statusOf(deal)).toBe('checkout_started')
  })

  test('recent activity defers it — age is silence, not birth', async () => {
    const deal = await newDeal('checkout_started', 240)
    // The buyer picked a method a minute ago: old row, live checkout.
    await h.db.query(`update deals set updated_at = now() - interval '1 minute' where id = $1`, [deal])
    expect(await sweep()).not.toContain(deal)
    expect(await statusOf(deal)).toBe('checkout_started')
  })
})

describe('expire_stale_deals — a live payment link outranks the cutoff', () => {
  test('an open unexpired session defers the deal, then it expires once the link dies', async () => {
    const deal = await newDeal('checkout_started', 240)
    const session = await openSession(deal, 30)

    expect(await sweep()).not.toContain(deal)
    expect(await statusOf(deal)).toBe('checkout_started')

    // The link's own TTL passes.
    await h.db.query(
      `update checkout_sessions set expires_at = now() - interval '1 minute' where id = $1`,
      [session],
    )

    expect(await sweep()).toContain(deal)
    expect(await statusOf(deal)).toBe('expired')
    // Withdrawn in the same transaction: a live link pointing at a deal that
    // would refuse the money is the failure this must not manufacture.
    expect(await sessionStatus(session)).toBe('canceled')
  })

  test('an already-closed session does not defer anything', async () => {
    const deal = await newDeal('checkout_started', 240)
    const session = await openSession(deal, 30)
    await h.db.query(`update checkout_sessions set status = 'canceled' where id = $1`, [session])
    expect(await sweep()).toContain(deal)
    expect(await statusOf(deal)).toBe('expired')
  })
})

describe('expire_stale_deals — running it repeatedly is safe', () => {
  test('a second pass finds nothing and writes no second audit row', async () => {
    const deal = await newDeal()
    await sweep()
    const second = await sweep()
    expect(second).not.toContain(deal)
    const { rows: [a] } = await h.db.query<{ n: string }>(
      `select count(*) as n from audit_log where deal_id = $1 and action = 'deal.expired'`,
      [deal],
    )
    expect(Number(a.n)).toBe(1)
  })

  test('p_limit caps the batch, and the rest are taken on the next pass', async () => {
    const deals = [await newDeal(), await newDeal(), await newDeal()]
    const first = await sweep('60 minutes', 2)
    expect(first).toHaveLength(2)
    const remaining = deals.filter((d) => !first.includes(d))
    expect(remaining).toHaveLength(1)
    expect(await statusOf(remaining[0])).toBe('checkout_started')
    expect(await sweep('60 minutes', 2)).toContain(remaining[0])
  })

  test('the oldest go first, so a backlog cannot starve the ones waiting longest', async () => {
    const newer = await newDeal('checkout_started', 90)
    const older = await newDeal('checkout_started', 600)
    const swept = await sweep('60 minutes', 1)
    expect(swept).toEqual([older])
    expect(await statusOf(newer)).toBe('checkout_started')
  })

  test('a nonsense cutoff is refused rather than expiring everything', async () => {
    await rejects(() => h.db.query(`select expire_stale_deals('0 minutes'::interval, 500)`),
      /policy_violation/)
    await rejects(() => h.db.query(`select expire_stale_deals('60 minutes'::interval, 0)`),
      /policy_violation/)
  })
})
