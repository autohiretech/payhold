/**
 * The nightly reconciliation cron.
 *
 * The pass itself lives in `_shared/reconciliation.ts`, because it has a second
 * caller: an operator on the Admin screen who wants it run now rather than at
 * midnight. What stays here is the schedule's own authentication — `CRON_SECRET`
 * and nothing else. The jobs are not tenant-scoped, so no API key may trigger
 * one, and a deployment without the secret refuses every caller.
 *
 * It runs **first** in the staggered order (reconcile :00 → auto-release :10 →
 * payout-dispatch :20), because drift freezes payouts and a dispatch that went
 * first would send money out of a balance we already know we cannot explain.
 */

import { serviceClient } from '../_shared/auth.ts'
import { requireCronCaller } from '../_shared/cron-auth.ts'
import { handler, json } from '../_shared/http.ts'
import { reconcileAll } from '../_shared/reconciliation.ts'

Deno.serve(handler(async (req) => {
  await requireCronCaller(req)

  return json(req, await reconcileAll(serviceClient()))
}))
