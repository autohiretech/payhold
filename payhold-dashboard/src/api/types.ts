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

export type Currency =
  | 'RWF'
  | 'KES'
  | 'UGX'
  | 'TZS'
  | 'GHS'
  | 'NGN'
  | 'USD'
  | 'EUR'

/** ISO-8601 timestamp. */
export type Timestamp = string

export type Provider = 'flutterwave' | 'stripe' | 'fake'

/** How the buyer actually pays. Determines which rail the charge routes to. */
export type PaymentMethod =
  | 'card'
  | 'mtn_momo'
  | 'airtel_money'
  | 'mpesa'
  | 'bank_transfer'

/**
 * Where the buyer or seller is. Drives rail selection: the same method routes
 * to a different provider — or is unavailable — depending on the market.
 * `INTL` covers everywhere PayHold does not have a local rail.
 */
export type Country = 'RW' | 'KE' | 'UG' | 'TZ' | 'GH' | 'NG' | 'ZA' | 'INTL'

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
  amount: Money
  currency: Currency
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
  | 'flutterwave_mpesa'
  | 'flutterwave_bank'
  | 'stripe_connect'

export interface Seller {
  id: string
  tenant_id: string
  name: string
  /** Where the seller banks. Decides which rail can actually pay them. */
  country: Country
  payout_provider: PayoutProvider
  /** Provider-side token. PayHold never stores the real destination. */
  beneficiary_token: string
  /** Display-safe, e.g. "MTN •••• 4821". */
  masked_destination: string
  created_at: Timestamp
}

export type PayoutStatus = 'scheduled' | 'processing' | 'paid' | 'failed' | 'frozen'

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
  status: DisputeStatus
  opened_at: Timestamp
  resolved_at: Timestamp | null
  resolution_note: string | null
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
// Master-admin
// ---------------------------------------------------------------------------

export interface ReconciliationAlert {
  id: string
  tenant_id: string
  currency: Currency
  /** What our ledger says the provider should be holding. */
  ledger_balance: Money
  /** What the provider actually reports. */
  provider_balance: Money
  /** provider − ledger. Non-zero is the alert. */
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
