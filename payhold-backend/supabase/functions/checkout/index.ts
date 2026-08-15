/**
 * Hosted checkout sessions — spec §10.1.
 *
 *   POST /checkout/sessions               create (or return) a deal's live session
 *   GET  /checkout/sessions/:id           its status, for the client's server
 *   POST /checkout/sessions/:id/cancel    withdraw the link
 *
 *   GET  /checkout/public/:token           what the buyer sees. No credential
 *   POST /checkout/public/:token/pay       the buyer chooses; a charge starts
 *   POST /checkout/public/:token/authorize the buyer answers a PIN or an address
 *   POST /checkout/public/:token/validate  the buyer answers a code the rail sent
 *   POST /checkout/public/:token/capture   the buyer approved a wallet
 *   POST /checkout/public/:token/confirm   ask the rail whether it landed yet
 *
 * **The two halves are separated by an explicit path segment**, not by a plural
 * or a header. `public` is there so nobody reviewing a change has to work out
 * which routes are unauthenticated — the ones that are say so in the URL.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * §15 phase 2: *"test payments cannot be marked successful without verified
 * provider events."* **Nothing a buyer sends through this file can fund a
 * deal**, and that is the clause read exactly. What they choose, type, and
 * answer takes a session as far as `payment_pending` and no further.
 *
 * `/confirm` funds, and does not weaken that. It never reads the request for an
 * outcome: it re-fetches the transaction from the provider over our own
 * authenticated connection — the identical `verify` the webhooks make in their
 * step 4 — and hands the result to the identical `fund_deal`. The evidence is
 * the provider's answer either way. The webhook and this route differ only in
 * what prompted the question, and a system that could only ask when prompted
 * from outside was one undelivered POST away from a debited buyer, a frozen
 * deal, and a seller who never learned they had sold anything.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The public routes are the second thing in this system with no caller to
 * authenticate (provider webhooks are the first). What stands in for a
 * credential is the session token: 256 bits, expiring, and scoped to one
 * payment on one deal. It is no broader than the deal id that already opens
 * today's `/pay/:id` page, and considerably harder to guess.
 */

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { resolveCaller, serviceClient, type Caller } from '../_shared/auth.ts'
import { availableMethods, startCharge, validateCharge } from '../_shared/checkout.ts'
import { loadProvider } from '../_shared/load-provider.ts'
import { handler, json, readJson, required } from '../_shared/http.ts'
import { normaliseIp, payContext, recordContext } from '../_shared/request-context.ts'
import { settleDeal, type SettleableDeal } from '../_shared/settle.ts'
import { loadSettings } from '../_shared/settings.ts'
import { PayHoldError, type Deal, type PaymentMethod, type Provider } from '../_shared/types.ts'

interface CheckoutSession {
  id: string
  tenant_id: string
  deal_id: string
  token: string
  status: 'open' | 'completed' | 'canceled'
  return_url: string | null
  method: PaymentMethod | null
  network: string | null
  /**
   * The rail the charge actually started on. Typed as the enum rather than
   * `string` because it is routed on after the fact — a code the buyer answers
   * has to go back to the rail that issued it.
   */
  provider: Provider | null
  provider_ref: string | null
  payment_link: string | null
  expires_at: string
  completed_at: string | null
  created_at: string
}

/**
 * Session states a buyer may still read and act on.
 *
 * `completed` means they chose a method and a charge started — not that they
 * finished. Everything after that moment happens against this same token, so
 * excluding it would end the payment at the point it actually begins.
 */
const READABLE = ['open', 'completed'] as const

/**
 * A card as a client sends one.
 *
 * Only reachable for a tenant with `raw_card_relay` on — `startCharge` refuses
 * it otherwise — and forwarded straight to the adapter, which encrypts it. It
 * is never written to a column and never logged.
 */
interface CardInput {
  number: string
  cvv: string
  expiry_month: string
  expiry_year: string
  name?: string
  email?: string
}

function hostedUrl(token: string): string {
  const base = Deno.env.get('PUBLIC_URL') ?? 'https://app.payhold.local'
  return `${base}/checkout/${token}`
}

/** `open | completed | canceled | expired`, with expiry derived, never stored. */
function state(session: CheckoutSession): string {
  if (session.status === 'open' && new Date(session.expires_at) <= new Date()) {
    return 'expired'
  }
  return session.status
}

/** What the client's own server is told. Includes the token — it is theirs. */
function clientView(session: CheckoutSession): Record<string, unknown> {
  return {
    id: session.id,
    deal_id: session.deal_id,
    status: state(session),
    url: hostedUrl(session.token),
    return_url: session.return_url,
    method: session.method,
    network: session.network,
    provider: session.provider,
    expires_at: session.expires_at,
    completed_at: session.completed_at,
    created_at: session.created_at,
  }
}

// ---------------------------------------------------------------------------
// The client's server
// ---------------------------------------------------------------------------

async function create(
  req: Request,
  db: SupabaseClient,
  caller: Caller,
): Promise<Response> {
  const body = await readJson<{
    deal_id: string
    /** How long the link lives. Defaults to the tenant's setting. */
    hours?: number
    return_url?: string
  }>(req)
  required(body as unknown as Record<string, unknown>, 'deal_id')

  // Tenant-scoped first: another tenant's deal is a 404 here, never an error
  // out of the SQL function, and never a 403 — §4.
  const { data: deal } = await db
    .from('deals')
    .select('id')
    .eq('id', body.deal_id)
    .eq('tenant_id', caller.tenant_id)
    .maybeSingle()

  if (!deal) throw new PayHoldError('not_found', `Deal ${body.deal_id} not found`)

  const settings = await loadSettings(db, caller.tenant_id)

  const { data, error } = await db.rpc('open_checkout_session', {
    p_deal: body.deal_id,
    p_hours: body.hours ?? settings.checkout_session_hours,
    p_return_url: body.return_url ?? null,
  })

  if (error) throw rpcError(error, 'open a checkout session')

  return json(req, clientView(data as unknown as CheckoutSession), 201)
}

async function show(
  req: Request,
  db: SupabaseClient,
  caller: Caller,
  id: string,
): Promise<Response> {
  const { data } = await db
    .from('checkout_sessions')
    .select('*')
    .eq('id', id)
    .eq('tenant_id', caller.tenant_id)
    .maybeSingle()

  if (!data) throw new PayHoldError('not_found', `Checkout session ${id} not found`)

  return json(req, clientView(data as unknown as CheckoutSession))
}

async function cancel(
  req: Request,
  db: SupabaseClient,
  caller: Caller,
  id: string,
): Promise<Response> {
  const { data: session } = await db
    .from('checkout_sessions')
    .select('id')
    .eq('id', id)
    .eq('tenant_id', caller.tenant_id)
    .maybeSingle()

  if (!session) {
    throw new PayHoldError('not_found', `Checkout session ${id} not found`)
  }

  const { data, error } = await db.rpc('cancel_checkout_session', {
    p_session: id,
    p_actor: caller.actor,
  })

  if (error) throw rpcError(error, 'cancel this checkout session')

  return json(req, clientView(data as unknown as CheckoutSession))
}

// ---------------------------------------------------------------------------
// The buyer
// ---------------------------------------------------------------------------

/**
 * Resolve a token to its session, refusing anything not live.
 *
 * The refusal is the same for a token that never existed, one that expired and
 * one that was withdrawn. A buyer needs to know it will not work; distinguishing
 * the three would let somebody probe for real tokens.
 *
 * `open` alone was right while paying was a handoff — the buyer left, and the
 * token had no work left to do. It is wrong now that a charge can be finished
 * in the client's own page: `pay` completes the session, and everything that
 * follows it — the code the rail asked for, and the polling that watches the
 * deal move — happens *after* that. A buyer who is still paying would have been
 * told their own payment link had already been used.
 *
 * So the states are named per route rather than assumed. Starting a charge is
 * still `open` only, which is what stops a completed session being charged
 * twice; reading and validating accept `completed` as well, because that is the
 * state a buyer mid-payment is actually in.
 */
async function bySession(
  db: SupabaseClient,
  token: string,
  allow: readonly string[] = ['open'],
): Promise<{ session: CheckoutSession; deal: Deal }> {
  if (!token || token.length < 20) {
    throw new PayHoldError('not_found', 'This payment link is not valid')
  }

  const { data } = await db
    .from('checkout_sessions')
    .select('*')
    .eq('token', token)
    .maybeSingle()

  const session = data as unknown as CheckoutSession | null

  if (!session || !allow.includes(state(session))) {
    throw new PayHoldError(
      'not_found',
      'This payment link has expired or has already been used',
    )
  }

  // `currency`, `provider` and `provider_ref` are here for `/confirm`, which
  // settles against the rail and needs all three. `split_percent` and
  // `balance_amount` are for `availableMethods`/`startCharge`, which price a
  // split deal's methods differently — without them here a split deal on the
  // hosted page would silently look flat, the same shape of bug this select
  // already had before this deal ever existed. They widen the *query*, not
  // the response: `publicView` names every field it returns by hand, which is
  // exactly why adding a column here cannot leak one.
  const { data: deal } = await db
    .from('deals')
    .select('id, tenant_id, description, currency, presentment_amount, ' +
      'presentment_currency, buyer_country, status, seller_id, provider, provider_ref, ' +
      'split_percent, balance_amount')
    .eq('id', session.deal_id)
    .maybeSingle()

  if (!deal) throw new PayHoldError('not_found', 'This payment link is not valid')

  return { session, deal: deal as unknown as Deal }
}

/**
 * What a stranger holding the link is allowed to see.
 *
 * Curated by hand rather than by spreading the deal row, and that is the point:
 * whoever opens this is unauthenticated, so `buyer_ref`, the fee breakdown, the
 * tenant's other business and the seller's payout details are all absent
 * because they were never added, not because something stripped them.
 */
async function publicView(
  req: Request,
  db: SupabaseClient,
  token: string,
): Promise<Response> {
  const { session, deal } = await bySession(db, token, READABLE)

  const { data: seller } = await db
    .from('sellers')
    .select('name')
    .eq('id', deal.seller_id)
    .maybeSingle()

  return json(req, {
    status: state(session),
    expires_at: session.expires_at,
    deal: {
      id: deal.id,
      description: deal.description,
      amount: deal.presentment_amount,
      currency: deal.presentment_currency,
      status: deal.status,
    },
    seller: { name: seller?.name ?? null },
    methods: await availableMethods(db, deal.tenant_id, deal),
    /**
     * What has already been chosen on this session, so a client that reloads
     * mid-payment can pick the thread up rather than start the buyer again.
     * Null on a session nobody has paid on yet, which is the common case.
     */
    payment: session.method
      ? { method: session.method, network: session.network, provider: session.provider }
      : null,
  })
}

/**
 * The buyer chooses, and a charge starts.
 *
 * "And we hand them to the provider" is what this used to say, and it was the
 * whole shape of the route: every method ended at somebody's hosted page
 * because `payment_link` was the only thing a charge could return. It is now
 * one of four answers — see `ChargeNextAction`. A wallet number typed in the
 * client's page is charged directly and needs no page at all.
 *
 * The provider call happens before any state write, for the reason `/pay` does
 * the same: a charge that threw never started, and a deal left in
 * `payment_pending` by a rail that refused it would be unretryable.
 */
async function payPublic(
  req: Request,
  db: SupabaseClient,
  token: string,
): Promise<Response> {
  const body = await readJson<{
    method: PaymentMethod
    /**
     * The rail the buyer chose when the checkout offered more than one for the
     * same method. Forwarded to `startCharge`, which refuses it unless that
     * rail is genuinely on for this market — a buyer cannot name a rail that
     * is switched off.
     */
    provider?: string
    network?: string
    /**
     * The buyer's wallet number. Passed to the rail and stored by nobody — see
     * `ChargeRequest.phone`. Its presence is what makes a mobile money charge
     * direct instead of a handoff.
     */
    phone?: string
    /**
     * Card details, when the tenant collects the fields in its own checkout.
     * Refused by `startCharge` unless that tenant has `raw_card_relay` on.
     */
    card?: CardInput
    buyer_ip?: string
  }>(req)
  required(body as unknown as Record<string, unknown>, 'method')

  const { session, deal } = await bySession(db, token)

  const charge = await startCharge(db, deal.tenant_id, deal, {
    method: body.method,
    provider: body.provider as Provider | undefined,
    network: body.network,
    phone: typeof body.phone === 'string' ? body.phone.trim() : undefined,
    card: body.card,
    returnUrl: session.return_url,
  })

  const { data, error } = await db.rpc('complete_checkout_session', {
    p_session: session.id,
    p_method: body.method,
    p_network: body.network ?? null,
    p_provider: charge.rail,
    p_provider_ref: charge.provider_ref,
    p_payment_link: charge.payment_link,
  })

  if (error) throw rpcError(error, 'complete this checkout')

  // §6's request context. This request came from the buyer's own browser, so
  // the address is ours to observe rather than something a client told us —
  // `hosted_page`, which is the middle of the three provenances and the reason
  // they are kept apart.
  const context = payContext(req, body)

  await recordContext(db, {
    deal_id: deal.id,
    source: 'hosted_page',
    event: 'pay_started',
    ip: context.observed ?? normaliseIp(''),
    ip_country: null,
    user_agent: context.userAgent,
  })

  const completed = data as unknown as CheckoutSession

  return json(req, {
    status: state(completed),
    // Where to send the buyer next. Kept, and kept first, because it is what
    // every existing integration reads — including our own hosted page.
    payment_link: completed.payment_link,
    /**
     * The same answer with its shape intact.
     *
     * `payment_link` can only say "go here", so a client reading it alone has
     * no way to finish a payment in its own page and no way to tell "approve
     * this on your handset" from "we need a code from you". This says which.
     */
    next_action: charge.next_action,
  })
}

/**
 * The buyer answers the extra factor a card rail demanded.
 *
 * Separate from `/pay` because `/pay` calls `complete_checkout_session`, and
 * this is a continuation of a charge that route already started — running it
 * again would try to complete a session that is no longer open and fail on a
 * buyer who has done nothing wrong.
 *
 * The rail wants the whole payload back, extra factor included, so the client
 * resends what it is holding. That is the reason nothing here stores a card
 * between the two calls: there is no window in which it would have to.
 */
async function authorizePublic(
  req: Request,
  db: SupabaseClient,
  token: string,
): Promise<Response> {
  const body = await readJson<{
    card: CardInput
    authorization: { mode: 'pin' | 'avs_noauth'; [field: string]: string | undefined }
    attempt?: number
  }>(req)
  required(body as unknown as Record<string, unknown>, 'card', 'authorization')

  const { session, deal } = await bySession(db, token, READABLE)

  if (!session.method) {
    throw new PayHoldError(
      'invalid_state',
      'No payment has been started on this checkout yet',
    )
  }

  const charge = await startCharge(db, deal.tenant_id, deal, {
    method: session.method,
    network: session.network ?? undefined,
    card: body.card,
    authorization: body.authorization,
    // Anything but 0, so the rail does not replay the first response. The
    // client counts its own attempts; a number it repeats only costs it a retry.
    attempt: body.attempt ?? 1,
    returnUrl: session.return_url,
  })

  const context = payContext(req, {})
  await recordContext(db, {
    deal_id: deal.id,
    source: 'hosted_page',
    event: 'pay_validated',
    ip: context.observed ?? normaliseIp(''),
    ip_country: null,
    user_agent: context.userAgent,
  })

  return json(req, { status: state(session), next_action: charge.next_action })
}

/**
 * The buyer approved a wallet, and we ask the rail to take the money.
 *
 * A wallet approval is two steps by the provider's design: the buyer says yes
 * in a window we do not own, and the order is only *captured* afterwards. The
 * SDK reports the first from the buyer's browser, which is not evidence of
 * anything — so this does not believe it. It asks the rail to capture, and the
 * rail refuses if no such approval happened.
 *
 * **Capturing is still not funding.** Money moving at PayPal does not move a
 * deal here; that waits for `paypal-webhook` to verify a signature and re-fetch
 * the order, exactly as every other rail does. §15 phase 2 is unmoved.
 */
async function capturePublic(
  req: Request,
  db: SupabaseClient,
  token: string,
): Promise<Response> {
  const body = await readJson<{ order: string }>(req)
  required(body as unknown as Record<string, unknown>, 'order')

  const { session, deal } = await bySession(db, token, READABLE)

  if (session.provider !== 'paypal') {
    throw new PayHoldError(
      'invalid_state',
      'This checkout is not a wallet payment',
    )
  }

  const { provider } = await loadProvider(db, deal.tenant_id, 'paypal')
  const paypal = provider as unknown as {
    captureOrder?: (orderId: string, key: string) => Promise<unknown>
  }

  if (!paypal.captureOrder) {
    throw new PayHoldError('policy_violation', 'This rail cannot capture an order')
  }

  await paypal.captureOrder(body.order, `capture:${deal.id}`)

  return json(req, {
    status: state(session),
    // Nothing to do next but wait for the webhook to say the money is held.
    next_action: {
      type: 'wait',
      message: 'Payment approved — confirming with your wallet provider.',
    },
  })
}

/**
 * The buyer answers a code the rail asked for.
 *
 * Nothing here can fund a deal either — §15 phase 2 holds across this route
 * exactly as it holds across `/pay`. A validated code means the rail accepted
 * the buyer's authorisation, not that money moved; the hold is still written by
 * the provider webhook after it re-fetches the transaction. So this writes no
 * state at all: it forwards a code and reports what the rail said next.
 *
 * The `reference` comes back from the client rather than out of a column, and
 * that is a deliberate reading of what it is. It is the rail's handle for a
 * half-finished charge, it is useless without the session token that reaches
 * this route, and whoever holds that token could have started the charge
 * themselves. Storing it would add a column that grants nothing the caller does
 * not already hold.
 */
async function validatePublic(
  req: Request,
  db: SupabaseClient,
  token: string,
): Promise<Response> {
  const body = await readJson<{ reference: string; otp: string }>(req)
  required(body as unknown as Record<string, unknown>, 'reference', 'otp')

  // `completed` is the expected state here, not an edge case: a code can only
  // be asked for by a charge that has already started.
  const { session, deal } = await bySession(db, token, READABLE)

  if (!session.provider || !session.method) {
    throw new PayHoldError(
      'invalid_state',
      'No payment has been started on this checkout yet',
    )
  }

  const { next_action } = await validateCharge(db, deal.tenant_id, session.provider, {
    reference: body.reference,
    otp: body.otp,
    method: session.method,
  })

  // No `buyer_ip` is read from this body — an attested address belongs to the
  // moment a client starts a payment, and this request is the buyer's own.
  const context = payContext(req, {})

  await recordContext(db, {
    deal_id: deal.id,
    source: 'hosted_page',
    event: 'pay_validated',
    ip: context.observed ?? normaliseIp(''),
    ip_country: null,
    user_agent: context.userAgent,
  })

  return json(req, { status: state(session), next_action })
}

/**
 * "Has it landed yet?" — asked of the rail, not of our own table.
 *
 * The route that closes the gap between a buyer being debited and a deal being
 * funded. Everything up to here is honest about the money being with the
 * provider and not yet with us; what was missing was any way to find that out
 * except an inbound webhook nobody controls. A client polling `GET` reads our
 * `deals` row, which is precisely the row that stays wrong when the doorbell
 * never rings — so a payment that succeeded at the rail could be watched
 * forever without ever being noticed.
 *
 * This asks the provider directly and books the hold if the answer is yes. It
 * is not a shortcut past §15 phase 2, it is that clause's own step 4 reached by
 * polling: the same `verify` call, over the same authenticated connection,
 * feeding the same `fund_deal`. Nothing a buyer sends can make it say yes.
 *
 * `POST` rather than folding it into the `GET`, for two reasons that point the
 * same way: it writes when the answer is yes, and it costs a provider round
 * trip every time. A `GET` doing either would mean any page load — a prefetch,
 * a retry, a bot with a token — spends a call at Flutterwave and may move
 * money. The URL should say that something happens here.
 *
 * The shape deliberately mirrors the part of `publicView` a waiting client
 * actually reads, so polling this instead of that is a one-word change.
 */
async function confirmPublic(
  req: Request,
  db: SupabaseClient,
  token: string,
): Promise<Response> {
  const { session, deal } = await bySession(db, token, READABLE)

  const settle = session.method
    ? await settleDeal(db, deal as unknown as SettleableDeal, {
      // The session's rail, not the deal's. The deal carries the rail it was
      // routed to at creation; the session carries the one that actually took
      // the charge, and those differ whenever the matrix moved in between.
      rail: session.provider,
      // Flutterwave answers to our deal id (`tx_ref`); Stripe answers to the
      // `pi_…` the charge returned, which lives here until funding writes it
      // onto the deal. `settleDeal` falls back through both.
      reference: session.provider_ref,
      method: session.method,
      network: session.network,
    })
    // No method on the session means nobody has chosen how to pay, so there is
    // no charge to ask about. Answering from the deal costs the rail nothing.
    : { status: deal.status, funded: false, reason: 'not_started' as const }

  return json(req, {
    status: state(session),
    deal: {
      id: deal.id,
      status: settle.status,
      amount: deal.presentment_amount,
      currency: deal.presentment_currency,
    },
    /** True on the one poll that moved it, and on every poll after. */
    settled: settle.funded,
    /** Why not yet — `pending` for as long as the rail is still deciding. */
    reason: settle.reason,
  })
}

/** The same mechanical mapping the other functions use on a SQL failure. */
function rpcError(error: { message: string }, what: string): PayHoldError {
  const message = error.message

  for (
    const code of
      ['not_found', 'invalid_state', 'policy_violation', 'insufficient_balance'] as const
  ) {
    if (message.startsWith(code)) {
      return new PayHoldError(code, message.slice(code.length + 2).trim())
    }
  }

  console.error(`unmapped ${what} failure`, { message })
  return new PayHoldError('policy_violation', `Could not ${what}`)
}

Deno.serve(handler(async (req) => {
  const db = serviceClient()

  const segments = new URL(req.url).pathname.split('/').filter(Boolean)
  const base = segments.indexOf('checkout')
  const scope = segments[base + 1]
  const key = segments[base + 2]
  const action = segments[base + 3]

  // --- the buyer, holding only a token -------------------------------------
  if (scope === 'public') {
    if (!key) throw new PayHoldError('not_found', 'This payment link is not valid')

    if (req.method === 'GET' && !action) return await publicView(req, db, key)
    if (req.method === 'POST' && action === 'pay') return await payPublic(req, db, key)
    if (req.method === 'POST' && action === 'validate') {
      return await validatePublic(req, db, key)
    }
    if (req.method === 'POST' && action === 'authorize') {
      return await authorizePublic(req, db, key)
    }
    if (req.method === 'POST' && action === 'capture') {
      return await capturePublic(req, db, key)
    }
    if (req.method === 'POST' && action === 'confirm') {
      return await confirmPublic(req, db, key)
    }

    throw new PayHoldError('not_found', `No such action "${action ?? ''}"`)
  }

  if (scope !== 'sessions') {
    throw new PayHoldError('not_found', `No such route "${scope ?? ''}"`)
  }

  // --- the client's server, holding a key ----------------------------------
  const caller = await resolveCaller(db, req)

  if (req.method === 'POST' && !key) return await create(req, db, caller)

  /**
   * Every link issued, newest first — including the withdrawn and the expired.
   *
   * A live session is already reachable from its deal. This answers a different
   * question: "which links has this account handed out", which is a record
   * rather than a state, and is where a support conversation about a payment
   * link starts.
   *
   * **The token is stripped from anything not live, and that is the one
   * judgement in this endpoint.** A token *is* the credential — `/checkout/
   * public/:token` takes no other — so carrying a dead one in a list would put
   * a plaintext credential in a response that outlives the session it belonged
   * to. A withdrawn or expired token opens nothing today, and the reason to
   * withhold it is that "opens nothing" is a property of the session's state
   * rather than of the string, and states get changed.
   *
   * Liveness comes from `state()`, never from the stored status — expiry is
   * derived for the same reason it is derived everywhere else, because a stored
   * value would need a writer and the writer would be a sweep that had not run
   * yet. `state()` is this file's existing mirror of SQL's
   * `checkout_session_state`, and it is used rather than the function itself
   * because that function takes a **row**: reaching it per session would be a
   * round trip each, on a page whose whole purpose is showing them together.
   */
  if (req.method === 'GET' && !key) {
    const dealId = new URL(req.url).searchParams.get('deal_id')

    let query = db
      .from('checkout_sessions')
      .select('id, deal_id, token, status, return_url, method, network, ' +
        'provider, provider_ref, payment_link, expires_at, completed_at, created_at')
      .eq('tenant_id', caller.tenant_id)
      .order('created_at', { ascending: false })

    if (dealId) query = query.eq('deal_id', dealId)

    const { data, error } = await query
    if (error) throw new Error(`checkout session list failed: ${error.message}`)

    const sessions = ((data ?? []) as unknown as CheckoutSession[]).map((row) => {
      const current = state(row)
      return {
        ...row,
        state: current,
        token: current === 'open' ? row.token : null,
      }
    })

    return json(req, { sessions })
  }

  if (req.method === 'GET' && key && !action) return await show(req, db, caller, key)
  if (req.method === 'POST' && key && action === 'cancel') {
    return await cancel(req, db, caller, key)
  }

  throw new PayHoldError('policy_violation', `${req.method} is not supported here`)
}))
