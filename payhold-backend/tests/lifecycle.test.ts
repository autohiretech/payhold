/**
 * Spec §6 — the order lifecycle.
 *
 * The transition guard, the clearance window as an observable state, and the
 * per-deal completion policy. The counterpart in the dashboard's mock is
 * `src/api/mock/engine.test.ts`; a rule that changes has to change in both.
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { migrated, rejects, type Harness } from './harness'

let h: Harness

// One tenant, one seller, reused. Each test makes its own deal.
let tenant: string
let seller: string

beforeAll(async () => {
  h = await migrated()

  const { rows: [t] } = await h.db.query<{ id: string }>(
    `insert into tenants (name, slug) values ('Lifecycle Co', 'lifecycle-co')
     returning id`,
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

async function newDeal(overrides: Record<string, unknown> = {}): Promise<string> {
  const cols = Object.keys(overrides)
  const extraCols = cols.length ? `, ${cols.join(', ')}` : ''
  const extraVals = cols.length
    ? `, ${cols.map((_, i) => `$${i + 3}`).join(', ')}`
    : ''

  const { rows: [d] } = await h.db.query<{ id: string }>(
    `insert into deals (
       tenant_id, buyer_ref, seller_id, description, amount, currency,
       presentment_currency, presentment_amount, buyer_country, provider,
       fee_amount${extraCols}
     )
     values ($1, 'buyer_1', $2, 'A rental', 100000, 'RWF',
             'RWF', 100000, 'RW', 'fake', 10000${extraVals})
     returning id`,
    [tenant, seller, ...Object.values(overrides)],
  )
  return d.id
}

async function statusOf(deal: string): Promise<string> {
  const { rows: [d] } = await h.db.query<{ status: string }>(
    `select status from deals where id = $1`, [deal],
  )
  return d.status
}

/** Fund, confirm both sides, and land in `clearing`. */
async function toClearing(deal: string): Promise<void> {
  await h.db.query(`update deals set status = 'funded_held' where id = $1`, [deal])
  await h.db.query(`select confirm_deal($1, 'buyer', 'user', 90000, 'RWF', 10000)`, [deal])
  await h.db.query(`select confirm_deal($1, 'seller', 'user', 90000, 'RWF', 10000)`, [deal])
}

describe('the transition guard', () => {
  test('describes the whole enum — every state has an answer', async () => {
    // `deal_transition_allowed` is a CASE with an `else false`, which would
    // silently swallow a state nobody wrote a branch for. This asserts each
    // one was actually considered: a terminal state legitimately allows
    // nothing, but every other state must lead somewhere.
    const { rows } = await h.db.query<{ status: string; n: number }>(
      `select s.status::text as status,
              (select count(*)::int from unnest(enum_range(null::deal_status)) t
                where deal_transition_allowed(s.status, t)) as n
         from unnest(enum_range(null::deal_status)) s(status)`,
    )

    const terminal = ['refunded', 'expired', 'canceled']
    for (const row of rows) {
      if (terminal.includes(row.status)) {
        expect(row.n, `${row.status} should be terminal`).toBe(0)
      } else {
        expect(row.n, `${row.status} leads nowhere`).toBeGreaterThan(0)
      }
    }
  })

  test('a deal cannot skip from created to paid out', async () => {
    const deal = await newDeal()
    await rejects(
      () => h.db.query(`update deals set status = 'paid_out' where id = $1`, [deal]),
      /invalid_transition: a deal cannot go from created to paid_out/,
    )
  })

  test('a terminal state is terminal', async () => {
    const deal = await newDeal()
    await h.db.query(`update deals set status = 'canceled' where id = $1`, [deal])
    await rejects(
      () => h.db.query(`update deals set status = 'funded_held' where id = $1`, [deal]),
      /invalid_transition/,
    )
  })

  test('writing the same status twice is not a transition', async () => {
    const deal = await newDeal()
    await h.db.query(`update deals set status = 'funded_held' where id = $1`, [deal])
    // No-op rather than `funded_held -> funded_held`, which is not in the map.
    await h.db.query(`update deals set status = 'funded_held' where id = $1`, [deal])
    expect(await statusOf(deal)).toBe('funded_held')
  })

  test('an illegal transition queues no webhook', async () => {
    const { rows: [e] } = await h.db.query<{ id: string }>(
      `insert into webhook_endpoints (tenant_id, url, secret_encrypted, masked_secret)
       values ($1, 'https://client.example/hooks', 'enc', 'whsec_••••1')
       returning id`,
      [tenant],
    )
    const deal = await newDeal()

    await rejects(
      () => h.db.query(`update deals set status = 'paid_out' where id = $1`, [deal]),
      /invalid_transition/,
    )

    // The guard is a BEFORE trigger and the emitter an AFTER one, so the
    // refusal happens first. A client must never be told about a state the
    // database refused to write.
    const { rows } = await h.db.query(
      `select 1 from webhook_deliveries where deal_id = $1`, [deal],
    )
    expect(rows).toHaveLength(0)

    await h.db.query(`delete from webhook_endpoints where id = $1`, [e.id])
  })
})

describe('the clearance window', () => {
  test('the second confirmation lands in clearing, not released', async () => {
    const deal = await newDeal()
    await toClearing(deal)

    expect(await statusOf(deal)).toBe('clearing')

    const { rows: [d] } = await h.db.query<{
      released_at: string | null
      payout_due_at: string | null
    }>(`select released_at, payout_due_at from deals where id = $1`, [deal])

    // The money left the hold here, whatever the status is called.
    expect(d.released_at).toBeTruthy()
    expect(d.payout_due_at).toBeTruthy()
  })

  test('the ledger is written on entry to clearing, not on entry to released', async () => {
    const deal = await newDeal()
    await toClearing(deal)

    const { rows } = await h.db.query<{ entry_type: string }>(
      `select entry_type::text from ledger where deal_id = $1 order by entry_type::text`,
      [deal],
    )
    expect(rows.map((r) => r.entry_type)).toEqual(['fee', 'release'])
  })

  test('a deal inside its window is not matured', async () => {
    const deal = await newDeal()
    await toClearing(deal)

    const { rows } = await h.db.query(`select * from mature_clearing_deals()`)
    expect(rows.find((r) => (r as { id: string }).id === deal)).toBeUndefined()
    expect(await statusOf(deal)).toBe('clearing')
  })

  test('a deal past its window becomes released', async () => {
    const deal = await newDeal()
    await toClearing(deal)
    await h.db.query(
      `update deals set payout_due_at = now() - interval '1 hour' where id = $1`,
      [deal],
    )

    await h.db.query(`select * from mature_clearing_deals()`)
    expect(await statusOf(deal)).toBe('released')
  })

  test('maturing moves no money', async () => {
    const deal = await newDeal()
    await toClearing(deal)
    const before = await h.db.query(`select id from ledger where deal_id = $1`, [deal])

    await h.db.query(
      `update deals set payout_due_at = now() - interval '1 hour' where id = $1`,
      [deal],
    )
    await h.db.query(`select * from mature_clearing_deals()`)

    const after = await h.db.query(`select id from ledger where deal_id = $1`, [deal])
    expect(after.rows).toHaveLength(before.rows.length)
  })

  test('a disputed deal is never matured', async () => {
    const deal = await newDeal()
    await toClearing(deal)
    await h.db.query(`select open_dispute($1, 'buyer', 'Damage on return')`, [deal])
    await h.db.query(
      `update deals set payout_due_at = now() - interval '1 hour' where id = $1`,
      [deal],
    )

    await h.db.query(`select * from mature_clearing_deals()`)
    expect(await statusOf(deal)).toBe('disputed')
  })

  test('maturing twice is a no-op', async () => {
    const deal = await newDeal()
    await toClearing(deal)
    await h.db.query(
      `update deals set payout_due_at = now() - interval '1 hour' where id = $1`,
      [deal],
    )

    await h.db.query(`select * from mature_clearing_deals()`)
    const { rows } = await h.db.query(`select * from mature_clearing_deals()`)

    expect(rows.find((r) => (r as { id: string }).id === deal)).toBeUndefined()
    expect(await statusOf(deal)).toBe('released')
  })
})

describe('the completion policy — §14', () => {
  test('a deal with no policy takes the tenant default of 14 days', async () => {
    const deal = await newDeal()
    await toClearing(deal)

    const { rows: [d] } = await h.db.query<{ days: number }>(
      `select round(extract(epoch from (payout_due_at - released_at)) / 86400)::int as days
         from deals where id = $1`,
      [deal],
    )
    // §29.7 — the V1 default was 7.
    expect(d.days).toBe(14)
  })

  test('a deal carrying its own clearing_days wins over the tenant setting', async () => {
    await h.db.query(
      `insert into settings (tenant_id, key, value) values ($1, 'clearance_days', '30')
       on conflict (tenant_id, key) do update set value = excluded.value`,
      [tenant],
    )
    const deal = await newDeal({ clearing_days: 3 })
    await toClearing(deal)

    const { rows: [d] } = await h.db.query<{ days: number }>(
      `select round(extract(epoch from (payout_due_at - released_at)) / 86400)::int as days
         from deals where id = $1`,
      [deal],
    )
    expect(d.days).toBe(3)

    await h.db.query(`delete from settings where tenant_id = $1 and key = 'clearance_days'`,
                     [tenant])
  })

  test('zero clearing days is a policy, not a missing one', async () => {
    // `coalesce` would read 0 as present and null as absent, which is the
    // behaviour wanted — but only if the column allows 0 in the first place.
    const deal = await newDeal({ clearing_days: 0 })
    await toClearing(deal)

    const { rows: [d] } = await h.db.query<{ same: boolean }>(
      `select payout_due_at = released_at as same from deals where id = $1`, [deal],
    )
    expect(d.same).toBe(true)
  })

  test('a negative clearance window is refused', async () => {
    await rejects(
      () => newDeal({ clearing_days: -1 }),
      /deals_clearing_days_check/,
    )
  })
})

describe('payout states drag the deal', () => {
  async function payoutFor(deal: string): Promise<string> {
    const { rows: [p] } = await h.db.query<{ id: string }>(
      `select id from payouts where deal_id = $1`, [deal],
    )
    return p.id
  }

  test('a transfer with the provider moves the deal to payout_pending', async () => {
    const deal = await newDeal()
    await toClearing(deal)
    await h.db.query(
      `update deals set payout_due_at = now() - interval '1 hour' where id = $1`, [deal],
    )
    await h.db.query(`select * from mature_clearing_deals()`)

    await h.db.query(`select mark_payout_processing($1, 'FLW-TRANSFER-1')`,
                     [await payoutFor(deal)])
    expect(await statusOf(deal)).toBe('payout_pending')
  })

  test('a failed transfer returns the deal to released', async () => {
    const deal = await newDeal()
    await toClearing(deal)
    await h.db.query(
      `update deals set payout_due_at = now() - interval '1 hour' where id = $1`, [deal],
    )
    await h.db.query(`select * from mature_clearing_deals()`)

    const payout = await payoutFor(deal)
    await h.db.query(`select mark_payout_processing($1, 'FLW-TRANSFER-2')`, [payout])
    await h.db.query(`select fail_payout($1, 'Beneficiary rejected')`, [payout])

    // §5.1: a failed payout does not lose funds, and the deal must not go on
    // claiming a transfer is in flight.
    expect(await statusOf(deal)).toBe('released')
  })

  test('re-polling an already-processing payout does not walk the deal back', async () => {
    const deal = await newDeal()
    await toClearing(deal)
    await h.db.query(
      `update deals set payout_due_at = now() - interval '1 hour' where id = $1`, [deal],
    )
    await h.db.query(`select * from mature_clearing_deals()`)

    const payout = await payoutFor(deal)
    await h.db.query(`select mark_payout_processing($1, 'FLW-TRANSFER-3')`, [payout])
    await h.db.query(`select mark_payout_processing($1, 'FLW-TRANSFER-3')`, [payout])

    expect(await statusOf(deal)).toBe('payout_pending')
  })

  test('a disputed deal cannot have its payout booked — §8', async () => {
    const deal = await newDeal()
    await toClearing(deal)
    // The payout row already exists by the time the chargeback arrives. That is
    // new in V2: V1 could only dispute a held deal, so there was nothing to
    // stop.
    await h.db.query(`select open_dispute($1, 'buyer', 'Chargeback raised')`, [deal])

    const payout = await payoutFor(deal)
    await rejects(
      () => h.db.query(`select settle_payout($1, 90000, 'FLW-SETTLED-2')`, [payout]),
      /disputed — its payout is frozen/,
    )
    expect(await statusOf(deal)).toBe('disputed')
  })

  test('a settled transfer promotes a deal still clearing rather than refusing it', async () => {
    const deal = await newDeal()
    await toClearing(deal)

    // No maturing pass: this is the forced-retry case, where the transfer
    // settles while the deal still says it is inside its safety window.
    await h.db.query(`select settle_payout($1, 90000, 'FLW-SETTLED-1')`,
                     [await payoutFor(deal)])

    expect(await statusOf(deal)).toBe('paid_out')

    const { rows } = await h.db.query<{ action: string }>(
      `select action from audit_log where deal_id = $1 and action = 'deal.cleared'`,
      [deal],
    )
    // The promotion leaves a trace saying a payout caused it, not the clock.
    expect(rows).toHaveLength(1)
  })
})

describe('funding accepts the states a checkout produces', () => {
  test('there is exactly one fund_deal', async () => {
    // Not a paranoid test. An earlier draft of V2 added a second `fund_deal`
    // with a different argument list, intending to replace the first. Postgres
    // read it as an overload, the webhook went on calling the original, and
    // every test still passed — because the tests for the new behaviour were
    // calling the function nothing in production uses.
    //
    // The same trap is waiting for any money function that gains a parameter:
    // `create or replace` cannot change a signature, only add a sibling.
    const { rows } = await h.db.query<{ n: number }>(
      `select count(*)::int as n from pg_proc where proname = 'fund_deal'`,
    )
    expect(rows[0].n).toBe(1)
  })

  test('a deal mid-payment can still be funded', async () => {
    const deal = await newDeal()
    await h.db.query(`update deals set status = 'payment_pending' where id = $1`, [deal])
    await h.db.query(
      `select fund_deal($1, 'fake', 'FLW-PAY-1', 'mobile_money', 'MTN', 100000, 'RWF')`,
      [deal],
    )
    expect(await statusOf(deal)).toBe('funded_held')
  })

  test('a retry after a declined card can be funded', async () => {
    const deal = await newDeal()
    await h.db.query(`update deals set status = 'payment_pending' where id = $1`, [deal])
    await h.db.query(`update deals set status = 'payment_failed' where id = $1`, [deal])
    await h.db.query(
      `select fund_deal($1, 'fake', 'FLW-PAY-2', 'card', 'Visa', 100000, 'RWF')`,
      [deal],
    )
    expect(await statusOf(deal)).toBe('funded_held')
  })

  test('a cancelled deal cannot be funded', async () => {
    const deal = await newDeal()
    await h.db.query(`update deals set status = 'canceled' where id = $1`, [deal])
    await rejects(
      () => h.db.query(
        `select fund_deal($1, 'fake', 'FLW-PAY-3', 'card', 'Visa', 100000, 'RWF')`,
        [deal],
      ),
      /cannot be funded/,
    )
  })
})
