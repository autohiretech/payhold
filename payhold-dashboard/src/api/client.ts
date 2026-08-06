/**
 * The single seam between the dashboard and PayHold's backend.
 *
 * Every screen calls this interface and nothing else. Today `MockClient`
 * implements it against an in-browser state machine; when payhold-backend
 * exists we add `HttpClient` with the same methods and change one line in
 * `src/api/index.ts`. No screen changes.
 *
 * Method names and arguments deliberately mirror the v1 HTTP contract:
 *   createDeal   → POST /v1/deals
 *   getDeal      → GET  /v1/deals/:id
 *   confirmDeal  → POST /v1/deals/:id/confirm
 *   ...and so on.
 */

import type {
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
  DealOutcome,
  DealStatus,
  Dispute,
  LedgerEntry,
  Payout,
  PaymentMethod,
  Provider,
  ProviderAccount,
  ProviderRequirement,
  RailBalance,
  RailStatus,
  ReconciliationAlert,
  RequestContext,
  RiskSignal,
  Seller,
  Tenant,
  TenantSettings,
  WebhookDelivery,
  WebhookDeliveryStatus,
  WebhookEndpoint,
} from './types'

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
  // -- Deals ---------------------------------------------------------------
  createDeal(input: CreateDealInput): Promise<CreateDealResult>
  getDeal(id: string): Promise<Deal>
  listDeals(filter?: DealListFilter): Promise<Deal[]>
  /** Both sides present → atomic release. */
  confirmDeal(id: string, side: ConfirmSide): Promise<Deal>
  refundDeal(id: string, reason: string): Promise<Deal>

  // -- Deposits (card pre-auth) --------------------------------------------
  captureDeposit(dealId: string, amount: number): Promise<Deal>
  releaseDeposit(dealId: string): Promise<Deal>

  // -- Sellers -------------------------------------------------------------
  listSellers(): Promise<Seller[]>
  createSeller(input: CreateSellerInput): Promise<Seller>

  // -- Money ---------------------------------------------------------------
  getBalance(): Promise<Balance[]>
  /** The same buckets split by the rail holding the money. */
  getRailBalances(): Promise<RailBalance[]>
  listLedger(dealId?: string): Promise<LedgerEntry[]>
  listPayouts(): Promise<Payout[]>
  retryPayout(id: string): Promise<Payout>
  /**
   * Let a payout a risk rule stopped go out. Rules hold; only people release,
   * and the approval is recorded against the person who gave it.
   */
  approvePayoutReview(id: string, approvedBy: string): Promise<Payout>
  /** What the deterministic rules noticed, whether or not they held anything. */
  listRiskSignals(dealId?: string): Promise<RiskSignal[]>
  /**
   * Where payments were made from — the observation a signal is checked
   * against. Read-only; there is no method that writes one.
   */
  listRequestContext(dealId?: string): Promise<RequestContext[]>

  // -- Disputes ------------------------------------------------------------
  listDisputes(): Promise<Dispute[]>
  openDispute(dealId: string, raisedBy: ConfirmSide, reason: string): Promise<Dispute>
  resolveDispute(
    id: string,
    resolution: 'release' | 'refund',
    note: string,
  ): Promise<Dispute>

  // -- Payment provider accounts (bring-your-own-keys) ----------------------
  /** Which rails this company has connected, and which are still demo. */
  listRailStatus(): Promise<RailStatus[]>
  listProviderAccounts(): Promise<ProviderAccount[]>
  /** What each rail needs before it can be connected. */
  listProviderRequirements(): Promise<ProviderRequirement[]>
  /**
   * Store a company's provider credentials. They are validated against the
   * provider before being accepted, and never readable afterwards.
   */
  connectProvider(input: ConnectProviderInput): Promise<ProviderAccount>
  /** Blocked while deals still hold money on that rail. */
  disconnectProvider(provider: Provider): Promise<void>

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
  decideAiSuggestion(
    id: string,
    decision: AiDecision,
    decidedBy: string,
  ): Promise<AiSuggestion>
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
  freezePayouts(tenantId: string): Promise<Tenant>
  unfreezePayouts(tenantId: string): Promise<Tenant>
}

/**
 * Simulation hooks. These exist ONLY on the mock — they are the levers the dev
 * panel pulls to drive deals through states that would normally need a real
 * provider or a cron job. `HttpClient` will not implement this.
 */
export interface SimulationApi {
  /**
   * Simulate a verified provider webhook landing: created → funded_held.
   * The method fixes which rail the deal ends up on.
   */
  simulateFunding(
    dealId: string,
    method?: PaymentMethod,
    network?: string,
  ): Promise<Deal>
  /** Move the world's clock forward, firing any timers that come due. */
  advanceTime(hours: number): Promise<void>
  /** Run the cron pass now: auto-release, clearance, payout dispatch. */
  runCron(): Promise<void>
  /** Make the next payout attempt fail, to exercise the triage path. */
  failNextPayout(): void
  /** Make the next webhook attempt fail, to exercise backoff and retry. */
  failNextWebhook(): void
  /** Introduce a ledger-vs-provider drift so reconciliation alerts. */
  injectDrift(tenantId: string, amount: number): Promise<void>
  /** Wipe localStorage and re-seed from fixtures. */
  reset(): Promise<void>
  /** Current simulated time, which may be ahead of the real clock. */
  now(): Date
}

export function isSimulated(
  client: PayHoldClient,
): client is PayHoldClient & { sim: SimulationApi } {
  return 'sim' in client
}
