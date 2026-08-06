/**
 * Approve or reject a draft — the human gate of invariant 9.
 *
 *   POST /ai-decisions  { suggestion_id, decision }
 *   GET  /ai-decisions?deal_id=…   every suggestion, decided or not
 *
 * This is deliberately a separate function from the three that draft, and the
 * separation is the design rather than tidiness. Those run as `payhold_ai`, a
 * role Postgres will not let near a money function. This one runs as the
 * service role, because approving a `release` draft really does release money —
 * so the process that can do that is the one a person authenticates to, and no
 * model output reaches it except as a row id.
 *
 * Three things this endpoint does not do, each on purpose:
 *
 *   * It does not accept an actor. `decided_by` comes from the caller's own
 *     session, because a client that can name its own approver can forge an
 *     approval — and the audit row is about a person, not a payload.
 *   * It does not accept an amount. The recommendation is read from the stored
 *     suggestion inside the transaction, so what gets executed is the draft
 *     that was shown rather than whatever the request body says.
 *   * It does not let the AI role in. A draft can be approved only through
 *     here, by a signed-in owner or staff member.
 */

import { requireRole, resolveCaller, serviceClient } from '../_shared/auth.ts'
import { aiUsage, SUGGESTION_COLUMNS, type StoredSuggestion } from '../_shared/ai.ts'
import { releaseFigures } from '../_shared/figures.ts'
import { handler, json, readJson, required } from '../_shared/http.ts'
import { PayHoldError, type Deal } from '../_shared/types.ts'

Deno.serve(handler(async (req) => {
  const db = serviceClient()
  const caller = await resolveCaller(db, req)
  const url = new URL(req.url)

  if (req.method === 'GET') {
    // Same shape as `webhook-endpoints?deliveries=1`: one function serves the
    // reads that belong to one screen, rather than three deployments for three
    // list endpoints.
    if (url.searchParams.get('usage')) {
      return json(req, { usage: await aiUsage(db, caller.tenant_id) })
    }

    if (url.searchParams.get('outcomes')) {
      const { data } = await db
        .from('deal_outcomes')
        .select(
          'id, tenant_id, deal_id, outcome, reason_code, notes, amount_disputed, ' +
            'resolved_at, created_at',
        )
        .eq('tenant_id', caller.tenant_id)
        .order('resolved_at', { ascending: false })
        .limit(Math.min(Number(url.searchParams.get('limit') ?? 200), 1_000))

      return json(req, { outcomes: data ?? [] })
    }

    const dealId = url.searchParams.get('deal_id')
    let query = db
      .from('ai_suggestions')
      .select(SUGGESTION_COLUMNS)
      .eq('tenant_id', caller.tenant_id)
      .order('created_at', { ascending: false })
      .limit(Math.min(Number(url.searchParams.get('limit') ?? 100), 500))

    if (dealId) query = query.eq('deal_id', dealId)

    const { data } = await query
    return json(req, { suggestions: data ?? [] })
  }

  if (req.method !== 'POST') {
    throw new PayHoldError('policy_violation', `${req.method} is not supported here`)
  }

  // A viewer is exactly the role that exists so a finance observer can watch
  // without being able to act. Approving a draft is acting.
  requireRole(caller, 'owner', 'staff')

  const body = await readJson<{
    suggestion_id: string
    decision: 'approved' | 'rejected'
  }>(req)
  required(body as unknown as Record<string, unknown>, 'suggestion_id', 'decision')

  if (body.decision !== 'approved' && body.decision !== 'rejected') {
    throw new PayHoldError(
      'policy_violation',
      'decision must be "approved" or "rejected"',
    )
  }

  const { data: suggestion } = await db
    .from('ai_suggestions')
    .select(SUGGESTION_COLUMNS)
    .eq('id', body.suggestion_id)
    .eq('tenant_id', caller.tenant_id)
    .maybeSingle()

  if (!suggestion) {
    throw new PayHoldError('not_found', `Suggestion ${body.suggestion_id} not found`)
  }

  const stored = suggestion as unknown as StoredSuggestion

  // FX and fees are this side's job even here — `decide_ai_suggestion` takes
  // already-converted figures, exactly as `release_deal` does, so the database
  // never calls out mid-transaction. Computed only when the decision could
  // actually reach a money function; a rejection needs no conversion, and a
  // deal whose rate lookup fails should still be rejectable.
  let figures = {
    p_payout_amount: null as number | null,
    p_payout_currency: null as string | null,
    p_fee_presentment: null as number | null,
  }

  const executes = body.decision === 'approved' &&
    stored.kind === 'dispute_resolution' &&
    stored.output.recommendation !== 'escalate'

  if (executes) {
    const { data: deal } = await db
      .from('deals')
      .select('*')
      .eq('id', stored.deal_id)
      .eq('tenant_id', caller.tenant_id)
      .maybeSingle()

    if (!deal) throw new PayHoldError('not_found', `Deal ${stored.deal_id} not found`)
    figures = await releaseFigures(db, deal as Deal)
  }

  // From here the guard is the transaction's, not ours. The suggestion is
  // locked, the decision is written, and the dispute is resolved or it is not —
  // a second click cannot resolve it twice.
  const { data, error } = await db.rpc('decide_ai_suggestion', {
    p_suggestion_id: stored.id,
    p_decision: body.decision,
    p_decided_by: caller.actor,
    ...figures,
  })

  if (error) {
    // The SQL function raises with a `code: message` prefix, the same
    // convention the money functions use.
    const message = error.message ?? 'Could not record that decision'
    if (message.includes('invalid_state')) {
      throw new PayHoldError('invalid_state', message.replace(/^.*invalid_state: /, ''))
    }
    if (message.includes('not_found')) {
      throw new PayHoldError('not_found', message.replace(/^.*not_found: /, ''))
    }
    throw new PayHoldError('policy_violation', message)
  }

  return json(req, {
    suggestion: data,
    // Said plainly so a client does not have to infer it from the kind and the
    // recommendation: this is whether money moved.
    executed: executes,
  })
}))
