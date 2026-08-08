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

  // The selection moved into SQL when `payout_mode = 'wallet'` arrived, and the
  // batch limit is why. In wallet mode a cleared payout is not due until
  // somebody asks for it, and filtering those out *after* `limit 25` would let
  // one tenant's unasked-for backlog fill the pass and starve every other
  // tenant — quietly, and for as long as the backlog stood. The predicate has
  // to be inside the limit.
  //
  // `DISPATCHABLE` is still owned here and passed in, rather than restated in
  // the function: `held_for_review` is absent from it and must stay absent,
  // because cron may never be the thing that lets a held payout through
  // (invariant 11), and that reasoning belongs next to the list.
  const { data: due, error } = await db.rpc('due_payouts', {
    p_statuses: DISPATCHABLE,
    p_limit: BATCH,
  })

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
