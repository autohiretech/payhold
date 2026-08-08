/**
 * A person stopping one payout — `hold_payout`.
 *
 * The lever this adds is narrow on purpose, and the tests are about the edges
 * of it rather than the happy path. Before it existed, an operator who noticed
 * something the rules do not model had one option: freeze the whole tenant,
 * stopping every honest seller to stop one.
 *
 * Its counterpart in the dashboard's mock is `risk.test.ts`, which is the
 * acceptance spec for the same behaviour on the other side of the seam.
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
             'fake', 'ref-' || gen_random_uuid(), 'funded_held', 10000)
     returning id`,
    [tenant.id, seller.id],
  )

  await h.db.query(
    `insert into ledger (tenant_id, deal_id, entry_type, amount, currency, provider)
     values ($1, $2, 'hold', 100000, 'RWF', 'fake')`,
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

const statusOf = async (payout: string): Promise<string> => {
  const { rows: [p] } = await h.db.query<{ status: string }>(
    `select status from payouts where id = $1`, [payout],
  )
  return p.status
}

const hold = (payout: string, by = 'grace@autohire.rw', why = 'Seller unreachable by phone') =>
  h.db.query(`select hold_payout($1, $2, $3)`, [payout, by, why])

beforeAll(async () => { h = await migrated() })
afterAll(async () => { await h.close() })

describe('holding one payout', () => {
  test('stops it, and says who and why', async () => {
    const s = await seed()
    await hold(s.payout)

    const { rows: [p] } = await h.db.query<{
      status: string; review_held_by: string; review_hold_reason: string
      review_held_at: string | null
    }>(
      `select status, review_held_by, review_hold_reason, review_held_at
       from payouts where id = $1`, [s.payout],
    )

    expect(p.status).toBe('held_for_review')
    expect(p.review_held_by).toBe('grace@autohire.rw')
    expect(p.review_hold_reason).toBe('Seller unreachable by phone')
    expect(p.review_held_at).not.toBeNull()
  })

  test('moves no money', async () => {
    const s = await seed()
    const before = await h.db.query(`select id from ledger where deal_id = $1`, [s.deal])
    await hold(s.payout)
    const after = await h.db.query(`select id from ledger where deal_id = $1`, [s.deal])

    // The same guarantee a rule hold carries: the worst a wrong stop costs is a
    // seller waiting for a person, never a cent in the wrong place.
    expect(after.rows).toHaveLength(before.rows.length)
    expect(await h.db.query(
      `select id from payouts where id = $1 and paid_at is not null`, [s.payout],
    ).then((r) => r.rows)).toHaveLength(0)
  })

  test('is attributable — a hold with no name or no reason is refused', async () => {
    const s = await seed()

    await rejects(() => hold(s.payout, '   ', 'because'), /policy_violation.*name the person/)
    await rejects(() => hold(s.payout, 'grace@autohire.rw', ''), /policy_violation.*say why/)

    // Refused means refused: the payout is untouched, not half-held.
    expect(await statusOf(s.payout)).toBe('scheduled')
  })

  test('cannot stop money that has already gone', async () => {
    const s = await seed()
    // With the rail's reference, because §17's
    // `paid_needs_a_provider_reference` refuses a payout marked paid without
    // one — a paid payout with no transfer behind it is not a state this test
    // could be describing.
    await h.db.query(
      `update payouts set status = 'paid', paid_at = now(), provider_ref = 'FLW-SENT'
        where id = $1`,
      [s.payout],
    )

    await rejects(() => hold(s.payout), /invalid_state.*already been sent/)
  })

  test('cannot stop a transfer already with the provider', async () => {
    const s = await seed()
    await h.db.query(`update payouts set status = 'processing' where id = $1`, [s.payout])

    // Recalling an in-flight transfer is a conversation with Flutterwave, not a
    // row in this table, and a hold that pretended otherwise would be a lie an
    // operator acts on.
    await rejects(() => hold(s.payout), /invalid_state.*already with the provider/)
  })

  test('refuses to hold what is already held', async () => {
    const s = await seed()
    await hold(s.payout)

    await rejects(() => hold(s.payout, 'sam@autohire.rw', 'same again'),
                  /invalid_state.*already held/)
  })

  test('a person clears it through the same door a rule hold uses', async () => {
    const s = await seed()
    await hold(s.payout)
    await h.db.query(`select approve_payout_review($1, 'owner@autohire.rw')`, [s.payout])

    const { rows: [p] } = await h.db.query<{
      status: string; review_approved_by: string; review_held_by: string
    }>(
      `select status, review_approved_by, review_held_by from payouts where id = $1`,
      [s.payout],
    )

    expect(p.status).toBe('scheduled')
    expect(p.review_approved_by).toBe('owner@autohire.rw')
    // Who stopped it survives the clearing. Both halves are the record.
    expect(p.review_held_by).toBe('grace@autohire.rw')
  })

  test('a second hold supersedes an earlier approval rather than sitting under it', async () => {
    const s = await seed()
    await hold(s.payout)
    await h.db.query(`select approve_payout_review($1, 'owner@autohire.rw')`, [s.payout])
    await hold(s.payout, 'sam@autohire.rw', 'New information from the buyer')

    const { rows: [p] } = await h.db.query<{
      review_approved_by: string | null; review_held_by: string
    }>(
      `select review_approved_by, review_held_by from payouts where id = $1`, [s.payout],
    )

    // Leaving the old approval would show a name beside a payout that person
    // has not approved — and would make `screen_payout` skip this payout for
    // the rest of its life.
    expect(p.review_approved_by).toBeNull()
    expect(p.review_held_by).toBe('sam@autohire.rw')
  })

  test('records the decision against the person, with their reason', async () => {
    const s = await seed()
    await hold(s.payout)

    const { rows } = await h.db.query<{ actor: string; details: Record<string, unknown> }>(
      `select actor, details from audit_log
       where deal_id = $1 and action = 'payout.held_by_person'`, [s.deal],
    )

    expect(rows).toHaveLength(1)
    expect(rows[0].actor).toBe('grace@autohire.rw')
    expect(rows[0].details.reason).toBe('Seller unreachable by phone')
    expect(rows[0].details.previous_status).toBe('scheduled')
  })

  test('tells the client, on the same event a rule hold sends', async () => {
    const s = await seed()
    await h.db.query(
      `insert into webhook_endpoints (tenant_id, url, secret_encrypted, masked_secret)
       values ($1, 'https://client.example/hook', 'x', 'whsec_••••1234')`, [s.tenant],
    )
    await hold(s.payout)

    const { rows } = await h.db.query<{ event: string }>(
      `select event from webhook_deliveries where deal_id = $1`, [s.deal],
    )

    // A client cannot act on a distinction between "a rule stopped it" and "a
    // person stopped it" — either way their seller is not being paid today.
    expect(rows.map((r) => r.event)).toContain('payout.held_for_review')
  })
})
