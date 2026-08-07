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
  PAST_HOLD_STATUSES,
  PayHoldError,
  type Balance,
  type ConfirmSide,
  type Currency,
  type Deal,
  type DealAmounts,
  type DealOutcome,
  type Dispute,
  type LedgerEntry,
  type LedgerEntryType,
  type PaymentMethod,
  type Payout,
  type PayoutStatus,
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
  hoursBetween,
  isDue,
  nextId,
  nowIso,
  type MockDb,
} from './store'
import { dealFindings, payoutFindings, recordFindings } from './risk'
import { primaryDestination, routePayout } from './routing'
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

  emitWebhook(db, deal.tenant_id, 'order.funded_held', deal.id, {
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
    // §10.2: the seller delivers, the buyer accepts. One event per side, and
    // the confirmation row is what knows which — and whether the timer did it.
    emitWebhook(
      db,
      deal.tenant_id,
      side === 'seller' ? 'order.delivered' : 'order.accepted',
      deal.id,
      { side, actor },
    )
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
  if (PAST_HOLD_STATUSES.includes(deal.status)) return deal

  const cfg = settingsFor(db, deal.tenant_id)
  const releasedAt = nowIso()

  // §6.1's new-seller reserve. Off unless the tenant has set a rate, so an
  // account that has not configured one behaves exactly as it did before V2.
  // "New" is counted in payouts actually *paid* — a transfer that worked is
  // what the reserve is waiting to observe.
  const rate = cfg.reserve_rate ?? 0
  let reserve = 0
  let reserveDays = 0

  if (rate > 0) {
    const priorPaid = db.payouts.filter(
      (p) => p.seller_id === deal.seller_id && p.status === 'paid',
    ).length

    if (priorPaid < (cfg.reserve_after_payouts ?? 3)) {
      const pool =
        deal.presentment_amount -
        presentmentFee(deal) -
        deal.provider_fee_amount -
        deal.tax_amount
      reserve = Math.floor(pool * rate)
      reserveDays = cfg.reserve_days ?? 30
    }
  }

  // §6: the money leaves the hold here and the safety window starts. `released`
  // is the far side of that window — see `20260807000002_lifecycle.sql`.
  deal.status = 'clearing'
  deal.released_at = releasedAt
  // §14: a deal that carried its own policy at creation wins over the tenant
  // setting, and keeps it however the setting moves afterwards. A reserve is
  // extra days on top (§6.1), ending exactly when the payout comes due — one
  // payout per deal, so a reserve outliving it would have nothing to send it.
  deal.payout_due_at = addDays(
    releasedAt,
    (deal.completion_policy.clearing_days ?? cfg.clearance_days) + reserveDays,
  )
  deal.reserve_amount = reserve
  deal.reserve_until = reserve > 0 ? deal.payout_due_at : null
  touch(deal)

  // What the buyer paid, less anything already sent back. Releasing the
  // original figure would let out money that is no longer there.
  const refundedAlready = db.refunds
    .filter((r) => r.deal_id === deal.id && r.status !== 'failed')
    .reduce((n, r) => n + r.amount, 0)

  ledgerEntry(db, deal, 'release', -(deal.presentment_amount - refundedAlready))
  ledgerEntry(db, deal, 'fee', -presentmentFee(deal))
  if (deal.tax_amount > 0) ledgerEntry(db, deal, 'tax', -deal.tax_amount)
  if (reserve > 0) ledgerEntry(db, deal, 'reserve', -reserve)
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

  emitWebhook(db, deal.tenant_id, 'order.clearing_started', deal.id, {
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

/**
 * §7.1 — full, partial or line-item.
 *
 * `amount` omitted means everything still refundable, which is what every V1
 * caller meant. What is refundable is `presentment_amount` less what has
 * already gone back; the guard is cumulative and lives here for the same reason
 * the release guard lives under the row lock in SQL.
 *
 * **A partial refund does not change the deal's status** (§29.8). It is an
 * amount, not a lifecycle position — a deal refunded by a third still has to be
 * delivered, cleared and paid out for the other two thirds.
 */
export function refundDeal(
  db: MockDb,
  dealId: string,
  reason: string,
  amount?: number,
  lineItems?: unknown,
  actor = 'dashboard',
): Deal {
  const deal = requireDeal(db, dealId)

  if (deal.status === 'refunded') return deal
  if (
    !HOLDING_STATUSES.includes(deal.status) &&
    !PAST_HOLD_STATUSES.includes(deal.status)
  ) {
    throw new PayHoldError('invalid_state', 'Nothing has been collected to refund')
  }

  const payout = db.payouts.find((p) => p.deal_id === deal.id)
  if (payout?.status === 'processing') {
    throw new PayHoldError(
      'policy_violation',
      'A payout for this deal is in flight — wait for it to settle',
    )
  }

  // A failed refund never left, so it does not count against what is still
  // refundable. A pending one does: it is expected to.
  const already = db.refunds
    .filter((r) => r.deal_id === deal.id && r.status !== 'failed')
    .reduce((n, r) => n + r.amount, 0)
  const refundable = deal.presentment_amount - already

  if (refundable <= 0) {
    throw new PayHoldError(
      'policy_violation',
      'Nothing further is refundable on this deal',
    )
  }

  const value = amount ?? refundable

  if (!Number.isInteger(value) || value <= 0) {
    throw new PayHoldError('policy_violation', 'A refund must be a positive amount')
  }
  if (value > refundable) {
    throw new PayHoldError(
      'policy_violation',
      `Refund of ${value} exceeds the ${refundable} still refundable on this deal`,
    )
  }

  const full = value === refundable
  const pastHold = PAST_HOLD_STATUSES.includes(deal.status)

  db.refunds.push({
    id: nextId('rfn'),
    tenant_id: deal.tenant_id,
    deal_id: deal.id,
    amount: value,
    currency: deal.presentment_currency,
    reason,
    line_items: lineItems ?? null,
    status: deal.status === 'paid_out' ? 'pending' : 'succeeded',
    actor,
    created_at: nowIso(),
    settled_at: deal.status === 'paid_out' ? null : nowIso(),
  })

  // §7.1.4. The money is with the seller and is not ours to send.
  if (deal.status === 'paid_out') {
    ledgerEntry(db, deal, 'receivable', value)
    audit(db, deal.tenant_id, deal.id, actor, 'refund.receivable_raised', {
      amount: value,
      reason,
      note: 'The seller has already been paid. This needs a person.',
    })
    return deal
  }

  if (pastHold) {
    // §7.1.3. Put it back in the hold, then take it out to the buyer. Booking
    // only the refund would drive `held` negative — the release has already
    // cancelled the hold.
    const poolBefore = clearingPool(db, deal.id)
    ledgerEntry(db, deal, 'release', value)
    ledgerEntry(db, deal, 'refund', -value)

    if (payout && poolBefore > 0 && payout.status !== 'paid') {
      payout.amount = Math.max(
        1,
        Math.floor((payout.amount * clearingPool(db, deal.id)) / poolBefore),
      )
    }
  } else {
    ledgerEntry(db, deal, 'refund', -value)
  }

  if (!full) {
    audit(db, deal.tenant_id, deal.id, actor, 'deal.partially_refunded', {
      amount: value,
      refundable_before: refundable,
      reason,
    })
    touch(deal)
    return deal
  }

  // The one refund that is a lifecycle event.
  deal.status = 'refunded'
  touch(deal)

  if (deal.deposit_amount && !depositSettled(db, deal.id)) {
    ledgerEntry(db, deal, 'deposit_release', -deal.deposit_amount)
  }

  // Nothing is owed any more, so nothing should be scheduled.
  if (payout && ['scheduled', 'frozen', 'held_for_review'].includes(payout.status)) {
    payout.status = 'failed'
    payout.failure_reason = 'Deal was refunded'
  }

  audit(db, deal.tenant_id, deal.id, actor, 'deal.refunded', { reason, amount: value })
  emitWebhook(db, deal.tenant_id, 'refund.succeeded', deal.id, {
    reason,
    amount: value,
    currency: deal.presentment_currency,
  })

  if (!db.disputes.some((d) => d.deal_id === deal.id)) {
    recordOutcome(db, deal, 'refunded', 'client_refund', reason)
  }
  return deal
}

/** The clearing pool for one deal — the mirror of SQL's `deal_clearing_pool`. */
function clearingPool(db: MockDb, dealId: string): number {
  let pool = 0
  for (const e of db.ledger) {
    if (e.deal_id !== dealId) continue
    if (e.entry_type === 'release') pool -= e.amount
    else if (POOL_DEDUCTIONS.includes(e.entry_type)) pool += e.amount
  }
  return pool
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

  // §6 adds `clearing -> disputed`. A chargeback or a complaint does not wait
  // politely for the safety window to end — and freezing during clearing is
  // most of what having a window is for.
  if (!HOLDING_STATUSES.includes(deal.status) && deal.status !== 'clearing') {
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
  emitWebhook(db, deal.tenant_id, 'dispute.opened', deal.id, {
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
 * §12: what stops this seller being paid at all, as opposed to what a rule
 * finds worth a second look. The mirror of SQL's `seller_capabilities` plus
 * §5.1's change protection.
 *
 * Every reason, not the first — a client showing a seller what is missing
 * should not make them fix one thing at a time.
 */
function sellerEligibility(db: MockDb, payout: Payout): string[] {
  const seller = db.sellers.find((s) => s.id === payout.seller_id)
  if (!seller) return ['The seller no longer exists']

  const reasons: string[] = []

  if (seller.kyc_status !== 'verified') {
    reasons.push(`Identity is ${seller.kyc_status}, not verified`)
  }
  if (!seller.sanctions_checked_at) {
    reasons.push('Sanctions screening has not been run')
  }

  const destination = primaryDestination(db, seller.id)
  if (!destination) {
    reasons.push('No payout destination has been registered')
  } else if (!destination.verified_at) {
    reasons.push('The payout destination has not been verified')
  }

  // §5.1: a newly moved destination waits, so a stolen session cannot redirect
  // a payout and have it leave before anybody notices.
  if (seller.destination_changed_at) {
    const hours = hoursBetween(seller.destination_changed_at, nowIso())
    if (hours < 24) reasons.push('The payout destination changed in the last 24 hours')
  }

  // A routing failure is deliberately **not** in this list. If it were, an
  // unroutable payout would be held as `needs_verification`, the routing engine
  // would never see it — no decision row, no reason code — and a seller would be
  // told to verify something that is already verified. §5.1's answer to "we
  // cannot reach you" is `blocked`, with the checks behind it.
  return reasons
}

/**
 * Run the deterministic rules against a payout that is about to leave.
 *
 * Returns true when the payout was held. The signals are written either way —
 * the record of what we noticed is worth keeping even when nothing was worth
 * stopping for, because that is the history a model of our own trains on.
 */
function screenPayout(db: MockDb, payout: Payout): boolean {
  const cfg = settingsFor(db, payout.tenant_id)

  // §8 outranks everything, and is nobody's to clear from here: the payout
  // moves when the dispute resolves and not before. `blocked` rather than
  // `needs_verification` because there is nothing for the seller to verify.
  if (requireDeal(db, payout.deal_id).status === 'disputed') {
    if (payout.status !== 'blocked') {
      payout.status = 'blocked'
      payout.failure_reason = 'The deal is disputed'
      audit(db, payout.tenant_id, payout.deal_id, 'system', 'payout.blocked', {
        payout_id: payout.id,
        reason_code: 'deal_disputed',
      })
    }
    return true
  }

  // §12's eligibility gate, and it is **not** behind `risk_rules_enabled`, nor
  // behind an earlier approval. The discretionary rules below are arithmetic a
  // tenant may reasonably decline to act on; "we have never verified this
  // seller" is not, and neither is an approval that predates a revocation.
  const reasons = sellerEligibility(db, payout)

  if (reasons.length > 0) {
    // Written on entry and on a change of reasons, not on every pass:
    // `needs_verification` is re-screened by the dispatcher, and §12.3's labels
    // cannot be backfilled, which makes drowning them in duplicates costly.
    const last = [...db.risk_signals]
      .filter((r) => r.deal_id === payout.deal_id && r.signal === 'not_eligible')
      .pop()
    const changed = JSON.stringify((last?.value as { reasons?: string[] })?.reasons) !==
      JSON.stringify(reasons)

    if (changed) {
      recordFindings(db, payout.tenant_id, payout.deal_id, payout.seller_id, [
        {
          signal: 'not_eligible',
          severity: 'review',
          value: { reasons },
          explanation: `This seller cannot be paid yet: ${reasons.join('; ')}.`,
        },
      ])
    }

    if (payout.status !== 'needs_verification') {
      payout.status = 'needs_verification'
      payout.review_held_at = nowIso()

      audit(db, payout.tenant_id, payout.deal_id, 'system', 'payout.needs_verification', {
        payout_id: payout.id,
        eligibility: reasons,
      })
    }
    return true
  }

  // Nothing outstanding any more. Somebody attested to the missing fact, so the
  // payout goes back in the queue rather than waiting for a pass that would
  // never come.
  if (payout.status === 'needs_verification') {
    payout.status = 'scheduled'
    payout.review_held_at = null
    audit(db, payout.tenant_id, payout.deal_id, 'system', 'payout.eligible', {
      payout_id: payout.id,
    })
  }

  // Already looked at by a person: their decision stands over the discretionary
  // rules, and re-running those would let a rule overrule the human who
  // overruled it. It does not stand over the gate above — that is the point of
  // the ordering.
  if (payout.review_approved_at) return false

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
  // provider's reliability. It also covers §8 — a disputed deal is blocked
  // here, which is why this runs before routing rather than after: routing
  // un-blocks a payout it can route, and would let a disputed one back out.
  if (screenPayout(db, payout)) return

  // §5.1's routing engine. Deterministic, and it records what it decided
  // whether or not it found anything — the decision is the audit.
  if (routePayout(db, payout).reason_code !== 'routed') return

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
  // A settled transfer proves the window is over, so a deal still clearing is
  // promoted rather than skipped — the same recovery path `settle_payout` takes.
  if (deal.status === 'clearing') {
    deal.status = 'released'
    audit(db, deal.tenant_id, deal.id, 'system', 'deal.cleared', {
      reason: 'payout settled',
      payout_due_at: deal.payout_due_at,
    })
  }
  deal.status = 'paid_out'
  touch(deal)

  audit(db, payout.tenant_id, payout.deal_id, 'system', 'payout.paid', {
    amount: payout.amount,
    seller_id: payout.seller_id,
  })
  emitWebhook(db, payout.tenant_id, 'payout.paid', payout.deal_id, {
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
  // `blocked` is deliberately not refused: re-attempting is exactly what a
  // person wants once they have enabled a route or resolved a dispute, and
  // dispatch re-asks both questions before it sends anything.
  if (payout.status === 'needs_verification') {
    throw new PayHoldError(
      'invalid_state',
      'This seller has something outstanding — verify them to send it',
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
  /** Reserves whose hold ended this pass, returned to the clearing pool. */
  reserves_released: number
  /** Deals whose clearance window closed this pass: `clearing` → `released`. */
  cleared: number
  paid: number
  frozen: number
  held_for_review: number
  /** §12: stopped because something about the seller is outstanding. */
  needs_verification: number
  /** §5.1: no eligible route, or a disputed deal. */
  blocked: number
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
 *   3. the reserve sweep — §6.1 carve-outs whose hold has ended go back into
 *      the pool, before anything reads that pool
 *   4. the clearing sweep — deals whose safety window has closed become
 *      `released`, which is what makes their payout dispatchable
 *   5. payout dispatch for anything now released
 *   6. outbound webhook delivery, last, so this pass's own events go out
 */
/**
 * Payout states a machine may send. The mirror of `DISPATCHABLE` in
 * `_shared/dispatch.ts`, and the reasoning is in the loop below.
 */
const DISPATCHABLE: PayoutStatus[] = [
  'scheduled',
  'frozen',
  'blocked',
  'needs_verification',
]

export function runCron(db: MockDb): CronResult {
  const result: CronResult = {
    auto_released: 0,
    reserves_released: 0,
    cleared: 0,
    paid: 0,
    frozen: 0,
    held_for_review: 0,
    needs_verification: 0,
    blocked: 0,
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

  // Return any reserve whose hold has ended, before the clearing sweep. Both
  // are keyed on the same instant, and a deal that matured while its reserve
  // was still carved out would offer the dispatcher a pool short by it.
  for (const deal of db.deals) {
    if (deal.reserve_amount <= 0 || !isDue(deal.reserve_until)) continue
    if (db.ledger.some((e) => e.deal_id === deal.id && e.entry_type === 'reserve_release')) {
      continue
    }

    ledgerEntry(db, deal, 'reserve_release', deal.reserve_amount)
    audit(db, deal.tenant_id, deal.id, 'system', 'deal.reserve_released', {
      amount: deal.reserve_amount,
      reserve_until: deal.reserve_until,
    })
    result.reserves_released += 1
  }

  // Promote deals whose clearance window has closed, before looking at
  // payouts. Same order as `payout-dispatch`: a payout becomes dispatchable at
  // `payout_due_at`, which is the same instant the deal stops clearing, so
  // dispatching first would send against a deal still claiming to be inside its
  // safety window. Disputed and refunded deals are excluded by the status
  // check, so a dispute opened during clearing freezes the promotion.
  for (const deal of db.deals) {
    if (deal.status !== 'clearing' || !isDue(deal.payout_due_at)) continue

    deal.status = 'released'
    touch(deal)
    audit(db, deal.tenant_id, deal.id, 'system', 'deal.cleared', {
      payout_due_at: deal.payout_due_at,
    })
    emitWebhook(db, deal.tenant_id, 'order.released', deal.id, {
      payout_due_at: deal.payout_due_at,
    })
    result.cleared += 1
  }

  for (const payout of db.payouts) {
    // `held_for_review` is deliberately absent and must stay absent: cron must
    // never be the thing that lets a payout past a rule or a person.
    //
    // `blocked` and `needs_verification` are present, and that is the
    // difference between them and a hold. Neither is waiting on a decision —
    // one waits for a route to exist, the other for somebody to attest to a
    // fact — so a pass that re-asks and finds the reason gone overrules nobody.
    // The same shape as `frozen` clearing once reconciliation is resolved.
    if (!DISPATCHABLE.includes(payout.status) || !isDue(payout.scheduled_for)) continue

    dispatchPayout(db, payout)
    if (payout.status === 'paid') result.paid += 1
    if (payout.status === 'frozen') result.frozen += 1
    if (payout.status === 'held_for_review') result.held_for_review += 1
    if (payout.status === 'needs_verification') result.needs_verification += 1
    if (payout.status === 'blocked') result.blocked += 1
  }

  result.webhooks_delivered = deliverPending(db).delivered

  return result
}

// ---------------------------------------------------------------------------
// Balances — derived from the ledger, never stored
// ---------------------------------------------------------------------------

const HELD_TYPES: LedgerEntryType[] = ['hold', 'release', 'refund']

/**
 * Everything that comes out of the seller's clearing pool. `release` credits it
 * and is handled separately; these all debit it, except `reserve_release`,
 * which is stored positive and so adds back on its own.
 *
 * **Keep this identical to `POOL_ENTRY_TYPES` in the backend's `figures.ts` and
 * to the `clearing` expression in `rail_balances`.** A type present in one and
 * missing from another sends a seller money that is not theirs.
 */
const POOL_DEDUCTIONS: LedgerEntryType[] = [
  'fee',
  'provider_fee',
  'tax',
  'reserve',
  'reserve_release',
  'payout',
]

/**
 * Six buckets, per currency, computed entirely from ledger entries:
 *
 *   held              hold + release + refund  (nets to zero once settled)
 *   clearing pool     −release, less every deduction that is not the seller's
 *   split of that     by each deal's payout_due_at → pending / available
 *   reserved          §6.1's carve-out, taken out of the pool and unpayable
 *   fees_retained     our commission and collected tax: no longer the
 *                     seller's, and still sitting in the provider balance
 *   paid_out          the payout entries, unsigned
 *
 * `fees_retained` is the bucket whose absence made every released deal look
 * like drift — see `payhold-backend/.../20260807000004_money_breakdown.sql`.
 * Only `paid_out` describes money that actually left.
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
        reserved: 0,
        fees_retained: 0,
        paid_out: 0,
      }
      byCurrency.set(rail.currency, b)
    }
    b.held += rail.held
    b.pending_clearance += rail.pending_clearance
    b.available += rail.available
    b.reserved += rail.reserved
    b.fees_retained += rail.fees_retained
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
        reserved: 0,
        fees_retained: 0,
        paid_out: 0,
      })
    }
  }

  return [...byCurrency.values()].sort((a, b) => a.currency.localeCompare(b.currency))
}

/**
 * §7's breakdown for one deal — the counterpart of the backend's
 * `deal_amounts()`, derived from the ledger and never stored.
 *
 * All in the presentment currency. On an unfunded deal every figure is zero,
 * deliberately: this describes money that moved, and the estimate a checkout
 * shows before payment comes from the deal's own columns.
 */
export function computeDealAmounts(db: MockDb, dealId: string): DealAmounts {
  const deal = requireDeal(db, dealId)
  const entries = db.ledger.filter((e) => e.deal_id === dealId)

  // Deductions are stored negative and reported positive, and negating zero in
  // JavaScript yields `-0` — which serialises as `-0` and compares unequal to
  // `0` under `Object.is`. `|| 0` normalises it; a breakdown should never hand
  // a client a negative zero.
  const sum = (...types: LedgerEntryType[]) =>
    entries.filter((e) => types.includes(e.entry_type)).reduce((n, e) => n + e.amount, 0)
  const owed = (...types: LedgerEntryType[]) => -sum(...types) || 0

  let sellerNet = 0
  for (const e of entries) {
    if (e.entry_type === 'release') sellerNet -= e.amount
    if (POOL_DEDUCTIONS.includes(e.entry_type)) sellerNet += e.amount
  }

  return {
    currency: deal.presentment_currency,
    buyer_paid: sum('hold'),
    platform_fee: owed('fee'),
    provider_fee: owed('provider_fee'),
    tax: owed('tax'),
    reserve: owed('reserve', 'reserve_release'),
    refunded: owed('refund'),
    receivable: sum('receivable'),
    paid_out: owed('payout'),
    seller_net: sellerNet,
  }
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
        reserved: 0,
        fees_retained: 0,
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
    let reserved = 0
    let retained = 0
    let paid = 0

    for (const e of entries) {
      if (HELD_TYPES.includes(e.entry_type)) held += e.amount
      if (e.entry_type === 'release') clearing -= e.amount
      // Everything that is not the seller's comes out of the pool. This list
      // must match `amountLeaving`'s and the SQL's, or a payout sends money the
      // pool says is spoken for.
      if (POOL_DEDUCTIONS.includes(e.entry_type)) clearing += e.amount
      // Carved out of the pool rather than gone. `reserve` is stored negative
      // and `reserve_release` positive, so the two net to zero when it ends.
      if (e.entry_type === 'reserve' || e.entry_type === 'reserve_release') {
        reserved -= e.amount
      }
      // Stopped being the seller's, still in the vault.
      if (e.entry_type === 'fee' || e.entry_type === 'tax') retained -= e.amount
      if (e.entry_type === 'payout') paid -= e.amount
    }

    // Attribute to the rail recorded on the entries, not the deal — a deal's
    // provider can change when the buyer picks their method, and the ledger is
    // the record of where the money actually went.
    const provider = entries[0]?.provider ?? deal.provider
    const b = bucket(provider, entries[0]?.currency ?? deal.presentment_currency)

    b.held += held
    b.paid_out += paid
    b.reserved += reserved
    b.fees_retained += retained
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
 * balance endpoint.
 *
 * **This used to be our own expected figure plus injected drift**, which made
 * the comparison self-fulfilling: whatever the buckets said, the "provider"
 * agreed. That is why the mock never noticed that the platform fee made every
 * released deal drift — it could not, by construction.
 *
 * So it is now derived independently, from money that genuinely crossed the
 * provider boundary: buyer payments in, the rail's own fee out, refunds out,
 * payouts out. `release`, `fee`, `tax`, `reserve` and `reserve_release` are
 * reclassifications between our own buckets and appear nowhere here — which is
 * exactly the property the bucket maths has to satisfy for the two to agree.
 *
 * Deposits are excluded, as they are from the buckets: a pre-auth is the
 * buyer's money held against damage, not the tenant's balance.
 */
const CROSSES_THE_BOUNDARY: LedgerEntryType[] = [
  'hold',
  'provider_fee',
  'refund',
  'payout',
]

function providerReportedBalance(
  db: MockDb,
  tenantId: string,
  rail: RailBalance,
): number {
  let actual = 0

  for (const e of db.ledger) {
    if (e.tenant_id !== tenantId || e.deal_id === null) continue
    if (e.provider !== rail.provider || e.currency !== rail.currency) continue
    // Signed already: a hold credits, a fee and a payout debit.
    if (CROSSES_THE_BOUNDARY.includes(e.entry_type)) actual += e.amount
  }

  return actual + (db.provider_drift[driftKey(tenantId, rail.provider, rail.currency)] ?? 0)
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
      // Five buckets, not three. `reserved` and `fees_retained` are money that
      // has stopped being the seller's without leaving the provider — omitting
      // them made every released deal report drift equal to our own commission,
      // and drift freezes payouts. See the backend's `reconcile/index.ts`.
      const ledgerBalance =
        rail.held +
        rail.pending_clearance +
        rail.available +
        rail.reserved +
        rail.fees_retained
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
