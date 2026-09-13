/**
 * Payouts — what is owed, what was sent, and the one lever over a risk hold.
 *
 *   GET  /payouts                     this tenant's payouts, newest first
 *   GET  /payouts/:id                 one, with the signals that stopped it
 *   POST /payouts/:id/hold            stop one. A person only
 *   POST /payouts/:id/approve-review  clear a hold. A person only
 *   POST /payouts/:id/retry           re-attempt one the provider refused
 *   POST /payouts/:id/pull-back       ask the rail to return one it is holding
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
import { loadProvider } from '../_shared/load-provider.ts'
import { PayHoldError, type Payout, type Provider } from '../_shared/types.ts'

const PAYOUT_COLUMNS =
  'id, tenant_id, deal_id, seller_id, amount, currency, status, scheduled_for, ' +
  'paid_at, failure_reason, attempts, next_attempt_at, provider_ref, destination_id, review_held_at, ' +
  'review_held_by, review_hold_reason, review_approved_by, review_approved_at, created_at, ' +
  // Where the rail says this transfer is, and when it last said so. A hand-
  // maintained column list is how `provider_ref` went missing from two
  // endpoints and made a manual "Send it now" re-POST a transfer PayPal
  // already held; a field the client renders has to be in every list that
  // feeds a client.
  'rail_status, rail_status_at, fx_from_amount, fx_from_currency, fx_rate, fx_rate_source, ' +
  // Decides the idempotency key of the next send. A stale one rebuilds the key
  // of a batch the rail already holds.
  'send_seq, ' +
  // **Where the money actually went, not where the seller is paid today.**
  // The dashboard rendered the seller's *current* destination against every
  // payout, so a transfer sent to an address the seller has since replaced
  // displayed the new one — a money screen telling an operator the money went
  // somewhere it did not. Embedded through the payout's own foreign key, which
  // is the only thing that knows.
  'destination:seller_destinations!payouts_destination_id_fkey(masked_destination, payout_provider)'

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

/**
 * `POST /payouts/:id/pull-back` — ask the rail to give back a transfer it is
 * holding but has not delivered, so it can be sent somewhere that works.
 *
 * **The fourth POST, and the one `retry` cannot be.** `retry` re-attempts a
 * payout nothing is holding; this one is for a payout the rail accepted and
 * then could not deliver. PayPal's case: an item sitting `UNCLAIMED` because
 * the address has no confirmed PayPal account, held for thirty days before it
 * returns on its own. Pressing `retry` there does nothing at all — the payout
 * has a `provider_ref`, so `dispatchPayout` polls it rather than sending, and
 * polls it to the same answer for a month. On 2026-09-13 the owner pressed it
 * and watched nothing happen, which is what asked for this button.
 *
 * **It books nothing.** The rail is asked and that is all. The next dispatch
 * pass — or the item webhook, which arrives in seconds — sees the transfer
 * terminally failed, and the ordinary path books it, clears the dead
 * reference, moves `send_seq` and sends again under a key the rail has not
 * seen. One booking path; this only starts it sooner.
 *
 * Because the money goes out again straight afterwards, it re-routes as it
 * goes: the send picks up the seller's destination as it stands *now*, so
 * fixing the address and pressing this is the whole repair.
 */
async function pullBack(
  req: Request,
  db: SupabaseClient,
  caller: Caller,
  id: string,
): Promise<Response> {
  // A signed-in person, for `hold`'s reason rather than `retry`'s. Retry is
  // mechanical — nothing judged the payout and sending it again is just
  // sending it again — but this reaches into a rail and takes back money that
  // is already in flight. Whether that is the right thing to do to a transfer
  // somebody may be waiting on is a judgement, and a judgement wants somebody
  // who can be asked why. It also keeps a seller-facing app from offering it:
  // pulling a transfer out of a rail is an operator's move, not a host's.
  if (caller.kind !== 'dashboard') {
    throw new PayHoldError(
      'unauthorized',
      'A transfer can only be pulled back by a signed-in person, not by an API key',
    )
  }
  requireRole(caller, 'owner', 'staff')

  const payout = await getPayout(db, caller, id)

  if (payout.status === 'paid') {
    throw new PayHoldError('invalid_state', 'This payout has already been sent')
  }
  if (!payout.provider_ref) {
    throw new PayHoldError(
      'invalid_state',
      'This payout never reached a rail, so there is nothing to pull back',
    )
  }

  const { data: dest } = await db
    .from('seller_destinations')
    .select('payout_provider')
    .eq('id', payout.destination_id ?? '')
    .maybeSingle()

  const rail = (dest as { payout_provider?: string } | null)?.payout_provider

  if (!rail) {
    throw new PayHoldError(
      'invalid_state',
      'This payout has no destination on file, so there is no rail to ask',
    )
  }

  // Which adapter is behind that rail, read from `payout_routes` — the same
  // table `route_payout` reads, rather than a second copy of the mapping that
  // could send the cancel to the wrong provider.
  const { data: route } = await db
    .from('payout_routes')
    .select('provider, tenant_id')
    .eq('payout_provider', rail)
    .or(`tenant_id.eq.${payout.tenant_id},tenant_id.is.null`)
    .order('tenant_id', { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle()

  const adapter = (route as { provider?: string } | null)?.provider

  if (!adapter) {
    throw new PayHoldError(
      'invalid_state',
      `${rail} has no adapter behind it, so there is nothing to ask`,
    )
  }

  const { provider } = await loadProvider(db, payout.tenant_id, adapter as Provider)

  if (!provider.cancelTransfer) {
    throw new PayHoldError(
      'policy_violation',
      `${rail} cannot return a transfer it has already accepted`,
    )
  }

  const result = await provider.cancelTransfer(payout.provider_ref)

  await db.rpc('write_audit', {
    p_tenant: payout.tenant_id,
    p_deal: payout.deal_id,
    p_actor: caller.actor,
    p_action: 'payout.cancel_requested_at_rail',
    p_details: {
      payout_id: payout.id,
      provider_ref: payout.provider_ref,
      rail,
      result: result.detail,
    },
  })

  return json(req, {
    payout_id: payout.id,
    pulled_back: true,
    detail: result.detail,
    note:
      'The rail was asked to return it. Nothing has been booked here — the next ' +
      'pass books the return and sends again to the destination on file now.',
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
    case 'pull-back':
      return await pullBack(req, db, caller, id)
    default:
      throw new PayHoldError('not_found', `No such action "${action ?? ''}"`)
  }
}))
