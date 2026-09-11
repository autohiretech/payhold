/**
 * `dispute_decision_relay` — migration `20260911000002`.
 *
 * A tenant whose own platform decides disputes relays the outcome over its API
 * key and names the person who decided. PayHold still holds the money and still
 * moves it, so the properties worth pinning are about money and about names:
 *
 *   * off — the default, in SQL, in `settings.ts` and on the dashboard — nothing
 *     moves, and the refusal is its own code;
 *   * on, release, refund and a split move exactly what the person path moves,
 *     and both resolution webhooks still go out;
 *   * the credential is what is recorded as deciding and the name is recorded as
 *     *reported*, in the dispute, the audit row, the timeline and the webhook;
 *   * the conflict-of-interest check compares the reported name, and a
 *     credential that raised the dispute may still relay a distinct person's
 *     decision;
 *   * a retry of the same outcome moves nothing, and a different one is refused;
 *   * `dispute.opened` says which dispute; and an AI draft cannot be approved by
 *     a key at all.
 *
 * The status each refusal answers with at the edge is
 * `functions/_shared/dispute-relay.test.ts`.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { migrated, rejects, type Harness } from './harness'

let h: Harness

beforeAll(async () => { h = await migrated() }, 120_000)
afterAll(async () => { await h?.close() })

/** `resolveCaller` puts the credential's label here, never a person's name. */
const API_KEY = 'api_key:AutoHire live'
/** The human the platform says decided. */
const JANE = 'autohire-admin:jane@example.com'

type Relay = 'on' | 'off' | 'unset'

interface Account {
  tenant: string
  seller: string
}

/** A tenant with a webhook endpoint, so every event is queued and readable. */
async function account(relay: Relay): Promise<Account> {
  const { rows: [t] } = await h.db.query<{ id: string }>(
    `insert into tenants (name, slug) values ('AutoHire', 'autohire-' || gen_random_uuid())
     returning id`,
  )
  if (relay !== 'unset') {
    // 1 or 0, never a JSON boolean — see `encode` in settings.ts.
    await h.db.query(
      `insert into settings (tenant_id, key, value)
       values ($1, 'dispute_decision_relay', $2::jsonb)`,
      [t.id, relay === 'on' ? '1' : '0'],
    )
  }
  await h.db.query(
    `insert into webhook_endpoints (tenant_id, url, secret_encrypted, masked_secret)
     values ($1, 'https://autohire.example/hooks', 'enc:secret', 'whsec_••••1234')`,
    [t.id],
  )
  const { rows: [s] } = await h.db.query<{ id: string }>(
    `insert into sellers (tenant_id, name, country, payout_currency,
                          payout_provider, beneficiary_token, masked_destination)
     values ($1, 'Host', 'RW', 'RWF', 'flutterwave_momo', 'tok_' || gen_random_uuid(), '•••1234')
     returning id`,
    [t.id],
  )
  return { tenant: t.id, seller: s.id }
}

/** A funded deal of 100,000 with a 10,000 fee. */
async function funded(a: Account, amount = 100_000): Promise<string> {
  const { rows: [d] } = await h.db.query<{ id: string }>(
    `insert into deals (tenant_id, buyer_ref, seller_id, description, amount, currency,
                        presentment_currency, presentment_amount, buyer_country,
                        provider, fee_amount)
     values ($1, 'renter_1', $2, 'Toyota RAV4, 3 days', $3, 'RWF', 'RWF', $3, 'RW', 'fake', $4)
     returning id`,
    [a.tenant, a.seller, amount, Math.round(amount * 0.1)],
  )
  await h.db.query(
    `select fund_deal($1, 'fake', $2, 'mobile_money', 'MTN', $3, 'RWF')`,
    [d.id, `ref-${d.id}`, amount],
  )
  return d.id
}

/** Raised by the platform's own key unless a case says otherwise. */
async function openDispute(
  deal: string,
  opts: { actor?: string; amount?: number | null; code?: string } = {},
): Promise<string> {
  const { rows: [d] } = await h.db.query<{ id: string }>(
    `select id from open_dispute($1, 'buyer', 'Scratch on the rear bumper at return',
                                 $2, $3, $4)`,
    [deal, opts.code ?? 'damaged', opts.actor ?? API_KEY, opts.amount ?? null],
  )
  return d.id
}

/** What `functions/disputes` sends for an API key. */
async function relayed(
  dispute: string,
  resolution: string,
  opts: { refund?: number | null; reported?: string | null; credential?: string } = {},
): Promise<Record<string, unknown>> {
  const { rows: [d] } = await h.db.query<Record<string, unknown>>(
    `select * from resolve_dispute($1, $2, 'Decided on the platform', 90000, 'RWF', 10000,
                                   $3, $4, $5, true)`,
    [
      dispute,
      resolution,
      opts.refund ?? null,
      opts.credential ?? API_KEY,
      opts.reported === undefined ? JANE : opts.reported,
    ],
  )
  return d
}

/** What `functions/disputes` sends for a signed-in person — unchanged. */
async function byPerson(
  dispute: string,
  resolution: string,
  actor = 'user:dana@autohire.rw',
  refund: number | null = null,
): Promise<Record<string, unknown>> {
  const { rows: [d] } = await h.db.query<Record<string, unknown>>(
    `select * from resolve_dispute($1, $2, 'Decided here', 90000, 'RWF', 10000, $3, $4)`,
    [dispute, resolution, refund, actor],
  )
  return d
}

async function dealStatus(deal: string): Promise<string> {
  const { rows: [d] } = await h.db.query<{ status: string }>(
    `select status::text from deals where id = $1`, [deal],
  )
  return d.status
}

async function disputeRow(id: string) {
  const { rows: [d] } = await h.db.query<{
    status: string
    decided_by: string | null
    reported_decider: string | null
    decider_source: string | null
    resolution_refund_amount: string | null
  }>(
    `select status::text, decided_by, reported_decider, decider_source,
            resolution_refund_amount
       from disputes where id = $1`,
    [id],
  )
  return d
}

async function ledgerCount(deal: string): Promise<number> {
  const { rows: [r] } = await h.db.query<{ n: number }>(
    `select count(*)::int as n from ledger where deal_id = $1`, [deal],
  )
  return r.n
}

async function refunded(deal: string): Promise<number> {
  const { rows: [a] } = await h.db.query<{ refunded: string }>(
    `select refunded from deal_amounts($1)`, [deal],
  )
  return Number(a.refunded)
}

async function deliveries(deal: string, event: string) {
  const { rows } = await h.db.query<{
    payload: { event: string; deal_id: string; occurred_at: string; data: Record<string, unknown> }
  }>(
    `select payload from webhook_deliveries where deal_id = $1 and event = $2`,
    [deal, event],
  )
  return rows.map((r) => r.payload)
}

async function resolvedAudit(deal: string) {
  const { rows } = await h.db.query<{ actor: string; details: Record<string, unknown> }>(
    `select actor, details from audit_log
      where deal_id = $1 and action = 'dispute.resolved' order by created_at`,
    [deal],
  )
  return rows
}

// ---------------------------------------------------------------------------

describe('off by default', () => {
  test('an account that never saved the setting is off; a stored 1 is on, a 0 off', async () => {
    const unset = await account('unset')
    const on = await account('on')
    const off = await account('off')

    const ask = async (tenant: string) => {
      const { rows: [r] } = await h.db.query<{ on: boolean }>(
        `select dispute_decision_relay($1) as on`, [tenant],
      )
      return r.on
    }

    expect(await ask(unset.tenant)).toBe(false)
    expect(await ask(on.tenant)).toBe(true)
    expect(await ask(off.tenant)).toBe(false)
  })

  test('the verification relay kept its own default, which is on', async () => {
    // Two relays, two defaults, on purpose: that one only unblocks paperwork.
    const unset = await account('unset')
    const { rows: [r] } = await h.db.query<{ on: boolean }>(
      `select seller_verification_relay($1) as on`, [unset.tenant],
    )
    expect(r.on).toBe(true)
  })

  test('settings.ts falls back to the same default SQL does', () => {
    const code = readFileSync(
      join(import.meta.dirname, '..', 'supabase', 'functions', '_shared', 'settings.ts'),
      'utf8',
    )
    expect(code).toMatch(/dispute_decision_relay: \{ kind: 'flag', fallback: false \}/)
    expect(code).toMatch(/seller_verification_relay: \{ kind: 'flag', fallback: true \}/)
  })
})

describe('relay off — the key is refused and nothing moves', () => {
  for (const relay of ['unset', 'off'] as const) {
    test(`with the setting ${relay === 'unset' ? 'never saved' : 'stored off'}`, async () => {
      const a = await account(relay)
      const deal = await funded(a)
      const dispute = await openDispute(deal)
      const before = await ledgerCount(deal)

      await rejects(() => relayed(dispute, 'release'), /^dispute_relay_off: .*My platform decides disputes/)

      expect(await dealStatus(deal)).toBe('disputed')
      expect((await disputeRow(dispute)).status).toBe('open')
      expect(await ledgerCount(deal)).toBe(before)
      expect(await deliveries(deal, 'dispute.resolved')).toHaveLength(0)
      expect(await resolvedAudit(deal)).toHaveLength(0)
    })
  }

  test('an api_key decider is a relayed decision even without the flag', async () => {
    // The flag is what an honest caller passes. The prefix catches one written
    // without it, which is the reason the rule lives in SQL.
    const a = await account('unset')
    const deal = await funded(a)
    const dispute = await openDispute(deal)

    // A reported decider and an `api_key:` actor, and no flag. Read as a person
    // this would be refused for carrying a reported decider; it is refused for
    // the relay being off instead, which is the proof it was read as relayed.
    await rejects(
      () => h.db.query(
        `select * from resolve_dispute($1, 'release', 'x', 90000, 'RWF', 10000, null, $2, $3)`,
        [dispute, API_KEY, JANE],
      ),
      /dispute_relay_off/,
    )
    // And with no name at all it is still the relayed path's refusal.
    await rejects(() => byPerson(dispute, 'release', API_KEY), /invalid_request: decided_by is required/)
    expect((await disputeRow(dispute)).status).toBe('open')
  })
})

describe('relay on — the money moves exactly as it does for a person', () => {
  test('release: the deal clears and both resolution webhooks go out', async () => {
    const a = await account('on')
    const deal = await funded(a)
    const dispute = await openDispute(deal)

    const row = await relayed(dispute, 'release')
    expect(row.status).toBe('resolved_released')

    expect(await dealStatus(deal)).toBe('clearing')
    expect(await deliveries(deal, 'order.clearing_started')).toHaveLength(1)
    expect(await deliveries(deal, 'deal.dispute_resolved')).toHaveLength(1)

    const [resolved] = await deliveries(deal, 'dispute.resolved')
    expect(resolved.data).toEqual({
      dispute_id: dispute,
      status: 'resolved_released',
      // The credential PayHold authenticated, and the name as reported beside it.
      decided_by: API_KEY,
      decider_source: 'platform_reported',
      reported_decider: JANE,
    })
  })

  test('refund: the buyer gets everything back', async () => {
    const a = await account('on')
    const deal = await funded(a)
    const dispute = await openDispute(deal)

    expect((await relayed(dispute, 'refund')).status).toBe('resolved_refunded')

    expect(await dealStatus(deal)).toBe('refunded')
    expect(await refunded(deal)).toBe(100_000)
    expect(await deliveries(deal, 'refund.succeeded')).toHaveLength(1)
    expect(await deliveries(deal, 'dispute.resolved')).toHaveLength(1)
    expect(await deliveries(deal, 'deal.dispute_resolved')).toHaveLength(1)
  })

  test('the refund is booked against the credential, not a PayHold staff member', async () => {
    const a = await account('on')
    const deal = await funded(a)
    const dispute = await openDispute(deal)
    await relayed(dispute, 'refund')

    // §7.1.5 wants an actor on every refund, and it is whoever asked.
    const { rows: refundRows } = await h.db.query<{ actor: string }>(
      `select actor from refunds where deal_id = $1`, [deal],
    )
    expect(refundRows.map((r) => r.actor)).toEqual([API_KEY])

    const { rows: audit } = await h.db.query<{ actor: string }>(
      `select actor from audit_log where deal_id = $1 and action = 'deal.refunded'`, [deal],
    )
    expect(audit.map((r) => r.actor)).toEqual([API_KEY])
  })

  test('a person here still books the refund exactly as before', async () => {
    const a = await account('on')
    const deal = await funded(a)
    const dispute = await openDispute(deal)
    await byPerson(dispute, 'refund')

    const { rows } = await h.db.query<{ actor: string }>(
      `select actor from refunds where deal_id = $1`, [deal],
    )
    expect(rows.map((r) => r.actor)).toEqual(['payhold-staff'])
  })

  test('partial_refund: the split is refunded, the rest released, the amount recorded', async () => {
    const a = await account('on')
    const deal = await funded(a)
    const dispute = await openDispute(deal)

    expect((await relayed(dispute, 'partial_refund', { refund: 25_000 })).status)
      .toBe('resolved_split')

    expect(await refunded(deal)).toBe(25_000)
    expect(await dealStatus(deal)).toBe('clearing')
    expect(Number((await disputeRow(dispute)).resolution_refund_amount)).toBe(25_000)
    expect(await deliveries(deal, 'dispute.resolved')).toHaveLength(1)
    expect(await deliveries(deal, 'deal.dispute_resolved')).toHaveLength(1)
  })

  test('the disputed amount still bounds a relayed decision', async () => {
    const a = await account('on')
    const deal = await funded(a)
    const dispute = await openDispute(deal, { amount: 30_000 })

    await rejects(() => relayed(dispute, 'refund'), /only 30000 of this payment is in dispute/)
    await rejects(
      () => relayed(dispute, 'partial_refund', { refund: 50_000 }),
      /more than the 30000 in dispute/,
    )
    expect((await disputeRow(dispute)).status).toBe('open')
  })

  test('a request still outstanding is withdrawn, by the credential', async () => {
    const a = await account('on')
    const deal = await funded(a)
    const dispute = await openDispute(deal)
    const { rows: [o] } = await h.db.query<{ id: string }>(
      `select id from make_dispute_offer($1, 'seller', $2, 'update')`, [dispute, API_KEY],
    )

    await relayed(dispute, 'release')

    const { rows: [after] } = await h.db.query<{ status: string; responded_by_actor: string }>(
      `select status::text, responded_by_actor from dispute_offers where id = $1`, [o.id],
    )
    expect(after).toEqual({ status: 'withdrawn', responded_by_actor: API_KEY })
  })
})

describe('the name is stored as reported, and the credential as the actor', () => {
  test('on the dispute', async () => {
    const a = await account('on')
    const deal = await funded(a)
    const dispute = await openDispute(deal)
    await relayed(dispute, 'release')

    expect(await disputeRow(dispute)).toMatchObject({
      decided_by: API_KEY,
      reported_decider: JANE,
      decider_source: 'platform_reported',
    })
  })

  test('on the audit row, with the status it actually came from', async () => {
    const a = await account('on')
    const deal = await funded(a)
    const dispute = await openDispute(deal)
    await relayed(dispute, 'release')

    const rows = await resolvedAudit(deal)
    expect(rows).toHaveLength(1)
    // Never a person who was not the caller.
    expect(rows[0].actor).toBe(API_KEY)
    expect(rows[0].details).toMatchObject({
      resolution: 'release',
      dispute_id: dispute,
      reported_decider: JANE,
      decider_source: 'platform_reported',
      // Captured before `update … returning * into` rewrote the records. Read
      // afterwards, these would say `funded_held`/`clearing` and a resolved
      // status — the one value from_status cannot mean.
      from_status: 'disputed',
      dispute_from_status: 'open',
    })
  })

  test('on the timeline', async () => {
    const a = await account('on')
    const deal = await funded(a)
    const dispute = await openDispute(deal)
    await relayed(dispute, 'release')

    const { rows: [r] } = await h.db.query<{ actor: string; details: Record<string, unknown> }>(
      `select actor, details from dispute_timeline($1) where kind = 'resolved'`, [dispute],
    )
    expect(r.actor).toBe(API_KEY)
    expect(r.details).toMatchObject({
      decider_source: 'platform_reported',
      reported_decider: JANE,
    })
  })

  test('a person here is recorded exactly as before, now labelled a person', async () => {
    const a = await account('on')
    const deal = await funded(a)
    const dispute = await openDispute(deal)
    await byPerson(dispute, 'release', 'user:dana@autohire.rw')

    expect(await disputeRow(dispute)).toMatchObject({
      decided_by: 'user:dana@autohire.rw',
      reported_decider: null,
      decider_source: 'person',
    })
    const [row] = await resolvedAudit(deal)
    expect(row.actor).toBe('user:dana@autohire.rw')
    expect(row.details).toMatchObject({
      decider_source: 'person',
      reported_decider: null,
      from_status: 'disputed',
      dispute_from_status: 'open',
    })
  })

  test('a person cannot hand in a reported decider', async () => {
    const a = await account('on')
    const deal = await funded(a)
    const dispute = await openDispute(deal)

    await rejects(
      () => h.db.query(
        `select * from resolve_dispute($1, 'release', 'x', 90000, 'RWF', 10000, null,
                                       'user:dana@autohire.rw', 'someone-else')`,
        [dispute],
      ),
      /policy_violation: only a decision relayed over an API key carries a reported decider/,
    )
  })

  test('agreement between the parties is labelled as that', async () => {
    const a = await account('on')
    const deal = await funded(a)
    const dispute = await openDispute(deal)
    const { rows: [o] } = await h.db.query<{ id: string }>(
      `select id from make_dispute_offer($1, 'seller', 'user:host', 'full_refund')`, [dispute],
    )
    await h.db.query(
      `select respond_dispute_offer($1, 'buyer', 'user:renter', true, 0, 'RWF', 0)`, [o.id],
    )

    expect(await disputeRow(dispute)).toMatchObject({
      decided_by: 'both-parties',
      decider_source: 'both_parties',
      reported_decider: null,
    })
  })
})

describe('the reported decider must name somebody', () => {
  const cases: [string, string | null, RegExp][] = [
    ['missing', null, /invalid_request: decided_by is required/],
    ['blank', '   ', /invalid_request: decided_by is required/],
    ['too long', 'x'.repeat(201), /invalid_request: decided_by must be 200 characters/],
    ['the agreement name', 'both-parties', /invalid_request: decided_by must name the person/],
    ['the credential itself', API_KEY, /invalid_request: decided_by must name the person/],
  ]

  for (const [label, reported, why] of cases) {
    test(`${label} is refused and nothing moves`, async () => {
      const a = await account('on')
      const deal = await funded(a)
      const dispute = await openDispute(deal)
      const before = await ledgerCount(deal)

      await rejects(() => relayed(dispute, 'release', { reported }), why)

      expect((await disputeRow(dispute)).status).toBe('open')
      expect(await ledgerCount(deal)).toBe(before)
    })
  }
})

describe('conflict of interest, relayed', () => {
  test('a reported decider who raised the dispute cannot decide it', async () => {
    const a = await account('on')
    const deal = await funded(a)
    const dispute = await openDispute(deal, { actor: 'autohire-admin:sam@example.com' })

    await rejects(
      () => relayed(dispute, 'release', { reported: 'autohire-admin:sam@example.com' }),
      /autohire-admin:sam@example.com acted for a party in this dispute/,
    )
    expect((await disputeRow(dispute)).status).toBe('open')
  })

  test('nor one who made a request on it', async () => {
    const a = await account('on')
    const deal = await funded(a)
    const dispute = await openDispute(deal)
    await h.db.query(
      `select make_dispute_offer($1, 'seller', 'autohire-admin:alex@example.com', 'update')`,
      [dispute],
    )

    await rejects(
      () => relayed(dispute, 'release', { reported: 'autohire-admin:alex@example.com' }),
      /acted for a party in this dispute/,
    )
  })

  test('nor one who answered one', async () => {
    const a = await account('on')
    const deal = await funded(a)
    const dispute = await openDispute(deal)
    const { rows: [o] } = await h.db.query<{ id: string }>(
      `select id from make_dispute_offer($1, 'seller', $2, 'update')`, [dispute, API_KEY],
    )
    await h.db.query(
      `select respond_dispute_offer($1, 'buyer', 'autohire-admin:jo@example.com', false)`,
      [o.id],
    )

    await rejects(
      () => relayed(dispute, 'release', { reported: 'autohire-admin:jo@example.com' }),
      /acted for a party in this dispute/,
    )
  })

  test('a credential that raised and argued the dispute may relay a distinct person', async () => {
    // The platform raises disputes and makes requests with the same key it
    // relays decisions with. Refusing the key for having acted would make every
    // dispute it raised unrelayable. Acceptable because the tenant opted in, and
    // the check that still binds is on the person it reported.
    const a = await account('on')
    const deal = await funded(a)
    const dispute = await openDispute(deal, { actor: API_KEY })
    const { rows: [o] } = await h.db.query<{ id: string }>(
      `select id from make_dispute_offer($1, 'seller', $2, 'update')`, [dispute, API_KEY],
    )
    await h.db.query(`select respond_dispute_offer($1, 'buyer', $2, false)`, [o.id, API_KEY])

    const row = await relayed(dispute, 'release', { reported: JANE })
    expect(row.status).toBe('resolved_released')
  })
})

describe('a retry does not move money twice', () => {
  test('the same outcome again returns the dispute unchanged', async () => {
    const a = await account('on')
    const deal = await funded(a)
    const dispute = await openDispute(deal)

    const first = await relayed(dispute, 'release')
    const ledger = await ledgerCount(deal)

    // A retried request — even one naming a different person — is the same
    // outcome, and the record stays what the first one wrote.
    const again = await relayed(dispute, 'release', { reported: 'autohire-admin:other@example.com' })

    expect(again.status).toBe('resolved_released')
    expect(again.resolved_at).toEqual(first.resolved_at)
    expect(again.reported_decider).toBe(JANE)
    expect(await ledgerCount(deal)).toBe(ledger)
    expect(await deliveries(deal, 'dispute.resolved')).toHaveLength(1)
    expect(await deliveries(deal, 'deal.dispute_resolved')).toHaveLength(1)
    expect(await resolvedAudit(deal)).toHaveLength(1)
  })

  test('a different outcome is refused as already resolved, and nothing moves', async () => {
    const a = await account('on')
    const deal = await funded(a)
    const dispute = await openDispute(deal)
    await relayed(dispute, 'release')
    const ledger = await ledgerCount(deal)

    await rejects(
      () => relayed(dispute, 'refund'),
      /^dispute_already_resolved: this dispute was already resolved as release and cannot be resolved again as refund/,
    )

    expect(await dealStatus(deal)).toBe('clearing')
    expect(await ledgerCount(deal)).toBe(ledger)
    expect(await resolvedAudit(deal)).toHaveLength(1)
  })

  test('a split is the same outcome only at the same amount', async () => {
    const a = await account('on')
    const deal = await funded(a)
    const dispute = await openDispute(deal)
    await relayed(dispute, 'partial_refund', { refund: 25_000 })
    const ledger = await ledgerCount(deal)

    expect((await relayed(dispute, 'partial_refund', { refund: 25_000 })).status)
      .toBe('resolved_split')
    await rejects(
      () => relayed(dispute, 'partial_refund', { refund: 40_000 }),
      /dispute_already_resolved/,
    )

    expect(await refunded(deal)).toBe(25_000)
    expect(await ledgerCount(deal)).toBe(ledger)
  })

  test('a dispute a person here already decided answers a relay the same way', async () => {
    const a = await account('on')
    const deal = await funded(a)
    const dispute = await openDispute(deal)
    await byPerson(dispute, 'refund')

    expect((await relayed(dispute, 'refund')).decided_by).toBe('user:dana@autohire.rw')
    await rejects(() => relayed(dispute, 'release'), /dispute_already_resolved/)
  })

  test('a person resolving a resolved dispute still gets invalid_state', async () => {
    // The dashboard path is untouched.
    const a = await account('on')
    const deal = await funded(a)
    const dispute = await openDispute(deal)
    await byPerson(dispute, 'release')

    await rejects(
      () => byPerson(dispute, 'release', 'user:someone@autohire.rw'),
      /^invalid_state: this dispute is already resolved/,
    )
  })
})

describe('dispute.opened says which dispute', () => {
  test('carries the dispute, who raised it, why and how much', async () => {
    const a = await account('unset')
    const deal = await funded(a)
    const dispute = await openDispute(deal, { amount: 30_000, code: 'damaged' })

    const [opened] = await deliveries(deal, 'dispute.opened')
    // The envelope is unchanged; only `data` gained keys.
    expect(opened.event).toBe('dispute.opened')
    expect(opened.deal_id).toBe(deal)
    expect(opened.occurred_at).toEqual(expect.any(String))
    expect(opened.data).toEqual({
      dispute_id: dispute,
      raised_by: 'buyer',
      reason: 'Scratch on the rear bumper at return',
      reason_code: 'damaged',
      disputed_amount: 30_000,
    })
  })

  test('the whole payment in dispute is a null amount, not a missing key', async () => {
    const a = await account('unset')
    const deal = await funded(a)
    await openDispute(deal)

    const [opened] = await deliveries(deal, 'dispute.opened')
    expect(opened.data).toHaveProperty('disputed_amount', null)
  })
})

describe('an AI draft cannot be approved by a key', () => {
  async function drafted(relay: Relay) {
    const a = await account(relay)
    const deal = await funded(a)
    const dispute = await openDispute(deal)
    const { rows: [s] } = await h.db.query<{ id: string }>(
      `insert into ai_suggestions
         (tenant_id, deal_id, kind, model, prompt_version, input_hash, output, cost_usd)
       values ($1, $2, 'dispute_resolution', 'claude-opus-5', 'dispute-assistant@2',
               'hash-' || gen_random_uuid(), $3::jsonb, 6)
       returning id`,
      [a.tenant, deal, JSON.stringify({ kind: 'dispute_resolution', recommendation: 'release' })],
    )
    return { deal, dispute, suggestion: s.id }
  }

  async function undecided(suggestion: string): Promise<boolean> {
    const { rows: [r] } = await h.db.query<{ decision: string | null }>(
      `select decision from ai_suggestions where id = $1`, [suggestion],
    )
    return r.decision === null
  }

  test('refused on the flag, even with the relay on', async () => {
    const { deal, dispute, suggestion } = await drafted('on')
    const before = await ledgerCount(deal)

    await rejects(
      () => h.db.query(
        `select decide_ai_suggestion($1, 'approved', 'user:grace@autohire.rw',
                                     90000, 'RWF', 10000, true)`,
        [suggestion],
      ),
      /^forbidden: /,
    )

    expect(await undecided(suggestion)).toBe(true)
    expect((await disputeRow(dispute)).status).toBe('open')
    expect(await ledgerCount(deal)).toBe(before)
  })

  test('refused on the actor, for a caller that forgot the flag', async () => {
    const { suggestion } = await drafted('on')

    await rejects(
      () => h.db.query(
        `select decide_ai_suggestion($1, 'rejected', $2)`, [suggestion, API_KEY],
      ),
      /^forbidden: /,
    )
    expect(await undecided(suggestion)).toBe(true)
  })

  test('a signed-in person still approves, and is recorded as a person', async () => {
    const { dispute, suggestion } = await drafted('unset')

    await h.db.query(
      `select decide_ai_suggestion($1, 'approved', 'user:grace@autohire.rw',
                                   90000, 'RWF', 10000)`,
      [suggestion],
    )

    expect(await disputeRow(dispute)).toMatchObject({
      status: 'resolved_released',
      decided_by: 'user:grace@autohire.rw',
      decider_source: 'person',
    })
  })
})

describe('grants and signatures', () => {
  test('recreating left exactly one of each', async () => {
    for (const fn of ['resolve_dispute', 'decide_ai_suggestion']) {
      const { rows: [c] } = await h.db.query<{ n: number }>(
        `select count(*)::int as n from pg_proc where proname = $1`, [fn],
      )
      expect(c.n, fn).toBe(1)
    }
  })

  test('nobody but the service role can call either', async () => {
    for (const fn of ['resolve_dispute', 'decide_ai_suggestion']) {
      for (const role of ['payhold_ai', 'anon', 'authenticated']) {
        const { rows: [r] } = await h.db.query<{ ok: boolean }>(
          `select bool_or(has_function_privilege($1, p.oid, 'execute')) as ok
             from pg_proc p where p.proname = $2`,
          [role, fn],
        )
        expect(r.ok, `${role} on ${fn}`).toBe(false)
      }
    }
  })
})

describe('the functions in front of it', () => {
  /** Comments stripped — the headers explain the rules at length. */
  const source = (...path: string[]) =>
    readFileSync(join(import.meta.dirname, '..', 'supabase', 'functions', ...path), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')

  const disputes = source('disputes', 'index.ts')
  const relayedPath = disputes.slice(disputes.indexOf('async function resolveRelayed'))
  const personPath = disputes.slice(
    disputes.indexOf('async function resolve('),
    disputes.indexOf('async function resolveRelayed'),
  )

  test('an API key is sent to the relayed path before anything else', () => {
    expect(personPath).toMatch(/if \(caller\.kind === 'api_key'\) return await resolveRelayed/)
  })

  test('the relayed path asks this setting before it reads the body or calls SQL', () => {
    const asks = relayedPath.indexOf('assertDisputeRelayOn(relaying)')
    expect(asks).toBeGreaterThan(-1)
    expect(relayedPath).toMatch(/dispute_decision_relay: relaying/)
    expect(asks).toBeLessThan(relayedPath.indexOf('parseRelayedResolution('))
    expect(asks).toBeLessThan(relayedPath.indexOf(`db.rpc('resolve_dispute'`))
  })

  test('it records the credential as deciding and the body\'s name as reported', () => {
    expect(relayedPath).toMatch(/p_decided_by: caller\.actor/)
    expect(relayedPath).toMatch(/p_reported_decider: body\.decided_by/)
    expect(relayedPath).toMatch(/p_via_api_key: true/)
  })

  test('the person path sends neither new argument', () => {
    expect(personPath).not.toMatch(/p_reported_decider|p_via_api_key/)
    expect(personPath).toMatch(/p_decided_by: caller\.actor/)
  })

  test('ai-decisions refuses a key before it reads or writes anything', () => {
    const ai = source('ai-decisions', 'index.ts')
    const refused = ai.indexOf('refuseApiKeyOnAiDecisions(caller)')
    expect(refused).toBeGreaterThan(-1)
    expect(refused).toBeLessThan(ai.indexOf(`req.method === 'GET'`))
    expect(refused).toBeLessThan(ai.indexOf(`db.rpc('decide_ai_suggestion'`))
  })
})
