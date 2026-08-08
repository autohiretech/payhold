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
  /** Where the provider returns the buyer once they have paid. */
  return_url: string
  /**
   * Card charges request 3DS — spec §6. Providers that cannot honour it for a
   * given method ignore it; providers that can MUST NOT silently downgrade.
   */
  three_d_secure: boolean
  idempotency_key: string
}

export interface ChargeResult {
  /** The provider's own reference. Becomes `deals.provider_ref`. */
  provider_ref: string
  /** Where to send the buyer to complete payment. */
  payment_link: string
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
