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
  ChargeSavedRequest,
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
import { momoBankCode, normalizeMsisdn } from './momo.ts'
import { PayHoldError, type Currency, type Money, type PaymentMethod } from './types.ts'

const API = 'https://api.flutterwave.com/v3'

/**
 * Flutterwave's Transfers API can be put behind IP whitelisting on their
 * side, and Supabase Edge Functions have no static egress IP to give it —
 * every invocation can leave from a different address, so whitelisting one
 * IP whitelists nothing. `FLUTTERWAVE_PROXY_URL` is the documented way
 * around that: an outbound proxy with its own fixed IP (QuotaGuard and
 * similar services sell exactly this), whitelisted with Flutterwave instead
 * of us. This is platform network configuration, not a tenant credential —
 * unlike `StripeCredentials`/`FlutterwaveCredentials` above, which this file
 * deliberately never reads from the environment, a proxy is how *every*
 * tenant's calls leave the building, not a fallback that could cross tenants.
 *
 * Opt-in and unverified: `Deno.createHttpClient` is the API Supabase's own
 * integration guides document for this, but Supabase's Edge Runtime is not
 * vanilla Deno Deploy and has been known to restrict Deno-namespace APIs
 * without notice. If it throws, every Flutterwave call falls back to a
 * plain `fetch` — the same (broken, unwhitelisted) behavior as today — rather
 * than taking the whole rail down over a transport feature nobody has
 * configured yet. Whoever sets `FLUTTERWAVE_PROXY_URL` should watch the first
 * real transfer after doing so; this has not been exercised against a live
 * proxy.
 */
let flutterwaveHttpClient: Deno.HttpClient | null | undefined

/**
 * `FLUTTERWAVE_PROXY_URL` as `Deno.createHttpClient` wants it.
 *
 * The operator sets the URL in the shape every proxy vendor prints —
 * `http://user:pass@host:port` — and it used to be handed to Deno whole.
 * Deno documents `Deno.Proxy` as a `url` **plus** a separate
 * `basicAuth: { username, password }` (https://docs.deno.com/api/deno/~/Deno.Proxy),
 * and nothing in that documentation promises that credentials embedded in the
 * URL are read out of it. QuotaGuard's own Supabase Edge Functions guide
 * parses them out and passes `basicAuth` on the side for exactly this reason
 * (https://www.quotaguard.com/docs/integration/platforms/supabase-edge-functions-integration-guide/).
 * A proxy that ignores the embedded credentials answers 407 to every call,
 * which `envelope` would report as `Flutterwave: Proxy Authentication
 * Required` — a stuck payout with the wrong vendor's name on it.
 *
 * So the credentials are split off here. `URL.username`/`URL.password` come
 * back percent-encoded exactly as written, and a password containing `@` or
 * `#` *had* to be encoded to fit in the URL at all, so both are decoded before
 * they are used as the literal Basic-auth value. The `url` handed on is
 * `protocol//host` only — no path, no trailing slash, and above all no
 * credentials, so the one string that could later appear in an error message
 * cannot carry them.
 *
 * Exported for the test; this is the parsing that decides whether a live
 * proxy is used or silently bypassed, and it needs pinning.
 */
export function proxyConfig(
  proxyUrl: string,
): { url: string; basicAuth?: { username: string; password: string } } {
  const u = new URL(proxyUrl)
  // `new URL('flutterwave-proxy:s3cret@host:3128')` — the string with its
  // scheme forgotten — does not throw; it parses as an opaque URL whose scheme
  // is the username. Only the transports Deno's proxy actually speaks are
  // accepted, and each needs a host, so that mistake fails here with the
  // fixed log line in `flutterwaveClient` rather than inside Deno with a
  // message that might quote it.
  if (!['http:', 'https:', 'socks5:'].includes(u.protocol) || !u.host) {
    throw new TypeError('proxy URL must be http://, https:// or socks5:// with a host')
  }
  const url = `${u.protocol}//${u.host}`
  if (!u.username && !u.password) return { url }
  return {
    url,
    basicAuth: {
      username: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
    },
  }
}

function flutterwaveClient(): Deno.HttpClient | undefined {
  if (flutterwaveHttpClient !== undefined) return flutterwaveHttpClient ?? undefined

  const proxyUrl = Deno.env.get('FLUTTERWAVE_PROXY_URL')
  if (!proxyUrl) {
    flutterwaveHttpClient = null
    return undefined
  }

  // Parsed in its own step, because `new URL()` quotes its input back in the
  // error it throws — and the input is the one string in this process that
  // holds the proxy password. Nothing from that failure reaches a log line
  // except the fact of it.
  let proxy: ReturnType<typeof proxyConfig>
  try {
    proxy = proxyConfig(proxyUrl)
  } catch {
    console.error(
      'FLUTTERWAVE_PROXY_URL is set but is not a URL of the form ' +
        "http://user:pass@host:port — falling back to a direct connection, which Flutterwave's " +
        'IP whitelist will keep refusing.',
    )
    flutterwaveHttpClient = null
    return undefined
  }

  try {
    // deno-lint-ignore no-explicit-any
    flutterwaveHttpClient = (Deno as any).createHttpClient({ proxy })
  } catch (err) {
    // `proxy.url` carries no credentials by construction (see `proxyConfig`),
    // so whatever Deno says about it is safe to print.
    console.error(
      'FLUTTERWAVE_PROXY_URL is set but Deno.createHttpClient is unavailable in this ' +
        "runtime — falling back to a direct connection, which Flutterwave's IP whitelist " +
        'will keep refusing.',
      err instanceof Error ? err.message : err,
    )
    flutterwaveHttpClient = null
  }
  return flutterwaveHttpClient ?? undefined
}

/**
 * `amount_settled` can lag a transaction's own success the same way Stripe's
 * balance transaction does — see the identical constants and reasoning in
 * `stripe.ts`'s `resolveProviderFee`. `verify` retries this many times,
 * `PROVIDER_FEE_RETRY_DELAY_MS` apart, before accepting whatever it has.
 */
const PROVIDER_FEE_RETRIES = 3
const PROVIDER_FEE_RETRY_DELAY_MS = 1000

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

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

/**
 * What makes a sandbox transfer settle at all.
 *
 * Flutterwave's test environment never settles a transfer on its own:
 * https://developer.flutterwave.com/v3.0/docs/testing says a mocked transfer
 * "will always remain in a PENDING state" by default, and to mock a
 * successful one the `reference` must end with `_PMCK`. `DU_{minutes}`
 * appended after it sets how long the mock waits — their own example,
 * `dfs23fhr7ntg0293039_PMCKDU_1`, succeeds after one minute where the bare
 * `_PMCK` takes ten. One minute is the difference between a person running
 * `scripts/sandbox-walkthrough.md` watching the payout land and giving up on
 * it, and nothing else about the mock changes with the delay.
 *
 * Until this existed every sandbox payout went `processing` and stayed there:
 * `release` sent the bare payout id, the sandbox left it `PENDING` forever,
 * `transferStatus` faithfully answered `pending` on every pass, and
 * `walkthrough_money_path` could never be signed off — not because anything
 * was wrong, but because the sandbox had never been told to pretend.
 *
 * Only the *success* marker is used. Their failure marker (`_PMCK_ST_F`) is
 * for testing the failure path by hand, not something this adapter should
 * ever pick on its own.
 */
const SANDBOX_SETTLE_SUFFIX = '_PMCKDU_1'

/**
 * The `reference` a transfer is created under. Our own `payouts.id`, and in
 * test mode only, `SANDBOX_SETTLE_SUFFIX` behind it.
 *
 * Live is the bare id and nothing else, and the branch is written so that is
 * the case that needs no reasoning: a live transfer carrying a mock-settle
 * marker would be a request to real money to behave like test money, and
 * whatever Flutterwave's live API does with an unknown suffix, the payout row
 * would then be found by a reference that is not its id.
 *
 * Deterministic in the payout id — same payout, same mode, same reference on
 * every attempt — which is what keeps `dispatchPayout`'s retry reasoning true:
 * a re-sent `release` (only ever after a *failed* attempt, since a
 * `processing` transfer is asked about by id, never re-POSTed) presents the
 * reference and the `idempotency_key` the rail already saw.
 */
export function transferReference(payoutId: string, mode: 'test' | 'live'): string {
  if (mode === 'test') return `${payoutId}${SANDBOX_SETTLE_SUFFIX}`
  return payoutId
}

/**
 * A seller's name as Flutterwave's M-Pesa transfer wants it: two fields.
 *
 * Split on the first run of whitespace — "Akinyi Kimwei" is `Akinyi` /
 * `Kimwei`, "Jean de Dieu Habimana" is `Jean` / `de Dieu Habimana`. A single
 * word fills both, because both fields are required and a person with one
 * name is still a person the rail must pay. Nothing to split is `null`, and
 * the caller refuses: inventing a name for a transfer is the one thing this
 * must never do.
 *
 * Exported for the test.
 */
export function splitBeneficiaryName(
  name: string | undefined,
): { first_name: string; last_name: string } | null {
  const trimmed = (name ?? '').trim().replace(/\s+/g, ' ')
  if (!trimmed) return null
  const space = trimmed.indexOf(' ')
  if (space === -1) return { first_name: trimmed, last_name: trimmed }
  return { first_name: trimmed.slice(0, space), last_name: trimmed.slice(space + 1) }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The payout id inside a transfer `reference` Flutterwave sends back, or null.
 *
 * The inverse of `transferReference`, for `flutterwave-webhook`: a `transfer.*`
 * event carries the reference we created the transfer under, and in the
 * sandbox that is the payout id with the settle marker behind it. Anything
 * from `_PMCK` onward is stripped — the delay modifier varies, and their
 * failure marker shares the prefix — and what remains must be a uuid, or the
 * event is not ours. The uuid check is what stops a reference somebody else
 * chose from being used as a row id in a query.
 */
export function payoutIdFromTransferReference(reference: string): string | null {
  const bare = reference.replace(/_PMCK.*$/, '')
  return UUID.test(bare) ? bare : null
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
    // Card only, and only once a charge has actually verified — see
    // `verify()`. A MoMo transaction never carries a token, whatever this
    // flag says: there is no reusable credential a mobile money charge
    // produces, only a one-time approval push.
    supportsSavedPaymentMethod: true,
  }

  constructor(
    private readonly creds: FlutterwaveCredentials,
    private readonly publicUrl: string,
    /**
     * Whether these credentials are a sandbox account or a live one, as
     * `tenant_provider_accounts.mode` records it. `loadProvider` is the one
     * caller that knows, so it is passed in rather than inferred here from the
     * `FLWSECK_TEST-` prefix — two places deciding the same fact is how they
     * come to disagree, and `provider-accounts` already refuses a key whose
     * prefix contradicts the mode it was submitted under.
     *
     * The only thing it changes is the transfer `reference` `release` sends —
     * see `transferReference`. Required rather than defaulted, because a
     * default of `live` would leave the sandbox quietly unable to settle and a
     * default of `test` would put a mock-settle marker on real money.
     */
    private readonly mode: 'test' | 'live',
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

    const client = flutterwaveClient()
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers,
      ...(client ? { client } : {}),
    })
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
    type VerifyResponse = {
      id: number
      amount: number
      charged_amount?: number
      currency: string
      status: string
      payment_type?: string
      /**
       * `token` is present only when tokenization is switched on for this
       * Flutterwave account and this transaction was a card — never for
       * mobile money, which has no equivalent. Read into
       * `VerifiedTransaction.saved_payment_method` below. **Unverified
       * against Flutterwave's own current documentation** — confirm the
       * exact field name before this carries live money.
       */
      card?: { type?: string; token?: string }
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
    }

    // `amount_settled` can lag a transaction's own success the same way
    // Stripe's balance transaction does — Flutterwave settles asynchronously,
    // and a webhook re-verified faster than that lands here with
    // `amount_settled` still absent. The old code fell back to `app_fee`
    // immediately in that case, which the field comment above already says
    // "can exclude VAT" — and a Nigerian-issued card charges 7.5% VAT on top
    // of the 3.8% fee, so that fallback silently under-booked by the VAT
    // every time it fired. Confirmed live: a deal whose booked provider_fee
    // was exactly 3.8% of the charge, to the rand, with no VAT component at
    // all. Retried the same bounded way `stripe.ts` retries its own fee read.
    let data = await this.call<VerifyResponse>(
      `/transactions/verify_by_reference?tx_ref=${encodeURIComponent(providerRef)}`,
    )
    for (
      let attempt = 1;
      attempt < PROVIDER_FEE_RETRIES && data.amount_settled == null;
      attempt++
    ) {
      await delay(PROVIDER_FEE_RETRY_DELAY_MS)
      data = await this.call<VerifyResponse>(
        `/transactions/verify_by_reference?tx_ref=${encodeURIComponent(providerRef)}`,
      )
    }

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
      saved_payment_method: data.status === 'successful' ? data.card?.token ?? null : null,
    }
  }

  // -------------------------------------------------------------------------
  // Payout
  // -------------------------------------------------------------------------

  async release(req: PayoutRequest): Promise<PayoutResult> {
    // Read before the transfer is sent, so a corridor whose extra facts we
    // cannot supply refuses here — with nothing at the rail — rather than
    // after a POST the rail then rejects.
    const meta = await this.transferMeta(req)

    // The beneficiary token stands in for the destination — PayHold never
    // holds the MoMo number itself.
    const data = await this.call<{ id: number; status: string }>('/transfers', {
      method: 'POST',
      idempotencyKey: req.idempotency_key,
      body: JSON.stringify({
        beneficiary: Number(req.beneficiary_token),
        amount: toMajor(req.amount, req.currency),
        currency: req.currency,
        // Our own `payouts.id`, which is how their `transfer.*` webhook finds
        // the payout again — plus, in the sandbox only, the marker that makes
        // the mock settle. See `transferReference`.
        reference: transferReference(req.payout_id, this.mode),
        narration: 'PayHold settlement',
        // Absent on every corridor that does not demand it. A key carrying
        // `undefined` is dropped by `JSON.stringify`, but saying so is clearer
        // than relying on it.
        ...(meta ? { meta } : {}),
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

  /**
   * The `meta` block a transfer on this corridor must carry, or nothing.
   *
   * Kenya M-Pesa is the one corridor in the table that wants more than a
   * beneficiary and an amount. Their create-a-transfer reference
   * (developer.flutterwave.com/v3.0.0/reference/create-a-transfer, read
   * 2026-09-09) marks five `meta` fields "required for … M-Pesa transfers":
   * `sender` and `sender_country` describe the **sender**, and `first_name`,
   * `last_name` and `mobile_number` describe the **beneficiary**. Their
   * mobile-money guide summarises `mobile_number` as the sender's; the
   * reference — the schema the API is generated from — says beneficiary, and
   * is what this follows. Until this existed `release` sent no `meta` at all,
   * so every KES wallet payout was refused at the rail with the buyer's money
   * already collected.
   *
   * `meta` is an **array** of one object on a transfer. Their charge endpoints
   * take a plain object (see `preauth`), and the Kenya guide's own example
   * shows the array — the two endpoints differ, and this is the transfer.
   *
   * The beneficiary's number is not stored on our side — CLAUDE.md forbids a
   * raw destination in any column — so it is read back from the rail's own
   * record of the beneficiary we registered, which is where it has been since
   * `tokenize`. That is one extra GET on this corridor only, and it is the
   * whole reason `release` can honour the requirement without PayHold ever
   * holding the number.
   */
  private async transferMeta(
    req: PayoutRequest,
  ): Promise<Record<string, string>[] | undefined> {
    if (req.rail !== 'flutterwave_momo' || req.currency.toUpperCase() !== 'KES') {
      return undefined
    }

    // Refused with the gap named. `dispatchPayout` records this sentence on
    // the payout and retries later, which is the right shape: the fix is a
    // fact about the tenant, not about this transfer.
    if (!req.sender_name?.trim() || !req.sender_country?.trim()) {
      throw new PayHoldError(
        'policy_violation',
        "Flutterwave requires the sender's name and country on every M-Pesa transfer, " +
          'and this tenant has no country on file',
      )
    }

    const names = splitBeneficiaryName(req.beneficiary_name)
    if (!names) {
      throw new PayHoldError(
        'policy_violation',
        "Flutterwave requires the beneficiary's name on every M-Pesa transfer, " +
          'and this seller has none',
      )
    }

    const beneficiary = await this.call<{ account_number?: string }>(
      `/beneficiaries/${encodeURIComponent(req.beneficiary_token)}`,
      { method: 'GET' },
    )
    const mobile = beneficiary?.account_number?.replace(/\D/g, '')
    if (!mobile) {
      throw new PayHoldError(
        'policy_violation',
        `Flutterwave holds no mobile number for beneficiary ${req.beneficiary_token}, ` +
          'and an M-Pesa transfer cannot be sent without one',
      )
    }

    return [{
      sender: req.sender_name.trim(),
      sender_country: req.sender_country.trim().toUpperCase(),
      mobile_number: mobile,
      first_name: names.first_name,
      last_name: names.last_name,
    }]
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
  // Charging a saved card — a split deal's balance, nobody watching
  // -------------------------------------------------------------------------

  /**
   * `req.token` is `card.token` from a prior verified charge (see `verify()`)
   * — present only when tokenization is enabled on this Flutterwave account
   * and the funding charge was a card. Never reachable for a MoMo-funded
   * deal: `verify()` never sets a token for one, so `deals.metadata` never
   * carries one to read, and the caller (`_shared/settle-balance.ts`)
   * refuses before it ever gets here.
   *
   * **Unverified against Flutterwave's own current documentation** — same
   * posture every other rail claim in this file takes. Confirm the
   * `/tokenized-charges` endpoint and field names before this carries live
   * money.
   */
  async chargeSaved(req: ChargeSavedRequest): Promise<{ provider_ref: string }> {
    const data = await this.call<{ id: number; tx_ref?: string; status?: string }>(
      '/tokenized-charges',
      {
        method: 'POST',
        idempotencyKey: req.idempotency_key,
        body: JSON.stringify({
          token: req.token,
          currency: req.currency,
          amount: toMajor(req.amount, req.currency),
          email: 'balance-charge@payhold.invalid',
          tx_ref: req.idempotency_key,
        }),
      },
    )

    return { provider_ref: String(data.id) }
  }

  // -------------------------------------------------------------------------
  // Beneficiaries and balances
  // -------------------------------------------------------------------------

  /**
   * Register the destination and keep only the token.
   *
   * **`account_bank` is required on every corridor**, and until this was fixed
   * it was sent only for RWF (`'MPS'`) and left `undefined` everywhere else —
   * so every MoMo seller outside Rwanda and every bank seller anywhere was
   * registered against a beneficiary Flutterwave will not transfer to. Nothing
   * caught it because no test makes a live transfer; it surfaces as a payout
   * that fails at the rail with the buyer's money already collected.
   *
   * A destination is therefore one of exactly two shapes, and neither has a
   * default:
   *
   *   mobile money  `network` names the wallet; the number is normalised to
   *                 the international form the API takes
   *   bank account  `bank_code` is the rail's own code for the bank
   *
   * `beneficiary_name` is the seller's own name rather than the constant this
   * used to send. Rails match it against the account being registered, and a
   * payout nobody can trace to a person is the thing §12 exists to prevent.
   */
  async tokenize(req: TokenizeRequest): Promise<TokenizeResult> {
    const isBank = Boolean(req.bank_code)

    if (!isBank && !req.network) {
      throw new PayHoldError(
        'policy_violation',
        'A mobile money destination needs the network it belongs to, and a bank ' +
          'account needs its bank code',
      )
    }

    const accountBank = isBank
      ? req.bank_code!
      : momoBankCode(req.country, req.network!)

    // A bank account number is digits as given; a mobile number is normalised,
    // because `+250 788 123 456` is what people actually type and
    // `250788123456` is what the rail takes.
    const accountNumber = isBank
      ? req.destination.replace(/\s+/g, '')
      : normalizeMsisdn(req.destination, req.country)

    const data = await this.call<{ id: number; account_number: string; bank_name?: string }>(
      '/beneficiaries',
      {
        method: 'POST',
        body: JSON.stringify({
          account_number: accountNumber,
          account_bank: accountBank,
          currency: req.currency,
          beneficiary_name: req.beneficiary_name ?? 'PayHold seller',
        }),
      },
    )

    const tail = accountNumber.replace(/\D/g, '').slice(-4).padStart(4, '0')
    return {
      beneficiary_token: String(data.id),
      // What we persist. The full number stays with Flutterwave. Their
      // `bank_name` is unset for every mobile corridor, so the wallet we were
      // told is a better word than "Mobile money" — and it is the one the
      // seller would use for it.
      masked_destination: `${data.bank_name ?? req.network ?? 'Mobile money'} •••• ${tail}`,
    }
  }

  /**
   * What became of a transfer we already sent.
   *
   * Their transfer statuses are `NEW`, `PENDING`, `SUCCESSFUL` and `FAILED`.
   * Only the last two are answers; the first two mean ask again next pass.
   * A transfer we cannot read is **not** a failure — booking one would tell a
   * seller their money bounced because our request timed out.
   */
  async transferStatus(providerRef: string): Promise<'paid' | 'pending' | 'failed'> {
    const data = await this.call<{ status: string; complete_message?: string }>(
      `/transfers/${encodeURIComponent(providerRef)}`,
      { method: 'GET' },
    )

    const status = (data.status ?? '').toUpperCase()
    if (status === 'SUCCESSFUL') return 'paid'
    if (status === 'FAILED') return 'failed'
    return 'pending'
  }

  /**
   * What this rail will actually convert a corridor at, right now.
   *
   * `amount=1` makes the answer a rate rather than a total, which is what gets
   * locked onto a deal and reused for every figure derived from it afterwards.
   *
   * The rate is read from `source.amount` / `destination.amount` in preference
   * to their bare `rate` field, whose direction their documentation does not
   * pin down. That matters more than it sounds: an inverted rate does not look
   * wrong on a screen, it looks like a very good exchange, and it would be
   * locked onto the deal before anybody noticed.
   */
  async transferRate(from: Currency, to: Currency): Promise<number> {
    const data = await this.call<{
      rate?: number
      source?: { currency?: string; amount?: number }
      destination?: { currency?: string; amount?: number }
    }>(
      `/transfers/rates?amount=1&destination_currency=${encodeURIComponent(to)}` +
        `&source_currency=${encodeURIComponent(from)}`,
      { method: 'GET' },
    )

    const refuse = (why: string): never => {
      throw new PayHoldError(
        'policy_violation',
        `Flutterwave's ${from}→${to} rate could not be read (${why})`,
      )
    }

    const src = data.source
    const dst = data.destination
    const srcCurrency = src?.currency?.toUpperCase()
    const dstCurrency = dst?.currency?.toUpperCase()

    // Checked rather than trusted, for the reason invariant 2 re-fetches a
    // webhook's transaction: a reply about a corridor we did not ask about is
    // not an answer to our question, and `rate` is **not** a safe fallback for
    // one — it would be that other corridor's rate wearing this one's name.
    if (
      (srcCurrency && srcCurrency !== from.toUpperCase()) ||
      (dstCurrency && dstCurrency !== to.toUpperCase())
    ) {
      return refuse(`they answered about ${srcCurrency ?? '?'}→${dstCurrency ?? '?'}`)
    }

    // Self-describing and unambiguous, so preferred over the bare `rate`.
    const derived = Number(dst?.amount) / Number(src?.amount)
    if (Number.isFinite(derived) && derived > 0) return derived

    const bare = Number(data.rate)
    if (Number.isFinite(bare) && bare > 0) return bare

    return refuse('no usable rate in the reply')
  }

  /**
   * The banks this rail can pay into, for a client to render a picker from.
   *
   * Bank codes are not a table we can transcribe the way `MOMO_NETWORKS` is —
   * they change, they are per country, and Flutterwave publishes them.
   */
  async banks(country: string): Promise<{ code: string; name: string }[]> {
    const data = await this.call<{ id: number; code: string; name: string }[]>(
      `/banks/${country.toUpperCase()}`,
      { method: 'GET' },
    )
    return data.map((b) => ({ code: b.code, name: b.name }))
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
    // This instance reads `/balances` and sends nothing, so the mode it is
    // built with decides nothing. `live` is still the right value to write
    // here: it is the branch of `transferReference` that appends nothing, so
    // if this validator ever did grow a transfer, it could not put a sandbox
    // marker on one.
    const provider = new FlutterwaveProvider(creds, '', 'live')
    const balances = await provider.balances()
    return { ok: true, currencies: balances.map((b) => b.currency) }
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof PayHoldError ? err.message : 'Could not reach Flutterwave',
    }
  }
}
