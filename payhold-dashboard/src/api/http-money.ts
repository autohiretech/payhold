/**
 * The money slice of `HttpClient` — deals, balances, payouts, sellers, against
 * the real Edge Functions.
 *
 * Same decorator shape as `AiHttpClient` and for the same reason: it wraps a
 * client and overrides the methods it can serve, so the cut-over lands in
 * slices instead of one commit that has to be right about fifty endpoints at
 * once. Anything not overridden here still falls through.
 *
 * **Reads first, and deliberately so.** A read that is wrong shows a wrong
 * number; a write that is wrong moves money. `createDeal` is the one write in
 * this slice because a payment cannot be demonstrated end to end without it,
 * and it is the write with the least to go wrong — it creates a row and returns
 * a link, and nothing has been charged when it returns.
 *
 * Every call carries the session's bearer token and nothing else. `resolveCaller`
 * turns that into a tenant, so there is no tenant id in any path below; a
 * dashboard that named its own tenant would be a dashboard that could name
 * somebody else's.
 */

import type { AuthBackend } from '@/auth'
import type { DealListFilter, PayHoldClient } from './client'
import {
  PayHoldError,
  type Balance,
  type CheckoutSession,
  type CheckoutSessionState,
  type ConfirmSide,
  type CreateDealInput,
  type CreateDealResult,
  type Deal,
  type DealAmounts,
  type PaymentMethod,
  type Payout,
  type PublicCheckout,
  type RailBalance,
  type Refund,
  type Seller,
  type SellerWallet,
} from './types'

/** `{ error: { code, message } }` — what every Edge Function returns on failure. */
async function toError(response: Response): Promise<PayHoldError> {
  let code = 'policy_violation'
  let message = `Request failed (${response.status})`

  try {
    const body = await response.json()
    if (body?.error?.code) code = body.error.code
    if (body?.error?.message) message = body.error.message
  } catch {
    // A non-JSON body means something upstream answered — a gateway, or a cold
    // start that timed out. The status is all there is to say.
  }

  return new PayHoldError(code as PayHoldError['code'], message)
}

export class MoneyHttpClient implements PayHoldClient {
  #base: string
  #auth: AuthBackend
  #anonKey: string

  constructor(base: string, anonKey: string, auth: AuthBackend, inner: PayHoldClient) {
    this.#base = `${base.replace(/\/+$/, '')}/functions/v1`
    this.#auth = auth
    this.#anonKey = anonKey

    return new Proxy(this, {
      get: (target, prop, receiver) => {
        if (Reflect.has(target, prop)) return Reflect.get(target, prop, receiver)
        const inherited = Reflect.get(inner as object, prop)
        return typeof inherited === 'function' ? inherited.bind(inner) : inherited
      },
      has: (target, prop) => Reflect.has(target, prop) || Reflect.has(inner as object, prop),
    })
  }

  async #call<T>(path: string, init?: RequestInit): Promise<T> {
    const token = await this.#auth.accessToken()
    if (!token) {
      throw new PayHoldError('unauthorized', 'Your session has expired. Sign in again.')
    }

    const response = await fetch(`${this.#base}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        ...init?.headers,
      },
    })

    if (!response.ok) throw await toError(response)
    return await response.json() as T
  }

  /**
   * The buyer's two calls, which carry **no credential at all**.
   *
   * Whoever opens a payment link from an email has no PayHold account, so the
   * token in their URL *is* the authorisation — `/checkout/public/:token` takes
   * nothing else and must not be sent a bearer token, which would be a
   * dashboard session travelling to a page a stranger is looking at.
   *
   * Supabase's gateway still wants its anon key to route the request. That key
   * is public by design and grants nothing on its own; it is not a credential
   * for the session, which is exactly the distinction being kept here.
   */
  async #public<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.#base}${path}`, {
      ...init,
      headers: {
        apikey: this.#anonKey,
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        ...init?.headers,
      },
    })

    if (!response.ok) throw await toError(response)
    return await response.json() as T
  }

  // -- Deals ---------------------------------------------------------------

  async createDeal(input: CreateDealInput): Promise<CreateDealResult> {
    return await this.#call<CreateDealResult>('/deals', {
      method: 'POST',
      body: JSON.stringify(input),
    })
  }

  async listDeals(filter?: DealListFilter): Promise<Deal[]> {
    const params = new URLSearchParams()
    if (filter?.status?.length) params.set('status', filter.status.join(','))
    if (filter?.seller_id) params.set('seller_id', filter.seller_id)
    if (filter?.limit) params.set('limit', String(filter.limit))

    const query = params.toString()
    const { deals } = await this.#call<{ deals: Deal[] }>(
      `/deals${query ? `?${query}` : ''}`,
    )

    // `search` is not a server-side filter — the endpoint does not offer one,
    // and inventing a query parameter the backend ignores would be a filter
    // that silently does nothing. Applied here so the screen behaves the same
    // either way, and narrowed to the fields the mock matched on.
    const term = filter?.search?.trim().toLowerCase()
    if (!term) return deals

    return deals.filter((d) =>
      d.id.toLowerCase().includes(term) ||
      d.buyer_ref.toLowerCase().includes(term) ||
      d.description.toLowerCase().includes(term)
    )
  }

  async getDeal(id: string): Promise<Deal> {
    // The endpoint returns the deal with §7's breakdown alongside it. The
    // breakdown is not part of `Deal`, so it is dropped here and read through
    // `getDealAmounts` — one fetch, two questions, and the screens stay honest
    // about which they are asking.
    const { amounts: _amounts, ...deal } = await this.#call<
      Deal & { amounts: DealAmounts | null }
    >(`/deals/${id}`)
    return deal as Deal
  }

  async getDealAmounts(id: string): Promise<DealAmounts> {
    const { amounts } = await this.#call<{ amounts: DealAmounts | null }>(
      `/deals/${id}`,
    )

    if (!amounts) {
      // `deal_amounts` returns a row of zeroes for an unfunded deal rather than
      // no row, so a null here means the deal itself is gone.
      throw new PayHoldError('not_found', `Deal ${id} has no amounts`)
    }
    return amounts
  }

  async listRefunds(dealId?: string): Promise<Refund[]> {
    if (!dealId) {
      // §7.1's records hang off a deal and there is no account-wide list. The
      // mock offered one; asking for every refund an account has ever made is
      // a different endpoint, and pretending otherwise here would return an
      // empty array that looked like an answer.
      throw new PayHoldError(
        'policy_violation',
        'Refunds are read per deal — pass a deal id',
      )
    }

    const { refunds } = await this.#call<{ refunds: Refund[] }>(
      `/deals/${dealId}/refunds`,
    )
    return refunds
  }

  /** Both sides present → atomic release, decided in SQL under a row lock. */
  async confirmDeal(id: string, side: ConfirmSide): Promise<Deal> {
    return await this.#call<Deal>(`/deals/${id}/confirm`, {
      method: 'POST',
      body: JSON.stringify({ side }),
    })
  }

  /**
   * §7.1. `amount` omitted means everything still refundable, which is what
   * every caller meant before partial refunds existed — so it is left out of
   * the body rather than sent as null, and the endpoint keeps its own default.
   */
  async refundDeal(
    id: string,
    reason: string,
    amount?: number,
    lineItems?: unknown,
  ): Promise<Deal> {
    return await this.#call<Deal>(`/deals/${id}/refund`, {
      method: 'POST',
      body: JSON.stringify({
        reason,
        ...(amount === undefined ? {} : { amount }),
        ...(lineItems === undefined ? {} : { line_items: lineItems }),
      }),
    })
  }

  // -- Hosted checkout (§10.1) ---------------------------------------------

  async openCheckoutSession(
    dealId: string,
    options?: { hours?: number; returnUrl?: string },
  ): Promise<CheckoutSession> {
    return await this.#call<CheckoutSession>('/checkout/sessions', {
      method: 'POST',
      body: JSON.stringify({
        deal_id: dealId,
        ...(options?.hours === undefined ? {} : { hours: options.hours }),
        ...(options?.returnUrl === undefined ? {} : { return_url: options.returnUrl }),
      }),
    })
  }

  async getCheckoutSession(id: string): Promise<CheckoutSession> {
    return await this.#call<CheckoutSession>(`/checkout/sessions/${id}`)
  }

  async cancelCheckoutSession(id: string): Promise<CheckoutSession> {
    return await this.#call<CheckoutSession>(`/checkout/sessions/${id}/cancel`, {
      method: 'POST',
    })
  }

  async listCheckoutSessions(dealId?: string): Promise<CheckoutSession[]> {
    const { sessions } = await this.#call<{ sessions: CheckoutSession[] }>(
      `/checkout/sessions${dealId ? `?deal_id=${encodeURIComponent(dealId)}` : ''}`,
    )
    return sessions
  }

  // The buyer's two. No session, no API key — the token is the credential.
  async getPublicCheckout(token: string): Promise<PublicCheckout> {
    return await this.#public<PublicCheckout>(`/checkout/public/${token}`)
  }

  async payCheckout(
    token: string,
    choice: { method: PaymentMethod; network?: string },
  ): Promise<{ status: CheckoutSessionState; payment_link: string | null }> {
    return await this.#public<{
      status: CheckoutSessionState
      payment_link: string | null
    }>(`/checkout/public/${token}/pay`, {
      method: 'POST',
      body: JSON.stringify(choice),
    })
  }

  // -- Money ---------------------------------------------------------------

  async getBalance(): Promise<Balance[]> {
    const { balances } = await this.#call<{ balances: Balance[] }>('/balance')
    return balances
  }

  async getRailBalances(): Promise<RailBalance[]> {
    const { balances } = await this.#call<{ balances: RailBalance[] }>(
      '/balance?by=rail',
    )
    return balances
  }

  async listSellerWallets(sellerId?: string): Promise<SellerWallet[]> {
    if (sellerId) {
      const { balances } = await this.#call<{
        balances: Omit<SellerWallet, 'seller_id' | 'seller_name' | 'seller_country'>[]
      }>(`/sellers/${sellerId}/balance`)

      // The per-seller endpoint answers about a seller you already named, so it
      // does not repeat their name back. The list shape carries it, so it is
      // filled from the seller record rather than left blank on a screen that
      // renders it.
      const seller = (await this.listSellers()).find((s) => s.id === sellerId)

      return balances.map((b) => ({
        ...b,
        seller_id: sellerId,
        seller_name: seller?.name ?? '',
        seller_country: seller?.country ?? 'RW',
      })) as SellerWallet[]
    }

    const { wallets } = await this.#call<{ wallets: SellerWallet[] }>(
      '/sellers/wallets',
    )
    return wallets
  }

  async listPayouts(): Promise<Payout[]> {
    const { payouts } = await this.#call<{ payouts: Payout[] }>('/payouts')
    return payouts
  }

  // -- Sellers -------------------------------------------------------------

  async listSellers(): Promise<Seller[]> {
    const { sellers } = await this.#call<{ sellers: Seller[] }>('/sellers')
    return sellers
  }
}

/*
 * The rest of `PayHoldClient` is served by the wrapped client through the proxy
 * in the constructor. Declaration merging is how that is said to the compiler —
 * the same shape `AiHttpClient` uses, and for the same reason: writing forty
 * pass-throughs would be forty lines saying nothing, each one to be deleted
 * when its own slice lands.
 */
export interface MoneyHttpClient extends PayHoldClient {}
