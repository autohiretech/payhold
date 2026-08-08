/**
 * FlutterwaveProvider — the launch rail.
 *
 * Cards, MTN MoMo and Airtel Money for collection; Transfers API to tokenized
 * beneficiaries for payout. This is the only rail that can pay a Rwandan
 * seller, which is why `African payouts always ride Flutterwave` is a
 * structural rule and not a preference.
 *
 * Credentials are per tenant (bring-your-own-keys): the caller decrypts a row
 * from `tenant_provider_accounts` and constructs this with them. Nothing here
 * reads the environment — a provider instance that could fall back to platform
 * keys would silently collect one tenant's money into another's balance.
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

const API = 'https://api.flutterwave.com/v3'

export interface FlutterwaveCredentials {
  /** `FLWSECK_TEST-…` or `FLWSECK-…`. The one that must never leave the server. */
  secret_key: string
  /** `FLWPUBK…`. Safe to expose; used by their inline checkout. */
  public_key: string
  /** Encrypts card payloads for their direct-charge endpoints. */
  encryption_key: string
  /** The `verif-hash` value configured on their webhook settings page. */
  webhook_hash: string
}

/**
 * Flutterwave quotes amounts in MAJOR units ("1500.50"), PayHold stores minor.
 *
 * Zero-decimal currencies are the trap: RWF 1000 is 1000 francs, not 10.00, so
 * a blanket divide-by-100 would collect a hundredth of the intended amount on
 * the launch market. This list is the ISO-4217 set of zero-decimal currencies
 * Flutterwave transacts in.
 */
const ZERO_DECIMAL = new Set(['RWF', 'UGX', 'XOF', 'XAF', 'BIF', 'DJF', 'GNF', 'KMF', 'VUV', 'JPY', 'KRW'])

export function toMajor(minor: Money, currency: Currency): number {
  return ZERO_DECIMAL.has(currency) ? minor : minor / 100
}

export function toMinor(major: number, currency: Currency): Money {
  return Math.round(ZERO_DECIMAL.has(currency) ? major : major * 100)
}

/** Their payment_type vocabulary, mapped to ours. */
function toMethod(paymentType: string | null | undefined): PaymentMethod | null {
  if (!paymentType) return null
  const t = paymentType.toLowerCase()
  if (t.includes('card')) return 'card'
  if (t.includes('mobile') || t.includes('momo')) return 'mobile_money'
  if (t.includes('bank') || t.includes('account') || t.includes('transfer')) {
    return 'bank_transfer'
  }
  return null
}

export class FlutterwaveProvider implements PaymentProvider {
  readonly name = 'flutterwave' as const

  /**
   * §9. Unverified like every other rail claim in this repository — see
   * `RAILS_VERIFIED`. These describe what Flutterwave's documentation says the
   * API can do, not what a signed agreement confirms our account may do, and
   * §16 requires the second before any of it carries live money.
   */
  readonly capabilities: ProviderCapabilities = {
    supportsCapture: true,
    supportsPartialRefund: true,
    // Transfers API to tokenized beneficiaries.
    supportsMarketplacePayout: true,
    supportsSellerOnboarding: false,
    supportsDispute: false,
    supportsLocalCurrency: true,
    supportsMobileMoney: true,
    // Transfers and refunds settle out of band; the webhook is what confirms.
    supportsAsyncRefund: true,
  }

  constructor(
    private readonly creds: FlutterwaveCredentials,
    private readonly publicUrl: string,
  ) {}

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  private async call<T>(
    path: string,
    init: RequestInit & { idempotencyKey?: string } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.creds.secret_key}`,
      'content-type': 'application/json',
    }
    // Their retry semantics: the same key returns the original result rather
    // than performing the action twice.
    if (init.idempotencyKey) headers['idempotency-key'] = init.idempotencyKey

    const res = await fetch(`${API}${path}`, { ...init, headers })
    const body = await res.json().catch(() => ({}))

    if (!res.ok || body.status === 'error') {
      // Their message is safe to surface — it is about the request, not about
      // our credentials.
      throw new PayHoldError(
        res.status === 401 ? 'unauthorized' : 'policy_violation',
        `Flutterwave: ${body.message ?? res.statusText}`,
      )
    }

    return body.data as T
  }

  // -------------------------------------------------------------------------
  // Collection
  // -------------------------------------------------------------------------

  async charge(req: ChargeRequest): Promise<ChargeResult> {
    // A hosted payment link rather than a direct charge: it keeps card data
    // entirely off PayHold's infrastructure, which is what lets §6's "never
    // stores raw card numbers" be structurally true rather than a promise.
    const data = await this.call<{ link: string }>('/payments', {
      method: 'POST',
      idempotencyKey: req.idempotency_key,
      body: JSON.stringify({
        tx_ref: req.deal_id,
        amount: toMajor(req.amount, req.currency),
        currency: req.currency,
        redirect_url: req.return_url,
        payment_options: paymentOptionsFor(req.method),
        // 3DS is requested on every card charge — §6. Flutterwave decides
        // per-issuer whether it is enforced; we never ask it not to be.
        authorization: req.three_d_secure ? { mode: 'redirect' } : undefined,
        customer: { email: `deal-${req.deal_id}@payhold.invalid` },
        meta: { deal_id: req.deal_id, network: req.network },
      }),
    })

    return {
      // tx_ref is ours and is what their webhook echoes; their own id only
      // exists after the buyer pays, so it cannot be the reference we store now.
      provider_ref: req.deal_id,
      payment_link: data.link,
    }
  }

  /**
   * The re-verify half of §6.
   *
   * A webhook says something happened; this asks Flutterwave directly what
   * actually happened. The webhook body's amounts are never trusted, because
   * anyone can POST a webhook body.
   */
  async verify(providerRef: string): Promise<VerifiedTransaction> {
    const data = await this.call<{
      id: number
      amount: number
      currency: string
      status: string
      payment_type?: string
      card?: { type?: string }
      /** What Flutterwave charged us for this collection. */
      app_fee?: number
    }>(`/transactions/verify_by_reference?tx_ref=${encodeURIComponent(providerRef)}`)

    return {
      provider_ref: providerRef,
      amount: toMinor(data.amount, data.currency),
      currency: data.currency,
      status: data.status === 'successful'
        ? 'successful'
        : data.status === 'failed'
        ? 'failed'
        : 'pending',
      method: toMethod(data.payment_type),
      network: data.card?.type ?? null,
      // §7's provider fee, in the same currency as the amount. Absent on some
      // responses; zero is the honest reading, because booking a guess would
      // put the ledger out by the difference and the reconciliation pass reads
      // that as drift.
      fee: data.app_fee ? toMinor(data.app_fee, data.currency) : 0,
    }
  }

  // -------------------------------------------------------------------------
  // Payout
  // -------------------------------------------------------------------------

  async release(req: PayoutRequest): Promise<PayoutResult> {
    // The beneficiary token stands in for the destination — PayHold never
    // holds the MoMo number itself.
    const data = await this.call<{ id: number; status: string }>('/transfers', {
      method: 'POST',
      idempotencyKey: req.idempotency_key,
      body: JSON.stringify({
        beneficiary: Number(req.beneficiary_token),
        amount: toMajor(req.amount, req.currency),
        currency: req.currency,
        reference: req.payout_id,
        narration: 'PayHold settlement',
      }),
    })

    return {
      provider_ref: String(data.id),
      // Transfers settle asynchronously. Anything not already terminal stays
      // pending until their transfer webhook confirms it — booking it as paid
      // here would credit a payout that can still fail.
      status: data.status === 'SUCCESSFUL' ? 'paid' : 'pending',
    }
  }

  async refund(req: RefundRequest): Promise<{ provider_ref: string }> {
    const tx = await this.call<{ id: number }>(
      `/transactions/verify_by_reference?tx_ref=${encodeURIComponent(req.provider_ref)}`,
    )
    const data = await this.call<{ id: number }>(`/transactions/${tx.id}/refund`, {
      method: 'POST',
      idempotencyKey: req.idempotency_key,
      body: JSON.stringify({ amount: toMajor(req.amount, req.currency) }),
    })
    return { provider_ref: String(data.id) }
  }

  // -------------------------------------------------------------------------
  // Card pre-auth deposits
  // -------------------------------------------------------------------------

  async preauth(req: PreauthRequest): Promise<ChargeResult> {
    const data = await this.call<{ link: string }>('/payments', {
      method: 'POST',
      idempotencyKey: req.idempotency_key,
      body: JSON.stringify({
        tx_ref: `${req.deal_id}-deposit`,
        amount: toMajor(req.amount, req.currency),
        currency: req.currency,
        redirect_url: req.return_url,
        payment_options: 'card',
        // Holds the funds without taking them. The capture call decides how
        // much is actually taken, up to this amount.
        preauthorize: true,
        customer: { email: `deal-${req.deal_id}@payhold.invalid` },
        meta: { deal_id: req.deal_id, kind: 'deposit' },
      }),
    })

    return { provider_ref: `${req.deal_id}-deposit`, payment_link: data.link }
  }

  async capture(providerRef: string, amount: Money): Promise<{ provider_ref: string }> {
    const tx = await this.call<{ id: number; currency: string }>(
      `/transactions/verify_by_reference?tx_ref=${encodeURIComponent(providerRef)}`,
    )
    const data = await this.call<{ id: number }>(`/charges/${tx.id}/capture`, {
      method: 'POST',
      body: JSON.stringify({ amount: toMajor(amount, tx.currency) }),
    })
    return { provider_ref: String(data.id) }
  }

  // -------------------------------------------------------------------------
  // Beneficiaries and balances
  // -------------------------------------------------------------------------

  async tokenize(req: TokenizeRequest): Promise<TokenizeResult> {
    const data = await this.call<{ id: number; account_number: string; bank_name?: string }>(
      '/beneficiaries',
      {
        method: 'POST',
        body: JSON.stringify({
          account_number: req.destination,
          account_bank: req.currency === 'RWF' ? 'MPS' : undefined,
          currency: req.currency,
          beneficiary_name: 'PayHold seller',
        }),
      },
    )

    const tail = req.destination.replace(/\D/g, '').slice(-4).padStart(4, '0')
    return {
      beneficiary_token: String(data.id),
      // What we persist. The full number stays with Flutterwave.
      masked_destination: `${data.bank_name ?? 'Mobile money'} •••• ${tail}`,
    }
  }

  async balances(): Promise<{ currency: Currency; amount: Money }[]> {
    const data = await this.call<{ currency: string; available_balance: number }[]>(
      '/balances',
    )
    return data.map((b) => ({
      currency: b.currency,
      amount: toMinor(b.available_balance, b.currency),
    }))
  }

  // -------------------------------------------------------------------------
  // Webhook signature
  // -------------------------------------------------------------------------

  /**
   * Flutterwave sends the configured secret verbatim in `verif-hash`. It is a
   * shared secret, not an HMAC over the body — so it proves the sender knows
   * the secret and nothing about the payload, which is exactly why §6 also
   * demands a re-verify against their API before any state changes.
   */
  verifySignature(_rawBody: string, headers: Headers): boolean {
    const presented = headers.get('verif-hash')
    if (!presented || !this.creds.webhook_hash) return false

    // Constant-time compare: a plain === leaks the secret's prefix over enough
    // forged requests.
    if (presented.length !== this.creds.webhook_hash.length) return false
    let diff = 0
    for (let i = 0; i < presented.length; i++) {
      diff |= presented.charCodeAt(i) ^ this.creds.webhook_hash.charCodeAt(i)
    }
    return diff === 0
  }
}

function paymentOptionsFor(method: PaymentMethod): string {
  switch (method) {
    case 'card':
      return 'card'
    case 'mobile_money':
      // Their market-specific channel names. Offering all of them lets one
      // link serve MTN and Airtel across the launch markets.
      return 'mobilemoneyrwanda,mobilemoneyghana,mobilemoneyuganda,mobilemoneyzambia,mpesa'
    case 'bank_transfer':
      return 'banktransfer,account'
    case 'wallet':
      // §9's wallet rails are PayPal's, Stripe's and a China partner's — none
      // of them Flutterwave's. Routing should never have sent this here, and
      // failing loudly beats quietly offering a card to somebody who chose a
      // wallet, which is the same refusal `StripeProvider` makes for mobile
      // money in the opposite direction.
      throw new PayHoldError(
        'policy_violation',
        'Flutterwave cannot collect a wallet payment',
      )
  }
}

/**
 * Confirm a credential set actually works before it is stored.
 *
 * Storing unvalidated keys means the failure surfaces at the first real
 * charge, in front of a buyer. `/balances` is the cheapest authenticated call
 * that proves the secret key is live and has the right permissions.
 */
export async function validateFlutterwaveCredentials(
  creds: FlutterwaveCredentials,
): Promise<{ ok: true; currencies: Currency[] } | { ok: false; reason: string }> {
  try {
    const provider = new FlutterwaveProvider(creds, '')
    const balances = await provider.balances()
    return { ok: true, currencies: balances.map((b) => b.currency) }
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof PayHoldError ? err.message : 'Could not reach Flutterwave',
    }
  }
}
