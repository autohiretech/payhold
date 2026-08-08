/**
 * `HttpClient` — the whole of `PayHoldClient`, against the real Edge Functions.
 *
 * There is one implementation now. Until this file grew to cover everything,
 * the dashboard ran on an in-browser mock and the HTTP methods arrived as
 * decorators wrapping it, slice by slice; the mock is gone, and with it the
 * composition in `index.ts` and the flags that chose between them. A browser-side
 * ledger is a convincing thing to look at and it is not the product.
 *
 * Every call carries the session's bearer token and nothing else. `resolveCaller`
 * turns that into a tenant, so there is no tenant id in any path below: a
 * dashboard that named its own tenant would be a dashboard that could name
 * somebody else's.
 *
 * **Two calls go out with no credential at all**, and that is not an oversight
 * to fix. Whoever opens a payment link from an email has no PayHold account, so
 * the token in their URL *is* the authorisation — `#public` sends Supabase's
 * anon key, which the gateway needs to route the request and which grants
 * nothing on its own.
 *
 * **No method here names an actor.** `verifySeller`, `approvePayoutReview`,
 * `resolveDispute`, `signOffLaunchItem` and the rest all record a person, and
 * that person comes from the session on the server. An argument for it would be
 * an argument a caller could forge, which is why the parameters that used to
 * exist for the mock's sake went with it.
 *
 * Three places it does not paper over a difference between the interface and
 * the API, deliberately: `listDeals`'s `search` is filtered here because the
 * endpoint offers no such parameter and a query string the backend ignores
 * would be a filter that silently does nothing; `listRefunds` and
 * `listSellerDestinations` **refuse** a call with no id rather than returning
 * `[]`, because those records hang off a deal or a seller and an empty array
 * would read as an answer; and `getDeal` drops the `amounts` the endpoint
 * embeds, so a screen asking what was agreed and a screen asking what happened
 * still go through different methods.
 */

import type { AuthBackend } from '@/auth'
import type {
  AdminApi,
  DealListFilter,
  PayHoldClient,
  PayoutRouting,
  WebhookDeliveryFilter,
} from './client'
import {
  PayHoldError,
  type AiChatMessage,
  type AiDecision,
  type AiSuggestion,
  type AiUsage,
  type ApiKey,
  type AuditLogEntry,
  type Balance,
  type CheckoutSession,
  type CheckoutSessionState,
  type ConfirmSide,
  type ConnectProviderInput,
  type CreateDealInput,
  type CreateDealResult,
  type CreateSellerInput,
  type Deal,
  type DealAmounts,
  type DealOutcome,
  type Dispute,
  type DisputeEvidence,
  type DisputeOffer,
  type DisputeOfferKind,
  type DisputeReasonCode,
  type DisputeTimelineEvent,
  type LaunchChecklist,
  type LedgerEntry,
  type Money,
  type PaymentMethod,
  type Payout,
  type PayoutRoute,
  type Provider,
  type ProviderAccount,
  type ProviderRequirement,
  type PublicCheckout,
  type RailBalance,
  type RailStatus,
  type ReconciliationAlert,
  type ReconciliationRun,
  type Refund,
  type RequestContext,
  type RiskSignal,
  type Seller,
  type SellerCapabilities,
  type SellerDestination,
  type SellerWallet,
  type Tenant,
  type TenantSettings,
  type Timestamp,
  type WebhookDelivery,
  type WebhookEndpoint,
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

/**
 * The full case, as `GET /disputes/:id` and every dispute write return it: the
 * dispute row with its offers, its evidence and the derived timeline alongside.
 * One call rather than four, because a person opening a dispute wants all of it.
 */
interface DisputeCase {
  offers?: RawOffer[]
  evidence?: RawEvidence[]
  timeline?: DisputeTimelineEvent[]
  [key: string]: unknown
}

type RawOffer = DisputeOffer

/** `dispute_evidence` as the table names its columns. */
interface RawEvidence {
  id: string
  dispute_id: string
  uploaded_by: ConfirmSide
  uploaded_by_actor: string
  kind: DisputeEvidence['kind']
  description: string
  storage_ref: string | null
  captured_at: Timestamp | null
  created_at: Timestamp
}

/**
 * The evidence row, in the shape the screens read.
 *
 * `storage_ref` becomes `url` because PayHold stores no files — the client's
 * site serves them and we keep the reference — and `created_at` becomes
 * `submitted_at` to leave `captured_at` unambiguous. When a photo was taken and
 * when it was filed are different facts, and an inspection photo from handover
 * is worth more than one taken after the complaint.
 */
function toEvidence(row: RawEvidence): DisputeEvidence {
  return {
    side: row.uploaded_by,
    kind: row.kind,
    description: row.description,
    url: row.storage_ref,
    captured_at: row.captured_at,
    submitted_at: row.created_at,
  }
}

/**
 * The dispute itself, with the embedded rows folded in.
 *
 * `counter_statement` is null against this backend and honestly so: §8's
 * respondent files their side as evidence of kind `message` rather than into a
 * field of its own, so a column here would be permanently empty and a screen
 * reading it would conclude the other party never replied.
 */
function toDispute(row: Record<string, unknown>): Dispute {
  const { offers: _offers, timeline: _timeline, evidence, ...rest } = row as DisputeCase

  return {
    ...(rest as unknown as Omit<Dispute, 'evidence' | 'counter_statement'>),
    counter_statement: null,
    evidence: (evidence ?? []).map(toEvidence),
  }
}

export class HttpClient implements PayHoldClient {
  #base: string
  #auth: AuthBackend
  #anonKey: string

  constructor(base: string, anonKey: string, auth: AuthBackend) {
    // Supabase serves functions from `<project>/functions/v1/<name>`.
    this.#base = `${base.replace(/\/+$/, '')}/functions/v1`
    this.#auth = auth
    this.#anonKey = anonKey
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

  #post<T>(path: string, body?: unknown): Promise<T> {
    return this.#call<T>(path, {
      method: 'POST',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  }

  /**
   * The buyer's two calls, which carry **no credential at all**.
   *
   * `/checkout/public/:token` takes nothing else and must not be sent a bearer
   * token, which would be a dashboard session travelling to a page a stranger is
   * looking at. Supabase's gateway still wants its anon key to route the
   * request; that key is public by design and grants nothing on its own, which
   * is exactly the distinction being kept here.
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
    // either way, over the fields somebody would type into it.
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
      // §7.1's records hang off a deal and there is no account-wide list.
      // Returning an empty array would look like an answer.
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
    return await this.#post<Deal>(`/deals/${id}/confirm`, { side })
  }

  /**
   * §7.1. `amount` omitted means everything still refundable, which is what
   * every caller meant before partial refunds existed — so it is left out of
   * the body rather than sent as null, and the endpoint keeps its own default.
   */
  async refundDeal(
    id: string,
    reason: string,
    amount?: Money,
    lineItems?: unknown,
  ): Promise<Deal> {
    return await this.#post<Deal>(`/deals/${id}/refund`, {
      reason,
      ...(amount === undefined ? {} : { amount }),
      ...(lineItems === undefined ? {} : { line_items: lineItems }),
    })
  }

  // -- Deposits (card pre-auth, §22) ---------------------------------------

  /**
   * Take some or all of a held deposit.
   *
   * The guards — that there is a deposit, that it is not already settled, that
   * this is not more than was held — are in SQL, checked under the deal's row
   * lock. The provider is called first: a capture that succeeded and was not
   * booked is recoverable, and a booking with no capture behind it is not.
   */
  async captureDeposit(dealId: string, amount: number): Promise<Deal> {
    return await this.#post<Deal>(`/deals/${dealId}/capture`, { amount })
  }

  async releaseDeposit(dealId: string): Promise<Deal> {
    return await this.#post<Deal>(`/deals/${dealId}/release-deposit`)
  }

  // -- Hosted checkout (§10.1) ---------------------------------------------

  async openCheckoutSession(
    dealId: string,
    options?: { hours?: number; returnUrl?: string },
  ): Promise<CheckoutSession> {
    return await this.#post<CheckoutSession>('/checkout/sessions', {
      deal_id: dealId,
      ...(options?.hours === undefined ? {} : { hours: options.hours }),
      ...(options?.returnUrl === undefined ? {} : { return_url: options.returnUrl }),
    })
  }

  async getCheckoutSession(id: string): Promise<CheckoutSession> {
    return await this.#call<CheckoutSession>(`/checkout/sessions/${id}`)
  }

  async cancelCheckoutSession(id: string): Promise<CheckoutSession> {
    return await this.#post<CheckoutSession>(`/checkout/sessions/${id}/cancel`)
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

  /**
   * The entries the buckets are made of.
   *
   * `getBalance` sums them and stores nothing; this is what to read when a
   * bucket and a provider disagree. Append-only on the other side, so there is
   * no method here that writes one — a correction is an opposite entry.
   */
  async listLedger(dealId?: string): Promise<LedgerEntry[]> {
    const { entries } = await this.#call<{ entries: LedgerEntry[] }>(
      `/ledger${dealId ? `?deal_id=${encodeURIComponent(dealId)}` : ''}`,
    )
    return entries
  }

  async listPayouts(): Promise<Payout[]> {
    const { payouts } = await this.#call<{ payouts: Payout[] }>('/payouts')
    return payouts
  }

  /**
   * §5.1's recorded decision for one payout — the state, and why it is that.
   *
   * Read rather than re-derived. `payout_decisions` exists because the choice
   * has to be auditable after the fact, and re-running the routing engine now
   * would answer "what would we do today" instead of "what did we do".
   */
  async getPayoutRouting(id: string): Promise<PayoutRouting> {
    const { display_status, decision } = await this.#call<{
      display_status: PayoutRouting['display_status']
      decision: PayoutRouting['decision']
    }>(`/payouts/${id}`)
    return { display_status, decision }
  }

  /**
   * §5.1's routing table. Read-only: which corridors are open rests on §16's
   * written provider confirmation per market, and a dashboard that could switch
   * its own on would have turned that checklist into a field it sets.
   */
  async listPayoutRoutes(): Promise<PayoutRoute[]> {
    const { routes } = await this.#call<{ routes: PayoutRoute[] }>('/payout-routes')
    return routes
  }

  /**
   * A person's retry. **One more attempt, not a fresh series** — the endpoint
   * re-arms the clock and deliberately leaves `attempts` alone, because
   * `route_payout` reads that counter to decide whether the seller's verified
   * backup destination may be used, and zeroing it would send the next attempt
   * back to the primary that has been failing.
   */
  async retryPayout(id: string): Promise<Payout> {
    const { payout } = await this.#post<{ payout: Payout }>(`/payouts/${id}/retry`)
    return payout
  }

  /**
   * Invariant 11's narrow alternative to freezing a whole account. Takes a
   * reason, because the next person to look at the row has nothing else to go
   * on — and not a name: the endpoint takes the actor from the session, for the
   * reason `verifySeller` does. A caller that can name its own actor can forge
   * one.
   */
  async holdPayout(id: string, reason: string): Promise<Payout> {
    const { payout } = await this.#post<{ payout: Payout }>(
      `/payouts/${id}/hold`,
      { reason },
    )
    return payout
  }

  /** Clear a hold — a rule's or a person's. Refuses an API key server-side. */
  async approvePayoutReview(id: string): Promise<Payout> {
    const { payout } = await this.#post<{ payout: Payout }>(
      `/payouts/${id}/approve-review`,
    )
    return payout
  }

  async listRiskSignals(dealId?: string): Promise<RiskSignal[]> {
    const { risk_signals } = await this.#call<{ risk_signals: RiskSignal[] }>(
      `/risk-signals${dealId ? `?deal_id=${encodeURIComponent(dealId)}` : ''}`,
    )
    return risk_signals
  }

  /**
   * Where payments were made from. Observation only, and there is no method
   * that writes one on either side of the seam — the writers are the `/pay`
   * handler and the provider webhook.
   */
  async listRequestContext(dealId?: string): Promise<RequestContext[]> {
    const params = new URLSearchParams({ context: '1' })
    if (dealId) params.set('deal_id', dealId)

    const { request_context } = await this.#call<{
      request_context: RequestContext[]
    }>(`/risk-signals?${params.toString()}`)
    return request_context
  }

  // -- Sellers -------------------------------------------------------------

  async listSellers(): Promise<Seller[]> {
    const { sellers } = await this.#call<{ sellers: Seller[] }>('/sellers')
    return sellers
  }

  /**
   * The raw destination crosses the wire exactly once, to be tokenized, and is
   * never stored — §6. What comes back is the token's mask.
   */
  async createSeller(input: CreateSellerInput): Promise<Seller> {
    const { seller } = await this.#post<{ seller: Seller }>('/sellers', input)
    return seller
  }

  async getSellerCapabilities(sellerId: string): Promise<SellerCapabilities> {
    return await this.#call<SellerCapabilities>(
      `/sellers/${sellerId}/capabilities`,
    )
  }

  async listSellerDestinations(sellerId?: string): Promise<SellerDestination[]> {
    if (!sellerId) {
      // §5.1's destinations hang off a seller and there is no account-wide
      // list. Returning [] would read as "this account has none".
      throw new PayHoldError(
        'policy_violation',
        'Destinations are read per seller — pass a seller id',
      )
    }

    const { destinations } = await this.#call<{
      destinations: SellerDestination[]
    }>(`/sellers/${sellerId}/destinations`)
    return destinations
  }

  /**
   * §12's attestation. The endpoint takes the actor from the session and
   * **refuses an API key** outright, because a client that could verify its own
   * sellers has turned KYC into a field it sets.
   */
  async verifySeller(sellerId: string, verified: boolean): Promise<Seller> {
    return await this.#post<Seller>(`/sellers/${sellerId}/verify`, { verified })
  }

  // -- Disputes: the Resolution Center (§8) --------------------------------

  async listDisputes(): Promise<Dispute[]> {
    const { disputes } = await this.#call<{ disputes: Record<string, unknown>[] }>(
      '/disputes',
    )
    return disputes.map(toDispute)
  }

  async openDispute(
    dealId: string,
    raisedBy: ConfirmSide,
    reason: string,
    opts: {
      reasonCode?: DisputeReasonCode
      disputedAmount?: Money
    } = {},
  ): Promise<Dispute> {
    const created = await this.#post<Record<string, unknown>>('/disputes', {
      deal_id: dealId,
      raised_by: raisedBy,
      reason,
      ...(opts.reasonCode === undefined ? {} : { reason_code: opts.reasonCode }),
      // Omitted disputes the whole payment. A dispute that named no amount must
      // not be sent as one that disputed nothing.
      ...(opts.disputedAmount === undefined
        ? {}
        : { disputed_amount: opts.disputedAmount }),
    })
    return toDispute(created)
  }

  async listDisputeOffers(disputeId: string): Promise<DisputeOffer[]> {
    const { offers } = await this.#call<DisputeCase>(`/disputes/${disputeId}`)
    return offers ?? []
  }

  /**
   * Request an update, extension, cancellation or refund. One may be open per
   * order at a time, and it lapses after 48 hours rather than being accepted by
   * silence.
   *
   * The write returns the whole case, so the new request is picked out of it
   * rather than fetched again — and picked as the newest, since the endpoint
   * answers with the case as it now stands.
   */
  async makeDisputeOffer(
    disputeId: string,
    offeredBy: ConfirmSide,
    kind: DisputeOfferKind,
    opts: { amount?: Money; extendTo?: Timestamp; note?: string } = {},
  ): Promise<DisputeOffer> {
    const body = await this.#post<DisputeCase>(`/disputes/${disputeId}/offers`, {
      offered_by: offeredBy,
      kind,
      ...(opts.amount === undefined ? {} : { amount: opts.amount }),
      ...(opts.extendTo === undefined ? {} : { extend_to: opts.extendTo }),
      ...(opts.note === undefined ? {} : { note: opts.note }),
    })

    return newestOffer(body, disputeId)
  }

  /**
   * The **other** party answers. Accepting a refund kind settles the deal, in
   * the same transaction as the answer — `respond_dispute_offer` calls
   * `resolve_dispute` itself rather than leaving a second call to fail on its
   * own.
   */
  async respondDisputeOffer(
    disputeId: string,
    offerId: string,
    side: ConfirmSide,
    accept: boolean,
  ): Promise<DisputeOffer> {
    const body = await this.#post<DisputeCase>(
      `/disputes/${disputeId}/offers/${offerId}/respond`,
      { side, accept },
    )
    return findOffer(body, offerId)
  }

  async withdrawDisputeOffer(
    disputeId: string,
    offerId: string,
  ): Promise<DisputeOffer> {
    const body = await this.#post<DisputeCase>(
      `/disputes/${disputeId}/offers/${offerId}/withdraw`,
    )
    return findOffer(body, offerId)
  }

  /** A description and a reference. PayHold stores no bytes. */
  async addDisputeEvidence(
    disputeId: string,
    side: ConfirmSide,
    input: {
      kind: DisputeEvidence['kind']
      description: string
      url?: string
      /** When it was captured, which is not when it was filed. */
      capturedAt?: Timestamp
    },
  ): Promise<DisputeEvidence> {
    const body = await this.#post<DisputeCase>(`/disputes/${disputeId}/evidence`, {
      uploaded_by: side,
      kind: input.kind,
      description: input.description,
      ...(input.url === undefined ? {} : { storage_ref: input.url }),
      ...(input.capturedAt === undefined ? {} : { captured_at: input.capturedAt }),
    })

    const rows = body.evidence ?? []
    const added = rows[rows.length - 1]
    if (!added) {
      throw new PayHoldError('not_found', 'The evidence was not recorded')
    }
    return toEvidence(added)
  }

  async disputeTimeline(disputeId: string): Promise<DisputeTimelineEvent[]> {
    const { timeline } = await this.#call<DisputeCase>(`/disputes/${disputeId}`)
    return timeline ?? []
  }

  /**
   * §8's final decision record. The decider comes from the session: whoever
   * spoke for a side in this dispute cannot decide it, and a caller who could
   * name their own decider would walk straight past that.
   */
  async resolveDispute(
    id: string,
    resolution: 'release' | 'refund' | 'partial_refund',
    note: string,
    refundAmount?: Money,
  ): Promise<Dispute> {
    const body = await this.#post<Record<string, unknown>>(
      `/disputes/${id}/resolve`,
      {
        resolution,
        note,
        ...(refundAmount === undefined ? {} : { refund_amount: refundAmount }),
      },
    )
    return toDispute(body)
  }

  // -- Payment provider accounts (bring-your-own-keys) ----------------------

  async listProviderAccounts(): Promise<ProviderAccount[]> {
    const { accounts } = await this.#call<{
      accounts: { provider: Provider; mode: 'test' | 'live'; created_at: string }[]
    }>('/provider-accounts')

    // There is no `credentials` field in this response, in any shape, and there
    // is no endpoint that returns one. `connected_at` is the row's own
    // `created_at`; the credential behind it never leaves the database.
    return accounts.map(({ provider, mode, created_at }) => ({
      provider,
      mode,
      connected_at: created_at,
    }))
  }

  async listProviderRequirements(): Promise<ProviderRequirement[]> {
    const { available } = await this.#call<{ available: ProviderRequirement[] }>(
      '/provider-accounts',
    )
    return available
  }

  /**
   * Which rails this company has connected, and which are still demo.
   *
   * Derived from the endpoint's own list of connectable rails rather than a
   * pair named here: which adapters exist is the backend's fact, and a screen
   * with them baked in is wrong the day one is added. Demo mode is "active"
   * precisely when no real rail is connected — it disappears the moment real
   * keys arrive, rather than lingering as a second way money might be moving.
   */
  async listRailStatus(): Promise<RailStatus[]> {
    const { accounts, available } = await this.#call<{
      accounts: { provider: Provider; mode: 'test' | 'live' }[]
      available: { provider: Provider }[]
    }>('/provider-accounts')

    const rails: RailStatus[] = available.map(({ provider }) => {
      const account = accounts.find((a) => a.provider === provider)
      return { provider, connected: Boolean(account), mode: account?.mode ?? 'test' }
    })

    rails.push({ provider: 'fake', connected: accounts.length === 0, mode: 'test' })

    return rails.sort((a, b) => a.provider.localeCompare(b.provider))
  }

  /**
   * Store a company's provider credentials.
   *
   * They are validated against the provider before being accepted and are never
   * readable afterwards, so the account is read back rather than assembled from
   * what was sent: `connected_at` is a fact about the row, not about the call.
   *
   * **`mode: 'live'` is refused while §16's checklist has anything
   * outstanding**, and refused before the credentials are used — refusing after
   * we have sent a live secret key to the provider would be refusing too late.
   */
  async connectProvider(input: ConnectProviderInput): Promise<ProviderAccount> {
    const { provider, mode } = await this.#post<{
      provider: Provider
      mode: 'test' | 'live'
    }>('/provider-accounts', input)

    const stored = (await this.listProviderAccounts()).find(
      (a) => a.provider === provider,
    )
    return stored ?? { provider, mode, connected_at: new Date().toISOString() }
  }

  /** Blocked while deals still hold money on that rail. */
  async disconnectProvider(provider: Provider): Promise<void> {
    await this.#call<{ provider: Provider; connected: boolean }>(
      `/provider-accounts?provider=${encodeURIComponent(provider)}`,
      { method: 'DELETE' },
    )
  }

  // -- The launch gate (§16) -----------------------------------------------

  /**
   * §16's checklist, with `live_mode_allowed` derived from it.
   *
   * PayHold staff, not a tenant: both routes want a `platform_admins` session
   * and refuse an API key. A tenant learns the gate is shut from the refusal on
   * `connectProvider` and does not get to read the list.
   */
  async getLaunchChecklist(): Promise<LaunchChecklist> {
    return await this.#call<LaunchChecklist>('/launch')
  }

  /**
   * Record that an item is done, or withdraw that with `signed: false`.
   *
   * Appended, never edited. A **blocked** item is refused whatever the caller's
   * authority: no attestation makes unbuilt work exist.
   */
  async signOffLaunchItem(
    code: string,
    evidence: string,
    signed = true,
  ): Promise<LaunchChecklist> {
    return await this.#post<LaunchChecklist>(`/launch/${code}/sign-off`, {
      evidence,
      signed,
    })
  }

  // -- Settings and access -------------------------------------------------

  async getSettings(): Promise<TenantSettings> {
    const { settings } = await this.#call<{ settings: TenantSettings }>('/settings')
    return settings
  }

  /**
   * In-flight deals keep the settings they were created with (§27), so nothing
   * this changes reaches a deal that already exists: the fee is stamped at
   * creation and the windows are resolved into timestamps when they start
   * running.
   */
  async updateSettings(patch: Partial<TenantSettings>): Promise<TenantSettings> {
    const { settings } = await this.#call<{ settings: TenantSettings }>('/settings', {
      method: 'PATCH',
      body: JSON.stringify(patch),
    })
    return settings
  }

  async listApiKeys(): Promise<ApiKey[]> {
    const { keys } = await this.#call<{ keys: ApiKey[] }>('/api-keys')
    return keys
  }

  /** Returns the plaintext exactly once — only its hash is stored. */
  async createApiKey(label: string): Promise<{ key: ApiKey; plaintext: string }> {
    return await this.#post<{ key: ApiKey; plaintext: string }>('/api-keys', {
      label,
    })
  }

  /** Revoked, not deleted: the label and the last-used stamp are the record. */
  async revokeApiKey(id: string): Promise<ApiKey> {
    const { key } = await this.#call<{ key: ApiKey }>(
      `/api-keys?id=${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    )
    return key
  }

  async listWebhookEndpoints(): Promise<WebhookEndpoint[]> {
    const { endpoints } = await this.#call<{ endpoints: WebhookEndpoint[] }>(
      '/webhook-endpoints',
    )
    return endpoints
  }

  async createWebhookEndpoint(
    url: string,
  ): Promise<{ endpoint: WebhookEndpoint; secret: string }> {
    const { endpoint, secret } = await this.#post<{
      endpoint: WebhookEndpoint
      secret: string
    }>('/webhook-endpoints', { url })

    // The only time the signing secret is ever returned. It is encrypted rather
    // than hashed on the other side, because unlike an API key it has to be
    // *used* on every delivery — but there is no endpoint that reads it back.
    return { endpoint, secret }
  }

  /** Stops notifications without deleting the delivery history. */
  async disableWebhookEndpoint(id: string): Promise<WebhookEndpoint> {
    const { endpoint } = await this.#call<{ endpoint: WebhookEndpoint }>(
      `/webhook-endpoints?id=${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    )
    return endpoint
  }

  async listWebhookDeliveries(
    filter: WebhookDeliveryFilter = {},
  ): Promise<WebhookDelivery[]> {
    const params = new URLSearchParams({ deliveries: '1' })
    if (filter.endpoint_id) params.set('endpoint_id', filter.endpoint_id)
    if (filter.deal_id) params.set('deal_id', filter.deal_id)
    if (filter.status?.length) params.set('status', filter.status.join(','))
    if (filter.limit) params.set('limit', String(filter.limit))

    const { deliveries } = await this.#call<{ deliveries: WebhookDelivery[] }>(
      `/webhook-endpoints?${params.toString()}`,
    )
    return deliveries
  }

  /**
   * Send one again now, instead of waiting for the backoff to elapse.
   *
   * The endpoint re-arms the clock; `webhook-dispatch` does the sending, on its
   * next pass a minute later. So the row comes back `pending` rather than
   * delivered, which is what actually happened.
   */
  async retryWebhookDelivery(id: string): Promise<WebhookDelivery> {
    const { delivery } = await this.#post<{ delivery: WebhookDelivery }>(
      `/webhook-endpoints/deliveries/${id}/retry`,
    )
    return delivery
  }

  // -- Intelligence (advisory only — spec §12) -----------------------------
  //
  // Every method here is read-then-write-a-suggestion. None of them touch a
  // deal, the ledger, or a payout. `decideAiSuggestion` is the one that can end
  // in money moving, and only because a person called it with `approved`: it
  // then runs the *same* `resolveDispute` an admin would have run by hand, and
  // is audited as their decision, not the model's.
  //
  // What none of them carries is a key. The model credential lives in Supabase's
  // function secrets, and the browser could not reach Claude if it wanted to.

  async listAiSuggestions(dealId?: string): Promise<AiSuggestion[]> {
    const query = dealId ? `?deal_id=${encodeURIComponent(dealId)}` : ''
    const { suggestions } = await this.#call<{ suggestions: AiSuggestion[] }>(
      `/ai-decisions${query}`,
    )
    return suggestions
  }

  async draftDisputeSuggestion(disputeId: string): Promise<AiSuggestion> {
    const { suggestion } = await this.#post<{ suggestion: AiSuggestion }>(
      '/ai-dispute',
      { dispute_id: disputeId },
    )
    return suggestion
  }

  async draftRiskSummary(dealId: string): Promise<AiSuggestion> {
    const { suggestion } = await this.#post<{ suggestion: AiSuggestion }>(
      '/ai-risk-narrator',
      { deal_id: dealId },
    )
    return suggestion
  }

  /**
   * The approver comes from the session. A client that can name its own
   * approver can forge an approval, and the audit row here is the record of a
   * person's decision — so the one place it may come from is the token that
   * proves who they are.
   */
  async decideAiSuggestion(
    id: string,
    decision: AiDecision,
  ): Promise<AiSuggestion> {
    const { suggestion } = await this.#post<{ suggestion: AiSuggestion }>(
      '/ai-decisions',
      { suggestion_id: id, decision },
    )
    return suggestion
  }

  async askAssistant(question: string): Promise<AiChatMessage> {
    const { message } = await this.#post<{ message: AiChatMessage }>(
      '/ai-support',
      { question },
    )
    return message
  }

  async listAiChat(): Promise<AiChatMessage[]> {
    const { messages } = await this.#call<{ messages: AiChatMessage[] }>('/ai-support')
    return messages
  }

  async listDealOutcomes(): Promise<DealOutcome[]> {
    const { outcomes } = await this.#call<{ outcomes: DealOutcome[] }>(
      '/ai-decisions?outcomes=1',
    )
    return outcomes
  }

  async getAiUsage(): Promise<AiUsage> {
    const { usage } = await this.#call<{ usage: AiUsage }>('/ai-decisions?usage=1')
    return usage
  }

  // -- Audit ---------------------------------------------------------------

  async listAuditLog(dealId?: string): Promise<AuditLogEntry[]> {
    const { entries } = await this.#call<{ entries: AuditLogEntry[] }>(
      `/audit-log${dealId ? `?deal_id=${encodeURIComponent(dealId)}` : ''}`,
    )
    return entries
  }

  // -- Tenant context ------------------------------------------------------

  /**
   * The company this session belongs to. `/account/me` is what turns a token
   * into a tenant and a role, and it is the same call the sign-in makes — a
   * session with no membership is not an account with no company, it is signed
   * back out.
   */
  async getTenant(): Promise<Tenant> {
    const { tenant } = await this.#call<{ tenant: Tenant }>('/account/me')
    return tenant
  }

  // -- Master-admin (PayHold staff only) -----------------------------------
  //
  // Every route below reads across tenants and none of them is scoped to one,
  // which is why they are their own function on the other side rather than a
  // few more handlers beside the scoped ones. A tenant `owner` gets the same
  // 404 here as a stranger.

  admin: AdminApi = {
    listTenants: async (): Promise<Tenant[]> => {
      const { tenants } = await this.#call<{ tenants: Tenant[] }>('/admin/tenants')
      return tenants
    },

    listReconciliationAlerts: async (): Promise<ReconciliationAlert[]> => {
      const { alerts } = await this.#call<{ alerts: ReconciliationAlert[] }>(
        '/admin/reconciliation-alerts',
      )
      return alerts
    },

    /** The same pass the nightly cron runs — there is no faster version of it. */
    runReconciliation: async (): Promise<ReconciliationAlert[]> => {
      const { alerts } = await this.#post<{ alerts: ReconciliationAlert[] }>(
        '/admin/reconciliation-runs',
      )
      return alerts
    },

    listReconciliationRuns: async (): Promise<ReconciliationRun[]> => {
      const { runs } = await this.#call<{ runs: ReconciliationRun[] }>(
        '/admin/reconciliation-runs',
      )
      return runs
    },

    /**
     * A person signing a finished pass off, and optionally lifting the freeze it
     * caused. Two arguments because they are two claims: writing down what
     * happened, and declaring the money accounted for. The name comes from the
     * session, and the unfreeze is refused while any case on that tenant is
     * still open.
     */
    resolveReconciliationRun: async (
      runId: string,
      note: string,
      unfreeze = false,
    ): Promise<ReconciliationRun> => {
      const { run } = await this.#post<{ run: ReconciliationRun }>(
        `/admin/reconciliation-runs/${runId}/resolve`,
        { note, unfreeze },
      )
      return run
    },

    freezePayouts: async (tenantId: string): Promise<Tenant> => {
      const { tenant } = await this.#post<{ tenant: Tenant }>(
        `/admin/tenants/${tenantId}/freeze`,
      )
      return tenant
    },

    /**
     * Refused while any reconciliation case on that account is open — the same
     * condition the run sign-off enforces. Freezing is arithmetic; lifting one
     * is a judgement about whether the difference has been explained.
     */
    unfreezePayouts: async (tenantId: string): Promise<Tenant> => {
      const { tenant } = await this.#post<{ tenant: Tenant }>(
        `/admin/tenants/${tenantId}/unfreeze`,
      )
      return tenant
    },
  }
}

/** The offer this call just wrote, out of the case the endpoint answered with. */
function newestOffer(body: DisputeCase, disputeId: string): DisputeOffer {
  const offers = body.offers ?? []
  const offer = offers[offers.length - 1]
  if (!offer) {
    throw new PayHoldError('not_found', `No request was recorded on ${disputeId}`)
  }
  return offer
}

function findOffer(body: DisputeCase, offerId: string): DisputeOffer {
  const offer = (body.offers ?? []).find((o) => o.id === offerId)
  if (!offer) throw new PayHoldError('not_found', `Request ${offerId} not found`)
  return offer
}
