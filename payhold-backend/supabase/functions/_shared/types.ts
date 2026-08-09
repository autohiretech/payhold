/**
 * PayHold public API v1 — domain types.
 *
 * The counterpart of payhold-dashboard/src/api/types.ts. The two describe the
 * same wire contract from opposite ends, so a change to either is a change to
 * both, in the same commit.
 *
 * Money is always integer minor units. Never floats — see `Money`.
 */

/** Integer minor units. 1000 = 10.00 USD. */
export type Money = number

/**
 * ISO-3166 alpha-2 and ISO-4217.
 *
 * The dashboard narrows these to a generated union of every country in the
 * world (`src/lib/countries.ts`, ~200 rows, regenerated when provider coverage
 * changes). Copying that union here would guarantee the two drift, so the
 * backend types the shape and validates membership at the edge instead —
 * exactly what the `country_code` / `currency_code` domains do in SQL.
 */
export type Country = string
export type Currency = string

/** ISO-8601 timestamp. */
export type Timestamp = string

/**
 * §9's adapters. The first three are built; the last three are **declared and
 * unbuilt** (§29.3), so they can be named, refused with a reason and carry a
 * capability row — `loadProvider` throws for them rather than falling back to
 * the fake.
 *
 * Distinct from `PayoutProvider`, which names a **rail** — the shape of
 * destination a token was minted for. One adapter carries several: Venmo
 * destinations are reached through PayPal's API.
 */
export type Provider =
  | 'flutterwave'
  | 'stripe'
  | 'fake'
  | 'paypal'
  | 'cash_app_pay'
  | 'china_wallet_partner'

/**
 * How the buyer pays, at the level the rail cares about. The specific wallet —
 * MTN, M-Pesa, Wave — is a `payment_network`, not a method.
 */
/**
 * How the buyer paid.
 *
 * `wallet` covers §9's wallet rails — PayPal, Venmo, Cash App Pay, Alipay,
 * WeChat Pay. They have no card scheme, are not 3DS-eligible and dispute
 * through a different process, so recording one as a `card` would put a
 * claim in the ledger nobody made.
 *
 * Stripe Link is **not** one: it is card-backed and disputes as a card does,
 * so it is a faster way to present a card rather than a different instrument.
 */
export type PaymentMethod = 'card' | 'wallet' | 'mobile_money' | 'bank_transfer'

// ---------------------------------------------------------------------------
// Deal state machine
// ---------------------------------------------------------------------------

/**
 * Spec §6. **In the Postgres enum's declaration order**, which is the order
 * `order by status` produces — see `20260807000001_lifecycle_states.sql`. Keep
 * the two in step: this array reading as the lifecycle is what lets a screen
 * sort by it.
 *
 * §6's `delivered` and `buyer_review` are absent deliberately. Both name the
 * window where the seller has confirmed and the buyer has not, which is
 * `confirmed_seller` here. §29.1 carries the ruling.
 */
export const DEAL_STATUSES = [
  'created',
  'checkout_started',
  'payment_pending',
  'payment_failed',
  'expired',
  'canceled',
  'funded_held',
  'in_progress',
  'revision_requested',
  'confirmed_buyer',
  'confirmed_seller',
  'clearing',
  'released',
  'payout_pending',
  'paid_out',
  'refunded',
  'partially_refunded',
  'disputed',
] as const

export type DealStatus = (typeof DEAL_STATUSES)[number]

/** Statuses where money is sitting in the provider vault under our control. */
export const HOLDING_STATUSES: readonly DealStatus[] = [
  'funded_held',
  'in_progress',
  'revision_requested',
  'confirmed_buyer',
  'confirmed_seller',
  'disputed',
]

/**
 * At or past the release — the money has left the hold. `clearing` is inside
 * the safety window, `released` is past it and payable (§5.1's `available`).
 *
 * This is the set the old code spelled `['released', 'paid_out']`, and it is
 * the one to reach for when the question is "has this deal's money moved yet",
 * because that question now has four answers.
 */
export const PAST_HOLD_STATUSES: readonly DealStatus[] = [
  'clearing',
  'released',
  'payout_pending',
  'paid_out',
]

/** Statuses no further transition can leave. */
export const TERMINAL_STATUSES: readonly DealStatus[] = [
  'paid_out',
  'refunded',
  'expired',
  'canceled',
]

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
  currency: Currency
  /**
   * What the buyer is actually charged, when their market cannot be charged in
   * the settlement currency. Equal to `currency`/`amount` when no conversion
   * is needed.
   */
  presentment_currency: Currency
  presentment_amount: Money
  /** Units of presentment per unit of settlement, locked when the buyer paid. */
  fx_rate: number | null
  deposit_amount: Money | null
  buyer_country: Country
  provider: Provider
  payment_method: PaymentMethod | null
  payment_network: string | null
  provider_ref: string | null
  status: DealStatus
  expected_complete_at: Timestamp | null
  auto_release_at: Timestamp | null
  released_at: Timestamp | null
  payout_due_at: Timestamp | null
  fee_amount: Money
  /**
   * §7's itemisation, all in the **presentment** currency — what the buyer is
   * charged. `amount` and `fee_amount` are settlement; do not add the two sets
   * together.
   *
   * These are what a checkout shows *before* payment. What actually happened is
   * `DealAmounts`, derived from the ledger.
   */
  tax_amount: Money
  discount_amount: Money
  /** What the rail charged. Zero until the provider reports it at funding. */
  provider_fee_amount: Money
  /** §6.1's new-seller carve-out, decided at release. Zero when none applies. */
  reserve_amount: Money
  reserve_until: Timestamp | null
  completion_policy: CompletionPolicy
  confirmations: Confirmation[]
  metadata: Record<string, string>
  created_at: Timestamp
  updated_at: Timestamp
}

// ---------------------------------------------------------------------------
// Sellers and payouts
// ---------------------------------------------------------------------------

/**
 * The rail a destination is tokenized against, which is provider and method
 * together — a MoMo token means nothing to a bank transfer.
 *
 * The last five are **declared and disabled** (spec §29.3). Their routes name
 * an adapter that is not built — `paypal` carries Venmo too,
 * `china_wallet_partner` carries both Chinese wallets — and a trigger refuses
 * to enable a route whose adapter is not live in `provider_capabilities`. They
 * exist so a seller who picks one is told why it will not work rather than
 * told nothing.
 */
export type PayoutProvider =
  | 'flutterwave_momo'
  | 'flutterwave_bank'
  | 'stripe_connect'
  | 'paypal'
  | 'venmo'
  | 'cash_app_pay'
  | 'alipay'
  | 'wechat_pay'

/** §5.1's "selected method", in the shape a seller recognises. */
export type PayoutMethod = 'mobile_money' | 'bank_account' | 'wallet'

/** §5.1's `route.riskStatus`. Only `approved` is eligible. */
export type RouteRiskStatus = 'approved' | 'review' | 'suspended'

/**
 * §5.1's routing table — **data, not code**. Which rails exist, where they
 * reach, and whether they are on. §12 requires a country or a provider to be
 * disabled without a redeploy, which is why this is a row.
 *
 * `tenant_id: null` is the platform default for that rail. A tenant row
 * *replaces* it rather than sitting beside it.
 */
export interface PayoutRoute {
  id: string
  tenant_id: string | null
  payout_provider: PayoutProvider
  /**
   * The adapter that talks to this rail's API. One adapter carries several
   * rails. Whether it is *built* is `ProviderCapability.implemented`, not a
   * null here — and a route cannot be enabled while it is not.
   */
  provider: Provider
  method: PayoutMethod
  countries: Country[]
  currencies: Currency[]
  supports_payouts: boolean
  enabled: boolean
  risk_status: RouteRiskStatus
  /** Lower wins. §5.1's "reliability", made explicit rather than implied. */
  rank: number
  min_amount: Money
  max_amount: Money | null
  fee_fixed: Money
  fee_bps: number
  note: string | null
  created_at: Timestamp
}

/**
 * Why a route was or was not eligible. `routed` is the success case; the rest
 * come from `route_evaluation`'s filter chain, in the order it applies them.
 */
export type RouteReasonCode =
  | 'routed'
  | 'provider_disabled'
  | 'route_suspended'
  | 'route_under_review'
  | 'payouts_not_supported'
  | 'country_not_supported'
  | 'currency_not_supported'
  | 'below_route_minimum'
  | 'above_route_maximum'
  | 'destination_not_verified'
  | 'no_eligible_verified_destination'
  | 'no_route_for_destination'

/**
 * §5.1: a payout decision must be "deterministic and auditable" — the selected
 * provider, selected method, eligibility checks, ranking score, currency, fees,
 * exchange-rate source and reason code, kept after the fact.
 */
export interface PayoutDecision {
  id: string
  tenant_id: string
  payout_id: string
  /** Null on a no-route decision: there was nothing to select. */
  route_id: string | null
  destination_id: string | null
  provider: Provider | null
  payout_provider: PayoutProvider | null
  method: PayoutMethod | null
  currency: Currency | null
  amount: Money | null
  ranking_score: number | null
  fee_estimate: Money | null
  /** Null when no conversion happened, which is what §5.1 prefers. */
  fx_source: 'deal_locked_rate' | 'payhold_indicative' | null
  fx_rate: number | null
  /** True only on a backup destination, which §5.1 requires be logged. */
  is_fallback: boolean
  reason_code: RouteReasonCode
  /** Every route considered and its verdict. */
  checks: RouteCheck[]
  created_at: Timestamp
}

export interface RouteCheck {
  route_id: string
  provider: Provider | null
  payout_provider: PayoutProvider
  method: PayoutMethod
  rank: number
  fee_estimate: Money
  /** Whether this is the rail the destination is tokenized against. */
  preferred: boolean
  eligible: boolean
  reason_code: RouteReasonCode
}

/**
 * §5.1: a seller has a preferred destination and may have a verified backup,
 * which one pair of columns on `sellers` could not express.
 */
export interface SellerDestination {
  id: string
  tenant_id: string
  seller_id: string
  label: string | null
  country: Country
  payout_currency: Currency
  payout_provider: PayoutProvider
  beneficiary_token: string
  masked_destination: string
  is_primary: boolean
  /** Used only after a failed primary payout and an explicit policy check. */
  is_backup: boolean
  /** Null means ownership has not been confirmed. */
  verified_at: Timestamp | null
  /** §5.1's change protection: a newly added destination waits. */
  security_hold_until: Timestamp | null
  created_at: Timestamp
}

export interface Seller {
  id: string
  tenant_id: string
  name: string
  country: Country
  payout_currency: Currency
  payout_provider: PayoutProvider
  /** Provider-side token. PayHold never stores the real destination. */
  beneficiary_token: string
  masked_destination: string
  /**
   * §12's onboarding state. A seller starts `pending` and cannot be paid until
   * somebody attests that the identity check, the sanctions screen and the
   * ownership check came back.
   */
  kyc_status: KycStatus
  external_user_id: string | null
  sanctions_checked_at: Timestamp | null
  destination_changed_at: Timestamp | null
  created_at: Timestamp
}

/** §12's state list, verbatim. */
export type KycStatus =
  | 'pending'
  | 'verified'
  | 'restricted'
  | 'rejected'
  | 'review_required'

/**
 * What is actually true of a payout row. Six of these are stops, and they are
 * separate because who can end them differs:
 *
 *   `frozen`              the whole tenant is stopped on reconciliation drift.
 *   `held_for_review`     a discretionary rule, or a person, stopped this one.
 *                         `approve_payout_review` is the only way out and it
 *                         records a name. A machine may never clear it.
 *   `needs_verification`  §12: the seller has something outstanding. The way
 *                         out is `verify_seller`, an attestation with somebody
 *                         behind it — deliberately *not* the approve button.
 *   `blocked`             §5.1's no-route case, and a disputed deal. Nothing to
 *                         approve and nothing for the seller to fix; it moves
 *                         when some other fact does.
 */
export type PayoutStatus =
  | 'scheduled'
  | 'processing'
  | 'paid'
  | 'failed'
  | 'frozen'
  | 'held_for_review'
  | 'needs_verification'
  | 'blocked'

/**
 * §5.1's seller-facing vocabulary, **derived** rather than stored.
 *
 * `clearing` and `available` are questions about the deal's window, which the
 * deal's own status already answers; storing them on the payout would be one
 * fact with two writers. `frozen` and `held_for_review` both read as `blocked`
 * here — to a seller they are the same thing, and pointing at a review queue
 * invites them to fix something that is not theirs to fix.
 */
export type PayoutDisplayStatus =
  | 'clearing'
  | 'available'
  | 'processing'
  | 'paid'
  | 'failed'
  | 'blocked'
  | 'needs_verification'

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
  /**
   * Why this payout is not moving — a provider's refusal, or the routing
   * engine's sentence when it is `blocked`. Surfaced in the dashboard for
   * triage.
   */
  failure_reason: string | null
  attempts: number
  /**
   * When a machine may next attempt this payout — §13's capped backoff.
   * **Null means never**: the retry budget is spent and only a person can send
   * it again, which is how "then move to blocked for operator action" is said
   * without a second status meaning "blocked, but really blocked".
   */
  next_attempt_at?: Timestamp | null
  /** The provider's transfer reference, set once it has one. */
  provider_ref?: string | null
  /** §5.1: which destination this payout actually went to. */
  destination_id?: string | null
  /** When it was stopped — by a rule, or by a person. */
  review_held_at?: Timestamp | null
  /** Who stopped it. Null means a rule did; the signals are in `risk_signals`. */
  review_held_by?: string | null
  /** Their reason, in their own words. Null for a rule hold. */
  review_hold_reason?: string | null
  /** Who let it through. Either kind of hold, only ever a person. */
  review_approved_by?: string | null
  review_approved_at?: Timestamp | null
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

export type LedgerEntryType =
  | 'hold'
  | 'release'
  | 'refund'
  /** PayHold's commission. Reclassified, not moved — see `Balance.fees_retained`. */
  | 'fee'
  /** What the rail charged. Unlike `fee`, this genuinely left the balance. */
  | 'provider_fee'
  /** Collected from the buyer and owed onward. Never the seller's. */
  | 'tax'
  /** §6.1's new-seller carve-out, taken out of the clearing pool. */
  | 'reserve'
  /** The carve-out returned. The only credit among the deductions. */
  | 'reserve_release'
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

/**
 * The six buckets, per currency. V2 §7 added two, and both are money that is
 * still physically with the provider:
 *
 * `reserved` — §6.1's new-seller carve-out. Taken out of the clearing pool so
 * it cannot be paid, without leaving the vault.
 *
 * `fees_retained` — our commission and collected tax. They have stopped being
 * the seller's, but nothing sweeps them out of the tenant's own provider
 * balance, so a reconciliation pass that ignored them reported drift equal to
 * the fee on every released deal.
 *
 * `paid_out` is the only bucket describing money that has actually gone.
 */
export interface Balance {
  currency: Currency
  held: Money
  pending_clearance: Money
  available: Money
  reserved: Money
  fees_retained: Money
  paid_out: Money
}

/** The same six buckets, split by the rail actually holding the money. */
export interface RailBalance extends Balance {
  provider: Provider
}

/**
 * §7's price breakdown for one deal, derived from the ledger and never stored.
 * All figures are in the **presentment** currency — what the buyer was charged.
 *
 * On an unfunded deal every figure is zero: this describes money that moved.
 * The estimate a checkout shows *before* payment comes from the deal's own
 * columns instead.
 */
export interface DealAmounts {
  currency: Currency
  /** What actually arrived from the buyer. */
  buyer_paid: Money
  platform_fee: Money
  /** What the rail took. Unlike the platform fee, this really left. */
  provider_fee: Money
  tax: Money
  /** Currently carved out and unpayable; returns to `seller_net` when it ends. */
  reserve: Money
  refunded: Money
  paid_out: Money
  /** Still owed to the seller and sendable. */
  seller_net: Money
}

// ---------------------------------------------------------------------------
// Disputes, tenant, settings, keys, audit
// ---------------------------------------------------------------------------

export type DisputeStatus = 'open' | 'resolved_released' | 'resolved_refunded'

export interface Dispute {
  id: string
  tenant_id: string
  deal_id: string
  raised_by: ConfirmSide
  reason: string
  status: DisputeStatus
  opened_at: Timestamp
  resolved_at: Timestamp | null
  resolution_note: string | null
}

export type TenantStatus = 'active' | 'suspended' | 'payouts_frozen'

export interface Tenant {
  id: string
  name: string
  slug: string
  status: TenantStatus
  created_at: Timestamp
}

/*
 * Settings live in `_shared/settings.ts`, type and defaults together.
 *
 * They used to be declared here with a copy of the documented defaults, and the
 * copy went stale: `clearance_days` stayed at V1's 7 while every SQL reader
 * moved to §6.1's 14. A default that nothing reads is a default that cannot be
 * caught being wrong, so there is now one spec and both views derive from it.
 */

export interface ApiKey {
  id: string
  tenant_id: string
  label: string
  masked_key: string
  created_at: Timestamp
  revoked_at: Timestamp | null
  last_used_at: Timestamp | null
}

export interface WebhookEndpoint {
  id: string
  tenant_id: string
  url: string
  masked_secret: string
  created_at: Timestamp
  disabled_at: Timestamp | null
}

export interface AuditLogEntry {
  id: string
  tenant_id: string
  deal_id: string | null
  actor: string
  action: string
  details: Record<string, unknown>
  created_at: Timestamp
}

export interface ReconciliationAlert {
  id: string
  tenant_id: string
  provider: Provider
  currency: Currency
  ledger_balance: Money
  provider_balance: Money
  drift: Money
  detected_at: Timestamp
  resolved_at: Timestamp | null
}

// ---------------------------------------------------------------------------
// Request payloads
// ---------------------------------------------------------------------------

/**
 * §14's per-deal completion policy. Every field is nullable and falls back to
 * the tenant's settings, so a client that sends nothing behaves exactly as it
 * did before V2.
 *
 * It is locked at creation, not read live: §27 says in-flight deals keep the
 * settings they were created with, and a rental whose clearance window moved
 * under it mid-trip is the exact surprise that rule exists to prevent.
 */
export interface CompletionPolicy {
  /** The client's own name for the event that ends the work — `vehicle_returned`. */
  completion_event: string | null
  /** Hours of buyer silence after delivery before the timer confirms for them. */
  auto_complete_after_hours: number | null
  /** Days between release and payout. Overrides the tenant's `clearance_days`. */
  clearing_days: number | null
}

export interface CreateDealInput {
  buyer_ref: string
  seller_id: string
  description: string
  amount: Money
  currency: Currency
  buyer_country?: Country
  deposit_amount?: Money
  expected_complete_at?: Timestamp
  completion_policy?: Partial<CompletionPolicy>
  /** §7, presentment currency. The client knows its own tax rules; we do not. */
  tax_amount?: Money
  discount_amount?: Money
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
  payout_currency?: Currency
  payout_provider: PayoutProvider
  /** Raw destination — tokenized immediately, never stored. */
  destination: string
  /**
   * §11's external user id: the client's own handle for this person, so their
   * system can find this seller again. Unique per tenant where supplied, which
   * is what makes a retried registration safe.
   */
  external_user_id?: string
}

/**
 * §5.1: a further destination for a seller who already has one.
 *
 * Country and currency are optional because a seller changing rails has not
 * changed country — omitted, they are taken from the seller's own row rather
 * than restated by a caller who could restate them wrongly.
 */
export interface AddDestinationInput {
  payout_provider: PayoutProvider
  /** Raw destination — tokenized immediately, never stored. */
  destination: string
  country?: Country
  payout_currency?: Currency
  label?: string
  /** 'primary' moves where the money goes. Defaults to primary. */
  role?: 'primary' | 'backup'
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

/** HTTP status for each error code, so handlers never pick one by hand. */
export const ERROR_STATUS: Record<PayHoldErrorCode, number> = {
  not_found: 404,
  invalid_state: 409,
  policy_violation: 422,
  insufficient_balance: 409,
  unauthorized: 401,
}
