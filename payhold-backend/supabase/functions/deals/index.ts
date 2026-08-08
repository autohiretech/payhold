/**
 * Deals — the public API's centre of gravity.
 *
 *   POST   /deals                    create → returns the deal and a payment link
 *   GET    /deals                    list, this tenant only
 *   GET    /deals/:id                full status, timestamps, amounts
 *   POST   /deals/:id/pay            start the charge on the buyer's chosen rail
 *   POST   /deals/:id/confirm        side=buyer|seller; both → atomic release
 *   POST   /deals/:id/refund         pre-release, policy-checked
 *   POST   /deals/:id/deposit        open a card pre-auth
 *   POST   /deals/:id/capture        take some or all of it
 *   POST   /deals/:id/release-deposit  give it all back
 *
 * Every handler resolves a tenant from the caller's key and filters on it.
 * A deal belonging to someone else is a 404 and never a 403 — a 403 confirms
 * the thing exists, which is the leak spec §4 forbids.
 *
 * The division of labour is the one in CLAUDE.md and it is visible in every
 * handler here: this file works out FX, fees and which rail, then hands
 * already-converted figures to a SQL function that owns the atomicity. Nothing
 * here reads, decides and writes over three round trips.
 */

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { assertPayoutsNotFrozen, resolveCaller, type Caller } from '../_shared/auth.ts'
import { serviceClient } from '../_shared/auth.ts'
import { releaseFigures } from '../_shared/figures.ts'
import { convertOrThrow, presentmentCurrencyFor } from '../_shared/fx.ts'
import { handler, json, readJson, required } from '../_shared/http.ts'
import { startCharge } from '../_shared/checkout.ts'
import { loadProvider } from '../_shared/load-provider.ts'
import { payContext, recordContext } from '../_shared/request-context.ts'
import {
  countryInfo,
  currenciesFor,
  defaultProviderFor,
  SUPPORTED_CURRENCIES,
} from '../_shared/rails.ts'
import { feeFor, loadSettings } from '../_shared/settings.ts'
import {
  PayHoldError,
  type ConfirmSide,
  type CreateDealInput,
  type Deal,
  type DealAmounts,
  type Money,
  type PaymentMethod,
} from '../_shared/types.ts'

/** Columns a client may see. `metadata` is theirs; nothing internal leaks. */
const DEAL_COLUMNS = `
  id, tenant_id, buyer_ref, seller_id, description, amount, currency,
  presentment_currency, presentment_amount, fx_rate, deposit_amount,
  buyer_country, provider, payment_method, payment_network, provider_ref,
  status, expected_complete_at, auto_release_at, released_at, payout_due_at,
  fee_amount, tax_amount, discount_amount, provider_fee_amount,
  reserve_amount, reserve_until,
  completion_event, auto_complete_after_hours, clearing_days,
  metadata, created_at, updated_at
`

/**
 * The completion policy is three flat columns in Postgres and one nested object
 * on the wire, because §14's create payload nests it and a client should be
 * able to send back what it was given.
 */
function shapeDeal(row: Record<string, unknown>): Deal {
  const {
    completion_event,
    auto_complete_after_hours,
    clearing_days,
    ...rest
  } = row

  return {
    ...rest,
    completion_policy: {
      completion_event: (completion_event ?? null) as string | null,
      auto_complete_after_hours: (auto_complete_after_hours ?? null) as number | null,
      clearing_days: (clearing_days ?? null) as number | null,
    },
  } as unknown as Deal
}

async function getDeal(
  db: SupabaseClient,
  caller: Caller,
  id: string,
): Promise<Deal> {
  const { data } = await db
    .from('deals')
    .select(DEAL_COLUMNS)
    .eq('id', id)
    .eq('tenant_id', caller.tenant_id)
    .maybeSingle()

  if (!data) throw new PayHoldError('not_found', `Deal ${id} not found`)
  return shapeDeal(data as Record<string, unknown>)
}

/** The confirmations belong to the deal as far as a client is concerned. */
async function withConfirmations(db: SupabaseClient, deal: Deal): Promise<Deal> {
  const { data } = await db
    .from('confirmations')
    .select('side, actor, confirmed_at')
    .eq('deal_id', deal.id)
    .order('confirmed_at')

  return { ...deal, confirmations: (data ?? []) as Deal['confirmations'] }
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

async function create(
  req: Request,
  db: SupabaseClient,
  caller: Caller,
): Promise<Response> {
  const body = await readJson<CreateDealInput>(req)
  required(
    body as unknown as Record<string, unknown>,
    'buyer_ref',
    'seller_id',
    'description',
    'amount',
    'currency',
  )

  if (!Number.isInteger(body.amount) || body.amount <= 0) {
    throw new PayHoldError(
      'policy_violation',
      'amount must be a positive integer in minor units (1000 = 10.00)',
    )
  }
  if (body.deposit_amount !== undefined && body.deposit_amount !== null) {
    if (!Number.isInteger(body.deposit_amount) || body.deposit_amount <= 0) {
      throw new PayHoldError('policy_violation', 'deposit_amount must be a positive integer')
    }
  }

  const settings = await loadSettings(db, caller.tenant_id)

  if (settings.currencies.length > 0 && !settings.currencies.includes(body.currency)) {
    throw new PayHoldError(
      'policy_violation',
      `${body.currency} is not enabled for this account`,
    )
  }
  if (!SUPPORTED_CURRENCIES.includes(body.currency)) {
    throw new PayHoldError(
      'policy_violation',
      `No rail can collect ${body.currency}`,
    )
  }

  const { data: seller } = await db
    .from('sellers')
    .select('id, country')
    .eq('id', body.seller_id)
    .eq('tenant_id', caller.tenant_id)
    .maybeSingle()

  if (!seller) {
    throw new PayHoldError('not_found', `Seller ${body.seller_id} not found`)
  }

  // Most deals are local, so the buyer defaults to the seller's market. They
  // pick their own country at checkout if that is wrong, and every market can
  // pay by card.
  const buyerCountry = body.buyer_country ?? seller.country
  countryInfo(buyerCountry)

  // The seller is owed `currency`. If the buyer's market cannot be charged it —
  // an Indian card cannot be charged RWF — find one it can and convert.
  // Refusing would turn away a legitimate customer over a mechanical detail
  // they cannot control.
  const presentmentCurrency = presentmentCurrencyFor(
    currenciesFor(buyerCountry),
    body.currency,
  )
  if (!presentmentCurrency) {
    throw new PayHoldError(
      'policy_violation',
      `PayHold cannot take a payment from ${countryInfo(buyerCountry).name}`,
    )
  }

  // Indicative until the buyer actually pays: `fx_rate` stays null and is
  // locked from the provider's rate at funding.
  const converted = convertOrThrow(body.amount, body.currency, presentmentCurrency)

  const { data, error } = await db
    .from('deals')
    .insert({
      tenant_id: caller.tenant_id,
      buyer_ref: body.buyer_ref,
      seller_id: seller.id,
      description: body.description,
      amount: body.amount,
      currency: body.currency,
      presentment_currency: presentmentCurrency,
      presentment_amount: converted.amount,
      deposit_amount: body.deposit_amount ?? null,
      buyer_country: buyerCountry,
      provider: defaultProviderFor(buyerCountry, presentmentCurrency),
      status: 'created',
      expected_complete_at: body.expected_complete_at ?? null,
      // §7. Presentment currency, set by the client — they know their own tax
      // rules and their own discounts, and we know neither.
      tax_amount: body.tax_amount ?? 0,
      discount_amount: body.discount_amount ?? 0,
      // §14. Locked at creation for the same reason `fee_amount` is: §27 says
      // in-flight deals keep the settings they were created with, and a
      // clearance window that moved mid-rental is exactly that surprise.
      completion_event: body.completion_policy?.completion_event ?? null,
      auto_complete_after_hours:
        body.completion_policy?.auto_complete_after_hours ?? null,
      clearing_days: body.completion_policy?.clearing_days ?? null,
      // Frozen at creation. Changing the tenant's fee later must not reprice a
      // deal that already exists — spec §8.
      fee_amount: feeFor(body.amount, settings),
      metadata: body.metadata ?? {},
    })
    .select(DEAL_COLUMNS)
    .single()

  if (error || !data) {
    throw new PayHoldError('policy_violation', 'Could not create that deal')
  }

  const deal = shapeDeal(data as Record<string, unknown>)

  await db.rpc('write_audit', {
    p_tenant: caller.tenant_id,
    p_deal: deal.id,
    p_actor: caller.actor,
    p_action: 'deal.created',
    p_details: { amount: deal.amount, currency: deal.currency },
  })

  const publicUrl = Deno.env.get('PUBLIC_URL') ?? 'https://app.payhold.local'

  return json(
    req,
    {
      deal: { ...deal, confirmations: [] },
      // Where the buyer goes to choose a method and pay. The provider's own
      // link is minted at that point, not now — the rail is not fixed until
      // they choose.
      payment_link: `${publicUrl}/pay/${deal.id}`,
    },
    201,
  )
}

// ---------------------------------------------------------------------------
// Pay — turn a created deal into a real charge
// ---------------------------------------------------------------------------

/**
 * Start the payment, on the rail the buyer's chosen method implies.
 *
 * This is where the provisional provider on a created deal becomes real: a
 * deal routed to Flutterwave at creation becomes a Stripe deal if the buyer
 * pays by international card, and the ledger follows the rail that actually
 * holds the money.
 *
 * Called by the client's own site, with their API key, before redirecting the
 * buyer. The buyer has no credential of their own — the end-user tokens spec
 * §4 mentions for `confirm` are not built yet, and inventing an auth scheme
 * here would be the wrong place to do it.
 *
 * The deal moves to `payment_pending` and no further. `funded_held` comes from
 * the provider's webhook and only after we re-fetch the transaction — starting
 * a charge is not evidence that one succeeded, which is the whole reason §6
 * gives the attempt a state of its own rather than letting it look like money.
 */
async function pay(
  req: Request,
  db: SupabaseClient,
  caller: Caller,
  id: string,
): Promise<Response> {
  const body = await readJson<{
    method: PaymentMethod
    network?: string
    /**
     * The buyer's address, where the client collects it themselves — spec §6.
     * Optional, unverifiable, and recorded as `client_attested` so nothing
     * downstream mistakes it for something a provider saw.
     */
    buyer_ip?: string
  }>(req)
  required(body as unknown as Record<string, unknown>, 'method')

  const deal = await getDeal(db, caller, id)

  // `payment_failed` is here so a declined card can be retried without the
  // client having to create a second deal for the same booking. `payment_pending`
  // is not: a buyer who is mid-payment on one rail must not be started on
  // another, or two charges race for one hold.
  if (!['created', 'checkout_started', 'payment_failed'].includes(deal.status)) {
    throw new PayHoldError(
      'invalid_state',
      `This deal is ${deal.status} — a payment has already been started`,
    )
  }

  // The one implementation, shared with the hosted checkout route so a buyer
  // choosing on our page and a client choosing on their server cannot diverge
  // — the argument `_shared/dispatch.ts` makes about payouts. It re-checks the
  // method against the live capability matrix, so a rail we have switched off
  // cannot be started from either entrance.
  const charge = await startCharge(db, caller.tenant_id, deal, {
    method: body.method,
    network: body.network,
  })
  const rail = charge.rail

  // The rail is recorded now so the dashboard shows where the payment went
  // even while it is still pending. The reference and the hold wait for the
  // webhook.
  //
  // The status write happens after the provider call, not before: a charge that
  // threw never started, and a deal left in `payment_pending` by a rail that
  // refused it would be unretryable — `/pay` declines that state on purpose.
  await db
    .from('deals')
    .update({ provider: rail, status: 'payment_pending' })
    .eq('id', deal.id)

  await db.rpc('write_audit', {
    p_tenant: caller.tenant_id,
    p_deal: deal.id,
    p_actor: caller.actor,
    p_action: 'deal.payment_started',
    p_details: { provider: rail, method: body.method, network: body.network ?? null },
  })

  // Where this payment is being made from. Observation only — no rule reads it
  // yet, and none of it can fail the charge (see `recordContext`).
  const context = payContext(req, body)

  if (context.attested) {
    await recordContext(db, {
      deal_id: deal.id,
      source: 'client_attested',
      event: 'pay_started',
      ip: context.attested,
      user_agent: context.userAgent,
    })
  }

  // The observed address is only the buyer's when the request came from a
  // browser rather than from a client's server. With an API key present it is
  // the integration's own host — interesting in its own right, but it is not
  // the buyer, and filing it as though it were would poison every rule that
  // later reads this column.
  if (context.observed && caller.kind !== 'api_key') {
    await recordContext(db, {
      deal_id: deal.id,
      source: 'hosted_page',
      event: 'pay_started',
      ip: context.observed,
      user_agent: context.userAgent,
    })
  }

  return json(req, {
    payment_link: charge.payment_link,
    provider: rail,
    provider_ref: charge.provider_ref,
  })
}

// ---------------------------------------------------------------------------
// Confirm and refund
// ---------------------------------------------------------------------------

async function confirm(
  req: Request,
  db: SupabaseClient,
  caller: Caller,
  id: string,
): Promise<Response> {
  const body = await readJson<{ side: ConfirmSide }>(req)
  required(body as unknown as Record<string, unknown>, 'side')

  if (body.side !== 'buyer' && body.side !== 'seller') {
    throw new PayHoldError('policy_violation', 'side must be "buyer" or "seller"')
  }

  const deal = await getDeal(db, caller, id)

  // Everything about whether this releases is decided inside the SQL function,
  // under a row lock. This side only supplies the figures a release needs, and
  // supplies them whether or not one happens.
  const { error } = await db.rpc('confirm_deal', {
    p_deal_id: deal.id,
    p_side: body.side,
    p_actor: 'user',
    ...(await releaseFigures(db, deal)),
  })

  if (error) throw rpcError(error, 'confirm')

  return json(req, await withConfirmations(db, await getDeal(db, caller, id)))
}

async function refund(
  req: Request,
  db: SupabaseClient,
  caller: Caller,
  id: string,
): Promise<Response> {
  const body = await readJson<{
    reason?: string
    /** §7.1.5. Omitted means everything still refundable — V1's only option. */
    amount?: Money
    /** The client's own breakdown of what they are giving back. */
    line_items?: unknown
  }>(req)
  const deal = await getDeal(db, caller, id)

  if (body.amount !== undefined) {
    if (!Number.isInteger(body.amount) || body.amount <= 0) {
      throw new PayHoldError(
        'policy_violation',
        'amount must be a positive integer in minor units (1000 = 10.00)',
      )
    }
  }

  // Return the buyer's money at the provider FIRST. A ledger that says
  // "refunded" while the provider still holds the funds is the one direction
  // this must never fail in — the reverse is recoverable by re-running.
  //
  // Skipped once the seller has been paid: §7.1.4 books a receivable instead,
  // because there is nothing left at the provider to send and asking a rail to
  // refund money it no longer holds fails in a way that helps nobody.
  if (deal.provider_ref && deal.status !== 'paid_out') {
    const { provider } = await loadProvider(db, caller.tenant_id, deal.provider)

    if (body.amount !== undefined && !provider.capabilities.supportsPartialRefund) {
      throw new PayHoldError(
        'policy_violation',
        `${deal.payment_method ?? 'This rail'} cannot refund part of a payment — ` +
          'refund the whole amount or resolve it with the buyer directly',
      )
    }

    await provider.refund({
      provider_ref: deal.provider_ref,
      // The whole thing when no amount was named. `refund_deal` decides what
      // "the whole thing" means against its own cumulative guard; this is the
      // provider call, and a rail asked for more than it holds refuses loudly.
      amount: body.amount ?? deal.presentment_amount,
      currency: deal.presentment_currency,
      // Partial refunds are not one event per deal, so the key cannot be one
      // per deal either. Two different amounts must not collapse into one
      // provider-side refund.
      idempotency_key: `refund:${deal.id}:${body.amount ?? 'full'}`,
    })
  }

  const { error } = await db.rpc('refund_deal', {
    p_deal_id: deal.id,
    p_reason: body.reason ?? 'Refunded by the client',
    p_actor: caller.actor,
    p_amount: body.amount ?? null,
    p_line_items: body.line_items ?? null,
  })
  if (error) throw rpcError(error, 'refund')

  return json(req, await withConfirmations(db, await getDeal(db, caller, id)))
}

// ---------------------------------------------------------------------------
// Security deposits (card pre-auth)
// ---------------------------------------------------------------------------

async function openDeposit(
  req: Request,
  db: SupabaseClient,
  caller: Caller,
  id: string,
): Promise<Response> {
  const deal = await getDeal(db, caller, id)

  if (!deal.deposit_amount) {
    throw new PayHoldError('invalid_state', 'This deal has no security deposit')
  }

  const { provider } = await loadProvider(db, caller.tenant_id, deal.provider)
  const publicUrl = Deno.env.get('PUBLIC_URL') ?? 'https://app.payhold.local'

  const result = await provider.preauth({
    deal_id: deal.id,
    amount: deal.deposit_amount,
    currency: deal.presentment_currency,
    return_url: `${publicUrl}/pay/${deal.id}`,
    idempotency_key: `deposit:${deal.id}`,
  })

  await db.rpc('record_deposit_ref', {
    p_deal_id: deal.id,
    p_provider_ref: result.provider_ref,
  })

  return json(req, { deposit_link: result.payment_link, provider_ref: result.provider_ref })
}

async function captureDeposit(
  req: Request,
  db: SupabaseClient,
  caller: Caller,
  id: string,
): Promise<Response> {
  const body = await readJson<{ amount: number }>(req)
  required(body as unknown as Record<string, unknown>, 'amount')

  const deal = await getDeal(db, caller, id)
  const depositRef = deal.metadata?.deposit_provider_ref

  if (depositRef) {
    const { provider } = await loadProvider(db, caller.tenant_id, deal.provider)
    await provider.capture(depositRef, body.amount)
  }

  // The guards — has a deposit, not already settled, never more than was held
  // — are all in the SQL function, where they are checked under a row lock.
  const { error } = await db.rpc('capture_deposit', {
    p_deal_id: deal.id,
    p_amount: body.amount,
  })
  if (error) throw rpcError(error, 'capture')

  return json(req, await withConfirmations(db, await getDeal(db, caller, id)))
}

async function releaseDeposit(
  req: Request,
  db: SupabaseClient,
  caller: Caller,
  id: string,
): Promise<Response> {
  const deal = await getDeal(db, caller, id)

  const { error } = await db.rpc('release_deposit', { p_deal_id: deal.id })
  if (error) throw rpcError(error, 'release deposit')

  return json(req, await withConfirmations(db, await getDeal(db, caller, id)))
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Turn a Postgres error from a money function into the right API error.
 *
 * The SQL functions raise with a `code: message` convention precisely so this
 * mapping is mechanical rather than a guess at what went wrong.
 */
function rpcError(error: { message: string }, what: string): PayHoldError {
  const message = error.message

  for (const code of ['not_found', 'invalid_state', 'policy_violation', 'insufficient_balance'] as const) {
    if (message.startsWith(code)) {
      return new PayHoldError(code, message.slice(code.length + 2).trim())
    }
  }

  console.error(`unmapped ${what} failure`, { message })
  return new PayHoldError('policy_violation', `Could not ${what} this deal`)
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

Deno.serve(handler(async (req) => {
  const db = serviceClient()
  const caller = await resolveCaller(db, req)

  const url = new URL(req.url)
  // Supabase serves this at /functions/v1/deals/…, so the segment after the
  // function name is the deal id.
  const segments = url.pathname.split('/').filter(Boolean)
  const base = segments.indexOf('deals')
  const id = segments[base + 1]
  const action = segments[base + 2]

  if (req.method === 'POST' && !id) {
    await assertPayoutsNotFrozen(db, caller.tenant_id)
    return await create(req, db, caller)
  }

  if (req.method === 'GET' && !id) {
    const status = url.searchParams.get('status')
    let query = db
      .from('deals')
      .select(DEAL_COLUMNS)
      .eq('tenant_id', caller.tenant_id)
      .order('created_at', { ascending: false })
      .limit(Math.min(Number(url.searchParams.get('limit') ?? 100), 500))

    if (status) query = query.in('status', status.split(','))

    const { data } = await query
    return json(req, {
      deals: ((data ?? []) as Record<string, unknown>[]).map(shapeDeal),
    })
  }

  if (!id) {
    throw new PayHoldError('policy_violation', `${req.method} is not supported here`)
  }

  // §7.1's refund records. Its own read rather than a field on the deal,
  // because a refund has a *lifetime*: §7.1.6 has Alipay and WeChat Pay
  // settling asynchronously up to 90 days out, so "how much went back" and
  // "what is still in flight" are different questions and only this one
  // answers the second.
  //
  // `getDeal` first, and the 404 it raises is the tenant scoping — a refund
  // list must not confirm that another account's deal exists.
  if (req.method === 'GET' && action === 'refunds') {
    await getDeal(db, caller, id)

    const { data } = await db
      .from('refunds')
      .select('id, deal_id, amount, currency, reason, line_items, status, ' +
        'actor, provider_ref, created_at, settled_at')
      .eq('deal_id', id)
      .eq('tenant_id', caller.tenant_id)
      .order('created_at', { ascending: false })

    return json(req, { refunds: data ?? [] })
  }

  if (req.method === 'GET' && !action) {
    const deal = await withConfirmations(db, await getDeal(db, caller, id))

    // §7: every value separately, derived from the ledger. Alongside the deal
    // rather than inside it — the list endpoint returns deals too, and one
    // aggregate query per row there is how a list of a hundred becomes slow.
    const { data: amounts } = await db.rpc('deal_amounts', { p_deal: deal.id })

    return json(req, {
      ...deal,
      amounts: (amounts as DealAmounts[] | null)?.[0] ?? null,
    })
  }

  if (req.method !== 'POST') {
    throw new PayHoldError('policy_violation', `${req.method} is not supported here`)
  }

  switch (action) {
    case 'pay':
      return await pay(req, db, caller, id)
    case 'confirm':
      return await confirm(req, db, caller, id)
    case 'refund':
      return await refund(req, db, caller, id)
    case 'deposit':
      return await openDeposit(req, db, caller, id)
    case 'capture':
      return await captureDeposit(req, db, caller, id)
    case 'release-deposit':
      return await releaseDeposit(req, db, caller, id)
    default:
      throw new PayHoldError('not_found', `No such action "${action ?? ''}"`)
  }
}))
