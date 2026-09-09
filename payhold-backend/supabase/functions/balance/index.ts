/**
 * Balance — held, pending clearance, available, paid out.
 *
 *   GET  /balance                     per currency
 *   GET  /balance?by=rail             per provider and currency
 *   POST /balance/external-transfers  record a move between your own accounts
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

import { requireRole, resolveCaller, serviceClient } from '../_shared/auth.ts'
import { handler, json, readJson, required } from '../_shared/http.ts'
import { PayHoldError } from '../_shared/types.ts'

interface ExternalTransferBody {
  provider: string
  currency: string
  /** Signed minor units: positive is money arriving on that rail. */
  amount: number
  reference: string
}

/**
 * Record money the tenant moved between their own provider accounts.
 *
 * Under bring-your-own-keys PayHold orchestrates and never custodies, so a
 * tenant who collects on Stripe and pays African sellers on Flutterwave tops
 * the second account up from the first themselves — through their bank, over
 * days, entirely outside anything this system can observe. The ledger still has
 * to be able to explain the Flutterwave balance, or the nightly pass reports
 * the top-up as drift and freezes their payouts.
 *
 * **Person-only, and a reference is required.** Both for the same reason
 * `paid_needs_a_provider_reference` exists: this is a claim that money moved
 * somewhere we cannot check, and a claim with nothing to trace it by is how a
 * difference gets papered over instead of explained. A client's server that
 * could file these could balance its own books against us.
 */
async function recordExternalTransfer(
  req: Request,
  db: ReturnType<typeof serviceClient>,
  caller: Awaited<ReturnType<typeof resolveCaller>>,
): Promise<Response> {
  if (caller.kind === 'api_key') {
    throw new PayHoldError(
      'policy_violation',
      'Recording a transfer between your own accounts is a person\'s statement ' +
        'and cannot be filed with an API key',
    )
  }
  requireRole(caller, 'owner', 'staff')

  const body = await readJson<ExternalTransferBody>(req)
  required(
    body as unknown as Record<string, unknown>,
    'provider',
    'currency',
    'amount',
    'reference',
  )

  if (!Number.isInteger(body.amount)) {
    throw new PayHoldError(
      'policy_violation',
      'amount is in minor units and must be a whole number',
    )
  }

  const { data, error } = await db.rpc('record_external_transfer', {
    p_tenant: caller.tenant_id,
    p_provider: body.provider,
    p_currency: body.currency,
    p_amount: body.amount,
    p_reference: body.reference,
    p_actor: caller.actor,
  })

  if (error) {
    const message = error.message
    for (const code of ['not_found', 'policy_violation'] as const) {
      if (message.startsWith(code)) {
        throw new PayHoldError(code, message.slice(code.length + 2).trim())
      }
    }
    console.error('external transfer failed', { message })
    throw new PayHoldError('policy_violation', 'Could not record that transfer')
  }

  return json(req, { entry: data }, 201)
}

Deno.serve(handler(async (req) => {
  const db = serviceClient()
  const caller = await resolveCaller(db, req)
  const segments = new URL(req.url).pathname.split('/').filter(Boolean)
  const action = segments[segments.indexOf('balance') + 1]

  if (req.method === 'POST' && action === 'external-transfers') {
    return await recordExternalTransfer(req, db, caller)
  }

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
