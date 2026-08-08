/**
 * PayHold Intelligence, against a real Postgres — spec §12.
 *
 * The mirror of `payhold-dashboard/src/api/mock/ai.test.ts`, which is the
 * acceptance spec. What that suite asserts by diffing money state across every
 * AI call, this one asserts structurally: the AI role cannot reach a money
 * function, and the only thing that can is a decision with a person's name on
 * it.
 *
 * What is *not* here is the model. Nothing in these tests makes a network call
 * — the prompt assembly and the schema validation are Deno tests in
 * `functions/_shared/ai.test.ts`. This file is about the guarantees that hold
 * whatever the model says, which is the half that matters.
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { migrated, rejects, type Harness } from './harness'

let h: Harness

interface Seeded {
  tenant: string
  seller: string
  deal: string
}

async function seed(opts: { amount?: number; status?: string } = {}): Promise<Seeded> {
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
                        presentment_currency, presentment_amount, buyer_country,
                        provider, provider_ref, status, fee_amount)
     values ($1, 'buyer-1', $2, 'Excavator hire', $3, 'RWF', 'RWF', $3, 'RW',
             'fake', 'ref-' || gen_random_uuid(), $4::deal_status, $5)
     returning id`,
    [tenant.id, seller.id, amount, opts.status ?? 'funded_held', Math.round(amount * 0.1)],
  )
  return { tenant: tenant.id, seller: seller.id, deal: deal.id }
}

async function draft(
  s: Seeded,
  output: Record<string, unknown>,
  kind = 'dispute_resolution',
): Promise<string> {
  const { rows: [row] } = await h.db.query<{ id: string }>(
    `insert into ai_suggestions
       (tenant_id, deal_id, kind, model, prompt_version, input_hash, output, cost_usd)
     values ($1, $2, $3::ai_suggestion_kind, 'claude-opus-5', 'dispute-assistant@1',
             'hash-' || gen_random_uuid(), $4::jsonb, 6)
     returning id`,
    [s.tenant, s.deal, kind, JSON.stringify(output)],
  )
  return row.id
}

/** Fund the hold so a release has something to release. */
async function fund(s: Seeded, amount = 100_000): Promise<void> {
  await h.db.query(
    `insert into ledger (tenant_id, deal_id, entry_type, amount, currency, provider)
     values ($1, $2, 'hold', $3, 'RWF', 'fake')`,
    [s.tenant, s.deal, amount],
  )
}

const moneyRows = async (deal: string): Promise<number> => {
  const { rows } = await h.db.query<{ n: number }>(
    `select count(*)::int as n from ledger where deal_id = $1`,
    [deal],
  )
  return rows[0].n
}

beforeAll(async () => { h = await migrated() }, 120_000)
afterAll(async () => { await h?.close() })

// ---------------------------------------------------------------------------

describe('a suggestion moves nothing on its own', () => {
  test('writing a draft touches no ledger entry and no deal status', async () => {
    const s = await seed()
    await fund(s)
    const before = await moneyRows(s.deal)

    await draft(s, { kind: 'dispute_resolution', recommendation: 'release' })

    expect(await moneyRows(s.deal)).toBe(before)
    const { rows } = await h.db.query<{ status: string }>(
      `select status from deals where id = $1`,
      [s.deal],
    )
    expect(rows[0].status).toBe('funded_held')
  })

  test('a decision must name the person who made it', async () => {
    const s = await seed()
    const id = await draft(s, { kind: 'risk_summary' }, 'risk_summary')

    await rejects(
      () =>
        h.db.query(`select decide_ai_suggestion($1, 'approved', '')`, [id]),
      /a decision must record who made it/,
    )
  })

  test('the three decision columns move together or not at all', async () => {
    const s = await seed()
    const id = await draft(s, { kind: 'risk_summary' }, 'risk_summary')

    await rejects(
      () =>
        h.db.query(
          `update ai_suggestions set decision = 'approved' where id = $1`,
          [id],
        ),
      /ai_suggestions_decision_complete/,
    )
  })
})

describe('approving a risk summary is not a money path', () => {
  test('an approved risk summary writes the decision and nothing else', async () => {
    const s = await seed()
    await fund(s)
    const before = await moneyRows(s.deal)
    const id = await draft(s, { kind: 'risk_summary', band: 'look closely' }, 'risk_summary')

    await h.db.query(
      `select decide_ai_suggestion($1, 'approved', 'grace@autohire.rw')`,
      [id],
    )

    const { rows } = await h.db.query<{ decision: string; decided_by: string }>(
      `select decision, decided_by from ai_suggestions where id = $1`,
      [id],
    )
    expect(rows[0].decision).toBe('approved')
    expect(rows[0].decided_by).toBe('grace@autohire.rw')
    expect(await moneyRows(s.deal)).toBe(before)
  })
})

describe('approving a dispute draft', () => {
  async function disputed(): Promise<{ s: Seeded; dispute: string }> {
    const s = await seed()
    await fund(s)
    const { rows: [d] } = await h.db.query<{ id: string }>(
      `select (open_dispute($1, 'buyer', 'Never arrived')).id`,
      [s.deal],
    )
    return { s, dispute: d.id }
  }

  test('an approved release resolves the dispute and releases the money', async () => {
    const { s } = await disputed()
    const id = await draft(s, {
      kind: 'dispute_resolution',
      recommendation: 'release',
      headline: 'Release to the seller.',
    })

    await h.db.query(
      `select decide_ai_suggestion($1, 'approved', 'grace@autohire.rw', 90000, 'RWF', 10000)`,
      [id],
    )

    const { rows: [deal] } = await h.db.query<{ status: string }>(
      `select status from deals where id = $1`,
      [s.deal],
    )
    expect(deal.status).toBe('clearing')

    const { rows: [dsp] } = await h.db.query<{ status: string; note: string }>(
      `select status, resolution_note as note from disputes where deal_id = $1`,
      [s.deal],
    )
    expect(dsp.status).toBe('resolved_released')
    // The trail has to read "a person accepted this draft", not "the AI decided".
    expect(dsp.note).toContain('approved by grace@autohire.rw')
    expect(dsp.note).toContain('claude-opus-5')
  })

  test('an approved escalate executes nothing', async () => {
    const { s } = await disputed()
    const before = await moneyRows(s.deal)
    const id = await draft(s, {
      kind: 'dispute_resolution',
      recommendation: 'escalate',
      headline: 'Needs a person.',
    })

    await h.db.query(
      `select decide_ai_suggestion($1, 'approved', 'grace@autohire.rw')`,
      [id],
    )

    const { rows: [dsp] } = await h.db.query<{ status: string }>(
      `select status from disputes where deal_id = $1`,
      [s.deal],
    )
    expect(dsp.status).toBe('open')
    expect(await moneyRows(s.deal)).toBe(before)
  })

  test('a rejected release executes nothing', async () => {
    const { s } = await disputed()
    const before = await moneyRows(s.deal)
    const id = await draft(s, { kind: 'dispute_resolution', recommendation: 'release' })

    await h.db.query(
      `select decide_ai_suggestion($1, 'rejected', 'grace@autohire.rw')`,
      [id],
    )

    const { rows: [dsp] } = await h.db.query<{ status: string }>(
      `select status from disputes where deal_id = $1`,
      [s.deal],
    )
    expect(dsp.status).toBe('open')
    expect(await moneyRows(s.deal)).toBe(before)
  })

  test('the same draft cannot be approved twice', async () => {
    const { s } = await disputed()
    const id = await draft(s, { kind: 'dispute_resolution', recommendation: 'release' })

    await h.db.query(
      `select decide_ai_suggestion($1, 'approved', 'grace@autohire.rw', 90000, 'RWF', 10000)`,
      [id],
    )

    await rejects(
      () =>
        h.db.query(
          `select decide_ai_suggestion($1, 'approved', 'grace@autohire.rw', 90000, 'RWF', 10000)`,
          [id],
        ),
      /already been decided/,
    )
  })

  test('a draft whose dispute was resolved by hand refuses rather than re-resolving', async () => {
    const { s, dispute } = await disputed()
    const id = await draft(s, { kind: 'dispute_resolution', recommendation: 'release' })

    await h.db.query(
      `select resolve_dispute($1, 'release', 'Sorted on the phone', 90000, 'RWF', 10000, null, 'ops@payhold.test')`,
      [dispute],
    )

    await rejects(
      () =>
        h.db.query(
          `select decide_ai_suggestion($1, 'approved', 'grace@autohire.rw', 90000, 'RWF', 10000)`,
          [id],
        ),
      /resolved while the draft was open/,
    )
  })

  test('every decision is audited against the person, not the model', async () => {
    const { s } = await disputed()
    const id = await draft(s, { kind: 'dispute_resolution', recommendation: 'escalate' })

    await h.db.query(
      `select decide_ai_suggestion($1, 'rejected', 'grace@autohire.rw')`,
      [id],
    )

    const { rows } = await h.db.query<{ actor: string; action: string }>(
      `select actor, action from audit_log
        where deal_id = $1 and action like 'ai.suggestion_%'`,
      [s.deal],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].actor).toBe('grace@autohire.rw')
    expect(rows[0].action).toBe('ai.suggestion_rejected')
  })
})

// ---------------------------------------------------------------------------

describe('the AI role cannot reach a money function', () => {
  const MONEY = [
    'release_deal',
    'refund_deal',
    'confirm_deal',
    'settle_payout',
    'capture_deposit',
    'release_deposit',
    'resolve_dispute',
    'decide_ai_suggestion',
    'approve_payout_review',
  ]

  test.each(MONEY)('payhold_ai holds no execute on %s', async (fn) => {
    const { rows } = await h.db.query<{ allowed: boolean }>(
      `select bool_or(has_function_privilege('payhold_ai', p.oid, 'execute')) as allowed
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = $1`,
      [fn],
    )
    expect(rows[0].allowed).toBe(false)
  })

  test('payhold_ai cannot read an api key hash or a provider credential', async () => {
    for (const table of ['api_keys', 'tenant_provider_accounts', 'webhook_endpoints']) {
      const { rows } = await h.db.query<{ allowed: boolean }>(
        `select has_table_privilege('payhold_ai', $1, 'select') as allowed`,
        [table],
      )
      expect(rows[0].allowed, table).toBe(false)
    }
  })

  test('payhold_ai can insert a suggestion and cannot update or delete one', async () => {
    const { rows } = await h.db.query<{
      ins: boolean
      upd: boolean
      del: boolean
    }>(
      `select has_table_privilege('payhold_ai', 'ai_suggestions', 'insert') as ins,
              has_table_privilege('payhold_ai', 'ai_suggestions', 'update') as upd,
              has_table_privilege('payhold_ai', 'ai_suggestions', 'delete') as del`,
    )
    expect(rows[0]).toEqual({ ins: true, upd: false, del: false })
  })

  test('payhold_ai cannot write to deals or the ledger', async () => {
    for (const table of ['deals', 'ledger', 'payouts', 'disputes']) {
      const { rows } = await h.db.query<{ allowed: boolean }>(
        `select has_table_privilege('payhold_ai', $1, 'insert') or
                has_table_privilege('payhold_ai', $1, 'update') or
                has_table_privilege('payhold_ai', $1, 'delete') as allowed`,
        [table],
      )
      expect(rows[0].allowed, table).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------

describe('outcome labels are written from the money path', () => {
  test('both sides confirming labels the deal released_clean', async () => {
    const s = await seed()
    await fund(s)
    await h.db.query(
      `select confirm_deal($1, 'buyer', 'user', 90000, 'RWF', 10000)`,
      [s.deal],
    )
    await h.db.query(
      `select confirm_deal($1, 'seller', 'user', 90000, 'RWF', 10000)`,
      [s.deal],
    )

    const { rows } = await h.db.query<{ outcome: string; reason_code: string }>(
      `select outcome, reason_code from deal_outcomes where deal_id = $1`,
      [s.deal],
    )
    expect(rows[0]).toEqual({ outcome: 'released_clean', reason_code: 'both_confirmed' })
  })

  test('the timer confirming for a silent party labels it auto_released', async () => {
    const s = await seed()
    await fund(s)
    await h.db.query(
      `select confirm_deal($1, 'buyer', 'user', 90000, 'RWF', 10000)`,
      [s.deal],
    )
    await h.db.query(
      `select confirm_deal($1, 'seller', 'auto', 90000, 'RWF', 10000)`,
      [s.deal],
    )

    const { rows } = await h.db.query<{ outcome: string; reason_code: string }>(
      `select outcome, reason_code from deal_outcomes where deal_id = $1`,
      [s.deal],
    )
    expect(rows[0]).toEqual({ outcome: 'auto_released', reason_code: 'timer_fired' })
  })

  test('a client refund is labelled refunded', async () => {
    const s = await seed()
    await fund(s)
    await h.db.query(`select refund_deal($1, 'Buyer cancelled', 'dashboard')`, [s.deal])

    const { rows } = await h.db.query<{ outcome: string }>(
      `select outcome from deal_outcomes where deal_id = $1`,
      [s.deal],
    )
    expect(rows[0].outcome).toBe('refunded')
  })

  test('a resolved dispute is labelled with which way it went, and by whom it was raised', async () => {
    const s = await seed()
    await fund(s)
    const { rows: [d] } = await h.db.query<{ id: string }>(
      `select (open_dispute($1, 'seller', 'Buyer will not confirm')).id`,
      [s.deal],
    )
    await h.db.query(
      `select resolve_dispute($1, 'refund', 'Photos back the buyer', 90000, 'RWF', 10000, null, 'ops@payhold.test')`,
      [d.id],
    )

    const { rows } = await h.db.query<{
      outcome: string
      reason_code: string
      notes: string
      amount_disputed: string
    }>(
      `select outcome, reason_code, notes, amount_disputed
         from deal_outcomes where deal_id = $1`,
      [s.deal],
    )
    expect(rows[0].outcome).toBe('dispute_refunded')
    expect(rows[0].reason_code).toBe('dispute_seller_raised')
    expect(rows[0].notes).toBe('Photos back the buyer')
    expect(Number(rows[0].amount_disputed)).toBe(100_000)
  })

  test('a deal ends once — a label is never overwritten by a later transition', async () => {
    const s = await seed()
    await fund(s)
    await h.db.query(
      `select confirm_deal($1, 'buyer', 'user', 90000, 'RWF', 10000)`,
      [s.deal],
    )
    await h.db.query(
      `select confirm_deal($1, 'seller', 'user', 90000, 'RWF', 10000)`,
      [s.deal],
    )
    // Through the legal path rather than a jump: the transition guard added in
    // `20260807000002_lifecycle.sql` refuses `clearing -> paid_out`, and the
    // point of this test is what happens to the label on the *later* change.
    await h.db.query(`update deals set status = 'released' where id = $1`, [s.deal])
    await h.db.query(`update deals set status = 'paid_out' where id = $1`, [s.deal])

    const { rows } = await h.db.query<{ n: number; outcome: string }>(
      `select count(*)::int as n, min(outcome::text) as outcome
         from deal_outcomes where deal_id = $1`,
      [s.deal],
    )
    expect(rows[0].n).toBe(1)
    expect(rows[0].outcome).toBe('released_clean')
  })

  test('labels are written whether or not a model was ever involved', async () => {
    const s = await seed()
    await fund(s)
    await h.db.query(`select refund_deal($1, 'Changed their mind', 'dashboard')`, [s.deal])

    const { rows: suggestions } = await h.db.query<{ n: number }>(
      `select count(*)::int as n from ai_suggestions where deal_id = $1`,
      [s.deal],
    )
    const { rows: outcomes } = await h.db.query<{ n: number }>(
      `select count(*)::int as n from deal_outcomes where deal_id = $1`,
      [s.deal],
    )

    // The point of §12.4: a training set of only AI-assisted cases is biased
    // from its first row.
    expect(suggestions[0].n).toBe(0)
    expect(outcomes[0].n).toBe(1)
  })
})

// ---------------------------------------------------------------------------

describe('spend', () => {
  test('the monthly figure counts drafts and chat together', async () => {
    const s = await seed()
    await draft(s, { kind: 'risk_summary' }, 'risk_summary')
    await h.db.query(
      `insert into ai_chat (tenant_id, role, text, cost_usd)
       values ($1, 'assistant', 'Held means the money is with the provider.', 2)`,
      [s.tenant],
    )

    const { rows } = await h.db.query<{ spend: string }>(
      `select ai_monthly_spend($1) as spend`,
      [s.tenant],
    )
    expect(Number(rows[0].spend)).toBe(8)
  })

  test('last month does not count against this month', async () => {
    const s = await seed()
    await h.db.query(
      `insert into ai_suggestions
         (tenant_id, deal_id, kind, model, prompt_version, input_hash, output,
          cost_usd, created_at)
       values ($1, $2, 'risk_summary', 'claude-opus-5', 'risk-narrator@1', 'h', '{}',
               500, date_trunc('month', now()) - interval '2 days')`,
      [s.tenant, s.deal],
    )

    const { rows } = await h.db.query<{ spend: string }>(
      `select ai_monthly_spend($1) as spend`,
      [s.tenant],
    )
    expect(Number(rows[0].spend)).toBe(0)
  })

  test('spend is one tenant\'s own', async () => {
    const mine = await seed()
    const theirs = await seed()
    await draft(theirs, { kind: 'risk_summary' }, 'risk_summary')

    const { rows } = await h.db.query<{ spend: string }>(
      `select ai_monthly_spend($1) as spend`,
      [mine.tenant],
    )
    expect(Number(rows[0].spend)).toBe(0)
  })
})
