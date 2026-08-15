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
  /**
   * The buyer's card, when the tenant collects the fields itself.
   *
   * **This is an exception to §6, it is off by default, and it is the tenant's
   * to take.** PayHold's normal posture is that a card never reaches this
   * system at all: the hosted page, the framed checkout and `payment_element`
   * all keep the number inside the provider's own origin, which is what makes
   * "PayHold does not handle card numbers" structurally true rather than a
   * promise. A tenant sending this has accepted PCI SAQ D on their own side —
   * see `rawCardAllowed` in `settings.ts`, which refuses it unless switched on
   * for that tenant.
   *
   * Prefer `payment_element` wherever the rail offers one. This exists because
   * Flutterwave does not: it has a hosted page and a full-viewport script, and
   * nothing in between, so a tenant who wants their own checkout on that rail
   * has no other route.
   *
   * What is guaranteed: encrypted for the provider on the way out, never
   * written to a column, never logged, never held past the request.
   */
  card?: {
    number: string
    cvv: string
    /** Two digits. */
    expiry_month: string
    /** Two digits — the short year, as the rail wants it. */
    expiry_year: string
    name?: string
    email?: string
  }
  /**
   * The second factor a card rail asked for after seeing the card.
   *
   * Answering it means sending the card *again*, which is the rail's design
   * rather than ours. Keeping it in the request — instead of caching the card
   * here between calls — is what lets the client hold it in memory and resend,
   * so nothing on this side ever stores one.
   */
  authorization?: {
    mode: 'pin' | 'avs_noauth'
    pin?: string
    city?: string
    address?: string
    state?: string
    country?: string
    zipcode?: string
  }
  /**
   * Distinguishes retries of one payment from each other.
   *
   * A card rail answers the first call with a demand for a PIN or an address,
   * and the answer is a second call carrying the same reference. The
   * idempotency key must therefore differ between them, or the rail replays the
   * first response and the buyer is asked for the same PIN forever.
   */
  attempt?: number
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
   * The card needs a PIN before it will authorise.
   *
   * Distinct from `otp` because the answer goes somewhere else: a PIN returns
   * to the *charge* endpoint alongside the card, while a code goes to
   * `validate`. Collapsing them would send a PIN to a route that cannot use it.
   * Usually followed by an `otp` action once the PIN is accepted.
   */
  | { type: 'pin'; message: string }
  /**
   * The card needs the billing address the issuer holds.
   *
   * `fields` names what to ask for rather than leaving a client to guess, and
   * is ordered the way a form should read.
   */
  | { type: 'avs'; message: string; fields: string[] }
  /**
   * A wallet the buyer signs into, approved in a window the client opens.
   *
   * Not `redirect`, though a link exists, and not `payment_element`, though the
   * provider serves the UI. A wallet is its own shape: the buyer must
   * authenticate with someone who is not us and never inside our frame — PayPal
   * refuses to be embedded, and should — but their SDK does it in a popup over
   * the client's page, so the checkout underneath survives.
   *
   * `order` is the provider's reference for the approval, which is what the
   * SDK's `createOrder` must hand back. `client_id` is publishable.
   */
  | {
    type: 'wallet_approval'
    provider: Provider
    client_id: string
    order: string
    currency: Currency
    /** Where to send them if the SDK cannot load at all. */
    approval_url: string
  }
  /**
   * The buyer pays us from their own banking app, into an account the rail
   * generated for this one charge.
   *
   * Nothing to collect and nowhere to send them: the account number *is* the
   * instruction, and a client that can print it needs no page of anybody's.
   * It expires, which is why `expires_at` is carried rather than left implied —
   * a buyer who comes back tomorrow must be told the account is stale rather
   * than paying into a dead one.
   */
  | {
    type: 'transfer'
    account: string
    bank: string
    /** Major units, as the buyer must type it into their banking app. */
    amount: string
    reference: string
    expires_at: string | null
    note: string | null
  }
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
  /**
   * A reusable reference to this buyer's payment method, present only once
   * the rail has actually confirmed the charge — a card is not reusable
   * until it has been used successfully once. `null` on a rail with no
   * saved-method capability (`ProviderCapabilities.supportsSavedPaymentMethod`)
   * and on every mobile money transaction, which has no reusable credential
   * at all: a MoMo charge is a one-time approval push, not a token.
   *
   * The caller persists this onto `deals.metadata` at funding time, which is
   * the only place a split deal's later `chargeSaved` call (the balance +
   * overage charge on return) can read it back from.
   */
  saved_payment_method: string | null
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

/**
 * Charge a payment method saved from an earlier, buyer-present charge on this
 * deal — off-session, with nobody watching. Used for exactly one thing: a
 * split deal's balance (plus any overage), charged the moment a rental is
 * confirmed returned.
 *
 * `token` is `VerifiedTransaction.saved_payment_method` off the deal's own
 * funding — never invented, never taken from a request body. A caller naming
 * its own token would be a caller charging any card it likes.
 */
export interface ChargeSavedRequest {
  token: string
  amount: Money
  currency: Currency
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
  /**
   * Can this adapter save a payment method at charge time and charge it
   * again later, off-session? True for Stripe and Flutterwave cards. Never
   * true for a mobile money charge specifically — see
   * `VerifiedTransaction.saved_payment_method` — which is why this is a rail
   * capability rather than something `chargeSaved`'s presence alone answers:
   * an adapter that serves both cards and MoMo can carry this flag true while
   * still returning a null token for any given MoMo transaction.
   */
  supportsSavedPaymentMethod: boolean
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

  /**
   * Charge a payment method saved from this deal's own funding — a split
   * deal's balance, charged the moment a rental is confirmed returned, and
   * never called until then. Optional the way `validate?` is: PayPal has no
   * adapter for this, and a method every adapter implements but most throw
   * from would be a worse lie than its absence.
   * `ProviderCapabilities.supportsSavedPaymentMethod` is what a caller checks
   * first.
   */
  chargeSaved?(req: ChargeSavedRequest): Promise<{ provider_ref: string }>

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
    supportsSavedPaymentMethod: true,
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
      // A card is reusable; mobile money is not — the same rule a real rail
      // follows, so a demo split deal exercises the identical refusal a
      // MoMo-funded deal gets in production.
      saved_payment_method: req.method === 'card' ? this.ref('fakepm') : null,
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
      saved_payment_method: null,
    })
  }

  release(_req: PayoutRequest): Promise<PayoutResult> {
    return Promise.resolve({ provider_ref: this.ref('faketrf'), status: 'paid' })
  }

  refund(_req: RefundRequest): Promise<{ provider_ref: string }> {
    return Promise.resolve({ provider_ref: this.ref('fakerfnd') })
  }

  chargeSaved(_req: ChargeSavedRequest): Promise<{ provider_ref: string }> {
    return Promise.resolve({ provider_ref: this.ref('fakebal') })
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
      saved_payment_method: null,
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
