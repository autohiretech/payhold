/**
 * Sellers — a payout destination, tokenized.
 *
 *   POST /sellers   register a destination → returns the seller, never the number
 *   GET  /sellers   list this tenant's sellers
 *
 * The raw MoMo number or bank account is used exactly once, to ask the
 * provider for a token, and is then dropped. It is never written to a column,
 * never logged, and never in a response — spec §6. What we persist is the
 * token and a display-safe mask.
 *
 * The corridor is checked before anything is stored. Most African markets can
 * be collected from and cannot be paid into, and finding that out when the
 * first payout is due — with the buyer's money already held — is the failure
 * this endpoint exists to prevent.
 */

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { resolveCaller, serviceClient, type Caller } from '../_shared/auth.ts'
import { handler, json, readJson, required } from '../_shared/http.ts'
import { loadProvider } from '../_shared/load-provider.ts'
import { countryInfo, payoutRoute } from '../_shared/rails.ts'
import { PayHoldError, type CreateSellerInput, type Seller } from '../_shared/types.ts'

const SELLER_COLUMNS =
  'id, tenant_id, name, country, payout_currency, payout_provider, ' +
  'beneficiary_token, masked_destination, kyc_status, external_user_id, ' +
  'sanctions_checked_at, destination_changed_at, created_at'

async function create(
  req: Request,
  db: SupabaseClient,
  caller: Caller,
): Promise<Response> {
  const body = await readJson<CreateSellerInput>(req)
  required(
    body as unknown as Record<string, unknown>,
    'name',
    'country',
    'payout_provider',
    'destination',
  )

  const info = countryInfo(body.country)
  const payoutCurrency = body.payout_currency ?? info.currency

  // Refuse a destination we could never send money to.
  const route = payoutRoute(body.country, payoutCurrency)
  if (route.blocked) {
    throw new PayHoldError('policy_violation', route.reason)
  }

  // Tokenize on the rail that will actually carry the payout, not on whichever
  // rail happens to be connected: a Rwandan seller is paid by Flutterwave even
  // when the buyer's card was charged by Stripe.
  const { provider } = await loadProvider(db, caller.tenant_id, route.provider!)
  const token = await provider.tokenize({
    destination: body.destination,
    currency: payoutCurrency,
    country: body.country,
  })

  const { data, error } = await db
    .from('sellers')
    .insert({
      tenant_id: caller.tenant_id,
      name: body.name,
      country: body.country,
      payout_currency: payoutCurrency,
      payout_provider: body.payout_provider,
      beneficiary_token: token.beneficiary_token,
      masked_destination: token.masked_destination,
    })
    .select(SELLER_COLUMNS)
    .single()

  if (error || !data) {
    throw new PayHoldError('policy_violation', 'Could not register that seller')
  }

  const seller = data as unknown as Seller

  await db.rpc('write_audit', {
    p_tenant: caller.tenant_id,
    p_deal: null,
    p_actor: caller.actor,
    p_action: 'seller.created',
    // The name and the mask. Never the destination — an audit log is exactly
    // the place a raw account number would survive longest.
    p_details: {
      seller_id: seller.id,
      name: seller.name,
      destination: seller.masked_destination,
    },
  })

  return json(req, { seller, payout_route: route }, 201)
}

/**
 * §10.1's `GET /v1/sellers/{id}/capabilities` — can this seller be paid, and if
 * not, what is missing.
 *
 * The same questions `screen_payout` asks, asked ahead of time. A client that
 * can show a seller "your sanctions screening is out of date" while they are
 * still onboarding is a client whose sellers do not discover it as a held
 * payout three weeks later.
 */
async function readCapabilities(
  req: Request,
  db: SupabaseClient,
  caller: Caller,
  id: string,
): Promise<Response> {
  // Tenant-scoped first, and a seller belonging to someone else is a 404 — a
  // capability read must not confirm that another tenant's seller exists.
  const { data: seller } = await db
    .from('sellers')
    .select('id')
    .eq('id', id)
    .eq('tenant_id', caller.tenant_id)
    .maybeSingle()

  if (!seller) throw new PayHoldError('not_found', `Seller ${id} not found`)

  const { data, error } = await db.rpc('seller_capabilities', { p_seller: id })
  if (error) throw new Error(`seller_capabilities failed: ${error.message}`)

  const row = (data as {
    can_receive_payouts: boolean
    kyc_status: string
    reasons: string[] | null
    route_reasons: string[] | null
  }[] | null)?.[0]

  // The two lists are separate because the answers are: `reasons` is what this
  // seller has to go and do, `route_reasons` is what PayHold cannot yet reach.
  // §5.2's second case is the second kind — a verified U.S. seller who picked
  // Venmo needs to be told that, not told to verify something again.
  return json(req, {
    can_receive_payouts: row?.can_receive_payouts ?? false,
    kyc_status: row?.kyc_status ?? 'pending',
    reasons: row?.reasons ?? [],
    route_reasons: row?.route_reasons ?? [],
  })
}

/**
 * §12: record that the identity check, the sanctions screen and the ownership
 * check came back.
 *
 * **Refuses an API key.** The same reasoning as `approve_payout_review`: a
 * client that could verify its own sellers from its own server has turned KYC
 * into a field it sets, and the attestation is supposed to be somebody's.
 */
async function verify(
  req: Request,
  db: SupabaseClient,
  caller: Caller,
  id: string,
): Promise<Response> {
  if (caller.kind === 'api_key') {
    throw new PayHoldError(
      'policy_violation',
      'Verifying a seller is a person\'s decision and cannot be done with an API key',
    )
  }

  const body = await readJson<{ verified?: boolean }>(req)

  const { data: seller } = await db
    .from('sellers')
    .select('id')
    .eq('id', id)
    .eq('tenant_id', caller.tenant_id)
    .maybeSingle()

  if (!seller) throw new PayHoldError('not_found', `Seller ${id} not found`)

  const { error } = await db.rpc('verify_seller', {
    p_seller: id,
    // From the session, never the request body — a caller that can name its own
    // verifier can forge one.
    p_actor: caller.actor,
    p_verified: body.verified ?? true,
  })
  if (error) throw new Error(`verify_seller failed: ${error.message}`)

  const { data } = await db
    .from('sellers')
    .select(SELLER_COLUMNS)
    .eq('id', id)
    .maybeSingle()

  return json(req, data)
}

Deno.serve(handler(async (req) => {
  const db = serviceClient()
  const caller = await resolveCaller(db, req)

  const url = new URL(req.url)
  const segments = url.pathname.split('/').filter(Boolean)
  const base = segments.indexOf('sellers')
  const id = segments[base + 1]
  const action = segments[base + 2]

  if (req.method === 'GET' && id && action === 'capabilities') {
    return await readCapabilities(req, db, caller, id)
  }

  if (req.method === 'POST' && id && action === 'verify') {
    return await verify(req, db, caller, id)
  }

  switch (req.method) {
    case 'POST':
      return await create(req, db, caller)
    case 'GET': {
      const { data } = await db
        .from('sellers')
        .select(SELLER_COLUMNS)
        .eq('tenant_id', caller.tenant_id)
        .order('created_at', { ascending: false })

      return json(req, { sellers: data ?? [] })
    }
    default:
      throw new PayHoldError('policy_violation', `${req.method} is not supported here`)
  }
}))
