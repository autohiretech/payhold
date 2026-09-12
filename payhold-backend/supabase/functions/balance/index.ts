/**
 * Balance — held, pending clearance, available, paid out.
 *
 *   GET  /balance                     per currency
 *   GET  /balance?by=rail             per provider and currency
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

/**
 * `POST /balance/external-transfers` was removed 2026-09-12, at the account
 * owner's request.
 *
 * It let a person file a claim that they had moved money between their own
 * provider accounts — a top-up PayHold cannot observe, since under
 * bring-your-own-keys it orchestrates and never custodies. The intent was
 * sound: `reconciliation.ts` adds `tenant_funds` into what it expects to find
 * on a rail, so an unexplained top-up reads as drift and
 * `record_reconciliation` freezes the tenant's payouts.
 *
 * What made it worse than the problem it solved is that `record_external_transfer`
 * validated the actor, the reference and a non-zero amount — and nothing about
 * the money. It never asked the rail registry whether that provider can hold
 * that currency, so the only two entries ever filed included a **GHS balance on
 * PayPal**, a rail that carries USD and EUR alone (`_shared/rails.ts`). A
 * mistyped claim does not just mislead a tile: it lands in `expected()` and
 * arms the same payout freeze the feature existed to prevent.
 *
 * If this comes back, it needs `(provider, currency)` checked against the rail
 * registry before the insert, and the form needs `toMinorUnits(amount, currency)`
 * rather than a hardcoded x100 — RWF is zero-decimal, so that multiply filed a
 * 100x overstatement for the currency the form defaulted to.
 *
 * The ledger keeps `external_transfer` as an entry type: `rail_balances` still
 * reads it, the two historical rows still exist (the ledger is append-only),
 * and `cross_rail_offset` / `cross_rail_payout` — which the system writes for
 * itself and can verify — are untouched.
 */

Deno.serve(handler(async (req) => {
  const db = serviceClient()
  const caller = await resolveCaller(db, req)

  // Read-only again, now that the external-transfer POST is gone: there is no
  // sub-path left to route on, so the method is the whole decision.
  if (req.method !== 'GET') {
    throw new PayHoldError('policy_violation', `${req.method} is not supported here`)
  }

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
