/**
 * Balance — held, pending clearance, available, paid out.
 *
 *   GET /balance            per currency
 *   GET /balance?by=rail    per provider and currency
 *
 * Every number here is derived from the ledger by `tenant_balances()` and
 * `rail_balances()`. There is no stored balance column anywhere in the system,
 * which is what makes "the ledger is the truth" a fact about the schema rather
 * than a habit people have to keep.
 *
 * The rail view is the operationally honest one: "held" is never one pot. It is
 * a Flutterwave balance and a Stripe balance, reconciled against different
 * APIs, and only one of them can pay an African seller.
 */

import { resolveCaller, serviceClient } from '../_shared/auth.ts'
import { handler, json } from '../_shared/http.ts'
import { PayHoldError } from '../_shared/types.ts'

Deno.serve(handler(async (req) => {
  if (req.method !== 'GET') {
    throw new PayHoldError('policy_violation', `${req.method} is not supported here`)
  }

  const db = serviceClient()
  const caller = await resolveCaller(db, req)
  const byRail = new URL(req.url).searchParams.get('by') === 'rail'

  const { data, error } = await db.rpc(
    byRail ? 'rail_balances' : 'tenant_balances',
    { p_tenant: caller.tenant_id },
  )

  if (error) {
    console.error('balance lookup failed', { message: error.message })
    throw new PayHoldError('policy_violation', 'Could not read the balance')
  }

  return json(req, { balances: data ?? [] })
}))
