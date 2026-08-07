/**
 * `fund_deal` — the transactional half of an inbound provider webhook.
 *
 * Invariants 3 and 4 live here and nowhere else:
 *
 *   an amount or currency that does not match the deal produces `disputed`,
 *   never `funded_held`; and
 *
 *   a redelivered webhook carrying a reference we already hold changes
 *   nothing.
 *
 * The signature check and the provider re-fetch that must happen *before* this
 * is called are the Edge Function's half, in `flutterwave-webhook`.
 */

import { beforeAll, afterAll, describe, expect, test } from 'vitest'
import { migrated, rejects, type Harness } from './harness'

let h: Harness

interface Seeded {
  tenant: string
  seller: string
  deal: string
}

async function seedDeal(opts: {
  amount?: number
  presentment?: number
  presentmentCurrency?: string
  deposit?: number | null
} = {}): Promise<Seeded> {
  const amount = opts.amount ?? 100_000
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
                        presentment_currency, presentment_amount, deposit_amount,
                        buyer_country, provider, status, fee_amount, expected_complete_at)
     values ($1, 'buyer-1', $2, 'Excavator hire', $3, 'RWF', $4, $5, $6,
             'RW', 'flutterwave', 'created', $7, now() + interval '2 days')
     returning id`,
    [
      tenant.id, seller.id, amount,
      opts.presentmentCurrency ?? 'RWF',
      opts.presentment ?? amount,
      opts.deposit ?? null,
      Math.round(amount * 0.1),
    ],
  )
  return { tenant: tenant.id, seller: seller.id, deal: deal.id }
}

/**
 * What the provider says arrived. Defaults to exactly what was expected.
 *
 * The reference defaults to a fresh one per call: the whole file shares one
 * database, and one provider reference can back exactly one deal — which is
 * itself an invariant, tested below.
 */
const fund = (
  deal: string,
  opts: { amount?: number; currency?: string; ref?: string; method?: string } = {},
) =>
  h.db.query(
    `select * from fund_deal($1, 'flutterwave', $2, $3::payment_method, 'MTN',
                             $4, $5, null, 3)`,
    [
      deal,
      opts.ref ?? `FLW-${crypto.randomUUID()}`,
      opts.method ?? 'mobile_money',
      opts.amount ?? 100_000,
      opts.currency ?? 'RWF',
    ],
  )

const dealRow = async (id: string) => {
  const { rows: [d] } = await h.db.query<{
    status: string
    provider_ref: string | null
    payment_method: string | null
    payment_network: string | null
    presentment_amount: number
    presentment_currency: string
    auto_release_at: string | null
    fx_rate: number | null
  }>(
    `select status, provider_ref, payment_method, payment_network, presentment_amount,
            presentment_currency, auto_release_at, fx_rate
     from deals where id = $1`,
    [id],
  )
  return d
}

const ledgerFor = async (deal: string) => {
  const { rows } = await h.db.query<{ entry_type: string; amount: number }>(
    `select entry_type, amount from ledger where deal_id = $1 order by created_at, id`,
    [deal],
  )
  return rows
}

beforeAll(async () => { h = await migrated() }, 120_000)
afterAll(async () => { await h?.close() })

describe('a payment that matches', () => {
  test('moves the deal to funds held and books the hold', async () => {
    const s = await seedDeal()
    await fund(s.deal, { ref: 'FLW-MATCHED-1' })

    const d = await dealRow(s.deal)
    expect(d.status).toBe('funded_held')
    expect(d.provider_ref).toBe('FLW-MATCHED-1')
    expect(d.payment_method).toBe('mobile_money')
    expect(d.payment_network).toBe('MTN')

    expect(await ledgerFor(s.deal)).toEqual([
      { entry_type: 'hold', amount: 100_000 },
    ])
  })

  test('starts the auto-release timer from the expected completion date', async () => {
    const s = await seedDeal()
    await fund(s.deal)

    const { rows: [check] } = await h.db.query<{ ok: boolean }>(
      `select auto_release_at between now() + interval '4 days'
                                 and now() + interval '6 days' as ok
       from deals where id = $1`,
      [s.deal],
    )
    // expected_complete_at is two days out, auto_release_days is three.
    expect(check.ok).toBe(true)
  })

  test('books a security deposit as its own entry', async () => {
    const s = await seedDeal({ deposit: 50_000 })
    await fund(s.deal)

    // Compared as a set: both entries are written in the same transaction, so
    // they share a timestamp and the ledger promises no order between them.
    // The deposit is the buyer's money held against damage — a separate entry
    // from the payment, and excluded from the tenant's balance.
    expect(await ledgerFor(s.deal)).toEqual(
      expect.arrayContaining([
        { entry_type: 'hold', amount: 100_000 },
        { entry_type: 'deposit_hold', amount: 50_000 },
      ]),
    )
    expect(await ledgerFor(s.deal)).toHaveLength(2)
  })

  test('audits the verification and the funding separately', async () => {
    const s = await seedDeal()
    await fund(s.deal)

    const { rows } = await h.db.query<{ action: string }>(
      `select action from audit_log where deal_id = $1`,
      [s.deal],
    )

    // Compared as a set. Both rows are written in one transaction, so they
    // share a `created_at` to the microsecond and the id tiebreak is a random
    // uuid — the audit log does not order events within a transaction. What
    // matters here is that verification and funding are recorded as two
    // separate facts rather than one.
    expect(rows.map((r) => r.action).sort()).toEqual([
      'deal.funded_held',
      'webhook.verified',
    ])
  })

  test('notifies the client site', async () => {
    const s = await seedDeal()
    await h.db.query(
      `insert into webhook_endpoints (tenant_id, url, secret_encrypted, masked_secret)
       values ($1, 'https://client.example/hooks', 'enc', 'whsec_••••1')`,
      [s.tenant],
    )
    await fund(s.deal)

    const { rows } = await h.db.query<{ event: string }>(
      `select event from webhook_deliveries where deal_id = $1`, [s.deal],
    )
    expect(rows.map((r) => r.event)).toEqual(['order.funded_held'])
  })
})

describe('a payment that does not match — invariant 3', () => {
  test('a short payment disputes the deal instead of holding it', async () => {
    const s = await seedDeal()
    await fund(s.deal, { amount: 90_000 })

    expect((await dealRow(s.deal)).status).toBe('disputed')
  })

  test('the wrong currency disputes the deal', async () => {
    const s = await seedDeal()
    await fund(s.deal, { amount: 100_000, currency: 'KES' })

    expect((await dealRow(s.deal)).status).toBe('disputed')
  })

  test('an overpayment is a mismatch too, not a bonus', async () => {
    const s = await seedDeal()
    await fund(s.deal, { amount: 150_000 })

    expect((await dealRow(s.deal)).status).toBe('disputed')
  })

  test('books what actually arrived, so reconciliation still balances', async () => {
    const s = await seedDeal()
    await fund(s.deal, { amount: 90_000 })

    // The money genuinely reached the provider. Omitting the entry would leave
    // us permanently out of step with their balance and hand the
    // reconciliation pass a drift nobody could explain.
    expect(await ledgerFor(s.deal)).toEqual([
      { entry_type: 'hold', amount: 90_000 },
    ])
  })

  test('records what was expected against what came', async () => {
    const s = await seedDeal()
    await fund(s.deal, { amount: 90_000 })

    const { rows: [entry] } = await h.db.query<{ details: Record<string, unknown> }>(
      `select details from audit_log
       where deal_id = $1 and action = 'deal.amount_mismatch'`,
      [s.deal],
    )
    expect(entry.details).toMatchObject({
      expected_amount: 100_000,
      received_amount: 90_000,
      expected_currency: 'RWF',
      received_currency: 'RWF',
    })
  })

  test('sets no auto-release timer on a disputed deal', async () => {
    const s = await seedDeal()
    await fund(s.deal, { amount: 90_000 })

    // The timer must never release money whose payment we could not match.
    expect((await dealRow(s.deal)).auto_release_at).toBeNull()
  })
})

describe('idempotency — invariant 4', () => {
  test('the same webhook twice books one hold', async () => {
    const s = await seedDeal()
    const ref = `FLW-${crypto.randomUUID()}`
    await fund(s.deal, { ref })
    await fund(s.deal, { ref })

    expect(await ledgerFor(s.deal)).toEqual([
      { entry_type: 'hold', amount: 100_000 },
    ])
    expect((await dealRow(s.deal)).status).toBe('funded_held')
  })

  test('a redelivery does not emit a second notification', async () => {
    const s = await seedDeal()
    await h.db.query(
      `insert into webhook_endpoints (tenant_id, url, secret_encrypted, masked_secret)
       values ($1, 'https://client.example/hooks', 'enc', 'whsec_••••1')`,
      [s.tenant],
    )
    const ref = `FLW-${crypto.randomUUID()}`
    await fund(s.deal, { ref })
    await fund(s.deal, { ref })

    const { rows } = await h.db.query(
      `select 1 from webhook_deliveries where deal_id = $1`, [s.deal],
    )
    expect(rows).toHaveLength(1)
  })

  test('a different reference against a funded deal is refused', async () => {
    const s = await seedDeal()
    await fund(s.deal, { ref: 'FLW-REF-1' })

    // Not idempotent — a second, different payment for the same deal. Silently
    // accepting it would overwrite the reference to money we still hold.
    await rejects(() => fund(s.deal, { ref: 'FLW-REF-2' }), /cannot be funded/)
  })

  test('one provider reference cannot back two deals', async () => {
    const a = await seedDeal()
    const b = await seedDeal()
    await fund(a.deal, { ref: 'FLW-SHARED' })

    await rejects(
      () => fund(b.deal, { ref: 'FLW-SHARED' }),
      /duplicate key|deals_provider_ref_key/,
    )
  })

  test('funding an unknown deal is not found, not a crash', async () => {
    await rejects(
      () => fund('00000000-0000-0000-0000-000000000000'),
      /does not exist/,
    )
  })
})

describe('cross-border funding', () => {
  test('locks the rate on a converted deal', async () => {
    // A Rwandan host's RWF price, charged to a foreign card in USD.
    const s = await seedDeal({ amount: 140_000, presentment: 100, presentmentCurrency: 'USD' })
    await h.db.query(
      `select * from fund_deal($1, 'stripe', 'pi_1', 'card', 'Visa', 100, 'USD',
                               0.0007142857, 3)`,
      [s.deal],
    )

    const d = await dealRow(s.deal)
    expect(d.status).toBe('funded_held')
    expect(d.presentment_currency).toBe('USD')
    expect(Number(d.fx_rate)).toBeCloseTo(0.0007142857, 9)
  })

  test('books the hold in the currency actually collected', async () => {
    const s = await seedDeal({ amount: 140_000, presentment: 100, presentmentCurrency: 'USD' })
    await h.db.query(
      `select * from fund_deal($1, 'stripe', 'pi_2', 'card', 'Visa', 100, 'USD',
                               0.0007142857, 3)`,
      [s.deal],
    )

    const { rows: [entry] } = await h.db.query<{ amount: number; currency: string }>(
      `select amount, currency from ledger where deal_id = $1`, [s.deal],
    )
    // What landed in the provider balance, not what the seller is owed.
    expect(entry).toEqual({ amount: 100, currency: 'USD' })
  })

  test('a same-currency deal stores no rate at all', async () => {
    const s = await seedDeal()
    await fund(s.deal)

    expect((await dealRow(s.deal)).fx_rate).toBeNull()
  })
})
