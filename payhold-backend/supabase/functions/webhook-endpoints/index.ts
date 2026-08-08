/**
 * Where to notify a client when their deals move.
 *
 *   POST   /webhook-endpoints        register a URL → returns the secret ONCE
 *   GET    /webhook-endpoints        list, masked
 *   GET    /webhook-endpoints?deliveries=1   recent delivery attempts
 *   POST   /webhook-endpoints/deliveries/:id/retry   send one again now
 *   DELETE /webhook-endpoints?id=…   disable, keeping the delivery history
 *
 * The signing secret is shown exactly once, at creation. After that it is only
 * ever *used* — by `webhook-dispatch`, to sign — and there is no endpoint that
 * returns it. Losing it means registering a new endpoint, which is the same
 * bargain API keys make.
 *
 * Note it is encrypted rather than hashed, unlike an API key. A key is only
 * compared, so a hash is strictly safer; a signing secret has to be recovered
 * on every delivery. `sealWebhookSecret` is the one place that decision lives.
 */

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { requireRole, resolveCaller, serviceClient, type Caller } from '../_shared/auth.ts'
import { generateWebhookSecret, sealWebhookSecret } from '../_shared/crypto.ts'
import { handler, json, readJson, required } from '../_shared/http.ts'
import { PayHoldError } from '../_shared/types.ts'

const ENDPOINT_COLUMNS = 'id, tenant_id, url, masked_secret, created_at, disabled_at'

async function register(
  req: Request,
  db: SupabaseClient,
  caller: Caller,
): Promise<Response> {
  const body = await readJson<{ url: string }>(req)
  required(body as unknown as Record<string, unknown>, 'url')

  let parsed: URL
  try {
    parsed = new URL(body.url)
  } catch {
    throw new PayHoldError('policy_violation', 'url must be a valid absolute URL')
  }

  // Notifications carry deal amounts and references. Sending them in the clear
  // would put that on the wire for anyone on the path, and a signature does not
  // help — it proves who sent it, not that nobody read it.
  if (parsed.protocol !== 'https:') {
    throw new PayHoldError('policy_violation', 'Webhook endpoints must be https')
  }

  const secret = generateWebhookSecret()

  const { data, error } = await db
    .from('webhook_endpoints')
    .insert({
      tenant_id: caller.tenant_id,
      url: parsed.toString(),
      secret_encrypted: await sealWebhookSecret(secret.plaintext),
      masked_secret: secret.masked,
    })
    .select(ENDPOINT_COLUMNS)
    .single()

  if (error || !data) {
    throw new PayHoldError('policy_violation', 'Could not register that endpoint')
  }

  await db.rpc('write_audit', {
    p_tenant: caller.tenant_id,
    p_deal: null,
    p_actor: caller.actor,
    p_action: 'webhook_endpoint.created',
    p_details: { url: parsed.toString() },
  })

  return json(
    req,
    {
      endpoint: data,
      // The only time this is ever returned.
      secret: secret.plaintext,
      verify: {
        header: 'PayHold-Signature',
        format: 't=<unix seconds>,v1=<hex hmac-sha256>',
        signed: '<t>.<raw request body>',
        // Without this a captured delivery verifies forever.
        note: 'Recompute the HMAC over the raw body and reject anything whose ' +
          'timestamp is not recent.',
      },
    },
    201,
  )
}

const DELIVERY_COLUMNS =
  'id, tenant_id, endpoint_id, deal_id, event, payload, body, signature, status, ' +
  'status_code, error, attempts, next_attempt_at, delivered_at, created_at'

/**
 * Send one again now, instead of waiting for the backoff to elapse.
 *
 * It re-arms the clock rather than posting from here. Delivery is
 * `webhook-dispatch`'s, which claims a batch `for update skip locked` and signs
 * with the endpoint's decrypted secret — a second sender would be a second
 * place that construction lives, and the pass runs every minute.
 *
 * **`attempts` is deliberately untouched**, the same as a person's payout
 * retry. The counter is what `record_webhook_attempt` reads to decide the
 * backoff and when to stop, so zeroing it would turn one more try into a fresh
 * series of five against a server that has already refused us five times.
 *
 * A delivery whose endpoint has been disabled is re-armed and stays put: the
 * claim query joins on `disabled_at is null`. That is the honest outcome —
 * nothing was sent, and the row says the attempt is still pending rather than
 * claiming a delivery to somewhere the tenant switched off.
 */
async function retryDelivery(
  req: Request,
  db: SupabaseClient,
  caller: Caller,
  id: string,
): Promise<Response> {
  requireRole(caller, 'owner', 'staff')

  const { data: existing } = await db
    .from('webhook_deliveries')
    .select('id, status')
    .eq('id', id)
    .eq('tenant_id', caller.tenant_id)
    .maybeSingle()

  if (!existing) throw new PayHoldError('not_found', `Delivery ${id} not found`)

  if ((existing as { status: string }).status === 'delivered') {
    throw new PayHoldError(
      'invalid_state',
      'This one already went through — re-sending it would be a duplicate event',
    )
  }

  const { data, error } = await db
    .from('webhook_deliveries')
    .update({ status: 'pending', next_attempt_at: new Date().toISOString() })
    .eq('id', id)
    .eq('tenant_id', caller.tenant_id)
    .select(DELIVERY_COLUMNS)
    .single()

  if (error) throw new Error(`delivery retry failed: ${error.message}`)

  const delivery = data as unknown as { deal_id: string | null; event: string }

  await db.rpc('write_audit', {
    p_tenant: caller.tenant_id,
    p_deal: delivery.deal_id,
    p_actor: caller.actor,
    p_action: 'webhook_delivery.retried',
    p_details: { delivery_id: id, event: delivery.event },
  })

  return json(req, { delivery: data })
}

Deno.serve(handler(async (req) => {
  const db = serviceClient()
  const caller = await resolveCaller(db, req)
  const url = new URL(req.url)

  const segments = url.pathname.split('/').filter(Boolean)
  const base = segments.indexOf('webhook-endpoints')
  const resource = segments[base + 1]
  const id = segments[base + 2]
  const action = segments[base + 3]

  switch (req.method) {
    case 'POST':
      if (resource === 'deliveries' && id && action === 'retry') {
        return await retryDelivery(req, db, caller, id)
      }
      if (resource) throw new PayHoldError('not_found', 'No such action')

      requireRole(caller, 'owner', 'staff')
      return await register(req, db, caller)

    case 'GET': {
      if (url.searchParams.get('deliveries') || resource === 'deliveries') {
        let query = db
          .from('webhook_deliveries')
          .select(DELIVERY_COLUMNS)
          .eq('tenant_id', caller.tenant_id)
          .order('created_at', { ascending: false })
          .limit(Math.min(Number(url.searchParams.get('limit') ?? 100), 500))

        const endpointId = url.searchParams.get('endpoint_id')
        if (endpointId) query = query.eq('endpoint_id', endpointId)

        const dealId = url.searchParams.get('deal_id')
        if (dealId) query = query.eq('deal_id', dealId)

        const status = url.searchParams.get('status')
        if (status) query = query.in('status', status.split(','))

        const { data } = await query
        return json(req, { deliveries: data ?? [] })
      }

      const { data } = await db
        .from('webhook_endpoints')
        .select(ENDPOINT_COLUMNS)
        .eq('tenant_id', caller.tenant_id)
        .order('created_at', { ascending: false })

      return json(req, { endpoints: data ?? [] })
    }

    case 'DELETE': {
      requireRole(caller, 'owner', 'staff')
      const id = url.searchParams.get('id')
      if (!id) throw new PayHoldError('policy_violation', 'Specify ?id=')

      // Disabled, not deleted. The delivery history is the answer to "did you
      // tell us?", and removing the endpoint would take it with them.
      const { data, error } = await db
        .from('webhook_endpoints')
        .update({ disabled_at: new Date().toISOString() })
        .eq('id', id)
        .eq('tenant_id', caller.tenant_id)
        .select(ENDPOINT_COLUMNS)
        .maybeSingle()

      if (error || !data) throw new PayHoldError('not_found', `Endpoint ${id} not found`)

      await db.rpc('write_audit', {
        p_tenant: caller.tenant_id,
        p_deal: null,
        p_actor: caller.actor,
        p_action: 'webhook_endpoint.disabled',
        p_details: { url: data.url },
      })

      return json(req, { endpoint: data })
    }

    default:
      throw new PayHoldError('policy_violation', `${req.method} is not supported here`)
  }
}))
