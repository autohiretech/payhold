/**
 * Sellers — a payout destination, tokenized.
 *
 *   POST /sellers   register a destination → returns the seller, never the number
 *   GET  /sellers   list this tenant's sellers, or `?external_user_id=` to find
 *                   the one registered against the client's own handle
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
import { dispatchPayout } from '../_shared/dispatch.ts'
import { handler, json, readJson, required } from '../_shared/http.ts'
import { loadProvider } from '../_shared/load-provider.ts'
import { countryInfo, payoutRoute } from '../_shared/rails.ts'
import {
  PayHoldError,
  type AddDestinationInput,
  type CreateSellerInput,
  type Payout,
  type Seller,
} from '../_shared/types.ts'

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

  // §11's external user id: the client's own handle for this person. Checked
  // before the provider is asked for anything, so a retried registration does
  // not mint a beneficiary token nobody will use.
  //
  // It refuses rather than returning the existing seller, because the two
  // requests are not the same request: this one carries a destination, and
  // silently ignoring it would turn a re-registration into a no-op that looks
  // like a destination change was accepted. Moving a destination is
  // `seller_destinations` and §5.1's security hold, which is the path that
  // holds the next payout — exactly what a takeover would want to skip.
  const externalUserId = body.external_user_id?.trim() || null
  if (externalUserId) {
    const { data: existing } = await db
      .from('sellers')
      .select('id')
      .eq('tenant_id', caller.tenant_id)
      .eq('external_user_id', externalUserId)
      .maybeSingle()

    if (existing) {
      throw new PayHoldError(
        'policy_violation',
        `${externalUserId} is already registered as seller ${existing.id}`,
      )
    }
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
      external_user_id: externalUserId,
    })
    .select(SELLER_COLUMNS)
    .single()

  if (error || !data) {
    // The lookup above is not a lock, so two concurrent registrations of one
    // handle both reach here and `sellers_external_user_key` refuses the
    // second. Say which it was — the caller is a retry loop, and "could not
    // register that seller" is not something it can act on.
    if (error?.message?.includes('sellers_external_user_key')) {
      throw new PayHoldError(
        'policy_violation',
        `${externalUserId} is already registered as a seller`,
      )
    }
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
      external_user_id: seller.external_user_id,
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

/**
 * `POST /v1/sellers/:id/destinations` — §5.1: move where a seller is paid, or
 * give them a backup.
 *
 * The other half of `POST /sellers`, and the reason that one is allowed to
 * refuse a handle it already knows. A registration carries the *first*
 * destination; every one after it comes through here, where the security hold
 * is, and a client with a seller whose MoMo line was cut off finally has
 * something to call.
 *
 * Three things happen in an order that matters. The corridor is checked first,
 * so a destination PayHold could never pay is refused before a provider is
 * asked for anything. Then the raw destination is tokenized — used exactly once
 * and dropped, §19, the same as at registration. Only then does
 * `add_seller_destination` swap the primary over inside one transaction, which
 * is where the demote-and-insert has to happen: `seller_destinations_one_primary`
 * refuses the overlap, and doing it in two statements leaves a window in which
 * the seller has no primary destination and is unpayable.
 *
 * The new row comes back unverified and inside its hold. That is §5.1's change
 * protection and there is no parameter to turn it off: a takeover's whole play
 * is to move the destination and withdraw, and the hold is what puts a person
 * between those two steps. A client should tell its seller that payouts pause
 * until the new account is verified, because they will.
 */
async function addDestination(
  req: Request,
  db: SupabaseClient,
  caller: Caller,
  id: string,
): Promise<Response> {
  const { data } = await db
    .from('sellers')
    .select('id, country, payout_currency')
    .eq('id', id)
    .eq('tenant_id', caller.tenant_id)
    .maybeSingle()

  if (!data) throw new PayHoldError('not_found', `Seller ${id} not found`)
  const seller = data as unknown as Pick<Seller, 'country' | 'payout_currency'>

  const body = await readJson<AddDestinationInput>(req)
  required(body as unknown as Record<string, unknown>, 'payout_provider', 'destination')

  const role = body.role ?? 'primary'
  if (role !== 'primary' && role !== 'backup') {
    throw new PayHoldError(
      'policy_violation',
      `A destination is primary or backup, not ${role}`,
    )
  }

  // Defaulting to the seller's own country and currency rather than requiring
  // them: a seller who moves from MoMo to a bank account has not moved country,
  // and a client that had to restate it could get it wrong. A stated country
  // brings its own currency with it, because the pair has to agree — a
  // destination in Kenya paid in RWF is a corridor, not a preference.
  const country = body.country ?? seller.country
  const payoutCurrency = body.payout_currency ??
    (body.country ? countryInfo(body.country).currency : seller.payout_currency)

  const route = payoutRoute(country, payoutCurrency)
  if (route.blocked) throw new PayHoldError('policy_violation', route.reason)

  const { provider } = await loadProvider(db, caller.tenant_id, route.provider!)
  const token = await provider.tokenize({
    destination: body.destination,
    currency: payoutCurrency,
    country,
  })

  const { data: added, error } = await db.rpc('add_seller_destination', {
    p_seller: id,
    p_tenant: caller.tenant_id,
    p_country: country,
    p_currency: payoutCurrency,
    p_provider: body.payout_provider,
    p_token: token.beneficiary_token,
    p_masked: token.masked_destination,
    p_label: body.label ?? null,
    p_role: role,
    p_actor: caller.actor,
  })

  if (error) {
    // The function's own refusals are answers, not faults — an unknown seller,
    // a role that is not a role. A 500 would tell the client to retry them.
    throw new PayHoldError('policy_violation', error.message)
  }

  // `beneficiary_token` is on the returned row and must not go out: it is the
  // provider-side handle money moves against, and the whole point of returning
  // a mask is that this never leaves.
  const { beneficiary_token: _token, ...destination } = added as Record<string, unknown>

  return json(req, { destination, payout_route: route }, 201)
}

/**
 * Confirm a seller belongs to the calling tenant, or 404.
 *
 * A 403 would confirm the row exists, which invariant 8 forbids: a response
 * must not reveal that other tenants have sellers.
 */
async function ownSeller(
  db: SupabaseClient,
  caller: Caller,
  id: string,
): Promise<void> {
  const { data } = await db
    .from('sellers')
    .select('id')
    .eq('id', id)
    .eq('tenant_id', caller.tenant_id)
    .maybeSingle()

  if (!data) throw new PayHoldError('not_found', `Seller ${id} not found`)
}

/**
 * `GET /v1/sellers/:id/balance` — one seller's wallet.
 *
 * Two shapes, because they answer two questions and neither answers the other.
 * `balances` is ledger money in the currency the buyer was charged, derived the
 * same way `GET /v1/balance` is, so a tenant can add its sellers up and get its
 * own balance back. `withdrawable` is the payout rows in the seller's *own*
 * payout currency — what a withdrawal would actually move — with a count
 * against each reason something is stuck.
 *
 * A cross-border deal makes the two genuinely different numbers in genuinely
 * different currencies, and collapsing them would mean picking one to be wrong.
 *
 * This is a tenant read. The seller has no login and is not the caller: their
 * platform fetches this with its own API key and renders it in its own app,
 * exactly as it does with `/capabilities`.
 */
async function readWallet(
  req: Request,
  db: SupabaseClient,
  caller: Caller,
  id: string,
): Promise<Response> {
  await ownSeller(db, caller, id)

  const [balances, withdrawable] = await Promise.all([
    db.rpc('seller_balance', { p_seller: id }),
    db.rpc('seller_withdrawable', { p_seller: id }),
  ])

  if (balances.error) throw new Error(`seller_balance failed: ${balances.error.message}`)
  if (withdrawable.error) {
    throw new Error(`seller_withdrawable failed: ${withdrawable.error.message}`)
  }

  return json(req, {
    seller_id: id,
    balances: balances.data ?? [],
    withdrawable: withdrawable.data ?? [],
  })
}

/**
 * `POST /v1/sellers/:id/withdraw` — ask for the cleared money.
 *
 * The request stamps the seller's due payouts and re-arms their retry clock;
 * `dispatchPayout` then does everything it does for the cron — the frozen-tenant
 * check, `screen_payout`'s eligibility gate, `route_payout`'s decision, the
 * provider call, the booking. Nothing here is a shortcut past any of it, which
 * is the point: a withdrawal path that skipped the gate would be a second way
 * to pay a seller nobody had verified, and §12 says there must not be one.
 *
 * `destination_id` is optional and must be one of the seller's own verified
 * destinations. It is a choice among rows they already registered, never a new
 * address — a withdrawal that could name a fresh destination is the shape an
 * account takeover uses, which is what §5.1's security hold exists to catch.
 *
 * Unlike `/verify` this accepts an API key. Verifying is an attestation and has
 * to be somebody's; asking for money that has already cleared every check is
 * the seller's own routine act, and their platform makes it on their behalf.
 */
async function withdraw(
  req: Request,
  db: SupabaseClient,
  caller: Caller,
  id: string,
): Promise<Response> {
  await ownSeller(db, caller, id)

  const body = await readJson<{ destination_id?: string }>(req)

  const { data, error } = await db.rpc('request_withdrawal', {
    p_seller: id,
    p_actor: caller.actor,
    p_destination: body.destination_id ?? null,
  })

  if (error) {
    // The function's own refusals are the seller's answer — nothing cleared to
    // withdraw, an unverified destination, one still inside its security hold.
    // They are policy, not faults, and a 500 would tell a client to retry.
    throw new PayHoldError('policy_violation', error.message)
  }

  const requested = (data ?? []) as unknown as { id: string }[]

  // Sent one at a time and the outcome recorded per payout. One seller's rail
  // refusing must not strand the rest of their own withdrawal, and a single
  // aggregate status would hide a partial send — which is the thing a person
  // chasing "where is my money" most needs to see.
  const results: { payout_id: string; outcome: string }[] = []

  for (const payout of requested) {
    const { data: row } = await db
      .from('payouts')
      .select('id, tenant_id, deal_id, seller_id, amount, currency, status, ' +
        'scheduled_for, paid_at, failure_reason, attempts, next_attempt_at')
      .eq('id', payout.id)
      .single()

    try {
      results.push({
        payout_id: payout.id,
        outcome: await dispatchPayout(db, row as unknown as Payout),
      })
    } catch (err) {
      console.error('withdrawal dispatch failed', {
        payout_id: payout.id,
        seller_id: id,
        message: err instanceof Error ? err.message : String(err),
      })
      results.push({ payout_id: payout.id, outcome: 'errored' })
    }
  }

  return json(req, { seller_id: id, requested: results.length, payouts: results })
}

/**
 * `GET /v1/sellers/wallets` — every seller's wallet, one query.
 *
 * The list an operator reads and the list a client app pages through. A
 * per-seller round trip would be one request per row of a screen whose whole
 * purpose is showing them together.
 */
async function readAllWallets(
  req: Request,
  db: SupabaseClient,
  caller: Caller,
): Promise<Response> {
  const { data, error } = await db.rpc('tenant_seller_wallets', {
    p_tenant: caller.tenant_id,
  })

  if (error) throw new Error(`tenant_seller_wallets failed: ${error.message}`)

  return json(req, { wallets: data ?? [] })
}

Deno.serve(handler(async (req) => {
  const db = serviceClient()
  const caller = await resolveCaller(db, req)

  const url = new URL(req.url)
  const segments = url.pathname.split('/').filter(Boolean)
  const base = segments.indexOf('sellers')
  const id = segments[base + 1]
  const action = segments[base + 2]

  // Ahead of the `:id` routes: `wallets` is a collection, not a seller, and a
  // uuid column would refuse it anyway — with a 500 rather than a 404.
  if (req.method === 'GET' && id === 'wallets' && !action) {
    return await readAllWallets(req, db, caller)
  }

  if (req.method === 'GET' && id && action === 'capabilities') {
    return await readCapabilities(req, db, caller, id)
  }

  // §5.1's preferred destination and verified backup — which one pair of
  // columns on the seller could not express, and which the payout path now
  // reads instead of `sellers.beneficiary_token`.
  //
  // `beneficiary_token` is **not** selected. It is the provider-side handle
  // money moves against; a screen needs the mask and never the token, and a
  // list endpoint is exactly where one would leak.
  if (req.method === 'GET' && id && action === 'destinations') {
    await ownSeller(db, caller, id)

    const { data } = await db
      .from('seller_destinations')
      .select('id, seller_id, label, country, payout_currency, payout_provider, ' +
        'masked_destination, is_primary, is_backup, verified_at, ' +
        'security_hold_until, created_at')
      .eq('seller_id', id)
      .eq('tenant_id', caller.tenant_id)
      .order('is_primary', { ascending: false })
      .order('created_at', { ascending: true })

    return json(req, { destinations: data ?? [] })
  }

  if (req.method === 'GET' && id && action === 'balance') {
    return await readWallet(req, db, caller, id)
  }

  // §5.1's change protection lives behind this, which is why moving a
  // destination is not `POST /sellers` again: that one refuses a handle it
  // already knows precisely so a re-registration cannot become a silent
  // destination change that skipped the hold.
  if (req.method === 'POST' && id && action === 'destinations') {
    return await addDestination(req, db, caller, id)
  }

  if (req.method === 'POST' && id && action === 'withdraw') {
    return await withdraw(req, db, caller, id)
  }

  if (req.method === 'POST' && id && action === 'verify') {
    return await verify(req, db, caller, id)
  }

  switch (req.method) {
    case 'POST':
      return await create(req, db, caller)
    case 'GET': {
      // §11's handle as a lookup — "which seller is this user of mine". PayHold
      // mints no seller identity, so a client registers its own users and this
      // is how it finds one again without keeping our id beside its own. It is
      // also the missing half of a get-or-create: `POST /sellers` refuses a
      // handle it already knows, and a caller has to be able to ask first.
      //
      // No match is an empty list rather than a 404. "This user is not
      // registered yet" is the answer the caller is asking for, not a failure.
      const handle = url.searchParams.get('external_user_id')

      // Blank is refused rather than ignored: answering `?external_user_id=`
      // with the whole list would be a filter that silently did nothing, and
      // the caller would read the first row as their seller.
      if (handle !== null && !handle.trim()) {
        throw new PayHoldError(
          'policy_violation',
          'external_user_id cannot be blank',
        )
      }

      let query = db
        .from('sellers')
        .select(SELLER_COLUMNS)
        .eq('tenant_id', caller.tenant_id)

      // Trimmed the same way `create` trims it before storing, or a handle
      // carrying a stray space would register fine and then never be found.
      if (handle !== null) query = query.eq('external_user_id', handle.trim())

      const { data } = await query.order('created_at', { ascending: false })

      return json(req, { sellers: data ?? [] })
    }
    default:
      throw new PayHoldError('policy_violation', `${req.method} is not supported here`)
  }
}))
