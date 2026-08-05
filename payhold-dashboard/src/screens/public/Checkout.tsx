/**
 * Hosted checkout — what the buyer sees after clicking "Book & Pay" on a client
 * site. No dashboard chrome, no login. A small client can point at this page
 * and write almost no payment code of their own.
 *
 * The word "escrow" must never appear here. This page explains a payment hold
 * in plain language: your money is held, nobody can take it, both sides confirm.
 */

import { useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api, isSimulated } from '@/api'
import { Button, Card, Dot, Skeleton } from '@/components/ui'
import { formatDate, formatMoney } from '@/lib/format'
import { useMoneyAction } from '@/lib/queries'

export function CheckoutPage() {
  const { id = '' } = useParams()
  const deal = useQuery({ queryKey: ['public-deal', id], queryFn: () => api.getDeal(id) })

  const pay = useMoneyAction(async () => {
    // Stands in for the provider redirect. In production the buyer leaves for
    // Flutterwave or Stripe here, and comes back once the charge succeeds.
    if (isSimulated(api)) await api.sim.simulateFunding(id)
  })

  if (deal.isPending) {
    return (
      <PublicFrame>
        <Skeleton className="h-64" />
      </PublicFrame>
    )
  }

  if (deal.isError || !deal.data) {
    return (
      <PublicFrame>
        <Card className="p-8 text-center">
          <p className="font-medium text-fg">This payment link is not valid.</p>
          <p className="mt-1 text-sm text-fg-muted">
            Ask the company you are buying from for a new one.
          </p>
        </Card>
      </PublicFrame>
    )
  }

  const d = deal.data
  const total = d.amount + (d.deposit_amount ?? 0)

  if (d.status !== 'created') {
    return (
      <PublicFrame>
        <Card className="p-8 text-center">
          <p className="font-medium text-fg">This payment is already complete.</p>
          <p className="mt-1 text-sm text-fg-muted">
            Your money is held safely. Nothing more to do right now.
          </p>
          <a
            href={`/status/${d.id}`}
            className="mt-4 inline-block text-sm font-medium text-brand hover:underline"
          >
            Track this payment →
          </a>
        </Card>
      </PublicFrame>
    )
  }

  return (
    <PublicFrame>
      <Card className="overflow-hidden">
        <div className="border-b border-line px-6 py-5">
          <p className="text-sm text-fg-muted">You are paying for</p>
          <h1 className="mt-1 text-lg font-semibold text-fg">{d.description}</h1>
          {d.expected_complete_at && (
            <p className="mt-1 text-sm text-fg-muted">
              Expected completion {formatDate(d.expected_complete_at)}
            </p>
          )}
        </div>

        <dl className="space-y-2 px-6 py-5 text-sm">
          <div className="flex justify-between">
            <dt className="text-fg-muted">Amount</dt>
            <dd className="tabular">{formatMoney(d.amount, d.currency)}</dd>
          </div>
          {d.deposit_amount !== null && (
            <div className="flex justify-between">
              <dt className="text-fg-muted">
                Refundable security deposit
                <span className="mt-0.5 block text-xs text-fg-subtle">
                  Held on your card, released when you return the item
                </span>
              </dt>
              <dd className="tabular">{formatMoney(d.deposit_amount, d.currency)}</dd>
            </div>
          )}
          <div className="flex justify-between border-t border-line pt-2 text-base">
            <dt className="font-medium text-fg">Total today</dt>
            <dd className="tabular font-semibold text-fg">
              {formatMoney(total, d.currency)}
            </dd>
          </div>
        </dl>

        <div className="border-t border-line bg-surface-2 px-6 py-5">
          <p className="text-sm font-medium text-fg">How your money is protected</p>
          <ul className="mt-3 space-y-2.5 text-sm text-fg-muted">
            {[
              'Your payment is held — the seller cannot take it yet.',
              'When the service is complete, you both confirm.',
              'Only then is the money released to the seller.',
              'If something goes wrong, you can raise a dispute instead.',
            ].map((line) => (
              <li key={line} className="flex gap-2.5">
                <span className="mt-1.5">
                  <Dot tone="held" />
                </span>
                {line}
              </li>
            ))}
          </ul>
        </div>

        <div className="px-6 py-5">
          <Button
            variant="primary"
            className="w-full"
            disabled={pay.isPending}
            onClick={() => pay.mutate()}
          >
            {pay.isPending
              ? 'Redirecting…'
              : `Pay ${formatMoney(total, d.currency)} securely`}
          </Button>
          <p className="mt-3 text-center text-xs text-fg-subtle">
            Card and mobile money accepted. Card details go straight to our payment
            provider — PayHold never sees or stores them.
          </p>
        </div>
      </Card>
    </PublicFrame>
  )
}

export function PublicFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col items-center justify-center bg-canvas px-4 py-10">
      <div className="w-full max-w-md">
        {children}
        <p className="mt-5 text-center text-xs text-fg-subtle">
          Payments held by PayHold
        </p>
      </div>
    </div>
  )
}
