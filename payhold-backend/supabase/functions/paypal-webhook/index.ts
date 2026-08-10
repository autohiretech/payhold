/**
 * Inbound PayPal webhook — invariants 2, 3 and 4.
 *
 *   POST /paypal-webhook/:tenant
 *
 * The counterpart of `flutterwave-webhook`, and it exists for the same reason:
 * **nothing else can fund a deal.** PayPal's adapter and its rail were both in
 * place before this was, which meant a buyer could approve an order, PayPal
 * could take their money, and the deal would sit at `payment_pending` for ever
 * because no signed event ever arrived to move it. A rail without its webhook
 * is a way to collect money you cannot account for.
 *
 * The tenant is in the path because this is an endpoint with no caller to
 * authenticate — PayPal holds no PayHold API key. What authenticates it is the
 * signature, checked against *that tenant's* stored credentials, which is why
 * the path segment is needed to know whose to check.
 *
 * The order of operations is the spec's, and none of it is optional:
 *
 *   1. Read the RAW body. Parsing before verifying is how signature checks get
 *      defeated.
 *   2. Record the event, whether or not it verifies. §11.8 triage depends on
 *      this table containing the ones we rejected.
 *   3. Check the signature. A forged webhook must return 401.
 *   4. RE-FETCH the order from PayPal. The webhook body is never trusted for an
 *      amount; a valid signature only proves who sent it, not that the numbers
 *      in it are true.
 *   5. Only then touch state, in one transactional call.
 *
 * **PayPal's signature check is a network call**, unlike Flutterwave's shared
 * secret and Stripe's local HMAC: their `verify-webhook-signature` endpoint is
 * the only thing that can validate it. That is the reason
 * `PaymentProvider.verifySignature` returns a promise, and it means an
 * unreachable PayPal makes an event unverifiable — which is refused, because
 * invariant 2 wants the signature *and* the re-fetch, and neither is optional.
 *
 * Deploy: supabase functions deploy paypal-webhook --no-verify-jwt
 */

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { serviceClient } from '../_shared/auth.ts'
import { convert } from '../_shared/fx.ts'
import { handler, json } from '../_shared/http.ts'
import { loadProvider } from '../_shared/load-provider.ts'
import { normaliseIp, recordContext } from '../_shared/request-context.ts'
import { loadSettings } from '../_shared/settings.ts'
import { PayHoldError } from '../_shared/types.ts'

/** A path segment that is not a uuid cannot be a tenant, and must not reach a query. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * What PayPal sends. Only the fields we route on — never the amounts.
 *
 * `resource` is a capture on `PAYMENT.CAPTURE.*` and an order on
 * `CHECKOUT.ORDER.*`, which is why both shapes are read for a reference: our
 * deal id is the `custom_id` we set on the purchase unit, and it survives into
 * the capture. `supplementary_data` is where a capture keeps its order id.
 */
interface PayPalEvent {
  id?: string
  event_type?: string
  resource?: {
    id?: string
    custom_id?: string
    status?: string
    supplementary_data?: { related_ids?: { order_id?: string } }
    purchase_units?: { custom_id?: string }[]
  }
}

/**
 * Our deal id, wherever this event happens to carry it.
 *
 * `custom_id` is what `charge()` sets on the purchase unit and is the only
 * field that means anything to us — PayPal's own ids are theirs. A capture
 * carries it at the top level, an order carries it inside the purchase unit,
 * and reading both is cheaper than caring which event this is.
 */
function dealRefFrom(event: PayPalEvent): string | null {
  return (
    event.resource?.custom_id ??
    event.resource?.purchase_units?.[0]?.custom_id ??
    null
  )
}

/**
 * The reference to re-fetch with.
 *
 * A capture id is not an order id, and `verify` accepts either — see the note
 * at the top of `paypal.ts`. Preferring the resource's own id keeps us asking
 * about the thing the event was actually about.
 */
function providerRefFrom(event: PayPalEvent): string | null {
  return (
    event.resource?.id ??
    event.resource?.supplementary_data?.related_ids?.order_id ??
    null
  )
}

/**
 * Events worth acting on.
 *
 * A completed capture is the only one that can fund a deal; an approved order
 * means the buyer said yes and the money has not moved. Everything else is
 * recorded and ignored, which is deliberate — an unrecognised event type must
 * not be an error, or PayPal adding one would start failing deliveries.
 */
const FUNDING_EVENTS = new Set([
  'PAYMENT.CAPTURE.COMPLETED',
  'CHECKOUT.ORDER.COMPLETED',
])

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
    provider: 'paypal',
    event_id: eventId,
    event_type: eventType,
    signature_ok: signatureOk,
    payload,
  })

  if (!error) return 'new'
  // 23505: the unique index on (provider, event_id). PayPal retries, and a
  // retry must not fund a deal twice.
  if ((error as { code?: string }).code === '23505') return 'duplicate'

  throw new Error(`could not record provider event: ${error.message}`)
}

Deno.serve(handler(async (req) => {
  if (req.method !== 'POST') {
    throw new PayHoldError('policy_violation', `${req.method} is not supported here`)
  }

  const segments = new URL(req.url).pathname.split('/').filter(Boolean)
  const tenantId = segments[segments.indexOf('paypal-webhook') + 1]
  if (!tenantId) {
    throw new PayHoldError('not_found', 'No tenant in the webhook path')
  }

  // (1) Raw first, always.
  const raw = await req.text()
  const db = serviceClient()

  let event: PayPalEvent
  try {
    event = JSON.parse(raw) as PayPalEvent
  } catch {
    throw new PayHoldError('policy_violation', 'Body must be valid JSON')
  }

  const eventId = event.id ?? providerRefFrom(event)
  if (!eventId) {
    throw new PayHoldError('policy_violation', 'Event carries no id')
  }

  // The tenant has to exist before anything can reference it — `provider_events`
  // has a foreign key to `tenants`, so a forged webhook aimed at a made-up
  // tenant would die on that constraint and surface as a 500 where the launch
  // gate requires a flat 401. Recorded anyway, with a null tenant, because
  // §11.8 triage depends on this table holding the ones we rejected.
  const known = UUID.test(tenantId)
    ? (await db.from('tenants').select('id').eq('id', tenantId).maybeSingle()).data
    : null

  const loaded = known ? await loadProvider(db, tenantId, 'paypal') : null

  // (3) Signature. A network call to PayPal on this rail, not a local compare.
  const signatureOk = await (loaded?.provider.verifySignature(raw, req.headers) ?? false)
  const connected = loaded?.connected ?? false
  const provider = loaded?.provider

  // (2) Recorded either way — including the forgeries.
  const seen = await recordEvent(
    db,
    known ? tenantId : null,
    eventId,
    event.event_type ?? null,
    signatureOk,
    event,
  )

  if (!signatureOk) {
    throw new PayHoldError('unauthorized', 'Signature check failed')
  }
  if (seen === 'duplicate') {
    return json(req, { status: 'duplicate', event_id: eventId })
  }
  if (!connected) {
    throw new PayHoldError('policy_violation', 'No PayPal account is connected')
  }

  const finished = async (reason: string) => {
    await db
      .from('provider_events')
      .update({ processed_at: new Date().toISOString(), error: reason })
      .eq('provider', 'paypal')
      .eq('event_id', eventId)
  }

  // Recorded and ignored rather than refused. PayPal sends far more than money
  // events, and failing an unrecognised one would make it retry something we
  // were never going to act on.
  if (!FUNDING_EVENTS.has(event.event_type ?? '')) {
    await finished(`Ignored event type ${event.event_type ?? 'unknown'}`)
    return json(req, { status: 'ignored', reason: 'not a funding event' })
  }

  const dealRef = dealRefFrom(event)
  const providerRef = providerRefFrom(event)

  if (!dealRef || !providerRef) {
    await finished('Event carries no custom_id or resource id')
    throw new PayHoldError('policy_violation', 'Event carries no usable reference')
  }

  // (4) Ask PayPal what actually happened. The body above is not evidence.
  const verified = await provider!.verify(providerRef)

  if (verified.status !== 'successful') {
    await finished(`Transaction is ${verified.status}, not successful`)
    return json(req, { status: 'ignored', reason: verified.status })
  }

  // `custom_id` is our deal id — we set it on the purchase unit at charge time.
  const { data: deal } = await db
    .from('deals')
    .select('id, currency, presentment_currency, tenant_id')
    .eq('id', dealRef)
    .eq('tenant_id', tenantId)
    .maybeSingle()

  if (!deal) {
    // Money arrived that we cannot attribute. §11.8 triage; the event row is
    // the record that it happened.
    await finished('No matching deal for custom_id')
    throw new PayHoldError('not_found', 'No deal matches that reference')
  }

  const settings = await loadSettings(db, tenantId)

  // Locked from what actually arrived against what the seller is owed, and
  // stored on the deal. Re-deriving it later would move the number under a deal
  // that has already been paid.
  const lockedRate = verified.currency === deal.currency
    ? null
    : convert(1_000_000, deal.currency, verified.currency)?.rate ?? null

  // (5) One call. The amount comparison and the state write are in the same
  // transaction, which is the only way "mismatch → disputed, never funded_held"
  // is a guarantee rather than a hope.
  const { error } = await db.rpc('fund_deal', {
    p_deal_id: deal.id,
    p_provider: 'paypal',
    p_provider_ref: verified.provider_ref,
    p_method: verified.method,
    p_network: verified.network,
    p_verified_amount: verified.amount,
    p_verified_currency: verified.currency,
    p_fx_rate: lockedRate,
    p_auto_release_days: settings.auto_release_days,
    // §7. From the re-fetched transaction rather than the webhook body, like
    // every other figure here — this is what reconciles our ledger against what
    // the provider is actually holding.
    p_provider_fee: verified.fee,
  })

  // The provider's own observation of a transaction we have just re-verified —
  // the strongest of §6's three sources, and stronger than anything a client
  // could tell us.
  await recordContext(db, {
    deal_id: deal.id,
    source: 'provider',
    event: 'charge_confirmed',
    ip: normaliseIp(''),
    ip_country: null,
    user_agent: null,
  })

  if (error) {
    await finished(error.message)
    throw new PayHoldError('policy_violation', `Could not fund the deal: ${error.message}`)
  }

  await finished('')

  return json(req, { status: 'funded', deal_id: deal.id })
}))
