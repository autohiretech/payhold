/**
 * Where to notify a client when their deals move.
 *
 *   POST   /webhook-endpoints        register a URL → returns the secret ONCE
 *   GET    /webhook-endpoints        list, masked
 *   GET    /webhook-endpoints?deliveries=1   recent delivery attempts
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

Deno.serve(handler(async (req) => {
  const db = serviceClient()
  const caller = await resolveCaller(db, req)
  const url = new URL(req.url)

  switch (req.method) {
    case 'POST':
      requireRole(caller, 'owner', 'staff')
      return await register(req, db, caller)

    case 'GET': {
      if (url.searchParams.get('deliveries')) {
        const { data } = await db
          .from('webhook_deliveries')
          .select('id, endpoint_id, deal_id, event, status, status_code, error, ' +
            'attempts, signature, next_attempt_at, delivered_at, created_at')
          .eq('tenant_id', caller.tenant_id)
          .order('created_at', { ascending: false })
          .limit(Math.min(Number(url.searchParams.get('limit') ?? 100), 500))

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
