import type { Currency, DealStatus, Money, PayoutStatus } from '@/api'

/** Money is stored in minor units everywhere; only this file divides by 100. */
export function formatMoney(amount: Money, currency: Currency): string {
  return new Intl.NumberFormat('en-RW', {
    style: 'currency',
    currency,
    currencyDisplay: 'code',
    maximumFractionDigits: currency === 'RWF' || currency === 'UGX' ? 0 : 2,
  }).format(amount / 100)
}

/** Compact form for stat tiles, where the exact centime is noise. */
export function formatMoneyShort(amount: Money, currency: Currency): string {
  const major = amount / 100
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
  funded_held: {
    label: 'Funds held',
    tone: 'held',
    hint: 'The buyer has paid. The money is held and neither side can touch it.',
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
  released: {
    label: 'Released',
    tone: 'released',
    hint: 'Both sides confirmed. Funds are clearing before payout.',
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
}

export const TONE_CLASS: Record<Tone, string> = {
  neutral: 'bg-surface-2 text-fg-muted ring-line-strong/70',
  held: 'bg-held-soft text-held ring-held/20',
  confirmed: 'bg-confirmed-soft text-confirmed ring-confirmed/20',
  released: 'bg-released-soft text-released ring-released/20',
  pending: 'bg-pending-soft text-pending ring-pending/25',
  danger: 'bg-danger-soft text-danger ring-danger/20',
}
