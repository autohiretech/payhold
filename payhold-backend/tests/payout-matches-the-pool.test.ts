/**
 * A payout may not promise more than the pool it is paid from — migration
 * `20260913000003`.
 *
 * Two functions computed "what the seller gets" and disagreed. `rail_balances`
 * and `release_deal`'s own `v_pool` take the platform fee, the rail's fee, tax
 * and any reserve off what was held. `releaseFigures` took only the platform
 * fee, off the settlement amount, and that is the figure that went into
 * `payouts.amount`.
 *
 * On a live Kigali deal charged RWF 471,800 the two came out RWF 405,347 and
 * RWF 424,620. The seller's wallet showed one and their payout was created for
 * the other; had it settled, `settle_payout` would have booked the pool
 * leaving the vault while the rail sent the larger figure, and the difference
 * would have come out of the platform's own provider balance on every payout —
 * visible nowhere except as reconciliation drift, which freezes payouts.
 */

import { beforeAll, afterAll, describe, expect, test } from 'vitest'
import { migrated, type Harness } from './harness'

let h: Harness

beforeAll(async () => {
  h = await migrated()
}, 120_000)

afterAll(async () => {
  await h?.close()
})

const newTenant = async (): Promise<string> => {
  const { rows: [t] } = await h.db.query<{ id: string }>(
    `insert into tenants (name, slug) values ('Acme', 'acme-' || gen_random_uuid())
     returning id`,
  )
  return t.id
}

const newSeller = async (tenant: string): Promise<string> => {
  const { rows: [s] } = await h.db.query<{ id: string }>(
    `insert into sellers (tenant_id, name, country, payout_currency, payout_provider,
                          beneficiary_token, masked_destination)
     values ($1, 'Host', 'RW', 'RWF', 'flutterwave_momo',
             'tok_' || gen_random_uuid(), 'MTN •••• 4821')
     returning id`,
    [tenant],
  )
  return s.id
}

/**
 * The real shape of the deal that exposed this, scaled to itself: RWF 471,800
 * charged, a 10% platform fee, and RWF 19,273 taken by the rail at funding.
 */
async function fundedDeal(
  tenant: string,
  seller: string,
  { charged = 471_800, fee = 47_180, providerFee = 19_273 } = {},
): Promise<string> {
  const { rows: [deal] } = await h.db.query<{ id: string }>(
    `insert into deals (tenant_id, buyer_ref, seller_id, description, amount, currency,
                        presentment_currency, presentment_amount, buyer_country,
                        provider, status, fee_amount, expected_complete_at)
     values ($1, 'buyer-1', $2, 'Car hire', $3, 'RWF', 'RWF', $3, 'RW',
             'flutterwave', 'created', $4, now() + interval '2 days')
     returning id`,
    [tenant, seller, charged, fee],
  )

  await h.db.query(
    `select * from fund_deal($1, 'flutterwave', $2, 'mobile_money', 'MTN', $3,
                             'RWF', null, 3, $4)`,
    [deal.id, `FLW-${crypto.randomUUID()}`, charged, providerFee],
  )

  return deal.id
}

/**
 * Both confirmations, releasing the deal — with the payout figure the OLD
 * TypeScript computed, `amount - fee_amount`, deliberately. The clamp is what
 * this file is about: a caller handing over a figure that is too big must not
 * be able to create a payout the pool cannot cover.
 */
async function releaseWith(deal: string, payoutAmount: number, fee: number) {
  for (const side of ['buyer', 'seller']) {
    await h.db.query(
      `select * from confirm_deal($1, $2::confirm_side, 'user', $3, 'RWF', $4)`,
      [deal, side, payoutAmount, fee],
    )
  }
}

const wallet = async (seller: string) => {
  const { rows: [w] } = await h.db.query<{ available: string; pending_clearance: string }>(
    `select available, pending_clearance from seller_wallet_rows(null, $1)`,
    [seller],
  )
  return w
}

const payout = async (deal: string) => {
  const { rows: [p] } = await h.db.query<{ amount: string; currency: string }>(
    `select amount, currency from payouts where deal_id = $1`,
    [deal],
  )
  return p
}

describe('a payout and the wallet describe the same money', () => {
  test('the rail’s fee cannot be paid to the seller as well as to the rail', async () => {
    const tenant = await newTenant()
    const seller = await newSeller(tenant)
    const deal = await fundedDeal(tenant, seller)

    // What the old caller passed: 471,800 - 47,180, with the rail's 19,273
    // still in it.
    await releaseWith(deal, 424_620, 47_180)

    const p = await payout(deal)
    const w = await wallet(seller)
    const pool = Number(w.available) + Number(w.pending_clearance)

    expect(Number(p.amount)).toBe(405_347)
    expect(Number(p.amount)).toBe(pool)
  })

  test('a correct caller is passed through untouched', async () => {
    // The clamp is a floor under a wrong figure, not an arithmetic of its own:
    // a caller that already agrees with the pool must see its own number.
    const tenant = await newTenant()
    const seller = await newSeller(tenant)
    const deal = await fundedDeal(tenant, seller)

    await releaseWith(deal, 405_347, 47_180)

    expect(Number((await payout(deal)).amount)).toBe(405_347)
  })

  test('a deal the rail charged nothing for is unchanged', async () => {
    const tenant = await newTenant()
    const seller = await newSeller(tenant)
    const deal = await fundedDeal(tenant, seller, { providerFee: 0 })

    await releaseWith(deal, 424_620, 47_180)

    const p = await payout(deal)
    const w = await wallet(seller)
    expect(Number(p.amount)).toBe(424_620)
    expect(Number(p.amount)).toBe(Number(w.available) + Number(w.pending_clearance))
  })

  test('a reserve is carved out of the payout, not just out of the wallet', async () => {
    // §6.1's new-seller carve-out is decided inside release_deal from settings
    // the caller does not read, so it is the one deduction TypeScript cannot
    // apply — which makes it exactly the case the clamp has to cover.
    const tenant = await newTenant()
    await h.db.query(
      `insert into settings (tenant_id, key, value) values ($1, 'reserve_rate', '0.1'::jsonb)`,
      [tenant],
    )
    const seller = await newSeller(tenant)
    const deal = await fundedDeal(tenant, seller)

    await releaseWith(deal, 424_620, 47_180)

    // Pool 405,347 less a 10% reserve of 40,534.
    const p = await payout(deal)
    expect(Number(p.amount)).toBe(364_813)
  })
})
