/**
 * One interface, all rails behind it — spec §7.
 *
 * Adding Paystack or DPO later is one new class implementing `PaymentProvider`,
 * one webhook function, and one routing entry. The ledger, the API and every
 * screen stay exactly as they are. That promise is only kept if nothing outside
 * this file knows which provider it is talking to, so:
 *
 *   - No caller may branch on `provider.name`. Route by capability, not by
 *     identity. `FlutterwaveProvider` is not "the African one", it is the one
 *     `payoutRail()` returns for that corridor.
 *   - Every method is idempotent on `idempotency_key`. Retries are normal:
 *     a cron pass that times out mid-transfer will run again.
 *   - Nothing here writes to the database. These are the outside-world calls;
 *     the bookkeeping half is the SQL functions in migration 000002, and
 *     keeping them apart is what makes a provider timeout recoverable.
 */

import type {
  Currency,
  Money,
  PaymentMethod,
  Provider,
} from './types.ts'

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

export interface ChargeRequest {
  /** Our deal id, passed to the provider as their reference. */
  deal_id: string
  amount: Money
  currency: Currency
  method: PaymentMethod
  /** The specific wallet or scheme, when the buyer has chosen one. */
  network?: string
  /**
   * The buyer's mobile money number, when they typed one.
   *
   * Only a mobile money rail has any use for it, and only a direct charge —
   * a hosted page asks for it itself. It is passed to the provider and kept
   * nowhere: no column on this side stores it, because a wallet number is the
   * buyer's identity on that rail and PayHold has no reason to remember it.
   */
  phone?: string
  /** Where the provider returns the buyer once they have paid. */
  return_url: string
  /**
   * Card charges request 3DS — spec §6. Providers that cannot honour it for a
   * given method ignore it; providers that can MUST NOT silently downgrade.
   */
  three_d_secure: boolean
  idempotency_key: string
}

/**
 * What the buyer has to do next, said precisely enough to be done in a page we
 * do not own.
 *
 * `payment_link` on its own could only ever mean "send them away", so every
 * rail had to end at somebody's hosted page and every integrator had to hand
 * the buyer over at the last step. These variants are the same information with
 * the shape kept: a client that understands them can finish a payment inside
 * its own checkout, and a client that does not can still read `payment_link`
 * and redirect exactly as before.
 *
 * The variants are ordered by how much they ask of the client.
 */
export type ChargeNextAction =
  /**
   * Nothing to collect and nothing to show — the buyer approves on their
   * handset. The client polls until the deal moves.
   */
  | { type: 'wait'; message: string }
  /**
   * The rail sent a one-time code and wants it back. `reference` is the
   * provider's handle for this half-finished charge and is what `validate`
   * must be given; it is the provider's, not ours, and means nothing elsewhere.
   */
  | { type: 'otp'; reference: string; message: string }
  /**
   * The buyer must be taken to the provider. Framing it is the client's call
   * and their risk — Stripe Checkout refuses to be framed, Flutterwave does not.
   */
  | { type: 'redirect'; url: string }
  /**
   * The provider's fields, mounted into the client's own markup.
   *
   * This is the variant to reach for. The provider serves each input from its
   * own origin, so the card number never touches the client or us and SAQ A
   * holds — but the client positions and styles the container, so it is their
   * checkout rather than a page of somebody else's wearing a border. Stripe's
   * Payment Element and PayPal's CardFields are both this shape.
   *
   * `client_secret` authorises exactly one payment and nothing else. It is
   * meant for the buyer's browser — that is what it is for — but it must not be
   * logged or stored, so it travels no further than the response that carries it.
   */
  | {
    type: 'payment_element'
    provider: Provider
    /** The provider's publishable key. Public by construction. */
    publishable_key: string
    client_secret: string
    /** Where the provider returns the buyer if a step of its own intervenes. */
    return_url: string
  }
  /**
   * The provider collects the details itself, in the client's own page, from a
   * script it serves. This is what keeps a PAN out of both our infrastructure
   * and theirs while still ending inside their checkout: the fields belong to
   * the provider's iframe, the surrounding page belongs to the client.
   *
   * Weaker than `payment_element` and kept for rails that offer nothing better:
   * a script is free to draw wherever it likes, and Flutterwave's takes the
   * whole viewport with a method picker of its own.
   *
   * `reference` is the charge reference the widget must use — our deal id — so
   * the charge the browser creates is the one our webhook is waiting for.
   */
  | {
    type: 'element'
    provider: Provider
    /** The provider's publishable key. Public by construction. */
    public_key: string
    reference: string
    amount: Money
    currency: Currency
    /** Methods the widget should offer. Already narrowed to the live matrix. */
    options: string[]
    redirect_url: string
  }

export interface ChargeResult {
  /** The provider's own reference. Becomes `deals.provider_ref`. */
  provider_ref: string
  /**
   * Where to send the buyer to complete payment.
   *
   * Empty when `next_action` needs no page — a mobile money charge already
   * accepted by the rail has nowhere to send anyone. Clients that still treat
   * this as the whole answer get an empty string rather than a link to nothing.
   */
  payment_link: string
  /**
   * The precise version of `payment_link`. Optional so an adapter that has not
   * been taught this yet keeps compiling; `startCharge` fills in a `redirect`
   * for whatever omits it, which is what those adapters always meant.
   */
  next_action?: ChargeNextAction
}

/** The buyer's answer to an `otp` next action. */
export interface ValidateChargeRequest {
  /** The `reference` the `otp` action carried. */
  reference: string
  otp: string
  method: PaymentMethod
}

/**
 * What the provider says about a transaction, fetched fresh from their API.
 *
 * This is the "re-verify" half of spec §6: a webhook tells us something
 * happened, and then we ask the provider directly what actually happened. The
 * webhook body is never trusted for amounts.
 */
export interface VerifiedTransaction {
  provider_ref: string
  amount: Money
  currency: Currency
  status: 'pending' | 'successful' | 'failed'
  method: PaymentMethod | null
  network: string | null
  /**
   * What the rail charged us for taking this payment, in the same currency —
   * §7's "provider fee", and the one figure in this breakdown that only the
   * provider knows.
   *
   * Zero on a rail that does not itemise it. Booking it here rather than
   * guessing at a rate matters: unbooked, it is the difference between our
   * ledger and the provider's balance, which the reconciliation pass reads as
   * drift and answers by freezing the tenant's payouts.
   */
  fee: Money
}

export interface PayoutRequest {
  payout_id: string
  /** A token from `sellers.beneficiary_token` — never a raw destination. */
  beneficiary_token: string
  amount: Money
  currency: Currency
  idempotency_key: string
}

export interface PayoutResult {
  provider_ref: string
  /** Some rails settle asynchronously; the transfer webhook confirms later. */
  status: 'pending' | 'paid'
}

export interface RefundRequest {
  provider_ref: string
  amount: Money
  currency: Currency
  idempotency_key: string
}

export interface PreauthRequest {
  deal_id: string
  amount: Money
  currency: Currency
  return_url: string
  idempotency_key: string
}

export interface TokenizeRequest {
  /** Raw MoMo number or bank account. Tokenized immediately, never stored. */
  destination: string
  currency: Currency
  country: string
}

export interface TokenizeResult {
  beneficiary_token: string
  /** Display-safe, e.g. "MTN •••• 4821". This is what we persist. */
  masked_destination: string
}

// ---------------------------------------------------------------------------
// The interface
// ---------------------------------------------------------------------------

/**
 * §9: "each adapter must expose capabilities rather than letting the UI guess."
 *
 * This is what makes "no caller may branch on `provider.name`" enforceable
 * rather than aspirational — a caller that needs to know whether a partial
 * refund is possible has somewhere to ask that is not the provider's identity.
 *
 * §7.1.6 is the immediate reason two of these exist: Alipay and WeChat Pay
 * refund asynchronously, and Stripe documents Alipay refunds up to 90 days
 * after payment. "All methods refund the same way" is a promise the product
 * must not make.
 *
 * The routing matrix that reads the rest of these is Phase 6.
 */
export interface ProviderCapabilities {
  supportsCapture: boolean
  supportsPartialRefund: boolean
  supportsMarketplacePayout: boolean
  supportsSellerOnboarding: boolean
  supportsDispute: boolean
  supportsLocalCurrency: boolean
  supportsMobileMoney: boolean
  /** The refund is acknowledged now and settles later, by webhook. */
  supportsAsyncRefund: boolean
}

export interface PaymentProvider {
  readonly name: Provider
  readonly capabilities: ProviderCapabilities

  /** Collect from the buyer. Returns where to send them to pay. */
  charge(req: ChargeRequest): Promise<ChargeResult>

  /**
   * Answer an `otp` next action and carry the charge on.
   *
   * Optional because issuing a code is a rail's behaviour, not a promise the
   * interface can make: Stripe never asks for one, and a method on every
   * adapter that all but one of them throws from would be a worse lie than its
   * absence. `startCharge`'s caller checks for it before offering the step.
   *
   * Returns a `ChargeResult` rather than a boolean because validating is not
   * always the last step — a rail may answer a correct code with another
   * action, and collapsing that into "done" would strand the buyer.
   */
  validate?(req: ValidateChargeRequest): Promise<ChargeResult>

  /**
   * Ask the provider what really happened. Called on every inbound webhook
   * before any state changes, and by the reconciliation cron.
   */
  verify(providerRef: string): Promise<VerifiedTransaction>

  /** Send funds to a tokenized beneficiary. */
  release(req: PayoutRequest): Promise<PayoutResult>

  /** Return the buyer's money. Safe to call twice. */
  refund(req: RefundRequest): Promise<{ provider_ref: string }>

  /** Hold a card deposit without taking it. */
  preauth(req: PreauthRequest): Promise<ChargeResult>

  /** Take some or all of a held pre-auth. */
  capture(providerRef: string, amount: Money): Promise<{ provider_ref: string }>

  /** Turn a raw payout destination into a token we can safely store. */
  tokenize(req: TokenizeRequest): Promise<TokenizeResult>

  /**
   * What the provider says it is holding for us, per currency. The
   * reconciliation cron compares this to `rail_balances()`, and a mismatch
   * freezes that tenant's payouts.
   */
  balances(): Promise<{ currency: Currency; amount: Money }[]>

  /**
   * Verify an inbound webhook's signature. Flutterwave sends `verif-hash`,
   * Stripe an HMAC over the raw body — hence both arguments, and hence the
   * RAW body: parsing before verifying is how signature checks get defeated.
   *
   * A promise is allowed because those two are different kinds of check.
   * Flutterwave's is a shared secret compared verbatim and answers
   * synchronously; Stripe's is an HMAC, and Web Crypto has no synchronous
   * digest. Callers await either way, which costs a synchronous rail nothing
   * and is the only shape that lets a real signature scheme sit behind this
   * interface at all.
   */
  verifySignature(rawBody: string, headers: Headers): boolean | Promise<boolean>
}

// ---------------------------------------------------------------------------
// FakeProvider — demo mode with zero keys must work end to end (§12)
// ---------------------------------------------------------------------------

/**
 * A provider that succeeds plausibly and touches no network.
 *
 * This is not a test double bolted on for convenience; the spec requires that
 * PayHold demonstrates a full deal lifecycle before any real credentials
 * exist, so this is the rail a fresh tenant runs on until they bring keys.
 *
 * It deliberately does NOT short-circuit any guard. A fake charge still has to
 * be webhooked in, still has to match amount and currency, still has to be
 * confirmed twice before it releases. The only thing faked is the counterparty.
 */
export class FakeProvider implements PaymentProvider {
  readonly name = 'fake' as const

  /**
   * Everything, because the fake exists so a full lifecycle works with zero
   * keys (§12) and a capability it refused would make a demo path unreachable
   * for a reason that is not true of any real rail.
   */
  readonly capabilities: ProviderCapabilities = {
    supportsCapture: true,
    supportsPartialRefund: true,
    supportsMarketplacePayout: true,
    supportsSellerOnboarding: true,
    supportsDispute: true,
    supportsLocalCurrency: true,
    supportsMobileMoney: true,
    supportsAsyncRefund: false,
  }

  /** Everything charged in this process, so `verify()` can answer honestly. */
  private readonly issued = new Map<string, VerifiedTransaction>()

  constructor(private readonly publicUrl: string) {}

  private ref(prefix: string): string {
    return `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`
  }

  charge(req: ChargeRequest): Promise<ChargeResult> {
    const provider_ref = this.ref('fake')
    this.issued.set(provider_ref, {
      provider_ref,
      amount: req.amount,
      currency: req.currency,
      // Pending, not successful: the demo still has to go through a webhook,
      // because that is the path the real rails take.
      status: 'pending',
      method: req.method,
      network: req.network ?? null,
      fee: 0,
    })
    return Promise.resolve({
      provider_ref,
      payment_link: `${this.publicUrl}/pay/${req.deal_id}?ref=${provider_ref}`,
    })
  }

  verify(providerRef: string): Promise<VerifiedTransaction> {
    const known = this.issued.get(providerRef)
    if (known) return Promise.resolve(known)

    // An Edge Function is not a long-lived process: the map is empty after a
    // cold start, and a demo webhook arriving then would otherwise fail
    // verification for the wrong reason. Unknown refs verify as pending with
    // no amount, which the caller treats as "not yet payable" — never as a
    // successful payment.
    return Promise.resolve({
      provider_ref: providerRef,
      amount: 0,
      currency: 'XXX',
      status: 'pending',
      method: null,
      network: null,
      // The fake charges nothing, which is the truth about it. §12 requires a
      // full lifecycle with zero keys, and inventing a fee would make demo
      // balances stop adding up for no gain.
      fee: 0,
    })
  }

  release(_req: PayoutRequest): Promise<PayoutResult> {
    return Promise.resolve({ provider_ref: this.ref('faketrf'), status: 'paid' })
  }

  refund(_req: RefundRequest): Promise<{ provider_ref: string }> {
    return Promise.resolve({ provider_ref: this.ref('fakerfnd') })
  }

  preauth(req: PreauthRequest): Promise<ChargeResult> {
    const provider_ref = this.ref('fakeauth')
    this.issued.set(provider_ref, {
      provider_ref,
      amount: req.amount,
      currency: req.currency,
      status: 'pending',
      method: 'card',
      network: 'Visa',
      fee: 0,
    })
    return Promise.resolve({
      provider_ref,
      payment_link: `${this.publicUrl}/pay/${req.deal_id}?deposit=${provider_ref}`,
    })
  }

  capture(_providerRef: string, _amount: Money): Promise<{ provider_ref: string }> {
    return Promise.resolve({ provider_ref: this.ref('fakecap') })
  }

  tokenize(req: TokenizeRequest): Promise<TokenizeResult> {
    const tail = req.destination.replace(/\D/g, '').slice(-4).padStart(4, '0')
    return Promise.resolve({
      beneficiary_token: this.ref('faketok'),
      masked_destination: `Demo •••• ${tail}`,
    })
  }

  balances(): Promise<{ currency: Currency; amount: Money }[]> {
    // No external truth to report. The reconciliation cron skips fake rails
    // rather than treating an empty list as "the provider holds nothing",
    // which would freeze every demo tenant on the first pass.
    return Promise.resolve([])
  }

  verifySignature(_rawBody: string, headers: Headers): boolean {
    // Demo mode still refuses an unsigned webhook. The forged-webhook test in
    // §9 must return 401 on every rail, this one included — a demo that
    // accepts anything teaches the wrong thing about the system.
    return headers.get('x-payhold-demo-signature') === 'demo'
  }
}
