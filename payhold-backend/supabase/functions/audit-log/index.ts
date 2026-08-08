/**
 * The audit log — who did what, and when.
 *
 *   GET /audit-log              this tenant's entries, newest first
 *   GET /audit-log?deal_id=…    one deal's
 *
 * Invariant 6's other half. The ledger records where money moved; this records
 * every state transition and every provider call, including the ones that moved
 * nothing — a refused payout, a withdrawn sign-off, a settings change. An
 * approval that is not attributable to somebody is not an approval, and this is
 * where the name is.
 *
 * Read-only, and deliberately so: `audit_log` is append-only by trigger and
 * every row is written by the function that did the thing being recorded. An
 * endpoint that could write one would be an endpoint that could forge one.
 */

import { resolveCaller, serviceClient } from '../_shared/auth.ts'
import { handler, json } from '../_shared/http.ts'
import { PayHoldError } from '../_shared/types.ts'

const AUDIT_COLUMNS = 'id, tenant_id, deal_id, actor, action, details, created_at'

Deno.serve(handler(async (req) => {
  if (req.method !== 'GET') {
    throw new PayHoldError('policy_violation', `${req.method} is not supported here`)
  }

  const db = serviceClient()
  const caller = await resolveCaller(db, req)
  const params = new URL(req.url).searchParams

  let query = db
    .from('audit_log')
    .select(AUDIT_COLUMNS)
    .eq('tenant_id', caller.tenant_id)
    .order('created_at', { ascending: false })
    .limit(Math.min(Number(params.get('limit') ?? 200), 1_000))

  const dealId = params.get('deal_id')
  if (dealId) query = query.eq('deal_id', dealId)

  const action = params.get('action')
  if (action) query = query.in('action', action.split(','))

  const { data, error } = await query
  if (error) throw new Error(`audit lookup failed: ${error.message}`)

  return json(req, { entries: data ?? [] })
}))
