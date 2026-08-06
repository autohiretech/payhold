/**
 * Outbound webhooks — invariant 7.
 *
 * A client's site learns that a deal released because we tell it, and it can
 * tell the message really came from us because it is HMAC-signed with a secret
 * only the two of us hold. Nothing here is decorative: `signPayload` is a real
 * HMAC-SHA256, and `webhooks.test.ts` verifies a delivery the way a client's
 * own server would.
 *
 * Two decisions worth keeping:
 *
 *   Enqueue is synchronous and inside the money path. A release that committed
 *   but failed to queue a notification would leave the client's site
 *   permanently out of step with ours, so the row is written in the same step
 *   as the release — in Postgres that is literally the same transaction.
 *
 *   Sending is not. Delivery happens on the cron pass, with backoff, because a
 *   client endpoint being down must never be able to fail a release.
 */

import { signPayload } from '@/lib/hmac'
import type {
  WebhookDelivery,
  WebhookEvent,
  WebhookPayload,
} from '../types'
import {
  addMinutes,
  audit,
  isDue,
  nextId,
  nowIso,
  type MockDb,
} from './store'

/** The signed timestamp is unix seconds, as the backend's signer uses. */
const unixSeconds = (iso: string): number => Math.floor(new Date(iso).getTime() / 1000)

/** After this many tries we stop and leave the record for a person to see. */
const MAX_ATTEMPTS = 5

/** Minutes to wait after attempt 1, 2, 3, 4. Roughly exponential. */
const BACKOFF_MINUTES = [1, 5, 30, 120]

/**
 * Queue one notification per live endpoint.
 *
 * A tenant with no endpoint registered is the normal case for a new account,
 * and it is not an error — there is simply nobody to tell.
 */
export function emitWebhook(
  db: MockDb,
  tenantId: string,
  event: WebhookEvent,
  dealId: string | null,
  data: Record<string, unknown> = {},
): WebhookDelivery[] {
  const endpoints = db.webhook_endpoints.filter(
    (e) => e.tenant_id === tenantId && e.disabled_at === null,
  )
  if (endpoints.length === 0) return []

  const occurredAt = nowIso()
  const payload: WebhookPayload = {
    event,
    deal_id: dealId,
    occurred_at: occurredAt,
    data,
  }
  // Serialise once. The signature covers these exact bytes, so re-encoding the
  // object before sending — with keys in a different order — would produce a
  // body the client cannot verify.
  const body = JSON.stringify(payload)

  return endpoints.map((endpoint) => {
    const delivery: WebhookDelivery = {
      id: nextId('whd'),
      tenant_id: tenantId,
      endpoint_id: endpoint.id,
      event,
      deal_id: dealId,
      payload,
      body,
      signature: signPayload(endpoint.secret, unixSeconds(occurredAt), body),
      status: 'pending',
      attempts: 0,
      status_code: null,
      error: null,
      next_attempt_at: occurredAt,
      delivered_at: null,
      created_at: occurredAt,
    }
    db.webhook_deliveries.push(delivery)
    return delivery
  })
}

/**
 * One attempt at one delivery.
 *
 * The signature is recomputed here rather than reused from the queue: a client
 * checking that our timestamp is recent — which is how they stop a captured
 * delivery being replayed at them — would reject a retry that still carried
 * the timestamp from three hours ago.
 */
export function attemptDelivery(db: MockDb, delivery: WebhookDelivery): WebhookDelivery {
  if (delivery.status === 'delivered') return delivery

  const endpoint = db.webhook_endpoints.find((e) => e.id === delivery.endpoint_id)
  const at = nowIso()

  if (!endpoint || endpoint.disabled_at !== null) {
    delivery.status = 'failed'
    delivery.error = 'Endpoint is disabled'
    delivery.next_attempt_at = null
    return delivery
  }

  delivery.signature = signPayload(endpoint.secret, unixSeconds(at), delivery.body)
  delivery.attempts += 1

  // The mock has no network. A dev-panel flag stands in for the client's
  // server being down, which is the only interesting failure here.
  if (db.fail_next_webhook) {
    db.fail_next_webhook = false
    delivery.status_code = 500
    delivery.error = 'Client endpoint returned 500'

    if (delivery.attempts >= MAX_ATTEMPTS) {
      delivery.status = 'failed'
      delivery.next_attempt_at = null
      audit(db, delivery.tenant_id, delivery.deal_id, 'system', 'webhook.exhausted', {
        event: delivery.event,
        url: endpoint.url,
        attempts: delivery.attempts,
      })
    } else {
      delivery.status = 'pending'
      delivery.next_attempt_at = addMinutes(
        at,
        BACKOFF_MINUTES[delivery.attempts - 1] ?? BACKOFF_MINUTES.at(-1)!,
      )
      audit(db, delivery.tenant_id, delivery.deal_id, 'system', 'webhook.failed', {
        event: delivery.event,
        url: endpoint.url,
        attempts: delivery.attempts,
        next_attempt_at: delivery.next_attempt_at,
      })
    }
    return delivery
  }

  delivery.status = 'delivered'
  delivery.status_code = 200
  delivery.error = null
  delivery.delivered_at = at
  delivery.next_attempt_at = null

  audit(db, delivery.tenant_id, delivery.deal_id, 'system', 'webhook.delivered', {
    event: delivery.event,
    url: endpoint.url,
    attempts: delivery.attempts,
  })
  return delivery
}

export interface DeliveryResult {
  delivered: number
  retrying: number
  failed: number
}

/** The cron pass: every queued delivery whose backoff has elapsed. */
export function deliverPending(db: MockDb): DeliveryResult {
  const result: DeliveryResult = { delivered: 0, retrying: 0, failed: 0 }

  for (const delivery of db.webhook_deliveries) {
    if (delivery.status !== 'pending' || !isDue(delivery.next_attempt_at)) continue

    const attempted = attemptDelivery(db, delivery)
    if (attempted.status === 'delivered') result.delivered += 1
    else if (attempted.status === 'failed') result.failed += 1
    else result.retrying += 1
  }

  return result
}
