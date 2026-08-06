/**
 * The three features added on top of the money engine, tested against a real
 * Postgres: signed outbound webhooks, the deterministic risk rules, and the
 * reconciliation pass.
 *
 * These mirror the dashboard's mock suites, which are the acceptance spec:
 *   payhold-dashboard/src/api/mock/webhooks.test.ts
 *   payhold-dashboard/src/api/mock/risk.test.ts
 *   payhold-dashboard/src/api/mock/reconciliation.test.ts
 *
 * The one thing they cannot cover is the signature itself — signing needs the
 * endpoint's decrypted secret and happens in the dispatcher, so that half lives
 * in `functions/_shared/webhooks.test.ts` as a Deno test.
 */

import { beforeAll, afterAll, describe, expect, test } from 'vitest'
import { migrated, rejects, type Harness } from './harness'

let h: Harness

interface Seeded {
  tenant: string
  seller: string
  deal: string
  endpoint: string
}

/** A tenant with one live webhook endpoint and one deal ready to move. */
async function seed(opts: {
  amount?: number
  status?: string
  sellerAgeDays?: number
  withEndpoint?: boolean
} = {}): Promise<Seeded> {
  const amount = opts.amount ?? 100_000
  const { rows: [tenant] } = await h.db.query<{ id: string }>(
    `insert into tenants (name, slug) values ('Acme', 'acme-' || gen_random_uuid())
     returning id`,
  )
  const { rows: [seller] } = await h.db.query<{ id: string }>(
    `insert into sellers (tenant_id, name, country, payout_currency, payout_provider,
                          beneficiary_token, masked_destination, created_at)
     values ($1, 'Host', 'RW', 'RWF', 'flutterwave_momo', 'tok_1', 'MTN •••• 4821',
             now() - ($2 || ' days')::interval)
     returning id`,
    [tenant.id, String(opts.sellerAgeDays ?? 400)],
  )
  const { rows: [deal] } = await h.db.query<{ id: string }>(
    `insert into deals (tenant_id, buyer_ref, seller_id, description, amount, currency,
                        presentment_currency, presentment_amount, buyer_country,
                        provider, provider_ref, status, fee_amount)
     values ($1, 'buyer-1', $2, 'Excavator hire', $3, 'RWF', 'RWF', $3, 'RW',
             'fake', 'ref-' || gen_random_uuid(), $4::deal_status, $5)
     returning id`,
    [tenant.id, seller.id, amount, opts.status ?? 'created', Math.round(amount * 0.1)],
  )

  let endpoint = ''
  if (opts.withEndpoint !== false) {
    const { rows: [e] } = await h.db.query<{ id: string }>(
      `insert into webhook_endpoints (tenant_id, url, secret_encrypted, masked_secret)
       values ($1, 'https://client.example/hooks', 'enc:secret', 'whsec_••••1234')
       returning id`,
      [tenant.id],
    )
    endpoint = e.id
  }

  return { tenant: tenant.id, seller: seller.id, deal: deal.id, endpoint }
}

const events = async (deal: string): Promise<string[]> => {
  const { rows } = await h.db.query<{ event: string }>(
    `select event from webhook_deliveries where deal_id = $1 order by created_at, id`,
    [deal],
  )
  return rows.map((r) => r.event)
}

beforeAll(async () => { h = await migrated() }, 120_000)
afterAll(async () => { await h?.close() })

describe('outbound webhooks are queued by the state change itself', () => {
  test('a deal moving to funded_held queues a notification', async () => {
    const s = await seed()
    await h.db.query(`update deals set status = 'funded_held' where id = $1`, [s.deal])

    expect(await events(s.deal)).toEqual(['deal.funded_held'])
  })

  test('the queued body is exactly what will be signed', async () => {
    const s = await seed()
    await h.db.query(`update deals set status = 'funded_held' where id = $1`, [s.deal])

    const { rows: [d] } = await h.db.query<{ body: string; payload: unknown }>(
      `select body, payload from webhook_deliveries where deal_id = $1`, [s.deal],
    )
    // Signing an object and re-serialising it on the way out can reorder keys,
    // and then every delivery fails verification on the client's side while
    // looking fine here.
    expect(JSON.parse(d.body)).toEqual(d.payload)
    expect(JSON.parse(d.body).event).toBe('deal.funded_held')
  })

  test('confirmations carry which side and whether the timer did it', async () => {
    const s = await seed({ status: 'funded_held' })
    await h.db.query(
      `insert into confirmations (deal_id, side, actor) values ($1, 'buyer', 'auto')`,
      [s.deal],
    )

    const { rows: [d] } = await h.db.query<{ payload: { data: Record<string, string> } }>(
      `select payload from webhook_deliveries where deal_id = $1 and event = 'deal.confirmed'`,
      [s.deal],
    )
    expect(d.payload.data).toMatchObject({ side: 'buyer', actor: 'auto' })
  })

  test('a full lifecycle emits the same events the mock does', async () => {
    const s = await seed({ status: 'funded_held' })
    await h.db.query(`insert into confirmations (deal_id, side) values ($1, 'buyer')`,
                     [s.deal])
    await h.db.query(`insert into confirmations (deal_id, side) values ($1, 'seller')`,
                     [s.deal])
    await h.db.query(`select release_deal($1, 90000, 'RWF', 10000)`, [s.deal])

    expect(await events(s.deal)).toEqual([
      'deal.confirmed',
      'deal.confirmed',
      'deal.released',
    ])
  })

  test('a refund notifies', async () => {
    const s = await seed({ status: 'funded_held' })
    await h.db.query(
      `insert into ledger (tenant_id, deal_id, entry_type, amount, currency, provider)
       values ($1, $2, 'hold', 100000, 'RWF', 'fake')`,
      [s.tenant, s.deal],
    )
    await h.db.query(`select refund_deal($1, 'Host cancelled')`, [s.deal])

    expect(await events(s.deal)).toContain('deal.refunded')
  })

  test('a deposit capture notifies', async () => {
    const s = await seed({ status: 'funded_held' })
    await h.db.query(`update deals set deposit_amount = 50000 where id = $1`, [s.deal])
    await h.db.query(
      `insert into ledger (tenant_id, deal_id, entry_type, amount, currency, provider)
       values ($1, $2, 'deposit_hold', 50000, 'RWF', 'fake')`,
      [s.tenant, s.deal],
    )
    await h.db.query(`select capture_deposit($1, 20000)`, [s.deal])

    const emitted = await events(s.deal)
    expect(emitted).toContain('deposit.captured')
    // The unused remainder goes back, and that is its own event.
    expect(emitted).toContain('deposit.released')
  })

  test('a tenant with no endpoint queues nothing', async () => {
    const s = await seed({ withEndpoint: false })
    await h.db.query(`update deals set status = 'funded_held' where id = $1`, [s.deal])

    expect(await events(s.deal)).toEqual([])
  })

  test('a disabled endpoint is skipped', async () => {
    const s = await seed()
    await h.db.query(`update webhook_endpoints set disabled_at = now() where id = $1`,
                     [s.endpoint])
    await h.db.query(`update deals set status = 'funded_held' where id = $1`, [s.deal])

    expect(await events(s.deal)).toEqual([])
  })

  test('the same deal state written twice queues one notification', async () => {
    const s = await seed()
    await h.db.query(`update deals set status = 'funded_held' where id = $1`, [s.deal])
    await h.db.query(`update deals set status = 'funded_held' where id = $1`, [s.deal])

    expect(await events(s.deal)).toEqual(['deal.funded_held'])
  })
})

describe('delivery claiming and backoff', () => {
  test('a claim returns the url and body the dispatcher needs', async () => {
    const s = await seed()
    await h.db.query(`update deals set status = 'funded_held' where id = $1`, [s.deal])

    const { rows } = await h.db.query<{ url: string; body: string; event: string }>(
      `select * from claim_webhook_deliveries(50)`,
    )
    // The whole file shares one database, so a claim legitimately returns other
    // tests' deliveries too. Find ours by the deal in the body.
    const mine = rows.find((r) => JSON.parse(r.body).deal_id === s.deal)

    expect(mine).toBeDefined()
    expect(mine!.event).toBe('deal.funded_held')
    expect(mine!.url).toBe('https://client.example/hooks')
  })

  test('a claimed delivery is not handed out again immediately', async () => {
    const s = await seed()
    await h.db.query(`update deals set status = 'funded_held' where id = $1`, [s.deal])

    await h.db.query(`select * from claim_webhook_deliveries(10)`)
    const { rows } = await h.db.query<{ id: string }>(
      `select * from claim_webhook_deliveries(10)`,
    )
    // Two dispatcher invocations overlapping must not send the same delivery
    // twice — the claim pushes next_attempt_at forward.
    expect(rows).toHaveLength(0)
  })

  test('success records the signature that was sent', async () => {
    const s = await seed()
    await h.db.query(`update deals set status = 'funded_held' where id = $1`, [s.deal])
    const { rows: [d] } = await h.db.query<{ id: string }>(
      `select id from webhook_deliveries where deal_id = $1`, [s.deal],
    )

    await h.db.query(
      `select record_webhook_attempt($1, true, 200, null, 't=2026-08-06T09:00:00.000Z,v1=abc')`,
      [d.id],
    )

    const { rows: [after] } = await h.db.query<{
      status: string; attempts: number; signature: string; delivered_at: string | null
    }>(`select status, attempts, signature, delivered_at from webhook_deliveries where id = $1`,
       [d.id])
    expect(after.status).toBe('delivered')
    expect(after.attempts).toBe(1)
    expect(after.signature).toContain('v1=')
    expect(after.delivered_at).not.toBeNull()
  })

  test('failures back off, then give up after five attempts', async () => {
    const s = await seed()
    await h.db.query(`update deals set status = 'funded_held' where id = $1`, [s.deal])
    const { rows: [d] } = await h.db.query<{ id: string }>(
      `select id from webhook_deliveries where deal_id = $1`, [s.deal],
    )

    for (let i = 0; i < 4; i++) {
      await h.db.query(
        `select record_webhook_attempt($1, false, 500, 'client returned 500', 'sig')`,
        [d.id],
      )
      const { rows: [mid] } = await h.db.query<{ status: string; next_attempt_at: string }>(
        `select status, next_attempt_at from webhook_deliveries where id = $1`, [d.id],
      )
      expect(mid.status).toBe('pending')
      expect(mid.next_attempt_at).not.toBeNull()
    }

    await h.db.query(
      `select record_webhook_attempt($1, false, 500, 'client returned 500', 'sig')`,
      [d.id],
    )
    const { rows: [end] } = await h.db.query<{
      status: string; attempts: number; next_attempt_at: string | null; error: string
    }>(`select status, attempts, next_attempt_at, error from webhook_deliveries where id = $1`,
       [d.id])

    expect(end.status).toBe('failed')
    expect(end.attempts).toBe(5)
    expect(end.next_attempt_at).toBeNull()
    expect(end.error).toBeTruthy()
  })

  test('every outcome leaves an audit row', async () => {
    const s = await seed()
    await h.db.query(`update deals set status = 'funded_held' where id = $1`, [s.deal])
    const { rows: [d] } = await h.db.query<{ id: string }>(
      `select id from webhook_deliveries where deal_id = $1`, [s.deal],
    )
    await h.db.query(`select record_webhook_attempt($1, true, 200, null, 'sig')`, [d.id])

    const { rows } = await h.db.query<{ action: string }>(
      `select action from audit_log where deal_id = $1 and action like 'webhook.%'`,
      [s.deal],
    )
    expect(rows.map((r) => r.action)).toContain('webhook.delivered')
  })
})

describe('risk rules', () => {
  /** Release a seeded deal and return its queued payout. */
  async function payoutFor(s: Seeded, amount = 90_000): Promise<string> {
    await h.db.query(`update deals set status = 'funded_held' where id = $1`, [s.deal])
    await h.db.query(
      `insert into ledger (tenant_id, deal_id, entry_type, amount, currency, provider)
       values ($1, $2, 'hold', 100000, 'RWF', 'fake')`,
      [s.tenant, s.deal],
    )
    await h.db.query(`insert into confirmations (deal_id, side) values ($1, 'buyer')`,
                     [s.deal])
    await h.db.query(`insert into confirmations (deal_id, side) values ($1, 'seller')`,
                     [s.deal])
    await h.db.query(`select release_deal($1, $2, 'RWF', 10000)`, [s.deal, amount])

    const { rows: [p] } = await h.db.query<{ id: string }>(
      `select id from payouts where deal_id = $1`, [s.deal],
    )
    return p.id
  }

  const statusOf = async (payout: string): Promise<string> => {
    const { rows: [p] } = await h.db.query<{ status: string }>(
      `select status from payouts where id = $1`, [payout],
    )
    return p.status
  }

  test('holds the first payout to a seller who registered just before the deal', async () => {
    const s = await seed({ sellerAgeDays: 1 })
    const payout = await payoutFor(s)

    const { rows: [held] } = await h.db.query<{ screen_payout: boolean }>(
      `select screen_payout($1)`, [payout],
    )
    expect(held.screen_payout).toBe(true)
    expect(await statusOf(payout)).toBe('held_for_review')
  })

  test('writes a signal a person can check', async () => {
    const s = await seed({ sellerAgeDays: 1 })
    await h.db.query(`select screen_payout($1)`, [await payoutFor(s)])

    const { rows } = await h.db.query<{
      signal: string; severity: string; explanation: string; value: Record<string, unknown>
    }>(`select signal, severity, explanation, value from risk_signals where deal_id = $1
        order by severity desc`, [s.deal])

    // Two things were noticed: a first payout to a new seller, which holds, and
    // that the deal was funded and released in one breath, which on an amount
    // this size is context rather than cause.
    expect(rows.map((r) => r.signal).sort()).toEqual(['fast_release', 'new_seller'])

    const blocking = rows.filter((r) => r.severity === 'review')
    expect(blocking).toHaveLength(1)
    expect(blocking[0].signal).toBe('new_seller')
    expect(blocking[0].explanation).toContain('First payout')
    expect(blocking[0].value).toMatchObject({ prior_payouts: 0 })
  })

  test('holds when the seller lost a dispute recently', async () => {
    const s = await seed()
    // A prior deal for the same seller, refunded after a dispute.
    const { rows: [prior] } = await h.db.query<{ id: string }>(
      `insert into deals (tenant_id, buyer_ref, seller_id, description, amount, currency,
                          presentment_currency, presentment_amount, buyer_country,
                          provider, provider_ref, status, fee_amount)
       values ($1, 'buyer-0', $2, 'Earlier hire', 50000, 'RWF', 'RWF', 50000, 'RW',
               'fake', 'ref-prior', 'refunded', 5000)
       returning id`,
      [s.tenant, s.seller],
    )
    await h.db.query(
      `insert into disputes (tenant_id, deal_id, raised_by, reason, status, resolved_at)
       values ($1, $2, 'buyer', 'Never delivered', 'resolved_refunded', now())`,
      [s.tenant, prior.id],
    )

    const payout = await payoutFor(s)
    await h.db.query(`select screen_payout($1)`, [payout])

    expect(await statusOf(payout)).toBe('held_for_review')
  })

  test('lets an ordinary payout through', async () => {
    const s = await seed()
    // An established seller: one prior payout already sent.
    const { rows: [old] } = await h.db.query<{ id: string }>(
      `insert into deals (tenant_id, buyer_ref, seller_id, description, amount, currency,
                          presentment_currency, presentment_amount, buyer_country,
                          provider, provider_ref, status, fee_amount, released_at)
       values ($1, 'buyer-0', $2, 'Earlier hire', 100000, 'RWF', 'RWF', 100000, 'RW',
               'fake', 'ref-old', 'paid_out', 10000, now() - interval '30 days')
       returning id`,
      [s.tenant, s.seller],
    )
    await h.db.query(
      `insert into payouts (tenant_id, deal_id, seller_id, amount, currency, status,
                            scheduled_for, paid_at)
       values ($1, $2, $3, 90000, 'RWF', 'paid', now() - interval '30 days',
               now() - interval '30 days')`,
      [s.tenant, old.id, s.seller],
    )

    const payout = await payoutFor(s)
    const { rows: [held] } = await h.db.query<{ screen_payout: boolean }>(
      `select screen_payout($1)`, [payout],
    )

    expect(held.screen_payout).toBe(false)
    expect(await statusOf(payout)).toBe('scheduled')
  })

  test('records signals but holds nothing when the tenant turns the rules off', async () => {
    const s = await seed({ sellerAgeDays: 1 })
    await h.db.query(
      `insert into settings (tenant_id, key, value) values ($1, 'risk_rules_enabled', '0'::jsonb)`,
      [s.tenant],
    )

    const payout = await payoutFor(s)
    const { rows: [held] } = await h.db.query<{ screen_payout: boolean }>(
      `select screen_payout($1)`, [payout],
    )

    expect(held.screen_payout).toBe(false)
    expect(await statusOf(payout)).toBe('scheduled')

    // Still noticed, still written down: this is the labelled history §12.4
    // trains on, and it cannot be reconstructed after the fact.
    const { rows } = await h.db.query(`select 1 from risk_signals where deal_id = $1`,
                                      [s.deal])
    expect(rows.length).toBeGreaterThan(0)
  })

  test('a held payout is released only by a person, and it is recorded', async () => {
    const s = await seed({ sellerAgeDays: 1 })
    const payout = await payoutFor(s)
    await h.db.query(`select screen_payout($1)`, [payout])

    await h.db.query(`select approve_payout_review($1, 'grace@autohire.rw')`, [payout])

    const { rows: [p] } = await h.db.query<{
      status: string; review_approved_by: string; review_held_at: string
    }>(`select status, review_approved_by, review_held_at from payouts where id = $1`,
       [payout])

    expect(p.status).toBe('scheduled')
    expect(p.review_approved_by).toBe('grace@autohire.rw')
    // The hold is not erased by the approval — the history of both is the point.
    expect(p.review_held_at).not.toBeNull()

    const { rows: [audit] } = await h.db.query<{ actor: string }>(
      `select actor from audit_log where deal_id = $1 and action = 'payout.review_approved'`,
      [s.deal],
    )
    expect(audit.actor).toBe('grace@autohire.rw')
  })

  test('refuses to approve a payout that was never held', async () => {
    const s = await seed()
    const payout = await payoutFor(s)

    await rejects(
      () => h.db.query(`select approve_payout_review($1, 'grace')`, [payout]),
      /not held for review/,
    )
  })

  test('does not re-hold what a person already approved', async () => {
    const s = await seed({ sellerAgeDays: 1 })
    const payout = await payoutFor(s)
    await h.db.query(`select screen_payout($1)`, [payout])
    await h.db.query(`select approve_payout_review($1, 'grace')`, [payout])

    const { rows: [again] } = await h.db.query<{ screen_payout: boolean }>(
      `select screen_payout($1)`, [payout],
    )
    // The rules would still fire — the seller is still new. A second screening
    // that overruled the human would make approval meaningless.
    expect(again.screen_payout).toBe(false)
    expect(await statusOf(payout)).toBe('scheduled')
  })

  test('holding a payout notifies the client site', async () => {
    const s = await seed({ sellerAgeDays: 1 })
    await h.db.query(`select screen_payout($1)`, [await payoutFor(s)])

    expect(await events(s.deal)).toContain('payout.held_for_review')
  })

  test('a hold moves no money', async () => {
    const s = await seed({ sellerAgeDays: 1 })
    const payout = await payoutFor(s)
    const before = await h.db.query(`select 1 from ledger where deal_id = $1`, [s.deal])

    await h.db.query(`select screen_payout($1)`, [payout])

    const after = await h.db.query(`select 1 from ledger where deal_id = $1`, [s.deal])
    expect(after.rows.length).toBe(before.rows.length)

    const { rows: [d] } = await h.db.query<{ status: string }>(
      `select status from deals where id = $1`, [s.deal],
    )
    expect(d.status).toBe('released')
  })
})

describe('reconciliation', () => {
  test('agreeing balances raise nothing', async () => {
    const s = await seed()
    await h.db.query(`select record_reconciliation($1, 'flutterwave', 'RWF', 100000, 100000)`,
                     [s.tenant])

    const { rows } = await h.db.query(
      `select 1 from reconciliation_alerts where tenant_id = $1`, [s.tenant],
    )
    expect(rows).toHaveLength(0)
  })

  test('drift raises an alert and freezes that tenant payouts', async () => {
    const s = await seed()
    await h.db.query(`select record_reconciliation($1, 'flutterwave', 'RWF', 100000, 125000)`,
                     [s.tenant])

    const { rows: [a] } = await h.db.query<{ drift: string; provider: string }>(
      `select drift, provider from reconciliation_alerts
       where tenant_id = $1 and resolved_at is null`, [s.tenant],
    )
    expect(Number(a.drift)).toBe(25_000)
    expect(a.provider).toBe('flutterwave')

    const { rows: [t] } = await h.db.query<{ status: string }>(
      `select status from tenants where id = $1`, [s.tenant],
    )
    expect(t.status).toBe('payouts_frozen')
  })

  test('the same drift on a later pass refreshes rather than duplicates', async () => {
    const s = await seed()
    await h.db.query(`select record_reconciliation($1, 'flutterwave', 'RWF', 100000, 125000)`,
                     [s.tenant])
    await h.db.query(`select record_reconciliation($1, 'flutterwave', 'RWF', 100000, 125000)`,
                     [s.tenant])

    const { rows } = await h.db.query(
      `select 1 from reconciliation_alerts where tenant_id = $1 and resolved_at is null`,
      [s.tenant],
    )
    expect(rows).toHaveLength(1)
  })

  test('rails are reconciled separately', async () => {
    const s = await seed()
    await h.db.query(`select record_reconciliation($1, 'flutterwave', 'RWF', 100000, 125000)`,
                     [s.tenant])
    await h.db.query(`select record_reconciliation($1, 'stripe', 'USD', 5000, 4500)`,
                     [s.tenant])

    const { rows } = await h.db.query<{ provider: string; currency: string }>(
      `select provider, currency from reconciliation_alerts
       where tenant_id = $1 and resolved_at is null order by provider::text`, [s.tenant],
    )
    expect(rows).toEqual([
      { provider: 'flutterwave', currency: 'RWF' },
      { provider: 'stripe', currency: 'USD' },
    ])
  })

  test('closes the alert when the drift goes away, but does not unfreeze', async () => {
    const s = await seed()
    await h.db.query(`select record_reconciliation($1, 'flutterwave', 'RWF', 100000, 125000)`,
                     [s.tenant])
    await h.db.query(`select record_reconciliation($1, 'flutterwave', 'RWF', 100000, 100000)`,
                     [s.tenant])

    const { rows: open } = await h.db.query(
      `select 1 from reconciliation_alerts where tenant_id = $1 and resolved_at is null`,
      [s.tenant],
    )
    expect(open).toHaveLength(0)

    // Resuming is a judgement about whether the drift was explained, and that
    // is a person's call.
    const { rows: [t] } = await h.db.query<{ status: string }>(
      `select status from tenants where id = $1`, [s.tenant],
    )
    expect(t.status).toBe('payouts_frozen')
  })
})
