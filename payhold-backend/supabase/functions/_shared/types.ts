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

export type Provider = 'flutterwave' | 'stripe' | 'fake'

/**
 * How the buyer pays, at the level the rail cares about. The specific wallet —
 * MTN, M-Pesa, Wave — is a `payment_network`, not a method.
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
  country: Country
  payout_currency: Currency
  payout_provider: PayoutProvider
  /** Provider-side token. PayHold never stores the real destination. */
  beneficiary_token: string
  masked_destination: string
  created_at: Timestamp
}

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
  held: Money
  pending_clearance: Money
  available: Money
  paid_out: Money
}

/** The same four buckets, split by the rail actually holding the money. */
export interface RailBalance extends Balance {
  provider: Provider
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

export interface TenantSettings {
  tenant_id: string
  service_fee_rate: number
  buyer_fee: Money
  clearance_days: number
  auto_release_days: number
  currencies: Currency[]
}

/** The documented defaults — spec §8. A tenant missing a row behaves like this. */
export const DEFAULT_SETTINGS: Omit<TenantSettings, 'tenant_id' | 'currencies'> = {
  service_fee_rate: 0.1,
  buyer_fee: 0,
  clearance_days: 7,
  auto_release_days: 3,
}

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

export interface CreateDealInput {
  buyer_ref: string
  seller_id: string
  description: string
  amount: Money
  currency: Currency
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

/** HTTP status for each error code, so handlers never pick one by hand. */
export const ERROR_STATUS: Record<PayHoldErrorCode, number> = {
  not_found: 404,
  invalid_state: 409,
  policy_violation: 422,
  insufficient_balance: 409,
  unauthorized: 401,
}
