/**
 * The mock money engine.
 *
 * This is a genuine state machine, not a pile of canned responses. Every
 * transition here is one the backend will have to implement identically, and
 * the guards are the same guards: a deal cannot release without both
 * confirmations or an expired timer, a refund cannot follow a release, a
 * payout cannot leave a frozen tenant.
 *
 * Balances are derived from the ledger and never stored, exactly as the real
 * system requires.
 */

import {
  HOLDING_STATUSES,
  PayHoldError,
  type Balance,
  type ConfirmSide,
  type Currency,
  type Deal,
  type DealOutcome,
  type Dispute,
  type LedgerEntry,
  type LedgerEntryType,
  type PaymentMethod,
  type Payout,
  type Provider,
  type RailBalance,
  type ReconciliationAlert,
  type TenantSettings,
} from '../types'
import { METHOD_LABEL, collectionRails, providerFor } from '@/lib/rails'
import { convert } from '@/lib/fx'
import {
  addDays,
  audit,
  getDb,
  isDue,
  nextId,
  nowIso,
  type MockDb,
} from './store'
import { dealFindings, payoutFindings, recordFindings } from './risk'
import { deliverPending, emitWebhook } from './webhooks'

/**
 * Re-exported so the many callers that reach for `audit` alongside the money
 * functions keep one import. It lives in `store` because the webhook
 * dispatcher and the reconciliation pass write audit rows too, and importing
 * them from here would put a cycle through the money paths.
 */
export { audit } from './store'

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

export function requireDeal(db: MockDb, id: string): Deal {
  const deal = db.deals.find((d) => d.id === id)
  if (!deal) throw new PayHoldError('not_found', `Deal ${id} not found`)
  return deal
}

export function settingsFor(db: MockDb, tenantId: string): TenantSettings {
  const s = db.settings.find((x) => x.tenant_id === tenantId)
  if (!s) throw new PayHoldError('not_found', `No settings for tenant ${tenantId}`)
  return s
}

// ---------------------------------------------------------------------------
// Write helpers — every state change goes through these, so nothing can move
// money without also leaving a ledger entry and an audit trail.
// ---------------------------------------------------------------------------

function ledgerEntry(
  db: MockDb,
  deal: Deal,
  type: LedgerEntryType,
  amount: number,
): void {
  db.ledger.push({
    id: nextId('led'),
    tenant_id: deal.tenant_id,
    deal_id: deal.id,
    entry_type: type,
    amount,
    // The currency that actually landed in the provider balance, which is what
    // the buyer was charged — not what the seller is owed.
    currency: deal.presentment_currency,
    provider: deal.provider,
    provider_ref: deal.provider_ref,
    created_at: nowIso(),
  })
}

function touch(deal: Deal): void {
  deal.updated_at = nowIso()
}

/** The fee, in the currency actually collected. */
function presentmentFee(deal: Deal): number {
  if (deal.presentment_currency === deal.currency) return deal.fee_amount
  return (
    convert(deal.fee_amount, deal.currency, deal.presentment_currency)?.amount ??
    deal.fee_amount
  )
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

/**
 * A verified provider webhook has landed: the buyer's money is now in the
 * vault. In the real system this is only reachable after signature check AND
 * provider re-verification of amount, currency and status.
 *
 * The payment method the buyer chose fixes the rail — a deal that was
 * provisionally routed to Flutterwave becomes a Stripe deal if they paid by
 * international card, and the ledger entries follow the rail that actually
 * holds the money.
 */
export function fundDeal(
  db: MockDb,
  dealId: string,
  method?: PaymentMethod,
  network?: string,
): Deal {
  const deal = requireDeal(db, dealId)
  if (deal.status !== 'created') {
    throw new PayHoldError(
      'invalid_state',
      `Deal ${dealId} is ${deal.status}, cannot be funded`,
    )
  }

  // Route on what the buyer is charged, not on what the seller is owed. An
  // Indian buyer settling an RWF deal is charged USD, and it is the USD rails
  // that have to exist.
  const rails = collectionRails(deal.buyer_country, deal.presentment_currency)
  const chosen = method ?? rails[0]?.method ?? 'card'
  const provider = providerFor(deal.buyer_country, deal.presentment_currency, chosen)
  const rail = rails.find((r) => r.method === chosen)

  if (!provider) {
    throw new PayHoldError(
      'policy_violation',
      `${METHOD_LABEL[chosen]} is not available for ${deal.presentment_currency} in ${deal.buyer_country}`,
    )
  }

  const cfg = settingsFor(db, deal.tenant_id)
  deal.status = 'funded_held'
  deal.payment_method = chosen
  // Record the specific wallet or scheme, so "paid with M-Pesa" survives even
  // though the engine only cares that it was mobile money.
  deal.payment_network =
    network ?? rail?.networks[0] ?? (chosen === 'card' ? 'Visa' : null)
  deal.provider = provider
  deal.provider_ref = `${provider === 'stripe' ? 'pi' : 'FLW'}-${nextId('ref')}`
  deal.auto_release_at = addDays(
    deal.expected_complete_at ?? nowIso(),
    cfg.auto_release_days,
  )
  touch(deal)

  // Lock the rate at the moment of payment. Re-deriving it later would move
  // the number under a deal that has already been paid.
  if (deal.presentment_currency !== deal.currency) {
    const locked = convert(deal.amount, deal.currency, deal.presentment_currency)
    if (locked) {
      deal.presentment_amount = locked.amount
      deal.fx_rate = locked.rate
      audit(db, deal.tenant_id, deal.id, 'system', 'fx.rate_locked', {
        settlement: deal.currency,
        presentment: deal.presentment_currency,
        rate: locked.rate,
      })
    }
  }

  ledgerEntry(db, deal, 'hold', deal.presentment_amount)
  if (deal.deposit_amount) {
    ledgerEntry(db, deal, 'deposit_hold', deal.deposit_amount)
  }

  audit(db, deal.tenant_id, deal.id, 'system', 'webhook.verified', {
    provider: deal.provider,
  })
  audit(db, deal.tenant_id, deal.id, 'system', 'deal.funded_held', {
    amount: deal.amount,
  })

  // Everything knowable about the counterparties at the moment money lands.
  // None of it can stop the deal — a rule that could hold a buyer's payment
  // would be a worse product than the fraud it prevents.
  recordFindings(db, deal.tenant_id, deal.id, deal.seller_id, dealFindings(db, deal))

  emitWebhook(db, deal.tenant_id, 'deal.funded_held', deal.id, {
    amount: deal.amount,
    currency: deal.currency,
    presentment_amount: deal.presentment_amount,
    presentment_currency: deal.presentment_currency,
    payment_method: deal.payment_method,
    auto_release_at: deal.auto_release_at,
  })
  return deal
}

/**
 * Record one side's confirmation. When both sides are in, release happens in
 * the same call — this is the atomic step the backend guards with
 * SELECT ... FOR UPDATE.
 */
export function confirmDeal(
  db: MockDb,
  dealId: string,
  side: ConfirmSide,
  actor: 'user' | 'auto' = 'user',
): Deal {
  const deal = requireDeal(db, dealId)

  if (!HOLDING_STATUSES.includes(deal.status)) {
    throw new PayHoldError(
      'invalid_state',
      `Deal ${dealId} is ${deal.status} and can no longer be confirmed`,
    )
  }
  if (deal.status === 'disputed') {
    throw new PayHoldError(
      'invalid_state',
      'Deal is disputed — resolve the dispute before confirming',
    )
  }

  // Idempotent: confirming twice from the same side is a no-op, not an error.
  // The notification is inside the guard for the same reason the audit row is
  // — a client resending a confirmation should not see two events.
  if (!deal.confirmations.some((c) => c.side === side)) {
    deal.confirmations.push({ side, confirmed_at: nowIso(), actor })
    audit(
      db,
      deal.tenant_id,
      deal.id,
      actor === 'auto' ? 'system' : `user:${side}`,
      `deal.confirmed_${side}`,
      { actor },
    )
    emitWebhook(db, deal.tenant_id, 'deal.confirmed', deal.id, { side, actor })
  }

  const hasBuyer = deal.confirmations.some((c) => c.side === 'buyer')
  const hasSeller = deal.confirmations.some((c) => c.side === 'seller')

  if (hasBuyer && hasSeller) return releaseDeal(db, deal)

  deal.status = hasBuyer ? 'confirmed_buyer' : 'confirmed_seller'
  touch(deal)
  return deal
}

/**
 * Move money out of the hold. Only reachable with both confirmations present —
 * the timer path gets there by writing the missing confirmation first.
 */
/**
 * Label a deal's terminal result — the training set of spec §12.3.
 *
 * This lives on the money path rather than beside the AI code on purpose: the
 * labels have to come from *every* resolution, including the ones no model was
 * involved in, or the eventual fraud model learns from a biased sample. It is
 * also why this is written now rather than when a model is trained — an
 * outcome nobody recorded at the time cannot be reconstructed later.
 */
function recordOutcome(
  db: MockDb,
  deal: Deal,
  outcome: DealOutcome['outcome'],
  reasonCode: string,
  notes: string | null = null,
  amountDisputed: number | null = null,
): void {
  if (db.deal_outcomes.some((o) => o.deal_id === deal.id)) return

  db.deal_outcomes.push({
    id: nextId('out'),
    tenant_id: deal.tenant_id,
    deal_id: deal.id,
    outcome,
    reason_code: reasonCode,
    notes,
    amount_disputed: amountDisputed,
    resolved_at: nowIso(),
    created_at: nowIso(),
  })
}

function releaseDeal(db: MockDb, deal: Deal): Deal {
  const hasBoth =
    deal.confirmations.some((c) => c.side === 'buyer') &&
    deal.confirmations.some((c) => c.side === 'seller')

  if (!hasBoth) {
    throw new PayHoldError('invalid_state', 'Release requires both confirmations')
  }
  if (deal.status === 'released' || deal.status === 'paid_out') return deal

  const cfg = settingsFor(db, deal.tenant_id)
  const releasedAt = nowIso()

  deal.status = 'released'
  deal.released_at = releasedAt
  deal.payout_due_at = addDays(releasedAt, cfg.clearance_days)
  touch(deal)

  ledgerEntry(db, deal, 'release', -deal.presentment_amount)
  ledgerEntry(db, deal, 'fee', -presentmentFee(deal))
  if (deal.deposit_amount && !depositSettled(db, deal.id)) {
    ledgerEntry(db, deal, 'deposit_release', -deal.deposit_amount)
  }

  // The seller is owed the settlement currency, whatever the buyer paid in.
  const seller = db.sellers.find((s) => s.id === deal.seller_id)
  const netSettlement = deal.amount - deal.fee_amount
  const payoutCurrency = seller?.payout_currency ?? deal.currency
  const payoutAmount =
    convert(netSettlement, deal.currency, payoutCurrency)?.amount ?? netSettlement

  db.payouts.push({
    id: nextId('po'),
    tenant_id: deal.tenant_id,
    deal_id: deal.id,
    seller_id: deal.seller_id,
    amount: payoutAmount,
    currency: payoutCurrency,
    status: 'scheduled',
    scheduled_for: deal.payout_due_at,
    paid_at: null,
    failure_reason: null,
    attempts: 0,
    review_held_at: null,
    review_held_by: null,
    review_hold_reason: null,
    review_approved_by: null,
    review_approved_at: null,
  })

  audit(db, deal.tenant_id, deal.id, 'system', 'deal.released', {
    fee_amount: deal.fee_amount,
    net: netSettlement,
    paid_in: payoutCurrency,
  })

  emitWebhook(db, deal.tenant_id, 'deal.released', deal.id, {
    fee_amount: deal.fee_amount,
    net: netSettlement,
    payout_currency: payoutCurrency,
    payout_amount: payoutAmount,
    payout_due_at: deal.payout_due_at,
  })

  // A dispute resolution records its own, more specific label.
  if (!db.disputes.some((d) => d.deal_id === deal.id)) {
    const auto = deal.confirmations.some((c) => c.actor === 'auto')
    recordOutcome(
      db,
      deal,
      auto ? 'auto_released' : 'released_clean',
      auto ? 'timer_fired' : 'both_confirmed',
    )
  }
  return deal
}

export function refundDeal(db: MockDb, dealId: string, reason: string): Deal {
  const deal = requireDeal(db, dealId)

  if (deal.status === 'released' || deal.status === 'paid_out') {
    throw new PayHoldError(
      'policy_violation',
      'Funds have already been released — refund is no longer possible',
    )
  }
  if (deal.status === 'refunded') return deal
  if (deal.status === 'created') {
    throw new PayHoldError('invalid_state', 'Nothing has been collected to refund')
  }

  deal.status = 'refunded'
  touch(deal)

  ledgerEntry(db, deal, 'refund', -deal.presentment_amount)
  if (deal.deposit_amount && !depositSettled(db, deal.id)) {
    ledgerEntry(db, deal, 'deposit_release', -deal.deposit_amount)
  }

  audit(db, deal.tenant_id, deal.id, 'dashboard', 'deal.refunded', { reason })
  emitWebhook(db, deal.tenant_id, 'deal.refunded', deal.id, {
    reason,
    amount: deal.presentment_amount,
    currency: deal.presentment_currency,
  })

  if (!db.disputes.some((d) => d.deal_id === deal.id)) {
    recordOutcome(db, deal, 'refunded', 'client_refund', reason)
  }
  return deal
}

// ---------------------------------------------------------------------------
// Deposits (card pre-auth)
// ---------------------------------------------------------------------------

function depositSettled(db: MockDb, dealId: string): boolean {
  return db.ledger.some(
    (e) =>
      e.deal_id === dealId &&
      (e.entry_type === 'deposit_capture' || e.entry_type === 'deposit_release'),
  )
}

export function captureDeposit(db: MockDb, dealId: string, amount: number): Deal {
  const deal = requireDeal(db, dealId)

  if (!deal.deposit_amount) {
    throw new PayHoldError('invalid_state', 'This deal has no security deposit')
  }
  if (depositSettled(db, dealId)) {
    throw new PayHoldError('invalid_state', 'The deposit has already been settled')
  }
  if (amount <= 0 || amount > deal.deposit_amount) {
    throw new PayHoldError(
      'policy_violation',
      `Capture must be between 1 and the held deposit of ${deal.deposit_amount}`,
    )
  }

  ledgerEntry(db, deal, 'deposit_capture', amount)
  if (amount < deal.deposit_amount) {
    ledgerEntry(db, deal, 'deposit_release', -(deal.deposit_amount - amount))
  }
  audit(db, deal.tenant_id, deal.id, 'dashboard', 'deposit.captured', { amount })
  emitWebhook(db, deal.tenant_id, 'deposit.captured', deal.id, {
    amount,
    held: deal.deposit_amount,
    returned: deal.deposit_amount - amount,
  })
  touch(deal)
  return deal
}

export function releaseDeposit(db: MockDb, dealId: string): Deal {
  const deal = requireDeal(db, dealId)

  if (!deal.deposit_amount) {
    throw new PayHoldError('invalid_state', 'This deal has no security deposit')
  }
  if (depositSettled(db, dealId)) {
    throw new PayHoldError('invalid_state', 'The deposit has already been settled')
  }

  ledgerEntry(db, deal, 'deposit_release', -deal.deposit_amount)
  audit(db, deal.tenant_id, deal.id, 'dashboard', 'deposit.released', {
    amount: deal.deposit_amount,
  })
  emitWebhook(db, deal.tenant_id, 'deposit.released', deal.id, {
    amount: deal.deposit_amount,
  })
  touch(deal)
  return deal
}

// ---------------------------------------------------------------------------
// Disputes
// ---------------------------------------------------------------------------

export function openDispute(
  db: MockDb,
  dealId: string,
  raisedBy: ConfirmSide,
  reason: string,
): Dispute {
  const deal = requireDeal(db, dealId)

  if (!HOLDING_STATUSES.includes(deal.status)) {
    throw new PayHoldError(
      'invalid_state',
      `A deal in ${deal.status} cannot be disputed`,
    )
  }

  const dispute: Dispute = {
    id: nextId('dsp'),
    tenant_id: deal.tenant_id,
    deal_id: deal.id,
    raised_by: raisedBy,
    reason,
    // The other side has not been asked yet — a dispute starts one-sided, and
    // the assistant is told so rather than left to assume silence means guilt.
    counter_statement: null,
    evidence: [],
    status: 'open',
    opened_at: nowIso(),
    resolved_at: null,
    resolution_note: null,
  }
  db.disputes.push(dispute)

  deal.status = 'disputed'
  touch(deal)
  audit(db, deal.tenant_id, deal.id, `user:${raisedBy}`, 'deal.disputed', { reason })
  emitWebhook(db, deal.tenant_id, 'deal.disputed', deal.id, {
    dispute_id: dispute.id,
    raised_by: raisedBy,
    reason,
  })
  return dispute
}

export function resolveDispute(
  db: MockDb,
  disputeId: string,
  resolution: 'release' | 'refund',
  note: string,
): Dispute {
  const dispute = db.disputes.find((d) => d.id === disputeId)
  if (!dispute) throw new PayHoldError('not_found', `Dispute ${disputeId} not found`)
  if (dispute.status !== 'open') {
    throw new PayHoldError('invalid_state', 'This dispute is already resolved')
  }

  const deal = requireDeal(db, dispute.deal_id)

  if (resolution === 'release') {
    // Staff resolution stands in for the parties: both sides are recorded as
    // confirmed by the system, then the normal release path runs.
    deal.status = 'funded_held'
    for (const side of ['buyer', 'seller'] as ConfirmSide[]) {
      if (!deal.confirmations.some((c) => c.side === side)) {
        deal.confirmations.push({ side, confirmed_at: nowIso(), actor: 'auto' })
      }
    }
    releaseDeal(db, deal)
    dispute.status = 'resolved_released'
  } else {
    deal.status = 'funded_held'
    refundDeal(db, deal.id, `Dispute resolved in buyer's favour: ${note}`)
    dispute.status = 'resolved_refunded'
  }

  dispute.resolved_at = nowIso()
  dispute.resolution_note = note
  audit(db, deal.tenant_id, deal.id, 'payhold-staff', 'dispute.resolved', {
    resolution,
    note,
  })
  emitWebhook(db, deal.tenant_id, 'deal.dispute_resolved', deal.id, {
    dispute_id: dispute.id,
    resolution,
    note,
  })
  recordOutcome(
    db,
    deal,
    resolution === 'release' ? 'dispute_released' : 'dispute_refunded',
    `dispute_${dispute.raised_by}_raised`,
    note,
    deal.amount,
  )
  return dispute
}

// ---------------------------------------------------------------------------
// Payouts
// ---------------------------------------------------------------------------

/**
 * Run the deterministic rules against a payout that is about to leave.
 *
 * Returns true when the payout was held. The signals are written either way —
 * the record of what we noticed is worth keeping even when nothing was worth
 * stopping for, because that is the history a model of our own trains on.
 */
function screenPayout(db: MockDb, payout: Payout): boolean {
  // Already looked at by a person: their decision stands, and re-running the
  // rules would let a rule overrule the human who overruled it.
  if (payout.review_approved_at) return false

  const cfg = settingsFor(db, payout.tenant_id)
  const findings = payoutFindings(db, payout, cfg)
  if (findings.length === 0) return false

  recordFindings(db, payout.tenant_id, payout.deal_id, payout.seller_id, findings)

  const blocking = findings.filter((f) => f.severity === 'review')
  if (!cfg.risk_rules_enabled || blocking.length === 0) return false

  payout.status = 'held_for_review'
  payout.review_held_at = nowIso()

  audit(db, payout.tenant_id, payout.deal_id, 'system', 'payout.held_for_review', {
    payout_id: payout.id,
    signals: blocking.map((f) => f.signal),
    reasons: blocking.map((f) => f.explanation),
  })
  emitWebhook(db, payout.tenant_id, 'payout.held_for_review', payout.deal_id, {
    payout_id: payout.id,
    amount: payout.amount,
    currency: payout.currency,
    signals: blocking.map((f) => f.signal),
  })
  return true
}

function dispatchPayout(db: MockDb, payout: Payout): void {
  const tenant = db.tenants.find((t) => t.id === payout.tenant_id)
  if (tenant?.status === 'payouts_frozen') {
    payout.status = 'frozen'
    audit(db, payout.tenant_id, payout.deal_id, 'system', 'payout.frozen', {
      reason: 'Tenant payouts are frozen pending reconciliation',
    })
    return
  }

  // Screening happens before the attempt counter moves: a payout a rule stopped
  // was never tried, and counting it as an attempt would misreport the
  // provider's reliability.
  if (screenPayout(db, payout)) return

  payout.attempts += 1

  if (db.fail_next_payout) {
    db.fail_next_payout = false
    payout.status = 'failed'
    payout.failure_reason = 'Provider rejected the transfer (simulated failure)'
    audit(db, payout.tenant_id, payout.deal_id, 'system', 'payout.failed', {
      reason: payout.failure_reason,
      attempts: payout.attempts,
    })
    emitWebhook(db, payout.tenant_id, 'payout.failed', payout.deal_id, {
      payout_id: payout.id,
      reason: payout.failure_reason,
      attempts: payout.attempts,
    })
    return
  }

  const deal = requireDeal(db, payout.deal_id)
  payout.status = 'paid'
  payout.paid_at = nowIso()
  payout.failure_reason = null

  // Debit the balance we actually hold. The seller receives `payout.amount` in
  // their own currency; what leaves our vault is the presentment equivalent.
  const leaving =
    convert(payout.amount, payout.currency, deal.presentment_currency)?.amount ??
    payout.amount
  ledgerEntry(db, deal, 'payout', -leaving)
  deal.status = 'paid_out'
  touch(deal)

  audit(db, payout.tenant_id, payout.deal_id, 'system', 'payout.paid', {
    amount: payout.amount,
    seller_id: payout.seller_id,
  })
  emitWebhook(db, payout.tenant_id, 'deal.paid_out', payout.deal_id, {
    payout_id: payout.id,
    amount: payout.amount,
    currency: payout.currency,
    seller_id: payout.seller_id,
  })
}

export function retryPayout(db: MockDb, payoutId: string): Payout {
  const payout = db.payouts.find((p) => p.id === payoutId)
  if (!payout) throw new PayHoldError('not_found', `Payout ${payoutId} not found`)
  if (payout.status === 'paid') {
    throw new PayHoldError('invalid_state', 'This payout has already been sent')
  }
  // Retry is for provider failures. A payout a rule stopped needs a decision,
  // not another attempt — otherwise "retry" is a button that skips review.
  if (payout.status === 'held_for_review') {
    throw new PayHoldError(
      'invalid_state',
      'This payout is held for review — approve it to send it',
    )
  }
  dispatchPayout(db, payout)
  return payout
}

/**
 * A person stopping one payout.
 *
 * The narrow counterpart to freezing a tenant. Before this existed, an operator
 * who noticed something the rules do not model — a phone call, a seller gone
 * quiet, a booking that reads wrong — could only stop every payout the account
 * had, which punishes every honest seller to catch one.
 *
 * It reuses `held_for_review` rather than inventing a status, because what it
 * produces is the same thing: one payout waiting on one person, cleared through
 * the same audited approval. `review_held_by` is what tells the two apart when
 * somebody reads them back, and it is required for that reason — a stop nobody
 * signed is a stop nobody can be asked about.
 *
 * This does not weaken invariant 11. That invariant limits *rules* to stopping,
 * because a rule is arithmetic nobody agreed to at the time. A person stopping a
 * payout fails in the same safe direction with a name attached.
 */
export function holdPayout(
  db: MockDb,
  payoutId: string,
  heldBy: string,
  reason: string,
): Payout {
  const payout = db.payouts.find((p) => p.id === payoutId)
  if (!payout) throw new PayHoldError('not_found', `Payout ${payoutId} not found`)

  if (!heldBy.trim()) {
    throw new PayHoldError('policy_violation', 'A hold must name the person placing it')
  }
  if (!reason.trim()) {
    throw new PayHoldError('policy_violation', 'A hold must say why')
  }

  if (payout.status === 'paid') {
    throw new PayHoldError('invalid_state', 'This payout has already been sent')
  }
  // Already with the provider. Recalling an in-flight transfer is a
  // conversation with Flutterwave, not a row in this table, and a hold that
  // pretended otherwise would be a lie an operator acts on.
  if (payout.status === 'processing') {
    throw new PayHoldError('invalid_state', 'This payout is already with the provider')
  }
  if (payout.status === 'held_for_review') {
    throw new PayHoldError('invalid_state', 'This payout is already held')
  }

  const previous = payout.status
  payout.status = 'held_for_review'
  payout.review_held_at = nowIso()
  payout.review_held_by = heldBy
  payout.review_hold_reason = reason.trim()
  // A previous approval is cleared deliberately: it was a decision about what
  // the rules found then, and leaving it would show an approver's name beside a
  // payout they have not approved.
  payout.review_approved_by = null
  payout.review_approved_at = null

  audit(db, payout.tenant_id, payout.deal_id, heldBy, 'payout.held_by_person', {
    payout_id: payout.id,
    reason: reason.trim(),
    previous_status: previous,
  })
  // The same event a rule hold sends. A client cannot act on the difference —
  // either way their seller is not being paid today.
  emitWebhook(db, payout.tenant_id, 'payout.held_for_review', payout.deal_id, {
    payout_id: payout.id,
    amount: payout.amount,
    currency: payout.currency,
    held_by: heldBy,
  })

  return payout
}

/**
 * A person overriding a hold — a rule's or another person's. This is the only
 * way a held payout moves, and it is recorded against them rather than against
 * the system.
 */
export function approvePayoutReview(
  db: MockDb,
  payoutId: string,
  approvedBy: string,
): Payout {
  const payout = db.payouts.find((p) => p.id === payoutId)
  if (!payout) throw new PayHoldError('not_found', `Payout ${payoutId} not found`)
  if (payout.status !== 'held_for_review') {
    throw new PayHoldError('invalid_state', 'This payout is not held for review')
  }

  payout.review_approved_by = approvedBy
  payout.review_approved_at = nowIso()

  const signals = db.risk_signals.filter(
    (s) => s.deal_id === payout.deal_id && s.severity === 'review',
  )
  audit(db, payout.tenant_id, payout.deal_id, approvedBy, 'payout.review_approved', {
    payout_id: payout.id,
    overrode: signals.map((s) => s.signal),
  })

  dispatchPayout(db, payout)
  return payout
}

// ---------------------------------------------------------------------------
// Cron
// ---------------------------------------------------------------------------

export interface CronResult {
  auto_released: number
  paid: number
  frozen: number
  held_for_review: number
  webhooks_delivered: number
  drift_alerts: number
}

/**
 * One pass of every scheduled job, in the order they have to run:
 *
 *   1. reconciliation, first — drift freezes payouts, and a pass that paid out
 *      before checking would be sending money out of a balance we already know
 *      we cannot explain
 *   2. auto-release timers
 *   3. payout dispatch for anything whose clearance window has closed
 *   4. outbound webhook delivery, last, so this pass's own events go out
 */
export function runCron(db: MockDb): CronResult {
  const result: CronResult = {
    auto_released: 0,
    paid: 0,
    frozen: 0,
    held_for_review: 0,
    webhooks_delivered: 0,
    drift_alerts: 0,
  }

  result.drift_alerts = runReconciliation(db).filter((a) => !a.resolved_at).length

  for (const deal of db.deals) {
    const canAutoRelease =
      HOLDING_STATUSES.includes(deal.status) &&
      deal.status !== 'disputed' &&
      isDue(deal.auto_release_at)

    if (!canAutoRelease) continue

    audit(db, deal.tenant_id, deal.id, 'system', 'deal.auto_release_fired', {
      auto_release_at: deal.auto_release_at,
    })
    for (const side of ['buyer', 'seller'] as ConfirmSide[]) {
      if (!deal.confirmations.some((c) => c.side === side)) {
        deal.confirmations.push({ side, confirmed_at: nowIso(), actor: 'auto' })
      }
    }
    releaseDeal(db, deal)
    result.auto_released += 1
  }

  for (const payout of db.payouts) {
    // `held_for_review` is deliberately not dispatchable: cron must never be
    // the thing that lets a held payout through. Only a person can.
    const dispatchable = payout.status === 'scheduled' || payout.status === 'frozen'
    if (!dispatchable || !isDue(payout.scheduled_for)) continue

    dispatchPayout(db, payout)
    if (payout.status === 'paid') result.paid += 1
    if (payout.status === 'frozen') result.frozen += 1
    if (payout.status === 'held_for_review') result.held_for_review += 1
  }

  result.webhooks_delivered = deliverPending(db).delivered

  return result
}

// ---------------------------------------------------------------------------
// Balances — derived from the ledger, never stored
// ---------------------------------------------------------------------------

const HELD_TYPES: LedgerEntryType[] = ['hold', 'release', 'refund']

/**
 * Four buckets, per currency, computed entirely from ledger entries:
 *
 *   held              hold + release + refund  (nets to zero once settled)
 *   clearing pool     −release − fee − payout  (what the seller is owed)
 *   split of that     by each deal's payout_due_at
 *   paid_out          the payout entries, unsigned
 *
 * Security deposits are excluded — they are the buyer's money held against
 * damage, not part of the tenant's balance.
 */
export function computeBalances(db: MockDb, tenantId: string): Balance[] {
  const byCurrency = new Map<Currency, Balance>()

  for (const rail of computeRailBalances(db, tenantId)) {
    let b = byCurrency.get(rail.currency)
    if (!b) {
      b = {
        currency: rail.currency,
        held: 0,
        pending_clearance: 0,
        available: 0,
        paid_out: 0,
      }
      byCurrency.set(rail.currency, b)
    }
    b.held += rail.held
    b.pending_clearance += rail.pending_clearance
    b.available += rail.available
    b.paid_out += rail.paid_out
  }

  // A tenant with a configured currency and no activity should still show a
  // zeroed row rather than vanishing from the overview.
  for (const currency of settingsFor(db, tenantId).currencies) {
    if (!byCurrency.has(currency)) {
      byCurrency.set(currency, {
        currency,
        held: 0,
        pending_clearance: 0,
        available: 0,
        paid_out: 0,
      })
    }
  }

  return [...byCurrency.values()].sort((a, b) => a.currency.localeCompare(b.currency))
}

/**
 * The same computation, split by the rail holding the money.
 *
 * This is the operational truth: "held" is never one pot. It is a Flutterwave
 * balance and a Stripe balance, reconciled separately against different
 * providers, and only one of them can pay an African seller. The reconciliation
 * cron compares these rows — not the currency totals — to what each provider
 * actually reports.
 */
export function computeRailBalances(db: MockDb, tenantId: string): RailBalance[] {
  const byRail = new Map<string, RailBalance>()

  const bucket = (provider: Provider, currency: Currency): RailBalance => {
    const key = `${provider}:${currency}`
    let b = byRail.get(key)
    if (!b) {
      b = {
        provider,
        currency,
        held: 0,
        pending_clearance: 0,
        available: 0,
        paid_out: 0,
      }
      byRail.set(key, b)
    }
    return b
  }

  const entriesByDeal = new Map<string, LedgerEntry[]>()
  for (const e of db.ledger) {
    if (e.tenant_id !== tenantId || e.deal_id === null) continue
    const list = entriesByDeal.get(e.deal_id)
    if (list) list.push(e)
    else entriesByDeal.set(e.deal_id, [e])
  }

  for (const [dealId, entries] of entriesByDeal) {
    const deal = db.deals.find((d) => d.id === dealId)
    if (!deal) continue

    let held = 0
    let clearing = 0
    let paid = 0

    for (const e of entries) {
      if (HELD_TYPES.includes(e.entry_type)) held += e.amount
      if (e.entry_type === 'release') clearing -= e.amount
      if (e.entry_type === 'fee') clearing += e.amount
      if (e.entry_type === 'payout') {
        clearing += e.amount
        paid -= e.amount
      }
    }

    // Attribute to the rail recorded on the entries, not the deal — a deal's
    // provider can change when the buyer picks their method, and the ledger is
    // the record of where the money actually went.
    const provider = entries[0]?.provider ?? deal.provider
    const b = bucket(provider, entries[0]?.currency ?? deal.presentment_currency)

    b.held += held
    b.paid_out += paid
    if (isDue(deal.payout_due_at)) b.available += clearing
    else b.pending_clearance += clearing
  }

  return [...byRail.values()].sort(
    (a, b) =>
      a.provider.localeCompare(b.provider) || a.currency.localeCompare(b.currency),
  )
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

/** Key into `provider_drift` — one rail, one currency, one tenant. */
export function driftKey(
  tenantId: string,
  provider: Provider,
  currency: Currency,
): string {
  return `${tenantId}:${provider}:${currency}`
}

/**
 * What the provider says it is holding for this tenant on this rail.
 *
 * In the real system this is an API call — Flutterwave's `/balances`, Stripe's
 * balance endpoint. Here it is our own number plus whatever drift the dev panel
 * injected, which is the same shape of answer: something computed elsewhere
 * that we have to agree with.
 */
function providerReportedBalance(
  db: MockDb,
  tenantId: string,
  rail: RailBalance,
): number {
  const expected = rail.held + rail.pending_clearance + rail.available
  return expected + (db.provider_drift[driftKey(tenantId, rail.provider, rail.currency)] ?? 0)
}

/**
 * The reconciliation cron: compare every rail's ledger balance against what the
 * provider reports, and freeze payouts on any mismatch.
 *
 * "Ledger balance" here means everything still sitting with the provider —
 * held, plus released money inside its clearance window, plus cleared money not
 * yet sent. Paid-out money has left. Release is a move between our buckets, not
 * a movement of funds, which is why it cannot be read off the ledger's signs
 * directly.
 *
 * Freezing is automatic; unfreezing is not. A mismatch means we cannot explain
 * where money is, and the safe response is to stop sending it — but resuming
 * is a judgement about whether it has been explained, which is a person's call.
 */
export function runReconciliation(db: MockDb, tenantId?: string): ReconciliationAlert[] {
  const tenants = tenantId
    ? db.tenants.filter((t) => t.id === tenantId)
    : db.tenants
  const touched: ReconciliationAlert[] = []

  for (const tenant of tenants) {
    let raisedNew = false

    for (const rail of computeRailBalances(db, tenant.id)) {
      const ledgerBalance = rail.held + rail.pending_clearance + rail.available
      const providerBalance = providerReportedBalance(db, tenant.id, rail)
      const drift = providerBalance - ledgerBalance

      const open = db.alerts.find(
        (a) =>
          a.tenant_id === tenant.id &&
          a.provider === rail.provider &&
          a.currency === rail.currency &&
          a.resolved_at === null,
      )

      if (drift === 0) {
        // The books agree again. Close the alert, but leave the freeze — the
        // drift going away is not the same as someone having understood it.
        if (open) {
          open.resolved_at = nowIso()
          open.ledger_balance = ledgerBalance
          open.provider_balance = providerBalance
          open.drift = 0
          open.resolution_note = 'Balances agree on a later pass'
          audit(db, tenant.id, null, 'system', 'reconciliation.cleared', {
            provider: rail.provider,
            currency: rail.currency,
          })
          touched.push(open)
        }
        continue
      }

      if (open) {
        // Same disagreement, still there. One alert per rail, refreshed —
        // a new row every pass would bury the first report under a hundred
        // copies of itself.
        open.ledger_balance = ledgerBalance
        open.provider_balance = providerBalance
        open.drift = drift
        open.last_seen_at = nowIso()
        touched.push(open)
        continue
      }

      const alert: ReconciliationAlert = {
        id: nextId('rec'),
        tenant_id: tenant.id,
        provider: rail.provider,
        currency: rail.currency,
        ledger_balance: ledgerBalance,
        provider_balance: providerBalance,
        drift,
        detected_at: nowIso(),
        last_seen_at: nowIso(),
        resolved_at: null,
        resolution_note: null,
      }
      db.alerts.push(alert)
      touched.push(alert)
      raisedNew = true

      audit(db, tenant.id, null, 'system', 'reconciliation.mismatch', {
        provider: rail.provider,
        currency: rail.currency,
        ledger_balance: ledgerBalance,
        provider_balance: providerBalance,
        drift,
        action: 'payouts frozen',
      })
    }

    if (raisedNew && tenant.status === 'active') {
      tenant.status = 'payouts_frozen'
      audit(db, tenant.id, null, 'system', 'tenant.payouts_frozen', {
        reason: 'Reconciliation found a balance we cannot explain',
      })
    }
  }

  return touched
}

/**
 * Dev-panel lever: make a provider disagree with us.
 *
 * It sets the disagreement and then runs the real job, rather than writing an
 * alert directly. That distinction is the point of the exercise — the thing
 * being demonstrated is that the job *finds* drift, not that we can display an
 * alert we invented.
 */
export function injectDrift(db: MockDb, tenantId: string, amount: number): void {
  const rails = computeRailBalances(db, tenantId)
  const rail = rails.find((r) => r.held > 0) ?? rails[0]
  if (!rail) return

  db.provider_drift[driftKey(tenantId, rail.provider, rail.currency)] = amount
  runReconciliation(db, tenantId)
}

/** Convenience for callers that already hold the singleton. */
export function currentDb(): MockDb {
  return getDb()
}
