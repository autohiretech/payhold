/**
 * Inbound Flutterwave webhook — invariants 2, 3 and 4.
 *
 *   POST /flutterwave-webhook/:tenant
 *
 * The tenant is in the path because this is the one endpoint with no caller to
 * authenticate: Flutterwave does not hold a PayHold API key. What authenticates
 * the request is the `verif-hash` header, checked against *that tenant's* own
 * stored credentials — which is why the path segment is needed to know whose
 * secret to check against, and why a wrong tenant simply fails the check.
 *
 * The order of operations is the spec's, and none of it is optional:
 *
 *   1. Read the RAW body. Parsing before verifying is how signature checks get
 *      defeated.
 *   2. Record the event, whether or not it verifies. §11.8 triage depends on
 *      this table containing the ones we rejected.
 *   3. Check the signature. A forged webhook must return 401 — this is the
 *      test the launch gate names explicitly.
 *   4. RE-FETCH the transaction from Flutterwave. The webhook body is never
 *      trusted for an amount; a valid signature only proves who sent it, not
 *      that the numbers in it are true.
 *   5. Only then touch state, in one transactional call.
 */

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { serviceClient } from '../_shared/auth.ts'
import { convert } from '../_shared/fx.ts'
import { handler, json } from '../_shared/http.ts'
import { loadProvider } from '../_shared/load-provider.ts'
import { normaliseIp, recordContext } from '../_shared/request-context.ts'
import { loadSettings } from '../_shared/settings.ts'
import { PayHoldError, type PaymentMethod } from '../_shared/types.ts'

/** A path segment that is not a uuid cannot be a tenant, and must not reach a query. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** What Flutterwave sends. Only the fields we route on — never the amounts. */
interface FlutterwaveEvent {
  event?: string
  data?: {
    id?: number
    tx_ref?: string
    status?: string
    payment_type?: string
    card?: { type?: string }
  }
}

/** Their `payment_type` in our vocabulary. */
function methodFrom(paymentType: string | undefined): PaymentMethod | null {
  switch (paymentType) {
    case 'card':
      return 'card'
    case 'mobilemoney':
    case 'mobilemoneyghana':
    case 'mobilemoneyuganda':
    case 'mobilemoneyrwanda':
    case 'mobilemoneyzambia':
    case 'mpesa':
      return 'mobile_money'
    case 'banktransfer':
    case 'account':
    case 'ach':
      return 'bank_transfer'
    default:
      return null
  }
}

/** The wallet or scheme, for the record rather than for routing. */
function networkFrom(event: FlutterwaveEvent): string | null {
  const type = event.data?.payment_type
  if (type === 'card') return event.data?.card?.type ?? 'Card'
  if (type === 'mpesa') return 'M-Pesa'
  if (type?.startsWith('mobilemoney')) return 'Mobile money'
  return null
}

async function recordEvent(
  db: SupabaseClient,
  tenantId: string | null,
  eventId: string,
  eventType: string | null,
  signatureOk: boolean,
  payload: unknown,
): Promise<'new' | 'duplicate'> {
  const { error } = await db.from('provider_events').insert({
    tenant_id: tenantId,
    provider: 'flutterwave',
    event_id: eventId,
    event_type: eventType,
    signature_ok: signatureOk,
    payload,
  })

  // Unique violation on (provider, event_id). A redelivery is a no-op, which
  // is what makes retries safe rather than dangerous.
  if (error?.code === '23505') return 'duplicate'
  if (error) throw new Error(`could not record provider event: ${error.message}`)
  return 'new'
}

Deno.serve(handler(async (req) => {
  if (req.method !== 'POST') {
    throw new PayHoldError('policy_violation', `${req.method} is not supported here`)
  }

  const segments = new URL(req.url).pathname.split('/').filter(Boolean)
  const tenantId = segments[segments.indexOf('flutterwave-webhook') + 1]
  if (!tenantId) {
    throw new PayHoldError('not_found', 'No tenant in the webhook path')
  }

  // (1) Raw first, always.
  const raw = await req.text()
  const db = serviceClient()

  let event: FlutterwaveEvent
  try {
    event = JSON.parse(raw) as FlutterwaveEvent
  } catch {
    throw new PayHoldError('policy_violation', 'Body must be valid JSON')
  }

  const txRef = event.data?.tx_ref
  const eventId = event.data?.id ? String(event.data.id) : txRef

  if (!eventId) {
    throw new PayHoldError('policy_violation', 'Event carries no id or tx_ref')
  }

  // The tenant has to exist before anything can reference it. `provider_events`
  // has a foreign key to `tenants`, so a forged webhook aimed at a made-up
  // tenant would otherwise die on that constraint and surface as a 500 — where
  // §9's launch gate requires a flat 401.
  //
  // The event is still recorded, with a null tenant, because §11.8 triage
  // depends on this table holding the ones we rejected. The response is
  // identical to a bad signature: whether a given tenant exists is not
  // something an unauthenticated caller gets to learn.
  const known = UUID.test(tenantId)
    ? (await db.from('tenants').select('id').eq('id', tenantId).maybeSingle()).data
    : null

  const loaded = known
    ? await loadProvider(db, tenantId, 'flutterwave')
    : null

  // (3) Signature, against this tenant's own stored hash.
  const signatureOk = loaded?.provider.verifySignature(raw, req.headers) ?? false
  const connected = loaded?.connected ?? false
  const provider = loaded?.provider

  // (2) Recorded either way — including the forgeries.
  const seen = await recordEvent(
    db,
    known ? tenantId : null,
    eventId,
    event.event ?? null,
    signatureOk,
    event,
  )

  if (!signatureOk) {
    // The launch gate's forged-webhook test asserts exactly this.
    throw new PayHoldError('unauthorized', 'Signature check failed')
  }
  if (seen === 'duplicate') {
    return json(req, { status: 'duplicate', event_id: eventId })
  }
  if (!connected) {
    // A signed webhook for a tenant with no credentials cannot be re-verified,
    // and acting on it unverified would defeat the point of step 4.
    throw new PayHoldError('policy_violation', 'No Flutterwave account is connected')
  }
  if (!txRef) {
    throw new PayHoldError('policy_violation', 'Event carries no tx_ref')
  }

  // (4) Ask Flutterwave what actually happened. The body above is not evidence.
  const verified = await provider!.verify(txRef)

  if (verified.status !== 'successful') {
    await db
      .from('provider_events')
      .update({
        processed_at: new Date().toISOString(),
        error: `Transaction is ${verified.status}, not successful`,
      })
      .eq('provider', 'flutterwave')
      .eq('event_id', eventId)

    return json(req, { status: 'ignored', reason: verified.status })
  }

  // `tx_ref` is our deal id — we set it when the charge was created.
  const { data: deal } = await db
    .from('deals')
    .select('id, currency, presentment_currency, tenant_id')
    .eq('id', txRef)
    .eq('tenant_id', tenantId)
    .maybeSingle()

  if (!deal) {
    // Money arrived that we cannot attribute. §11.8 calls this out as a triage
    // case; the event row is the record it happened.
    await db
      .from('provider_events')
      .update({
        processed_at: new Date().toISOString(),
        error: 'No matching deal for tx_ref',
      })
      .eq('provider', 'flutterwave')
      .eq('event_id', eventId)

    throw new PayHoldError('not_found', 'No deal matches that reference')
  }

  const settings = await loadSettings(db, tenantId)

  // The rate is locked from what actually arrived against what the seller is
  // owed, and stored on the deal. Re-deriving it later would move the number
  // under a deal that has already been paid.
  const lockedRate = verified.currency === deal.currency
    ? null
    : convert(1_000_000, deal.currency, verified.currency)?.rate ?? null

  // (5) One call. The amount/currency comparison and the state write are in the
  // same transaction, which is the only way "mismatch → disputed, never
  // funded_held" is a guarantee rather than a hope.
  const { error } = await db.rpc('fund_deal', {
    p_deal_id: deal.id,
    p_provider: 'flutterwave',
    p_provider_ref: verified.provider_ref,
    p_method: methodFrom(event.data?.payment_type),
    p_network: networkFrom(event),
    p_verified_amount: verified.amount,
    p_verified_currency: verified.currency,
    p_fx_rate: lockedRate,
    p_auto_release_days: settings.auto_release_days,
  })

  // Where the buyer paid from, as Flutterwave saw it — the strongest of the
  // three sources in §6, because it is the provider's own observation against a
  // transaction we have just re-verified rather than anything a client told us.
  // Recorded whether or not `fund_deal` succeeded: a charge that landed on a
  // mismatched amount is disputed, and that is precisely a case where an
  // operator wants to know where it came from.
  const customer = (event.data ?? {}) as {
    ip?: string
    customer?: { ip?: string }
    device_fingerprint?: string
  }

  await recordContext(db, {
    deal_id: deal.id,
    source: 'provider',
    event: 'charge_confirmed',
    ip: normaliseIp(customer.ip ?? customer.customer?.ip ?? ''),
    // Flutterwave reports no country on the charge, and this is not the place
    // to guess one from an address — a wrong country is worse than none when it
    // is about to flag somebody.
    ip_country: null,
    user_agent: customer.device_fingerprint ?? null,
  })

  await db
    .from('provider_events')
    .update({
      reverified: true,
      processed_at: new Date().toISOString(),
      error: error?.message ?? null,
    })
    .eq('provider', 'flutterwave')
    .eq('event_id', eventId)

  if (error) {
    console.error('funding failed', { deal_id: deal.id, message: error.message })
    throw new PayHoldError('invalid_state', 'Could not apply that payment')
  }

  return json(req, { status: 'applied', deal_id: deal.id })
}))
