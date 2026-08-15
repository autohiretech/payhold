/**
 * Hosted checkout — what the buyer sees after clicking "Book & Pay" on a client
 * site. No dashboard chrome, no login. A small client can point at this page
 * and write almost no payment code of their own.
 *
 * The word "escrow" must never appear here. This page explains a payment hold
 * in plain language: your money is held, nobody can take it, both sides confirm.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * **The URL carries a session token, not a deal id** (§10.1). That is the whole
 * of Phase 10's change here, and it is a correctness fix rather than a
 * refactor: the old page read the deal directly, and `GET /v1/deals/:id` is
 * tenant-scoped and needs an API key. It only ever worked because the mock is
 * in the same browser. A stranger opening a payment link has no credential, so
 * the token has to *be* the credential — scoped to one payment, on one deal,
 * with an expiry.
 *
 * Two things follow, and both are deliberate losses:
 *
 * - **The method list comes from the server**, not from `collectionRails`. The
 *   generated registry says what is possible in a market; the capability matrix
 *   says what is switched on (§29.11), and only the backend can read the
 *   second. A method rendered from the registry alone is a button that fails at
 *   the provider, in front of a buyer.
 * - **There is no country picker.** The old page let a buyer say they were
 *   somewhere else and re-priced in the browser. `PublicCheckout` carries one
 *   amount in one currency because the session is for one payment, and a page
 *   that re-priced without the deal being re-created would be quoting a figure
 *   nothing had agreed to. A buyer in the wrong market needs a new link, which
 *   is a thing the seller can issue in a click.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Nothing on this page can fund a deal. Paying completes the session and hands
 * the buyer to the provider; `funded_held` comes from a webhook that checked a
 * signature and re-fetched the transaction. §15 phase 2.
 */

import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api, type PaymentMethod } from '@/api'
import { Button, Card, Dot, ErrorNote, Select, Skeleton, cx } from '@/components/ui'
import { MethodIcon } from '@/components/rails'
import { formatMoney } from '@/lib/format'
import { METHOD_BLURB, METHOD_LABEL } from '@/lib/rails'
import { useMoneyAction } from '@/lib/queries'
import { postToParent, reportHeight } from '@/lib/embed'

export function CheckoutPage() {
  const { token = '' } = useParams()
  // Only does anything when a tenant has framed this page. Outside a frame
  // every call in `@/lib/embed` is a no-op.
  useEffect(reportHeight, [])
  const checkout = useQuery({
    queryKey: ['public-checkout', token],
    queryFn: () => api.getPublicCheckout(token),
    // A payment link is opened once and used. Retrying a refusal would just be
    // three more chances to tell somebody their link expired.
    retry: false,
  })

  const [method, setMethod] = useState<PaymentMethod | null>(null)
  const [network, setNetwork] = useState<string | null>(null)

  const pay = useMoneyAction(async () => {
    if (!method) return
    let result
    try {
      result = await api.payCheckout(token, {
        method,
        network: network ?? undefined,
      })
    } catch (err) {
      // A refusal before the buyer ever reaches the provider — a method we
      // switched off, an expired session. The parent would otherwise sit on a
      // spinner, because nothing navigated and nothing will.
      postToParent('payment_failed', { deal_id: checkout.data?.deal.id })
      throw err
    }
    // In production this is the provider's own hosted page. The buyer leaves
    // for Flutterwave or Stripe here and comes back when the charge settles.
    //
    // **Note for anyone embedding this:** the frame navigates to the provider
    // at this point, and whether that works is the provider's decision, not
    // ours — their pages set their own `frame-ancestors`, and Stripe Checkout
    // in particular refuses to be framed. A parent must keep the redirect
    // fallback for exactly this reason. There is no outcome event here because
    // this page is no longer the one that knows: the buyer comes back to
    // `/status/:id`, which is where the result is reported from.
    if (result.payment_link) location.assign(result.payment_link)
  })

  if (checkout.isPending) {
    return (
      <PublicFrame>
        <Skeleton className="h-64" />
      </PublicFrame>
    )
  }

  // Expired, withdrawn, already used and never-existed all land here, and the
  // page says the same thing for all four — distinguishing them would let
  // somebody probe for real tokens.
  if (checkout.isError || !checkout.data || checkout.data.status !== 'open') {
    return (
      <PublicFrame>
        <Card className="p-8 text-center">
          <p className="font-medium text-fg">This payment link is no longer valid.</p>
          <p className="mt-1 text-sm text-fg-muted">
            It may have expired or already been used. Ask the company you are
            buying from for a new one.
          </p>
        </Card>
      </PublicFrame>
    )
  }

  const { deal, seller, methods } = checkout.data
  const chosen = methods.find((m) => m.method === method)
  const networks = chosen?.networks ?? []
  const dueNow = chosen?.amount ?? deal.amount
  // Methods price differently only on a split deal: one whose second charge
  // is collected automatically later shows the first installment; one that
  // cannot be charged again shows the full amount instead. Derived from what
  // the server already returned per method, not computed here.
  const pricesVary = new Set(methods.map((m) => m.amount)).size > 1
  const cheapestAmount = pricesVary ? Math.min(...methods.map((m) => m.amount)) : dueNow

  return (
    <PublicFrame>
      <Card className="overflow-hidden">
        <div className="border-b border-line px-6 py-5">
          <p className="text-sm text-fg-muted">You are paying for</p>
          <h1 className="mt-1 text-lg font-semibold text-fg">{deal.description}</h1>
          {seller.name && (
            <p className="mt-1 text-sm text-fg-muted">Sold by {seller.name}</p>
          )}
        </div>

        <dl className="space-y-2 px-6 py-5 text-sm">
          <div className="flex justify-between border-t border-line pt-2 text-base">
            <dt className="font-medium text-fg">Total today</dt>
            <dd className="tabular font-semibold text-fg">
              {formatMoney(dueNow, deal.currency)}
            </dd>
          </div>
          {pricesVary && (
            <p className="text-xs leading-relaxed text-fg-muted">
              {chosen == null
                ? 'The amount due now depends on how you pay — some methods charge the rest automatically later, others take it all up front.'
                : chosen.amount > cheapestAmount
                  ? "This method can't be charged again later, so the full amount is due now."
                  : "You'll pay the rest automatically once this is confirmed complete."}
            </p>
          )}
        </dl>

        {/* Only methods that are open in this market *and* live right now.
            §29.11: the registry says what is possible, the matrix says what is
            on, and an option the buyer cannot complete is worse than no
            option. No `ProviderChip` here on purpose — Flutterwave/Stripe is
            plumbing a buyer has no reason to see; the operator screens still
            show it because there the rail is the thing being managed. */}
        <div className="border-t border-line px-6 py-5">
          <p className="text-sm font-semibold text-fg">How would you like to pay?</p>

          {methods.length === 0 ? (
            <p className="mt-3 rounded-xl bg-danger-soft px-4 py-3 text-sm leading-relaxed text-danger">
              There is no way to take this payment at the moment. Ask the seller
              for another option — nothing has been charged.
            </p>
          ) : (
            <div className="mt-3 space-y-2">
              {methods.map((option) => {
                const selected = method === option.method
                return (
                  <button
                    key={`${option.method}-${option.provider}`}
                    type="button"
                    onClick={() => {
                      setMethod(option.method)
                      // The old wallet may not exist on the new method.
                      setNetwork(null)
                    }}
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
                      <MethodIcon method={option.method} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold text-fg">
                        {option.label}
                      </span>
                      <span className="mt-0.5 block text-xs leading-relaxed text-fg-muted">
                        {METHOD_BLURB[option.method]}
                      </span>
                    </span>
                    {pricesVary && (
                      <span className="mt-0.5 shrink-0 tabular text-xs font-semibold text-fg">
                        {formatMoney(option.amount, deal.currency)}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          )}

          {networks.length > 1 && (
            <label className="mt-3 block">
              <span className="text-sm font-medium text-fg">Which one?</span>
              <Select
                className="mt-2"
                value={network ?? ''}
                onChange={(e) => setNetwork(e.target.value || null)}
              >
                <option value="">Choose…</option>
                {networks.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </Select>
            </label>
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
            disabled={
              pay.isPending || !method || (networks.length > 1 && !network)
            }
            onClick={() => pay.mutate()}
          >
            {pay.isPending
              ? 'Taking you to pay…'
              : !method
                ? 'Choose a payment method'
                : networks.length > 1 && !network
                  ? 'Choose which one'
                  : `Pay ${formatMoney(dueNow, deal.currency)} with ${METHOD_LABEL[method]}`}
          </Button>

          {pay.isError && (
            <div className="mt-3">
              <ErrorNote message={pay.error.message} />
            </div>
          )}

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
