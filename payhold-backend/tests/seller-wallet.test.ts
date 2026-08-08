/**
 * Seller wallets and pull-based payouts — migration `20260808000002`.
 *
 * Three properties are worth pinning, and the first is the one that makes the
 * rest safe to believe.
 *
 * **The wallet reconciles.** Every seller's wallet summed is the tenant's own
 * balance, bucket for bucket, minus `fees_retained` — which is ours and never
 * theirs. That is not a nice-to-have: a wallet computed a second way is free to
 * disagree with `tenant_balances`, and the number a seller reads would be the
 * one nobody reconciles against a provider.
 *
 * **Wallet mode changes when, not whether.** A tenant on `payout_mode = wallet`
 * still clears on the same window and still lands money in `available`. What
 * stops is the cron sending it unasked. `due_payouts` is where that binds, and
 * the tests below assert the same payout is invisible to a pass before the
 * request and visible after it.
 *
 * **Asking is not deciding.** `request_withdrawal` stamps rows and re-arms a
 * clock. It does not screen, route, send or book — so a withdrawal cannot
 * become the second way to pay a seller nobody verified (§12), and a payout a
 * person or a rule stopped stays stopped (invariant 11).
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

interface Tenant {
  id: string
}

async function seedTenant(): Promise<string> {
  const { rows: [t] } = await h.db.query<Tenant>(
    `insert into tenants (name, slug) values ('Acme', 'acme-' || gen_random_uuid())
     returning id`,
  )
  return t.id
}

async function seedSeller(tenant: string, name = 'Host'): Promise<string> {
  const { rows: [s] } = await h.db.query<Tenant>(
    `insert into sellers (tenant_id, name, country, payout_currency, payout_provider,
                          beneficiary_token, masked_destination)
     values ($1, $2, 'RW', 'RWF', 'flutterwave_momo', 'tok_' || gen_random_uuid(),
             'MTN •••• 4821')
     returning id`,
    [tenant, name],
  )
  return s.id
}

/**
 * A deal funded and held. `fee` is in presentment terms and is what release
 * will strike off — 10% of 100,000 in every case below.
 */
async function seedFundedDeal(
  tenant: string,
  seller: string,
  amount = 100_000,
): Promise<string> {
  const { rows: [deal] } = await h.db.query<Tenant>(
    `insert into deals (tenant_id, buyer_ref, seller_id, description, amount, currency,
                        presentment_currency, presentment_amount, buyer_country,
                        provider, status, fee_amount, expected_complete_at)
     values ($1, 'buyer-1', $2, 'Excavator hire', $3, 'RWF', 'RWF', $3, 'RW',
             'flutterwave', 'created', $4, now() + interval '2 days')
     returning id`,
    [tenant, seller, amount, Math.round(amount * 0.1)],
  )

  await h.db.query(
    `select * from fund_deal($1, 'flutterwave', $2, 'mobile_money', 'MTN', $3, 'RWF', null, 3)`,
    [deal.id, `FLW-${crypto.randomUUID()}`, amount],
  )

  return deal.id
}

/** Both confirmations, which is what releases. Leaves the deal `clearing`. */
async function release(deal: string, amount = 100_000): Promise<void> {
  const fee = Math.round(amount * 0.1)
  for (const side of ['buyer', 'seller']) {
    await h.db.query(
      `select * from confirm_deal($1, $2::confirm_side, 'user', $3, 'RWF', $4)`,
      [deal, side, amount - fee, fee],
    )
  }
}

/**
 * Drag a deal's clearance window into the past and mature it, which is what a
 * dispatch pass does. After this the money is `available` rather than
 * `pending_clearance`.
 *
 * `payouts.scheduled_for` is moved with it. `release_deal` sets the two from
 * the same instant, so real elapsed time passes both at once — backdating only
 * the deal would leave a payout that is cleared in the wallet and not yet due
 * to the cron, a state fourteen days of clock can never produce.
 */
async function mature(deal: string): Promise<void> {
  await h.db.query(
    `update deals set payout_due_at = now() - interval '1 hour' where id = $1`,
    [deal],
  )
  await h.db.query(
    `update payouts set scheduled_for = now() - interval '1 hour' where deal_id = $1`,
    [deal],
  )
  await h.db.query(`select * from mature_clearing_deals()`)
}

interface Buckets {
  currency: string
  held: string
  pending_clearance: string
  available: string
  reserved: string
  paid_out: string
}

const wallet = async (seller: string): Promise<Buckets[]> => {
  const { rows } = await h.db.query<Buckets>(
    `select currency::text, held::text, pending_clearance::text, available::text,
            reserved::text, paid_out::text
       from seller_balance($1)`,
    [seller],
  )
  return rows
}

describe('the wallet is derived from the same ledger the tenant balance is', () => {
  test('money sits in held while the deal is held, and is gross', async () => {
    const tenant = await seedTenant()
    const seller = await seedSeller(tenant)
    await seedFundedDeal(tenant, seller)

    const [row] = await wallet(seller)

    // The full amount the buyer paid. Nothing is struck inside the hold, which
    // is why a client must label this "in progress" rather than "yours".
    expect(row.held).toBe('100000')
    expect(row.pending_clearance).toBe('0')
    expect(row.available).toBe('0')
  })

  test('release moves it to pending_clearance, net of the fee', async () => {
    const tenant = await seedTenant()
    const seller = await seedSeller(tenant)
    const deal = await seedFundedDeal(tenant, seller)
    await release(deal)

    const [row] = await wallet(seller)

    expect(row.held).toBe('0')
    // 100,000 less our 10,000 commission. The fee is the tenant's and does not
    // appear in the seller's wallet at all.
    expect(row.pending_clearance).toBe('90000')
    expect(row.available).toBe('0')
  })

  test('maturing the window moves it to available', async () => {
    const tenant = await seedTenant()
    const seller = await seedSeller(tenant)
    const deal = await seedFundedDeal(tenant, seller)
    await release(deal)
    await mature(deal)

    const [row] = await wallet(seller)

    expect(row.pending_clearance).toBe('0')
    expect(row.available).toBe('90000')
  })

  /**
   * The property the whole design rests on. If these ever disagree, one of the
   * two is wrong and there is no way to tell which from either number alone.
   */
  test('every seller wallet summed is the tenant balance, less what is ours', async () => {
    const tenant = await seedTenant()
    const one = await seedSeller(tenant, 'Alice')
    const two = await seedSeller(tenant, 'Bereket')

    const held = await seedFundedDeal(tenant, one, 40_000)
    const cleared = await seedFundedDeal(tenant, two, 100_000)
    const clearing = await seedFundedDeal(tenant, one, 60_000)

    await release(cleared, 100_000)
    await mature(cleared)
    await release(clearing, 60_000)

    const { rows: [tenantRow] } = await h.db.query<Buckets & { fees_retained: string }>(
      `select currency::text, held::text, pending_clearance::text, available::text,
              reserved::text, fees_retained::text, paid_out::text
         from tenant_balances($1)`,
      [tenant],
    )

    const { rows: [summed] } = await h.db.query<Buckets>(
      `select sum(held)::text as held,
              sum(pending_clearance)::text as pending_clearance,
              sum(available)::text as available,
              sum(reserved)::text as reserved,
              sum(paid_out)::text as paid_out
         from tenant_seller_wallets($1)`,
      [tenant],
    )

    expect(summed.held).toBe(tenantRow.held)
    expect(summed.pending_clearance).toBe(tenantRow.pending_clearance)
    expect(summed.available).toBe(tenantRow.available)
    expect(summed.reserved).toBe(tenantRow.reserved)
    expect(summed.paid_out).toBe(tenantRow.paid_out)

    // And the bucket the sellers' wallets never see is non-zero, so the
    // assertions above are not passing because everything happens to be equal.
    expect(Number(tenantRow.fees_retained)).toBeGreaterThan(0)
  })

  test('one seller cannot see another seller, and one tenant cannot see another', async () => {
    const tenant = await seedTenant()
    const other = await seedTenant()
    const mine = await seedSeller(tenant, 'Mine')
    const theirs = await seedSeller(other, 'Theirs')

    await seedFundedDeal(tenant, mine, 50_000)
    await seedFundedDeal(other, theirs, 900_000)

    const [row] = await wallet(mine)
    expect(row.held).toBe('50000')

    const { rows } = await h.db.query<{ seller_name: string }>(
      `select seller_name from tenant_seller_wallets($1)`, [tenant],
    )
    expect(rows.map((r) => r.seller_name)).toEqual(['Mine'])
  })
})

describe('what can actually be sent, and why it cannot', () => {
  test('a cleared payout is available; a clearing one is not', async () => {
    const tenant = await seedTenant()
    const seller = await seedSeller(tenant)
    const cleared = await seedFundedDeal(tenant, seller)
    const clearing = await seedFundedDeal(tenant, seller)

    await release(cleared)
    await mature(cleared)
    await release(clearing)

    const { rows: [w] } = await h.db.query<{
      available_amount: string
      available_count: number
      clearing_amount: string
      clearing_count: number
    }>(
      `select available_amount::text, available_count,
              clearing_amount::text, clearing_count
         from seller_withdrawable($1)`,
      [seller],
    )

    expect(w.available_amount).toBe('90000')
    expect(w.available_count).toBe(1)
    expect(w.clearing_amount).toBe('90000')
    expect(w.clearing_count).toBe(1)
  })

  test('a stopped payout is counted against its own reason', async () => {
    const tenant = await seedTenant()
    const seller = await seedSeller(tenant)
    const deal = await seedFundedDeal(tenant, seller)
    await release(deal)
    await mature(deal)

    const { rows: [p] } = await h.db.query<{ id: string }>(
      `select id from payouts where deal_id = $1`, [deal],
    )
    await h.db.query(
      `select * from hold_payout($1, 'ops@payhold', 'Checking the destination')`,
      [p.id],
    )

    const { rows: [w] } = await h.db.query<{
      held_count: number
      available_count: number
    }>(
      `select held_count, available_count from seller_withdrawable($1)`,
      [seller],
    )

    // Held, and therefore no longer available. A wallet showing it as both
    // would have a seller asking why a number they can see will not move.
    expect(w.held_count).toBe(1)
    expect(w.available_count).toBe(0)
  })
})

describe('requesting a withdrawal', () => {
  test('stamps the cleared payouts and re-arms their clock', async () => {
    const tenant = await seedTenant()
    const seller = await seedSeller(tenant)
    const deal = await seedFundedDeal(tenant, seller)
    await release(deal)
    await mature(deal)

    await h.db.query(`select * from request_withdrawal($1, 'seller-app')`, [seller])

    const { rows: [p] } = await h.db.query<{
      withdrawal_requested_at: Date | null
      next_attempt_at: Date | null
    }>(
      `select withdrawal_requested_at, next_attempt_at from payouts where deal_id = $1`,
      [deal],
    )

    expect(p.withdrawal_requested_at).not.toBeNull()
    expect(p.next_attempt_at).not.toBeNull()
  })

  test('refuses when nothing has cleared', async () => {
    const tenant = await seedTenant()
    const seller = await seedSeller(tenant)
    await seedFundedDeal(tenant, seller)

    await rejects(
      () => h.db.query(`select * from request_withdrawal($1, 'seller-app')`, [seller]),
      /nothing cleared to withdraw/,
    )
  })

  test('refuses without a name', async () => {
    const tenant = await seedTenant()
    const seller = await seedSeller(tenant)

    await rejects(
      () => h.db.query(`select * from request_withdrawal($1, '  ')`, [seller]),
      /needs a name/,
    )
  })

  /**
   * The attempt counter is what `route_payout` reads to decide whether the
   * verified backup destination may be used. Zeroing it on a request would send
   * the next attempt back to the primary that has been failing — the same trap
   * `reset_payout_retry` documents.
   */
  test('does not reset the attempt counter', async () => {
    const tenant = await seedTenant()
    const seller = await seedSeller(tenant)
    const deal = await seedFundedDeal(tenant, seller)
    await release(deal)
    await mature(deal)

    const { rows: [p] } = await h.db.query<{ id: string }>(
      `select id from payouts where deal_id = $1`, [deal],
    )
    await h.db.query(
      `update payouts set attempts = 3, status = 'failed' where id = $1`, [p.id],
    )

    await h.db.query(`select * from request_withdrawal($1, 'seller-app')`, [seller])

    const { rows: [after] } = await h.db.query<{ attempts: number }>(
      `select attempts from payouts where id = $1`, [p.id],
    )
    expect(after.attempts).toBe(3)
  })

  /** Invariant 11: only a named person moves a payout somebody stopped. */
  test('does not wake a payout held for review', async () => {
    const tenant = await seedTenant()
    const seller = await seedSeller(tenant)
    const held = await seedFundedDeal(tenant, seller)
    const free = await seedFundedDeal(tenant, seller)

    for (const d of [held, free]) {
      await release(d)
      await mature(d)
    }

    const { rows: [p] } = await h.db.query<{ id: string }>(
      `select id from payouts where deal_id = $1`, [held],
    )
    await h.db.query(
      `select * from hold_payout($1, 'ops@payhold', 'Checking the destination')`,
      [p.id],
    )

    await h.db.query(`select * from request_withdrawal($1, 'seller-app')`, [seller])

    const { rows: [after] } = await h.db.query<{
      status: string
      withdrawal_requested_at: Date | null
    }>(
      `select status::text, withdrawal_requested_at from payouts where id = $1`,
      [p.id],
    )

    expect(after.status).toBe('held_for_review')
    expect(after.withdrawal_requested_at).toBeNull()
  })

  describe('choosing a destination', () => {
    const addDestination = async (
      tenant: string,
      seller: string,
      opts: { verified: boolean; hold?: string },
    ): Promise<string> => {
      const { rows: [d] } = await h.db.query<Tenant>(
        `insert into seller_destinations
           (tenant_id, seller_id, country, payout_currency, payout_provider,
            beneficiary_token, masked_destination, is_backup, verified_at,
            security_hold_until)
         values ($1, $2, 'RW', 'RWF', 'flutterwave_momo',
                 'tok_' || gen_random_uuid(), 'Airtel •••• 9910', true,
                 case when $3 then now() else null end, $4::timestamptz)
         returning id`,
        [tenant, seller, opts.verified, opts.hold ?? null],
      )
      return d.id
    }

    test('refuses a destination belonging to someone else', async () => {
      const tenant = await seedTenant()
      const seller = await seedSeller(tenant)
      const stranger = await seedSeller(tenant, 'Stranger')
      const theirs = await addDestination(tenant, stranger, { verified: true })

      await rejects(
        () => h.db.query(
          `select * from request_withdrawal($1, 'seller-app', $2)`, [seller, theirs],
        ),
        /does not belong to seller/,
      )
    })

    test('refuses an unverified destination', async () => {
      const tenant = await seedTenant()
      const seller = await seedSeller(tenant)
      const dest = await addDestination(tenant, seller, { verified: false })

      await rejects(
        () => h.db.query(
          `select * from request_withdrawal($1, 'seller-app', $2)`, [seller, dest],
        ),
        /has not been verified/,
      )
    })

    /** §5.1's change protection, and the account-takeover shape it catches. */
    test('refuses a destination still inside its security hold', async () => {
      const tenant = await seedTenant()
      const seller = await seedSeller(tenant)
      const dest = await addDestination(tenant, seller, {
        verified: true,
        hold: new Date(Date.now() + 3_600_000).toISOString(),
      })

      await rejects(
        () => h.db.query(
          `select * from request_withdrawal($1, 'seller-app', $2)`, [seller, dest],
        ),
        /security hold/,
      )
    })

    test('records the chosen destination on the payout', async () => {
      const tenant = await seedTenant()
      const seller = await seedSeller(tenant)
      const dest = await addDestination(tenant, seller, { verified: true })
      const deal = await seedFundedDeal(tenant, seller)
      await release(deal)
      await mature(deal)

      await h.db.query(
        `select * from request_withdrawal($1, 'seller-app', $2)`, [seller, dest],
      )

      const { rows: [p] } = await h.db.query<{ requested_destination_id: string }>(
        `select requested_destination_id from payouts where deal_id = $1`, [deal],
      )
      expect(p.requested_destination_id).toBe(dest)
    })
  })
})

describe('wallet mode is where the cron stops', () => {
  const DISPATCHABLE =
    `array['scheduled','frozen','processing','blocked','needs_verification','failed']::payout_status[]`

  const dueCount = async (tenant: string): Promise<number> => {
    const { rows } = await h.db.query<{ id: string }>(
      `select d.id from due_payouts(${DISPATCHABLE}, 100) d
        where d.tenant_id = $1`,
      [tenant],
    )
    return rows.length
  }

  test('a tenant on the default is unchanged — cleared money is due', async () => {
    const tenant = await seedTenant()
    const seller = await seedSeller(tenant)
    const deal = await seedFundedDeal(tenant, seller)
    await release(deal)
    await mature(deal)

    expect(await dueCount(tenant)).toBe(1)
  })

  test('in wallet mode cleared money is not due until it is asked for', async () => {
    const tenant = await seedTenant()
    await h.db.query(
      `insert into settings (tenant_id, key, value) values ($1, 'payout_mode', '"wallet"')`,
      [tenant],
    )
    const seller = await seedSeller(tenant)
    const deal = await seedFundedDeal(tenant, seller)
    await release(deal)
    await mature(deal)

    // Cleared, and sitting in the wallet.
    const [row] = await wallet(seller)
    expect(row.available).toBe('90000')

    // …and invisible to a pass.
    expect(await dueCount(tenant)).toBe(0)

    await h.db.query(`select * from request_withdrawal($1, 'seller-app')`, [seller])

    expect(await dueCount(tenant)).toBe(1)
  })

  /**
   * The reason `due_payouts` exists at all. Filtering wallet-mode rows out
   * after the limit would let one tenant's unasked-for backlog fill the pass
   * and starve everyone else, silently and for as long as the backlog stood.
   */
  test('an unasked-for backlog does not consume the batch', async () => {
    const walletTenant = await seedTenant()
    await h.db.query(
      `insert into settings (tenant_id, key, value) values ($1, 'payout_mode', '"wallet"')`,
      [walletTenant],
    )
    const hoarder = await seedSeller(walletTenant, 'Hoarder')
    for (let i = 0; i < 3; i += 1) {
      const deal = await seedFundedDeal(walletTenant, hoarder)
      await release(deal)
      await mature(deal)
    }

    const autoTenant = await seedTenant()
    const waiting = await seedSeller(autoTenant, 'Waiting')
    const deal = await seedFundedDeal(autoTenant, waiting)
    await release(deal)
    await mature(deal)

    // `due_payouts` takes the oldest rows in the whole table, and every other
    // test in this file has left due payouts behind. Backdating these four past
    // all of them is what makes the batch below deterministic — the hoarder's
    // three are the oldest of all, so an unfiltered query would return exactly
    // them and nothing else.
    await h.db.query(
      `update payouts set scheduled_for = now() - interval '100 days'
        where tenant_id = $1`,
      [walletTenant],
    )
    await h.db.query(
      `update payouts set scheduled_for = now() - interval '99 days'
        where tenant_id = $1`,
      [autoTenant],
    )

    const { rows } = await h.db.query<{ tenant_id: string }>(
      `select tenant_id from due_payouts(${DISPATCHABLE}, 3)`,
    )

    // A batch of three. Without the filter the hoarder's backlog is all three
    // and the auto tenant waits — which is the starvation this is about.
    expect(rows.some((r) => r.tenant_id === walletTenant)).toBe(false)
    expect(rows.some((r) => r.tenant_id === autoTenant)).toBe(true)
  })

  test('a null clock is still excluded, wallet mode or not', async () => {
    const tenant = await seedTenant()
    const seller = await seedSeller(tenant)
    const deal = await seedFundedDeal(tenant, seller)
    await release(deal)
    await mature(deal)

    await h.db.query(
      `update payouts set next_attempt_at = null where deal_id = $1`, [deal],
    )

    expect(await dueCount(tenant)).toBe(0)
  })
})

describe('invariant 1 and invariant 9 still bind', () => {
  test('the AI role cannot request a withdrawal', async () => {
    const { rows } = await h.db.query<{ has: boolean }>(
      `select has_function_privilege('payhold_ai',
                'request_withdrawal(uuid, text, uuid)', 'execute') as has`,
    )
    expect(rows[0].has).toBe(false)
  })

  /**
   * `route_payout` is recreated by this migration, and a recreated function is
   * granted to PUBLIC by default. The revoke has to be reissued, which is the
   * same trap `refund_deal` and `resolve_dispute` walked into in V2.
   */
  test('the AI role cannot route a payout after the recreate', async () => {
    const { rows } = await h.db.query<{ has: boolean }>(
      `select has_function_privilege('payhold_ai',
                'route_payout(uuid)', 'execute') as has`,
    )
    expect(rows[0].has).toBe(false)
  })

  test('a dashboard session cannot request a withdrawal', async () => {
    for (const role of ['anon', 'authenticated']) {
      const { rows } = await h.db.query<{ has: boolean }>(
        `select has_function_privilege($1,
                  'request_withdrawal(uuid, text, uuid)', 'execute') as has`,
        [role],
      )
      expect(rows[0].has).toBe(false)
    }
  })

  /** The wallet is a read, and a tenant's own people may run it. */
  test('a dashboard session may read a wallet', async () => {
    const { rows } = await h.db.query<{ has: boolean }>(
      `select has_function_privilege('authenticated',
                'seller_balance(uuid)', 'execute') as has`,
    )
    expect(rows[0].has).toBe(true)
  })

  /**
   * `create or replace` cannot change a signature — it adds a sibling, and the
   * caller goes on using the old one while the tests exercise the new. The same
   * guard `fund_deal` and `record_reconciliation` carry.
   */
  test('route_payout was replaced, not duplicated', async () => {
    const { rows } = await h.db.query<{ count: string }>(
      `select count(*)::text from pg_proc where proname = 'route_payout'`,
    )
    expect(rows[0].count).toBe('1')
  })
})
