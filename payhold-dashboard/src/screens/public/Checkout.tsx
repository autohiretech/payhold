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
import { api, type ChargeNextAction, type PaymentMethod } from '@/api'
import { Button, Card, Dot, ErrorNote, Input, Select, Skeleton, cx } from '@/components/ui'
import { MethodIcon } from '@/components/rails'
import { formatMoney } from '@/lib/format'
import { METHOD_BLURB, METHOD_LABEL } from '@/lib/rails'
import { useMoneyAction } from '@/lib/queries'
import { postToParent, reportHeight } from '@/lib/embed'

/**
 * What this page is waiting on, once `pay` starts a charge that has nothing
 * to redirect to. `otp`'s `reference` is the rail's own handle for the
 * half-finished charge — `answerCheckoutOtp` needs it back, and it means
 * nothing anywhere else.
 */
type Pending = { type: 'wait'; message: string } | { type: 'otp'; reference: string; message: string }

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
  const [phone, setPhone] = useState('')
  const [otp, setOtp] = useState('')
  const [otpError, setOtpError] = useState<string | null>(null)
  /**
   * Non-null once the rail has nothing left to send the buyer to — a mobile
   * money charge that only needs an approval on their handset, or a code back.
   * Card and every other method still ends at the rail's own page, exactly as
   * before; this only ever gets set for the direct charge `phone` makes
   * possible. Non-null switches the whole card from "how would you like to
   * pay" to "here's what's happening", which is why it lives above both
   * mutations rather than inside either one.
   */
  const [pending, setPending] = useState<Pending | null>(null)

  const handleNextAction = (next: ChargeNextAction, fallbackLink: string | null) => {
    switch (next.type) {
      case 'wait':
        setPending({ type: 'wait', message: next.message })
        return
      case 'otp':
        setPending({ type: 'otp', reference: next.reference, message: next.message })
        return
      case 'redirect':
        location.assign(next.url)
        return
      default:
        // Every other shape (card's own inline widget, a wallet's popup, …) is
        // not built into this page yet. `payment_link` still works for all of
        // them — the same fallback `startCharge` always meant by carrying one.
        if (fallbackLink) location.assign(fallbackLink)
    }
  }

  const pay = useMoneyAction(async () => {
    if (!method) return
    let result
    try {
      result = await api.payCheckout(token, {
        method,
        network: network ?? undefined,
        // Present, mobile money is charged directly and the buyer never
        // leaves this page — the rail pushes an approval to their handset
        // instead. Absent, it falls back to the rail's own hosted page
        // exactly as every other method does.
        phone: method === 'mobile_money' && phone.trim() ? phone.trim() : undefined,
      })
    } catch (err) {
      // A refusal before the buyer ever reaches the provider — a method we
      // switched off, an expired session. The parent would otherwise sit on a
      // spinner, because nothing navigated and nothing will.
      postToParent('payment_failed', { deal_id: checkout.data?.deal.id })
      throw err
    }
    handleNextAction(result.next_action, result.payment_link)
  })

  const answerOtp = useMoneyAction(async () => {
    if (!pending || pending.type !== 'otp') return
    setOtpError(null)
    try {
      const result = await api.answerCheckoutOtp(token, { reference: pending.reference, otp })
      handleNextAction(result.next_action, null)
    } catch (err) {
      setOtpError(err instanceof Error ? err.message : 'That code was not accepted.')
    }
  })

  // Polled only while waiting on the buyer's handset — an `otp` state waits on
  // `answerOtp` instead, which arms its own `wait` once a code is accepted.
  // Nothing here can fund a deal: this is `/confirm`'s own re-fetch from the
  // provider, the identical check the webhook makes, never a request body.
  const confirmPoll = useQuery({
    queryKey: ['public-checkout-confirm', token],
    queryFn: () => api.confirmCheckout(token),
    enabled: pending?.type === 'wait',
    refetchInterval: (query) => (query.state.data?.settled ? false : 3000),
  })

  const settledDealId = confirmPoll.data?.settled ? confirmPoll.data.deal.id : null
  useEffect(() => {
    // This page is now the one that knows, since a direct charge never sends
    // the buyer anywhere for `/status/:id` to pick up the story from. Fired
    // once per settle, the same way `DealStatusPage` fires it once per status.
    if (settledDealId) postToParent('payment_succeeded', { deal_id: settledDealId })
  }, [settledDealId])

  if (checkout.isPending) {
    return (
      <PublicFrame>
        <Skeleton className="h-64" />
      </PublicFrame>
    )
  }

  // Expired, withdrawn, already used and never-existed all land here, and the
  // page says the same thing for all four — distinguishing them would let
  // somebody probe for real tokens. Checked only while nothing is `pending`:
  // paying moves the session past `open` server-side, `useMoneyAction`
  // invalidates every query including this one, and the refetch that follows
  // would otherwise read as an expired link on the very page that is waiting
  // on the buyer's handset.
  if (!pending && (checkout.isError || !checkout.data || checkout.data.status !== 'open')) {
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

  if (!checkout.data) return null

  if (pending) {
    return (
      <PublicFrame>
        <Card className="overflow-hidden p-8 text-center">
          {confirmPoll.data?.settled ? (
            <>
              <p className="text-3xl">✓</p>
              <p className="mt-3 font-medium text-fg">Payment received.</p>
              <p className="mt-1 text-sm text-fg-muted">
                Your money is held safely. The seller has been notified.
              </p>
            </>
          ) : pending.type === 'wait' ? (
            <>
              <div className="mx-auto size-8 animate-spin rounded-full border-2 border-line-strong border-t-brand" />
              <p className="mt-4 font-medium text-fg">{pending.message}</p>
              <p className="mt-1 text-sm text-fg-muted">
                This page updates itself — no need to refresh.
              </p>
              <button
                type="button"
                className="mt-6 text-sm font-medium text-brand hover:underline"
                onClick={() => setPending(null)}
              >
                Choose a different way to pay
              </button>
            </>
          ) : (
            <>
              <p className="font-medium text-fg">{pending.message}</p>
              <label className="mt-4 block text-left">
                <span className="text-sm font-medium text-fg">Code</span>
                <Input
                  className="mt-2"
                  inputMode="numeric"
                  autoFocus
                  value={otp}
                  onChange={(e) => setOtp(e.target.value)}
                />
              </label>
              <Button
                variant="primary"
                className="mt-3 w-full"
                disabled={answerOtp.isPending || !otp.trim()}
                onClick={() => answerOtp.mutate()}
              >
                {answerOtp.isPending ? 'Checking…' : 'Submit code'}
              </Button>
              {otpError && (
                <div className="mt-3 text-left">
                  <ErrorNote message={otpError} />
                </div>
              )}
            </>
          )}
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

          {/* Given a number, mobile money is charged right here — a prompt
              goes straight to the buyer's own phone rather than a page of
              Flutterwave's. Left blank, it still works exactly as before,
              on the rail's own hosted page. */}
          {method === 'mobile_money' && (
            <label className="mt-3 block">
              <span className="text-sm font-medium text-fg">Your mobile money number</span>
              <Input
                className="mt-2"
                type="tel"
                inputMode="tel"
                placeholder="e.g. 0781 234 567"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
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
              pay.isPending ||
              !method ||
              (networks.length > 1 && !network) ||
              (method === 'mobile_money' && !phone.trim())
            }
            onClick={() => pay.mutate()}
          >
            {pay.isPending
              ? method === 'mobile_money'
                ? 'Sending the request to your phone…'
                : 'Taking you to pay…'
              : !method
                ? 'Choose a payment method'
                : networks.length > 1 && !network
                  ? 'Choose which one'
                  : method === 'mobile_money' && !phone.trim()
                    ? 'Enter your mobile money number'
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
