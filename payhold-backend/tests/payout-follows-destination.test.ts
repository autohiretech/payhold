/**
 * A payout follows a seller who changes country or payout method —
 * `redenominate_payout`.
 *
 * The case is a real one, found on the owner's own account: a host released a
 * trip while they were in Rwanda being paid RWF, then moved to a US PayPal
 * account. `route_evaluation` answered `currency_not_supported` for every rail,
 * correctly — both rails that reach the United States send USD and neither
 * sends RWF — so their own money, sitting behind a verified destination that
 * was out of its security hold, could not be carried by anything.
 *
 * What is tested here is the money-side half: the lock, the guards, and the
 * fact that restating what a seller is owed in a different currency moves no
 * money and books nothing. The conversion itself is TypeScript's, for the
 * reason every other figure is — there is one FX table in this system and it
 * is not in the database.
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


/** 90,000 RWF restated as 60.00 USD — the shape, not a real quote. */
const USD = 6_000
const RATE = 0.000667

const follow = (payout: string, amount = USD, ccy = 'USD', rate = RATE, src = 'flutterwave') =>
  h.db.query(`select redenominate_payout($1, $2, $3, $4, $5)`, [payout, amount, ccy, rate, src])

const payoutRow = async (id: string) => {
  const { rows: [p] } = await h.db.query<{
    amount: number
    currency: string
    status: string
  }>(`select amount, currency, status from payouts where id = $1`, [id])
  return p
}

beforeAll(async () => { h = await migrated() })
afterAll(async () => { await h.close() })

describe('a payout following its destination', () => {
  test('is restated into the currency the seller is now paid in', async () => {
    const s = await seed()
    expect(await payoutRow(s.payout)).toMatchObject({ amount: 90_000, currency: 'RWF' })

    await follow(s.payout)

    expect(await payoutRow(s.payout)).toMatchObject({ amount: USD, currency: 'USD' })
  })

  test('moves no money and books nothing', async () => {
    // Nothing has left anywhere. `amountLeaving` reads the deal's clearing pool
    // in the presentment currency and is untouched by this; the restated figure
    // is what `settle_payout` will later book as the cross-rail half.
    const s = await seed()
    const before = await h.db.query<{ n: string }>(
      `select count(*) as n from ledger where deal_id = $1`, [s.deal],
    )
    await follow(s.payout)
    const after = await h.db.query<{ n: string }>(
      `select count(*) as n from ledger where deal_id = $1`, [s.deal],
    )

    expect(after.rows[0].n).toBe(before.rows[0].n)
  })

  test('records what it converted, at what rate, from where', async () => {
    // A payout restated against a number nobody quoted is what `rates.ts`
    // exists to refuse, so which kind of rate it was has to be checkable after
    // the fact rather than inferred.
    const s = await seed()
    await follow(s.payout)

    const { rows } = await h.db.query<{ details: Record<string, unknown> }>(
      `select details from audit_log
        where deal_id = $1 and action = 'payout.redenominated'`,
      [s.deal],
    )

    expect(rows).toHaveLength(1)
    expect(rows[0].details).toMatchObject({
      from_amount: 90_000,
      from_currency: 'RWF',
      to_amount: USD,
      to_currency: 'USD',
      rate_source: 'flutterwave',
    })
  })

  test('asking twice is a no-op, not an error', async () => {
    // `dispatchPayout` asks on every pass without knowing the answer first, so
    // the already-correct case cannot be a refusal. Same shape as a hold that
    // has already lapsed.
    const s = await seed()
    await follow(s.payout)
    await follow(s.payout)

    expect(await payoutRow(s.payout)).toMatchObject({ amount: USD, currency: 'USD' })
    const { rows } = await h.db.query(
      `select 1 from audit_log where deal_id = $1 and action = 'payout.redenominated'`,
      [s.deal],
    )
    expect(rows).toHaveLength(1)
  })

  describe('what it refuses', () => {
    test('a transfer already with the rail', async () => {
      // Rewriting the amount of money that has gone. `hold_payout` and
      // `hold_payout_unfunded` refuse the same two statuses for the same reason.
      const s = await seed()
      await h.db.query(`update payouts set status = 'processing' where id = $1`, [s.payout])

      await rejects(() => follow(s.payout), /invalid_state.*cannot be restated/)
    })

    test('a payout already paid', async () => {
      const s = await seed()
      await h.db.query(
        `update payouts set status = 'paid', paid_at = now(), provider_ref = 'FLW-1'
          where id = $1`,
        [s.payout],
      )

      await rejects(() => follow(s.payout), /invalid_state.*cannot be restated/)
    })

    test('an amount of nothing', async () => {
      const s = await seed()
      await rejects(() => follow(s.payout, 0), /invalid_request.*positive amount/)
    })

    test('a rate of nothing', async () => {
      const s = await seed()
      await rejects(() => follow(s.payout, USD, 'USD', 0), /invalid_request.*rate it was converted at/)
    })

    test('a rate from nowhere', async () => {
      const s = await seed()
      await rejects(() => follow(s.payout, USD, 'USD', RATE, '  '), /invalid_request.*source of its rate/)
    })

    test('a payout that does not exist', async () => {
      await rejects(
        () => follow('00000000-0000-0000-0000-000000000000'),
        /not_found: payout .* does not exist/,
      )
    })
  })

  test('the AI role cannot reach it', async () => {
    const { rows } = await h.db.query<{ ok: boolean }>(
      `select has_function_privilege('payhold_ai',
         'redenominate_payout(uuid, bigint, text, numeric, text)', 'execute') as ok`,
    )
    expect(rows[0].ok).toBe(false)
  })

  test('there is exactly one of it', async () => {
    const { rows } = await h.db.query<{ n: number }>(
      `select count(*)::int as n from pg_proc where proname = 'redenominate_payout'`,
    )
    expect(rows[0].n).toBe(1)
  })
})
