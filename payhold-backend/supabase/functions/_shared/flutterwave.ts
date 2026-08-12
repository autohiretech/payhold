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

import forge from 'npm:node-forge@1.3.1'
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
  ValidateChargeRequest,
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

/**
 * Their response envelope.
 *
 * `meta` is a sibling of `data`, not a field inside it, and on a direct charge
 * it is the half that matters: `data` says a charge exists, `meta.authorization`
 * says what the buyer now has to do about it.
 */
interface FlutterwaveEnvelope<T> {
  status?: string
  message?: string
  data?: T
  meta?: {
    authorization?: {
      /** `redirect` | `otp` | `callback` | `pin` | `avs_noauth`. */
      mode?: string
      redirect?: string
      /** Their wording for the buyer. Preferred over ours when present. */
      instruction?: string
      validate_instructions?: string
      note?: string
      /** Bank transfer only: the account they minted for this one charge. */
      transfer_reference?: string
      transfer_account?: string
      transfer_bank?: string
      transfer_amount?: number | string
      account_expiration?: string
      transfer_note?: string
    }
  }
}

/**
 * Encrypt a payload the way this rail's direct endpoints require.
 *
 * 3DES-ECB under the tenant's `encryption_key`, base64, sent as `client`. The
 * algorithm is not a choice — it is what the endpoint accepts — and it is worth
 * being clear that it protects the payload *in transit to the rail* and is not
 * a claim about anything stronger. ECB with a fixed key leaks equality between
 * identical blocks; what makes that tolerable here is that the payload is
 * unique per charge and is already inside TLS.
 *
 * `node-forge` rather than WebCrypto or `node:crypto`, because neither has 3DES
 * in this runtime — `createCipheriv('des-ede3')` answers "Unknown cipher".
 */
function encryptPayload(encryptionKey: string, payload: unknown): string {
  if (!encryptionKey) {
    throw new PayHoldError(
      'policy_violation',
      'This Flutterwave account has no encryption key, so a card cannot be charged directly',
    )
  }

  // 3DES takes a 24-byte key and nothing else, which is the length the rail's
  // dashboard issues. Checked here so a mistyped key is a sentence an operator
  // can act on rather than "Invalid Triple-DES key size" out of a crypto
  // library, thrown mid-charge with a buyer waiting.
  if (encryptionKey.length !== 24) {
    throw new PayHoldError(
      'policy_violation',
      'This Flutterwave encryption key is the wrong length — it must be the ' +
        '24-character key from their dashboard',
    )
  }

  const cipher = forge.cipher.createCipher(
    '3DES-ECB',
    forge.util.createBuffer(encryptionKey),
  )
  cipher.start()
  cipher.update(forge.util.createBuffer(JSON.stringify(payload), 'utf8'))
  cipher.finish()
  return forge.util.encode64(cipher.output.getBytes())
}

/**
 * Which direct mobile money endpoint takes this currency.
 *
 * Flutterwave splits mobile money by country rather than by method, and the
 * split is not cosmetic — the endpoints take different fields and answer with
 * different authorization modes. Keyed on currency because that is what a
 * charge carries; the country is the deal's and does not reach an adapter.
 *
 * A currency missing from here has no direct rail, which is a refusal rather
 * than a fallback: charging it through the hosted page instead would silently
 * put the buyer back on somebody else's checkout, which is the one outcome the
 * direct path exists to avoid.
 */
const MOMO_ENDPOINT: Record<string, string> = {
  RWF: 'mobile_money_rwanda',
  UGX: 'mobile_money_uganda',
  ZMW: 'mobile_money_zambia',
  GHS: 'mobile_money_ghana',
  KES: 'mpesa',
  TZS: 'mobile_money_tanzania',
  XOF: 'mobile_money_franco',
  XAF: 'mobile_money_franco',
}

/**
 * Our network label in Flutterwave's vocabulary.
 *
 * The rails table names wallets the way a buyer would recognise them — "MTN
 * MoMo", "Airtel Money" — and Flutterwave wants the carrier alone, uppercased.
 * Taking the first word is what separates the two, and it is enough for every
 * network in the registry.
 */
function toNetwork(network: string | undefined): string | undefined {
  if (!network) return undefined
  return network.trim().split(/\s+/)[0].toUpperCase()
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

  /**
   * The whole response, not just its `data`.
   *
   * Every call in this adapter but one wants `data` and says so by using
   * `call`. The direct-charge endpoints are the exception: what the buyer must
   * do next lives in `meta.authorization`, a sibling of `data` rather than a
   * field inside it, and a helper that unwrapped it would throw that away
   * before the caller could see it.
   */
  private async envelope<T>(
    path: string,
    init: RequestInit & { idempotencyKey?: string } = {},
  ): Promise<FlutterwaveEnvelope<T>> {
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

    return body as FlutterwaveEnvelope<T>
  }

  private async call<T>(
    path: string,
    init: RequestInit & { idempotencyKey?: string } = {},
  ): Promise<T> {
    const body = await this.envelope<T>(path, init)
    return body.data as T
  }

  // -------------------------------------------------------------------------
  // Collection
  // -------------------------------------------------------------------------

  async charge(req: ChargeRequest): Promise<ChargeResult> {
    // Mobile money is charged directly, because it can be: the only thing the
    // rail needs is a wallet number, and a wallet number is not card data. The
    // buyer approves on their handset, so there is no page anyone has to be
    // sent to and no reason to send them to one.
    if (req.method === 'mobile_money' && req.phone) {
      return await this.chargeMobileMoney(req)
    }

    // A card the tenant collected itself. Gated upstream in `startCharge` — by
    // the time it reaches here the tenant has switched `raw_card_relay` on and
    // taken SAQ D. See `ChargeRequest.card`.
    if (req.method === 'card' && req.card) {
      return await this.chargeCard(req, req.card)
    }

    // Bank transfer needs nothing from the buyer at all, so sending them to a
    // page to collect nothing was always the wrong shape. The rail mints an
    // account and the answer is that account number.
    if (req.method === 'bank_transfer') {
      return await this.chargeBankTransfer(req)
    }

    return await this.chargeHostedPage(req)
  }

  /**
   * The rail's own page — the fallback, and no longer the way in.
   *
   * Every method now has a direct path: a wallet number, a card, or an account
   * to pay into. This is what remains for the cases those cannot serve — a
   * currency with no direct rail, a tenant that has not enabled card relay, or
   * a bank transfer the rail declined to mint an account for.
   */
  private async chargeHostedPage(req: ChargeRequest): Promise<ChargeResult> {
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
      /**
       * Card is offered as an element as well as a link, and the two are the
       * same checkout: Flutterwave's inline script renders the very page
       * `data.link` opens, in an iframe, in whatever page the client is
       * already showing. So the buyer types their card into Flutterwave either
       * way — the difference is only whether the client's own page survives it.
       *
       * Both carry `tx_ref = deal_id`, which is deliberate and is why offering
       * both is safe: they are two doors onto one charge, our webhook matches
       * on that reference, and Flutterwave refuses a second success against a
       * `tx_ref` that already has one. At most one of them can ever complete.
       */
      next_action: req.method === 'card'
        ? {
          type: 'element',
          provider: 'flutterwave',
          public_key: this.creds.public_key,
          reference: req.deal_id,
          amount: req.amount,
          currency: req.currency,
          options: [paymentOptionsFor(req.method)],
          redirect_url: req.return_url,
        }
        : { type: 'redirect', url: data.link },
    }
  }

  /**
   * Charge a wallet directly and report back what the buyer must do.
   *
   * Which of the three that is belongs to the rail and not to us, and it
   * differs by market on the same method: Rwanda answers with a redirect it
   * wants the buyer to see, Uganda and Ghana answer `pending` and push a
   * prompt to the handset, and some networks ask for a code. All three are read
   * off `meta.authorization` rather than assumed, and anything unrecognised is
   * treated as "approve on your phone" — the outcome that needs nothing from
   * the client and cannot strand a buyer in front of a field that will not
   * help them.
   */
  private async chargeMobileMoney(req: ChargeRequest): Promise<ChargeResult> {
    const endpoint = MOMO_ENDPOINT[req.currency]
    if (!endpoint) {
      throw new PayHoldError(
        'policy_violation',
        `Flutterwave has no direct mobile money rail for ${req.currency}`,
      )
    }

    const body = await this.envelope<{ flw_ref?: string; status?: string }>(
      `/charges?type=${endpoint}`,
      {
        method: 'POST',
        idempotencyKey: req.idempotency_key,
        body: JSON.stringify({
          tx_ref: req.deal_id,
          amount: toMajor(req.amount, req.currency),
          currency: req.currency,
          // The same placeholder the hosted path uses. Flutterwave requires an
          // email and PayHold does not hold the buyer's — a deal has a
          // `buyer_ref` belonging to the client, never an address of ours.
          email: `deal-${req.deal_id}@payhold.invalid`,
          phone_number: req.phone,
          network: toNetwork(req.network),
          fullname: 'PayHold buyer',
          redirect_url: req.return_url,
          meta: { deal_id: req.deal_id },
        }),
      },
    )

    const auth = body.meta?.authorization ?? {}
    const flwRef = body.data?.flw_ref ?? ''
    const instruction = auth.instruction ?? auth.validate_instructions ?? auth.note

    if (auth.mode === 'redirect' && auth.redirect) {
      return {
        provider_ref: req.deal_id,
        payment_link: auth.redirect,
        next_action: { type: 'redirect', url: auth.redirect },
      }
    }

    // An OTP with no reference cannot be answered — `validate-charge` is
    // addressed by `flw_ref` and there is nothing else to send. Falling through
    // to the wait state is honest: the charge is real and the webhook will
    // still settle it, which is more than an OTP box that cannot submit.
    if (auth.mode === 'otp' && flwRef) {
      return {
        provider_ref: req.deal_id,
        payment_link: '',
        next_action: {
          type: 'otp',
          reference: flwRef,
          message: instruction ?? 'Enter the code sent to your phone.',
        },
      }
    }

    return {
      provider_ref: req.deal_id,
      payment_link: '',
      next_action: {
        type: 'wait',
        message: instruction ?? 'Approve the payment prompt on your phone.',
      },
    }
  }

  /**
   * Charge a card the tenant collected, and report what the issuer wants next.
   *
   * The rail picks the authorisation model per card, so all four outcomes are
   * live for any buyer: a PIN, a billing address, a 3DS redirect, or nothing.
   * `pin` and `avs_noauth` are answered by calling this *again* with the same
   * details plus an `authorization` block — the rail's design, not ours — which
   * is why they are a request field rather than something cached here. Nothing
   * on this side holds them between calls, and they appear in no log line.
   */
  private async chargeCard(
    req: ChargeRequest,
    card: NonNullable<ChargeRequest['card']>,
  ): Promise<ChargeResult> {
    const payload = {
      card_number: card.number.replace(/\s+/g, ''),
      cvv: card.cvv,
      expiry_month: card.expiry_month,
      expiry_year: card.expiry_year,
      currency: req.currency,
      amount: toMajor(req.amount, req.currency),
      email: card.email ?? `deal-${req.deal_id}@payhold.invalid`,
      fullname: card.name ?? 'PayHold buyer',
      tx_ref: req.deal_id,
      redirect_url: req.return_url,
      // Answering a PIN or address demand means resending everything with the
      // extra factor alongside. Absent on the first call.
      ...(req.authorization ? { authorization: req.authorization } : {}),
    }

    const body = await this.envelope<{ flw_ref?: string; status?: string }>(
      '/charges?type=card',
      {
        method: 'POST',
        // Per attempt, not per deal. A continuation carries the same tx_ref, so
        // `charge:${deal_id}` alone would make the rail replay the first
        // response and ask the buyer for the same PIN forever.
        idempotencyKey: `${req.idempotency_key}:${req.attempt ?? 0}`,
        body: JSON.stringify({
          client: encryptPayload(this.creds.encryption_key, payload),
        }),
      },
    )

    const auth = body.meta?.authorization ?? {}
    const flwRef = body.data?.flw_ref ?? ''
    const instruction = auth.instruction ?? auth.validate_instructions ?? auth.note

    if (auth.mode === 'pin') {
      return {
        provider_ref: req.deal_id,
        payment_link: '',
        next_action: { type: 'pin', message: instruction ?? 'Enter the PIN for this card.' },
      }
    }

    if (auth.mode === 'avs_noauth') {
      return {
        provider_ref: req.deal_id,
        payment_link: '',
        next_action: {
          type: 'avs',
          message: instruction ?? 'Enter the billing address for this card.',
          fields: ['address', 'city', 'state', 'zipcode', 'country'],
        },
      }
    }

    // 3DS. The issuer's page rather than the rail's — nobody can render that
    // inline, and handing a buyer to their own bank is the one correct handoff.
    if (auth.mode === 'redirect' && auth.redirect) {
      return {
        provider_ref: req.deal_id,
        payment_link: auth.redirect,
        next_action: { type: 'redirect', url: auth.redirect },
      }
    }

    if (auth.mode === 'otp' && flwRef) {
      return {
        provider_ref: req.deal_id,
        payment_link: '',
        next_action: {
          type: 'otp',
          reference: flwRef,
          message: instruction ?? 'Enter the code sent to your phone.',
        },
      }
    }

    return {
      provider_ref: req.deal_id,
      payment_link: '',
      next_action: {
        type: 'wait',
        message: instruction ?? 'Payment submitted — waiting for your bank to confirm.',
      },
    }
  }

  /**
   * Ask the rail for an account the buyer can pay into.
   *
   * The one method where a hosted page was pure overhead: there is nothing to
   * collect and nothing to authorise, so the page existed only to print an
   * account number that the rail hands us directly. A client that can render
   * six fields never needs to send anyone anywhere.
   *
   * The account is per charge and expires. That expiry is carried through
   * rather than dropped, because a buyer returning to a stale account would pay
   * money into a number that no longer maps to their booking.
   */
  private async chargeBankTransfer(req: ChargeRequest): Promise<ChargeResult> {
    const body = await this.envelope<{ flw_ref?: string; status?: string }>(
      '/charges?type=bank_transfer',
      {
        method: 'POST',
        idempotencyKey: req.idempotency_key,
        body: JSON.stringify({
          tx_ref: req.deal_id,
          amount: toMajor(req.amount, req.currency),
          currency: req.currency,
          email: `deal-${req.deal_id}@payhold.invalid`,
          fullname: 'PayHold buyer',
          ...(req.phone ? { phone_number: req.phone } : {}),
          // A fresh account per charge, not a permanent one for the buyer. A
          // permanent account cannot tell two bookings apart when the same
          // person pays for both.
          is_permanent: false,
        }),
      },
    )

    const auth = body.meta?.authorization ?? {}

    // No account means the rail could not mint one — a currency it does not do
    // transfers in, most often. Falling back to the hosted page is honest here:
    // it is the only remaining way this buyer can pay by bank.
    if (!auth.transfer_account || !auth.transfer_bank) {
      return await this.chargeHostedPage(req)
    }

    return {
      provider_ref: req.deal_id,
      payment_link: '',
      next_action: {
        type: 'transfer',
        account: auth.transfer_account,
        bank: auth.transfer_bank,
        // Their figure when they give one — they decide the exact amount, and
        // a transfer that is a franc out does not match.
        amount: String(auth.transfer_amount ?? toMajor(req.amount, req.currency)),
        reference: auth.transfer_reference ?? req.deal_id,
        expires_at: auth.account_expiration ?? null,
        note: auth.transfer_note && auth.transfer_note !== 'N/A' ? auth.transfer_note : null,
      },
    }
  }

  /**
   * Answer a code the rail asked for.
   *
   * A correct code is not necessarily the end — Flutterwave may follow it with
   * a redirect, or with another code — so this reads `meta.authorization` again
   * exactly as the charge did rather than assuming success. What it never does
   * is report the money as held: that is the webhook's, after it re-fetches the
   * transaction (§15 phase 2), and nothing in this file can shortcut it.
   */
  async validate(req: ValidateChargeRequest): Promise<ChargeResult> {
    const body = await this.envelope<{ flw_ref?: string; tx_ref?: string; status?: string }>(
      '/validate-charge',
      {
        method: 'POST',
        body: JSON.stringify({
          otp: req.otp,
          flw_ref: req.reference,
          type: req.method === 'card' ? 'card' : 'mobile_money',
        }),
      },
    )

    const auth = body.meta?.authorization ?? {}
    const flwRef = body.data?.flw_ref ?? req.reference
    const provider_ref = body.data?.tx_ref ?? ''

    if (auth.mode === 'redirect' && auth.redirect) {
      return {
        provider_ref,
        payment_link: auth.redirect,
        next_action: { type: 'redirect', url: auth.redirect },
      }
    }

    if (auth.mode === 'otp' && flwRef) {
      return {
        provider_ref,
        payment_link: '',
        next_action: {
          type: 'otp',
          reference: flwRef,
          message: auth.instruction ?? 'That code was not accepted. Try the new one.',
        },
      }
    }

    return {
      provider_ref,
      payment_link: '',
      next_action: {
        type: 'wait',
        message: body.message ?? 'Payment submitted — waiting for your provider to confirm.',
      },
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
      charged_amount?: number
      currency: string
      status: string
      payment_type?: string
      card?: { type?: string }
      /**
       * What Flutterwave charged us for this collection. `amount_settled` is the
       * amount that actually landed in the merchant balance, so the fee is
       * `charged_amount − amount_settled` — the only figure the reconciliation
       * pass can check our ledger against. `app_fee` is what Flutterwave reports
       * it charged, and can exclude VAT or test-mode differences, so it is the
       * fallback rather than the source of truth.
       */
      app_fee?: number
      amount_settled?: number
    }>(`/transactions/verify_by_reference?tx_ref=${encodeURIComponent(providerRef)}`)

    // §7's provider fee, in the same currency as the amount. Prefer the settled
    // amount (what the wallet actually holds) over the reported `app_fee`; fall
    // back to `app_fee` when settlement is not present, and to zero only when
    // there is genuinely nothing to read. Booking a guess would put the ledger
    // out by the difference and the reconciliation pass reads that as drift —
    // which freezes the tenant.
    const charged = data.charged_amount ?? data.amount
    const fee = data.amount_settled != null && charged != null
      ? toMinor(charged - data.amount_settled, data.currency)
      : data.app_fee
        ? toMinor(data.app_fee, data.currency)
        : 0

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
      fee,
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
    const data = await this.call<
      {
        currency: string
        available_balance?: number
        ledger_balance?: number
        reserved_balance?: number
      }[]
    >('/balances')
    return data.map((b) => ({
      currency: b.currency,
      // Everything the wallet still holds, not only what is spendable this
      // instant. Settled funds sit in `ledger_balance` until settlement moves
      // them into `available_balance`, and the reconciliation cron compares
      // against everything the ledger expects the provider to be holding.
      // Reading `available_balance` alone reported a funded wallet as empty and
      // froze its payouts on the first pass.
      amount: toMinor(b.ledger_balance ?? b.available_balance ?? 0, b.currency),
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
