/**
 * Inbound Stripe webhook — invariants 2, 3 and 4.
 *
 *   POST /stripe-webhook/:tenant
 *
 * `flutterwave-webhook` is the pattern and this follows it deliberately: the
 * two rails differ in what they send and in nothing else about how a payment
 * becomes state. Where the shapes diverge it is noted; where they do not, the
 * code is the same code on purpose, because two webhook handlers that drifted
 * apart would mean one of them had quietly stopped re-verifying.
 *
 * The tenant is in the path because this is the one kind of endpoint with no
 * caller to authenticate: Stripe does not hold a PayHold API key. What
 * authenticates the request is the `Stripe-Signature` header, checked against
 * *that tenant's* own stored webhook secret — hence the path segment, and hence
 * a wrong tenant simply failing the check.
 *
 * The order of operations is the spec's, and none of it is optional:
 *
 *   1. Read the RAW body. Parsing before verifying is how signature checks get
 *      defeated — and Stripe's signature is over the exact bytes, so a
 *      re-serialised body fails even when it is honest.
 *   2. Record the event, whether or not it verifies. §11.8 triage depends on
 *      this table containing the ones we rejected.
 *   3. Check the signature. A forged webhook must return 401 — the test the
 *      launch gate names explicitly, on every rail.
 *   4. RE-FETCH the PaymentIntent from Stripe. The event body is never trusted
 *      for an amount; a valid signature proves who sent it, not that the
 *      numbers in it are true.
 *   5. Only then touch state, in one transactional call.
 */

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { serviceClient } from '../_shared/auth.ts'
import { convert } from '../_shared/fx.ts'
import { handler, json } from '../_shared/http.ts'
import { loadProvider } from '../_shared/load-provider.ts'
import { normaliseIp, recordContext } from '../_shared/request-context.ts'
import { persistSavedPaymentMethod } from '../_shared/settle.ts'
import { loadSettings } from '../_shared/settings.ts'
import { PayHoldError, type PaymentMethod } from '../_shared/types.ts'

/** A path segment that is not a uuid cannot be a tenant, and must not reach a query. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The events worth acting on.
 *
 * Stripe sends a great many and will send more without asking; anything not on
 * this list is recorded and acknowledged. Acknowledged rather than refused,
 * because a 4xx makes Stripe retry an event we have decided we do not want, and
 * a retry loop over an event nobody reads is noise that eventually disables the
 * endpoint.
 */
const FUNDING_EVENTS = new Set([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'payment_intent.succeeded',
])

interface StripeEvent {
  id?: string
  type?: string
  data?: {
    object?: {
      id?: string
      object?: string
      client_reference_id?: string | null
      payment_intent?: string | null
      metadata?: Record<string, string>
      payment_method_types?: string[]
      /** Only on a Checkout Session, and only when Stripe collected it. */
      customer_details?: { address?: { country?: string | null } | null } | null
    }
  }
}

/** Their payment-method vocabulary in ours. */
function methodFrom(types: string[] | undefined): PaymentMethod | null {
  const type = types?.[0]
  if (!type) return null
  if (type === 'card' || type === 'link') return 'card'
  if (['us_bank_account', 'sepa_debit', 'acss_debit', 'customer_balance'].includes(type)) {
    return 'bank_transfer'
  }
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
    provider: 'stripe',
    event_id: eventId,
    event_type: eventType,
    signature_ok: signatureOk,
    payload,
  })

  // Unique violation on (provider, event_id). A redelivery is a no-op, which is
  // what makes Stripe's at-least-once delivery safe rather than dangerous.
  if (error?.code === '23505') return 'duplicate'
  if (error) throw new Error(`could not record provider event: ${error.message}`)
  return 'new'
}

/** Finish the event row, whatever the outcome. */
async function close(
  db: SupabaseClient,
  eventId: string,
  fields: Record<string, unknown>,
): Promise<void> {
  await db
    .from('provider_events')
    .update({ processed_at: new Date().toISOString(), ...fields })
    .eq('provider', 'stripe')
    .eq('event_id', eventId)
}

Deno.serve(handler(async (req) => {
  if (req.method !== 'POST') {
    throw new PayHoldError('policy_violation', `${req.method} is not supported here`)
  }

  const segments = new URL(req.url).pathname.split('/').filter(Boolean)
  const tenantId = segments[segments.indexOf('stripe-webhook') + 1]
  if (!tenantId) {
    throw new PayHoldError('not_found', 'No tenant in the webhook path')
  }

  // (1) Raw first, always. Stripe signs these exact bytes.
  const raw = await req.text()
  const db = serviceClient()

  let event: StripeEvent
  try {
    event = JSON.parse(raw) as StripeEvent
  } catch {
    throw new PayHoldError('policy_violation', 'Body must be valid JSON')
  }

  const eventId = event.id
  if (!eventId) {
    throw new PayHoldError('policy_violation', 'Event carries no id')
  }

  // The tenant has to exist before anything can reference it: `provider_events`
  // has a foreign key to `tenants`, so a forged webhook aimed at a made-up
  // tenant would die on that constraint and surface as a 500 where the launch
  // gate requires a flat 401. The event is still recorded, with a null tenant,
  // because §11.8 triage depends on this table holding the rejections — and the
  // response is identical to a bad signature, since whether a given tenant
  // exists is not something an unauthenticated caller gets to learn.
  const known = UUID.test(tenantId)
    ? (await db.from('tenants').select('id').eq('id', tenantId).maybeSingle()).data
    : null

  const loaded = known ? await loadProvider(db, tenantId, 'stripe') : null

  // (3) Signature, against this tenant's own stored secret. Awaited, unlike
  // Flutterwave's: Stripe's is a real HMAC and Web Crypto has no synchronous
  // digest.
  const signatureOk = await (loaded?.provider.verifySignature(raw, req.headers) ?? false)
  const connected = loaded?.connected ?? false
  const provider = loaded?.provider

  // (2) Recorded either way — including the forgeries.
  const seen = await recordEvent(
    db,
    known ? tenantId : null,
    eventId,
    event.type ?? null,
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
    throw new PayHoldError('policy_violation', 'No Stripe account is connected')
  }

  if (!FUNDING_EVENTS.has(event.type ?? '')) {
    await close(db, eventId, { error: null })
    return json(req, { status: 'ignored', reason: `${event.type} is not a funding event` })
  }

  const object = event.data?.object ?? {}

  // A deposit pre-auth is not a payment and must never fund a deal. It reaches
  // `funded_held` through `capture_deposit`, which is a separate decision by a
  // person — §22.
  if (object.metadata?.kind === 'deposit') {
    await close(db, eventId, { error: null })
    return json(req, { status: 'ignored', reason: 'deposit pre-authorization' })
  }

  // Our own reference, set when the charge was created. On a Checkout Session
  // it is `client_reference_id`; on a bare PaymentIntent it is metadata. Both,
  // because Stripe sends both kinds of event for the same payment and which
  // arrives first is not ours to decide.
  const dealId = object.client_reference_id ?? object.metadata?.deal_id ?? null

  if (!dealId) {
    await close(db, eventId, { error: 'Event carries no deal reference' })
    throw new PayHoldError('policy_violation', 'Event carries no deal reference')
  }

  if (!object.id) {
    await close(db, eventId, { error: 'Event object carries no id' })
    throw new PayHoldError('policy_violation', 'Event object carries no id')
  }

  // (4) Ask Stripe what actually happened. The body above is not evidence.
  //
  // `object.id` is a `cs_…` on a session event and a `pi_…` on an intent one,
  // and `StripeProvider.verify` takes either — which is what keeps this handler
  // from having to know how Stripe models a payment.
  const verified = await provider!.verify(object.id)

  if (verified.status !== 'successful') {
    await close(db, eventId, {
      error: `Transaction is ${verified.status}, not successful`,
    })
    return json(req, { status: 'ignored', reason: verified.status })
  }

  const { data: deal } = await db
    .from('deals')
    .select('id, currency, presentment_currency, tenant_id')
    .eq('id', dealId)
    .eq('tenant_id', tenantId)
    .maybeSingle()

  if (!deal) {
    // Money arrived that we cannot attribute. §11.8 calls this out as a triage
    // case; the event row is the record that it happened.
    await close(db, eventId, { error: 'No matching deal for reference' })
    throw new PayHoldError('not_found', 'No deal matches that reference')
  }

  const settings = await loadSettings(db, tenantId)

  // The rate is locked from what actually arrived against what the seller is
  // owed, and stored on the deal. Re-deriving it later would move the number
  // under a deal that has already been paid.
  const lockedRate = verified.currency === deal.currency
    ? null
    : convert(1_000_000, deal.currency, verified.currency)?.rate ?? null

  // (5) One call. The amount/currency comparison and the state write share a
  // transaction, which is the only way "mismatch → disputed, never funded_held"
  // is a guarantee rather than a hope.
  const { error } = await db.rpc('fund_deal', {
    p_deal_id: deal.id,
    p_provider: 'stripe',
    p_provider_ref: verified.provider_ref,
    p_method: methodFrom(object.payment_method_types) ?? verified.method,
    p_network: verified.network,
    p_verified_amount: verified.amount,
    p_verified_currency: verified.currency,
    p_fx_rate: lockedRate,
    p_auto_release_days: settings.auto_release_days,
    // §7. From the re-fetched balance transaction rather than the event body,
    // like every other figure here: this is the number that reconciles our
    // ledger against what Stripe is actually holding.
    p_provider_fee: verified.fee,
  })

  // §6's request context. Stripe reports no IP on a Checkout Session — it has
  // one and does not put it on the object — so what we can honestly record is
  // the billing country the buyer gave it, and nothing else. A null address
  // with a real country is a truthful row; inventing an address would not be.
  await recordContext(db, {
    deal_id: deal.id,
    source: 'provider',
    event: 'charge_confirmed',
    ip: normaliseIp(''),
    ip_country: object.customer_details?.address?.country ?? null,
    user_agent: null,
  })

  await close(db, eventId, { reverified: true, error: error?.message ?? null })

  if (error) {
    console.error('funding failed', { deal_id: deal.id, message: error.message })
    throw new PayHoldError('invalid_state', 'Could not apply that payment')
  }

  await persistSavedPaymentMethod(db, deal.id, verified.saved_payment_method)

  return json(req, { status: 'applied', deal_id: deal.id })
}))
