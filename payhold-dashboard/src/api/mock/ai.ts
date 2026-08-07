/**
 * PayHold Intelligence, mocked — the AI equivalent of `FakeProvider`.
 *
 * Spec §12 requires demo mode with zero keys to work end to end, and that
 * includes the assistant. So this file is a deterministic stand-in for the
 * model: same inputs, same draft, no network, no API key. When the real Edge
 * Function exists it calls Claude with the same *inputs* assembled here and
 * returns the same *shapes* — the screens do not change.
 *
 * Two things it is careful to be, because they are the parts worth getting
 * right long before a real model is wired in:
 *
 *   1. **Grounded.** Every rationale line comes from a row that exists, and
 *      cites it. A draft that cannot cite is a draft that cannot be checked.
 *   2. **Powerless.** Nothing here writes to a deal, the ledger, or a payout.
 *      The only export that ends in money moving is `decideSuggestion`, and
 *      only when a person passes `approved` — see the note there.
 */

import {
  PayHoldError,
  type AiChatAttachment,
  type AiChatMessage,
  type AiDecision,
  type AiSuggestion,
  type AiUsage,
  type CitedEvent,
  type Deal,
  type Dispute,
  type DisputeRecommendation,
  type DisputeSuggestionOutput,
  type RiskSummaryOutput,
  type Seller,
} from '../types'
import { formatMoney } from '@/lib/format'
import { computeBalances, requireDeal, resolveDispute, settingsFor } from './engine'
import { nextId, now, nowIso, type MockDb } from './store'

/**
 * The model we point at. Held here as a constant rather than inlined so the
 * upgrade in §11.9 is a one-line diff with a version bump beside it.
 */
const MODEL = 'claude-opus-5'

const PROMPT_VERSION = {
  dispute: 'dispute-assistant@3',
  risk: 'risk-narrator@2',
  chat: 'support-assistant@4',
} as const

/**
 * What a call costs, USD minor units. Real figures for a few thousand tokens
 * of deal history — small next to a deal's service fee, which is the whole
 * economic argument for the day-one features.
 */
const COST = { dispute: 6, risk: 3, chat: 1 } as const

// ---------------------------------------------------------------------------
// Budget and availability
// ---------------------------------------------------------------------------

function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}`
}

export function aiUsage(db: MockDb, tenantId: string): AiUsage {
  const cfg = settingsFor(db, tenantId)
  const thisMonth = monthKey(now())

  const mine = db.ai_suggestions.filter((s) => s.tenant_id === tenantId)
  const recent = mine.filter((s) => monthKey(new Date(s.created_at)) === thisMonth)
  const chat = db.ai_chat.filter(
    (m) =>
      m.tenant_id === tenantId &&
      m.role === 'assistant' &&
      monthKey(new Date(m.created_at)) === thisMonth,
  )

  const spend =
    recent.reduce((sum, s) => sum + s.cost_usd, 0) + chat.length * COST.chat

  return {
    enabled: cfg.ai_enabled,
    spend_usd: spend,
    budget_usd: cfg.ai_monthly_budget_usd,
    over_budget: spend >= cfg.ai_monthly_budget_usd,
    suggestions_this_month: recent.length,
    labelled_outcomes: db.deal_outcomes.filter((o) => o.tenant_id === tenantId).length,
  }
}

/**
 * The degrade path of §12.5. Note what it does *not* do: it refuses the AI
 * call and nothing else. No money path consults this function, so a tenant
 * with AI switched off — or one that has burned its budget — releases,
 * refunds and pays out exactly as before.
 */
export function assertAiAvailable(db: MockDb, tenantId: string): void {
  const usage = aiUsage(db, tenantId)
  if (!usage.enabled) {
    throw new PayHoldError(
      'policy_violation',
      'Intelligence is switched off for this company. Money paths are unaffected.',
    )
  }
  if (usage.over_budget) {
    throw new PayHoldError(
      'policy_violation',
      "This month's AI budget is spent. Drafts resume next month, or raise the budget in Settings. Money paths are unaffected.",
    )
  }
}

// ---------------------------------------------------------------------------
// Input hashing — a decision you cannot reproduce is not auditable
// ---------------------------------------------------------------------------

/** FNV-1a. Short, stable, and not pretending to be a security primitive. */
function hashInput(payload: unknown): string {
  const text = JSON.stringify(payload)
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `sha_${h.toString(16).padStart(8, '0')}`
}

// ---------------------------------------------------------------------------
// Shared lookups
// ---------------------------------------------------------------------------

function sellerFor(db: MockDb, deal: Deal): Seller | undefined {
  return db.sellers.find((s) => s.id === deal.seller_id)
}

function auditFor(db: MockDb, dealId: string) {
  return db.audit
    .filter((a) => a.deal_id === dealId)
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
}

function cite(ref: string, at: string, label: string): CitedEvent {
  return { ref, at, label }
}

function daysBetween(a: string, b: string): number {
  return (new Date(b).getTime() - new Date(a).getTime()) / 86_400_000
}

// ---------------------------------------------------------------------------
// Dispute assistant
// ---------------------------------------------------------------------------

interface Factor {
  toward: 'release' | 'refund'
  weight: number
  line: string
  cite?: CitedEvent
}

const NON_DELIVERY = /never (arrived|delivered|showed)|not delivered|no[- ]show/i

/**
 * Weigh what the two sides submitted.
 *
 * Deliberately legible: each factor is one readable sentence with the row it
 * came from, and the recommendation is their sum. A real model reasons better
 * than this, but it has to produce the same *shape* of answer — a position, the
 * factors behind it, and a citation per factor — or an admin cannot check it.
 */
function weighDispute(db: MockDb, deal: Deal, dispute: Dispute): Factor[] {
  const factors: Factor[] = []
  const rows = auditFor(db, deal.id)
  const seller = sellerFor(db, deal)

  const buyerConfirmed = deal.confirmations.find((c) => c.side === 'buyer')
  if (buyerConfirmed && buyerConfirmed.confirmed_at < dispute.opened_at) {
    const row = rows.find((r) => r.action === 'deal.confirmed_buyer')
    factors.push({
      toward: 'release',
      weight: 3,
      line: 'The buyer confirmed the deal was complete before this dispute was opened.',
      cite: row && cite(row.id, row.created_at, 'Buyer confirmed completion'),
    })
  }

  const claimsNonDelivery = NON_DELIVERY.test(dispute.reason)
  const sellerEvidence = dispute.evidence.filter((e) => e.side === 'seller')
  const buyerEvidence = dispute.evidence.filter((e) => e.side === 'buyer')

  if (claimsNonDelivery && dispute.raised_by === 'buyer') {
    const unanswered = sellerEvidence.length === 0 && !dispute.counter_statement
    factors.push({
      toward: 'refund',
      weight: unanswered ? 4 : 1.5,
      line: unanswered
        ? 'The buyer says the vehicle never arrived and the seller has submitted nothing to the contrary.'
        : 'The buyer says the vehicle never arrived, but the seller has answered with their own account.',
    })
  }

  for (const [side, items] of [
    ['seller', sellerEvidence],
    ['buyer', buyerEvidence],
  ] as const) {
    const first = items[0]
    if (!first) continue
    const toward = side === 'seller' ? 'release' : 'refund'
    // Cite the audit row the submission wrote, not a synthetic reference —
    // a citation an admin cannot look up is decoration.
    const row = rows.find(
      (r) => r.action === 'dispute.evidence_submitted' && r.actor === `user:${side}`,
    )
    factors.push({
      toward,
      weight: Math.min(3, items.length * 1.5),
      line: `The ${side} submitted ${items.length} piece${items.length > 1 ? 's' : ''} of evidence: ${items
        .map((e) => e.description)
        .join('; ')}.`,
      cite: cite(
        row?.id ?? `${dispute.id}#evidence.${side}`,
        row?.created_at ?? first.submitted_at,
        `${side === 'seller' ? 'Seller' : 'Buyer'} evidence submitted`,
      ),
    })
  }

  if (dispute.counter_statement) {
    const other = dispute.raised_by === 'buyer' ? 'seller' : 'buyer'
    factors.push({
      toward: other === 'seller' ? 'release' : 'refund',
      weight: 1,
      line: `The ${other} answered rather than staying silent, which is worth something on its own.`,
    })
  }

  // The seller's own record across this tenant.
  if (seller) {
    const theirDeals = db.deals.filter(
      (d) => d.seller_id === seller.id && d.tenant_id === deal.tenant_id,
    )
    const completed = theirDeals.filter((d) => d.status === 'paid_out').length
    const priors = db.disputes.filter(
      (d) =>
        d.id !== dispute.id &&
        theirDeals.some((td) => td.id === d.deal_id) &&
        d.status !== 'open',
    )
    const againstSeller = priors.filter((d) => d.status === 'resolved_refunded')

    if (againstSeller.length > 0) {
      factors.push({
        toward: 'refund',
        weight: 2,
        line: `${seller.name} has ${againstSeller.length} prior dispute${againstSeller.length > 1 ? 's' : ''} resolved in the buyer's favour.`,
      })
    } else if (completed >= 3) {
      factors.push({
        toward: 'release',
        weight: 1.5,
        line: `${seller.name} has ${completed} completed deals and no dispute resolved against them.`,
      })
    }
  }

  // A claim raised long after the job should have finished is a weaker claim.
  if (deal.expected_complete_at) {
    const lateness = daysBetween(deal.expected_complete_at, dispute.opened_at)
    if (lateness > 3) {
      factors.push({
        toward: 'release',
        weight: 1.5,
        line: `The dispute was opened ${Math.round(lateness)} days after the deal was due to finish.`,
      })
    }
  }

  return factors
}

/**
 * The draft itself, with no ids and no writes.
 *
 * Split out so the fixtures can seed a waiting draft by running the real
 * reasoning rather than by hand-copying its wording — a fixture that drifts
 * from the code it illustrates is worse than no fixture.
 */
export function composeDisputeDraft(
  db: MockDb,
  dispute: Dispute,
): { output: DisputeSuggestionOutput; input: unknown } {
  const deal = requireDeal(db, dispute.deal_id)
  const seller = sellerFor(db, deal)
  const factors = weighDispute(db, deal, dispute)

  const score = factors.reduce(
    (sum, f) => sum + (f.toward === 'release' ? f.weight : -f.weight),
    0,
  )

  const recommendation: DisputeRecommendation =
    score >= 2.5 ? 'release' : score <= -2.5 ? 'refund' : 'escalate'

  const money = formatMoney(deal.amount, deal.currency)
  const headline =
    recommendation === 'release'
      ? `Release ${money} to ${seller?.name ?? 'the seller'}.`
      : recommendation === 'refund'
        ? `Refund ${money} to the buyer.`
        : `Needs a person — the evidence points both ways.`

  const rationale = [...factors]
    .sort((a, b) => b.weight - a.weight)
    .map((f) => f.line)

  if (recommendation === 'escalate') {
    rationale.push(
      'Neither side is clearly ahead on the evidence, and v1 has no partial refund, so this is a judgement call rather than a draft worth approving.',
    )
  }

  const cited = factors.flatMap((f) => (f.cite ? [f.cite] : []))
  const output: DisputeSuggestionOutput = {
    kind: 'dispute_resolution',
    recommendation,
    headline,
    rationale,
    cited,
    confidence: Math.round(Math.min(0.94, 0.45 + Math.abs(score) / 10) * 100) / 100,
  }

  return {
    output,
    input: {
      deal: [deal.id, deal.amount, deal.currency, deal.status],
      dispute: [dispute.id, dispute.reason, dispute.counter_statement],
      evidence: dispute.evidence.map((e) => `${e.side}:${e.description}`),
      confirmations: deal.confirmations.map((c) => `${c.side}@${c.confirmed_at}`),
    },
  }
}

export function draftDisputeSuggestion(db: MockDb, disputeId: string): AiSuggestion {
  const dispute = db.disputes.find((d) => d.id === disputeId)
  if (!dispute) throw new PayHoldError('not_found', `Dispute ${disputeId} not found`)
  if (dispute.status !== 'open') {
    throw new PayHoldError('invalid_state', 'That dispute is already resolved')
  }

  assertAiAvailable(db, dispute.tenant_id)

  const { output, input } = composeDisputeDraft(db, dispute)

  return record(db, {
    tenant_id: dispute.tenant_id,
    deal_id: dispute.deal_id,
    kind: 'dispute_resolution',
    prompt_version: PROMPT_VERSION.dispute,
    cost: COST.dispute,
    output,
    input,
  })
}

/** Exposed so fixtures can stamp a seeded draft with the same provenance. */
export const AI_META = { model: MODEL, prompt: PROMPT_VERSION, cost: COST }

export { hashInput }

// ---------------------------------------------------------------------------
// Risk narrator
// ---------------------------------------------------------------------------

export function draftRiskSummary(db: MockDb, dealId: string): AiSuggestion {
  const deal = requireDeal(db, dealId)
  assertAiAvailable(db, deal.tenant_id)

  const seller = sellerFor(db, deal)
  const points: string[] = []
  const flags: string[] = []
  const cited: CitedEvent[] = []

  const theirDeals = db.deals.filter(
    (d) => d.seller_id === deal.seller_id && d.tenant_id === deal.tenant_id,
  )
  const completed = theirDeals.filter((d) => d.status === 'paid_out')
  const sellerAge = seller ? Math.round(daysBetween(seller.created_at, nowIso())) : 0

  points.push(
    seller
      ? `${seller.name} registered ${sellerAge} days ago and has ${completed.length} completed deal${completed.length === 1 ? '' : 's'} on this account.`
      : 'The seller record for this deal is missing.',
  )

  if (sellerAge < 30 || completed.length === 0) {
    flags.push(
      completed.length === 0
        ? 'This would be their first payout.'
        : 'The seller is less than a month old.',
    )
  }

  const priors = db.disputes.filter(
    (d) => theirDeals.some((td) => td.id === d.deal_id) && d.deal_id !== deal.id,
  )
  if (priors.length) {
    const lost = priors.filter((d) => d.status === 'resolved_refunded').length
    points.push(
      `${priors.length} prior dispute${priors.length > 1 ? 's' : ''}, ${lost} resolved in the buyer's favour.`,
    )
    if (lost > 0) flags.push(`${lost} dispute resolved against them before.`)
  } else {
    points.push('No prior disputes.')
  }

  // A payout destination that moved days before a payout is the classic
  // account-takeover shape, and the one line a human most wants surfaced.
  const changed = db.audit
    .filter(
      (a) =>
        a.tenant_id === deal.tenant_id &&
        a.action === 'seller.destination_updated' &&
        (a.details as { seller_id?: string }).seller_id === deal.seller_id,
    )
    .sort((a, b) => b.created_at.localeCompare(a.created_at))[0]

  if (changed) {
    const age = Math.round(daysBetween(changed.created_at, nowIso()))
    points.push(
      `Payout destination changed ${age <= 1 ? 'yesterday' : `${age} days ago`} — now ${seller?.masked_destination ?? 'unknown'}.`,
    )
    if (age <= 7) {
      flags.push('Payout destination changed within the last week.')
      cited.push(cite(changed.id, changed.created_at, 'Payout destination updated'))
    }
  }

  // Size, against what this company normally does.
  const sameCurrency = db.deals.filter(
    (d) => d.tenant_id === deal.tenant_id && d.currency === deal.currency,
  )
  const average =
    sameCurrency.reduce((sum, d) => sum + d.amount, 0) / (sameCurrency.length || 1)
  const ratio = average ? deal.amount / average : 1
  points.push(
    `${formatMoney(deal.amount, deal.currency)} is ${ratio.toFixed(1)}× this company's average deal.`,
  )
  if (ratio >= 2) flags.push('Well above the usual deal size.')

  if (seller && deal.provider !== 'flutterwave' && seller.country === 'RW') {
    points.push(
      `Collected on ${deal.provider} and paid out on Flutterwave — the two rails reconcile separately.`,
    )
  }

  const funded = auditFor(db, deal.id).find((a) => a.action === 'deal.funded_held')
  if (funded) cited.push(cite(funded.id, funded.created_at, 'Funds confirmed held'))

  const output: RiskSummaryOutput = {
    kind: 'risk_summary',
    headline: flags.length
      ? `${flags.length} thing${flags.length > 1 ? 's' : ''} worth a look before this pays out.`
      : 'Nothing unusual on this one.',
    points,
    flags,
    cited,
    confidence: completed.length >= 3 ? 0.88 : 0.6,
  }

  return record(db, {
    tenant_id: deal.tenant_id,
    deal_id: deal.id,
    kind: 'risk_summary',
    prompt_version: PROMPT_VERSION.risk,
    cost: COST.risk,
    output,
    input: {
      deal: [deal.id, deal.amount, deal.status],
      seller: [deal.seller_id, sellerAge, completed.length],
      priors: priors.length,
    },
  })
}

// ---------------------------------------------------------------------------
// Writing the suggestion down
// ---------------------------------------------------------------------------

function record(
  db: MockDb,
  args: {
    tenant_id: string
    deal_id: string
    kind: AiSuggestion['kind']
    prompt_version: string
    cost: number
    output: AiSuggestion['output']
    input: unknown
  },
): AiSuggestion {
  const suggestion: AiSuggestion = {
    id: nextId('ais'),
    tenant_id: args.tenant_id,
    deal_id: args.deal_id,
    kind: args.kind,
    model: MODEL,
    prompt_version: args.prompt_version,
    input_hash: hashInput(args.input),
    output: args.output,
    cost_usd: args.cost,
    created_at: nowIso(),
    decision: null,
    decided_by: null,
    decided_at: null,
  }
  db.ai_suggestions.push(suggestion)

  db.audit.push({
    id: nextId('aud'),
    tenant_id: args.tenant_id,
    deal_id: args.deal_id,
    actor: `ai:${MODEL}`,
    action: 'ai.suggestion_drafted',
    details: {
      suggestion_id: suggestion.id,
      kind: args.kind,
      prompt_version: args.prompt_version,
      input_hash: suggestion.input_hash,
      cost_usd: args.cost,
    },
    created_at: suggestion.created_at,
  })

  return suggestion
}

// ---------------------------------------------------------------------------
// The human decision
// ---------------------------------------------------------------------------

/**
 * The only path from a suggestion to money moving — and it runs on the
 * caller's authority, not the model's.
 *
 * An approval of a `release` or `refund` draft calls the same
 * `resolveDispute` an admin would have called from the dispute form; the
 * resolution note records which suggestion they approved so the trail reads
 * "a person accepted this draft", not "the AI decided". Everything else here
 * — a rejection, an approved `escalate`, any risk summary — writes a row and
 * stops.
 */
export function decideSuggestion(
  db: MockDb,
  id: string,
  decision: AiDecision,
  decidedBy: string,
): AiSuggestion {
  const suggestion = db.ai_suggestions.find((s) => s.id === id)
  if (!suggestion) throw new PayHoldError('not_found', `Suggestion ${id} not found`)
  if (suggestion.decision) {
    throw new PayHoldError('invalid_state', 'That suggestion has already been decided')
  }

  suggestion.decision = decision
  suggestion.decided_by = decidedBy
  suggestion.decided_at = nowIso()

  db.audit.push({
    id: nextId('aud'),
    tenant_id: suggestion.tenant_id,
    deal_id: suggestion.deal_id,
    actor: decidedBy,
    action: `ai.suggestion_${decision}`,
    details: { suggestion_id: suggestion.id, kind: suggestion.kind },
    created_at: suggestion.decided_at,
  })

  if (
    decision === 'approved' &&
    suggestion.output.kind === 'dispute_resolution' &&
    suggestion.output.recommendation !== 'escalate'
  ) {
    const dispute = db.disputes.find(
      (d) => d.deal_id === suggestion.deal_id && d.status === 'open',
    )
    if (!dispute) {
      throw new PayHoldError(
        'invalid_state',
        'That dispute was resolved while the draft was open — nothing has been changed',
      )
    }
    resolveDispute(
      db,
      dispute.id,
      suggestion.output.recommendation,
      `${suggestion.output.headline} Drafted by ${MODEL} (${suggestion.id}), approved by ${decidedBy}.`,
    )
  }

  return suggestion
}

// ---------------------------------------------------------------------------
// Support assistant
// ---------------------------------------------------------------------------

/**
 * The corpus. In production this is PayHold's own documentation, retrieved
 * and passed as context; here it is the same text inline. Either way the rule
 * is the same: an answer with no source is not an answer, so anything outside
 * the corpus gets a straight "I don't know".
 */
const DOCS: { id: string; source: string; keys: RegExp; answer: string }[] = [
  {
    id: 'hold',
    source: 'Operations guide — how a payment hold works',
    keys: /\bhold|held|holding|where is the money|vault\b/i,
    answer:
      'When a buyer pays, the money lands in the payment provider\'s balance and is marked held against that deal. It is not yours to spend yet and it is not the seller\'s either — it sits there until both sides confirm, the release timer fires, or the deal is refunded.',
  },
  {
    id: 'release',
    source: 'Operations guide — release',
    keys: /releas|both confirm|confirmation/i,
    answer:
      'Money is released when both the buyer and the seller confirm, and at no other time. The one exception is the timer: if the buyer stays silent past the auto-release date, the system confirms on their behalf and releases. Either way the release is a single atomic step — it cannot half-happen or happen twice.',
  },
  {
    id: 'timer',
    source: 'Settings — auto_release_days',
    keys: /timer|auto.?release|silent|no response/i,
    answer:
      'The auto-release timer starts from the expected completion date and runs for auto_release_days (3 by default). Reminders go out before it fires. A deal with an open dispute is skipped — the timer never overrides a dispute.',
  },
  {
    id: 'clearance',
    source: 'Operations guide — clearance and payouts',
    keys: /clearance|payout|paid out|when.*seller.*get|settle/i,
    answer:
      'Release and payout are different events. Released money waits out the clearance window (7 days by default) before it becomes available, then the payout job sends it to the seller\'s registered destination. You can see which stage anything is in on the Payouts screen.',
  },
  {
    id: 'refund',
    source: 'Operations guide — refunds',
    keys: /refund|cancel|money back/i,
    answer:
      'A refund can be made any time before release, and returns the buyer\'s money by the route it arrived on. After release the money has left the hold, so a refund is no longer a one-click operation — that is why the clearance window exists.',
  },
  {
    id: 'dispute',
    source: 'Operations guide — disputes',
    keys: /dispute|disagree|complain|damage|argument/i,
    answer:
      'Either side can open a dispute while funds are held. The money freezes where it is — it can neither release nor refund — until an admin resolves it in favour of one side. The assistant can draft a suggested resolution with its reasoning, but a person always makes the call.',
  },
  {
    id: 'fees',
    source: 'Settings — fees',
    keys: /fee|commission|charge|rate|cost/i,
    answer:
      'Your service fee is a percentage of the deal amount, taken at release. There is an optional flat buyer fee on top. Both live in Settings, and a change only applies to deals created afterwards — in-flight deals keep the terms they were created with.',
  },
  {
    id: 'rails',
    source: 'Payment rails',
    keys: /rail|flutterwave|stripe|momo|mobile money|m-?pesa|card|provider/i,
    answer:
      'Flutterwave is the launch rail for cards and mobile money across Africa, and it is the only rail that can pay out to Rwandan and Kenyan sellers. Stripe collects international cards but cannot send money to those markets, so a deal can be collected on Stripe and paid out on Flutterwave. That is why held balances are shown per rail.',
  },
  {
    id: 'keys',
    source: 'API keys and integration',
    keys: /api key|integrat|webhook|endpoint|token/i,
    answer:
      'Your site calls the API with an X-Api-Key header. Keys are hashed here, so the full value is shown once at creation and never again — if it is lost, revoke it and make another. Register a webhook endpoint and we will notify you on every status change, HMAC-signed so you can verify it really came from us.',
  },
  {
    id: 'ai',
    source: 'Operations guide §12 — PayHold Intelligence',
    keys: /\bai\b|assistant|model|claude|suggestion|automat/i,
    answer:
      'I read your data and draft suggestions; a person on your team approves or rejects them, and their approval is what actually does anything. I run read-only and I am not on any money path — if I were unavailable, every deal, release and payout would behave exactly the same.',
  },
]

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * Stands in for the session user. The real API derives this from auth and
 * never from the caller — a client that can name its own actor can forge an
 * approval.
 */
const OPERATOR = 'grace@autohire.rw'

/**
 * Natural-language instructions to move money get a flat no.
 *
 * The exact `/approve <id>` command is a different thing and does execute:
 * that is an operator naming one record in their own authenticated session,
 * parsed literally with no inference — a keyboard shortcut for the button, not
 * the model deciding anything. Anything the model has to *interpret* lands
 * here instead and comes back with the card and its buttons.
 */
const IMPERATIVE =
  /^(please\s+)?(release|refund|pay ?out|capture|send|approve|resolve|freeze)\b|\b(release|refund|pay out|approve)\b[^?]*\bfor me\b/i

interface Answer {
  text: string
  sources: string[]
  attachments: AiChatAttachment[]
}

const HELP: [string, string][] = [
  ['/queue', 'everything waiting on a decision, with the buttons'],
  ['/deal <ref>', 'one deal: status, money, timers, parties'],
  ['/evidence <ref>', 'both sides’ statements and what they submitted'],
  ['/draft <ref>', 'draft a resolution for that dispute'],
  ['/risk <ref>', 'summarise the counterparties before a payout'],
  ['/approve <id>', 'approve a draft · /reject <id> to decline it'],
  ['/disputes', 'open disputes'],
  ['/deals [status]', 'deals, optionally filtered'],
  ['/payouts', 'the payout queue'],
  ['/balance', 'held, clearing, available, paid out'],
  ['/audit <ref>', 'the trail for one deal'],
]

export function askAssistant(db: MockDb, question: string): AiChatMessage {
  const tenantId = db.current_tenant_id
  assertAiAvailable(db, tenantId)

  const asked = question.trim()
  db.ai_chat.push({
    id: nextId('chat'),
    tenant_id: tenantId,
    role: 'user',
    text: asked,
    sources: [],
    attachments: [],
    created_at: nowIso(),
  })

  const answer = respond(db, tenantId, asked)

  const reply: AiChatMessage = {
    id: nextId('chat'),
    tenant_id: tenantId,
    role: 'assistant',
    text: answer.text,
    sources: answer.sources,
    attachments: answer.attachments,
    created_at: nowIso(),
  }
  db.ai_chat.push(reply)

  db.audit.push({
    id: nextId('aud'),
    tenant_id: tenantId,
    deal_id: null,
    actor: `ai:${MODEL}`,
    action: 'ai.chat_answered',
    details: {
      prompt_version: PROMPT_VERSION.chat,
      input_hash: hashInput(asked),
      sources: answer.sources,
      cost_usd: COST.chat,
    },
    created_at: reply.created_at,
  })

  return reply
}

function respond(db: MockDb, tenantId: string, q: string): Answer {
  if (q.startsWith('/')) return runCommand(db, tenantId, q)

  if (IMPERATIVE.test(q)) {
    const waiting = pendingSuggestions(db, tenantId)
    return {
      text:
        "I can't move money — I only read. A person presses the button, which is deliberate: nothing I get wrong can cost you anything." +
        (waiting.length
          ? ' Here is what is waiting, if that is what you meant.'
          : ' Nothing is waiting on a decision right now.'),
      sources: ['Operations guide §12 — PayHold Intelligence'],
      attachments: waiting.map((s) => ({ kind: 'suggestion', id: s.id }) as const),
    }
  }

  // A few phrasings map straight onto commands, so nobody has to learn them.
  const ref = q.match(/\b(deal_[a-z0-9]+|bk_[a-z0-9]+|ord_[a-z0-9]+|dsp_[a-z0-9]+)\b/i)?.[1]
  if (/\bevidence|photo|proof|submitted\b/i.test(q) && ref) {
    return evidenceAnswer(db, tenantId, ref)
  }
  if (/\bwaiting|queue|pending|to decide|decide\b/i.test(q) && !ref) {
    return queueAnswer(db, tenantId)
  }
  if (/\bbalance|held|how much.*(hold|held)\b/i.test(q) && !ref) {
    return balanceAnswer(db, tenantId)
  }
  if (ref) return dealAnswer(db, tenantId, ref)

  const hit = DOCS.filter((d) => d.keys.test(q)).sort(
    (a, b) => matchCount(b, q) - matchCount(a, q),
  )[0]

  if (!hit) {
    return {
      text: "I don't have anything on that. Try a question about holds, releases, the timer, clearance, payouts, refunds, disputes, fees, rails or API keys — or use a command. Type /help to see them.",
      sources: [],
      attachments: [],
    }
  }

  return { text: hit.answer, sources: [hit.source], attachments: [] }
}

function runCommand(db: MockDb, tenantId: string, raw: string): Answer {
  const [word, ...rest] = raw.slice(1).split(/\s+/)
  const name = (word ?? '').toLowerCase()
  const arg = rest.join(' ').trim()

  switch (name) {
    case 'help':
    case '?':
      return {
        text: 'Everything on this account is readable from here.',
        sources: [],
        attachments: [
          {
            kind: 'table',
            caption: 'Commands',
            columns: ['Command', 'Shows'],
            rows: HELP.map(([c, d]) => [c, d]),
          },
        ],
      }

    case 'queue':
    case 'waiting':
      return queueAnswer(db, tenantId)

    case 'deal':
      return arg
        ? dealAnswer(db, tenantId, arg)
        : need('a deal reference, e.g. /deal bk_9912')

    case 'evidence':
      return arg
        ? evidenceAnswer(db, tenantId, arg)
        : need('a deal or dispute reference, e.g. /evidence bk_9912')

    case 'draft':
      return arg ? draftAnswer(db, tenantId, arg) : need('a reference, e.g. /draft bk_9912')

    case 'risk':
      return arg ? riskAnswer(db, tenantId, arg) : need('a reference, e.g. /risk bk_9877')

    case 'approve':
    case 'reject':
      return arg
        ? decideAnswer(db, tenantId, arg, name === 'approve' ? 'approved' : 'rejected')
        : need(`a suggestion id, e.g. /${name} ais_0042`)

    case 'disputes':
      return disputesAnswer(db, tenantId)

    case 'deals':
      return dealsAnswer(db, tenantId, arg)

    case 'payouts':
      return payoutsAnswer(db, tenantId)

    case 'balance':
      return balanceAnswer(db, tenantId)

    case 'audit':
      return arg ? auditAnswer(db, tenantId, arg) : need('a reference, e.g. /audit bk_9912')

    default:
      return {
        text: `I don't know /${name}. Type /help for the list.`,
        sources: [],
        attachments: [],
      }
  }
}

function need(what: string): Answer {
  return { text: `I need ${what}.`, sources: [], attachments: [] }
}

// -- Lookups ----------------------------------------------------------------

function findDeal(db: MockDb, tenantId: string, ref: string): Deal | undefined {
  const needle = ref.toLowerCase()
  const dispute = db.disputes.find(
    (d) => d.tenant_id === tenantId && d.id.toLowerCase() === needle,
  )
  const id = dispute?.deal_id.toLowerCase() ?? needle
  return db.deals.find(
    (d) =>
      d.tenant_id === tenantId &&
      (d.id.toLowerCase() === id || d.buyer_ref.toLowerCase() === id),
  )
}

function notFound(ref: string): Answer {
  return {
    text: `I can't find ${ref} on this account. Check the reference — I can only see this company's records.`,
    sources: [],
    attachments: [],
  }
}

function pendingSuggestions(db: MockDb, tenantId: string): AiSuggestion[] {
  return db.ai_suggestions.filter((s) => s.tenant_id === tenantId && !s.decision)
}

// -- Answers ----------------------------------------------------------------

function queueAnswer(db: MockDb, tenantId: string): Answer {
  const waiting = pendingSuggestions(db, tenantId)
  return {
    text: waiting.length
      ? `${waiting.length} draft${waiting.length > 1 ? 's are' : ' is'} waiting on you. You can decide here.`
      : 'Nothing is waiting on a decision. Ask for a draft with /draft <ref>, or a risk summary with /risk <ref>.',
    sources: [],
    attachments: waiting.map((s) => ({ kind: 'suggestion', id: s.id }) as const),
  }
}

function dealAnswer(db: MockDb, tenantId: string, ref: string): Answer {
  const deal = findDeal(db, tenantId, ref)
  if (!deal) return notFound(ref)
  return {
    text: describeDeal(db, deal),
    sources: [],
    attachments: [{ kind: 'deal', id: deal.id }],
  }
}

function evidenceAnswer(db: MockDb, tenantId: string, ref: string): Answer {
  const deal = findDeal(db, tenantId, ref)
  if (!deal) return notFound(ref)

  const dispute = db.disputes
    .filter((d) => d.deal_id === deal.id)
    .sort((a, b) => b.opened_at.localeCompare(a.opened_at))[0]

  if (!dispute) {
    return {
      text: `There is no dispute on ${deal.id}, so nothing has been submitted. ${describeDeal(db, deal)}`,
      sources: [],
      attachments: [{ kind: 'deal', id: deal.id }],
    }
  }

  const counts = dispute.evidence.length
  return {
    text: `${counts === 0 ? 'Nothing has been submitted yet' : `${counts} item${counts > 1 ? 's' : ''} submitted`} on the dispute raised by the ${dispute.raised_by}. Both statements are below — descriptions only, since PayHold never stores the files themselves.`,
    sources: [],
    attachments: [{ kind: 'evidence', dispute_id: dispute.id }],
  }
}

function draftAnswer(db: MockDb, tenantId: string, ref: string): Answer {
  const deal = findDeal(db, tenantId, ref)
  if (!deal) return notFound(ref)

  const dispute = db.disputes.find((d) => d.deal_id === deal.id && d.status === 'open')
  if (!dispute) {
    return {
      text: `There is no open dispute on ${deal.id} to draft against.`,
      sources: [],
      attachments: [{ kind: 'deal', id: deal.id }],
    }
  }

  const suggestion = draftDisputeSuggestion(db, dispute.id)
  return {
    text: 'Here is a draft. Read the reasoning before you decide — you can approve or reject it right here.',
    sources: [`Dispute ${dispute.id}`],
    attachments: [{ kind: 'suggestion', id: suggestion.id }],
  }
}

function riskAnswer(db: MockDb, tenantId: string, ref: string): Answer {
  const deal = findDeal(db, tenantId, ref)
  if (!deal) return notFound(ref)
  const suggestion = draftRiskSummary(db, deal.id)
  return {
    text: 'Everything I know about the counterparties on that deal.',
    sources: [`Deal ${deal.id}`],
    attachments: [{ kind: 'suggestion', id: suggestion.id }],
  }
}

/**
 * The typed form of the button.
 *
 * Only an exact `/approve <id>` reaches here — deterministic parsing of one
 * record named by the operator, recorded against them, running the same code
 * path the button runs. Nothing is inferred.
 */
function decideAnswer(
  db: MockDb,
  tenantId: string,
  id: string,
  decision: AiDecision,
): Answer {
  const suggestion = db.ai_suggestions.find(
    (s) => s.tenant_id === tenantId && s.id === id.toLowerCase(),
  )
  if (!suggestion) return notFound(id)

  if (suggestion.decision) {
    return {
      text: `${suggestion.id} was already ${suggestion.decision} by ${suggestion.decided_by}.`,
      sources: [],
      attachments: [{ kind: 'suggestion', id: suggestion.id }],
    }
  }

  decideSuggestion(db, suggestion.id, decision, OPERATOR)

  return {
    text:
      decision === 'approved'
        ? 'Approved and done, recorded against you.'
        : 'Rejected. Nothing was moved.',
    sources: [],
    attachments: [{ kind: 'suggestion', id: suggestion.id }],
  }
}

function disputesAnswer(db: MockDb, tenantId: string): Answer {
  const open = db.disputes.filter((d) => d.tenant_id === tenantId && d.status === 'open')
  if (!open.length) {
    return { text: 'No open disputes.', sources: [], attachments: [] }
  }
  return {
    text: `${open.length} open. Money on these is frozen until someone resolves them.`,
    sources: [],
    attachments: [
      {
        kind: 'table',
        caption: 'Open disputes',
        columns: ['Deal', 'Raised by', 'Held', 'Opened'],
        rows: open.map((d) => {
          const deal = db.deals.find((x) => x.id === d.deal_id)
          return [
            d.deal_id,
            d.raised_by,
            deal ? formatMoney(deal.amount, deal.currency) : '—',
            d.opened_at.slice(0, 10),
          ]
        }),
      },
    ],
  }
}

function dealsAnswer(db: MockDb, tenantId: string, filter: string): Answer {
  const wanted = filter.toLowerCase().replace(/\s+/g, '_')
  const rows = db.deals
    .filter((d) => d.tenant_id === tenantId && (!wanted || d.status === wanted))
    .slice(0, 12)

  if (!rows.length) {
    return {
      text: wanted ? `No deals with status ${wanted}.` : 'No deals yet.',
      sources: [],
      attachments: [],
    }
  }

  return {
    text: `${rows.length} deal${rows.length > 1 ? 's' : ''}${wanted ? ` in ${wanted.replace(/_/g, ' ')}` : ''}.`,
    sources: [],
    attachments: [
      {
        kind: 'table',
        columns: ['Deal', 'What', 'Amount', 'Status'],
        rows: rows.map((d) => [
          d.id,
          d.description,
          formatMoney(d.amount, d.currency),
          d.status.replace(/_/g, ' '),
        ]),
      },
    ],
  }
}

function payoutsAnswer(db: MockDb, tenantId: string): Answer {
  const rows = db.payouts.filter((p) => p.tenant_id === tenantId).slice(0, 12)
  if (!rows.length) return { text: 'No payouts yet.', sources: [], attachments: [] }

  return {
    text: 'The payout queue, newest first.',
    sources: [],
    attachments: [
      {
        kind: 'table',
        caption: 'Payouts',
        columns: ['Seller', 'Amount', 'Status', 'Due'],
        rows: rows.map((p) => [
          db.sellers.find((s) => s.id === p.seller_id)?.name ?? p.seller_id,
          formatMoney(p.amount, p.currency),
          p.status,
          p.scheduled_for.slice(0, 10),
        ]),
      },
    ],
  }
}

function balanceAnswer(db: MockDb, tenantId: string): Answer {
  const balances = computeBalances(db, tenantId)
  return {
    text: 'Held is buyer money in the vault. Available is cleared and payable now.',
    sources: ['Balances are derived from the ledger, never stored'],
    attachments: [
      {
        kind: 'table',
        caption: 'Balances',
        columns: ['Currency', 'Held', 'Clearing', 'Available', 'Paid out'],
        rows: balances.map((b) => [
          b.currency,
          formatMoney(b.held, b.currency),
          formatMoney(b.pending_clearance, b.currency),
          formatMoney(b.available, b.currency),
          formatMoney(b.paid_out, b.currency),
        ]),
      },
    ],
  }
}

function auditAnswer(db: MockDb, tenantId: string, ref: string): Answer {
  const deal = findDeal(db, tenantId, ref)
  if (!deal) return notFound(ref)

  const rows = auditFor(db, deal.id).slice(-12)
  return {
    text: `Everything recorded against ${deal.id}.`,
    sources: [],
    attachments: [
      {
        kind: 'table',
        caption: `Audit trail · ${deal.id}`,
        columns: ['When', 'Who', 'What'],
        rows: rows.map((r) => [
          r.created_at.slice(0, 16).replace('T', ' '),
          r.actor,
          r.action,
        ]),
      },
    ],
  }
}

function matchCount(doc: (typeof DOCS)[number], question: string): number {
  return question.split(/\s+/).filter((w) => doc.keys.test(w)).length
}

function describeDeal(db: MockDb, deal: Deal): string {
  const seller = sellerFor(db, deal)
  const money = formatMoney(deal.amount, deal.currency)
  const who = seller?.name ?? 'the seller'
  const confirmed = deal.confirmations.map((c) => c.side)

  switch (deal.status) {
    case 'created':
    case 'checkout_started':
      return `${money} for ${who}, waiting on the buyer to pay. Nothing is held yet — the payment link is live and the deal starts when they use it.`
    case 'payment_pending':
      return `${money} for ${who}. The buyer has started paying; nothing is held until the provider confirms it.`
    case 'payment_failed':
      return `${money} for ${who}. The buyer's payment did not go through. They can try again on the same deal.`
    case 'expired':
      return `${money} for ${who}, never paid. The link expired and nobody was charged.`
    case 'canceled':
      return `${money} for ${who}, called off before any money moved.`
    case 'in_progress':
    case 'revision_requested':
    case 'funded_held':
      return `${money} is held for ${who}. Neither side has confirmed yet. It releases when both do, or on ${new Date(deal.auto_release_at ?? '').toDateString()} if the buyer stays silent.`
    case 'confirmed_buyer':
    case 'confirmed_seller':
      return `${money} is held for ${who}. The ${confirmed[0]} has confirmed; it releases the moment the ${confirmed[0] === 'buyer' ? 'seller' : 'buyer'} does.`
    case 'disputed':
      return `${money} is frozen — there is an open dispute on this deal. It can neither release nor refund until someone resolves it.`
    case 'clearing':
      return `${money} was released to ${who} and is in the clearance window. The payout goes out on ${new Date(deal.payout_due_at ?? '').toDateString()}.`
    case 'released':
      return `${money} for ${who} has cleared and is ready to pay out. Nothing is holding it except the next dispatch pass — or a risk hold, if the Payouts screen shows one.`
    case 'payout_pending':
      return `${money} for ${who} is with the provider and has not settled yet. It books as paid when they confirm it.`
    case 'paid_out':
      return `Done — ${money} was released to ${who} and paid out. Nothing further happens on this deal.`
    case 'refunded':
      return `${money} went back to the buyer. This deal is closed.`
    case 'partially_refunded':
      return `Part of ${money} went back to the buyer; the rest follows the deal to ${who}.`
  }
}
