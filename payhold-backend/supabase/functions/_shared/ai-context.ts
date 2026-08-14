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
    /**
     * What the buyer was actually charged. §7.1 gives the model a split to
     * recommend, and a split needs a ceiling — a `partial_refund` for more than
     * this is not a split, and the validator discards it.
     */
    presentment_amount: Money
  }
  seller: { name: string; country: string | null; registered_at: Timestamp } | null
  dispute: {
    id: string
    raised_by: 'buyer' | 'seller'
    opened_at: Timestamp
    /** Free text from a party to the deal. Wrapped as untrusted in the prompt. */
    reason: string
    /** §8's structured code, which is ours rather than a party's. */
    reason_code: string
    /**
     * Presentment minor units, or null for the whole payment. It is a ceiling on
     * what any recommendation may take from the seller — `resolve_dispute`
     * refuses more, so a draft proposing more is a draft nobody can approve.
     */
    disputed_amount: Money | null
  }
  /**
   * §8's evidence. Descriptions only — PayHold stores no bytes, and a model that
   * cannot see the photo can still weigh "inspection photo taken at handover,
   * showing no damage" against a complaint that the item arrived damaged.
   *
   * Every one of these is written by a party to the deal, so it is wrapped as
   * untrusted in the prompt for the same reason the opening statement is: it is
   * *about* the question being asked, which makes it the injection surface.
   */
  evidence: {
    uploaded_by: 'buyer' | 'seller'
    kind: string
    description: string
    captured_at: Timestamp | null
    created_at: Timestamp
  }[]
  /**
   * What the parties have already offered each other. A draft that recommends
   * exactly the split one side declined yesterday is a draft that wastes an
   * administrator's afternoon.
   */
  offers: {
    offered_by: 'buyer' | 'seller'
    kind: string
    amount: Money | null
    status: string
    created_at: Timestamp
  }[]
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
    country: string | null
    payout_currency: string | null
    masked_destination: string | null
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
 * Phase 8 closed the gap this comment used to record: §8's `dispute_evidence`
 * and `dispute_offers` exist now, so the assistant weighs what both sides filed
 * and what they have already offered each other, not just the opening sentence.
 * That is the whole of `dispute-assistant@2`.
 *
 * What is still absent is a counter-statement column — the respondent's case
 * arrives as evidence of kind `message` rather than as a field of its own. Worth
 * knowing when reading a draft that says the seller never replied.
 */
export async function disputeCaseFile(
  db: SupabaseClient,
  tenantId: string,
  disputeId: string,
): Promise<{ file: DisputeCaseFile; deal_id: string }> {
  const { data: dispute } = await db
    .from('disputes')
    .select('id, deal_id, raised_by, reason, reason_code, disputed_amount, status, opened_at')
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

  // §8's case file, and the reason this is `dispute-assistant@2`. Both queries
  // run under the `payhold_ai` role's own policies, so they are scoped to this
  // tenant whether or not the filter above is right.
  const [{ data: evidence }, { data: offers }] = await Promise.all([
    db
      .from('dispute_evidence')
      .select('uploaded_by, kind, description, captured_at, created_at')
      .eq('dispute_id', dispute.id)
      .order('created_at', { ascending: true }),
    db
      .from('dispute_offers')
      .select('offered_by, kind, amount, status, created_at')
      .eq('dispute_id', dispute.id)
      .order('created_at', { ascending: true }),
  ])

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
        presentment_amount: deal.presentment_amount,
      },
      seller: seller
        ? { name: seller.name, country: seller.country, registered_at: seller.created_at }
        : null,
      dispute: {
        id: dispute.id as string,
        raised_by: dispute.raised_by as 'buyer' | 'seller',
        opened_at: dispute.opened_at as string,
        reason: dispute.reason as string,
        reason_code: dispute.reason_code as string,
        disputed_amount: (dispute.disputed_amount as number | null) ?? null,
      },
      evidence: (evidence ?? []).map((e) => ({
        uploaded_by: e.uploaded_by as 'buyer' | 'seller',
        kind: e.kind as string,
        description: e.description as string,
        captured_at: (e.captured_at as string | null) ?? null,
        created_at: e.created_at as string,
      })),
      offers: (offers ?? []).map((o) => ({
        offered_by: o.offered_by as 'buyer' | 'seller',
        kind: o.kind as string,
        amount: (o.amount as number | null) ?? null,
        status: o.status as string,
        created_at: o.created_at as string,
      })),
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
