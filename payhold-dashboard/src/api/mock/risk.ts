/**
 * Deterministic risk rules — the "own risk rules" half of spec §6.
 *
 * The line these sit on is invariant 9. An AI code path may not touch money;
 * a *deterministic rule* may, and the difference is that this file's output is
 * a function of our own tables. The same deal and the same history always
 * produce the same hold, so an operator can reproduce a decision, and disagree
 * with it, without asking anyone what the model was thinking that day.
 *
 * What a rule can do is stop a payout. It cannot send one, cannot release, and
 * cannot refund — so the worst a wrong rule causes is a seller waiting for a
 * person to look, which is the direction you want to fail in. Releasing a hold
 * is always a human act (`approvePayoutReview`).
 *
 * Every rule is also written as a signal even when it does not hold anything.
 * The `info` rows are the labelled history spec §12.3 accumulates for a fraud
 * model of our own, and they cannot be backfilled — a signal nobody recorded
 * at the time is gone.
 */

import { convert } from '@/lib/fx'
import type {
  Deal,
  Payout,
  RiskSeverity,
  RiskSignal,
  RiskSignalKind,
  TenantSettings,
} from '../types'
import { hoursBetween, nextId, nowIso, type MockDb } from './store'

/** A rule that fired, before it is written down. */
export interface RiskFinding {
  signal: RiskSignalKind
  severity: RiskSeverity
  value: Record<string, unknown>
  explanation: string
}

// --- Thresholds the rules are written against -------------------------------
//
// These are the shape of the rules, not the tenant's policy — the one number a
// tenant actually tunes is `risk_review_threshold_usd`, per §17's promise that
// fees and limits change without a deploy.

/** A seller is "new" for this long after registration. */
const NEW_SELLER_DAYS = 7

/** Deals from one buyer inside this window that count as a burst. */
const VELOCITY_WINDOW_HOURS = 24
const VELOCITY_COUNT = 3

/** A prior loss stays relevant this long. */
const DISPUTE_LOOKBACK_DAYS = 90

/** Faster than this between funding and release is worth noticing. */
const FAST_RELEASE_MINUTES = 15

/** How many times the seller's previous largest payout counts as a jump. */
const LARGE_PAYOUT_MULTIPLE = 3

// ---------------------------------------------------------------------------
// Rules at funding — context, never a block
// ---------------------------------------------------------------------------

/**
 * What we can know the moment money lands. Nothing here holds anything: no
 * payout exists yet, and stopping a *deal* would mean holding a buyer's money
 * hostage to a rule, which is not a thing PayHold does.
 */
export function dealFindings(db: MockDb, deal: Deal): RiskFinding[] {
  const findings: RiskFinding[] = []
  const seller = db.sellers.find((s) => s.id === deal.seller_id)

  if (seller) {
    const ageDays = hoursBetween(seller.created_at, nowIso()) / 24
    if (ageDays <= NEW_SELLER_DAYS) {
      findings.push({
        signal: 'new_seller',
        severity: 'info',
        value: { seller_age_days: Math.round(ageDays * 10) / 10 },
        explanation: `${seller.name} registered ${Math.round(ageDays)} day${
          Math.round(ageDays) === 1 ? '' : 's'
        } ago.`,
      })
    }
  }

  const recent = db.deals.filter(
    (d) =>
      d.tenant_id === deal.tenant_id &&
      d.buyer_ref === deal.buyer_ref &&
      d.status !== 'created' &&
      hoursBetween(d.created_at, nowIso()) <= VELOCITY_WINDOW_HOURS,
  )
  if (recent.length >= VELOCITY_COUNT) {
    findings.push({
      signal: 'buyer_velocity',
      severity: 'info',
      value: {
        buyer_ref: deal.buyer_ref,
        deals: recent.length,
        window_hours: VELOCITY_WINDOW_HOURS,
      },
      explanation: `${deal.buyer_ref} has funded ${recent.length} deals in the last ${VELOCITY_WINDOW_HOURS} hours.`,
    })
  }

  return findings
}

// ---------------------------------------------------------------------------
// Rules before a payout — these can hold
// ---------------------------------------------------------------------------

/**
 * Everything known about the counterparties at the moment money would leave.
 *
 * This is the last point where stopping is cheap: after the transfer there is
 * no recall, only a request.
 */
export function payoutFindings(
  db: MockDb,
  payout: Payout,
  cfg: TenantSettings,
): RiskFinding[] {
  const findings: RiskFinding[] = []
  const deal = db.deals.find((d) => d.id === payout.deal_id)
  const seller = db.sellers.find((s) => s.id === payout.seller_id)

  const priorPaid = db.payouts.filter(
    (p) =>
      p.seller_id === payout.seller_id && p.id !== payout.id && p.status === 'paid',
  )

  // The tenant's threshold is one number in USD; a payout is in whatever the
  // seller banks in. Convert at compare time rather than making every tenant
  // maintain a limit per currency.
  const threshold =
    convert(cfg.risk_review_threshold_usd, 'USD', payout.currency)?.amount ?? null
  const isLarge = threshold !== null && payout.amount >= threshold

  // --- A first payout to a destination we have never sent to ---------------
  if (priorPaid.length === 0 && seller) {
    // Age is measured at the moment the deal was struck, not now. Measuring it
    // at payout time would make this rule unfireable: the clearance window is
    // seven days by default, so every seller is at least a week old by the
    // time their first payout comes due. What matters is that they registered
    // shortly before taking this booking.
    const reference = deal?.created_at ?? nowIso()
    const ageDays = hoursBetween(seller.created_at, reference) / 24
    const brandNew = ageDays <= NEW_SELLER_DAYS

    findings.push({
      signal: 'new_seller',
      severity: brandNew || isLarge ? 'review' : 'info',
      value: {
        seller_id: seller.id,
        seller_age_days_at_deal: Math.round(ageDays * 10) / 10,
        prior_payouts: 0,
        destination: seller.masked_destination,
      },
      explanation:
        `First payout to ${seller.name} (${seller.masked_destination}), who registered ` +
        `${Math.round(Math.abs(ageDays))} day${Math.round(Math.abs(ageDays)) === 1 ? '' : 's'} ` +
        `${ageDays < 0 ? 'after' : 'before'} this deal was created.`,
    })
  }

  // --- A jump well beyond anything this seller has been paid before --------
  const previousMax = priorPaid.reduce((max, p) => Math.max(max, p.amount), 0)
  if (isLarge && previousMax > 0 && payout.amount >= previousMax * LARGE_PAYOUT_MULTIPLE) {
    findings.push({
      signal: 'large_payout',
      severity: 'review',
      value: {
        amount: payout.amount,
        currency: payout.currency,
        previous_max: previousMax,
        multiple: Math.round((payout.amount / previousMax) * 10) / 10,
      },
      explanation:
        `This payout is ${Math.round((payout.amount / previousMax) * 10) / 10}× the ` +
        `largest this seller has been paid before.`,
    })
  }

  // --- A loss against this seller inside the lookback window ---------------
  const sellerDealIds = new Set(
    db.deals.filter((d) => d.seller_id === payout.seller_id).map((d) => d.id),
  )
  const lostDisputes = db.disputes.filter(
    (d) =>
      sellerDealIds.has(d.deal_id) &&
      d.status === 'resolved_refunded' &&
      d.resolved_at !== null &&
      hoursBetween(d.resolved_at, nowIso()) <= DISPUTE_LOOKBACK_DAYS * 24,
  )
  if (lostDisputes.length > 0) {
    findings.push({
      signal: 'prior_dispute',
      severity: 'review',
      value: {
        disputes: lostDisputes.length,
        lookback_days: DISPUTE_LOOKBACK_DAYS,
        most_recent: lostDisputes.at(-1)?.resolved_at ?? null,
      },
      explanation:
        `${lostDisputes.length} dispute${lostDisputes.length === 1 ? '' : 's'} ` +
        `resolved in the buyer's favour against this seller in the last ${DISPUTE_LOOKBACK_DAYS} days.`,
    })
  }

  // --- Funded and released almost immediately ------------------------------
  if (deal?.released_at) {
    const funded = db.ledger.find(
      (e) => e.deal_id === deal.id && e.entry_type === 'hold',
    )
    if (funded) {
      const minutes = hoursBetween(funded.created_at, deal.released_at) * 60
      if (minutes >= 0 && minutes <= FAST_RELEASE_MINUTES) {
        findings.push({
          signal: 'fast_release',
          severity: isLarge ? 'review' : 'info',
          value: { minutes: Math.round(minutes), threshold: FAST_RELEASE_MINUTES },
          explanation: `Funded and released within ${Math.round(minutes)} minutes.`,
        })
      }
    }
  }

  return findings
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Write the findings down.
 *
 * Recording happens whether or not the rules are switched on for this tenant —
 * `risk_rules_enabled` governs whether a payout is *held*, not whether we
 * notice. A tenant who turns the rules off and later wants them still has the
 * history to judge what they would have caught.
 */
export function recordFindings(
  db: MockDb,
  tenantId: string,
  dealId: string,
  sellerId: string | null,
  findings: RiskFinding[],
): RiskSignal[] {
  const created = nowIso()

  return findings.map((finding) => {
    const signal: RiskSignal = {
      id: nextId('risk'),
      tenant_id: tenantId,
      deal_id: dealId,
      seller_id: sellerId,
      signal: finding.signal,
      severity: finding.severity,
      value: finding.value,
      explanation: finding.explanation,
      created_at: created,
    }
    db.risk_signals.push(signal)
    return signal
  })
}
