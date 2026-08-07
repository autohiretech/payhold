/**
 * The auto-release timer.
 *
 * The money model has two ways out of a hold: both sides confirm, or the timer
 * fires. This is the second one, and without it a seller whose buyer simply
 * never comes back is never paid — the funds sit held indefinitely, which is
 * the failure the whole product exists to prevent.
 *
 * `fund_deal` sets `auto_release_at` from the tenant's `auto_release_days` at
 * the moment the hold is booked, so the window a deal runs on is the one it was
 * created with. Nothing here re-reads that setting.
 *
 * How it releases matters. Rather than a release path of its own, it writes the
 * missing confirmations with `actor = 'auto'` and lets `confirm_deal` do what a
 * second human confirmation does. So the timer goes through the same row lock,
 * the same both-confirmations re-check and the same ledger writes — there is no
 * second way to release a deal that could drift from the first. The
 * confirmations record `auto`, so the audit trail still distinguishes a buyer
 * who agreed from a buyer who went quiet.
 *
 * A frozen tenant is NOT skipped. Releasing moves money between our own
 * buckets; it does not send anything. The payout it queues is what the freeze
 * stops, in `dispatchPayout`. Holding the release too would punish a seller for
 * a reconciliation problem that is not theirs.
 */

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { serviceClient } from '../_shared/auth.ts'
import { requireCronCaller } from '../_shared/cron-auth.ts'
import { releaseFigures } from '../_shared/figures.ts'
import { handler, json } from '../_shared/http.ts'
import {
  PAST_HOLD_STATUSES,
  type ConfirmSide,
  type Deal,
  type DealStatus,
} from '../_shared/types.ts'

/** Deals per pass. Each is a handful of round trips; the next pass takes more. */
const BATCH = 50

/**
 * The only statuses a timer may act on.
 *
 * `disputed` is absent deliberately: a dispute is the one thing that must stop
 * the clock, or a buyer who raised a complaint watches the money leave while
 * someone is still reading it. `confirm_deal` refuses a disputed deal under the
 * lock as well — this list only avoids asking.
 */
const RELEASABLE = ['funded_held', 'confirmed_buyer', 'confirmed_seller']

const DEAL_COLUMNS =
  'id, tenant_id, seller_id, amount, currency, fee_amount, ' +
  'presentment_currency, presentment_amount, status, auto_release_at'

/** Returns false when the deal turned out to be settled already. */
async function autoRelease(db: SupabaseClient, deal: Deal): Promise<boolean> {
  await db.rpc('write_audit', {
    p_tenant: deal.tenant_id,
    p_deal: deal.id,
    p_actor: 'system',
    p_action: 'deal.auto_release_fired',
    p_details: { auto_release_at: deal.auto_release_at },
  })

  const figures = await releaseFigures(db, deal)

  // Both sides, in order. Whichever call completes the pair releases inside its
  // own transaction; a side that already confirmed is a no-op rather than an
  // error, so a buyer who did confirm keeps their `user` actor and only the
  // silent side is recorded as `auto`.
  for (const side of ['buyer', 'seller'] as ConfirmSide[]) {
    const { data, error } = await db.rpc('confirm_deal', {
      p_deal_id: deal.id,
      p_side: side,
      p_actor: 'auto',
      ...figures,
    })

    if (error) {
      // Two passes overlapping, or one retried after a timeout: the other
      // finished the release between our select and this call. `confirm_deal`
      // refuses under the lock, which is correct and is not a failure — the
      // deal is released, which is what this pass wanted.
      if (/can no longer be confirmed/.test(error.message)) return false
      throw new Error(`confirm_deal(${side}) failed: ${error.message}`)
    }

    // The buyer call releases whenever the seller had already confirmed. Asking
    // for the second side afterwards would hit the refusal above.
    const status = (data as { status?: string } | null)?.status
    if (status && PAST_HOLD_STATUSES.includes(status as DealStatus)) break
  }

  return true
}

Deno.serve(handler(async (req) => {
  await requireCronCaller(req)

  const db = serviceClient()

  // A suspended account is one we have stopped serving. Its timers stop too,
  // rather than quietly settling deals while the tenant is locked out and
  // cannot see it happening.
  const { data: suspended } = await db
    .from('tenants')
    .select('id')
    .eq('status', 'suspended')

  const { data: due, error } = await db
    .from('deals')
    .select(DEAL_COLUMNS)
    .in('status', RELEASABLE)
    .not('auto_release_at', 'is', null)
    .lte('auto_release_at', new Date().toISOString())
    .order('auto_release_at', { ascending: true })
    .limit(BATCH)

  if (error) throw new Error(`deal lookup failed: ${error.message}`)

  const blocked = new Set((suspended ?? []).map((t) => t.id as string))
  const result = { considered: 0, auto_released: 0, skipped: 0, errored: 0 }

  for (const row of (due ?? []) as unknown as Deal[]) {
    result.considered += 1

    if (blocked.has(row.tenant_id)) {
      result.skipped += 1
      continue
    }

    try {
      if (await autoRelease(db, row)) result.auto_released += 1
      else result.skipped += 1
    } catch (err) {
      console.error('auto-release failed', {
        deal_id: row.id,
        tenant_id: row.tenant_id,
        message: err instanceof Error ? err.message : String(err),
      })
      result.errored += 1
    }
  }

  return json(req, result)
}))
