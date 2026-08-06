/**
 * What the deterministic rules noticed — spec §6.4.
 *
 *   GET /risk-signals                    this tenant's signals, newest first
 *   GET /risk-signals?deal_id=…          for one deal
 *   GET /risk-signals?seller_id=…        everything recorded against a seller
 *   GET /risk-signals?severity=review    only the ones that stopped something
 *   GET /risk-signals?context=1          where payments were made from
 *
 * Read-only, and there is no endpoint that writes one. Signals are recorded by
 * `screen_payout` inside the transaction that screens a payout, whether or not
 * the rules are switched on — the setting governs holding, not noticing. That
 * distinction is the reason this history is worth exposing: it accumulates on
 * tenants who have the rules off, and it is the training data for §12.4's own
 * fraud model, which cannot be backfilled.
 *
 * A signal explains itself. `value` carries the numbers the rule fired on and
 * `explanation` is the sentence an operator reads, so a hold is checkable
 * rather than something they have to take on trust.
 */

import { resolveCaller, serviceClient } from '../_shared/auth.ts'
import { handler, json } from '../_shared/http.ts'
import { PayHoldError } from '../_shared/types.ts'

const SIGNAL_COLUMNS =
  'id, tenant_id, deal_id, seller_id, signal, severity, value, explanation, created_at'

const CONTEXT_COLUMNS =
  'id, tenant_id, deal_id, source, event, ip, ip_country, user_agent, created_at'

Deno.serve(handler(async (req) => {
  if (req.method !== 'GET') {
    throw new PayHoldError('policy_violation', `${req.method} is not supported here`)
  }

  const db = serviceClient()
  const caller = await resolveCaller(db, req)
  const params = new URL(req.url).searchParams

  // Served from here rather than from a function of its own because it answers
  // the same question from the other end: a signal is what a rule concluded,
  // and this is the raw observation an operator checks it against. Same screen,
  // same tenant scope, same read-only posture — there is no endpoint that
  // writes either one.
  if (params.get('context')) {
    let contextQuery = db
      .from('request_context')
      .select(CONTEXT_COLUMNS)
      .eq('tenant_id', caller.tenant_id)
      .order('created_at', { ascending: false })
      .limit(Math.min(Number(params.get('limit') ?? 200), 1_000))

    const forDeal = params.get('deal_id')
    if (forDeal) contextQuery = contextQuery.eq('deal_id', forDeal)

    const { data, error } = await contextQuery
    if (error) throw new Error(`request context lookup failed: ${error.message}`)

    return json(req, { request_context: data ?? [] })
  }

  let query = db
    .from('risk_signals')
    .select(SIGNAL_COLUMNS)
    // Scoped to the caller's tenant, like every other read. A signal names a
    // seller and a deal, so an unscoped one would leak both.
    .eq('tenant_id', caller.tenant_id)
    .order('created_at', { ascending: false })
    .limit(Math.min(Number(params.get('limit') ?? 100), 500))

  const dealId = params.get('deal_id')
  const sellerId = params.get('seller_id')
  const severity = params.get('severity')

  if (dealId) query = query.eq('deal_id', dealId)
  if (sellerId) query = query.eq('seller_id', sellerId)
  if (severity) query = query.in('severity', severity.split(','))

  const { data, error } = await query
  if (error) throw new Error(`risk signal lookup failed: ${error.message}`)

  return json(req, { risk_signals: data ?? [] })
}))
