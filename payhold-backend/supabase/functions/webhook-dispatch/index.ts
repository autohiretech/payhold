/**
 * Deliver queued client notifications — invariant 7.
 *
 * Runs on a schedule. The queue itself is filled inside the transactions that
 * move money (see the triggers in migration 20260806000001), so a release that
 * committed always has its notification queued; this function is only ever
 * responsible for getting it out of the door.
 *
 * That separation is the point. A client's endpoint being down must never be
 * able to fail a release, so nothing here can roll back anything: the worst
 * outcome is a delivery still sitting in the queue with a recorded reason.
 *
 * Signing happens here rather than at enqueue time for two reasons: the secret
 * is encrypted at rest and only this side can decrypt it, and the timestamp
 * has to be the moment of *sending*. A client bounding the age of the signature
 * — which is what stops a captured delivery being replayed at them — would
 * reject every retry that still carried the timestamp from three hours ago.
 */

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { serviceClient } from '../_shared/auth.ts'
import { requireCronCaller } from '../_shared/cron-auth.ts'
import { finishCronRun, startCronRun } from '../_shared/cron-runs.ts'
import { openWebhookSecret, signPayload } from '../_shared/crypto.ts'
import { handler, json } from '../_shared/http.ts'

/** How long we wait on a client's server before calling it a failure. */
const TIMEOUT_MS = 10_000

/** Deliveries per pass. The next pass picks up the rest. */
const BATCH = 50

interface Claimed {
  id: string
  tenant_id: string
  endpoint_id: string
  url: string
  event: string
  body: string
  attempts: number
}

async function deliver(
  url: string,
  body: string,
  signature: string,
  event: string,
): Promise<{ ok: boolean; status: number | null; error: string | null }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'PayHold-Signature': signature,
        // So a client can route without parsing, and can make their handler
        // idempotent on something stable.
        'PayHold-Event': event,
      },
      body,
      signal: controller.signal,
    })

    return {
      ok: res.ok,
      status: res.status,
      error: res.ok ? null : `Client endpoint returned ${res.status}`,
    }
  } catch (err) {
    // A timeout, DNS failure or refused connection. Their outage, our retry.
    return {
      ok: false,
      status: null,
      error: err instanceof Error ? err.message : String(err),
    }
  } finally {
    clearTimeout(timer)
  }
}

Deno.serve(handler(async (req) => {
  await requireCronCaller(req)

  const db = serviceClient()
  const runId = await startCronRun(db, 'webhook-dispatch')

  try {
    const result = await runPass(db)
    await finishCronRun(db, runId, 'completed', result)
    return json(req, result)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await finishCronRun(db, runId, 'failed', undefined, message)
    throw err
  }
}))

async function runPass(db: SupabaseClient): Promise<Record<string, number>> {
  // `for update skip locked` inside this function is what lets two overlapping
  // invocations coexist without either sending the same delivery twice.
  const { data: claimed, error } = await db.rpc('claim_webhook_deliveries', {
    p_limit: BATCH,
  })
  if (error) throw new Error(`claim failed: ${error.message}`)

  const batch = (claimed ?? []) as Claimed[]
  const result = { claimed: batch.length, delivered: 0, failed: 0 }

  // Secrets are decrypted once per endpoint, not once per delivery: a busy
  // tenant can easily have twenty queued notifications for one URL.
  const secrets = new Map<string, string>()

  for (const delivery of batch) {
    let secret = secrets.get(delivery.endpoint_id)

    if (secret === undefined) {
      const { data: endpoint } = await db
        .from('webhook_endpoints')
        .select('secret_encrypted')
        .eq('id', delivery.endpoint_id)
        .maybeSingle()

      if (!endpoint) {
        // The endpoint was deleted between the claim and now. Record it and
        // move on — there is nobody left to tell.
        await db.rpc('record_webhook_attempt', {
          p_delivery_id: delivery.id,
          p_ok: false,
          p_status_code: null,
          p_error: 'Endpoint no longer exists',
          p_signature: null,
        })
        result.failed += 1
        continue
      }

      secret = await openWebhookSecret(endpoint.secret_encrypted)
      secrets.set(delivery.endpoint_id, secret)
    }

    const { header } = await signPayload(secret, delivery.body)
    const outcome = await deliver(delivery.url, delivery.body, header, delivery.event)

    await db.rpc('record_webhook_attempt', {
      p_delivery_id: delivery.id,
      p_ok: outcome.ok,
      p_status_code: outcome.status,
      p_error: outcome.error,
      p_signature: header,
    })

    if (outcome.ok) result.delivered += 1
    else result.failed += 1
  }

  return result
}