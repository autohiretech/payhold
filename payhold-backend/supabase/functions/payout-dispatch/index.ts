/**
 * Clearance → payout dispatch. The cron that ends the deal lifecycle.
 *
 * `release_deal` queues a payout with a `scheduled_for` at the end of the
 * tenant's clearance window. This is what picks it up. Until it runs, a
 * released deal is money the seller has been promised and not sent.
 *
 * Everything about how one payout is sent — the freeze check, the risk
 * screening, the provider call, the booking — lives in `_shared/dispatch.ts`,
 * shared with the approve-review endpoint. This file is only the pass: which
 * payouts are due, and making sure one bad row cannot stop the rest.
 *
 * It must run *after* the reconciliation pass, never before. Drift freezes a
 * tenant's payouts, and a dispatch that went first would send money out of a
 * balance we already know we cannot explain. The schedules in
 * `scripts/schedule-cron.sql` are staggered for exactly that reason.
 */

import { serviceClient } from '../_shared/auth.ts'
import { requireCronCaller } from '../_shared/cron-auth.ts'
import { DISPATCHABLE, dispatchPayout, type DispatchOutcome } from '../_shared/dispatch.ts'
import { handler, json } from '../_shared/http.ts'
import type { Payout } from '../_shared/types.ts'

/**
 * Payouts per pass. Each one is a provider round trip, and an Edge Function
 * has a wall clock — the next pass takes the rest, oldest first.
 */
const BATCH = 25

Deno.serve(handler(async (req) => {
  await requireCronCaller(req)

  const db = serviceClient()

  // Promote deals whose clearance window has closed, before looking for
  // payouts. Same pass, and in this order: a payout becomes dispatchable at
  // `payout_due_at`, which is the same instant the deal stops clearing, so
  // running the scan first would dispatch against a deal still claiming to be
  // inside its safety window — and `settle_payout` would then have to promote
  // it after the fact, which is the recovery path and not the normal one.
  const { data: cleared, error: matureError } = await db.rpc('mature_clearing_deals', {})

  if (matureError) throw new Error(`clearing sweep failed: ${matureError.message}`)

  const now = new Date().toISOString()

  const { data: due, error } = await db
    .from('payouts')
    .select('id, tenant_id, deal_id, seller_id, amount, currency, status, ' +
      'scheduled_for, paid_at, failure_reason, attempts, next_attempt_at')
    // `held_for_review` is not in this list and must never be. Cron is not
    // allowed to be the thing that lets a held payout through — invariant 11.
    // `blocked` and `needs_verification` are in it, on purpose: neither is
    // waiting on a decision, so re-asking overrules nobody. See `DISPATCHABLE`.
    .in('status', DISPATCHABLE)
    .lte('scheduled_for', now)
    // §13's backoff, and the reason it is a filter here rather than a branch in
    // `dispatchPayout`: a null `next_attempt_at` means no machine may try this
    // again, and `lte` excludes nulls by construction. The approve and retry
    // endpoints share `dispatchPayout` and are unaffected — a person is not a
    // machine, which is the whole distinction the column encodes.
    .lte('next_attempt_at', now)
    .order('scheduled_for', { ascending: true })
    .limit(BATCH)

  if (error) throw new Error(`payout lookup failed: ${error.message}`)

  const result: Record<DispatchOutcome | 'considered' | 'errored' | 'cleared', number> = {
    cleared: (cleared ?? []).length,
    considered: (due ?? []).length,
    paid: 0,
    processing: 0,
    held_for_review: 0,
    needs_verification: 0,
    blocked: 0,
    frozen: 0,
    failed: 0,
    skipped: 0,
    errored: 0,
  }

  for (const payout of (due ?? []) as unknown as Payout[]) {
    // One seller's payout failing in a way we did not anticipate must not
    // strand every other seller waiting behind it in the batch.
    try {
      result[await dispatchPayout(db, payout)] += 1
    } catch (err) {
      console.error('payout dispatch failed', {
        payout_id: payout.id,
        tenant_id: payout.tenant_id,
        message: err instanceof Error ? err.message : String(err),
      })
      result.errored += 1
    }
  }

  return json(req, result)
}))
