/**
 * Small visual pieces for showing which rail money is on.
 *
 * Providers get a fixed colour each so a Flutterwave row and a Stripe row are
 * distinguishable at a glance in a long table — that distinction is
 * operationally load-bearing, not decoration.
 */

import type { PaymentMethod, Provider } from '@/api'
import { METHOD_LABEL, PROVIDER_LABEL } from '@/lib/rails'
import { cx } from './ui'

const PROVIDER_CLASS: Record<Provider, string> = {
  flutterwave: 'bg-pending-soft text-pending ring-pending/25',
  stripe: 'bg-held-soft text-held ring-held/20',
  fake: 'bg-surface-2 text-fg-muted ring-line-strong/60',
  // The declared-and-unbuilt adapters share the muted treatment: nothing rides
  // them, so nothing about them should read as a live rail.
  paypal: 'bg-surface-2 text-fg-muted ring-line-strong/60',
  cash_app_pay: 'bg-surface-2 text-fg-muted ring-line-strong/60',
  china_wallet_partner: 'bg-surface-2 text-fg-muted ring-line-strong/60',
}

export function ProviderChip({
  provider,
  className,
}: {
  provider: Provider
  className?: string
}) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-semibold whitespace-nowrap ring-1 ring-inset',
        PROVIDER_CLASS[provider],
        className,
      )}
    >
      <span className="size-1.5 rounded-full bg-current opacity-70" />
      {PROVIDER_LABEL[provider]}
    </span>
  )
}

export function MethodIcon({ method }: { method: PaymentMethod }) {
  const common = {
    viewBox: '0 0 24 24',
    className: 'size-[1.125rem]',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.7,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  }

  if (method === 'card') {
    return (
      <svg {...common}>
        <rect x="2.5" y="5" width="19" height="14" rx="2.5" />
        <path d="M2.5 10h19M6 15h3" />
      </svg>
    )
  }

  if (method === 'bank_transfer') {
    return (
      <svg {...common}>
        <path d="M3 10h18L12 4 3 10Z" />
        <path d="M5.5 10v7M9.5 10v7M14.5 10v7M18.5 10v7M3 20h18" />
      </svg>
    )
  }

  // Every wallet method is a phone — the difference is the network, which the
  // label carries.
  return (
    <svg {...common}>
      <rect x="6.5" y="2.5" width="11" height="19" rx="2.5" />
      <path d="M10.5 18.5h3" />
    </svg>
  )
}

export function MethodChip({ method }: { method: PaymentMethod }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-sm whitespace-nowrap text-fg-muted">
      <MethodIcon method={method} />
      {METHOD_LABEL[method]}
    </span>
  )
}
