/**
 * Who may run a scheduled job.
 *
 * The cron functions are not tenant-scoped: they walk every account, freeze
 * payouts and dispatch notifications. There is no API key that should be able
 * to do that, so they authenticate on a shared secret set alongside the other
 * Supabase secrets and sent by pg_cron.
 *
 * A missing `CRON_SECRET` refuses every request rather than allowing them. The
 * failure mode of "cron stopped running" is visible within a day; the failure
 * mode of "anyone can trigger the reconciliation pass" is not.
 */

import { secureEquals } from './crypto.ts'
import { PayHoldError } from './types.ts'

export async function requireCronCaller(req: Request): Promise<void> {
  const expected = Deno.env.get('CRON_SECRET')
  const presented = req.headers.get('x-cron-secret')

  if (!expected) {
    throw new PayHoldError('unauthorized', 'Scheduled jobs are not configured')
  }
  if (!presented || !(await secureEquals(expected, presented))) {
    throw new PayHoldError('unauthorized', 'Not a scheduled job')
  }
}
