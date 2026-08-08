/**
 * §5.1's routing table — which rails reach where, and which are on.
 *
 *   GET /payout-routes                    the platform's rows plus this tenant's
 *   GET /payout-routes?country=RW         narrowed to a corridor
 *
 * **Read-only, and that is the whole design.** Which corridors are open is a
 * launch decision resting on §16's written provider confirmation per market;
 * a client that could switch its own on would have turned that checklist into a
 * field it sets. Rows are changed by an operator against the database, which is
 * also what §12 asks for — a country or a provider disabled without a redeploy.
 *
 * A tenant sees the platform defaults (`tenant_id is null`) alongside its own
 * overrides, and needs to: a row that *replaces* a default is only
 * comprehensible next to the default it replaced, and the corridor that refused
 * a seller is the one they have to be told about.
 *
 * What is *not* here is the decision. Which route a given payout took is
 * `GET /payouts/:id`, read off `payout_decisions` — re-running the engine now
 * would answer what we would do today rather than what we did.
 */

import { resolveCaller, serviceClient } from '../_shared/auth.ts'
import { handler, json } from '../_shared/http.ts'
import { PayHoldError } from '../_shared/types.ts'

const ROUTE_COLUMNS =
  'id, tenant_id, payout_provider, provider, method, countries, currencies, ' +
  'supports_payouts, enabled, risk_status, rank, min_amount, max_amount, ' +
  'fee_fixed, fee_bps, note, created_at'

Deno.serve(handler(async (req) => {
  if (req.method !== 'GET') {
    throw new PayHoldError('policy_violation', `${req.method} is not supported here`)
  }

  const db = serviceClient()
  const caller = await resolveCaller(db, req)
  const params = new URL(req.url).searchParams

  let query = db
    .from('payout_routes')
    .select(ROUTE_COLUMNS)
    .or(`tenant_id.is.null,tenant_id.eq.${caller.tenant_id}`)
    // The order the engine ranks in, so the list reads the way it decides:
    // rank first, then the rail's own name to break a tie the same way
    // `route_evaluation` does.
    .order('rank', { ascending: true })
    .order('payout_provider', { ascending: true })

  const country = params.get('country')
  if (country) query = query.contains('countries', [country.toUpperCase()])

  const currency = params.get('currency')
  if (currency) query = query.contains('currencies', [currency.toUpperCase()])

  const { data, error } = await query
  if (error) throw new Error(`payout route lookup failed: ${error.message}`)

  return json(req, { routes: data ?? [] })
}))
