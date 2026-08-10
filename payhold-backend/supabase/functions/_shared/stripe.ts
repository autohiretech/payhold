/**
 * StripeProvider — international card acquiring, and payouts where Stripe reaches.
 *
 * The complement to Flutterwave rather than a replacement for it. Stripe can
 * charge a card issued almost anywhere and **cannot pay a Rwandan seller**,
 * which is why a deal is routinely collected here and paid out there, and why
 * `rail_balances` has never been one pot.
 *
 * Credentials are per tenant (bring-your-own-keys). Nothing here reads the
 * environment: a provider instance that could fall back to platform keys would
 * collect one tenant's money into another's balance.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Three things about Stripe's API shape that the code below depends on:
 *
 *   **Amounts are already in the smallest currency unit.** Stripe takes 1500
 *   for $15.00 and 1500 for ¥1500, which is exactly the convention `Money`
 *   uses — see `ZERO_DECIMAL` in `flutterwave.ts`, where the same fact is
 *   written down as a conversion because Flutterwave quotes major units. So
 *   there is no `toMajor` here, and its absence is deliberate rather than an
 *   omission somebody should fix.
 *
 *   **Requests are form-encoded**, with bracket notation for nested objects.
 *   `form()` below is the whole of that.
 *
 *   **Idempotency is a header**, and Stripe replays the original response for
 *   24 hours. That is what makes `dispatchPayout`'s provider-before-booking
 *   order safe on this rail as well.
 * ─────────────────────────────────────────────────────────────────────────────
 */

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
import { PayHoldError, type Currency, type Money, type PaymentMethod } from './types.ts'

const API = 'https://api.stripe.com/v1'

export interface StripeCredentials {
  /** `sk_test_…` or `sk_live_…`. The one that must never leave the server. */
  secret_key: string
  /** `pk_…`. Safe to expose; used by their client-side SDK. */
  publishable_key: string
  /** `whsec_…` from the webhook endpoint's settings page. */
  webhook_secret: string
}

/**
 * Stripe's nested form encoding: `payment_intent_data[capture_method]=manual`.
 *
 * Undefined values are dropped rather than sent empty — Stripe treats an empty
 * string as an instruction to clear a field, which is not the same as saying
 * nothing about it.
 */
function form(params: Record<string, unknown>, prefix = ''): string[] {
  const out: string[] = []

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue
    const name = prefix ? `${prefix}[${key}]` : key

    if (Array.isArray(value)) {
      // Indexed, and **recursed** when the element is itself an object:
      // `line_items[0][price_data][unit_amount]=1500`. Stringifying an object
      // element instead would send Stripe the literal `[object Object]`, which
      // it accepts as a line item with no price and then charges nothing.
      value.forEach((v, i) => {
        if (v !== null && typeof v === 'object') {
          out.push(...form(v as Record<string, unknown>, `${name}[${i}]`))
        } else {
          out.push(
            `${encodeURIComponent(`${name}[${i}]`)}=${encodeURIComponent(String(v))}`,
          )
        }
      })
    } else if (typeof value === 'object') {
      out.push(...form(value as Record<string, unknown>, name))
    } else {
      out.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`)
    }
  }

  return out
}

/** Their payment-method vocabulary, mapped to ours. */
function toMethod(type: string | null | undefined): PaymentMethod | null {
  if (!type) return null
  // Link is card-backed: it carries a scheme, it is 3DS-eligible and it
  // disputes as a card does. A faster way to present a card, not a different
  // instrument — so it stays `card` while the true wallets below do not.
  if (type === 'card' || type === 'link') return 'card'
  // §9's wallet rails that reach us through Stripe. `cashapp` is the one that
  // made this necessary: it used to fall through to null, so a deal funded by
  // Cash App Pay recorded no method at all.
  if (type === 'cashapp' || type === 'paypal' || type === 'alipay' ||
      type === 'wechat_pay') {
    return 'wallet'
  }
  if (type === 'us_bank_account' || type === 'sepa_debit' || type === 'acss_debit') {
    return 'bank_transfer'
  }
  return null
}

interface StripeSession {
  id: string
  url?: string | null
  amount_total?: number | null
  currency?: string | null
  status?: string
  payment_status?: string
  payment_intent?: StripeIntent | string | null
}

interface StripeIntent {
  id: string
  amount: number
  amount_received?: number
  currency: string
  status: string
  latest_charge?: StripeCharge | string | null
  payment_method_types?: string[]
  /**
   * Present on creation, absent on the reads `verify` does. It authorises one
   * payment on this intent and is meant for the buyer's browser — which is why
   * it is never logged and never stored, only forwarded.
   */
  client_secret?: string
}

interface StripeCharge {
  id: string
  payment_method_details?: { type?: string; card?: { brand?: string } }
  balance_transaction?: { fee?: number } | string | null
}

/**
 * Our method vocabulary in Stripe's, for pinning an intent to one thing.
 *
 * Deliberately narrow. Each entry is a method the rails table can actually
 * route to Stripe, so a buyer is offered it only where it works; anything
 * absent never reaches `charge()` because `startCharge` refuses it first.
 */
const STRIPE_METHODS: Record<PaymentMethod, string[]> = {
  card: ['card'],
  // The wallets Stripe settles. Unreachable until `rails.ts` grows a wallet
  // rail — see the note there — but named here so that work is a one-line
  // change rather than a hunt.
  wallet: ['paypal', 'cashapp', 'alipay', 'wechat_pay'],
  bank_transfer: ['customer_balance'],
  // Never routed here: `charge()` refuses it above, because that corridor is
  // Flutterwave's.
  mobile_money: [],
}

export class StripeProvider implements PaymentProvider {
  readonly name = 'stripe' as const

  /**
   * §9. Unverified like every other rail claim here — see `RAILS_VERIFIED`.
   * These describe what Stripe's documentation says the API can do, not what a
   * signed agreement confirms our account may do, and §16 requires the second
   * before any of it carries live money. The database mirror is
   * `provider_capabilities`, and the two must agree.
   */
  readonly capabilities: ProviderCapabilities = {
    // PaymentIntents with `capture_method: manual` — this is how a §22 deposit
    // is held without being taken.
    supportsCapture: true,
    supportsPartialRefund: true,
    // Connect transfers to a connected account.
    supportsMarketplacePayout: true,
    supportsSellerOnboarding: true,
    supportsDispute: true,
    supportsLocalCurrency: true,
    // Not on any Stripe rail. African mobile money is Flutterwave's, which is
    // the structural reason both adapters exist.
    supportsMobileMoney: false,
    // Alipay and WeChat refunds settle out of band, up to 90 days — §7.1.6.
    supportsAsyncRefund: true,
  }

  constructor(
    private readonly creds: StripeCredentials,
    private readonly publicUrl: string,
  ) {}

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  private async call<T>(
    path: string,
    options: {
      method?: string
      body?: Record<string, unknown>
      idempotencyKey?: string
    } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.creds.secret_key}`,
      'content-type': 'application/x-www-form-urlencoded',
      // Pinned, because an account's default version moves when Stripe says so
      // and an adapter that changed shape on their schedule is one nobody can
      // reason about.
      //
      // **The release-name suffix is part of the version and belongs here.**
      // Stripe's versions are `YYYY-MM-DD.<train>`; stripping it does not give a
      // valid version, it gives a different invalid one. What was wrong with the
      // previous value was the value: `2026-06-30.basil` names a date Stripe has
      // no release on, on a train that ended at `2025-08-27.basil`. Every call
      // this adapter made was refused before it reached an endpoint, which is
      // why no test caught it — they all run against an intercepted fetch.
      //
      // Check https://docs.stripe.com/changelog before changing this. A version
      // that does not exist fails every request identically, whatever the key.
      'stripe-version': '2026-07-29.dahlia',
    }
    if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey

    const res = await fetch(`${API}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body ? form(options.body).join('&') : undefined,
    })

    const body = await res.json().catch(() => ({}))

    if (!res.ok) {
      // Their message is about the request, not about our credentials, so it is
      // safe to surface.
      throw new PayHoldError(
        res.status === 401 ? 'unauthorized' : 'policy_violation',
        `Stripe: ${body.error?.message ?? res.statusText}`,
      )
    }

    return body as T
  }

  // -------------------------------------------------------------------------
  // Collection
  // -------------------------------------------------------------------------

  /**
   * A PaymentIntent, so the buyer can pay where they already are.
   *
   * This used to open a hosted Checkout Session, and the reason to stop is that
   * a Session can only ever be *navigated to*: the URL is the whole product,
   * `checkout.stripe.com` refuses to be framed, and a client integrating one
   * therefore has no choice but to hand its buyer over to a page in somebody
   * else's brand. That is the handoff clients are trying to remove.
   *
   * An intent is the same charge without the constraint. It yields a
   * `client_secret`, Stripe's Payment Element mounts against it inside the
   * client's own checkout, and every field is still served from Stripe's
   * origin — so §6 does not move an inch. Card data touches neither the client
   * nor us, exactly as before; only the surrounding page changes hands.
   */
  async charge(req: ChargeRequest): Promise<ChargeResult> {
    if (req.method === 'mobile_money') {
      // Routing should never have sent this here. Failing loudly beats
      // collecting a card payment from somebody who chose a wallet.
      throw new PayHoldError(
        'policy_violation',
        'Stripe cannot collect mobile money — that corridor is Flutterwave\'s',
      )
    }

    const intent = await this.call<StripeIntent>('/payment_intents', {
      method: 'POST',
      idempotencyKey: req.idempotency_key,
      body: {
        amount: req.amount,
        currency: req.currency.toLowerCase(),
        metadata: { deal_id: req.deal_id },
        /**
         * Exactly the method the buyer already chose, and nothing else.
         *
         * `automatic_payment_methods` was the obvious setting and it is the
         * wrong one here. It hands the choice back to Stripe, and the Payment
         * Element then renders a tab for every method the dashboard has
         * switched on — so a buyer who picked Card in the client's own checkout
         * was shown Card, Link, Cash App and PayPal again, one modal deeper.
         * That is the nested picker clients integrate this to be rid of.
         *
         * The client's list is the authority. It came from `availableMethods`,
         * which already answers what this buyer in this market may use, and a
         * second opinion from the dashboard can only contradict it.
         */
        payment_method_types: STRIPE_METHODS[req.method],
        // §6, word for word the Session's rule: 3DS is requested on every card
        // charge and **never silently downgraded**. `any` asks Stripe to apply
        // it even where the issuer would have let the payment through without
        // it; `automatic` — the default — lets Radar decide, which is the
        // silent downgrade.
        payment_method_options: { card: { request_three_d_secure: 'any' } },
      },
    })

    if (!intent.client_secret) {
      throw new PayHoldError('policy_violation', 'Stripe returned no client secret')
    }

    return {
      provider_ref: intent.id,
      // No page to send anyone to, and saying so plainly beats handing back a
      // link that finishes nothing. `verify`, `refund` and `capture` all branch
      // on the `cs_` prefix already, so a bare `pi_…` needs nothing downstream.
      payment_link: '',
      next_action: {
        type: 'payment_element',
        provider: 'stripe',
        publishable_key: this.creds.publishable_key,
        client_secret: intent.client_secret,
        return_url: req.return_url,
      },
    }
  }

  /**
   * The hosted Checkout Session — kept, and no longer the way in.
   *
   * Still the right answer for a caller that genuinely wants to hand its buyer
   * over: a Session brings Stripe's own receipt, address collection and wallet
   * buttons, and rebuilding those around an intent would be worse than
   * navigating. `charge()` no longer reaches for it; deleting it would take the
   * option away from every tenant at once, which is not this change's to make.
   */
  async chargeHosted(req: ChargeRequest): Promise<ChargeResult> {
    const session = await this.call<StripeSession>('/checkout/sessions', {
      method: 'POST',
      idempotencyKey: req.idempotency_key,
      body: {
        mode: 'payment',
        client_reference_id: req.deal_id,
        success_url: req.return_url,
        cancel_url: req.return_url,
        line_items: [{
          quantity: 1,
          price_data: {
            currency: req.currency.toLowerCase(),
            unit_amount: req.amount,
            product_data: { name: `PayHold deal ${req.deal_id}` },
          },
        }],
        payment_intent_data: {
          metadata: { deal_id: req.deal_id },
          // §6: 3DS is requested on every card charge and **never silently
          // downgraded**. `any` asks Stripe to apply it even where the issuer
          // would have let the payment through without it; `automatic` — the
          // default — would let Radar decide, which is the silent downgrade.
          payment_method_options: { card: { request_three_d_secure: 'any' } },
        },
        metadata: { deal_id: req.deal_id },
      },
    })

    if (!session.url) {
      throw new PayHoldError('policy_violation', 'Stripe returned no checkout URL')
    }

    return { provider_ref: session.id, payment_link: session.url }
  }

  /**
   * The re-verify half of §6.
   *
   * Takes either a Checkout Session id or a PaymentIntent id, because both are
   * references this adapter hands out: `charge` returns the session, and their
   * webhook talks about the intent. A caller that had to know which is which
   * would be branching on Stripe's internals.
   */
  async verify(providerRef: string): Promise<VerifiedTransaction> {
    const intent = providerRef.startsWith('cs_')
      ? await this.intentForSession(providerRef)
      : await this.call<StripeIntent>(
        `/payment_intents/${providerRef}?expand[]=latest_charge.balance_transaction`,
      )

    if (!intent) {
      return {
        provider_ref: providerRef,
        amount: 0,
        currency: 'XXX',
        status: 'pending',
        method: null,
        network: null,
        fee: 0,
      }
    }

    const charge = typeof intent.latest_charge === 'object' ? intent.latest_charge : null
    const balanceTx = charge && typeof charge.balance_transaction === 'object'
      ? charge.balance_transaction
      : null

    return {
      provider_ref: providerRef,
      // `amount_received` is what actually arrived; `amount` is what was asked
      // for. On a manual-capture intent they differ until capture, and booking
      // the second would credit a hold as though it were a payment.
      amount: intent.amount_received ?? intent.amount,
      currency: intent.currency.toUpperCase(),
      status: intent.status === 'succeeded'
        ? 'successful'
        // `requires_capture` is a held deposit, not a failure and not a
        // payment: §22's pre-auth sits here until somebody captures it.
        : ['canceled', 'requires_payment_method'].includes(intent.status)
        ? 'failed'
        : 'pending',
      method: toMethod(
        charge?.payment_method_details?.type ?? intent.payment_method_types?.[0],
      ),
      network: charge?.payment_method_details?.card?.brand ?? null,
      // §7's provider fee, from the balance transaction — the only place Stripe
      // states what it actually took. Zero when it is not expanded yet, which
      // is the honest reading: booking a guess would put the ledger out by the
      // difference and reconciliation reads that as drift.
      fee: balanceTx?.fee ?? 0,
    }
  }

  private async intentForSession(sessionId: string): Promise<StripeIntent | null> {
    const session = await this.call<StripeSession>(
      `/checkout/sessions/${sessionId}?expand[]=payment_intent.latest_charge.balance_transaction`,
    )
    return typeof session.payment_intent === 'object' ? session.payment_intent : null
  }

  // -------------------------------------------------------------------------
  // Payout
  // -------------------------------------------------------------------------

  /**
   * A Connect transfer to the seller's connected account.
   *
   * `paid` rather than `pending`: the transfer moves money out of this tenant's
   * Stripe balance synchronously, and that is the event our ledger books. When
   * it reaches the seller's own bank is Stripe's payout schedule on their
   * account, which is theirs and not ours to report.
   */
  async release(req: PayoutRequest): Promise<PayoutResult> {
    const transfer = await this.call<{ id: string }>('/transfers', {
      method: 'POST',
      idempotencyKey: req.idempotency_key,
      body: {
        amount: req.amount,
        currency: req.currency.toLowerCase(),
        // The beneficiary token is the connected account id — see `tokenize`.
        destination: req.beneficiary_token,
        transfer_group: req.payout_id,
        metadata: { payout_id: req.payout_id },
      },
    })

    return { provider_ref: transfer.id, status: 'paid' }
  }

  async refund(req: RefundRequest): Promise<{ provider_ref: string }> {
    const intent = req.provider_ref.startsWith('cs_')
      ? (await this.intentForSession(req.provider_ref))?.id
      : req.provider_ref

    if (!intent) {
      throw new PayHoldError(
        'not_found',
        `Stripe has no payment behind ${req.provider_ref}`,
      )
    }

    const refund = await this.call<{ id: string }>('/refunds', {
      method: 'POST',
      idempotencyKey: req.idempotency_key,
      body: {
        payment_intent: intent,
        amount: req.amount,
        metadata: { currency: req.currency },
      },
    })

    return { provider_ref: refund.id }
  }

  // -------------------------------------------------------------------------
  // Card pre-auth deposits — §22
  // -------------------------------------------------------------------------

  /**
   * The same hosted session with `capture_method: manual`, which is how Stripe
   * holds a card without taking it. Their authorization lasts seven days.
   */
  async preauth(req: PreauthRequest): Promise<ChargeResult> {
    const session = await this.call<StripeSession>('/checkout/sessions', {
      method: 'POST',
      idempotencyKey: req.idempotency_key,
      body: {
        mode: 'payment',
        client_reference_id: `${req.deal_id}-deposit`,
        success_url: req.return_url,
        cancel_url: req.return_url,
        line_items: [{
          quantity: 1,
          price_data: {
            currency: req.currency.toLowerCase(),
            unit_amount: req.amount,
            product_data: { name: `PayHold deposit ${req.deal_id}` },
          },
        }],
        payment_intent_data: {
          capture_method: 'manual',
          metadata: { deal_id: req.deal_id, kind: 'deposit' },
          payment_method_options: { card: { request_three_d_secure: 'any' } },
        },
        metadata: { deal_id: req.deal_id, kind: 'deposit' },
      },
    })

    if (!session.url) {
      throw new PayHoldError('policy_violation', 'Stripe returned no checkout URL')
    }

    return { provider_ref: session.id, payment_link: session.url }
  }

  /** Take some or all of a held pre-auth. §22 allows a partial capture. */
  async capture(providerRef: string, amount: Money): Promise<{ provider_ref: string }> {
    const intent = providerRef.startsWith('cs_')
      ? (await this.intentForSession(providerRef))?.id
      : providerRef

    if (!intent) {
      throw new PayHoldError('not_found', `Stripe has no deposit behind ${providerRef}`)
    }

    const captured = await this.call<{ id: string }>(
      `/payment_intents/${intent}/capture`,
      { method: 'POST', body: { amount_to_capture: amount } },
    )

    return { provider_ref: captured.id }
  }

  // -------------------------------------------------------------------------
  // Destinations and balances
  // -------------------------------------------------------------------------

  /**
   * Stripe's "token" for a payout destination is the seller's **connected
   * account id** (`acct_…`), which the client's own onboarding produced. This
   * confirms it exists and can be paid before it is stored, rather than
   * discovering otherwise when a payout is due and the money is collected.
   *
   * PayHold never sees the bank details behind it — they are Stripe's, given by
   * the seller during Connect onboarding, which is exactly the property §19
   * wants and the reason this method looks like a lookup rather than a create.
   */
  async tokenize(req: TokenizeRequest): Promise<TokenizeResult> {
    const id = req.destination.trim()

    if (!id.startsWith('acct_')) {
      throw new PayHoldError(
        'policy_violation',
        'A Stripe payout destination is a connected account id (acct_…). ' +
          'Raw bank details are given to Stripe during Connect onboarding, ' +
          'never to PayHold.',
      )
    }

    const account = await this.call<{
      id: string
      business_profile?: { name?: string | null }
      payouts_enabled?: boolean
      external_accounts?: { data?: { last4?: string; bank_name?: string }[] }
    }>(`/accounts/${encodeURIComponent(id)}`)

    if (!account.payouts_enabled) {
      throw new PayHoldError(
        'policy_violation',
        'That Stripe account cannot receive payouts yet — its onboarding is incomplete',
      )
    }

    const external = account.external_accounts?.data?.[0]

    return {
      beneficiary_token: account.id,
      masked_destination: `${external?.bank_name ?? account.business_profile?.name ?? 'Stripe'} •••• ${external?.last4 ?? account.id.slice(-4)}`,
    }
  }

  async balances(): Promise<{ currency: Currency; amount: Money }[]> {
    const balance = await this.call<{
      available?: { amount: number; currency: string }[]
    }>('/balance')

    return (balance.available ?? []).map((b) => ({
      currency: b.currency.toUpperCase(),
      amount: b.amount,
    }))
  }

  // -------------------------------------------------------------------------
  // Webhook signature
  // -------------------------------------------------------------------------

  /**
   * `Stripe-Signature: t=<unix>,v1=<hex hmac-sha256 over "<t>.<raw body>">`.
   *
   * The same construction PayHold uses on its own outbound deliveries, and
   * verified with the same two obligations we place on our clients: check the
   * digest **and** bound the age of `t`, or a captured delivery can be replayed.
   * Five minutes is Stripe's own recommended tolerance.
   *
   * Async, unlike Flutterwave's — theirs is a shared secret compared verbatim,
   * this is an HMAC, and Web Crypto has no synchronous digest. That is why the
   * interface returns `boolean | Promise<boolean>`.
   */
  async verifySignature(rawBody: string, headers: Headers): Promise<boolean> {
    const header = headers.get('stripe-signature')
    if (!header || !this.creds.webhook_secret) return false

    const parts = new Map(
      header.split(',').map((p) => {
        const [k, v] = p.split('=', 2)
        return [k.trim(), v ?? '']
      }),
    )

    const timestamp = parts.get('t')
    const presented = parts.get('v1')
    if (!timestamp || !presented) return false

    const age = Math.abs(Date.now() / 1000 - Number(timestamp))
    if (!Number.isFinite(age) || age > 300) return false

    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(this.creds.webhook_secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    )
    const digest = await crypto.subtle.sign(
      'HMAC',
      key,
      new TextEncoder().encode(`${timestamp}.${rawBody}`),
    )
    const expected = [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')

    // Constant-time compare: a plain === leaks the digest's prefix over enough
    // forged requests.
    if (presented.length !== expected.length) return false
    let diff = 0
    for (let i = 0; i < presented.length; i++) {
      diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i)
    }
    return diff === 0
  }
}

/**
 * Confirm a credential set actually works before it is stored.
 *
 * Storing unvalidated keys moves the failure to the first real charge, in front
 * of a buyer. `/balance` is the cheapest authenticated call that proves the
 * secret key is live.
 */
export async function validateStripeCredentials(
  creds: StripeCredentials,
): Promise<{ ok: true; currencies: Currency[] } | { ok: false; reason: string }> {
  try {
    const provider = new StripeProvider(creds, '')
    const balances = await provider.balances()
    return { ok: true, currencies: balances.map((b) => b.currency) }
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof PayHoldError ? err.message : 'Could not reach Stripe',
    }
  }
}
