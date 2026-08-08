/**
 * §10.1's hosted checkout sessions.
 *
 * The mirror of `20260807000012_checkout_sessions.sql` — `openCheckoutSession`,
 * `completeCheckoutSession`, `cancelCheckoutSession`, `checkoutSessionState`, in
 * the same order and with the same rules. A change to either is a change to
 * both.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * §15 phase 2: *"test payments cannot be marked successful without verified
 * provider events."* **Nothing in this file funds a deal.** Completing a
 * session means the buyer finished the hosted flow and was handed to the
 * provider — the deal reaches `payment_pending` and stops, exactly where
 * `/pay` already leaves it. `funded_held` comes from the provider webhook, and
 * in the mock that is `simulateFunding`, which is the dev panel standing in for
 * a rail rather than a shortcut through one.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A session exists so a buyer can choose a payment method **without holding an
 * API key**, and without the client's server proxying the choice. It is also
 * what finally gives `checkout_started` a writer — declared in Phase 1 and
 * unreachable until now.
 */

import type {
  CheckoutSession,
  CheckoutSessionState,
  PaymentMethod,
  Provider,
} from '../types'
import { PayHoldError } from '../types'
import { audit, mintId, now, nowIso, type MockDb } from './store'
import { emitWebhook } from './webhooks'
import { requireDeal, touch } from './engine'
import { marketOpen } from './routing'
import { collectionRails, METHOD_LABEL } from '@/lib/rails'

/** Deal states a payment link may be issued against. */
const OPENABLE = ['created', 'checkout_started', 'payment_failed']

/**
 * `open | completed | canceled | expired`, with expiry derived rather than
 * stored — the same reasoning as §5.1's `clearing` and `available`. A stored
 * value would need a writer, and the writer would be a sweep that had not run
 * yet; deriving it means the refusal starts the instant the link expires.
 */
export function checkoutSessionState(session: CheckoutSession): CheckoutSessionState {
  if (session.status === 'open' && new Date(session.expires_at) <= now()) {
    return 'expired'
  }
  return session.status
}

/**
 * A token that is not worth guessing.
 *
 * The browser's CSPRNG, hex-encoded to 64 characters. The backend uses
 * `gen_random_bytes(32)` for the same 256 bits — a uuid would be 122 bits
 * wearing a recognisable shape, and this is the only thing standing between a
 * stranger and somebody's payment page.
 */
function mintToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function liveSession(db: MockDb, dealId: string): CheckoutSession | undefined {
  return db.checkout_sessions.find(
    (s) => s.deal_id === dealId && checkoutSessionState(s) === 'open',
  )
}

/**
 * Issue a payment link, or hand back the one already live.
 *
 * Idempotent by design. Two open sessions would be two live links against one
 * hold, and a buyer following the older one would start a second charge for the
 * same booking; returning the existing one also means a client retrying the
 * call does not strand a link behind it.
 */
export function openCheckoutSession(
  db: MockDb,
  dealId: string,
  options: { hours?: number; returnUrl?: string | null } = {},
): CheckoutSession {
  const deal = requireDeal(db, dealId)

  // `payment_failed` is here so a declined card gets a fresh link without the
  // client creating a second deal. `payment_pending` is not: a buyer mid-payment
  // on one rail must not be handed a second link.
  if (!OPENABLE.includes(deal.status)) {
    throw new PayHoldError(
      'invalid_state',
      `This deal is ${deal.status}, so a checkout cannot be opened`,
    )
  }

  const existing = liveSession(db, dealId)
  if (existing) return existing

  // An open-but-expired session is closed on the way past, or the one-live-
  // session rule would have nothing to enforce.
  for (const stale of db.checkout_sessions) {
    if (stale.deal_id === dealId && stale.status === 'open') stale.status = 'canceled'
  }

  const hours = Math.max(options.hours ?? 24, 1)

  const session: CheckoutSession = {
    id: mintId(db, 'cs'),
    tenant_id: deal.tenant_id,
    deal_id: deal.id,
    token: mintToken(),
    status: 'open',
    return_url: options.returnUrl ?? null,
    method: null,
    network: null,
    provider: null,
    provider_ref: null,
    payment_link: null,
    expires_at: new Date(now().getTime() + hours * 3_600_000).toISOString(),
    completed_at: null,
    created_at: nowIso(),
  }

  db.checkout_sessions.push(session)

  if (deal.status === 'created' || deal.status === 'payment_failed') {
    deal.status = 'checkout_started'
    touch(deal)
  }

  audit(db, deal.tenant_id, deal.id, 'system', 'checkout.opened', {
    session_id: session.id,
    expires_at: session.expires_at,
  })

  return session
}

/** Resolve a token, refusing anything not live. */
export function sessionByToken(db: MockDb, token: string): CheckoutSession {
  const session = db.checkout_sessions.find((s) => s.token === token)

  // The refusal is the same for a token that never existed, one that expired
  // and one that was withdrawn. Distinguishing them would let somebody probe
  // for real tokens.
  if (!session || checkoutSessionState(session) !== 'open') {
    throw new PayHoldError(
      'not_found',
      'This payment link has expired or has already been used',
    )
  }

  return session
}

/**
 * The buyer chose, and has been handed to the provider.
 *
 * Read the state changes: the session becomes `completed` and the deal becomes
 * `payment_pending`. There is no ledger entry and no route to `funded_held`.
 */
export function completeCheckoutSession(
  db: MockDb,
  sessionId: string,
  choice: {
    method: PaymentMethod
    network?: string | null
    provider: Provider
    providerRef: string
    paymentLink: string
  },
): CheckoutSession {
  const session = db.checkout_sessions.find((s) => s.id === sessionId)
  if (!session) {
    throw new PayHoldError('not_found', `Checkout session ${sessionId} not found`)
  }

  const state = checkoutSessionState(session)
  if (state !== 'open') {
    throw new PayHoldError('invalid_state', `This checkout session is ${state}`)
  }

  const deal = requireDeal(db, session.deal_id)

  session.status = 'completed'
  session.completed_at = nowIso()
  session.method = choice.method
  session.network = choice.network ?? null
  session.provider = choice.provider
  session.provider_ref = choice.providerRef
  session.payment_link = choice.paymentLink

  // The rail is recorded now so an operator sees where the payment went while
  // it is still pending. The hold waits for the webhook, as it always has.
  deal.provider = choice.provider
  deal.payment_method = choice.method
  deal.payment_network = choice.network ?? null
  deal.status = 'payment_pending'
  touch(deal)

  audit(db, deal.tenant_id, deal.id, 'buyer', 'checkout.completed', {
    session_id: session.id,
    provider: choice.provider,
    method: choice.method,
    network: choice.network ?? null,
  })

  // §10.2. Distinct from `order.funded_held` on purpose.
  emitWebhook(db, deal.tenant_id, 'checkout.completed', deal.id, {
    session_id: session.id,
    method: choice.method,
    network: choice.network ?? null,
    provider: choice.provider,
  })

  return session
}

/**
 * Withdraw a link.
 *
 * The deal goes back to `created` only if nothing else has happened to it — a
 * withdrawn link is not a statement about a deal that has since been funded,
 * disputed or canceled. That backwards edge is the one Phase 7 added to the
 * transition guard, and it is legal precisely because nothing happened.
 */
export function cancelCheckoutSession(
  db: MockDb,
  sessionId: string,
  actor: string,
): CheckoutSession {
  const session = db.checkout_sessions.find((s) => s.id === sessionId)
  if (!session) {
    throw new PayHoldError('not_found', `Checkout session ${sessionId} not found`)
  }
  if (session.status === 'completed') {
    throw new PayHoldError(
      'invalid_state',
      'This checkout session has already been used',
    )
  }

  session.status = 'canceled'

  const deal = requireDeal(db, session.deal_id)
  if (deal.status === 'checkout_started') {
    deal.status = 'created'
    touch(deal)
  }

  audit(db, session.tenant_id, session.deal_id, actor, 'checkout.canceled', {
    session_id: session.id,
  })

  return session
}

/**
 * Which rails this buyer may actually choose right now.
 *
 * The generated registry says what is *possible* in that market;
 * `payment_markets` and `provider_capabilities` say what is *on* (§29.11). A
 * method offered from the first without the second is a button that fails at
 * the provider, in front of a buyer.
 */
export function availableMethods(
  db: MockDb,
  deal: { tenant_id: string; buyer_country: string; presentment_currency: string },
): { method: PaymentMethod; label: string; provider: Provider; networks: string[] }[] {
  if (!marketOpen(db, deal.tenant_id, deal.buyer_country as never, 'collect')) return []

  const live = new Set(
    db.provider_capabilities
      .filter((c) => c.implemented && c.enabled)
      .map((c) => c.provider),
  )

  return collectionRails(deal.buyer_country as never, deal.presentment_currency as never)
    .filter((rail) => live.has(rail.provider))
    .map((rail) => ({
      method: rail.method,
      label: METHOD_LABEL[rail.method],
      provider: rail.provider,
      networks: rail.networks,
    }))
}
