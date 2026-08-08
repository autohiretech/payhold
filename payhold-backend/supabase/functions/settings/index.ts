/**
 * Per-tenant settings — spec §8, §11.4.
 *
 *   GET   /settings    everything, defaults filled in
 *   PATCH /settings    change some of it
 *
 * The point of the endpoint is §11.4's promise that a fee or a timer changes
 * without a deploy. What it must not become is a way to change a deal that
 * already exists: §27 says in-flight deals keep the settings they were created
 * with, and nothing here touches a deal, a payout or the ledger. The fee is
 * stamped on the deal at creation and the windows are resolved into timestamps
 * when they start running, so a change made here applies to what comes next.
 *
 * Writing is `owner` and `staff`. `viewer` exists so a finance observer can
 * watch the money without being able to reprice it, and an API key is refused
 * outright: a client that could set its own service fee has turned our
 * commission into a field it fills in.
 */

import { requireRole, resolveCaller, serviceClient } from '../_shared/auth.ts'
import { handler, json, readJson } from '../_shared/http.ts'
import { readSettings, writeSettings } from '../_shared/settings.ts'
import { PayHoldError } from '../_shared/types.ts'

Deno.serve(handler(async (req) => {
  const db = serviceClient()
  const caller = await resolveCaller(db, req)

  if (req.method === 'GET') {
    return json(req, { settings: await readSettings(db, caller.tenant_id) })
  }

  if (req.method !== 'PATCH' && req.method !== 'POST') {
    throw new PayHoldError('policy_violation', `${req.method} is not supported here`)
  }

  if (caller.kind !== 'dashboard') {
    throw new PayHoldError(
      'unauthorized',
      'Settings are changed by a signed-in person, not by an API key',
    )
  }
  requireRole(caller, 'owner', 'staff')

  const patch = await readJson<Record<string, unknown>>(req)
  const { settings, changed } = await writeSettings(db, caller.tenant_id, patch)

  // Audited even though no money moved: the fee on every deal created after
  // this call is the fee somebody set here, and "who changed the clearance
  // window" is asked the first time a seller says they were paid late.
  if (changed.length > 0) {
    await db.rpc('write_audit', {
      p_tenant: caller.tenant_id,
      p_deal: null,
      p_actor: caller.actor,
      p_action: 'settings.updated',
      p_details: Object.fromEntries(changed.map((k) => [k, patch[k]])),
    })
  }

  return json(req, { settings })
}))
