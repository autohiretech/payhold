/**
 * PayPal — §9's third adapter, and the one that carries Venmo.
 *
 * The complement to the other two rather than a replacement. Flutterwave
 * reaches African mobile money; Stripe charges a card almost anywhere and
 * cannot pay a Rwandan seller; PayPal reaches a wallet balance in ~200 markets
 * and can *send* to one, which is the capability neither of the others has for
 * a US or European seller who has no card rail we can push to.
 *
 * Four shape facts the code below depends on. Every one of them differs from
 * Stripe, which is why this is an adapter and not a branch.
 *
 * - **Amounts are major-unit decimal strings.** `{"value": "100.00"}`, not
 *   `10000`. `Money` is minor units everywhere in PayHold, so every amount
 *   crosses `toValue`/`fromValue` at this boundary. Stripe's adapter has no
 *   such conversion *deliberately* — its API is already minor units — and the
 *   asymmetry is the thing to keep straight when reading the two side by side.
 *
 * - **Auth is OAuth2, not a static key.** A client id and secret are exchanged
 *   for a bearer token that expires. The token is cached in the instance and
 *   re-fetched a minute before it lapses, because a provider adapter is
 *   constructed per request and a token fetch per call would double every
 *   round trip.
 *
 * - **Webhook verification is a network call.** PayPal signs with a
 *   certificate chain and offers `/v1/notifications/verify-webhook-signature`
 *   rather than an HMAC we can compute. That is exactly why
 *   `PaymentProvider.verifySignature` is allowed to return a promise — the
 *   shape was chosen for a rail like this one. It also means an unreachable
 *   PayPal makes a webhook unverifiable, and unverifiable is refused: invariant
 *   2 says check the signature *and* re-fetch, and neither half is optional.
 *
 * - **A capture id is not an order id.** `charge` returns an order, their
 *   webhook talks about a capture, and a refund must be issued against the
 *   capture. `verify` accepts either and resolves to the same answer, so no
 *   caller has to know which it is holding — the same courtesy
 *   `StripeProvider.verify` does for sessions and intents.
 *
 * **Payouts go to a receiver, and the receiver is the token.** PayPal Payouts
 * sends to an email address or a payer id. A payer id is an opaque account
 * handle and is strongly preferred; an email is a personal identifier we would
 * rather not hold, so `tokenize` records what it is given and masks it for
 * display, and the raw value never appears in a response or an audit row.
 */

import { PayHoldError } from './types.ts'
import type { Currency, Money, PaymentMethod, Provider } from './types.ts'
import type {
  ChargeRequest,
  ChargeResult,
  PaymentProvider,
  PayoutRequest,
  PayoutResult,
  PreauthRequest,
  ProviderCapabilities,
  RefundRequest,
  TokenizeRequest,
  TokenizeResult,
  VerifiedTransaction,
} from './provider.ts'

export interface PayPalCredentials {
  client_id: string
  client_secret: string
  /** The id of the webhook registered in their dashboard. Verification needs it. */
  webhook_id: string
  /** Sandbox and live are different hosts, not a flag on the request. */
  mode?: 'test' | 'live'
}

const LIVE = 'https://api-m.paypal.com'
const SANDBOX = 'https://api-m.sandbox.paypal.com'

/**
 * Currencies PayPal quotes without decimals.
 *
 * Their list is not ours: HUF and TWD are decimal currencies that PayPal
 * nonetheless refuses fractional amounts in, which is a rule about their API
 * rather than about the money. `flutterwave.ts` keeps its own list for the same
 * reason — one shared table would be wrong for one of the three rails.
 */
const ZERO_DECIMAL = new Set(['JPY', 'HUF', 'TWD'])

/** Minor units → the decimal string PayPal wants. */
export function toValue(minor: Money, currency: Currency): string {
  if (ZERO_DECIMAL.has(currency)) return String(Math.round(minor))
  return (minor / 100).toFixed(2)
}

/** Their decimal string → our minor units. */
export function fromValue(value: string, currency: Currency): Money {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.round(ZERO_DECIMAL.has(currency) ? n : n * 100)
}

/** Their order/capture status vocabulary, mapped to ours. */
function toStatus(status: string | undefined): VerifiedTransaction['status'] {
  switch (status) {
    case 'COMPLETED':
    case 'APPROVED':
      return 'successful'
    case 'DECLINED':
    case 'FAILED':
    case 'VOIDED':
    case 'EXPIRED':
      return 'failed'
    // CREATED, SAVED, PAYER_ACTION_REQUIRED, PENDING — the buyer has not
    // finished. Deliberately not 'failed': an abandoned order that later
    // completes must be able to fund the deal.
    default:
      return 'pending'
  }
}

interface TokenResponse {
  access_token: string
  expires_in: number
}

interface AmountShape {
  currency_code: Currency
  value: string
}

interface CaptureShape {
  id: string
  status?: string
  amount?: AmountShape
  seller_receivable_breakdown?: {
    paypal_fee?: AmountShape
    gross_amount?: AmountShape
  }
}

interface OrderShape {
  id: string
  status?: string
  intent?: string
  links?: { rel: string; href: string }[]
  purchase_units?: {
    amount?: AmountShape
    payments?: {
      captures?: CaptureShape[]
      authorizations?: { id: string; status?: string; amount?: AmountShape }[]
    }
  }[]
}

export class PayPalProvider implements PaymentProvider {
  readonly name: Provider = 'paypal'

  /**
   * Matches the `provider_capabilities` row this adapter is landing against.
   * The row described what PayPal's documentation says; this is the same claim
   * made by the code, and the two must not disagree — `implemented` is what
   * says the second one now exists.
   */
  readonly capabilities: ProviderCapabilities = {
    // Orders with `intent: AUTHORIZE`, captured later — §22's deposits.
    supportsCapture: true,
    supportsPartialRefund: true,
    // Payouts API, to a wallet receiver.
    supportsMarketplacePayout: true,
    supportsSellerOnboarding: true,
    supportsDispute: true,
    supportsLocalCurrency: true,
    // A wallet rail. African mobile money stays Flutterwave's.
    supportsMobileMoney: false,
    // A PayPal refund is terminal when their API returns COMPLETED.
    supportsAsyncRefund: false,
    // No adapter for this — `chargeSaved` is absent, and this class isn't
    // enabled anyway (see `payhold-backend/CLAUDE.md`: no signed agreement).
    supportsSavedPaymentMethod: false,
  }

  /** Cached bearer token and the moment it stops being usable. */
  private token: { value: string; expiresAt: number } | null = null

  constructor(
    private readonly creds: PayPalCredentials,
    private readonly publicUrl: string,
  ) {}

  private get api(): string {
    return this.creds.mode === 'live' ? LIVE : SANDBOX
  }

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  /**
   * Exchange the client credentials for a bearer token, or reuse the live one.
   *
   * Expiry is shaded by sixty seconds. A token that lapses between the check
   * and the call would surface as a 401 on a charge, which is the worst place
   * to discover it — the buyer is waiting.
   */
  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now()) return this.token.value

    const basic = btoa(`${this.creds.client_id}:${this.creds.client_secret}`)
    const res = await fetch(`${this.api}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${basic}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    })

    if (!res.ok) {
      // Never surfaces their body. A failed token exchange is about our own
      // credentials, and their error text can quote the client id back.
      throw new PayHoldError('unauthorized', 'PayPal rejected these credentials')
    }

    const body = (await res.json()) as TokenResponse
    this.token = {
      value: body.access_token,
      expiresAt: Date.now() + Math.max(0, (body.expires_in - 60) * 1000),
    }
    return this.token.value
  }

  /**
   * Prove the client id and secret work, and nothing else.
   *
   * Public because connecting an account has to check the credentials before
   * storing them, and the token exchange is the *only* call that tests exactly
   * the credentials. `balances()` is the equivalent probe on the other two
   * rails, but here it reads `/v1/reporting/balances`, which needs a reporting
   * permission an app can perfectly well be missing while still being able to
   * take and send money — refusing a connection on that would turn away a
   * working account.
   *
   * It doubles as the mode check. Sandbox and live are different *hosts* on
   * this rail, so a sandbox client id simply does not authenticate against the
   * live one. That is a stronger check than the key-prefix inspection the other
   * two rails get rather than a weaker one, and it is why `connect` has no
   * prefix test to run here.
   */
  async authenticate(): Promise<void> {
    await this.accessToken()
  }

  private async call<T>(
    path: string,
    options: {
      method?: string
      body?: unknown
      /** Becomes `PayPal-Request-Id`, their idempotency header. */
      idempotencyKey?: string
    } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${await this.accessToken()}`,
      'content-type': 'application/json',
    }
    if (options.idempotencyKey) headers['paypal-request-id'] = options.idempotencyKey

    const res = await fetch(`${this.api}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    })

    const body = await res.json().catch(() => ({}))

    if (!res.ok) {
      const detail = (body as { message?: string; details?: { issue?: string }[] })
      const issue = detail.details?.[0]?.issue
      throw new PayHoldError(
        res.status === 401 ? 'unauthorized' : 'policy_violation',
        `PayPal: ${detail.message ?? res.statusText}${issue ? ` (${issue})` : ''}`,
      )
    }

    return body as T
  }

  /** Where PayPal wants the buyer sent. `payer-action` is v2's name for it. */
  private static approvalLink(order: OrderShape): string {
    const link = order.links?.find(
      (l) => l.rel === 'payer-action' || l.rel === 'approve',
    )
    if (!link) {
      throw new PayHoldError(
        'policy_violation',
        'PayPal created an order with nowhere to send the buyer',
      )
    }
    return link.href
  }

  // -------------------------------------------------------------------------
  // Collection
  // -------------------------------------------------------------------------

  /**
   * A hosted PayPal approval flow, for the same reason the other two adapters
   * hand off: the buyer authenticates with PayPal and their credentials never
   * touch our infrastructure.
   *
   * `intent: CAPTURE` takes the money on approval. §22's deposits use
   * `preauth`, which is the same call with `AUTHORIZE` — the split is the whole
   * difference between a payment and a hold against damage.
   */
  async charge(req: ChargeRequest): Promise<ChargeResult> {
    if (req.method !== 'wallet' && req.method !== 'card') {
      // A wallet rail has no mobile money and no bank debit. Refused rather
      // than silently charged some other way — the same refusal
      // `StripeProvider` makes for mobile money in the other direction.
      throw new PayHoldError(
        'policy_violation',
        `PayPal cannot take a ${req.method} payment`,
      )
    }

    const order = await this.call<OrderShape>('/v2/checkout/orders', {
      method: 'POST',
      idempotencyKey: req.idempotency_key,
      body: {
        intent: 'CAPTURE',
        purchase_units: [
          {
            custom_id: req.deal_id,
            amount: {
              currency_code: req.currency,
              value: toValue(req.amount, req.currency),
            },
          },
        ],
        payment_source: {
          paypal: {
            experience_context: {
              return_url: req.return_url,
              cancel_url: `${this.publicUrl}/status/${req.deal_id}`,
              // The buyer approves and we capture, rather than PayPal
              // capturing on their say-so. It keeps the money's arrival an
              // event we caused and can therefore reconcile.
              user_action: 'PAY_NOW',
            },
          },
        },
      },
    })

    const approval_url = PayPalProvider.approvalLink(order)

    return {
      provider_ref: order.id,
      payment_link: approval_url,
      // Without this, `startCharge` fills in the generic `redirect` fallback
      // — a plain URL, which the checkout client puts in an iframe the same
      // way it does Flutterwave's hosted page. PayPal refuses to be framed
      // for the identical reason Stripe Checkout does (§6, and this file's
      // own header on why a wallet's login can never be ours to embed), so
      // that iframe starts loading PayPal's page and is immediately blocked
      // — the buyer sees it arrive and vanish, with no way to actually pay.
      // `wallet_approval` is what the client's popup-based button already
      // expects; it was simply never returned.
      next_action: {
        type: 'wallet_approval',
        provider: 'paypal',
        client_id: this.creds.client_id,
        order: order.id,
        currency: req.currency,
        approval_url,
      },
    }
  }

  /**
   * Ask what really happened — invariant 2's second half.
   *
   * Accepts an **order id or a capture id**, because both are references this
   * adapter hands out: `charge` returns the order and their webhooks talk about
   * the capture. A caller forced to know which is which would be branching on
   * PayPal's internals.
   *
   * The amount reported is the capture's, not the order's. On a partially
   * captured or partially refunded order the two differ, and the capture is
   * what actually moved.
   */
  async verify(providerRef: string): Promise<VerifiedTransaction> {
    // A capture id resolves directly. An order id 404s here, which is the
    // signal to look it up as an order rather than an error worth raising.
    let capture: CaptureShape | null = null
    let orderStatus: string | undefined
    let fallbackAmount: AmountShape | undefined

    try {
      capture = await this.call<CaptureShape>(`/v2/payments/captures/${providerRef}`)
    } catch {
      const order = await this.call<OrderShape>(`/v2/checkout/orders/${providerRef}`)
      orderStatus = order.status
      const unit = order.purchase_units?.[0]
      fallbackAmount = unit?.amount
      capture = unit?.payments?.captures?.[0] ?? null

      // The capture embedded in an order response is a summary and does not
      // carry `seller_receivable_breakdown` — confirmed live: a deal verified
      // this way booked `provider_fee: 0` on a real, successful payment.
      // `settle-pending` calls this with the order id every time (that is
      // what `charge` hands out as `provider_ref`), so this branch — not the
      // direct capture lookup above — is the one the common case actually
      // takes. The full breakdown only comes from asking about the capture by
      // its own id directly, same as the direct-lookup branch already does.
      if (capture && !capture.seller_receivable_breakdown) {
        try {
          capture = await this.call<CaptureShape>(`/v2/payments/captures/${capture.id}`)
        } catch {
          /* the summary is still a real capture — better than nothing */
        }
      }
    }

    const amount = capture?.amount ?? fallbackAmount
    const currency = (amount?.currency_code ?? 'USD') as Currency

    // Their fee, off the receivable breakdown. It genuinely left the money that
    // arrived, so it is a `provider_fee` and belongs in no retained bucket.
    const feeShape = capture?.seller_receivable_breakdown?.paypal_fee
    const fee = feeShape ? fromValue(feeShape.value, feeShape.currency_code) : 0

    return {
      provider_ref: capture?.id ?? providerRef,
      amount: amount ? fromValue(amount.value, currency) : 0,
      currency,
      status: toStatus(capture?.status ?? orderStatus),
      // A PayPal payment is a wallet payment. How the buyer funded *their*
      // wallet is PayPal's business and they do not tell us — guessing 'card'
      // would put a claim in the record nobody made, which is the gap
      // `payment_method`'s `wallet` value exists to close.
      method: 'wallet',
      network: 'paypal',
      fee,
      // No adapter here saves a payment method — `supportsSavedPaymentMethod`
      // is false on this class, and no caller should ever read this as
      // anything but null.
      saved_payment_method: null,
    }
  }

  /**
   * Take the money the buyer approved.
   *
   * Separate from `charge` because approval and capture are two events on this
   * rail, and only the second is money arriving. The webhook is still what
   * funds the deal — this returns the capture, and `fund_deal` books it after
   * re-fetching.
   */
  async captureOrder(orderId: string, idempotencyKey: string): Promise<CaptureShape> {
    const order = await this.call<OrderShape>(
      `/v2/checkout/orders/${orderId}/capture`,
      { method: 'POST', idempotencyKey, body: {} },
    )

    const capture = order.purchase_units?.[0]?.payments?.captures?.[0]
    if (!capture) {
      throw new PayHoldError('policy_violation', 'PayPal captured nothing')
    }
    return capture
  }

  // -------------------------------------------------------------------------
  // Deposits — §22
  // -------------------------------------------------------------------------

  /**
   * `intent: AUTHORIZE`. The buyer approves and the money is held on their
   * side, not taken — which is what a security deposit is, and why this is a
   * different call rather than a charge we remember not to keep.
   */
  async preauth(req: PreauthRequest): Promise<ChargeResult> {
    const order = await this.call<OrderShape>('/v2/checkout/orders', {
      method: 'POST',
      idempotencyKey: req.idempotency_key,
      body: {
        intent: 'AUTHORIZE',
        purchase_units: [
          {
            custom_id: req.deal_id,
            amount: {
              currency_code: req.currency,
              value: toValue(req.amount, req.currency),
            },
          },
        ],
        payment_source: {
          paypal: {
            experience_context: {
              return_url: req.return_url,
              cancel_url: `${this.publicUrl}/status/${req.deal_id}`,
              user_action: 'CONTINUE',
            },
          },
        },
      },
    })

    const approval_url = PayPalProvider.approvalLink(order)

    return {
      provider_ref: order.id,
      payment_link: approval_url,
      // Same reasoning as `charge`'s identical block: without this a deposit
      // hold falls back to the generic `redirect`, which the client frames —
      // and PayPal refuses framing regardless of which intent the order was
      // created with.
      next_action: {
        type: 'wallet_approval',
        provider: 'paypal',
        client_id: this.creds.client_id,
        order: order.id,
        currency: req.currency,
        approval_url,
      },
    }
  }

  /**
   * Take some or all of a held authorization — §22's partial capture.
   *
   * `final_capture: false`, deliberately: a deposit captured in part must leave
   * the remainder held rather than releasing it, because the decision to keep
   * the rest may not have been made yet.
   */
  async capture(providerRef: string, amount: Money): Promise<{ provider_ref: string }> {
    const auth = await this.call<{ amount?: AmountShape }>(
      `/v2/payments/authorizations/${providerRef}`,
    )
    const currency = (auth.amount?.currency_code ?? 'USD') as Currency

    const captured = await this.call<CaptureShape>(
      `/v2/payments/authorizations/${providerRef}/capture`,
      {
        method: 'POST',
        body: {
          amount: { currency_code: currency, value: toValue(amount, currency) },
          final_capture: false,
        },
      },
    )

    return { provider_ref: captured.id }
  }

  // -------------------------------------------------------------------------
  // Refunds
  // -------------------------------------------------------------------------

  /**
   * Refund a capture. **Not an order** — PayPal refunds the thing that took the
   * money, and an order id here is a 422 rather than a helpful redirect.
   *
   * Idempotent by `PayPal-Request-Id`, which is what makes invariant 4 hold on
   * a retried refund: the same key returns the same refund rather than issuing
   * a second one.
   */
  async refund(req: RefundRequest): Promise<{ provider_ref: string }> {
    const refunded = await this.call<{ id: string }>(
      `/v2/payments/captures/${req.provider_ref}/refund`,
      {
        method: 'POST',
        idempotencyKey: req.idempotency_key,
        body: {
          amount: {
            currency_code: req.currency,
            value: toValue(req.amount, req.currency),
          },
        },
      },
    )

    return { provider_ref: refunded.id }
  }

  // -------------------------------------------------------------------------
  // Payouts
  // -------------------------------------------------------------------------

  /**
   * PayPal Payouts, one item per batch.
   *
   * One item rather than a batch of many because a payout row is one deal's
   * money with its own idempotency key and its own line in reconciliation.
   * Batching would make a partial failure a thing we could not book.
   *
   * Returns `pending` unless PayPal says the item is already done. Their batch
   * is accepted first and processed after, so treating acceptance as settlement
   * would report a seller paid before the money moved — `mark_payout_processing`
   * is what the `pending` answer feeds, and a later pass re-sends on the same
   * key and books when they confirm.
   */
  async release(req: PayoutRequest): Promise<PayoutResult> {
    const batch = await this.call<{
      batch_header?: { payout_batch_id?: string; batch_status?: string }
    }>('/v1/payments/payouts', {
      method: 'POST',
      idempotencyKey: req.idempotency_key,
      body: {
        sender_batch_header: {
          // Their own idempotency anchor, alongside the header. PayPal refuses
          // a repeated batch id outright, which is the behaviour we want.
          sender_batch_id: req.idempotency_key,
          email_subject: 'You have a payment',
        },
        items: [
          {
            // A payer id when we hold one, an email when we do not. `tokenize`
            // is what decides, and records which it stored.
            recipient_type: req.beneficiary_token.includes('@')
              ? 'EMAIL'
              : 'PAYPAL_ID',
            receiver: req.beneficiary_token,
            amount: {
              currency: req.currency,
              value: toValue(req.amount, req.currency),
            },
            sender_item_id: req.payout_id,
          },
        ],
      },
    })

    const id = batch.batch_header?.payout_batch_id
    if (!id) {
      throw new PayHoldError('policy_violation', 'PayPal accepted no payout batch')
    }

    return {
      provider_ref: id,
      status: batch.batch_header?.batch_status === 'SUCCESS' ? 'paid' : 'pending',
    }
  }

  /**
   * Record a payout destination.
   *
   * A lookup rather than a tokenization, the same way `StripeProvider.tokenize`
   * is: PayPal's destination *is* the receiver handle, and there is no call
   * that exchanges it for an opaque one. So this validates the shape and hands
   * back a mask, and the raw value is stored encrypted like every other
   * credential rather than printed anywhere.
   *
   * A payer id is preferred over an email and both are accepted, because a
   * seller onboarding through PayPal's own flow gives us the first and a seller
   * typing their account into a client's form gives us the second.
   */
  // `async` with no `await` in it, deliberately. The interface promises a
  // promise, and a method typed that way which throws *synchronously* is a trap
  // for any caller reaching for `.catch()` — the refusal would sail straight
  // past it. `paypal.test.ts` is what caught that.
  async tokenize(req: TokenizeRequest): Promise<TokenizeResult> {
    const value = req.destination.trim()

    if (!value) {
      throw new PayHoldError('policy_violation', 'A PayPal destination is required')
    }

    const isEmail = value.includes('@')

    if (isEmail) {
      const [user, domain] = value.split('@')
      if (!domain || !domain.includes('.') || !user) {
        throw new PayHoldError(
          'policy_violation',
          'That does not look like a PayPal account',
        )
      }
      return {
        beneficiary_token: value,
        masked_destination: `${user.slice(0, 2)}•••@${domain}`,
      }
    }

    // A payer id is 13 alphanumeric characters. A bank account number arriving
    // here is a client misunderstanding worth naming rather than storing.
    if (!/^[A-Z0-9]{9,20}$/i.test(value)) {
      throw new PayHoldError(
        'policy_violation',
        'A PayPal destination is an account email or a payer id, not bank details',
      )
    }

    return {
      beneficiary_token: value,
      masked_destination: `PayPal •••• ${value.slice(-4)}`,
    }
  }

  // -------------------------------------------------------------------------
  // Reconciliation
  // -------------------------------------------------------------------------

  /**
   * What PayPal says it is holding for us.
   *
   * The reconciliation pass compares this against `rail_balances()` and any
   * difference freezes the tenant's payouts, so an unreachable API must not
   * look like a zero balance — `call` throws, the pass records a `skipped`
   * rail, and a skipped rail is explicitly not a clean one.
   */
  async balances(): Promise<{ currency: Currency; amount: Money }[]> {
    const res = await this.call<{
      balances?: { currency: Currency; total_balance?: AmountShape }[]
    }>('/v1/reporting/balances')

    return (res.balances ?? [])
      .filter((b) => b.total_balance)
      .map((b) => ({
        currency: b.currency,
        amount: fromValue(b.total_balance!.value, b.currency),
      }))
  }

  // -------------------------------------------------------------------------
  // Webhooks
  // -------------------------------------------------------------------------

  /**
   * Verify an inbound webhook — and this one is a **network call**.
   *
   * PayPal signs with a certificate chain rather than a shared secret, and the
   * supported way to check it is to hand the headers and the body back to them.
   * That is the reason `PaymentProvider.verifySignature` may return a promise:
   * the shape exists so a rail like this can sit behind the same interface.
   *
   * Two consequences worth stating rather than discovering.
   *
   * **The body is parsed here, and only to re-serialise it into their request.**
   * Everywhere else in this system the raw body is what gets verified, because
   * parsing before verifying is how signature checks get defeated. Here the
   * parse *is* the API contract — `webhook_event` is a JSON value, not a
   * string — and nothing is trusted from it before the answer comes back.
   *
   * **An unreachable PayPal means unverified, never verified.** Any failure
   * returns false. Invariant 2 does not have a degraded mode, and a webhook we
   * could not check is one a forger would want us to accept.
   */
  async verifySignature(
    rawBody: string,
    headers: Headers,
  ): Promise<boolean> {
    const transmissionId = headers.get('paypal-transmission-id')
    const transmissionTime = headers.get('paypal-transmission-time')
    const transmissionSig = headers.get('paypal-transmission-sig')
    const certUrl = headers.get('paypal-cert-url')
    const authAlgo = headers.get('paypal-auth-algo')

    if (!transmissionId || !transmissionTime || !transmissionSig || !certUrl || !authAlgo) {
      return false
    }

    // Their own host, and only their own. A cert_url taken from the header
    // without this check is an attacker naming where we fetch a key from —
    // PayPal validates it too, and it costs nothing to refuse first.
    if (!/^https:\/\/api(-m)?(\.sandbox)?\.paypal\.com\//.test(certUrl)) {
      return false
    }

    let event: unknown
    try {
      event = JSON.parse(rawBody)
    } catch {
      return false
    }

    try {
      const res = await this.call<{ verification_status?: string }>(
        '/v1/notifications/verify-webhook-signature',
        {
          method: 'POST',
          body: {
            transmission_id: transmissionId,
            transmission_time: transmissionTime,
            cert_url: certUrl,
            auth_algo: authAlgo,
            transmission_sig: transmissionSig,
            webhook_id: this.creds.webhook_id,
            webhook_event: event,
          },
        },
      )
      return res.verification_status === 'SUCCESS'
    } catch {
      return false
    }
  }
}

/**
 * Confirm a credential set actually works before it is stored.
 *
 * Same contract as `validateStripeCredentials` and its Flutterwave twin:
 * storing unvalidated keys moves the failure to the first real charge, in front
 * of a buyer.
 *
 * Two differences from the other two, both consequences of the rail:
 *
 *   - **The probe is the token exchange**, not `balances()`. See
 *     `authenticate()` — reporting is a separate permission here, and an app
 *     without it can still take and send money.
 *   - **`currencies` is best-effort.** The caller uses `ok` and `reason`; the
 *     list is informational, so a missing reporting permission returns an empty
 *     one rather than failing a connection that is fine.
 */
export async function validatePayPalCredentials(
  creds: PayPalCredentials,
): Promise<{ ok: true; currencies: Currency[] } | { ok: false; reason: string }> {
  const provider = new PayPalProvider(creds, '')

  try {
    await provider.authenticate()
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof PayHoldError ? err.message : 'Could not reach PayPal',
    }
  }

  try {
    const balances = await provider.balances()
    return { ok: true, currencies: balances.map((b) => b.currency) }
  } catch {
    return { ok: true, currencies: [] }
  }
}
