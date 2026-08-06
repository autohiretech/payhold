/**
 * Run with: deno test --allow-env supabase/functions/_shared/cron-auth.test.ts
 *
 * The scheduled jobs are not tenant-scoped — they walk every account, freeze
 * payouts and send notifications. So the interesting assertion is the negative
 * one: with no secret configured, nothing gets in.
 */

import { assertRejects } from 'jsr:@std/assert@1'
import { requireCronCaller } from './cron-auth.ts'
import { PayHoldError } from './types.ts'

const request = (secret?: string): Request =>
  new Request('https://example.test/reconcile', {
    method: 'POST',
    headers: secret ? { 'x-cron-secret': secret } : {},
  })

Deno.test('an unconfigured deployment refuses every caller', async () => {
  Deno.env.delete('CRON_SECRET')

  // Not "allow everything until configured". A cron that stopped running is
  // noticed within a day; an open reconciliation endpoint is not.
  await assertRejects(
    () => requireCronCaller(request('anything')),
    PayHoldError,
    'not configured',
  )
})

Deno.test('a request with no secret is refused', async () => {
  Deno.env.set('CRON_SECRET', 'the-real-secret')

  await assertRejects(
    () => requireCronCaller(request()),
    PayHoldError,
    'Not a scheduled job',
  )
})

Deno.test('a request with the wrong secret is refused', async () => {
  Deno.env.set('CRON_SECRET', 'the-real-secret')

  await assertRejects(
    () => requireCronCaller(request('the-wrong-secret')),
    PayHoldError,
    'Not a scheduled job',
  )
})

Deno.test('a request with the right secret is allowed', async () => {
  Deno.env.set('CRON_SECRET', 'the-real-secret')

  // No throw is the assertion.
  await requireCronCaller(request('the-real-secret'))
})
