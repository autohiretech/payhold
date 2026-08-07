/**
 * Sending one payout — the path money actually leaves by.
 *
 * Two callers share it: the clearance cron, which sends everything whose
 * window has closed, and the approve-review endpoint, so a person who clears a
 * hold does not then wait an hour for the next pass. Keeping one implementation
 * is what stops "approve" quietly becoming a route that skips a check the cron
 * makes.
 *
 * The order below is the whole safety argument and none of it is arbitrary:
 *
 *   1. a frozen tenant stops here — drift means money we cannot account for,
 *      and it must stop moving before anything else is considered
 *   2. the deterministic rules screen it (invariant 11). They may hold it and
 *      may do nothing else
 *   3. the routing engine picks a destination and a rail, or blocks it (§5.1).
 *      It may also do nothing else
 *   4. the provider is called
 *   5. only then is it booked
 *
 * Step 4 before step 5 is deliberate and is the direction to fail in. If the
 * transfer succeeds and the booking does not, the next pass re-sends with the
 * same `idempotency_key`, the provider returns the same transfer, and it books
 * then. The reverse — booking a transfer that never left — would report a
 * seller paid who was not.
 *
 * Step 2 before step 3 also matters, and is a dependency rather than a
 * preference: `screen_payout` is what blocks a payout whose deal is disputed,
 * and `route_payout` un-blocks a payout it can route. Routing first would let a
 * disputed payout out of `blocked` and into the queue. The booking guard in
 * `settle_payout` still refuses it under the row lock — this ordering is what
 * keeps the *status* honest in between.
 */

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { amountLeaving } from './figures.ts'
import { loadProvider } from './load-provider.ts'
import { PayHoldError, type Deal, type Payout, type Provider } from './types.ts'

export type DispatchOutcome =
  /** Sent and booked. */
  | 'paid'
  /** Accepted by the provider, settling asynchronously. */
  | 'processing'
  /** A discretionary rule, or a person, stopped it. Only a person moves it. */
  | 'held_for_review'
  /** §12: something about the seller is outstanding. `verify_seller` is the way out. */
  | 'needs_verification'
  /** §5.1: no eligible route, or a dispute. Money kept, nothing rerouted. */
  | 'blocked'
  /** The tenant's payouts are frozen pending reconciliation. */
  | 'frozen'
  /** The provider refused. Retried on a later pass. */
  | 'failed'
  /** Not ours to send right now — a suspended tenant. */
  | 'skipped'

/**
 * Payout states a machine may send.
 *
 * `held_for_review` is deliberately absent and must stay absent: cron may never
 * be the thing that lets a payout past a rule or a person (invariant 11).
 *
 * `blocked` and `needs_verification` are present, and that is the difference
 * between them and a hold. Neither is waiting on a decision — one is waiting
 * for a route to exist, the other for somebody to attest to a fact — so a pass
 * that re-asks and finds the reason gone is not overruling anyone. It is the
 * same shape as `frozen` clearing once reconciliation is resolved.
 */
export const DISPATCHABLE = [
  'scheduled',
  'frozen',
  'processing',
  'blocked',
  'needs_verification',
] as const

/** One row of `payout_decisions` — §5.1's auditable choice. */
interface RouteDecision {
  id: string
  route_id: string | null
  destination_id: string | null
  provider: Provider | null
  reason_code: string
  is_fallback: boolean
}

export async function dispatchPayout(
  db: SupabaseClient,
  payout: Payout,
): Promise<DispatchOutcome> {
  const { data: tenant } = await db
    .from('tenants')
    .select('status')
    .eq('id', payout.tenant_id)
    .maybeSingle()

  if (tenant?.status === 'suspended') return 'skipped'

  if (tenant?.status === 'payouts_frozen') {
    const { error } = await db.rpc('freeze_payout', { p_payout_id: payout.id })
    if (error) throw new Error(`freeze_payout failed: ${error.message}`)
    return 'frozen'
  }

  // A payout already with the provider has been screened and routed once, and
  // the money is in flight. Re-running the rules could only hold something we
  // can no longer stop, which would misreport it to an operator as prevented;
  // re-routing it would be the silent redirection §5.1 forbids.
  let decision: RouteDecision

  if (payout.status === 'processing') {
    const { data } = await db
      .from('payout_decisions')
      .select('id, route_id, destination_id, provider, reason_code, is_fallback')
      .eq('payout_id', payout.id)
      .eq('reason_code', 'routed')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (!data) {
      throw new PayHoldError(
        'invalid_state',
        `Payout ${payout.id} is processing with no routing decision behind it`,
      )
    }
    decision = data as unknown as RouteDecision
  } else {
    const { data: held, error } = await db.rpc('screen_payout', {
      p_payout_id: payout.id,
    })
    if (error) throw new Error(`screen_payout failed: ${error.message}`)

    if (held) {
      // Which of the three stops it was is on the row. Read back rather than
      // returned, so `screen_payout` keeps the signature every existing caller
      // and test uses — a return type is the one thing `create or replace`
      // cannot change, and this is not worth a drop.
      const { data: stopped } = await db
        .from('payouts')
        .select('status')
        .eq('id', payout.id)
        .maybeSingle()

      return stopped?.status === 'needs_verification'
        ? 'needs_verification'
        : stopped?.status === 'blocked'
        ? 'blocked'
        : 'held_for_review'
    }

    // §5.1's routing engine. Deterministic, and it records what it decided
    // whether or not it found anything — `payout_decisions` is the audit.
    const { data: routed, error: routeError } = await db.rpc('route_payout', {
      p_payout: payout.id,
    })
    if (routeError) throw new Error(`route_payout failed: ${routeError.message}`)

    decision = routed as unknown as RouteDecision
    // Nothing eligible. The amount stays where it is and the reason is on the
    // payout — §5.1 is emphatic that funds are never discarded or rerouted.
    if (decision.reason_code !== 'routed') return 'blocked'
  }

  const { data: dealRow } = await db
    .from('deals')
    .select('id, tenant_id, seller_id, amount, currency, fee_amount, ' +
      'presentment_currency, presentment_amount, provider, status')
    .eq('id', payout.deal_id)
    .maybeSingle()

  if (!dealRow) throw new PayHoldError('not_found', `Deal ${payout.deal_id} not found`)
  const deal = dealRow as unknown as Deal

  // §8: a dispute freezes payout. `settle_payout` refuses a disputed deal under
  // the row lock, which is the guarantee; this is the same check made early so
  // the cron reports it as skipped rather than as an error, and so we do not
  // ask a provider to send money we are about to refuse to book.
  if (deal.status === 'disputed') return 'skipped'

  // The destination the routing engine chose — §5.1's record of where this
  // money went, read from `seller_destinations` rather than from the seller's
  // copy of it. That copy exists because Phase 4 could not move fifty call
  // sites at once; this is the one that had to move, because a seller now has
  // more than one destination and only the decision knows which was picked.
  const { data: destination } = await db
    .from('seller_destinations')
    .select('beneficiary_token, masked_destination')
    .eq('id', decision.destination_id ?? '')
    .maybeSingle()

  if (!destination) {
    throw new PayHoldError(
      'not_found',
      `Destination ${decision.destination_id} for payout ${payout.id} not found`,
    )
  }

  // What departs our balance, read back off the ledger rather than converted —
  // see `amountLeaving`. Computed before the transfer so a figure we cannot
  // derive stops the payout instead of stranding one that has already gone.
  const leaving = await amountLeaving(db, deal)

  // The rail comes from the decision, not from the seller's country: which
  // provider can pay where is `payout_routes` now, so a corridor can be
  // switched off without a deploy (§5.2 case 8). It still has to match the rail
  // the destination was tokenized against, which is exactly what the routing
  // engine's `preferred` filter guarantees — a beneficiary token minted by one
  // provider means nothing to another.
  //
  // Note the funding question this leaves open: `settle_payout` debits the
  // collecting rail's vault, so a tenant who collects on Stripe and pays out on
  // Flutterwave has to keep the Flutterwave balance topped up themselves. The
  // ledger is right either way; the provider balance is theirs to manage.
  let outcome: { provider_ref: string; status: 'pending' | 'paid' }

  try {
    if (!decision.provider) {
      throw new PayHoldError(
        'policy_violation',
        'The chosen route has no provider behind it',
      )
    }
    const { provider } = await loadProvider(db, payout.tenant_id, decision.provider)

    outcome = await provider.release({
      payout_id: payout.id,
      beneficiary_token: destination.beneficiary_token,
      amount: payout.amount,
      currency: payout.currency,
      // Stable across retries, which is what makes step 4 safe to repeat.
      idempotency_key: `payout:${payout.id}`,
    })
  } catch (err) {
    // A corridor we cannot pay, a rail with no implementation, a refused
    // transfer. All of them are the same thing to the seller — nothing arrived
    // — so all of them record a reason and wait for the next pass.
    const reason = err instanceof PayHoldError
      ? err.message
      : err instanceof Error
      ? err.message
      : String(err)

    const { error } = await db.rpc('fail_payout', {
      p_payout_id: payout.id,
      p_reason: reason,
    })
    if (error) throw new Error(`fail_payout failed: ${error.message}`)
    return 'failed'
  }

  if (outcome.status === 'pending') {
    const { error } = await db.rpc('mark_payout_processing', {
      p_payout_id: payout.id,
      p_provider_ref: outcome.provider_ref,
    })
    if (error) throw new Error(`mark_payout_processing failed: ${error.message}`)
    return 'processing'
  }

  const { error } = await db.rpc('settle_payout', {
    p_payout_id: payout.id,
    p_leaving: leaving,
    p_provider_ref: outcome.provider_ref,
  })
  if (error) throw new Error(`settle_payout failed: ${error.message}`)

  return 'paid'
}
