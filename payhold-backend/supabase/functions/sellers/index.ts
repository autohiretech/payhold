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
import { handler, json, readJson, required, routeNotFound } from '../_shared/http.ts'
import { loadProvider } from '../_shared/load-provider.ts'
import { momoBankCode, momoNetworksFor } from '../_shared/momo.ts'
import { countryInfo, payoutRoute } from '../_shared/rails.ts'
import { withCallerLabel } from '../_shared/seller-mask.ts'
import {
  countryLabel,
  resolveSellerMarket,
  withCountryProvenance,
  type SellerMarket,
} from '../_shared/seller-market.ts'
import {
  assertRailOnRoute,
  assertRailRequirementsMet,
  assertRailSwitchedOnRows,
  evaluateRails,
  railAdapterFor,
  railRoute,
} from './rail-adapter.ts'
import { StripeProvider } from '../_shared/stripe.ts'
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
  'sanctions_checked_at, destination_changed_at, active, created_at'

/**
 * **`beneficiary_token` is not in this list and must not join it.** It is the
 * provider-side handle money moves against; a screen needs the mask, and a
 * read that returns several rows at once is exactly where one would leak.
 */
const DESTINATION_COLUMNS =
  'id, seller_id, label, country, payout_currency, payout_provider, ' +
  'masked_destination, is_primary, is_backup, verified_at, ' +
  'security_hold_until, created_at'

/**
 * What the rail needs to know about a destination beyond the number itself.
 *
 * Registering a destination and moving one are different operations with
 * different guards, but this rule is the same for both, so it is written once:
 * a mobile money beneficiary is registered against a **carrier** and a bank
 * beneficiary against a **bank code**, and neither has a default that is safe
 * to assume. Sending nothing — which every corridor except RWF did until this
 * was fixed — registers a beneficiary Flutterwave will not transfer to, and
 * the failure lands weeks later on a payout with the buyer's money already
 * collected.
 *
 * Refused here, before anything is sent to a provider, so the client is told
 * what to ask its seller for rather than being handed a rail's error.
 */
function destinationCredentials(
  rail: string,
  country: string,
  body: { network?: string; bank_code?: string },
): { network?: string; bank_code?: string } {
  if (rail === 'flutterwave_momo') {
    if (!body.network?.trim()) {
      const available = momoNetworksFor(country).map((n) => n.label)
      throw new PayHoldError(
        'policy_violation',
        available.length
          ? `A mobile money destination needs its network. In ${country} that is: ${
            available.join(', ')
          }`
          : `PayHold cannot pay a mobile money wallet in ${country} yet`,
      )
    }
    // Resolved now rather than at the provider call, so an unknown wallet is
    // refused before a beneficiary exists anywhere.
    momoBankCode(country, body.network)
    return { network: body.network.trim() }
  }

  if (rail === 'flutterwave_bank') {
    if (!body.bank_code?.trim()) {
      throw new PayHoldError(
        'policy_violation',
        'A bank destination needs the bank code. ' +
          `GET /v1/payment-options?payout_country=${country}&banks=1 lists them.`,
      )
    }
    return { bank_code: body.bank_code.trim() }
  }

  // Stripe Connect takes an `acct_…` and nothing else, and PayPal takes an
  // account email or a payer id — both are the whole destination, with no
  // carrier or bank code to name beside them, so there is nothing to collect
  // here for either. (This used to say the wallets never reach a tokenize
  // call. PayPal does, as of 2026-09-10: its route row is enabled and
  // `PayPalProvider.tokenize` validates the address it is given. The four
  // still-refused rails — Venmo, Cash App Pay, Alipay, WeChat Pay — are
  // refused by `assertRailOnRoute` before this is reached, not by returning
  // nothing from here.)
  return {}
}

async function create(
  req: Request,
  db: SupabaseClient,
  caller: Caller,
): Promise<Response> {
  const body = await readJson<CreateSellerInput>(req)
  required(body as unknown as Record<string, unknown>, 'name')

  // A destination is optional at registration — a host becomes a payable
  // party the moment PayHold knows who they are, and money can accrue in
  // `held`/`available` against them from their first deal. What is not
  // optional is doing it by halves: `country` and `payout_provider` name a
  // rail and a corridor together, and accepting one without the other would
  // silently drop it, which is worse than refusing.
  const hasDestination = body.country !== undefined || body.payout_provider !== undefined ||
    body.destination !== undefined
  if (hasDestination) {
    required(
      body as unknown as Record<string, unknown>,
      'country',
      'payout_provider',
      'destination',
    )
  }

  let route: ReturnType<typeof payoutRoute> | null = null
  let payoutCurrency: string | null = null
  let token: { beneficiary_token: string; masked_destination: string } | null = null

  if (hasDestination) {
    // `required` above already threw if any of these three were missing.
    const country = body.country!
    const destination = body.destination!

    const info = countryInfo(country)
    payoutCurrency = body.payout_currency ?? info.currency

    // Refuse a destination we could never send money to. `corridor` is the
    // market's own preferred route and is what the three checks below are made
    // against; what comes back in the response is the *rail's* route, built
    // from it once the rail has been accepted — see `railRoute`.
    const corridor = payoutRoute(country, payoutCurrency)
    if (corridor.blocked) {
      throw new PayHoldError('policy_violation', corridor.reason)
    }
    // A corridor the adapter cannot send on (it wants fields PayHold does not
    // collect) is refused first, because it is the only one of the three that
    // costs nothing to ask.
    assertRailRequirementsMet(body.payout_provider!, country)
    // Then the table's own verdict for every rail on this corridor, read once.
    // `blocked` only says the corridor is unreachable; it says nothing about
    // whether the rail the caller named is one that reaches it, and this is
    // the registration half of the hole `addDestination` was found through. A
    // market can have more than one live rail, and the corridor's *preferred*
    // rail is not the only one a seller may choose — `rail-adapter.ts` has the
    // account of what that got wrong.
    const rails = await evaluateRails(db, caller.tenant_id, country, payoutCurrency)
    assertRailOnRoute(body.payout_provider!, country, corridor, rails)
    assertRailSwitchedOnRows(rails, body.payout_provider!, country)

    // The rail is accepted, so the response can describe it rather than the
    // corridor's default — `addDestination` does the same, for the account in
    // `railRoute`'s header.
    route = railRoute(body.payout_provider!, country, corridor)

    // Which wallet or bank, checked before anything is sent anywhere. A
    // beneficiary registered without it is one the rail will not transfer to.
    const credentials = destinationCredentials(body.payout_provider!, country, body)

    // Tokenize on the adapter that will actually carry this destination's
    // payout, not on whichever rail happens to be connected: a Rwandan seller
    // is paid by Flutterwave even when the buyer's card was charged by Stripe.
    //
    // It is the **rail's** adapter, not `corridor.provider`. Those are the same
    // thing whenever the seller picked the corridor's preferred rail, and were
    // the same thing everywhere while a corridor had only one — but a US
    // seller choosing PayPal in a market `payoutRoute` prefers Stripe for would
    // otherwise have had a PayPal destination minted by Stripe, which is the
    // Rwandan `Card •••• 4538` row again from the other direction.
    // `assertRailOnRoute` has just checked this adapter against the routing
    // table's own row for the rail, so the two cannot disagree here.
    const { provider } = await loadProvider(
      db,
      caller.tenant_id,
      railAdapterFor(body.payout_provider!)!,
    )
    token = await provider.tokenize({
      destination,
      currency: payoutCurrency,
      country,
      beneficiary_name: body.name,
      ...credentials,
    })
    // The provider's own mask guesses its leading word from a field it does
    // not always get back (Flutterwave's `bank_name`, unset for every RWF
    // corridor) — the caller already knows which method this is, since it is
    // what chose `payout_provider` a few lines up.
    token = { ...token, masked_destination: withCallerLabel(token.masked_destination, body.label) }
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

  const { data, error } = await db
    .from('sellers')
    .insert({
      tenant_id: caller.tenant_id,
      name: body.name,
      country: hasDestination ? body.country : null,
      payout_currency: payoutCurrency,
      payout_provider: hasDestination ? body.payout_provider : null,
      beneficiary_token: token?.beneficiary_token ?? null,
      masked_destination: token?.masked_destination ?? null,
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
 * `POST /v1/sellers/:id/active` — whether this seller is currently one of the
 * tenant's active sellers, as opposed to someone who used to be.
 *
 * Status only. It carries no weight on the payout path — a seller who steps
 * back is still owed whatever they already earned, and `screen_payout` does
 * not read this column. **Accepts an API key**, unlike `/verify`: this is not
 * an attestation, it is the client restating a fact about its own business
 * that it already knows firsthand — the same reasoning `/withdraw` accepts one
 * for. A tenant that could not say "this host stopped hosting" without a
 * person in the loop would have to route every role change through its
 * dashboard, which is not where its hosts are.
 */
async function setActive(
  req: Request,
  db: SupabaseClient,
  caller: Caller,
  id: string,
): Promise<Response> {
  await ownSeller(db, caller, id)

  const body = await readJson<{ active?: boolean }>(req)

  const { error } = await db.rpc('set_seller_active', {
    p_seller: id,
    p_tenant: caller.tenant_id,
    p_active: body.active ?? true,
    p_actor: caller.actor,
  })
  if (error) throw new Error(`set_seller_active failed: ${error.message}`)

  const { data } = await db
    .from('sellers')
    .select(SELLER_COLUMNS)
    .eq('id', id)
    .maybeSingle()

  return json(req, data)
}

/**
 * `POST /v1/sellers/:id/name` — keep this seller's name matching the client's
 * own record of them.
 *
 * `create` set `name` once and nothing has touched it since — a client's own
 * name for this person can change after registration (a profile edit, a typo
 * fix), and until this route PayHold had no way to be told. Same reasoning as
 * `/active`: this is not an attestation, it is the client restating a fact it
 * already knows about its own business, so it accepts an API key rather than
 * a person in the loop.
 */
async function setName(
  req: Request,
  db: SupabaseClient,
  caller: Caller,
  id: string,
): Promise<Response> {
  await ownSeller(db, caller, id)

  const body = await readJson<{ name?: string }>(req)
  required(body as unknown as Record<string, unknown>, 'name')

  const { error } = await db.rpc('set_seller_name', {
    p_seller: id,
    p_tenant: caller.tenant_id,
    p_name: body.name,
    p_actor: caller.actor,
  })
  if (error) throw new Error(`set_seller_name failed: ${error.message}`)

  const { data } = await db
    .from('sellers')
    .select(SELLER_COLUMNS)
    .eq('id', id)
    .maybeSingle()

  return json(req, data)
}

/**
 * `POST /v1/sellers/:id/destinations/:destinationId/end-hold` — §5.1's step-up.
 *
 * The section asks for two things and the table only had one of them. A new
 * destination "enters a short security hold **and may require re-authentication
 * or step-up verification before use**" — `add_seller_destination` writes the
 * hold, and until this endpoint there was nothing to record the step-up with.
 * The hold could only expire, so a seller who rang in, answered the questions
 * and had the change confirmed still waited out a timer.
 *
 * **Refuses an API key**, for the reason `/verify` does and more sharply. The
 * hold exists because "get in, move the destination, withdraw" is the shape of
 * an account takeover; a client that could end its own holds from its own
 * server would have deleted the defence rather than satisfied it.
 *
 * **It does not verify the destination**, and the two must stay apart. Each
 * stops a payout on its own and §5.1 wants both — `verify_seller` is the other,
 * and it attests to a different thing: that the identity, sanctions and
 * ownership checks came back, rather than that this particular change was the
 * seller's own act.
 */
async function endHold(
  req: Request,
  db: SupabaseClient,
  caller: Caller,
  id: string,
  destinationId: string,
): Promise<Response> {
  if (caller.kind === 'api_key') {
    throw new PayHoldError(
      'policy_violation',
      "Ending a destination's security hold is a person's decision and cannot " +
        'be done with an API key',
    )
  }

  await ownSeller(db, caller, id)

  // Scoped to the seller as well as the tenant. A destination id belonging to
  // another of this account's sellers would otherwise be endable through
  // whichever seller page the caller happened to be on, and the audit row would
  // name the wrong one.
  const { data: destination } = await db
    .from('seller_destinations')
    .select('id')
    .eq('id', destinationId)
    .eq('seller_id', id)
    .eq('tenant_id', caller.tenant_id)
    .maybeSingle()

  if (!destination) {
    throw new PayHoldError('not_found', `Destination ${destinationId} not found`)
  }

  const { error } = await db.rpc('end_destination_hold', {
    p_destination: destinationId,
    p_tenant: caller.tenant_id,
    // From the session, never the request body — a caller that can name its own
    // actor can forge one.
    p_actor: caller.actor,
  })
  if (error) throw new Error(`end_destination_hold failed: ${error.message}`)

  const { data } = await db
    .from('seller_destinations')
    .select(DESTINATION_COLUMNS)
    .eq('id', destinationId)
    .maybeSingle()

  return json(req, data)
}

/**
 * `POST /v1/sellers/:id/destinations/:destinationId/verify` — §5.1's
 * attestation, per destination.
 *
 * `verify_seller` stamps only the primary, which was right while a seller had
 * one destination and wrong the moment §5.1 gave them a backup. A destination
 * displaced before anyone verified it could not be verified (not primary) and
 * could not be promoted to become primary (`promote_seller_destination`
 * refuses an unverified row) — a deadlock with no endpoint to break it. The
 * visible cost was a row reading "Not verified" forever; the real one is that
 * `route_payout` requires `verified_at is not null` on a backup, so §5.1's
 * failover was unreachable for any backup that missed its turn as primary.
 *
 * **Refuses an API key**, the same ground `/verify` stands on: a client that
 * could verify its own destinations has turned the check into a field it sets.
 *
 * **It does not end the security hold** — `end-hold` next door is the other
 * stop, and each attests to a different thing. Verifying says the account
 * belongs to them; ending the hold says this particular change was their own
 * act. §5.1 wants both, so one must never quietly satisfy the other.
 */
async function verifyDestination(
  req: Request,
  db: SupabaseClient,
  caller: Caller,
  id: string,
  destinationId: string,
): Promise<Response> {
  if (caller.kind === 'api_key') {
    throw new PayHoldError(
      'policy_violation',
      'Verifying a payout destination is a person\'s decision and cannot be ' +
        'done with an API key',
    )
  }

  const body = await readJson<{ verified?: boolean }>(req)

  await ownSeller(db, caller, id)

  // Scoped to the seller as well as the tenant, for `endHold`'s reason: a
  // destination belonging to another of this account's sellers would otherwise
  // be verifiable from whichever seller page the caller happened to be on, and
  // the audit row would name the wrong one.
  const { data: destination } = await db
    .from('seller_destinations')
    .select('id')
    .eq('id', destinationId)
    .eq('seller_id', id)
    .eq('tenant_id', caller.tenant_id)
    .maybeSingle()

  if (!destination) {
    throw new PayHoldError('not_found', `Destination ${destinationId} not found`)
  }

  const { error } = await db.rpc('verify_seller_destination', {
    p_destination: destinationId,
    p_tenant: caller.tenant_id,
    // From the session, never the request body — a caller that can name its own
    // verifier can forge one.
    p_actor: caller.actor,
    p_verified: body.verified ?? true,
  })
  if (error) throw new Error(`verify_seller_destination failed: ${error.message}`)

  const { data } = await db
    .from('seller_destinations')
    .select(DESTINATION_COLUMNS)
    .eq('id', destinationId)
    .maybeSingle()

  return json(req, data)
}

/**
 * `POST /v1/sellers/:id/destinations/:destinationId/promote` — §5.1's move back.
 *
 * `POST /destinations` always writes a new row with a new hold, which is right
 * for a destination nobody has seen and wrong for one this system already
 * tokenized, verified and held once. A seller whose card destination turned out
 * to be unroutable had no way back to their old mobile-money line except by
 * re-registering it and serving the hold again.
 *
 * **Refuses an API key**, like its two neighbours. It is a narrower door than
 * either: `promote_seller_destination` refuses an unverified destination and
 * one still inside its hold, so it picks between destinations a person has
 * already checked and cannot reach anything new. A takeover's freshly added row
 * fails both guards.
 */
async function promoteDestination(
  req: Request,
  db: SupabaseClient,
  caller: Caller,
  id: string,
  destinationId: string,
): Promise<Response> {
  if (caller.kind === 'api_key') {
    throw new PayHoldError(
      'policy_violation',
      "Moving a seller's payout destination is a person's decision and cannot " +
        'be done with an API key',
    )
  }

  await ownSeller(db, caller, id)

  const { data: destination } = await db
    .from('seller_destinations')
    .select('id')
    .eq('id', destinationId)
    .eq('seller_id', id)
    .eq('tenant_id', caller.tenant_id)
    .maybeSingle()

  if (!destination) {
    throw new PayHoldError('not_found', `Destination ${destinationId} not found`)
  }

  const { error } = await db.rpc('promote_seller_destination', {
    p_destination: destinationId,
    p_tenant: caller.tenant_id,
    p_actor: caller.actor,
  })
  if (error) {
    // Its refusals are answers, not faults — an unverified destination, one
    // still inside its hold. Same reading `addDestination` gives them: a 500
    // would tell the client to retry something that will never succeed.
    throw new PayHoldError('policy_violation', error.message)
  }

  const { data } = await db
    .from('seller_destinations')
    .select(DESTINATION_COLUMNS)
    .eq('id', destinationId)
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
    .select('id, name, country, payout_currency')
    .eq('id', id)
    .eq('tenant_id', caller.tenant_id)
    .maybeSingle()

  if (!data) throw new PayHoldError('not_found', `Seller ${id} not found`)
  const seller = data as unknown as Pick<Seller, 'name' | 'country' | 'payout_currency'>

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
  //
  // A seller registered with no destination at all has no country to default
  // to — `POST /v1/sellers` no longer requires one — so this, their first
  // destination, is the first point anybody has to say which market they are
  // in.
  //
  // `resolveSellerMarket` is that same rule, plus the record of which way it
  // went. The stored country is the first destination's and can be years stale,
  // so every refusal below has to be able to say the country was ours — see
  // `withCountryProvenance`.
  //
  // The sentence is written for the person who reads it. A tenant's app shows
  // our `message` to the host on their own payout screen, so `this seller has
  // no country on file` — which is our column, our word for them, and a fact
  // about a record they have never seen — becomes a dead end on somebody's
  // phone. What they can act on is the question nobody has answered yet.
  const market = resolveSellerMarket(body, seller)
  if (!market) {
    throw new PayHoldError(
      'policy_violation',
      'We do not have a payout country for you yet. ' +
        'Choose the country your payout account is in and try again.',
    )
  }
  const { country, currency: payoutCurrency } = market

  // The market's own preferred route, which is what the checks below are made
  // against and — until 2026-09-10 — was also what came back as
  // `payout_route`. It is not the destination being registered whenever the
  // caller named one of the corridor's other live rails; `railRoute` below is
  // that, and its header is the account of what returning this instead said.
  //
  // Everything from here to the tokenize call is refused in terms of a country
  // the caller may never have named, so it is wrapped: a refusal that quotes a
  // market back at a host who did not ask for it has to say where it came from,
  // or the only fix left to them is guessing.
  let route: ReturnType<typeof railRoute>
  let credentials: { network?: string; bank_code?: string }
  try {
    const corridor = payoutRoute(country, payoutCurrency)
    if (corridor.blocked) throw new PayHoldError('policy_violation', corridor.reason)

    // `corridor.blocked` used to be the only check here, and it is the wrong one
    // for the rail the caller named: RW/RWF is not blocked, it is Flutterwave's,
    // so a `stripe_connect` request sailed through, was tokenized on the
    // corridor's own provider below — Flutterwave — and was stored claiming
    // Stripe. `rail-adapter.ts` has the whole account; this is where it happened.
    // Same three checks as `create`, same order, same reasons.
    assertRailRequirementsMet(body.payout_provider, country)
    const rails = await evaluateRails(db, caller.tenant_id, country, payoutCurrency)
    assertRailOnRoute(body.payout_provider, country, corridor, rails)
    assertRailSwitchedOnRows(rails, body.payout_provider, country)

    // The rail is accepted, so `payout_route` can describe the destination this
    // call is creating instead of the one PayHold would have picked for it.
    route = railRoute(body.payout_provider, country, corridor)

    credentials = destinationCredentials(body.payout_provider, country, body)
  } catch (err) {
    throw withCountryProvenance(err, market)
  }

  // The rail's own adapter, for `create`'s reason.
  const { provider } = await loadProvider(
    db,
    caller.tenant_id,
    railAdapterFor(body.payout_provider)!,
  )
  const token = await provider.tokenize({
    destination: body.destination,
    currency: payoutCurrency,
    country,
    beneficiary_name: seller.name ?? undefined,
    ...credentials,
  })
  // Same reasoning as `create`'s tokenize call — the mask's guessed prefix is
  // less trustworthy than the label the caller already has for this method.
  const masked = withCallerLabel(token.masked_destination, body.label)

  const { data: added, error } = await db.rpc('add_seller_destination', {
    p_seller: id,
    p_tenant: caller.tenant_id,
    p_country: country,
    p_currency: payoutCurrency,
    p_provider: body.payout_provider,
    p_token: token.beneficiary_token,
    p_masked: masked,
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

  // `country_source` on the way out for the reason the refusals carry it on the
  // way back: the row above says `RW` whether the caller asked for RW or PayHold
  // filled it in, and a client reconciling what it sent against what was stored
  // cannot tell those apart from the destination alone. Additive and cheap —
  // one field, already known.
  return json(
    req,
    { destination, payout_route: route, country_source: market.country_source },
    201,
  )
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

/**
 * Get the seller to the point of having an `acct_…` mid-onboarding, shared by
 * both ways of presenting Stripe's form.
 *
 * Extracted rather than duplicated because everything up to "and now show them
 * the form" is a decision about money that must not be able to differ between
 * the redirect and the embedded mount: which market this seller is in, whether
 * that market is even paid out by Connect, whether this tenant has a Stripe
 * account at all, and whether an account for this seller already exists. A
 * second copy of that chain is a second place for a corridor to be answered
 * differently depending on which button the client rendered.
 */
async function connectAccountFor(
  db: SupabaseClient,
  caller: Caller,
  id: string,
  body: { country?: string; email?: string | null },
): Promise<{ provider: StripeProvider; accountId: string; market: SellerMarket }> {
  const { data } = await db
    .from('sellers')
    .select('id, country, payout_currency, stripe_connect_pending_account_id')
    .eq('id', id)
    .eq('tenant_id', caller.tenant_id)
    .maybeSingle()
  if (!data) throw new PayHoldError('not_found', `Seller ${id} not found`)
  const seller = data as unknown as {
    country: string | null
    payout_currency: string | null
    stripe_connect_pending_account_id: string | null
  }

  // Same "this is their first destination" gate `addDestination` enforces —
  // a seller registered with no destination has no country to default to — and
  // the same defaulting, through the same resolver, so the two cannot answer a
  // market differently or disagree about who named it.
  const market = resolveSellerMarket(body, seller)
  if (!market) {
    throw new PayHoldError(
      'policy_violation',
      'We do not have a payout country for you yet. ' +
        'Choose your payout country and try again.',
    )
  }
  const { country, currency } = market

  // Refuse before creating anything at Stripe: a market that pays out via
  // Flutterwave has no use for a Connect account, and one created anyway
  // would sit unused and unfindable by anything that reads
  // `stripe_connect_pending_account_id` for a market that never asks.
  //
  // This is the refusal a moved host meets first — `Rwanda is not paid out via
  // Stripe Connect` to somebody whose profile has said the United States for a
  // year — so it carries where Rwanda came from when Rwanda was ours.
  const route = payoutRoute(country, currency)
  if (route.provider !== 'stripe' || route.kind !== 'connect') {
    throw withCountryProvenance(
      new PayHoldError(
        'policy_violation',
        // Was `${name} is not paid out via Stripe Connect — use POST
        // /sellers/:id/destinations instead`, which named an endpoint to a
        // person with no way to call one. The rail's name is worth keeping —
        // a host who was about to click a Stripe button should be told it is
        // Stripe that does not reach them — and the action is the other
        // methods their own screen already offers.
        `We cannot pay out to ${countryLabel(country)} through Stripe. ` +
          'Choose one of the other payout methods.',
      ),
      market,
    )
  }

  const { provider, connected } = await loadProvider(db, caller.tenant_id, 'stripe')
  if (!connected || !(provider instanceof StripeProvider)) {
    throw new PayHoldError(
      'policy_violation',
      'This tenant has no live Stripe account connected — Connect onboarding needs one',
    )
  }

  // Reuse the account this seller already has mid-onboarding rather than
  // minting a second one every time they reopen the link — Stripe has no
  // delete for these either. This is also what lets a seller who started in
  // the embedded form finish in the redirect, or the other way round: one
  // account, two ways of showing it.
  let accountId = seller.stripe_connect_pending_account_id
  if (!accountId) {
    const created = await provider.createConnectAccount(country, body.email ?? null, id)
    accountId = created.accountId
    await db
      .from('sellers')
      .update({ stripe_connect_pending_account_id: accountId })
      .eq('id', id)
  }

  return { provider, accountId, market }
}

/**
 * `POST /v1/sellers/:id/connect/onboard` — start (or resume) Stripe Connect
 * onboarding for a seller whose market pays out via `stripe_connect` rather
 * than Flutterwave. `POST /sellers/:id/destinations` cannot do this on its
 * own: it takes a destination and tokenizes it, but nobody has minted an
 * `acct_…` for this seller yet, and `StripeProvider.tokenize` only confirms
 * one that already exists.
 *
 * Returns a one-time hosted onboarding URL. The client redirects the seller
 * there; nothing is written as a payable destination until
 * `GET /connect/status` (or the account webhook) confirms Stripe actually
 * finished onboarding them — a return URL by itself is not evidence of
 * anything, the same reasoning `checkout_session_state` applies to a payment.
 */
async function startConnectOnboarding(
  req: Request,
  db: SupabaseClient,
  caller: Caller,
  id: string,
): Promise<Response> {
  const body = await readJson<{
    country?: string
    email?: string | null
    return_url: string
    refresh_url: string
  }>(req)
  required(body as unknown as Record<string, unknown>, 'return_url', 'refresh_url')

  const { provider, accountId, market } = await connectAccountFor(db, caller, id, body)

  const { url } = await provider.createAccountLink(
    accountId,
    body.refresh_url,
    body.return_url,
  )

  // The market this account is being minted in, and whether the caller chose
  // it. Stripe registers a Connect account in one country and it cannot be
  // moved afterwards, so a client that meant the United States and got the
  // seller's stale Rwanda has minted the wrong account — and until this field
  // existed the only symptom was a refusal days later, at `/connect/status`.
  return json(req, {
    account_id: accountId,
    url,
    country: market.country,
    country_source: market.country_source,
  })
}

/**
 * `POST /v1/sellers/:id/connect/session` — the same Stripe onboarding as
 * `/connect/onboard` above, mounted inside the client's own app instead of
 * navigated to.
 *
 * **Both exist, and neither is the deprecated one.** A link sends the seller
 * to `connect.stripe.com`; a session hands the client a short-lived client
 * secret that `@stripe/connect-js` renders the identical form with, in their
 * page. Stripe collects the KYC, the documents and the bank details either
 * way and PayHold sees none of it either way — which is `tokenize`'s whole
 * header, and embedding does not weaken it. What the client gains is that a
 * host never leaves their app. What the redirect keeps is every context a DOM
 * mount is not available in: Stripe does not support embedded components
 * inside a mobile or desktop webview, and a client shipping as a PWA needs
 * somewhere to send those sellers.
 *
 * **A fresh session per call, deliberately.** Connect.js calls its
 * `fetchClientSecret` again whenever the session expires mid-onboarding, and
 * Stripe documents that it must return a *new* secret each time. Returning a
 * cached one would hand a dead secret to the exact caller that only asks
 * because the last one died — a host stranded on the screen where they were
 * typing their bank details.
 *
 * Nothing here is evidence of anything, the same as the redirect: the
 * destination is written by `GET /connect/status`, which asks Stripe whether
 * payouts are actually enabled. A mounted component that reported success to
 * its own parent would be `embed.ts`'s postMessage mistake one rail over.
 */
async function startConnectSession(
  req: Request,
  db: SupabaseClient,
  caller: Caller,
  id: string,
): Promise<Response> {
  const body = await readJson<{ country?: string; email?: string | null }>(req)
  const { provider, accountId, market } = await connectAccountFor(db, caller, id, body)
  const { clientSecret, publishableKey } = await provider.createAccountSession(accountId)

  return json(req, {
    account_id: accountId,
    client_secret: clientSecret,
    publishable_key: publishableKey,
    // Same pair `/connect/onboard` returns, for the same reason: one
    // onboarding presented two ways cannot report its market two ways.
    country: market.country,
    country_source: market.country_source,
  })
}

/**
 * `GET /v1/sellers/:id/connect/status` — has onboarding finished, and if so,
 * promote it to a real destination.
 *
 * The polling half of the pair, called from the seller's return page rather
 * than trusted from the redirect itself. Completion goes through exactly the
 * path `POST /sellers/:id/destinations` uses — `tokenize` then
 * `add_seller_destination` — so a Connect-onboarded destination lands
 * unverified and inside its security hold like any other. Stripe's own
 * onboarding proves the account is real and payable; it is not §12's
 * separate identity attestation, which still needs `POST /sellers/:id/verify`.
 */
async function connectStatus(
  req: Request,
  db: SupabaseClient,
  caller: Caller,
  id: string,
): Promise<Response> {
  const { data } = await db
    .from('sellers')
    .select('id, country, payout_currency, stripe_connect_pending_account_id')
    .eq('id', id)
    .eq('tenant_id', caller.tenant_id)
    .maybeSingle()
  if (!data) throw new PayHoldError('not_found', `Seller ${id} not found`)
  const seller = data as unknown as {
    country: string | null
    payout_currency: string | null
    stripe_connect_pending_account_id: string | null
  }

  if (!seller.stripe_connect_pending_account_id) {
    return json(req, { status: 'not_started' })
  }

  const { provider, connected } = await loadProvider(db, caller.tenant_id, 'stripe')
  if (!connected || !(provider instanceof StripeProvider)) {
    throw new PayHoldError(
      'policy_violation',
      'This tenant has no live Stripe account connected',
    )
  }

  const accountId = seller.stripe_connect_pending_account_id
  const { payoutsEnabled, country: accountCountry } = await provider.connectAccountStatus(
    accountId,
  )
  if (!payoutsEnabled) {
    return json(req, { status: 'pending', account_id: accountId })
  }

  // A seller who had no country at all when onboarding started still has none
  // now: `/connect/onboard` takes a `country`, mints the account in it and
  // writes it nowhere, so this call has nothing to promote the account into.
  // Refused in those words rather than reaching `countryInfo(null)`, which
  // reported `Unknown country code "null"` to a host whose real problem is that
  // PayHold never recorded the market they typed.
  if (!seller.country) {
    throw new PayHoldError(
      'policy_violation',
      `Your Stripe account is ready${
        accountCountry ? `, and Stripe opened it in ${countryLabel(accountCountry.toUpperCase())}` : ''
      }, but we do not have a payout country for you yet. ` +
        `Choose your payout country and try again.`,
    )
  }

  const currency = seller.payout_currency ?? countryInfo(seller.country).currency

  // The one place a stated country and a stored one can end up describing the
  // same destination, and it is not visible from either call on its own.
  // `/connect/onboard` and `/connect/session` both take a `country` and mint
  // the Stripe account in it; neither writes it anywhere, because a Connect
  // account is not a destination until Stripe says it is payable. This call is
  // where it becomes one — and it reads the *seller row*, which for a host who
  // has moved still says the market their first destination was in. So a US
  // account was promoted to a row saying RW/RWF, and every later payout was
  // routed on a corridor the account is not in: refused where the two markets
  // route differently, and silently sent on the wrong one where they do not.
  //
  // Refused rather than resolved in favour of either, the same as
  // `assertRailOnRoute` does when the routing table and the adapter disagree.
  // Deciding for them would mean either overriding a seller's stored country
  // from a provider's record or paying into a country nobody claimed, and both
  // are §5.1's silent redirection wearing a different hat. The pending account
  // id is left in place: the account is real at Stripe, and clearing it would
  // lose the only handle anyone has to it.
  if (accountCountry && accountCountry.toUpperCase() !== seller.country.toUpperCase()) {
    throw new PayHoldError(
      'policy_violation',
      `Stripe opened your account in ${countryLabel(accountCountry.toUpperCase())}, and we still have ` +
        `${countryLabel(seller.country)} as your payout country. Stripe fixes that ` +
        `country when the account is created and it cannot be changed afterwards, so ` +
        `update your payout country to ${countryLabel(accountCountry.toUpperCase())} and try again.`,
    )
  }

  // `startConnectOnboarding` already refused a market Stripe does not pay
  // into, but that was at the start of a redirect-and-poll that can take days,
  // and the row written here is a `stripe_connect` destination whatever the
  // routing says by now. Re-asked rather than trusted from then, for the same
  // reason the poll itself exists: the return is not the evidence, what is
  // true now is. A refusal leaves `stripe_connect_pending_account_id` in
  // place — the account is real at Stripe, and clearing it would lose the only
  // handle anyone has to it.
  const rails = await evaluateRails(db, caller.tenant_id, seller.country!, currency)
  assertRailOnRoute(
    'stripe_connect',
    seller.country!,
    payoutRoute(seller.country!, currency),
    rails,
  )
  // And the table's own answer, for the same reason: the row written below is
  // a `stripe_connect` destination whatever the routing says by now.
  assertRailSwitchedOnRows(rails, 'stripe_connect', seller.country!)

  const token = await provider.tokenize({
    destination: accountId,
    currency,
    country: seller.country!,
  })

  const { data: added, error } = await db.rpc('add_seller_destination', {
    p_seller: id,
    p_tenant: caller.tenant_id,
    p_country: seller.country,
    p_currency: currency,
    p_provider: 'stripe_connect',
    p_token: token.beneficiary_token,
    p_masked: token.masked_destination,
    p_label: 'Stripe',
    p_role: 'primary',
    p_actor: 'stripe_connect_onboarding',
  })
  if (error) throw new PayHoldError('policy_violation', error.message)

  await db
    .from('sellers')
    .update({ stripe_connect_pending_account_id: null })
    .eq('id', id)

  const { beneficiary_token: _token, ...destination } = added as Record<string, unknown>
  return json(req, { status: 'connected', destination })
}

Deno.serve(handler(async (req) => {
  const db = serviceClient()
  const caller = await resolveCaller(db, req)

  const url = new URL(req.url)
  const segments = url.pathname.split('/').filter(Boolean)
  const base = segments.indexOf('sellers')
  const id = segments[base + 1]
  const action = segments[base + 2]
  // §5.1's step-up hangs off a destination, which hangs off a seller. The only
  // two-deep route here, and the reason the parse goes past `action`.
  const sub = segments[base + 3]
  const subAction = segments[base + 4]

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
  if (req.method === 'GET' && id && action === 'destinations') {
    await ownSeller(db, caller, id)

    const { data } = await db
      .from('seller_destinations')
      .select(DESTINATION_COLUMNS)
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
  // Ahead of the bare `destinations` POST, which would otherwise swallow it and
  // try to register a destination from an empty body.
  if (
    req.method === 'POST' && id && action === 'destinations' &&
    sub && subAction === 'end-hold'
  ) {
    return await endHold(req, db, caller, id, sub)
  }

  if (
    req.method === 'POST' && id && action === 'destinations' &&
    sub && subAction === 'promote'
  ) {
    return await promoteDestination(req, db, caller, id, sub)
  }

  // Ahead of the bare `destinations` POST for `end-hold`'s reason: that route
  // would otherwise swallow this one and try to register a destination from a
  // body carrying only `verified`.
  if (
    req.method === 'POST' && id && action === 'destinations' &&
    sub && subAction === 'verify'
  ) {
    return await verifyDestination(req, db, caller, id, sub)
  }

  if (req.method === 'POST' && id && action === 'destinations') {
    return await addDestination(req, db, caller, id)
  }

  // Ahead of nothing in particular, but grouped with `destinations` since
  // `stripe_connect` is the one rail whose destination cannot be typed in —
  // it has to be minted by Stripe's own onboarding first.
  if (req.method === 'POST' && id && action === 'connect' && sub === 'onboard') {
    return await startConnectOnboarding(req, db, caller, id)
  }

  // The embedded twin of `onboard`. Same account, same promotion path, and a
  // fresh session on every call — Connect.js re-asks when one expires.
  if (req.method === 'POST' && id && action === 'connect' && sub === 'session') {
    return await startConnectSession(req, db, caller, id)
  }

  if (req.method === 'GET' && id && action === 'connect' && sub === 'status') {
    return await connectStatus(req, db, caller, id)
  }

  if (req.method === 'POST' && id && action === 'withdraw') {
    return await withdraw(req, db, caller, id)
  }

  if (req.method === 'POST' && id && action === 'verify') {
    return await verify(req, db, caller, id)
  }

  if (req.method === 'POST' && id && action === 'active') {
    return await setActive(req, db, caller, id)
  }

  if (req.method === 'POST' && id && action === 'name') {
    return await setName(req, db, caller, id)
  }

  // An unmatched path under a seller is a 404, and until this guard it was the
  // collection. Everything above is a route on one seller; everything below is
  // a route on the set, and a request naming a seller that matched none of the
  // former fell through to the latter — so `GET /sellers/:id/anything` answered
  // with every seller this tenant has, names and masked destinations included.
  //
  // Tenant-scoped throughout, so it was never a cross-tenant leak. What it was
  // is a typo that returns a data dump, and a silent success for calls to
  // routes that do not exist yet — a client polling an endpoint we have not
  // built would parse the list and conclude the feature works.
  //
  // Every remaining segment goes in the message, not just the two this parse
  // names: printing `${id}/${action}` reported a `/connect/session` call as
  // `POST /sellers/:id/connect is not a route`, which is a path the client
  // never sent. `routeNotFound`'s header is the whole account.
  if (id) {
    throw routeNotFound(req.method, segments, base)
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
