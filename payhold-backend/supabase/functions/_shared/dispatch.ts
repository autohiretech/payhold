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
 *   3. the provider is called
 *   4. only then is it booked
 *
 * Step 3 before step 4 is deliberate and is the direction to fail in. If the
 * transfer succeeds and the booking does not, the next pass re-sends with the
 * same `idempotency_key`, the provider returns the same transfer, and it books
 * then. The reverse — booking a transfer that never left — would report a
 * seller paid who was not.
 */

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { amountLeaving } from './figures.ts'
import { loadProvider } from './load-provider.ts'
import { payoutProviderFor } from './rails.ts'
import { PayHoldError, type Deal, type Payout } from './types.ts'

export type DispatchOutcome =
  /** Sent and booked. */
  | 'paid'
  /** Accepted by the provider, settling asynchronously. */
  | 'processing'
  /** A risk rule stopped it. Only a person moves it now. */
  | 'held_for_review'
  /** The tenant's payouts are frozen pending reconciliation. */
  | 'frozen'
  /** The provider refused. Retried on a later pass. */
  | 'failed'
  /** Not ours to send right now — a suspended tenant. */
  | 'skipped'

/** Payout states a machine may send. `held_for_review` is deliberately absent. */
export const DISPATCHABLE = ['scheduled', 'frozen', 'processing'] as const

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

  // A payout already with the provider has been screened once and the money is
  // in flight. Re-running the rules could only hold something we can no longer
  // stop, which would misreport it to an operator as prevented.
  if (payout.status !== 'processing') {
    const { data: held, error } = await db.rpc('screen_payout', {
      p_payout_id: payout.id,
    })
    if (error) throw new Error(`screen_payout failed: ${error.message}`)
    if (held) return 'held_for_review'
  }

  const { data: dealRow } = await db
    .from('deals')
    .select('id, tenant_id, seller_id, amount, currency, fee_amount, ' +
      'presentment_currency, presentment_amount, provider, status')
    .eq('id', payout.deal_id)
    .maybeSingle()

  if (!dealRow) throw new PayHoldError('not_found', `Deal ${payout.deal_id} not found`)
  const deal = dealRow as unknown as Deal

  const { data: seller } = await db
    .from('sellers')
    .select('country, payout_currency, beneficiary_token')
    .eq('id', payout.seller_id)
    .maybeSingle()

  if (!seller) throw new PayHoldError('not_found', `Seller ${payout.seller_id} not found`)

  // What departs our balance, read back off the ledger rather than converted —
  // see `amountLeaving`. Computed before the transfer so a figure we cannot
  // derive stops the payout instead of stranding one that has already gone.
  const leaving = await amountLeaving(db, deal)

  // The rail the seller can be *paid* on, which is not the rail that collected:
  // a Rwandan host is paid by Flutterwave even when a Stripe card funded the
  // deal. This must match the rail `sellers` tokenized against, because a
  // beneficiary token minted by one provider means nothing to another.
  //
  // Note the funding question this leaves open: `settle_payout` debits the
  // collecting rail's vault, so a tenant who collects on Stripe and pays out on
  // Flutterwave has to keep the Flutterwave balance topped up themselves. The
  // ledger is right either way; the provider balance is theirs to manage.
  let outcome: { provider_ref: string; status: 'pending' | 'paid' }

  try {
    const rail = payoutProviderFor(seller.country, seller.payout_currency)
    const { provider } = await loadProvider(db, payout.tenant_id, rail)

    outcome = await provider.release({
      payout_id: payout.id,
      beneficiary_token: seller.beneficiary_token,
      amount: payout.amount,
      currency: payout.currency,
      // Stable across retries, which is what makes step 3 safe to repeat.
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
