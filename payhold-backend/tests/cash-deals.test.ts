/**
 * Cash on pickup — deals PayHold records but never funds.
 *
 * The buyer hands the seller money in person. PayHold holds no funds, opens no
 * checkout, schedules no payout and charges no fee; what it keeps is the record
 * of what was agreed and, later, what was actually collected. These tests pin
 * the parts that would be invisible until the money went wrong.
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { migrated, rejects, type Harness } from './harness'

let h: Harness
let tenant: string
let seller: string

beforeAll(async () => {
  h = await migrated()

  const { rows: [t] } = await h.db.query<{ id: string }>(
    `insert into tenants (name, slug) values ('Cash Co', 'cash-co') returning id`,
  )
  tenant = t.id

  const { rows: [s] } = await h.db.query<{ id: string }>(
    `insert into sellers (tenant_id, name, country, payout_currency,
                          payout_provider, beneficiary_token, masked_destination)
     values ($1, 'Host', 'RW', 'RWF', 'flutterwave_momo', 'tok_cash', '•••4321')
     returning id`,
    [tenant],
  )
  seller = s.id
})

afterAll(() => h.close())

async function openCash(amount = 180_000): Promise<Record<string, unknown>> {
  const { rows: [d] } = await h.db.query<Record<string, unknown>>(
    `select * from open_cash_deal($1, $2, 'buyer-1', 'Toyota — cash on pickup',
                                  $3, 'RWF', 'api_key:test')`,
    [tenant, seller, amount],
  )
  return d
}

describe('opening one', () => {
  test('is recorded as offline, in cash, holding nothing', async () => {
    const d = await openCash()

    // The three lies this feature exists to avoid: a rail that did not carry
    // it, a method it was not paid by, and a status claiming money moved.
    expect(d.provider).toBe('offline')
    expect(d.payment_method).toBe('cash')
    expect(d.status).toBe('created')
    expect(Number(d.amount)).toBe(180_000)
    expect(Number(d.fee_amount)).toBe(0)
  })

  test('presentment equals settlement — there is nothing to convert', async () => {
    const d = await openCash()
    // Nobody is charging a card in another currency. A locked FX rate here
    // would be a number with no event behind it.
    expect(d.presentment_currency).toBe(d.currency)
    expect(Number(d.presentment_amount)).toBe(Number(d.amount))
    expect(d.fx_rate).toBeNull()
  })

  test('takes the country from the seller when nobody says', async () => {
    // Both people are standing in the same place; that is what a handover is.
    const d = await openCash()
    expect(d.buyer_country).toBe('RW')
  })

  test('refuses a seller belonging to someone else', async () => {
    const { rows: [other] } = await h.db.query<{ id: string }>(
      `insert into tenants (name, slug) values ('Other Co', 'other-co') returning id`,
    )
    await rejects(
      () =>
        h.db.query(
          `select * from open_cash_deal($1, $2, 'b', 'd', 1000, 'RWF', 'api_key:test')`,
          [other.id, seller],
        ),
      /not_found/,
    )
  })

  test('will not open one for nothing', async () => {
    await rejects(() => openCash(0), /policy_violation/)
  })

  test('records who opened it', async () => {
    const d = await openCash()
    const { rows } = await h.db.query<{ action: string }>(
      `select action from audit_log where deal_id = $1`,
      [d.id],
    )
    expect(rows.map((r) => r.action)).toContain('deal.opened_offline')
  })
})

describe('closing one', () => {
  test('keeps what was agreed alongside what was collected', async () => {
    const d = await openCash(180_000)
    const { rows: [settled] } = await h.db.query<Record<string, unknown>>(
      `select * from settle_cash_deal($1, $2, 200000, 'api_key:test')`,
      [d.id, tenant],
    )

    // The late return that cost more is exactly the trip someone will want to
    // look at later. Overwriting `amount` would delete the half that makes it
    // legible.
    expect(Number(settled.amount)).toBe(180_000)
    expect(Number(settled.collected_amount)).toBe(200_000)
    expect(settled.status).toBe('settled_offline')
    expect(settled.collected_at).not.toBeNull()
  })

  test('zero collected is a fact, not an error', async () => {
    const d = await openCash()
    const { rows: [settled] } = await h.db.query<Record<string, unknown>>(
      `select * from settle_cash_deal($1, $2, 0, 'api_key:test')`,
      [d.id, tenant],
    )
    expect(Number(settled.collected_amount)).toBe(0)
    expect(settled.status).toBe('settled_offline')
  })

  test('settling twice is one collection', async () => {
    const d = await openCash()
    await h.db.query(`select settle_cash_deal($1, $2, 150000, 'api_key:test')`, [d.id, tenant])
    const { rows: [again] } = await h.db.query<Record<string, unknown>>(
      `select * from settle_cash_deal($1, $2, 999999, 'api_key:test')`,
      [d.id, tenant],
    )
    // A handoff screen tapped twice must not become two collections, and the
    // second number must not overwrite the first.
    expect(Number(again.collected_amount)).toBe(150_000)
  })

  test('refuses a deal that is on a rail', async () => {
    const { rows: [d] } = await h.db.query<{ id: string }>(
      `insert into deals (tenant_id, buyer_ref, seller_id, description, amount, currency,
                          presentment_currency, presentment_amount, buyer_country, provider, status)
       values ($1, 'b', $2, 'card deal', 50000, 'RWF', 'RWF', 50000, 'RW', 'stripe', 'created')
       returning id`,
      [tenant, seller],
    )
    // Closing a rail deal by hand would leave a funded hold with nothing left
    // to release it.
    await rejects(
      () => h.db.query(`select settle_cash_deal($1, $2, 50000, 'api_key:test')`, [d.id, tenant]),
      /invalid_state.*rail/,
    )
  })

  test('refuses another tenant asking', async () => {
    const d = await openCash()
    const { rows: [other] } = await h.db.query<{ id: string }>(
      `insert into tenants (name, slug) values ('Nosy Co', 'nosy-co') returning id`,
    )
    await rejects(
      () => h.db.query(`select settle_cash_deal($1, $2, 1000, 'api_key:test')`, [d.id, other.id]),
      /not_found/,
    )
  })

  test('settled_offline is terminal — nothing follows it', async () => {
    const d = await openCash()
    await h.db.query(`select settle_cash_deal($1, $2, 1000, 'api_key:test')`, [d.id, tenant])
    // Not `paid_out`, which would schedule PayHold sending money a seller has
    // already been handed.
    await rejects(
      () => h.db.query(`update deals set status = 'paid_out' where id = $1`, [d.id]),
      /transition|invalid/i,
    )
  })

  test('records what it settled at, next to what was agreed', async () => {
    const d = await openCash(180_000)
    await h.db.query(`select settle_cash_deal($1, $2, 200000, 'api_key:test')`, [d.id, tenant])
    const { rows } = await h.db.query<{ action: string; details: Record<string, unknown> }>(
      `select action, details from audit_log where deal_id = $1 and action = 'deal.settled_offline'`,
      [d.id],
    )
    expect(rows).toHaveLength(1)
    expect(Number(rows[0].details.collected_amount)).toBe(200_000)
    expect(Number(rows[0].details.agreed_amount)).toBe(180_000)
  })
})
