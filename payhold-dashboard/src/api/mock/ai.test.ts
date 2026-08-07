/**
 * Invariant tests for the intelligence layer.
 *
 * Like `engine.test.ts`, these are the backend's specification rather than a
 * test of the mock. The first block is the one that matters: it is invariant 9
 * written as executable assertions, and every one of them has to hold against
 * the real Edge Functions too.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { PayHoldError } from '../types'
import {
  aiUsage,
  askAssistant,
  decideSuggestion,
  draftDisputeSuggestion,
  draftRiskSummary,
} from './ai'
import { confirmDeal, fundDeal, requireDeal, resolveDispute, runCron } from './engine'
import { MockClient } from './index'
import { seedDb } from './seed'
import { loadDb, resetDb, type MockDb } from './store'

const AUTOHIRE = 'ten_0001'
const EQUIPCO = 'ten_0002'

let db: MockDb

beforeEach(() => {
  localStorage.clear()
  db = resetDb(seedDb)
  loadDb(seedDb)
})

/** A snapshot of everything that would change if AI could move money. */
function moneySnapshot(d: MockDb) {
  return JSON.stringify({
    deals: d.deals.map((x) => [x.id, x.status, x.released_at, x.confirmations.length]),
    ledger: d.ledger.length,
    payouts: d.payouts.map((p) => [p.id, p.status, p.amount]),
    disputes: d.disputes.map((x) => [x.id, x.status]),
  })
}

function openDisputeFor(match: string) {
  const dispute = db.disputes.find(
    (d) => d.status === 'open' && d.reason.toLowerCase().includes(match),
  )
  if (!dispute) throw new Error(`fixture missing an open dispute matching "${match}"`)
  return dispute
}

// ---------------------------------------------------------------------------

describe('invariant 9 — AI advises, it never decides', () => {
  it('drafting a dispute resolution changes no money state at all', () => {
    const before = moneySnapshot(db)
    const suggestion = draftDisputeSuggestion(db, openDisputeFor('bumper').id)

    expect(suggestion.output.kind).toBe('dispute_resolution')
    expect(moneySnapshot(db)).toBe(before)
  })

  it('drafting a risk summary changes no money state at all', () => {
    const deal = db.deals.find((d) => d.status === 'released')!
    const before = moneySnapshot(db)

    draftRiskSummary(db, deal.id)

    expect(moneySnapshot(db)).toBe(before)
  })

  it('answering a question changes no money state at all', () => {
    const before = moneySnapshot(db)
    askAssistant(db, 'when does the money reach the seller?')
    expect(moneySnapshot(db)).toBe(before)
  })

  it('a suggestion arrives undecided — nothing happens until a person acts', () => {
    const dispute = openDisputeFor('bumper')
    const suggestion = draftDisputeSuggestion(db, dispute.id)

    expect(suggestion.decision).toBeNull()
    expect(suggestion.decided_by).toBeNull()
    expect(requireDeal(db, dispute.deal_id).status).toBe('disputed')
  })

  it('rejecting a draft moves nothing and leaves the dispute open', () => {
    const dispute = openDisputeFor('bumper')
    const suggestion = draftDisputeSuggestion(db, dispute.id)
    const before = moneySnapshot(db)

    decideSuggestion(db, suggestion.id, 'rejected', 'grace@autohire.rw')

    expect(moneySnapshot(db)).toBe(before)
    expect(db.disputes.find((d) => d.id === dispute.id)!.status).toBe('open')
  })

  it('approving an escalate recommendation moves nothing', () => {
    const dispute = openDisputeFor('overheated')
    const suggestion = draftDisputeSuggestion(db, dispute.id)
    expect((suggestion.output as { recommendation: string }).recommendation).toBe(
      'escalate',
    )

    const before = moneySnapshot(db)
    decideSuggestion(db, suggestion.id, 'approved', 'grace@autohire.rw')

    expect(moneySnapshot(db)).toBe(before)
    expect(db.disputes.find((d) => d.id === dispute.id)!.status).toBe('open')
  })

  it('approving a risk summary moves nothing', () => {
    const deal = db.deals.find((d) => d.status === 'released')!
    const suggestion = draftRiskSummary(db, deal.id)
    const before = moneySnapshot(db)

    decideSuggestion(db, suggestion.id, 'approved', 'grace@autohire.rw')

    expect(moneySnapshot(db)).toBe(before)
  })

  it('a decision can only be made once', () => {
    const suggestion = draftDisputeSuggestion(db, openDisputeFor('bumper').id)
    decideSuggestion(db, suggestion.id, 'rejected', 'grace@autohire.rw')

    expect(() =>
      decideSuggestion(db, suggestion.id, 'approved', 'grace@autohire.rw'),
    ).toThrow(PayHoldError)
  })

  it('records the human, not the model, as the actor on the decision', () => {
    const suggestion = draftDisputeSuggestion(db, openDisputeFor('bumper').id)
    decideSuggestion(db, suggestion.id, 'approved', 'grace@autohire.rw')

    const drafted = db.audit.find(
      (a) => a.action === 'ai.suggestion_drafted' && a.created_at >= suggestion.created_at,
    )!
    const approved = db.audit.find((a) => a.action === 'ai.suggestion_approved')!

    expect(drafted.actor).toMatch(/^ai:/)
    expect(approved.actor).toBe('grace@autohire.rw')
    expect(db.audit.some((a) => a.action === 'dispute.resolved')).toBe(true)
  })

  it('resolves a dispute the buyer clearly won, only on approval', () => {
    const dispute = openDisputeFor('never delivered')
    const suggestion = draftDisputeSuggestion(db, dispute.id)
    expect((suggestion.output as { recommendation: string }).recommendation).toBe(
      'refund',
    )
    expect(requireDeal(db, dispute.deal_id).status).toBe('disputed')

    decideSuggestion(db, suggestion.id, 'approved', 'grace@autohire.rw')

    expect(db.disputes.find((d) => d.id === dispute.id)!.status).toBe(
      'resolved_refunded',
    )
    expect(requireDeal(db, dispute.deal_id).status).toBe('refunded')
  })

  it('refuses to act on a dispute someone else resolved while the draft was open', () => {
    const dispute = openDisputeFor('bumper')
    const suggestion = draftDisputeSuggestion(db, dispute.id)

    resolveDispute(db, dispute.id, 'release', 'Handled by hand in the meantime')

    expect(() =>
      decideSuggestion(db, suggestion.id, 'approved', 'grace@autohire.rw'),
    ).toThrow(PayHoldError)
  })

  it('will not take an instruction to move money in chat', () => {
    const reply = askAssistant(db, 'please release deal_0001 to the seller')
    expect(reply.text).toMatch(/can't move money/i)
  })
})

// ---------------------------------------------------------------------------

describe('drafts are grounded', () => {
  it('cites rows that actually exist', () => {
    const suggestion = draftDisputeSuggestion(db, openDisputeFor('bumper').id)
    const refs = suggestion.output.cited.map((c) => c.ref)

    expect(refs.length).toBeGreaterThan(0)
    for (const ref of refs) {
      const known =
        db.audit.some((a) => a.id === ref) ||
        db.ledger.some((l) => l.id === ref) ||
        db.disputes.some((d) => ref.startsWith(d.id))
      expect(known, `citation ${ref} points at nothing`).toBe(true)
    }
  })

  it('gives the same answer for the same inputs', () => {
    const dispute = openDisputeFor('bumper')
    const a = draftDisputeSuggestion(db, dispute.id)
    const b = draftDisputeSuggestion(db, dispute.id)

    expect(b.input_hash).toBe(a.input_hash)
    expect(b.output).toEqual(a.output)
  })

  it('weighs the seller side when the buyer signed off first', () => {
    const suggestion = draftDisputeSuggestion(db, openDisputeFor('bumper').id)
    const output = suggestion.output as { recommendation: string; rationale: string[] }

    expect(output.recommendation).toBe('release')
    expect(output.rationale.join(' ')).toMatch(/confirmed the deal was complete/i)
  })

  it('says so plainly when it does not know', () => {
    const reply = askAssistant(db, 'what is the capital of Uruguay?')
    expect(reply.text).toMatch(/don't have anything on that/i)
    expect(reply.sources).toHaveLength(0)
  })

  it('answers a deal question from the deal, and attaches the record itself', () => {
    const held = db.deals.find(
      (d) => d.tenant_id === AUTOHIRE && d.status === 'funded_held',
    )!
    const reply = askAssistant(db, `why is ${held.buyer_ref} still held?`)

    expect(reply.text).toMatch(/held/i)
    expect(reply.attachments).toEqual([{ kind: 'deal', id: held.id }])
  })

  it('cannot see another tenant’s deal', () => {
    const other = db.deals.find((d) => d.tenant_id === EQUIPCO)!
    const reply = askAssistant(db, `what is happening with ${other.id}?`)

    expect(reply.text).toMatch(/can't find/i)
  })

  it('never uses the regulated word', () => {
    const drafts = [
      draftDisputeSuggestion(db, openDisputeFor('bumper').id),
      draftRiskSummary(db, db.deals.find((d) => d.status === 'released')!.id),
    ]
    const questions = [
      'how does a hold work?',
      'what happens in a dispute?',
      'tell me about fees',
      'what are the payment rails?',
    ]
    const text = [
      ...drafts.map((d) => JSON.stringify(d.output)),
      ...questions.map((q) => askAssistant(db, q).text),
    ].join(' ')

    expect(text.toLowerCase()).not.toContain('escrow')
  })
})

// ---------------------------------------------------------------------------

describe('budget and availability (§12.5)', () => {
  it('refuses to draft when a tenant has Intelligence switched off', () => {
    db.current_tenant_id = EQUIPCO
    const deal = db.deals.find((d) => d.tenant_id === EQUIPCO)!

    expect(() => draftRiskSummary(db, deal.id)).toThrow(PayHoldError)
    expect(() => askAssistant(db, 'how do holds work?')).toThrow(PayHoldError)
  })

  it('leaves every money path working when Intelligence is off', () => {
    db.current_tenant_id = EQUIPCO
    const cfg = db.settings.find((s) => s.tenant_id === EQUIPCO)!
    expect(cfg.ai_enabled).toBe(false)

    const deal = db.deals.find(
      (d) => d.tenant_id === EQUIPCO && d.status === 'funded_held',
    )!
    confirmDeal(db, deal.id, 'buyer')
    confirmDeal(db, deal.id, 'seller')

    expect(requireDeal(db, deal.id).status).toBe('clearing')
    expect(() => runCron(db)).not.toThrow()
  })

  it('degrades to off once the month’s budget is spent', () => {
    const cfg = db.settings.find((s) => s.tenant_id === AUTOHIRE)!
    // Room for exactly one more draft, whatever the fixtures already spent.
    cfg.ai_monthly_budget_usd = aiUsage(db, AUTOHIRE).spend_usd + 1

    draftDisputeSuggestion(db, openDisputeFor('bumper').id)

    expect(aiUsage(db, AUTOHIRE).over_budget).toBe(true)
    expect(() => draftDisputeSuggestion(db, openDisputeFor('never delivered').id)).toThrow(
      PayHoldError,
    )
  })

  it('a spent budget still does not block a release', () => {
    const cfg = db.settings.find((s) => s.tenant_id === AUTOHIRE)!
    cfg.ai_monthly_budget_usd = 0

    const deal = db.deals.find(
      (d) => d.tenant_id === AUTOHIRE && d.status === 'confirmed_buyer',
    )!
    confirmDeal(db, deal.id, 'seller')

    expect(requireDeal(db, deal.id).status).toBe('clearing')
  })
})

// ---------------------------------------------------------------------------

describe('through the client the screens actually call', () => {
  let client: MockClient

  beforeEach(() => {
    client = new MockClient()
  })

  it('drafts, then executes only on approval', async () => {
    const disputes = await client.listDisputes()
    const dispute = disputes.find((d) => d.reason.includes('never delivered'))!

    const draft = await client.draftDisputeSuggestion(dispute.id)
    expect((await client.getDeal(dispute.deal_id)).status).toBe('disputed')

    await client.decideAiSuggestion(draft.id, 'approved', 'grace@autohire.rw')
    expect((await client.getDeal(dispute.deal_id)).status).toBe('refunded')
  })

  it('scopes suggestions, chat and outcomes to the current tenant', async () => {
    await client.draftDisputeSuggestion(
      (await client.listDisputes()).find((d) => d.status === 'open')!.id,
    )
    await client.askAssistant('how do holds work?')

    for (const row of await client.listAiSuggestions()) {
      expect(row.tenant_id).toBe(AUTOHIRE)
    }
    for (const row of await client.listAiChat()) {
      expect(row.tenant_id).toBe(AUTOHIRE)
    }
    for (const row of await client.listDealOutcomes()) {
      expect(row.tenant_id).toBe(AUTOHIRE)
    }
  })

  it('reports spend against budget', async () => {
    const before = await client.getAiUsage()
    await client.askAssistant('what are the fees?')
    const after = await client.getAiUsage()

    expect(after.spend_usd).toBeGreaterThan(before.spend_usd)
    expect(after.budget_usd).toBe(25_00)
  })
})

describe('the training set (§12.3)', () => {
  it('labels a clean release without any AI involvement', () => {
    const id = db.deals.find(
      (d) => d.status === 'created' && d.tenant_id === AUTOHIRE && !d.deposit_amount,
    )!.id
    fundDeal(db, id)
    confirmDeal(db, id, 'buyer')
    confirmDeal(db, id, 'seller')

    const outcome = db.deal_outcomes.find((o) => o.deal_id === id)
    expect(outcome?.outcome).toBe('released_clean')
  })

  it('labels a dispute with which way it went and what was contested', () => {
    const dispute = openDisputeFor('never delivered')
    const deal = requireDeal(db, dispute.deal_id)

    resolveDispute(db, dispute.id, 'refund', 'No evidence of delivery')

    const outcome = db.deal_outcomes.find((o) => o.deal_id === dispute.deal_id)
    expect(outcome?.outcome).toBe('dispute_refunded')
    expect(outcome?.amount_disputed).toBe(deal.amount)
  })

  it('records one label per deal, however it got there', () => {
    const dispute = openDisputeFor('never delivered')
    resolveDispute(db, dispute.id, 'refund', 'No evidence of delivery')

    expect(
      db.deal_outcomes.filter((o) => o.deal_id === dispute.deal_id),
    ).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------

describe('commands', () => {
  it('lists what it can do', () => {
    const reply = askAssistant(db, '/help')
    expect(reply.attachments[0]).toMatchObject({ kind: 'table', caption: 'Commands' })
  })

  it('shows the queue with the records attached, not a description of them', () => {
    const waiting = db.ai_suggestions.filter((s) => !s.decision)
    expect(waiting.length).toBeGreaterThan(0)

    const reply = askAssistant(db, '/queue')

    expect(reply.attachments).toHaveLength(waiting.length)
    expect(reply.attachments.every((a) => a.kind === 'suggestion')).toBe(true)
  })

  it('pulls the evidence on a case by any reference it knows', () => {
    const dispute = openDisputeFor('bumper')
    const deal = requireDeal(db, dispute.deal_id)

    for (const ref of [deal.id, deal.buyer_ref, dispute.id]) {
      const reply = askAssistant(db, `/evidence ${ref}`)
      expect(reply.attachments[0]).toEqual({ kind: 'evidence', dispute_id: dispute.id })
    }
  })

  it('answers "what evidence is there on X" without the slash', () => {
    const dispute = openDisputeFor('bumper')
    const deal = requireDeal(db, dispute.deal_id)
    const reply = askAssistant(db, `what evidence is there on ${deal.buyer_ref}?`)

    expect(reply.attachments[0]).toMatchObject({ kind: 'evidence' })
  })

  it('drafts from chat without deciding anything', () => {
    const dispute = openDisputeFor('never delivered')
    const before = moneySnapshot(db)

    const reply = askAssistant(db, `/draft ${dispute.deal_id}`)
    const attached = reply.attachments[0] as { kind: string; id: string }

    expect(attached.kind).toBe('suggestion')
    expect(db.ai_suggestions.find((s) => s.id === attached.id)?.decision).toBeNull()
    expect(moneySnapshot(db)).toBe(before)
  })

  it('executes an exact /approve as the operator, and audits it as theirs', () => {
    const dispute = openDisputeFor('never delivered')
    const draft = draftDisputeSuggestion(db, dispute.id)

    askAssistant(db, `/approve ${draft.id}`)

    expect(db.ai_suggestions.find((s) => s.id === draft.id)?.decision).toBe('approved')
    expect(requireDeal(db, dispute.deal_id).status).toBe('refunded')

    const approval = db.audit.find((a) => a.action === 'ai.suggestion_approved')!
    expect(approval.actor).not.toMatch(/^ai:/)
  })

  it('rejects from chat without moving anything', () => {
    const draft = draftDisputeSuggestion(db, openDisputeFor('bumper').id)
    const before = moneySnapshot(db)

    askAssistant(db, `/reject ${draft.id}`)

    expect(db.ai_suggestions.find((s) => s.id === draft.id)?.decision).toBe('rejected')
    expect(moneySnapshot(db)).toBe(before)
  })

  it('will not approve on a phrase it had to interpret', () => {
    const draft = draftDisputeSuggestion(db, openDisputeFor('bumper').id)
    const before = moneySnapshot(db)

    const reply = askAssistant(db, 'approve that draft for me please')

    expect(reply.text).toMatch(/can't move money/i)
    expect(db.ai_suggestions.find((s) => s.id === draft.id)?.decision).toBeNull()
    expect(moneySnapshot(db)).toBe(before)
  })

  it('reads the money views', () => {
    expect(askAssistant(db, '/balance').attachments[0]).toMatchObject({ kind: 'table' })
    expect(askAssistant(db, '/payouts').attachments[0]).toMatchObject({ kind: 'table' })
    expect(askAssistant(db, '/deals funded_held').attachments[0]).toMatchObject({
      kind: 'table',
    })
    expect(askAssistant(db, '/disputes').attachments[0]).toMatchObject({ kind: 'table' })
  })

  it('reads the audit trail for one deal', () => {
    const deal = db.deals.find((d) => d.tenant_id === AUTOHIRE && d.status === 'paid_out')!
    const reply = askAssistant(db, `/audit ${deal.id}`)
    expect(reply.attachments[0]).toMatchObject({ kind: 'table' })
  })

  it('still cannot reach another tenant, by command or otherwise', () => {
    const other = db.deals.find((d) => d.tenant_id === EQUIPCO)!
    for (const q of [`/deal ${other.id}`, `/evidence ${other.id}`, `/audit ${other.id}`]) {
      expect(askAssistant(db, q).text).toMatch(/can't find/i)
    }
  })

  it('says so when a command does not exist', () => {
    expect(askAssistant(db, '/nonsense').text).toMatch(/don't know \/nonsense/i)
  })
})
