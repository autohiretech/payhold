/**
 * Payouts — what is owed, what was sent, and the one lever over a risk hold.
 *
 *   GET  /payouts                     this tenant's payouts, newest first
 *   GET  /payouts/:id                 one, with the signals that stopped it
 *   POST /payouts/:id/hold            stop one. A person only
 *   POST /payouts/:id/approve-review  clear a hold. A person only
 *   POST /payouts/:id/retry           re-attempt one the provider refused
 *
 * The three POSTs look similar and are deliberately not interchangeable.
 * `retry` is for a provider that said no — nothing judged the payout, so
 * sending it again is just sending it again. `approve-review` is for a payout a
 * rule or a person stopped, and it exists so that clearing a hold is an act by
 * a named person recorded against them (invariant 11). Letting `retry` move a
 * held payout would make it a button that skips review, so it refuses.
 *
 * `hold` is the other direction, and it is the reason an operator no longer has
 * to freeze a whole tenant to stop one seller. It takes a reason and refuses an
 * API key for the same argument `approve-review` does: a stop is a judgement,
 * and a judgement wants somebody who can be asked why.
 */

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { requireRole, resolveCaller, serviceClient, type Caller } from '../_shared/auth.ts'
import { dispatchPayout } from '../_shared/dispatch.ts'
import { handler, json } from '../_shared/http.ts'
import { PayHoldError, type Payout } from '../_shared/types.ts'

const PAYOUT_COLUMNS =
  'id, tenant_id, deal_id, seller_id, amount, currency, status, scheduled_for, ' +
  'paid_at, failure_reason, attempts, next_attempt_at, provider_ref, destination_id, review_held_at, ' +
  'review_held_by, review_hold_reason, review_approved_by, review_approved_at, created_at'

async function getPayout(
  db: SupabaseClient,
  caller: Caller,
  id: string,
): Promise<Payout> {
  const { data } = await db
    .from('payouts')
    .select(PAYOUT_COLUMNS)
    .eq('id', id)
    .eq('tenant_id', caller.tenant_id)
    .maybeSingle()

  // Another tenant's payout is a 404, never a 403 — spec §4.
  if (!data) throw new PayHoldError('not_found', `Payout ${id} not found`)
  return data as unknown as Payout
}

/**
 * The signals behind a hold, so an approver sees what they are overriding — and
 * the routing decision behind where it was going.
 *
 * §5.1 wants a payout decision auditable after the fact and the display status
 * shown "with the reason and the next action", so both travel with the payout
 * rather than being a second call somebody has to know to make.
 */
async function withSignals(
  db: SupabaseClient,
  payout: Payout,
): Promise<Record<string, unknown>> {
  const [{ data: signals }, { data: routing }, { data: display }] = await Promise.all([
    db
      .from('risk_signals')
      .select('signal, severity, value, explanation, created_at')
      .eq('deal_id', payout.deal_id)
      .order('created_at', { ascending: false }),
    db
      .from('payout_decisions')
      .select('route_id, destination_id, provider, payout_provider, method, ' +
        'currency, amount, ranking_score, fee_estimate, fx_source, fx_rate, ' +
        'is_fallback, reason_code, checks, created_at')
      .eq('payout_id', payout.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    db.rpc('payout_display_status', { p_payout: payout.id }),
  ])

  return {
    ...payout,
    // §5.1's seven-state vocabulary, derived. `status` keeps every distinction
    // an operator needs; this is the one a seller is shown.
    display_status: display ?? null,
    risk_signals: signals ?? [],
    routing: routing ?? null,
  }
}

/**
 * Clear a risk hold.
 *
 * An API key is refused here, and that refusal is the point rather than an
 * oversight. Invariant 11 says a person clears a hold; a key is a program, and
 * a client that could approve its own held payouts from its own server has
 * turned the rules into a formality. `review_approved_by` has to name someone
 * who can be asked why.
 */
async function approveReview(
  req: Request,
  db: SupabaseClient,
  caller: Caller,
  id: string,
): Promise<Response> {
  if (caller.kind !== 'dashboard') {
    throw new PayHoldError(
      'unauthorized',
      'A held payout can only be approved by a signed-in person, not by an API key',
    )
  }
  requireRole(caller, 'owner', 'staff')

  const payout = await getPayout(db, caller, id)

  const { error } = await db.rpc('approve_payout_review', {
    p_payout_id: payout.id,
    p_approved_by: caller.actor,
  })
  if (error) throw rpcError(error, 'approve this payout')

  // Send it now rather than waiting for the next pass. The approval is the
  // decision; making someone wait an hour to see it take effect invites them to
  // press the button again.
  const approved = await getPayout(db, caller, id)
  const outcome = await dispatchPayout(db, approved)

  return json(req, {
    payout: await withSignals(db, await getPayout(db, caller, id)),
    outcome,
  })
}

/**
 * Stop one payout.
 *
 * The narrow lever the product was missing: before this, an operator who
 * noticed something the rules do not model could only freeze the entire tenant,
 * which stops every honest seller to stop one. A key is refused here for the
 * same reason it is on `approve-review` — this is a judgement, and
 * `review_held_by` has to name someone who can be asked why.
 */
async function hold(
  req: Request,
  db: SupabaseClient,
  caller: Caller,
  id: string,
): Promise<Response> {
  if (caller.kind !== 'dashboard') {
    throw new PayHoldError(
      'unauthorized',
      'A payout can only be held by a signed-in person, not by an API key',
    )
  }
  requireRole(caller, 'owner', 'staff')

  const body = await req.json().catch(() => ({})) as { reason?: unknown }
  const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
  if (!reason) {
    throw new PayHoldError(
      'policy_violation',
      'A hold must say why — the person clearing it has nothing else to go on',
    )
  }

  // Resolved through the tenant filter first, so another tenant's payout is a
  // 404 here rather than an error out of the money function.
  const payout = await getPayout(db, caller, id)

  const { error } = await db.rpc('hold_payout', {
    p_payout_id: payout.id,
    p_held_by: caller.actor,
    p_reason: reason,
  })
  if (error) throw rpcError(error, 'hold this payout')

  return json(req, {
    payout: await withSignals(db, await getPayout(db, caller, id)),
  })
}

async function retry(
  req: Request,
  db: SupabaseClient,
  caller: Caller,
  id: string,
): Promise<Response> {
  requireRole(caller, 'owner', 'staff')

  const payout = await getPayout(db, caller, id)

  if (payout.status === 'paid') {
    throw new PayHoldError('invalid_state', 'This payout has already been sent')
  }
  if (payout.status === 'held_for_review') {
    throw new PayHoldError(
      'invalid_state',
      'This payout is held for review — approve it to send it',
    )
  }
  // `blocked` is deliberately not refused: re-attempting is exactly what a
  // person wants once they have enabled a route or resolved a dispute, and the
  // dispatch path re-asks both questions before it sends anything.
  if (payout.status === 'needs_verification') {
    throw new PayHoldError(
      'invalid_state',
      'This seller has something outstanding — verify them to send it',
    )
  }
  // A failure `refund_deal` itself wrote is permanent — release already
  // reversed and there is no clearing pool left to pay from, ever, unlike
  // a rail's own transient block (IP whitelisting, a timeout). dispatch
  // below would already skip it silently (its own PAYABLE_DEAL_STATUSES
  // check), so this is the difference between a clear refusal and a
  // wasted attempt with no explanation — the same reasoning
  // `hold_payout` refuses the identical case for.
  if (payout.status === 'failed' && payout.failure_reason === 'Deal was refunded') {
    throw new PayHoldError(
      'invalid_state',
      'This deal was refunded — there is nothing left to send',
    )
  }

  // Put the automatic clock back before sending. §13's backoff stops after
  // `payout_retry_max_attempts` by clearing `next_attempt_at`, and a payout a
  // person re-attempted must be visible to the cron again — otherwise one
  // manual attempt is all it ever gets, and if that attempt is the one that
  // times out, the payout leaves the queue silently.
  //
  // The attempt *counter* is deliberately untouched: `route_payout` reads it to
  // decide whether the seller's verified backup destination may be used, and
  // zeroing it would quietly send this attempt back to the primary that has
  // been failing.
  const { error: resetError } = await db.rpc('reset_payout_retry', {
    p_payout_id: payout.id,
    p_actor: caller.actor,
  })
  if (resetError) throw rpcError(resetError, 're-attempt this payout')

  const outcome = await dispatchPayout(db, await getPayout(db, caller, id))

  return json(req, {
    payout: await withSignals(db, await getPayout(db, caller, id)),
    outcome,
  })
}

/** Same mechanical mapping the deals function uses on a money-function error. */
function rpcError(error: { message: string }, what: string): PayHoldError {
  const message = error.message

  for (
    const code of
      ['not_found', 'invalid_state', 'policy_violation', 'insufficient_balance'] as const
  ) {
    if (message.startsWith(code)) {
      return new PayHoldError(code, message.slice(code.length + 2).trim())
    }
  }

  console.error(`unmapped ${what} failure`, { message })
  return new PayHoldError('policy_violation', `Could not ${what}`)
}

Deno.serve(handler(async (req) => {
  const db = serviceClient()
  const caller = await resolveCaller(db, req)

  const segments = new URL(req.url).pathname.split('/').filter(Boolean)
  const base = segments.indexOf('payouts')
  const id = segments[base + 1]
  const action = segments[base + 2]

  if (req.method === 'GET' && !id) {
    const url = new URL(req.url)
    let query = db
      .from('payouts')
      .select(PAYOUT_COLUMNS)
      .eq('tenant_id', caller.tenant_id)
      .order('scheduled_for', { ascending: false })
      .limit(Math.min(Number(url.searchParams.get('limit') ?? 100), 500))

    const status = url.searchParams.get('status')
    if (status) query = query.in('status', status.split(','))

    const { data } = await query
    return json(req, { payouts: data ?? [] })
  }

  if (!id) {
    throw new PayHoldError('policy_violation', `${req.method} is not supported here`)
  }

  if (req.method === 'GET' && !action) {
    return json(req, await withSignals(db, await getPayout(db, caller, id)))
  }

  if (req.method !== 'POST') {
    throw new PayHoldError('policy_violation', `${req.method} is not supported here`)
  }

  switch (action) {
    case 'hold':
      return await hold(req, db, caller, id)
    case 'approve-review':
      return await approveReview(req, db, caller, id)
    case 'retry':
      return await retry(req, db, caller, id)
    default:
      throw new PayHoldError('not_found', `No such action "${action ?? ''}"`)
  }
}))
