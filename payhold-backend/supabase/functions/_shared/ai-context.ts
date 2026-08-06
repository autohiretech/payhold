/**
 * The case file — everything the model is shown, and nothing else.
 *
 * This is the narrow end of the funnel. Whatever else the AI layer can reach,
 * only what these two functions return actually enters a prompt, so this is the
 * right place to be strict about three things:
 *
 *   1. **One tenant.** Every query filters on the tenant, and the role the
 *      queries run as would return nothing if one forgot (see `ai-db.ts`).
 *   2. **No PII, no secrets.** The deal's `buyer_ref` is the client's own
 *      identifier for their customer and is frequently an email; it is omitted
 *      because nothing the model is asked to judge depends on it. Sellers
 *      appear with a name and a masked destination — never a
 *      `beneficiary_token`, which is the credential that would let money be
 *      redirected.
 *   3. **Stable ordering.** The file is hashed, and the hash is what makes a
 *      decision reproducible and a cached draft safe. Two identical situations
 *      must serialise identically, so everything here is ordered explicitly
 *      rather than however the database felt like returning it.
 *
 * The file is plain data, deliberately: it is what gets hashed, what gets shown
 * to the model, and what an auditor reads six months later to ask why the draft
 * said what it said.
 */

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { PayHoldError, type Money, type Timestamp } from './types.ts'

const DEAL_COLUMNS =
  'id, tenant_id, seller_id, description, amount, currency, presentment_amount, ' +
  'presentment_currency, buyer_country, provider, payment_method, status, ' +
  'expected_complete_at, auto_release_at, released_at, fee_amount, created_at'

interface DealRow {
  id: string
  tenant_id: string
  seller_id: string
  description: string
  amount: Money
  currency: string
  presentment_amount: Money
  presentment_currency: string
  buyer_country: string
  provider: string
  payment_method: string | null
  status: string
  expected_complete_at: Timestamp | null
  auto_release_at: Timestamp | null
  released_at: Timestamp | null
  fee_amount: Money
  created_at: Timestamp
}

interface SellerRow {
  id: string
  name: string
  country: string
  payout_currency: string
  masked_destination: string
  created_at: Timestamp
}

export interface TimelineEvent {
  /** An `audit_log` id. The model is told to cite these and nothing else. */
  ref: string
  at: Timestamp
  action: string
  actor: string
}

export interface DisputeCaseFile {
  deal: {
    id: string
    description: string
    amount: Money
    currency: string
    status: string
    created_at: Timestamp
    expected_complete_at: Timestamp | null
  }
  seller: { name: string; country: string; registered_at: Timestamp } | null
  dispute: {
    id: string
    raised_by: 'buyer' | 'seller'
    opened_at: Timestamp
    /** Free text from a party to the deal. Wrapped as untrusted in the prompt. */
    reason: string
  }
  confirmations: { side: string; actor: string; confirmed_at: Timestamp }[]
  timeline: TimelineEvent[]
  seller_history: {
    deals_on_this_account: number
    completed: number
    prior_disputes: number
    prior_disputes_lost: number
  }
}

export interface RiskCaseFile {
  deal: {
    id: string
    description: string
    amount: Money
    currency: string
    status: string
    provider: string
    created_at: Timestamp
  }
  seller: {
    name: string
    country: string
    payout_currency: string
    masked_destination: string
    registered_at: Timestamp
    age_days: number
  } | null
  history: {
    deals_on_this_account: number
    completed: number
    prior_disputes: number
    prior_disputes_lost: number
    largest_previous_payout: Money
  }
  size: {
    amount: Money
    tenant_average: Money
    ratio: number
  }
  destination_changed_at: Timestamp | null
  /**
   * What the deterministic rules already noticed. Given to the narrator as
   * findings to explain, never as findings to reproduce — the rules are what
   * may hold a payout, and they run whether or not the model does.
   */
  risk_signals: { signal: string; severity: string; explanation: string | null }[]
  timeline: TimelineEvent[]
}

function daysBetween(from: string, to: string): number {
  return Math.round((new Date(to).getTime() - new Date(from).getTime()) / 86_400_000)
}

async function loadDeal(
  db: SupabaseClient,
  tenantId: string,
  dealId: string,
): Promise<DealRow> {
  const { data } = await db
    .from('deals')
    .select(DEAL_COLUMNS)
    .eq('id', dealId)
    .eq('tenant_id', tenantId)
    .maybeSingle()

  // A deal belonging to another tenant is a 404, never a 403 — §4. Here the
  // role would not have returned the row anyway; the message keeps the two
  // cases indistinguishable regardless.
  if (!data) throw new PayHoldError('not_found', `Deal ${dealId} not found`)
  return data as unknown as DealRow
}

async function loadSeller(
  db: SupabaseClient,
  sellerId: string,
): Promise<SellerRow | null> {
  const { data } = await db
    .from('sellers')
    .select('id, name, country, payout_currency, masked_destination, created_at')
    .eq('id', sellerId)
    .maybeSingle()

  return (data as SellerRow | null) ?? null
}

async function loadTimeline(
  db: SupabaseClient,
  dealId: string,
  limit = 60,
): Promise<TimelineEvent[]> {
  const { data } = await db
    .from('audit_log')
    .select('id, created_at, action, actor')
    .eq('deal_id', dealId)
    .order('created_at', { ascending: true })
    .limit(limit)

  return (data ?? []).map((row) => ({
    ref: row.id as string,
    at: row.created_at as string,
    action: row.action as string,
    actor: row.actor as string,
  }))
}

/** This seller's record on this account, which is what a reader wants to weigh. */
async function sellerHistory(
  db: SupabaseClient,
  tenantId: string,
  sellerId: string,
  excludeDealId: string,
) {
  const { data: deals } = await db
    .from('deals')
    .select('id, status, amount')
    .eq('tenant_id', tenantId)
    .eq('seller_id', sellerId)

  const rows = (deals ?? []) as { id: string; status: string; amount: Money }[]
  const otherIds = rows.map((d) => d.id).filter((id) => id !== excludeDealId)

  let priors: { status: string }[] = []
  if (otherIds.length > 0) {
    const { data } = await db
      .from('disputes')
      .select('status')
      .eq('tenant_id', tenantId)
      .in('deal_id', otherIds)
    priors = (data ?? []) as { status: string }[]
  }

  return {
    deals: rows,
    deals_on_this_account: rows.length,
    completed: rows.filter((d) => d.status === 'paid_out').length,
    prior_disputes: priors.length,
    prior_disputes_lost: priors.filter((d) => d.status === 'resolved_refunded').length,
  }
}

/**
 * Everything the dispute assistant reads.
 *
 * Note what is absent, because the honest gap matters more than the list: the
 * schema has no evidence table and no counter-statement column yet, so the
 * model weighs the opening reason, the timeline and the seller's record. The
 * dashboard mock models richer disputes; when those columns land here, this is
 * the function that grows and the prompt version that bumps.
 */
export async function disputeCaseFile(
  db: SupabaseClient,
  tenantId: string,
  disputeId: string,
): Promise<{ file: DisputeCaseFile; deal_id: string }> {
  const { data: dispute } = await db
    .from('disputes')
    .select('id, deal_id, raised_by, reason, status, opened_at')
    .eq('id', disputeId)
    .eq('tenant_id', tenantId)
    .maybeSingle()

  if (!dispute) throw new PayHoldError('not_found', `Dispute ${disputeId} not found`)

  if (dispute.status !== 'open') {
    throw new PayHoldError('invalid_state', 'That dispute is already resolved')
  }

  const deal = await loadDeal(db, tenantId, dispute.deal_id as string)
  const seller = await loadSeller(db, deal.seller_id)
  const history = await sellerHistory(db, tenantId, deal.seller_id, deal.id)

  const { data: confirmations } = await db
    .from('confirmations')
    .select('side, actor, confirmed_at')
    .eq('deal_id', deal.id)
    .order('confirmed_at', { ascending: true })

  return {
    deal_id: deal.id,
    file: {
      deal: {
        id: deal.id,
        description: deal.description,
        amount: deal.amount,
        currency: deal.currency,
        status: deal.status,
        created_at: deal.created_at,
        expected_complete_at: deal.expected_complete_at,
      },
      seller: seller
        ? { name: seller.name, country: seller.country, registered_at: seller.created_at }
        : null,
      dispute: {
        id: dispute.id as string,
        raised_by: dispute.raised_by as 'buyer' | 'seller',
        opened_at: dispute.opened_at as string,
        reason: dispute.reason as string,
      },
      confirmations: (confirmations ?? []).map((c) => ({
        side: c.side as string,
        actor: c.actor as string,
        confirmed_at: c.confirmed_at as string,
      })),
      timeline: await loadTimeline(db, deal.id),
      seller_history: {
        deals_on_this_account: history.deals_on_this_account,
        completed: history.completed,
        prior_disputes: history.prior_disputes,
        prior_disputes_lost: history.prior_disputes_lost,
      },
    },
  }
}

/**
 * Everything the risk narrator reads.
 *
 * It is handed the deterministic rules' own findings alongside the raw
 * material. That is deliberate: the narrator's job is to explain what is known
 * about the counterparties to the person deciding, not to re-derive a
 * conclusion the rules already reached — the rules are what can hold a payout,
 * and they hold it whether the model runs or not.
 */
export async function riskCaseFile(
  db: SupabaseClient,
  tenantId: string,
  dealId: string,
): Promise<{ file: RiskCaseFile; deal_id: string }> {
  const deal = await loadDeal(db, tenantId, dealId)
  const seller = await loadSeller(db, deal.seller_id)
  const history = await sellerHistory(db, tenantId, deal.seller_id, deal.id)

  // What this company normally does, in this currency. A figure that is large
  // in the abstract may be routine here, and the reverse.
  const { data: sameCurrency } = await db
    .from('deals')
    .select('amount')
    .eq('tenant_id', tenantId)
    .eq('currency', deal.currency)

  const amounts = (sameCurrency ?? []).map((d) => d.amount as number)
  const average = amounts.length
    ? Math.round(amounts.reduce((sum, a) => sum + a, 0) / amounts.length)
    : deal.amount

  const { data: paid } = await db
    .from('payouts')
    .select('amount')
    .eq('tenant_id', tenantId)
    .eq('seller_id', deal.seller_id)
    .eq('status', 'paid')
    .order('amount', { ascending: false })
    .limit(1)

  // A payout destination that moved days before a payout is the classic
  // account-takeover shape, and the single line a reviewer most wants surfaced.
  const { data: changed } = await db
    .from('audit_log')
    .select('created_at')
    .eq('tenant_id', tenantId)
    .eq('action', 'seller.destination_updated')
    .contains('details', { seller_id: deal.seller_id })
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  const { data: signals } = await db
    .from('risk_signals')
    .select('signal, severity, explanation')
    .eq('tenant_id', tenantId)
    .eq('deal_id', deal.id)
    .order('created_at', { ascending: true })

  return {
    deal_id: deal.id,
    file: {
      deal: {
        id: deal.id,
        description: deal.description,
        amount: deal.amount,
        currency: deal.currency,
        status: deal.status,
        provider: deal.provider,
        created_at: deal.created_at,
      },
      seller: seller
        ? {
          name: seller.name,
          country: seller.country,
          payout_currency: seller.payout_currency,
          masked_destination: seller.masked_destination,
          registered_at: seller.created_at,
          // Measured at the deal's creation, not now. With a seven-day
          // clearance window every seller is a week old by the time their
          // first payout comes due, so measuring at payout time would make
          // "brand-new seller" a thing nobody could ever observe.
          age_days: daysBetween(seller.created_at, deal.created_at),
        }
        : null,
      history: {
        deals_on_this_account: history.deals_on_this_account,
        completed: history.completed,
        prior_disputes: history.prior_disputes,
        prior_disputes_lost: history.prior_disputes_lost,
        largest_previous_payout: (paid?.[0]?.amount as number) ?? 0,
      },
      size: {
        amount: deal.amount,
        tenant_average: average,
        ratio: average ? Math.round((deal.amount / average) * 100) / 100 : 1,
      },
      destination_changed_at: (changed?.created_at as string | undefined) ?? null,
      risk_signals: (signals ?? []).map((s) => ({
        signal: s.signal as string,
        severity: s.severity as string,
        explanation: (s.explanation as string | null) ?? null,
      })),
      timeline: await loadTimeline(db, deal.id, 40),
    },
  }
}
