/**
 * Hosted checkout — what the buyer sees after clicking "Book & Pay" on a client
 * site. No dashboard chrome, no login. A small client can point at this page
 * and write almost no payment code of their own.
 *
 * The word "escrow" must never appear here. This page explains a payment hold
 * in plain language: your money is held, nobody can take it, both sides confirm.
 */

import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api, isSimulated, type PaymentMethod } from '@/api'
import { Button, Card, Dot, Skeleton, cx } from '@/components/ui'
import { MethodIcon, ProviderChip } from '@/components/rails'
import { formatDate, formatMoney } from '@/lib/format'
import {
  COUNTRY_LABEL,
  METHOD_BLURB,
  METHOD_LABEL,
  collectionRails,
} from '@/lib/rails'
import { useMoneyAction } from '@/lib/queries'

export function CheckoutPage() {
  const { id = '' } = useParams()
  const deal = useQuery({ queryKey: ['public-deal', id], queryFn: () => api.getDeal(id) })
  const [method, setMethod] = useState<PaymentMethod | null>(null)

  const pay = useMoneyAction(async () => {
    // Stands in for the provider redirect. In production the buyer leaves for
    // Flutterwave or Stripe here — whichever rail their method routes to — and
    // comes back once the charge succeeds.
    if (isSimulated(api) && method) await api.sim.simulateFunding(id, method)
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
  const rails = collectionRails(d.buyer_country, d.currency)

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

        {/* Method choice. Only rails that can actually take this currency from
            this market are offered — an option the buyer cannot complete is
            worse than no option. */}
        <div className="border-t border-line px-6 py-5">
          <p className="text-sm font-semibold text-fg">How would you like to pay?</p>

          {rails.length === 0 ? (
            <p className="mt-3 text-sm text-danger">
              We cannot accept {d.currency} payments from {COUNTRY_LABEL[d.buyer_country]}{' '}
              yet. Contact the seller for another way to pay.
            </p>
          ) : (
            <div className="mt-3 space-y-2">
              {rails.map((rail) => {
                const selected = method === rail.method
                return (
                  <button
                    key={`${rail.method}-${rail.provider}`}
                    type="button"
                    onClick={() => setMethod(rail.method)}
                    className={cx(
                      'flex w-full items-start gap-3 rounded-xl border px-4 py-3 text-left transition',
                      selected
                        ? 'border-brand bg-brand-soft ring-2 ring-brand/25'
                        : 'border-line-strong bg-surface hover:bg-surface-2',
                    )}
                  >
                    <span
                      className={cx(
                        'mt-0.5 shrink-0',
                        selected ? 'text-brand' : 'text-fg-muted',
                      )}
                    >
                      <MethodIcon method={rail.method} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold text-fg">
                        {METHOD_LABEL[rail.method]}
                      </span>
                      <span className="mt-0.5 block text-xs leading-relaxed text-fg-muted">
                        {METHOD_BLURB[rail.method]}
                      </span>
                    </span>
                    <span className="mt-0.5 shrink-0">
                      <ProviderChip provider={rail.provider} />
                    </span>
                  </button>
                )
              })}
            </div>
          )}
        </div>

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
            disabled={pay.isPending || !method}
            onClick={() => pay.mutate()}
          >
            {pay.isPending
              ? 'Redirecting…'
              : !method
                ? 'Choose a payment method'
                : `Pay ${formatMoney(total, d.currency)} with ${METHOD_LABEL[method]}`}
          </Button>
          <p className="mt-3 text-center text-xs leading-relaxed text-fg-subtle">
            {method === 'card'
              ? 'Your card details go straight to our payment provider and are verified with 3D Secure. PayHold never sees or stores them.'
              : 'Your wallet details go straight to our payment provider. PayHold never sees or stores them.'}
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
        <div className="mb-6 flex items-center justify-center gap-2.5">
          <span className="flex size-8 items-center justify-center rounded-xl bg-brand text-brand-fg shadow-[var(--shadow-card)]">
            <svg viewBox="0 0 24 24" className="size-[1.125rem]" aria-hidden="true">
              <rect
                x="3.5"
                y="10"
                width="17"
                height="10.5"
                rx="2.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.9"
              />
              <path
                d="M7.75 10V7.25a4.25 4.25 0 0 1 8.5 0V10"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.9"
                strokeLinecap="round"
              />
              <circle cx="12" cy="15.25" r="1.55" fill="currentColor" />
            </svg>
          </span>
          <span className="text-sm font-semibold text-fg">PayHold</span>
        </div>

        {children}

        <p className="mt-6 text-center text-xs text-fg-subtle">
          Your payment is held securely until both sides confirm.
        </p>
      </div>
    </div>
  )
}
