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
  'beneficiary_token, masked_destination, created_at'

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

Deno.serve(handler(async (req) => {
  const db = serviceClient()
  const caller = await resolveCaller(db, req)

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
