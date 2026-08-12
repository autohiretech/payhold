/**
 * The single seam between the dashboard and PayHold's backend.
 *
 * Every screen calls this interface and nothing else. `HttpClient` in
 * `./http.ts` is its one implementation, against the real Edge Functions; an
 * in-browser mock used to be the other, and deleting it is what made the
 * signatures below honest.
 *
 * Method names and arguments deliberately mirror the v1 HTTP contract:
 *   createDeal   → POST /v1/deals
 *   getDeal      → GET  /v1/deals/:id
 *   confirmDeal  → POST /v1/deals/:id/confirm
 *   ...and so on.
 *
 * **No method takes the name of the person doing it.** Verifying a seller,
 * clearing a payout hold, deciding a dispute, signing off a launch item and
 * approving a draft are all recorded against somebody, and that somebody is
 * read from the session on the server. These parameters existed because the
 * mock had no session to read; a caller that can name its own approver can
 * forge one, so the argument is gone rather than ignored.
 */

import type {
  AdminPayout,
  AdminWebhookDelivery,
  CheckoutSession,
  CheckoutSessionState,
  PublicCheckout,
  CronJobName,
  CronRun,
  AiChatMessage,
  AiDecision,
  AiSuggestion,
  AiUsage,
  ApiKey,
  AuditLogEntry,
  Balance,
  ConfirmSide,
  ConnectProviderInput,
  CreateDealInput,
  CreateDealResult,
  CreateSellerInput,
  Deal,
  DealAmounts,
  DealOutcome,
  DealStatus,
  Dispute,
  DisputeEvidence,
  DisputeOffer,
  DisputeOfferKind,
  DisputeReasonCode,
  DisputeTimelineEvent,
  LaunchChecklist,
  LedgerEntry,
  Money,
  Payout,
  PayoutDecision,
  PayoutDisplayStatus,
  PayoutRoute,
  PaymentMethod,
  Provider,
  ProviderAccount,
  ProviderRequirement,
  RailBalance,
  SellerWallet,
  RailStatus,
  ReconciliationAlert,
  ReconciliationRun,
  Refund,
  RequestContext,
  RiskSignal,
  Seller,
  SellerCapabilities,
  SellerDestination,
  Tenant,
  TenantSettings,
  Timestamp,
  WebhookDelivery,
  WebhookDeliveryStatus,
  WebhookEndpoint,
} from './types'

/** §5.1's status visibility, in one object: the state, and why it is that. */
export interface PayoutRouting {
  display_status: PayoutDisplayStatus
  /** Null before the routing engine has looked at this payout. */
  decision: PayoutDecision | null
}

export interface DealListFilter {
  status?: DealStatus[]
  seller_id?: string
  /** Matches deal id, buyer_ref, or description. */
  search?: string
  limit?: number
}

export interface WebhookDeliveryFilter {
  endpoint_id?: string
  deal_id?: string
  status?: WebhookDeliveryStatus[]
  limit?: number
}

export interface PayHoldClient {
  // -- Hosted checkout (§10.1) ---------------------------------------------
  /**
   * Issue a payment link, or hand back the one already live.
   *
   * Idempotent: two open sessions would be two live links against one hold.
   * The deal moves to `checkout_started` — a buyer has somewhere to pay and has
   * not paid, which §6 keeps separate from `payment_pending` on purpose.
   */
  openCheckoutSession(
    dealId: string,
    options?: { hours?: number; returnUrl?: string },
  ): Promise<CheckoutSession>
  getCheckoutSession(id: string): Promise<CheckoutSession>
  /** Withdraw a link. Refused once the buyer has used it. */
  cancelCheckoutSession(id: string): Promise<CheckoutSession>
  /**
   * What the buyer sees, resolved from the token in their URL. **No credential
   * required** — someone opening a payment link from an email has no PayHold
   * account and must never be asked for one.
   */
  getPublicCheckout(token: string): Promise<PublicCheckout>
  /**
   * The buyer chooses, and is handed to the provider.
   *
   * The furthest a session goes is `payment_pending`. `funded_held` is the
   * provider webhook's, after it verifies a signature *and* re-fetches the
   * transaction — §15 phase 2, and the reason this returns a link to follow
   * rather than a funded deal.
   */
  payCheckout(
    token: string,
    choice: { method: PaymentMethod; network?: string },
  ): Promise<{ status: CheckoutSessionState; payment_link: string | null }>

  /**
   * Every link issued for a deal, newest first — including the withdrawn and
   * the expired ones.
   *
   * A live session is reachable from the deal, but "which links has this
   * account handed out" is a different question, and the answer to it is a
   * record rather than a state: re-sending a payment link is ordinary support,
   * and a support conversation starts with what was already sent.
   */
  listCheckoutSessions(dealId?: string): Promise<CheckoutSession[]>

  // -- Deals ---------------------------------------------------------------
  createDeal(input: CreateDealInput): Promise<CreateDealResult>
  getDeal(id: string): Promise<Deal>
  /**
   * §7's breakdown for one deal — buyer-paid, fees, tax, reserve, refunded,
   * receivable, paid-out and seller-net, all in the presentment currency.
   *
   * Derived from the ledger and never stored, which is why it is its own call
   * rather than columns on `Deal`: the deal's own figures are what was agreed,
   * and these are what happened.
   */
  getDealAmounts(id: string): Promise<DealAmounts>
  /**
   * §7.1's refund records. A refund is not a bare ledger entry — Alipay and
   * WeChat Pay settle asynchronously up to 90 days out, so it has a lifetime
   * and a status of its own.
   */
  listRefunds(dealId?: string): Promise<Refund[]>
  listDeals(filter?: DealListFilter): Promise<Deal[]>
  /** Both sides present → atomic release. */
  confirmDeal(id: string, side: ConfirmSide): Promise<Deal>
  /**
   * §7.1. `amount` omitted means everything still refundable, which is what
   * every V1 caller meant. `line_items` is the client's own breakdown, carried
   * for the audit record rather than interpreted.
   */
  refundDeal(
    id: string,
    reason: string,
    amount?: Money,
    lineItems?: unknown,
  ): Promise<Deal>

  // -- Deposits (card pre-auth) --------------------------------------------
  captureDeposit(dealId: string, amount: number): Promise<Deal>
  releaseDeposit(dealId: string): Promise<Deal>

  // -- Sellers -------------------------------------------------------------
  listSellers(): Promise<Seller[]>
  createSeller(input: CreateSellerInput): Promise<Seller>
  /**
   * §5.1: a seller has a preferred destination and may have a verified backup,
   * which one pair of columns on the seller could not express. Omit the id for
   * every destination this account has.
   */
  listSellerDestinations(sellerId?: string): Promise<SellerDestination[]>
  /**
   * §12: can this seller be paid, and if not, what is missing — every reason,
   * so onboarding is not one round trip per missing document.
   */
  getSellerCapabilities(sellerId: string): Promise<SellerCapabilities>
  /**
   * Record that the identity check, the sanctions screen and the ownership
   * check came back.
   *
   * **A person's decision, and the endpoint refuses an API key** — a client
   * that could verify its own sellers from its own server has turned KYC into a
   * field it sets. `verified: false` is the other direction: it moves the
   * seller to `review_required`, which holds their payouts again.
   */
  verifySeller(sellerId: string, verified: boolean): Promise<Seller>
  /**
   * §5.1's step-up: record that a destination change was confirmed with the
   * seller, ending its security hold early.
   *
   * **A person's decision, and the endpoint refuses an API key** — the hold
   * exists because "get in, move the destination, withdraw" is the shape of an
   * account takeover, so a client that could end its own holds would have
   * deleted the defence rather than satisfied it.
   *
   * It does **not** verify the destination. Both conditions stop a payout on
   * their own and §5.1 wants both; `verifySeller` is the other one.
   */
  endDestinationHold(
    sellerId: string,
    destinationId: string,
  ): Promise<SellerDestination>
  /**
   * §5.1's move back: make an already-verified destination primary again,
   * without the second hold `POST /destinations` would impose on a row this
   * system has already checked. Refused for an unverified destination and for
   * one still inside its hold, so it reaches nothing new.
   */
  promoteSellerDestination(
    sellerId: string,
    destinationId: string,
  ): Promise<SellerDestination>

  // -- Money ---------------------------------------------------------------
  getBalance(): Promise<Balance[]>
  /** The same buckets split by the rail holding the money. */
  getRailBalances(): Promise<RailBalance[]>
  /**
   * The same buckets split by *seller* — who PayHold is holding money for.
   *
   * Summed, these are `getBalance()` less `fees_retained`, which is ours and
   * absent from a seller's wallet by design. Omit the id for every seller.
   *
   * A seller has no PayHold login and never calls this: their platform reads it
   * with its own credential and renders it in its own app.
   */
  listSellerWallets(sellerId?: string): Promise<SellerWallet[]>
  listLedger(dealId?: string): Promise<LedgerEntry[]>
  listPayouts(): Promise<Payout[]>
  retryPayout(id: string): Promise<Payout>
  /**
   * Stop one payout, because a person saw something the rules do not model.
   *
   * The narrow alternative to freezing a whole account, which stops every
   * honest seller to stop one. It takes a reason — the person who has to clear
   * it has nothing else to go on — and the name comes from the session, so a
   * stop nobody signed is not expressible.
   */
  holdPayout(id: string, reason: string): Promise<Payout>
  /**
   * Let a held payout go out — whether a rule or a person stopped it. Only
   * people release, and the approval is recorded against the one who gave it.
   */
  approvePayoutReview(id: string): Promise<Payout>
  /**
   * §5.1's routing table — which rails exist, where they reach, and whether
   * they are on. Read-only here: enablement is data an operator changes, and a
   * client that could switch its own corridors on has turned §5's country
   * launch checklist into a field it sets.
   */
  listPayoutRoutes(): Promise<PayoutRoute[]>
  /**
   * Where a payout was routed and why — §5.1's "deterministic and auditable".
   *
   * `display_status` is the seven-state seller-facing vocabulary, derived:
   * `Payout.status` keeps every distinction an operator needs, and this is the
   * one a seller is shown.
   */
  getPayoutRouting(id: string): Promise<PayoutRouting>
  /** What the deterministic rules noticed, whether or not they held anything. */
  listRiskSignals(dealId?: string): Promise<RiskSignal[]>
  /**
   * Where payments were made from — the observation a signal is checked
   * against. Read-only; there is no method that writes one.
   */
  listRequestContext(dealId?: string): Promise<RequestContext[]>

  // -- Disputes: the Resolution Center (§8) ---------------------------------
  listDisputes(): Promise<Dispute[]>
  openDispute(
    dealId: string,
    raisedBy: ConfirmSide,
    reason: string,
    opts?: {
      reasonCode?: DisputeReasonCode
      /**
       * Presentment minor units. Omitted disputes the whole payment — a dispute
       * that named no amount must not be read as one that disputed nothing.
       */
      disputedAmount?: Money
    },
  ): Promise<Dispute>
  /**
   * §8's final decision record. The decider is taken from the session, never
   * from a form: whoever spoke for a side in this dispute cannot decide it, and
   * a caller who can name their own decider walks straight past that.
   */
  resolveDispute(
    id: string,
    resolution: 'release' | 'refund' | 'partial_refund',
    note: string,
    refundAmount?: Money,
  ): Promise<Dispute>

  /** Every request on a dispute, oldest first. */
  listDisputeOffers(disputeId: string): Promise<DisputeOffer[]>
  /**
   * Request an update, extension, cancellation or refund. One may be open per
   * order at a time, and it lapses after 48 hours rather than being accepted by
   * silence.
   */
  makeDisputeOffer(
    disputeId: string,
    offeredBy: ConfirmSide,
    kind: DisputeOfferKind,
    opts?: { amount?: Money; extendTo?: Timestamp; note?: string },
  ): Promise<DisputeOffer>
  /**
   * The **other** party answers. Accepting a refund kind settles the deal.
   *
   * The dispute travels with the offer because the request is a sub-resource of
   * it — `/disputes/:id/offers/:offerId/respond` — and it is the dispute that
   * scopes the tenant check. An offer id alone would have to be looked up
   * first, which is a round trip to learn something the caller already knows.
   */
  respondDisputeOffer(
    disputeId: string,
    offerId: string,
    side: ConfirmSide,
    accept: boolean,
  ): Promise<DisputeOffer>
  withdrawDisputeOffer(disputeId: string, offerId: string): Promise<DisputeOffer>

  addDisputeEvidence(
    disputeId: string,
    side: ConfirmSide,
    input: {
      kind: DisputeEvidence['kind']
      description: string
      url?: string
      /** When it was captured, which is not when it was filed. */
      capturedAt?: Timestamp
    },
  ): Promise<DisputeEvidence>

  /** §8's timeline view, derived rather than stored. */
  disputeTimeline(disputeId: string): Promise<DisputeTimelineEvent[]>

  // -- Payment provider accounts (bring-your-own-keys) ----------------------
  /** Which rails this company has connected, and which are still demo. */
  listRailStatus(): Promise<RailStatus[]>
  listProviderAccounts(): Promise<ProviderAccount[]>
  /** What each rail needs before it can be connected. */
  listProviderRequirements(): Promise<ProviderRequirement[]>
  /**
   * Store a company's provider credentials. They are validated against the
   * provider before being accepted, and never readable afterwards.
   *
   * **`mode: 'live'` is refused while §16's checklist has anything
   * outstanding.** That is the whole of "the production release begins in test
   * mode": there is exactly one way live credentials enter the system, so one
   * check here is the gate.
   */
  connectProvider(input: ConnectProviderInput): Promise<ProviderAccount>
  /** Blocked while deals still hold money on that rail. */
  disconnectProvider(provider: Provider): Promise<void>

  // -- The launch gate (§16) -----------------------------------------------
  /**
   * §16's checklist, with `live_mode_allowed` derived from it.
   *
   * PayHold staff, not a tenant: the items are about the platform's own legal
   * entity, contracts and processes. A tenant learns the gate is shut from the
   * refusal on `connectProvider` and does not get to read the list.
   */
  getLaunchChecklist(): Promise<LaunchChecklist>
  /**
   * Record that an item is done, or withdraw that with `signed: false`.
   *
   * Appended, never edited — "who said this was fine, and when did they stop
   * saying it" is exactly the question asked afterwards. A **blocked** item is
   * refused whatever the caller's authority: no attestation makes unbuilt work
   * exist.
   *
   * The signatory comes from the session, the same as every other attestation
   * in this interface.
   */
  signOffLaunchItem(
    code: string,
    evidence: string,
    signed?: boolean,
  ): Promise<LaunchChecklist>

  // -- Settings and access -------------------------------------------------
  getSettings(): Promise<TenantSettings>
  updateSettings(patch: Partial<TenantSettings>): Promise<TenantSettings>
  listApiKeys(): Promise<ApiKey[]>
  /** Returns the plaintext key exactly once — it is never retrievable again. */
  createApiKey(label: string): Promise<{ key: ApiKey; plaintext: string }>
  revokeApiKey(id: string): Promise<ApiKey>
  listWebhookEndpoints(): Promise<WebhookEndpoint[]>
  createWebhookEndpoint(url: string): Promise<{ endpoint: WebhookEndpoint; secret: string }>
  /** Stops notifications without deleting the delivery history. */
  disableWebhookEndpoint(id: string): Promise<WebhookEndpoint>
  /** The answer to "did you tell us?" — every attempt, signed and dated. */
  listWebhookDeliveries(filter?: WebhookDeliveryFilter): Promise<WebhookDelivery[]>
  /** Send one again now, instead of waiting for the backoff to elapse. */
  retryWebhookDelivery(id: string): Promise<WebhookDelivery>

  // -- Intelligence (advisory only — spec §12) -----------------------------
  /**
   * Every method here is read-then-write-a-suggestion. None of them touch a
   * deal, the ledger, or a payout.
   *
   * `decideAiSuggestion` is the one that can end in money moving, and only
   * because a person called it with `approved`: it then runs the *same*
   * `resolveDispute` an admin would have run by hand, and is audited as their
   * decision, not the model's. Rejecting, or approving an `escalate`, moves
   * nothing.
   */
  listAiSuggestions(dealId?: string): Promise<AiSuggestion[]>
  /** Draft a resolution for an open dispute. Writes only `ai_suggestions`. */
  draftDisputeSuggestion(disputeId: string): Promise<AiSuggestion>
  /** Summarise what is known about a deal's counterparties before a payout. */
  draftRiskSummary(dealId: string): Promise<AiSuggestion>
  decideAiSuggestion(id: string, decision: AiDecision): Promise<AiSuggestion>
  /** The dashboard support assistant. Answers from documents; has no tools. */
  askAssistant(question: string): Promise<AiChatMessage>
  listAiChat(): Promise<AiChatMessage[]>
  /** The labelled history §12.3 accumulates for the models of §12.4. */
  listDealOutcomes(): Promise<DealOutcome[]>
  getAiUsage(): Promise<AiUsage>

  // -- Audit ---------------------------------------------------------------
  listAuditLog(dealId?: string): Promise<AuditLogEntry[]>

  // -- Tenant context ------------------------------------------------------
  getTenant(): Promise<Tenant>

  // -- Master-admin (PayHold staff only) -----------------------------------
  admin: AdminApi
}

export interface AdminApi {
  listTenants(): Promise<Tenant[]>
  listReconciliationAlerts(): Promise<ReconciliationAlert[]>
  /**
   * Compare every tenant's ledger against what each provider reports, now,
   * instead of waiting for the nightly pass. Drift freezes payouts by itself;
   * this returns whatever the pass touched.
   */
  runReconciliation(): Promise<ReconciliationAlert[]>
  /**
   * §13's record of the passes themselves — one per tenant per rail, newest
   * first. The alerts say what is wrong now; these say we looked, over what
   * window, and what we covered.
   */
  listReconciliationRuns(): Promise<ReconciliationRun[]>
  /**
   * A person signing a finished pass off, and optionally lifting the freeze it
   * caused. The two are separate arguments because they are separate claims:
   * writing down what happened, and declaring the money accounted for. It
   * refuses to lift while any case on that tenant is still open, and the name
   * comes from the session in the real endpoint.
   */
  resolveReconciliationRun(
    runId: string,
    note: string,
    unfreeze?: boolean,
  ): Promise<ReconciliationRun>
  freezePayouts(tenantId: string): Promise<Tenant>
  unfreezePayouts(tenantId: string): Promise<Tenant>
  /**
   * The `cron_job_runs` log: every scheduled pass, newest first. pg_cron knows
   * a schedule fired; these rows are what our code did with the fire.
   */
  listCronRuns(filter?: { job?: CronJobName; status?: CronRun['status'] }): Promise<CronRun[]>
  /**
   * Payouts in any given state across every tenant. The screen asks for
   * `failed,blocked` — the ones the sweeper gave up on and a person has to
   * look at. The retry below is idempotent and is how a human re-arms one.
   */
  listAdminPayouts(status?: string): Promise<AdminPayout[]>
  retryAdminPayout(payoutId: string): Promise<AdminPayout>
  /**
   * Webhook deliveries across every tenant. The dispatch job re-arms its own
   * failures; this is for the ones it has exhausted.
   */
  listAdminWebhookDeliveries(status?: string): Promise<AdminWebhookDelivery[]>
  retryAdminWebhookDelivery(deliveryId: string): Promise<AdminWebhookDelivery>
}

/*
 * There is no simulation surface here any more.
 *
 * `SimulationApi` used to sit at the bottom of this file: fund a deal, advance
 * the clock, run cron, force a payout failure, inject drift. Those were the
 * levers the dev panel pulled against the in-browser mock, and every one of
 * them is now something only a provider webhook or a scheduled job can cause.
 * A dashboard that could fund a deal would be a dashboard that could move money
 * without a rail agreeing, which is the thing invariant 2 exists to prevent.
 */
