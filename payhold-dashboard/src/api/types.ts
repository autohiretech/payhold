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
 * How the buyer pays, at the level the rail cares about.
 *
 * The specific wallet — MTN, M-Pesa, Wave — is a `payment_network`, not a
 * method: there are a dozen of them across ten countries and they all behave
 * identically to the engine.
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
  /**
   * Installment billing. Null means "charge it all now" — today's default,
   * unaffected. When set, `presentment_amount` is the FIRST installment
   * only; `balance_amount` is what's still owed, charged automatically the
   * moment the rental is confirmed returned.
   */
  split_percent: number | null
  /** What's still owed after the first charge. Zero once collected. */
  balance_amount: Money | null
  balance_provider_ref: string | null
  /**
   * A per-unit price and unit length (seconds) for a late-return surcharge —
   * e.g. 3600 for hourly, 86400 for daily. Charged only when confirmed
   * returned after `expected_complete_at`. Independent of `split_percent`.
   */
  overage_rate: Money | null
  overage_unit_seconds: number | null
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

export interface Seller {
  id: string
  tenant_id: string
  name: string
  /**
   * Null until a destination is registered. A seller can exist — and accrue
   * `held`/`available` money — before they have one; `seller_capabilities`
   * reports `'No payout destination has been registered'` in `reasons` until
   * `addSellerDestination` gives them one.
   */
  country: Country | null
  /** What they want to be paid in. Local by default; foreign changes the rail. */
  payout_currency: Currency | null
  payout_provider: PayoutProvider | null
  /** Provider-side token. PayHold never stores the real destination. */
  beneficiary_token: string | null
  /** Display-safe, e.g. "MTN •••• 4821". */
  masked_destination: string | null
  /**
   * §12's onboarding state. A seller starts `pending` and cannot be paid until
   * somebody attests that the identity check, the sanctions screen and the
   * ownership check came back — `POST /v1/sellers/:id/verify`, which refuses an
   * API key for the same reason clearing a risk hold does.
   */
  kyc_status: KycStatus
  /** The client's own handle for this person. PayHold mints no seller identity. */
  external_user_id: string | null
  /** Not a boolean: the question is "recently enough", not "ever". */
  sanctions_checked_at: Timestamp | null
  /** §5.1's change protection. A recent move holds the next payout. */
  destination_changed_at: Timestamp | null
  /**
   * Whether this seller is currently one of the tenant's active sellers, as
   * opposed to someone who used to be. Status only — it carries no weight on
   * the payout path. Defaults `true`.
   */
  active: boolean
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
  /**
   * §12: the seller has something outstanding. The way out is a verification
   * with somebody's name on it — deliberately *not* the approve button, which
   * would be an operator waving through the check §12 exists to require.
   */
  | 'needs_verification'
  /**
   * §5.1's no-route case, and a disputed deal. Nothing to approve and nothing
   * for the seller to fix; it moves when some other fact does.
   */
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
   * When a machine may next attempt this payout — §13's capped backoff, on the
   * same 1m / 5m / 30m / 2h ladder the webhook dispatcher uses.
   *
   * **Null means never**: the retry budget is spent and only a person can send
   * it again. That is how "then move to blocked for operator action" is said
   * without a second status meaning "blocked, but really blocked".
   */
  next_attempt_at: Timestamp | null
  /** The provider's transfer reference, set once it has one. */
  provider_ref?: string | null
  /** §5.1: which destination this payout actually went to. */
  destination_id?: string | null
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
// Hosted checkout — §10.1
// ---------------------------------------------------------------------------

/**
 * A scoped, expiring credential for one payment on one deal.
 *
 * It exists so a buyer can choose a payment method **without holding an API
 * key** and without the client's server proxying the choice — and without
 * anyone inventing a general end-user auth scheme to get there.
 *
 * `expired` is absent from the stored status and derived from `expires_at`,
 * the same way §5.1's `clearing` and `available` come from the deal's window: a
 * stored value would need a writer, and the writer would be a sweep that had
 * not run yet.
 */
export type CheckoutSessionStatus = 'open' | 'completed' | 'canceled'

/** What a reader sees, with expiry worked out. */
export type CheckoutSessionState = CheckoutSessionStatus | 'expired'

export interface CheckoutSession {
  id: string
  tenant_id: string
  deal_id: string
  /**
   * The bearer token in the hosted page's URL. 256 bits, expiring, and
   * authorising exactly one action — pay this one deal.
   */
  token: string
  status: CheckoutSessionStatus
  /** Held on the session so a tampered return_url cannot be injected later. */
  return_url: string | null
  /** What the buyer chose. Null until they choose. */
  method: PaymentMethod | null
  network: string | null
  provider: Provider | null
  provider_ref: string | null
  payment_link: string | null
  expires_at: Timestamp
  completed_at: Timestamp | null
  created_at: Timestamp
}

/**
 * What a stranger holding a payment link is allowed to see.
 *
 * Curated by hand rather than by spreading the deal, and that is the point:
 * whoever opens this is unauthenticated, so `buyer_ref`, the fee breakdown, the
 * tenant's other business and the seller's payout details are absent because
 * they were never added — not because something stripped them.
 */
export interface PublicCheckout {
  status: CheckoutSessionState
  expires_at: Timestamp
  deal: {
    id: string
    description: string
    amount: Money
    currency: Currency
    status: DealStatus
  }
  seller: { name: string | null }
  /**
   * Only rails that are open in this market and live right now — §29.11.
   *
   * `amount` is what choosing that method charges today, and it is not
   * always `deal.amount`: a split deal offers a method with no reusable
   * credential (mobile money, a wallet, a bank transfer) at its full price
   * instead of the first installment, because that method could never fund
   * the second charge later. Card still shows the installment.
   */
  methods: {
    method: PaymentMethod
    label: string
    provider: Provider
    networks: string[]
    amount: Money
  }[]
}

/**
 * What the buyer has to do next, mirrored field-for-field from the backend's
 * `ChargeNextAction` (`_shared/provider.ts`) — see that file for the full
 * argument. Only `wait`, `otp` and `redirect` are handled on this page today:
 * that is everything Flutterwave's direct mobile money charge can return.
 * The rest exist so a future method (card's own `element`, a wallet's
 * `wallet_approval`, …) fails closed to `redirect` rather than the type
 * silently not compiling.
 */
export type ChargeNextAction =
  | { type: 'wait'; message: string }
  | { type: 'otp'; reference: string; message: string }
  | { type: 'pin'; message: string }
  | { type: 'avs'; message: string; fields: string[] }
  | {
    type: 'wallet_approval'
    provider: Provider
    client_id: string
    order: string
    currency: Currency
    approval_url: string
  }
  | {
    type: 'transfer'
    account: string
    bank: string
    amount: string
    reference: string
    expires_at: string | null
    note: string | null
  }
  | { type: 'redirect'; url: string }
  | {
    type: 'payment_element'
    provider: Provider
    publishable_key: string
    client_secret: string
    return_url: string
  }
  | {
    type: 'element'
    provider: Provider
    public_key: string
    reference: string
    amount: Money
    currency: Currency
    options: string[]
    redirect_url: string
  }

// ---------------------------------------------------------------------------
// Payout routing — §5.1's Routing Center
// ---------------------------------------------------------------------------

/** §5.1's "selected method", in the shape a seller recognises. */
export type PayoutMethod = 'mobile_money' | 'bank_account' | 'wallet'

/** §5.1's `route.riskStatus`. Only `approved` is eligible. */
export type RouteRiskStatus = 'approved' | 'review' | 'suspended'

/**
 * §5.1's routing table — **data, not code**. Which rails exist, where they
 * reach, and whether they are on. §12 requires a country or a provider to be
 * disabled without a redeploy, which is why this is a row rather than a branch.
 *
 * `tenant_id: null` is the platform default for that rail. A tenant row
 * *replaces* it rather than sitting beside it — otherwise a tenant switching a
 * rail off would leave the platform's enabled row still eligible.
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
 * come from the filter chain, in the order §5.1's pseudocode applies them.
 */
export type RouteReasonCode =
  | 'routed'
  /** §12: we have closed this market. Ahead of every rail reason. */
  | 'market_closed'
  /** §9: the adapter is unbuilt, or switched off. */
  | 'provider_unavailable'
  /** This corridor was switched off, on a rail that is otherwise live. */
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

/**
 * §9: "each adapter declares its capabilities rather than letting the UI
 * guess." This is the row behind that — the database half of the backend's
 * `ProviderCapabilities`, and the two must agree.
 *
 * `implemented` and `enabled` are separate because they fail differently: an
 * unbuilt adapter is a roadmap item, a disabled one is an outage or a
 * commercial decision, and an operator needs to tell those apart at 3am.
 */
export interface ProviderCapability {
  provider: Provider
  implemented: boolean
  enabled: boolean
  supports_capture: boolean
  supports_partial_refund: boolean
  supports_marketplace_payout: boolean
  supports_seller_onboarding: boolean
  supports_dispute: boolean
  supports_local_currency: boolean
  supports_mobile_money: boolean
  supports_async_refund: boolean
  /** Why it is off, or what is missing. For an operator, never for a buyer. */
  note: string | null
}

/**
 * §12's country switch: a market closed without a redeploy.
 *
 * An **overlay**, not a copy of the registry. A country with no row behaves as
 * `lib/countries.ts` says — collectable unless sanctioned, payable if a route
 * reaches it. A row is a deliberate departure, and carries the reason, because
 * "why can nobody in Kenya pay us" is asked three months after whoever switched
 * it off has forgotten.
 */
export interface MarketClosure {
  id: string
  /** Null is the platform default; a tenant row replaces it. */
  tenant_id: string | null
  country: Country
  collect: boolean
  payout: boolean
  reason: string
  created_at: Timestamp
}

/**
 * §16's launch checklist — what must be true before PayHold takes live money.
 *
 * Two kinds of item, and only one of them is a signature. Most are
 * **attestations**: a person states that a thing was done, with their name and
 * a pointer to the evidence, because no code can check whether a lawyer
 * incorporated a company. The `engineering` ones have acceptance in code, and
 * those that are not built yet carry `blocked_by` — which makes them
 * unsignable, by anybody, until the work lands.
 */
export type LaunchItemKind = 'legal' | 'provider' | 'operational' | 'engineering'

/** The item itself — `launch_checklist`, seeded by migration and changed by one. */
export interface LaunchChecklistItem {
  /** Stable and referenced by the endpoint. Not a uuid. */
  code: string
  title: string
  /** What signing this actually claims. */
  detail: string
  kind: LaunchItemKind
  /** Set on §16's four per-market payout confirmations; null on the rest. */
  market: Country | null
  /** Does the gate wait for it? */
  required: boolean
  /** The unbuilt work in the way, or null. Blocked items cannot be signed. */
  blocked_by: string | null
}

/**
 * The item with its current state — `launch_status()`.
 *
 * Separate from the row for the reason the SQL keeps them separate: the state
 * is the latest sign-off, derived, and a stored flag would need a writer that
 * is already writing the event.
 */
export interface LaunchItem extends LaunchChecklistItem {
  signed: boolean
  signed_by: string | null
  signed_at: Timestamp | null
  evidence: string | null
}

/**
 * The checklist, plus the gate derived from it.
 *
 * `live_mode_allowed` is not a stored flag: it is "no required item is
 * outstanding", answered off the same rows the caller is looking at. Two round
 * trips that could disagree would be two answers to one question.
 */
export interface LaunchChecklist {
  live_mode_allowed: boolean
  outstanding: number
  /** Of those, how many nobody *can* sign yet. */
  blocked: number
  items: LaunchItem[]
}

/**
 * One statement, appended. Withdrawing a sign-off is a new row saying so, never
 * an edit — "who said this was fine, and when did they stop saying it" is
 * exactly the question asked after something goes wrong.
 */
export interface LaunchSignOff {
  id: string
  code: string
  signed: boolean
  actor: string
  evidence: string
  created_at: Timestamp
}

/**
 * §5.1: a seller has a preferred destination and may have a verified backup,
 * which one pair of columns on `sellers` could not express.
 *
 * `Seller.beneficiary_token` and `masked_destination` remain as the primary's
 * copy, kept in step by the backend's trigger; this table is the record.
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

/**
 * §10.1's `GET /v1/sellers/:id/capabilities` — can this seller be paid, and if
 * not, what is missing. The same questions the eligibility gate asks, asked
 * ahead of time, so a seller fixes it during onboarding rather than discovering
 * it as a held payout three weeks later.
 *
 * **The two lists stay separate because the answers do.** `reasons` is what the
 * seller has to go and do, and every one of them holds a payout.
 * `route_reasons` is what PayHold cannot yet reach, and none of them do: a
 * routing failure in the first list would make an unroutable payout
 * `needs_verification`, hide it from the routing engine, and tell a verified
 * seller to verify themselves again.
 */
export interface SellerCapabilities {
  seller_id: string
  can_receive_payouts: boolean
  kyc_status: KycStatus
  reasons: string[]
  route_reasons: string[]
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
  /**
   * §12's eligibility gate — unverified identity, stale sanctions screening, an
   * unverified or newly moved destination, an open dispute.
   *
   * The odd one out, and deliberately so: the others are discretionary and sit
   * behind `risk_rules_enabled`. This one is not, because a tenant switching
   * the rules off must not thereby start paying sellers it has never verified.
   */
  | 'not_eligible'

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
  /** §7.1.4: what the seller owes us. Not money at a provider. */
  | 'receivable'
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
 * Six buckets, per currency. V2 §7 added `reserved` and `fees_retained`, and
 * both describe money that is still physically with the provider — only
 * `paid_out` has actually gone.
 */
export interface Balance {
  currency: Currency
  /** Funds in the vault against unreleased deals. */
  held: Money
  /** Released but still inside the clearance window. */
  pending_clearance: Money
  /** Cleared and payable now. */
  available: Money
  /**
   * §6.1's new-seller carve-out: taken out of the clearing pool so it cannot be
   * paid, without leaving the vault. Returns to the pool when the hold ends.
   */
  reserved: Money
  /**
   * Our commission and collected tax. They have stopped being the seller's, but
   * nothing sweeps them out of the tenant's own provider balance — under
   * bring-your-own-keys there is no such transfer. A reconciliation pass that
   * ignored them reported drift equal to the fee on every released deal.
   */
  fees_retained: Money
  /** Lifetime total already sent to sellers. */
  paid_out: Money
}

/**
 * One seller's money, in the currency the buyer was charged.
 *
 * The same buckets as `Balance` and derived from the same ledger, grouped by
 * seller instead of by rail — every seller's wallet summed is the tenant's own
 * balance, bucket for bucket.
 *
 * **`fees_retained` is deliberately absent.** Our commission and collected tax
 * stopped being the seller's, and a wallet is a screen the seller is shown.
 *
 * **`held` is gross; everything past it is net.** Nothing is struck inside the
 * hold — the fee is booked at release — so a client must render `held` as "in
 * progress" rather than as the seller's money. `DealAmounts.seller_net` is what
 * a held deal is actually worth to them.
 */
export interface SellerWallet {
  seller_id: string
  seller_name: string
  seller_country: Country
  currency: Currency
  /** Buyer money still in the hold on this seller's deals. Not yet theirs. */
  held: Money
  /** Released and inside the clearance window. Theirs, not yet payable. */
  pending_clearance: Money
  /** Past the window. Theirs, and payable now. */
  available: Money
  /** §6.1's new-seller carve-out, unpayable until the hold ends. */
  reserved: Money
  /** Lifetime total already sent to this seller. */
  paid_out: Money
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
  /**
   * §7.1.4. Owed to us by the seller after a refund that followed their payout.
   * In no balance bucket: the buckets say what a provider is holding, and no
   * provider is holding this.
   */
  receivable: Money
  paid_out: Money
  /** Still owed to the seller and sendable. */
  seller_net: Money
}

/**
 * The same six buckets, split by the rail actually holding the money.
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

export type DisputeStatus =
  | 'open'
  | 'resolved_released'
  | 'resolved_refunded'
  /** §7.1 made a split executable, so a dispute can now end in one. */
  | 'resolved_split'

export type RefundStatus = 'pending' | 'succeeded' | 'failed'

/**
 * §11's `refunds`. A refund is a record with a lifetime, not a ledger entry:
 * §7.1.6 has Alipay and WeChat Pay settling asynchronously, up to 90 days out.
 */
export interface Refund {
  id: string
  tenant_id: string
  deal_id: string
  /** Presentment currency — a refund goes back the way the money came. */
  amount: Money
  currency: Currency
  reason: string
  /** The client's own breakdown of what they are giving back. Not interpreted. */
  line_items: unknown
  status: RefundStatus
  /** §7.1.5 requires an actor on every refund. */
  actor: string
  created_at: Timestamp
  settled_at: Timestamp | null
}

/**
 * §8's structured reason codes. The free-text `reason` stays alongside rather
 * than being replaced: a code is what a query groups by, a sentence is what a
 * person needs to read.
 */
export type DisputeReasonCode =
  | 'not_delivered'
  | 'not_as_described'
  | 'damaged'
  | 'late_delivery'
  | 'quality'
  | 'incomplete'
  | 'unauthorized_charge'
  | 'duplicate_charge'
  | 'cancellation_requested'
  | 'other'

/** §8's five requests. Only the last three can move money. */
export type DisputeOfferKind =
  | 'update'
  | 'extension'
  | 'cancellation'
  | 'partial_refund'
  | 'full_refund'

/**
 * `expired` is not `declined`, and the difference is who ended it. Declining is
 * an act — somebody read it and said no. Expiring is silence, and §24.3's
 * labels cannot be backfilled, so collapsing the two loses it permanently.
 */
export type DisputeOfferStatus =
  | 'open'
  | 'accepted'
  | 'declined'
  | 'withdrawn'
  | 'expired'

export interface Dispute {
  id: string
  tenant_id: string
  deal_id: string
  raised_by: ConfirmSide
  raised_by_actor: string | null
  reason: string
  reason_code: DisputeReasonCode
  /**
   * Presentment minor units, or null for the whole payment. It is a ceiling on
   * the resolution: only this much may be taken from the seller, so a complaint
   * about a third cannot quietly become a full refund.
   */
  disputed_amount: Money | null
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
  /** §8's final decision record. `both-parties` when the two sides agreed. */
  decided_by: string | null
}

export interface DisputeEvidence {
  side: ConfirmSide
  kind: 'photo' | 'inspection_photo' | 'document' | 'message' | 'checkin' | 'other'
  /** What it shows. This, not the image, is what the assistant is given. */
  description: string
  /** Where the client site serves it. Null when they sent only a description. */
  url: string | null
  /**
   * When the photo was taken, as distinct from when it was uploaded. An
   * inspection photo from handover is worth more than one from after the
   * complaint, and only this field can tell them apart.
   */
  captured_at: Timestamp | null
  submitted_at: Timestamp
}

/**
 * A request from one party to the other. §8 gives the other side 48 hours;
 * silence **lapses** it and never accepts it, because a clock that refunded a
 * buyer or paid a seller would be a machine deciding.
 */
export interface DisputeOffer {
  id: string
  tenant_id: string
  dispute_id: string
  deal_id: string
  offered_by: ConfirmSide
  offered_by_actor: string
  kind: DisputeOfferKind
  /** Presentment minor units. Only ever set for `partial_refund`. */
  amount: Money | null
  /** Only for `extension`: the new date being asked for. */
  extend_to: Timestamp | null
  note: string | null
  status: DisputeOfferStatus
  expires_at: Timestamp
  created_at: Timestamp
  responded_at: Timestamp | null
  responded_by_actor: string | null
}

/** One ordered list of everything that happened — §8's timeline view. */
export interface DisputeTimelineEvent {
  at: Timestamp
  kind: string
  actor: string
  side: ConfirmSide | null
  summary: string
  details: Record<string, unknown>
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
  /** Days between release and payout eligibility. Default 14 — §6.1, §29.7. */
  clearance_days: number
  /** Days after expected completion before auto-release fires. Default 3. */
  auto_release_days: number
  /**
   * §6.1's new-seller reserve. A fraction of each release held back, and the
   * extra days it is held for.
   *
   * Absent or zero means off, which is the default: a reserve is a real cost to
   * an honest seller and should be a decision rather than a surprise. "New" is
   * counted in payouts already **paid** — the thing the reserve is waiting to
   * observe is a transfer that worked.
   */
  reserve_rate?: number
  reserve_days?: number
  reserve_after_payouts?: number
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
  /**
   * §5.1's routing policy for the backup destination. It may be used "only
   * after a failed primary payout and an explicit routing-policy check" — this
   * pair is that check, and neither half is a default the engine assumes.
   */
  payout_backup_enabled?: boolean
  /** How many refusals from the primary before the backup is considered. */
  payout_primary_attempts?: number
  /**
   * §13. How many attempts a payout gets before it stops being retried by
   * anything automatic and waits for a person. Default 5, floor 1 — a budget of
   * zero would block every payout on the first transient error a rail has.
   */
  payout_retry_max_attempts?: number
  /**
   * `wallet` stops the cron sending cleared money nobody has asked for. It
   * changes **when**, not whether: money still clears on the same window and
   * still lands in `available`, and `request_withdrawal` is what stamps it due.
   */
  payout_mode?: 'auto' | 'wallet'
  /** §12's two AI features, switchable without switching the layer off. */
  ai_dispute_assistant?: boolean
  ai_risk_narrator?: boolean
  /** §5.1's change protection: how long a moved destination holds a payout. */
  destination_hold_hours?: number
  /** After this, a sanctions screening is stale and the gate holds the payout. */
  sanctions_max_age_days?: number
  /** §10.1: how long a hosted payment link lives. */
  checkout_session_hours?: number
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
 * What a client's site is told about, and when — spec §10.2.
 *
 * The object is a `deal` in our own code and an `order` on the wire (§29.2),
 * which is the one place the two vocabularies are allowed to differ: these
 * names are what a client integrating against the handoff document will
 * register for.
 *
 * **One event per transition.** There is no per-event subscription — every
 * registered endpoint receives every event — so shipping both an old and a new
 * name for the same state change would double every client's delivery volume
 * rather than easing their migration.
 *
 * The V1 names (`deal.funded_held`, `deal.confirmed`, `deal.released`,
 * `deal.refunded`, `deal.disputed`, `deal.paid_out`) were renamed here in
 * Phase 1. That is a breaking wire change, affordable exactly once, before any
 * live traffic exists.
 */
export const WEBHOOK_EVENTS = [
  'order.payment_pending',
  'payment.failed',
  /**
   * §10.1: the buyer finished the hosted flow and was handed to the provider.
   *
   * **Not** the funding event, deliberately. This says the buyer is done with
   * our page; `order.funded_held` says money arrived, after a provider webhook
   * verified its signature and re-fetched the transaction. A client that
   * conflated them would ship goods against a card that has not settled.
   */
  'checkout.completed',
  'order.funded_held',
  /** The seller says the work is done — V1's `deal.confirmed` with side=seller. */
  'order.delivered',
  /** The buyer accepts — V1's `deal.confirmed` with side=buyer. */
  'order.accepted',
  /** Money has left the hold and the safety window has started. */
  'order.clearing_started',
  /** The window has closed; the payout may go. */
  'order.released',
  'order.canceled',
  'order.expired',
  'refund.succeeded',
  'dispute.opened',
  /**
   * §8's Resolution Center. One event per thing that happened to a request, and
   * `expired` is deliberately separate from `declined`: declining is an act,
   * expiring is silence, and a client reconciling its own records needs to be
   * able to tell which.
   */
  'dispute.offer_made',
  'dispute.offer_accepted',
  'dispute.offer_declined',
  'dispute.offer_withdrawn',
  'dispute.offer_expired',
  'dispute.evidence_added',
  'dispute.resolved',
  'deal.dispute_resolved',
  'payout.pending',
  'payout.paid',
  'payout.failed',
  'payout.held_for_review',
  /** §5.1's no-route behaviour: keep the amount, and say so. */
  'payout.blocked',
  'payout.needs_verification',
  /** §5.1: the backup destination was used, and the seller must be told. */
  'payout.route_changed',
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
  /**
   * §7.1's split, kept apart from `dispute_refunded` so §24.4 does not learn
   * that the buyer won outright when in fact both sides got part of it.
   */
  | 'dispute_split'

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
  /**
   * Can the *deployment* run §12 at all — i.e. can it reach the read-only AI
   * role? False means no toggle on the Settings screen can help, which is
   * exactly what a reader has to be able to tell apart from the company having
   * switched the feature off.
   */
  configured: boolean
  /**
   * True when there is no model key and answers come from the deterministic
   * stand-in. Drafts work; they are a fixed rule over the case file rather than
   * a model's reading of it, and any screen showing one has to say so.
   */
  demo: boolean
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
  /** Which pass first raised this case. Null on alerts predating §13's runs. */
  run_id: string | null
}

/** Where a finished pass left things. */
export type ReconciliationResolution =
  /** Every rail on this provider agreed, and nothing is outstanding. */
  | 'clean'
  /**
   * Nothing disagreed and nothing was proven either — a rail could not be
   * reached. Folding this into `clean` would let a week of provider outages
   * read as a week of clean books.
   */
  | 'incomplete'
  | 'cases_open'
  /** A named person has explained it. Only a person can put this here. */
  | 'resolved'

/**
 * One reconciliation pass over one tenant's one rail — spec §13.
 *
 * The alerts above say what is wrong now; a run says we looked. "Did last
 * night's pass check Stripe" is not a question a table of open alerts can
 * answer, and a nightly control nobody can prove ran is not a control.
 */
export interface ReconciliationRun {
  id: string
  tenant_id: string
  provider: Provider
  /** `missing` is counted over this window; the balances are read at its end. */
  period_start: Timestamp
  period_end: Timestamp
  started_at: Timestamp
  finished_at: Timestamp | null
  /** Currency comparisons made on this rail. */
  rails_checked: number
  matched: number
  mismatched: number
  /** Currencies with no external figure — an unreachable or demo provider. */
  skipped: number
  /**
   * Verified inbound events in the window that never finished processing: what
   * the provider told us and the ledger has not posted.
   */
  missing: number
  status: 'running' | 'completed' | 'failed'
  resolution: ReconciliationResolution | null
  resolved_by: string | null
  resolved_at: Timestamp | null
  resolution_note: string | null
  /** Why the pass did not finish, when it did not. */
  error: string | null
}

/** The five scheduled jobs. Matches the `job` check on `cron_job_runs`. */
export type CronJobName =
  | 'reconcile'
  | 'auto-release'
  | 'payout-dispatch'
  | 'settle-pending'
  | 'webhook-dispatch'

/**
 * One scheduled-job invocation, as the job itself recorded it.
 *
 * pg_cron knows a schedule fired; this is what our code did with the fire.
 * `counters` are whatever the pass returned — reconciles count tenants and
 * rails, dispatchers count outcomes — so the shape is deliberately open.
 */
export interface CronRun {
  id: string
  job: CronJobName
  started_at: Timestamp
  finished_at: Timestamp | null
  status: 'running' | 'completed' | 'failed'
  counters: Record<string, number> | null
  error: string | null
}

/**
 * A payout as the staff view sees it — cross-tenant, so the signal-carrying
 * columns the tenant screen loads are left off the wire.
 */
export interface AdminPayout {
  id: string
  tenant_id: string
  deal_id: string
  seller_id: string
  amount: Money
  currency: Currency
  status: PayoutStatus
  scheduled_for: Timestamp
  paid_at: Timestamp | null
  failure_reason: string | null
  attempts: number
  next_attempt_at: Timestamp | null
  created_at: Timestamp
}

/** A webhook delivery, across every tenant. */
export interface AdminWebhookDelivery {
  id: string
  tenant_id: string
  endpoint_id: string
  event: WebhookEvent
  deal_id: string | null
  status: WebhookDeliveryStatus
  attempts: number
  status_code: number | null
  error: string | null
  next_attempt_at: Timestamp | null
  delivered_at: Timestamp | null
  created_at: Timestamp
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
  /** Defaults to the tenant's home market when omitted. */
  buyer_country?: Country
  deposit_amount?: Money
  expected_complete_at?: Timestamp
  completion_policy?: Partial<CompletionPolicy>
  /** §7, presentment currency. The client knows its own tax rules; we do not. */
  tax_amount?: Money
  discount_amount?: Money
  /**
   * Installment billing. `split_percent` charges that percentage now and
   * the rest on return; `overage_rate` + `overage_unit_seconds` charge a
   * late-return surcharge, independent of whether the deal is split at all.
   * `overage_rate` needs `expected_complete_at` set — there is otherwise
   * nothing to be late against.
   */
  split_percent?: number
  overage_rate?: Money
  overage_unit_seconds?: number
  metadata?: Record<string, string>
}

export interface CreateDealResult {
  deal: Deal
  /** Where the buyer is sent to pay. */
  payment_link: string
}

export interface CreateSellerInput {
  name: string
  /**
   * `country`, `payout_provider` and `destination` are optional together — a
   * seller can be registered with no payout destination at all, added later
   * with `addSellerDestination`. Sending one of the three without the others
   * is refused rather than silently dropped.
   */
  country?: Country
  /** Defaults to the market's local currency when omitted. */
  payout_currency?: Currency
  payout_provider?: PayoutProvider
  /** Raw destination — tokenized immediately, never stored. */
  destination?: string
  /**
   * §11's external user id: the client's own handle for this person, so their
   * system can find this seller again. Unique per tenant where supplied, which
   * is what makes a retried registration safe.
   */
  external_user_id?: string
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
