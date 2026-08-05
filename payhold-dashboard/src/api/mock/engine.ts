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
  type Dispute,
  type LedgerEntry,
  type LedgerEntryType,
  type PaymentMethod,
  type Payout,
  type Provider,
  type RailBalance,
  type TenantSettings,
} from '../types'
import { METHOD_LABEL, collectionRails, providerFor } from '@/lib/rails'
import { addDays, getDb, isDue, nextId, nowIso, type MockDb } from './store'

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
    currency: deal.currency,
    provider: deal.provider,
    provider_ref: deal.provider_ref,
    created_at: nowIso(),
  })
}

export function audit(
  db: MockDb,
  tenantId: string,
  dealId: string | null,
  actor: string,
  action: string,
  details: Record<string, unknown> = {},
): void {
  db.audit.push({
    id: nextId('aud'),
    tenant_id: tenantId,
    deal_id: dealId,
    actor,
    action,
    details,
    created_at: nowIso(),
  })
}

function touch(deal: Deal): void {
  deal.updated_at = nowIso()
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
export function fundDeal(db: MockDb, dealId: string, method?: PaymentMethod): Deal {
  const deal = requireDeal(db, dealId)
  if (deal.status !== 'created') {
    throw new PayHoldError(
      'invalid_state',
      `Deal ${dealId} is ${deal.status}, cannot be funded`,
    )
  }

  const chosen =
    method ?? collectionRails(deal.buyer_country, deal.currency)[0]?.method ?? 'card'
  const provider = providerFor(deal.buyer_country, deal.currency, chosen)

  if (!provider) {
    throw new PayHoldError(
      'policy_violation',
      `${METHOD_LABEL[chosen]} is not available for ${deal.currency} in ${deal.buyer_country}`,
    )
  }

  const cfg = settingsFor(db, deal.tenant_id)
  deal.status = 'funded_held'
  deal.payment_method = chosen
  deal.provider = provider
  deal.provider_ref = `${provider === 'stripe' ? 'pi' : 'FLW'}-${nextId('ref')}`
  deal.auto_release_at = addDays(
    deal.expected_complete_at ?? nowIso(),
    cfg.auto_release_days,
  )
  touch(deal)

  ledgerEntry(db, deal, 'hold', deal.amount)
  if (deal.deposit_amount) {
    ledgerEntry(db, deal, 'deposit_hold', deal.deposit_amount)
  }

  audit(db, deal.tenant_id, deal.id, 'system', 'webhook.verified', {
    provider: deal.provider,
  })
  audit(db, deal.tenant_id, deal.id, 'system', 'deal.funded_held', {
    amount: deal.amount,
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

  ledgerEntry(db, deal, 'release', -deal.amount)
  ledgerEntry(db, deal, 'fee', -deal.fee_amount)
  if (deal.deposit_amount && !depositSettled(db, deal.id)) {
    ledgerEntry(db, deal, 'deposit_release', -deal.deposit_amount)
  }

  db.payouts.push({
    id: nextId('po'),
    tenant_id: deal.tenant_id,
    deal_id: deal.id,
    seller_id: deal.seller_id,
    amount: deal.amount - deal.fee_amount,
    currency: deal.currency,
    status: 'scheduled',
    scheduled_for: deal.payout_due_at,
    paid_at: null,
    failure_reason: null,
    attempts: 0,
  })

  audit(db, deal.tenant_id, deal.id, 'system', 'deal.released', {
    fee_amount: deal.fee_amount,
    net: deal.amount - deal.fee_amount,
  })
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

  ledgerEntry(db, deal, 'refund', -deal.amount)
  if (deal.deposit_amount && !depositSettled(db, deal.id)) {
    ledgerEntry(db, deal, 'deposit_release', -deal.deposit_amount)
  }

  audit(db, deal.tenant_id, deal.id, 'dashboard', 'deal.refunded', { reason })
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
    status: 'open',
    opened_at: nowIso(),
    resolved_at: null,
    resolution_note: null,
  }
  db.disputes.push(dispute)

  deal.status = 'disputed'
  touch(deal)
  audit(db, deal.tenant_id, deal.id, `user:${raisedBy}`, 'deal.disputed', { reason })
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
  return dispute
}

// ---------------------------------------------------------------------------
// Payouts
// ---------------------------------------------------------------------------

function dispatchPayout(db: MockDb, payout: Payout): void {
  const tenant = db.tenants.find((t) => t.id === payout.tenant_id)
  if (tenant?.status === 'payouts_frozen') {
    payout.status = 'frozen'
    audit(db, payout.tenant_id, payout.deal_id, 'system', 'payout.frozen', {
      reason: 'Tenant payouts are frozen pending reconciliation',
    })
    return
  }

  payout.attempts += 1

  if (db.fail_next_payout) {
    db.fail_next_payout = false
    payout.status = 'failed'
    payout.failure_reason = 'Provider rejected the transfer (simulated failure)'
    audit(db, payout.tenant_id, payout.deal_id, 'system', 'payout.failed', {
      reason: payout.failure_reason,
      attempts: payout.attempts,
    })
    return
  }

  const deal = requireDeal(db, payout.deal_id)
  payout.status = 'paid'
  payout.paid_at = nowIso()
  payout.failure_reason = null

  ledgerEntry(db, deal, 'payout', -payout.amount)
  deal.status = 'paid_out'
  touch(deal)

  audit(db, payout.tenant_id, payout.deal_id, 'system', 'payout.paid', {
    amount: payout.amount,
    seller_id: payout.seller_id,
  })
}

export function retryPayout(db: MockDb, payoutId: string): Payout {
  const payout = db.payouts.find((p) => p.id === payoutId)
  if (!payout) throw new PayHoldError('not_found', `Payout ${payoutId} not found`)
  if (payout.status === 'paid') {
    throw new PayHoldError('invalid_state', 'This payout has already been sent')
  }
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
}

/**
 * One pass of everything the scheduled jobs do: fire auto-release timers, then
 * dispatch payouts whose clearance window has closed.
 */
export function runCron(db: MockDb): CronResult {
  const result: CronResult = { auto_released: 0, paid: 0, frozen: 0 }

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
    const dispatchable = payout.status === 'scheduled' || payout.status === 'frozen'
    if (!dispatchable || !isDue(payout.scheduled_for)) continue

    dispatchPayout(db, payout)
    if (payout.status === 'paid') result.paid += 1
    if (payout.status === 'frozen') result.frozen += 1
  }

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
    const b = bucket(provider, deal.currency)

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

export function injectDrift(db: MockDb, tenantId: string, amount: number): void {
  const balances = computeBalances(db, tenantId)
  const first = balances.find((b) => b.held > 0) ?? balances[0]
  const currency: Currency = first?.currency ?? 'RWF'
  const ledgerBalance = first?.held ?? 0

  db.alerts.push({
    id: nextId('rec'),
    tenant_id: tenantId,
    currency,
    ledger_balance: ledgerBalance,
    provider_balance: ledgerBalance + amount,
    drift: amount,
    detected_at: nowIso(),
    resolved_at: null,
  })

  const tenant = db.tenants.find((t) => t.id === tenantId)
  if (tenant) tenant.status = 'payouts_frozen'

  audit(db, tenantId, null, 'system', 'reconciliation.mismatch', {
    drift: amount,
    currency,
    action: 'payouts frozen',
  })
}

/** Convenience for callers that already hold the singleton. */
export function currentDb(): MockDb {
  return getDb()
}
