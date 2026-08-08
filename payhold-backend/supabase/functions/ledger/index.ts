/**
 * The ledger itself — every entry, newest first.
 *
 *   GET /ledger              this tenant's entries
 *   GET /ledger?deal_id=…    one deal's
 *
 * `balance` answers what the buckets add up to; this answers what they are made
 * of, which is the question asked when the two disagree with a provider. Both
 * read the same rows, and neither stores anything: a balance is a sum over
 * these entries and never a column.
 *
 * Read-only, and there is no writer here in any method — every entry is written
 * by a `security definer` money function inside the transaction that decided
 * it. The table is append-only by trigger as well, so a correction is an
 * opposite entry rather than an edit.
 */

import { resolveCaller, serviceClient } from '../_shared/auth.ts'
import { handler, json } from '../_shared/http.ts'
import { PayHoldError } from '../_shared/types.ts'

const ENTRY_COLUMNS =
  'id, tenant_id, deal_id, entry_type, amount, currency, provider, provider_ref, created_at'

Deno.serve(handler(async (req) => {
  if (req.method !== 'GET') {
    throw new PayHoldError('policy_violation', `${req.method} is not supported here`)
  }

  const db = serviceClient()
  const caller = await resolveCaller(db, req)
  const params = new URL(req.url).searchParams

  let query = db
    .from('ledger')
    .select(ENTRY_COLUMNS)
    .eq('tenant_id', caller.tenant_id)
    .order('created_at', { ascending: false })
    .limit(Math.min(Number(params.get('limit') ?? 200), 1_000))

  const dealId = params.get('deal_id')
  if (dealId) query = query.eq('deal_id', dealId)

  const { data, error } = await query
  if (error) throw new Error(`ledger lookup failed: ${error.message}`)

  return json(req, { entries: data ?? [] })
}))
