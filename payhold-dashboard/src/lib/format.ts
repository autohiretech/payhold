import type {
  Currency,
  DealStatus,
  DisputeOfferKind,
  DisputeOfferStatus,
  DisputeReasonCode,
  DisputeStatus,
  KycStatus,
  Money,
  PayoutStatus,
  WebhookDeliveryStatus,
} from '@/api'
import { ZERO_DECIMAL_CURRENCIES } from './countries'

/**
 * Money is stored in minor units everywhere; only these two functions cross
 * that boundary, in either direction, and every screen with a money amount —
 * displayed or typed into a form — goes through one of them.
 *
 * Zero-decimal currencies — RWF, UGX, the CFA francs — have no minor unit at
 * all, and PayHold's own money engine stores them as-is: `toMajor`/`toMinor`
 * in payhold-backend's `_shared/flutterwave.ts` are a no-op for every
 * currency in `ZERO_DECIMAL_CURRENCIES`, the same list this file uses. A
 * scatter of screens used to do the ×100/÷100 conversion inline and treat
 * every currency identically — `formatMoney`/`formatMoneyShort` here, plus
 * the deal-creation, refund, deposit-capture and dispute-resolution forms —
 * so a real RWF 673,200 payout rendered as "RWF 6,732", and a operator typing
 * "673200" into an RWF refund field would have sent 67,320,000. Confirmed
 * against the live ledger: summing a seller's actual entries lands exactly on
 * the *undivided* ledger_balance PayHold reports, not on 1/100th of it.
 */
export function toMajorUnits(minor: Money, currency: Currency): number {
  return ZERO_DECIMAL_CURRENCIES.includes(currency) ? minor : minor / 100
}

/** The inverse of `toMajorUnits` — what a form's typed amount sends on the wire. */
export function toMinorUnits(major: number, currency: Currency): Money {
  const value = Number.isFinite(major) ? major : 0
  return ZERO_DECIMAL_CURRENCIES.includes(currency) ? Math.round(value) : Math.round(value * 100)
}

export function formatMoney(amount: Money, currency: Currency): string {
  const zeroDecimal = ZERO_DECIMAL_CURRENCIES.includes(currency)
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency,
    currencyDisplay: 'code',
    minimumFractionDigits: zeroDecimal ? 0 : 2,
    maximumFractionDigits: zeroDecimal ? 0 : 2,
  }).format(toMajorUnits(amount, currency))
}

/** Compact form for stat tiles, where the exact centime is noise. */
export function formatMoneyShort(amount: Money, currency: Currency): string {
  const major = toMajorUnits(amount, currency)
  if (Math.abs(major) >= 1_000_000) {
    return `${currency} ${(major / 1_000_000).toFixed(1)}M`
  }
  if (Math.abs(major) >= 10_000) {
    return `${currency} ${Math.round(major / 1000)}K`
  }
  return formatMoney(amount, currency)
}

export function formatPercent(rate: number): string {
  return `${(rate * 100).toFixed(rate * 100 % 1 === 0 ? 0 : 1)}%`
}

export function formatDate(ts: string | null): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

export function formatDateTime(ts: string | null): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/**
 * Relative time against the simulated clock, not the wall clock — otherwise
 * "advance time by 5 days" would make every timestamp read wrong.
 */
export function formatRelative(ts: string | null, from: Date): string {
  if (!ts) return '—'

  const diffMs = new Date(ts).getTime() - from.getTime()
  const past = diffMs < 0
  const mins = Math.round(Math.abs(diffMs) / 60_000)

  const phrase =
    mins < 1
      ? 'just now'
      : mins < 60
        ? `${mins}m`
        : mins < 1440
          ? `${Math.round(mins / 60)}h`
          : `${Math.round(mins / 1440)}d`

  if (phrase === 'just now') return phrase
  return past ? `${phrase} ago` : `in ${phrase}`
}

// ---------------------------------------------------------------------------
// Status vocabulary
// ---------------------------------------------------------------------------

export type Tone = 'neutral' | 'held' | 'confirmed' | 'released' | 'pending' | 'danger'

export interface StatusMeta {
  label: string
  tone: Tone
  /** Plain-language explanation. No jargon, and never the word "escrow". */
  hint: string
}

export const DEAL_STATUS_META: Record<DealStatus, StatusMeta> = {
  created: {
    label: 'Awaiting payment',
    tone: 'neutral',
    hint: 'The deal exists but the buyer has not paid yet.',
  },
  checkout_started: {
    label: 'At checkout',
    tone: 'neutral',
    hint: 'The buyer opened the payment page. Nothing has been charged.',
  },
  payment_pending: {
    label: 'Payment started',
    tone: 'neutral',
    hint: 'The buyer is paying. Money is only held once the provider confirms it.',
  },
  payment_failed: {
    label: 'Payment failed',
    tone: 'danger',
    hint: 'The charge did not go through. The buyer can try again.',
  },
  expired: {
    label: 'Expired',
    tone: 'neutral',
    hint: 'Nobody paid in time. Nothing was charged and nothing is owed.',
  },
  canceled: {
    label: 'Cancelled',
    tone: 'neutral',
    hint: 'Called off before any money moved.',
  },
  funded_held: {
    label: 'Funds held',
    tone: 'held',
    hint: 'The buyer has paid. The money is held and neither side can touch it.',
  },
  in_progress: {
    label: 'In progress',
    tone: 'held',
    hint: 'The work has started. The money stays held until both sides confirm.',
  },
  revision_requested: {
    label: 'Changes asked for',
    tone: 'held',
    hint: 'The buyer asked for something to be put right. The money is still held.',
  },
  confirmed_buyer: {
    label: 'Buyer confirmed',
    tone: 'confirmed',
    hint: 'Waiting on the seller to confirm before funds release.',
  },
  confirmed_seller: {
    label: 'Seller confirmed',
    tone: 'confirmed',
    hint: 'Waiting on the buyer to confirm before funds release.',
  },
  clearing: {
    label: 'Clearing',
    tone: 'released',
    hint: 'Both sides confirmed. Funds are clearing before payout.',
  },
  released: {
    label: 'Ready to pay out',
    tone: 'released',
    hint: 'The clearance window has passed. The payout can go.',
  },
  payout_pending: {
    label: 'Payout sending',
    tone: 'pending',
    hint: 'The transfer is with the provider and has not settled yet.',
  },
  paid_out: {
    label: 'Paid out',
    tone: 'released',
    hint: 'The seller has been paid. This deal is complete.',
  },
  refunded: {
    label: 'Refunded',
    tone: 'pending',
    hint: 'The money went back to the buyer.',
  },
  partially_refunded: {
    label: 'Partly refunded',
    tone: 'pending',
    hint: 'Some of the money went back to the buyer. The rest follows the deal.',
  },
  disputed: {
    label: 'Disputed',
    tone: 'danger',
    hint: 'Held pending review. Payout and refund are both blocked.',
  },
}

export const PAYOUT_STATUS_META: Record<PayoutStatus, StatusMeta> = {
  scheduled: {
    label: 'Scheduled',
    tone: 'neutral',
    hint: 'Queued to send once the clearance window closes.',
  },
  processing: {
    label: 'Processing',
    tone: 'held',
    hint: 'Sent to the provider, awaiting confirmation.',
  },
  paid: { label: 'Paid', tone: 'released', hint: 'Delivered to the seller.' },
  failed: {
    label: 'Failed',
    tone: 'danger',
    hint: 'The provider rejected the transfer. Retry after fixing the cause.',
  },
  frozen: {
    label: 'Frozen',
    tone: 'pending',
    hint: 'Blocked because this account is under reconciliation review.',
  },
  held_for_review: {
    label: 'Held for review',
    tone: 'pending',
    hint: 'A risk rule stopped this one. Someone needs to look before it sends.',
  },
  // The two stops nobody approves. Both say what has to change instead of who
  // has to decide, because in neither case is a decision what is missing —
  // §12's check has not been done, or §5.1 has nowhere eligible to send it.
  needs_verification: {
    label: 'Needs verification',
    tone: 'pending',
    hint: 'Something about this seller is outstanding. Verifying them releases it.',
  },
  blocked: {
    label: 'Blocked',
    tone: 'danger',
    hint: 'No eligible payout route, or the deal is disputed. The money is untouched.',
  },
}

/**
 * §12's onboarding states.
 *
 * Only `verified` is payable, and the hints say what to do rather than what
 * went wrong: every one of these is a seller waiting on somebody here, and a
 * label that reads as a verdict on them would be wrong about most of them —
 * `pending` is the state every new seller starts in.
 */
export const KYC_STATUS_META: Record<KycStatus, StatusMeta> = {
  pending: {
    label: 'Unverified',
    tone: 'neutral',
    hint: 'Where every new seller starts. They cannot be paid until somebody attests.',
  },
  verified: {
    label: 'Verified',
    tone: 'released',
    hint: 'Identity, sanctions and ownership all attested. Payouts can go.',
  },
  review_required: {
    label: 'Needs review',
    tone: 'pending',
    hint: 'Something came back that a person has to look at. Payouts are held.',
  },
  restricted: {
    label: 'Restricted',
    tone: 'danger',
    hint: 'Deliberately barred from payouts.',
  },
  rejected: {
    label: 'Rejected',
    tone: 'danger',
    hint: 'The checks came back against them. They cannot be paid.',
  },
}

export const DELIVERY_STATUS_META: Record<WebhookDeliveryStatus, StatusMeta> = {
  pending: {
    label: 'Queued',
    tone: 'neutral',
    hint: 'Waiting to send, or waiting out a backoff after a failed attempt.',
  },
  delivered: {
    label: 'Delivered',
    tone: 'released',
    hint: 'Your endpoint accepted it.',
  },
  failed: {
    label: 'Failed',
    tone: 'danger',
    hint: 'Five attempts, no success. Send it again once the endpoint is back.',
  },
}

// ---------------------------------------------------------------------------
// The Resolution Center's vocabulary (§8)
// ---------------------------------------------------------------------------

export const DISPUTE_STATUS_META: Record<DisputeStatus, StatusMeta> = {
  open: {
    label: 'Open',
    tone: 'held',
    hint: 'The money stays put — it can neither release nor refund while this is open.',
  },
  resolved_released: {
    label: 'Released to seller',
    tone: 'released',
    hint: 'Decided in the seller’s favour. The payout can go.',
  },
  resolved_refunded: {
    label: 'Refunded to buyer',
    tone: 'neutral',
    hint: 'Decided in the buyer’s favour. The money went back.',
  },
  resolved_split: {
    label: 'Split',
    tone: 'confirmed',
    hint: 'Part refunded, the rest released. Both sides got some of what they asked for.',
  },
}

/**
 * §8's structured reasons. The free-text statement stays alongside — a code is
 * what you group by, a sentence is what a person actually reads.
 */
export const DISPUTE_REASON_LABEL: Record<DisputeReasonCode, string> = {
  not_delivered: 'Not delivered',
  not_as_described: 'Not as described',
  damaged: 'Damaged',
  late_delivery: 'Late',
  quality: 'Quality',
  incomplete: 'Incomplete',
  unauthorized_charge: 'Unauthorised charge',
  duplicate_charge: 'Duplicate charge',
  cancellation_requested: 'Cancellation requested',
  other: 'Other',
}

/**
 * §8's five requests. `moves_money` is the distinction that matters on screen:
 * accepting an update or an extension settles nothing and leaves the dispute
 * open, while accepting either refund kind resolves it and moves funds.
 */
export interface OfferKindMeta {
  label: string
  hint: string
  moves_money: boolean
}

export const DISPUTE_OFFER_KIND_META: Record<DisputeOfferKind, OfferKindMeta> = {
  update: {
    label: 'Ask for an update',
    hint: 'A photo, a status, an explanation. Agreeing to send one settles nothing.',
    moves_money: false,
  },
  extension: {
    label: 'Ask for more time',
    hint: 'A new date. Agreeing to it leaves the dispute open and the money held.',
    moves_money: false,
  },
  cancellation: {
    label: 'Ask to cancel',
    hint: 'Call the order off. Accepting returns the whole payment to the buyer.',
    moves_money: true,
  },
  partial_refund: {
    label: 'Offer a partial refund',
    hint: 'Give back part and release the rest. Accepting executes both.',
    moves_money: true,
  },
  full_refund: {
    label: 'Ask for a full refund',
    hint: 'The whole payment back. Accepting executes it.',
    moves_money: true,
  },
}

/**
 * `expired` is deliberately not `declined`. Declining is an act — somebody read
 * it and said no; expiring is silence. §24.3's labels cannot be backfilled, so
 * a screen that showed them as one thing would lose the difference for good.
 */
export const DISPUTE_OFFER_STATUS_META: Record<DisputeOfferStatus, StatusMeta> = {
  open: {
    label: 'Awaiting an answer',
    tone: 'pending',
    hint: 'The other party has 48 hours. Silence lapses it; it is never accepted by default.',
  },
  accepted: {
    label: 'Accepted',
    tone: 'released',
    hint: 'The other party agreed.',
  },
  declined: {
    label: 'Declined',
    tone: 'danger',
    hint: 'Somebody read it and said no.',
  },
  withdrawn: {
    label: 'Withdrawn',
    tone: 'neutral',
    hint: 'Taken back by whoever made it, before it was answered.',
  },
  expired: {
    label: 'Lapsed',
    tone: 'neutral',
    hint: 'Nobody answered inside 48 hours. Nothing moved, and the dispute stayed open.',
  },
}

export const TONE_CLASS: Record<Tone, string> = {
  neutral: 'bg-surface-2 text-fg-muted ring-line-strong/70',
  held: 'bg-held-soft text-held ring-held/20',
  confirmed: 'bg-confirmed-soft text-confirmed ring-confirmed/20',
  released: 'bg-released-soft text-released ring-released/20',
  pending: 'bg-pending-soft text-pending ring-pending/25',
  danger: 'bg-danger-soft text-danger ring-danger/20',
}
