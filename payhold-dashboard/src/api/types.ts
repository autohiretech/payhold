/**
 * PayHold public API v1 — domain types.
 *
 * This file is the contract. The mock engine implements it today; the Supabase
 * backend will implement the same shapes later, and these types get copied
 * verbatim into payhold-backend so the two can never drift.
 *
 * Money is always integer minor units (cents / centimes / RWF has none but we
 * still store x100 for uniformity). Never floats — see `Money`.
 */

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** Integer minor units. 1000 = 10.00 USD. */
export type Money = number

/**
 * Country and currency come from the world registry, so the rail tables and
 * the domain types can never disagree about which markets exist.
 */
export type { Country, Currency } from '@/lib/countries'
import type { Country, Currency } from '@/lib/countries'

/** ISO-8601 timestamp. */
export type Timestamp = string

export type Provider = 'flutterwave' | 'stripe' | 'fake'

/**
 * How the buyer pays, at the level the rail cares about.
 *
 * The specific wallet — MTN, M-Pesa, Wave — is a `payment_network`, not a
 * method: there are a dozen of them across ten countries and they all behave
 * identically to the engine.
 */
export type PaymentMethod = 'card' | 'mobile_money' | 'bank_transfer'


// ---------------------------------------------------------------------------
// Deal state machine
// ---------------------------------------------------------------------------

export const DEAL_STATUSES = [
  'created',
  'funded_held',
  'confirmed_buyer',
  'confirmed_seller',
  'released',
  'paid_out',
  'refunded',
  'disputed',
] as const

export type DealStatus = (typeof DEAL_STATUSES)[number]

/** Statuses where money is sitting in the provider vault under our control. */
export const HOLDING_STATUSES: readonly DealStatus[] = [
  'funded_held',
  'confirmed_buyer',
  'confirmed_seller',
  'disputed',
]

/** Statuses no further transition can leave. */
export const TERMINAL_STATUSES: readonly DealStatus[] = ['paid_out', 'refunded']

export type ConfirmSide = 'buyer' | 'seller'

export interface Confirmation {
  side: ConfirmSide
  confirmed_at: Timestamp
  /** 'auto' when the release timer confirmed on a silent party's behalf. */
  actor: 'user' | 'auto'
}

export interface Deal {
  id: string
  tenant_id: string
  /** Client's own identifier for the buyer — PayHold stores no buyer PII. */
  buyer_ref: string
  seller_id: string
  description: string
  /** What the seller is owed, in the settlement currency. */
  amount: Money
  /** Settlement currency — what the seller quoted and will be paid in. */
  currency: Currency
  /**
   * What the buyer is actually charged, when their market cannot be charged
   * in the settlement currency. A card in Mumbai cannot be charged RWF, so an
   * Indian buyer pays USD against a Rwandan host's RWF price.
   *
   * Equal to `currency` and `amount` when no conversion is needed.
   */
  presentment_currency: Currency
  presentment_amount: Money
  /**
   * Units of presentment per unit of settlement, locked when the buyer paid.
   * Null while the deal is unpaid, or when no conversion applies.
   */
  fx_rate: number | null
  /** Card pre-auth security deposit, held separately from the deal amount. */
  deposit_amount: Money | null
  /** Which market the buyer pays from — decides which rails are offered. */
  buyer_country: Country
  /**
   * The rail this deal routes to. Provisional at creation (based on country and
   * currency), and fixed once the buyer picks a method and pays.
   */
  provider: Provider
  /** Null until the buyer actually pays — we don't know how they will. */
  payment_method: PaymentMethod | null
  /** The specific wallet or scheme used, e.g. "M-Pesa", "Visa". */
  payment_network: string | null
  provider_ref: string | null
  status: DealStatus
  expected_complete_at: Timestamp | null
  /** When the timer will confirm on a silent buyer's behalf. */
  auto_release_at: Timestamp | null
  released_at: Timestamp | null
  /** End of the clearance window; payout may dispatch after this. */
  payout_due_at: Timestamp | null
  fee_amount: Money
  confirmations: Confirmation[]
  metadata: Record<string, string>
  created_at: Timestamp
  updated_at: Timestamp
}

// ---------------------------------------------------------------------------
// Sellers and payouts
// ---------------------------------------------------------------------------

export type PayoutProvider =
  | 'flutterwave_momo'
  | 'flutterwave_bank'
  | 'stripe_connect'

export interface Seller {
  id: string
  tenant_id: string
  name: string
  /** Where the seller banks. Decides which rail can actually pay them. */
  country: Country
  /** What they want to be paid in. Local by default; foreign changes the rail. */
  payout_currency: Currency
  payout_provider: PayoutProvider
  /** Provider-side token. PayHold never stores the real destination. */
  beneficiary_token: string
  /** Display-safe, e.g. "MTN •••• 4821". */
  masked_destination: string
  created_at: Timestamp
}

/**
 * `frozen` is the whole account stopped — reconciliation found drift, so
 * nothing leaves until a person clears it. `held_for_review` is one payout
 * stopped by a risk rule *or by a person*, and needs one approval rather than
 * an account-wide decision. They are deliberately separate: the first is an
 * emergency, the second is a queue.
 */
export type PayoutStatus =
  | 'scheduled'
  | 'processing'
  | 'paid'
  | 'failed'
  | 'frozen'
  | 'held_for_review'

export interface Payout {
  id: string
  tenant_id: string
  deal_id: string
  seller_id: string
  amount: Money
  currency: Currency
  status: PayoutStatus
  scheduled_for: Timestamp
  paid_at: Timestamp | null
  /** Populated on `failed`; surfaced in the dashboard for triage. */
  failure_reason: string | null
  attempts: number
  /** The provider's transfer reference, set once it has one. */
  provider_ref?: string | null
  /** When it was stopped — by a rule, or by a person. */
  review_held_at: Timestamp | null
  /**
   * Who stopped it. Null means a rule did, and the signals are in
   * `risk_signals`. A name here means somebody saw something the rules do not
   * model, which is the only kind of stop that comes with a sentence.
   */
  review_held_by: string | null
  /** Their reason, in their own words. Null for a rule hold. */
  review_hold_reason: string | null
  /** Who let it through. Either kind of hold, only ever a person. */
  review_approved_by: string | null
  review_approved_at: Timestamp | null
}

// ---------------------------------------------------------------------------
// Risk rules — deterministic, and the only automation that may stop money
// ---------------------------------------------------------------------------

/**
 * These are rules, not model output, which is what lets them act at all:
 * invariant 9 bars an AI code path from touching money, and permits a
 * deterministic rule. Every one of them is computable from our own tables, so
 * the same inputs always produce the same hold — a decision an operator can
 * reproduce and argue with.
 *
 * And what they do is *stop*, never send. The worst a bug here can cause is a
 * payout waiting for a human, which is the safe direction to fail in.
 */
export type RiskSignalKind =
  | 'new_seller'
  | 'prior_dispute'
  | 'buyer_velocity'
  | 'large_payout'
  | 'fast_release'

/** `review` holds the payout. `info` is context for whoever looks. */
export type RiskSeverity = 'info' | 'review'

/**
 * How much an address is worth believing.
 *
 * The three are not interchangeable and the screen says so out loud: a client
 * can tell us anything, a provider is reporting what it saw. Anything that
 * ever reads `ip` has to read this beside it.
 */
export type RequestContextSource =
  /** Flutterwave or Stripe reported it on the charge. Their observation. */
  | 'provider'
  /** Our own /pay/:id page saw the connection. */
  | 'hosted_page'
  /** The client's server passed `buyer_ip`. Unverifiable by construction. */
  | 'client_attested'

/**
 * Where a payment was made from — spec §6.
 *
 * Observation only. No rule reads this yet and no verdict is stored on it;
 * it is the raw material an operator checks a signal against, and the history
 * the fraud model of §12.4 will eventually train on.
 *
 * **This is personal data** — the first PayHold stores. It is kept indefinitely
 * as a deliberate decision, which is a position that comes with a stated
 * purpose and a deletion path rather than one that comes for free.
 */
export interface RequestContext {
  id: string
  tenant_id: string
  deal_id: string
  source: RequestContextSource
  /** `pay_started`, `charge_confirmed`, `confirmation`. */
  event: string
  /** Null when the source reported none — common, and not itself suspicious. */
  ip: string | null
  /** Provider-reported only. Never inferred from the address. */
  ip_country: Country | null
  user_agent: string | null
  created_at: Timestamp
}

export interface RiskSignal {
  id: string
  tenant_id: string
  deal_id: string
  seller_id: string | null
  signal: RiskSignalKind
  severity: RiskSeverity
  /** The numbers the rule fired on — what makes the hold checkable. */
  value: Record<string, unknown>
  /** One line an operator can read without knowing the rule. */
  explanation: string
  created_at: Timestamp
}

// ---------------------------------------------------------------------------
// Ledger — the single source of truth for balances
// ---------------------------------------------------------------------------

export type LedgerEntryType =
  | 'hold'
  | 'release'
  | 'refund'
  | 'fee'
  | 'payout'
  | 'deposit_hold'
  | 'deposit_capture'
  | 'deposit_release'

export interface LedgerEntry {
  id: string
  tenant_id: string
  deal_id: string | null
  entry_type: LedgerEntryType
  /** Signed. Positive credits the tenant, negative debits. */
  amount: Money
  currency: Currency
  provider: Provider
  provider_ref: string | null
  created_at: Timestamp
}

export interface Balance {
  currency: Currency
  /** Funds in the vault against unreleased deals. */
  held: Money
  /** Released but still inside the clearance window. */
  pending_clearance: Money
  /** Cleared and payable now. */
  available: Money
  /** Lifetime total already sent to sellers. */
  paid_out: Money
}

/**
 * The same four buckets, split by the rail actually holding the money.
 *
 * This is the view that matters operationally: "held" is not one pot, it is a
 * Flutterwave balance and a Stripe balance, reconciled separately, and only one
 * of them can pay a Rwandan seller.
 */
export interface RailBalance extends Balance {
  provider: Provider
}

// ---------------------------------------------------------------------------
// Disputes
// ---------------------------------------------------------------------------

export type DisputeStatus = 'open' | 'resolved_released' | 'resolved_refunded'

export interface Dispute {
  id: string
  tenant_id: string
  deal_id: string
  raised_by: ConfirmSide
  reason: string
  /** The other side's account, once they give one. Null while they are silent. */
  counter_statement: string | null
  /**
   * What each side submitted. PayHold stores no files — the client site holds
   * them and sends us a description plus a URL, so a dispute can be reviewed
   * with the photos in front of you while the images themselves stay theirs.
   */
  evidence: DisputeEvidence[]
  status: DisputeStatus
  opened_at: Timestamp
  resolved_at: Timestamp | null
  resolution_note: string | null
}

export interface DisputeEvidence {
  side: ConfirmSide
  kind: 'photo' | 'document'
  /** What it shows. This, not the image, is what the assistant is given. */
  description: string
  /** Where the client site serves it. Null when they sent only a description. */
  url: string | null
  submitted_at: Timestamp
}

// ---------------------------------------------------------------------------
// Tenant, settings, keys, audit
// ---------------------------------------------------------------------------

export type TenantStatus = 'active' | 'suspended' | 'payouts_frozen'

export interface Tenant {
  id: string
  name: string
  slug: string
  status: TenantStatus
  created_at: Timestamp
}

export interface TenantSettings {
  tenant_id: string
  /** Fraction of deal amount taken as PayHold's fee. Default 0.10. */
  service_fee_rate: number
  /** Optional flat fee added on top, charged to the buyer. */
  buyer_fee: Money
  /** Days between release and payout eligibility. Default 7. */
  clearance_days: number
  /** Days after expected completion before auto-release fires. Default 3. */
  auto_release_days: number
  currencies: Currency[]
  /**
   * Intelligence (§12). Off means no drafts and no chat — and nothing else.
   * Every money path behaves identically either way, which is the point.
   */
  ai_enabled: boolean
  /** Monthly ceiling on AI spend. Reaching it degrades to off, never to a block. */
  ai_monthly_budget_usd: Money
  /**
   * The deterministic risk rules (§6). Off means payouts are never held for
   * review — signals are still recorded, because the history is what a fraud
   * model of our own is trained on later and it cannot be backfilled.
   */
  risk_rules_enabled: boolean
  /**
   * Payouts at or above this go to review when a rule also finds something
   * about the counterparty. In USD minor units and converted at compare time,
   * so one number covers a tenant paying out in four currencies.
   */
  risk_review_threshold_usd: Money
}

/**
 * A payment provider account a company has connected.
 *
 * Bring-your-own-keys: the buyer's money lands in *this company's* Flutterwave
 * or Stripe balance, not a PayHold-owned one. PayHold orchestrates and never
 * custodies.
 *
 * There is deliberately no `credentials` field, in any shape. Credentials go
 * to the backend once and are never returned to any caller — so a screen
 * cannot render them, a query cache cannot hold them, and a bug report
 * screenshot cannot leak them.
 */
export interface ProviderAccount {
  provider: Provider
  /** `test` moves no real money. `live` does. */
  mode: 'test' | 'live'
  connected_at: Timestamp
}

/** What a rail needs before it can be connected, and where to find it. */
export interface ProviderRequirement {
  provider: Provider
  /** Credential field names, in the order the form should show them. */
  fields: string[]
  /** Plain-language directions to the provider's own dashboard. */
  where: string
}

export interface ConnectProviderInput {
  provider: Provider
  mode: 'test' | 'live'
  credentials: Record<string, string>
}

/** The live status of one rail, as the Rails screen shows it. */
export interface RailStatus {
  provider: Provider
  connected: boolean
  mode: 'test' | 'live'
}

export interface ApiKey {
  id: string
  tenant_id: string
  label: string
  /** First and last chars only — the full key is shown once, at creation. */
  masked_key: string
  created_at: Timestamp
  revoked_at: Timestamp | null
  last_used_at: Timestamp | null
}

export interface WebhookEndpoint {
  id: string
  tenant_id: string
  url: string
  /** Shown once at creation; clients verify our HMAC with it. */
  masked_secret: string
  created_at: Timestamp
  disabled_at: Timestamp | null
}

/**
 * What a client's site is told about, and when.
 *
 * The names match the audit actions rather than inventing a second vocabulary:
 * a client reading their logs beside ours should see the same words.
 */
export const WEBHOOK_EVENTS = [
  'deal.funded_held',
  'deal.confirmed',
  'deal.released',
  'deal.refunded',
  'deal.disputed',
  'deal.dispute_resolved',
  'deal.paid_out',
  'payout.failed',
  'payout.held_for_review',
  'deposit.captured',
  'deposit.released',
] as const

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number]

/** The signed envelope. `data` varies by event; everything else never does. */
export interface WebhookPayload {
  event: WebhookEvent
  deal_id: string | null
  occurred_at: Timestamp
  data: Record<string, unknown>
}

export type WebhookDeliveryStatus = 'pending' | 'delivered' | 'failed'

/**
 * One attempt to notify one endpoint.
 *
 * Kept as a record rather than fire-and-forget because "did you tell us?" is a
 * question clients ask during an incident, and "we think so" is not an answer.
 */
export interface WebhookDelivery {
  id: string
  tenant_id: string
  endpoint_id: string
  event: WebhookEvent
  deal_id: string | null
  payload: WebhookPayload
  /** Exactly the bytes that were signed and sent. */
  body: string
  /** The `X-PayHold-Signature` header value: `t=<iso>,v1=<hex>`. */
  signature: string
  status: WebhookDeliveryStatus
  attempts: number
  status_code: number | null
  error: string | null
  /** Null once delivered or permanently failed. */
  next_attempt_at: Timestamp | null
  delivered_at: Timestamp | null
  created_at: Timestamp
}

export interface AuditLogEntry {
  id: string
  tenant_id: string
  deal_id: string | null
  /** Who acted: an API key label, a dashboard user, 'system' for cron. */
  actor: string
  action: string
  details: Record<string, unknown>
  created_at: Timestamp
}

// ---------------------------------------------------------------------------
// Intelligence — advisory only (spec §12)
// ---------------------------------------------------------------------------

/**
 * Nothing in this section can move money, and the types are shaped to make
 * that obvious rather than merely true: a suggestion has no execute method, it
 * has a `decision`. The decision is made by a person, and the money path it
 * triggers is the same one that person could have called by hand.
 */

export type AiSuggestionKind = 'dispute_resolution' | 'risk_summary'

/**
 * What the dispute assistant can recommend.
 *
 * There is no `split`: v1 has no partial-refund primitive, so a case the
 * evidence genuinely divides is escalated to a human rather than described in
 * terms the engine cannot execute.
 */
export type DisputeRecommendation = 'release' | 'refund' | 'escalate'

/**
 * A fact the model leaned on, with the row it came from. Citations are the
 * difference between a summary an admin can check in ten seconds and one they
 * have to take on trust.
 */
export interface CitedEvent {
  /** An audit_log or ledger id — resolvable, not decorative. */
  ref: string
  at: Timestamp
  label: string
}

export interface DisputeSuggestionOutput {
  kind: 'dispute_resolution'
  recommendation: DisputeRecommendation
  /** One line, the way a colleague would open: what they'd do and why. */
  headline: string
  /** The reasoning, one factor per line. */
  rationale: string[]
  cited: CitedEvent[]
  /** 0–1. Advisory, and deliberately not a threshold anything acts on. */
  confidence: number
}

export interface RiskSummaryOutput {
  kind: 'risk_summary'
  headline: string
  points: string[]
  /** The things worth a second look, if any. Empty is a real answer. */
  flags: string[]
  cited: CitedEvent[]
  confidence: number
}

export type AiOutput = DisputeSuggestionOutput | RiskSummaryOutput

export type AiDecision = 'approved' | 'rejected'

export interface AiSuggestion {
  id: string
  tenant_id: string
  deal_id: string
  kind: AiSuggestionKind
  model: string
  prompt_version: string
  /** Hash of exactly what the model was shown, so a decision is reproducible. */
  input_hash: string
  output: AiOutput
  /** What the call cost, in USD minor units. */
  cost_usd: Money
  created_at: Timestamp
  /** Null until a person decides. Nothing happens before that. */
  decision: AiDecision | null
  decided_by: string | null
  decided_at: Timestamp | null
}

export type AiChatRole = 'user' | 'assistant'

/**
 * What an answer can show beyond prose.
 *
 * Record kinds carry an **id, not a snapshot**, so a card in yesterday's
 * transcript renders today's truth — a suggestion approved after it was shown
 * reads as approved, and a deal that has since released says so. Tables are
 * the exception: a list is an answer about a moment, and freezing it is
 * honest.
 */
export type AiChatAttachment =
  | { kind: 'suggestion'; id: string }
  | { kind: 'deal'; id: string }
  | { kind: 'evidence'; dispute_id: string }
  | { kind: 'table'; caption?: string; columns: string[]; rows: string[][] }

export interface AiChatMessage {
  id: string
  tenant_id: string
  role: AiChatRole
  text: string
  /** Which documents the answer came from. An answer with none is a guess. */
  sources: string[]
  attachments: AiChatAttachment[]
  created_at: Timestamp
}

/**
 * The terminal label for a deal — the training set §12.3 exists to accumulate.
 * These cannot be backfilled, which is why they are written from the first
 * live deal rather than when a model is finally trained.
 */
export type DealOutcomeLabel =
  | 'released_clean'
  | 'auto_released'
  | 'refunded'
  | 'dispute_released'
  | 'dispute_refunded'

export interface DealOutcome {
  id: string
  tenant_id: string
  deal_id: string
  outcome: DealOutcomeLabel
  reason_code: string
  notes: string | null
  /** What was contested, where that differs from the deal amount. */
  amount_disputed: Money | null
  resolved_at: Timestamp
  created_at: Timestamp
}

/** Spend against budget, and how much labelled history has accumulated. */
export interface AiUsage {
  enabled: boolean
  /** This calendar month's spend, USD minor units. */
  spend_usd: Money
  budget_usd: Money
  /** Budget reached: drafts and chat are off. Money paths are untouched. */
  over_budget: boolean
  suggestions_this_month: number
  labelled_outcomes: number
}

// ---------------------------------------------------------------------------
// Master-admin
// ---------------------------------------------------------------------------

/**
 * Drift between our ledger and one provider's reported balance.
 *
 * Per rail, not per currency: "held" is never one pot, and a Flutterwave RWF
 * balance and a Stripe USD balance are reconciled against different APIs. An
 * alert that summed them would be unactionable — you cannot ask two providers
 * about one number.
 */
export interface ReconciliationAlert {
  id: string
  tenant_id: string
  provider: Provider
  currency: Currency
  /** What our ledger says the provider should be holding. */
  ledger_balance: Money
  /** What the provider actually reports. */
  provider_balance: Money
  /** provider − ledger. Non-zero is the alert. */
  drift: Money
  detected_at: Timestamp
  /** Refreshed on every pass while the drift persists. */
  last_seen_at: Timestamp
  resolved_at: Timestamp | null
  resolution_note: string | null
}

// ---------------------------------------------------------------------------
// Request payloads
// ---------------------------------------------------------------------------

export interface CreateDealInput {
  buyer_ref: string
  seller_id: string
  description: string
  amount: Money
  currency: Currency
  /** Defaults to the tenant's home market when omitted. */
  buyer_country?: Country
  deposit_amount?: Money
  expected_complete_at?: Timestamp
  metadata?: Record<string, string>
}

export interface CreateDealResult {
  deal: Deal
  /** Where the buyer is sent to pay. */
  payment_link: string
}

export interface CreateSellerInput {
  name: string
  country: Country
  /** Defaults to the market's local currency when omitted. */
  payout_currency?: Currency
  payout_provider: PayoutProvider
  /** Raw destination — tokenized immediately, never stored. */
  destination: string
}

export type PayHoldErrorCode =
  | 'not_found'
  | 'invalid_state'
  | 'policy_violation'
  | 'insufficient_balance'
  | 'unauthorized'

/** Every failure the API can return, as a typed error. */
export class PayHoldError extends Error {
  code: PayHoldErrorCode

  constructor(code: PayHoldErrorCode, message: string) {
    super(message)
    this.name = 'PayHoldError'
    this.code = code
  }
}
