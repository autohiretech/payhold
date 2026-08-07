/**
 * Hosted deal-status page — the link a client site gives both buyer and seller
 * after payment. It answers the only two questions either of them has: where is
 * my money, and what do I need to do?
 *
 * The confirm buttons here are the same `POST /v1/deals/:id/confirm` call the
 * client site would make itself. Small clients can skip building their own.
 */

import { useSearchParams, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api, type ConfirmSide, type Deal } from '@/api'
import { Badge, Button, Card, Dot, ErrorNote, Skeleton, cx } from '@/components/ui'
import { DEAL_STATUS_META, formatDate, formatMoney } from '@/lib/format'
import { useMoneyAction } from '@/lib/queries'
import { PublicFrame } from './Checkout'

export function DealStatusPage() {
  const { id = '' } = useParams()
  const [params] = useSearchParams()

  // Which party is looking. In production this comes from the signed token in
  // the confirm link, not a query string.
  const side: ConfirmSide = params.get('side') === 'seller' ? 'seller' : 'buyer'

  const deal = useQuery({ queryKey: ['public-deal', id], queryFn: () => api.getDeal(id) })
  const confirm = useMoneyAction(() => api.confirmDeal(id, side))

  if (deal.isPending) {
    return (
      <PublicFrame>
        <Skeleton className="h-72" />
      </PublicFrame>
    )
  }

  if (deal.isError || !deal.data) {
    return (
      <PublicFrame>
        <Card className="p-8 text-center">
          <p className="font-medium text-fg">We can't find this payment.</p>
          <p className="mt-1 text-sm text-fg-muted">The link may have expired.</p>
        </Card>
      </PublicFrame>
    )
  }

  const d = deal.data
  const alreadyConfirmed = d.confirmations.some((c) => c.side === side)
  const otherSide: ConfirmSide = side === 'buyer' ? 'seller' : 'buyer'
  const otherConfirmed = d.confirmations.some((c) => c.side === otherSide)
  const canConfirm =
    ['funded_held', 'confirmed_buyer', 'confirmed_seller'].includes(d.status) &&
    !alreadyConfirmed

  return (
    <PublicFrame>
      <Card>
        <div className="border-b border-line px-6 py-5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h1 className="font-semibold text-fg">{d.description}</h1>
              <p className="mt-1 text-sm text-fg-muted">
                {formatMoney(d.amount, d.currency)}
                {d.expected_complete_at &&
                  ` · due ${formatDate(d.expected_complete_at)}`}
              </p>
            </div>
            <Badge meta={DEAL_STATUS_META[d.status]} />
          </div>
        </div>

        <div className="px-6 py-5">
          <p className="text-sm text-fg">{plainStatus(d, side)}</p>
        </div>

        <Steps deal={d} />

        {canConfirm && (
          <div className="border-t border-line px-6 py-5">
            <p className="text-sm font-medium text-fg">
              {otherConfirmed
                ? 'The other side has confirmed. Yours is the last step.'
                : 'Ready to confirm?'}
            </p>
            <p className="mt-1 text-sm text-fg-muted">
              {side === 'buyer'
                ? 'Only confirm once you have received what you paid for.'
                : 'Only confirm once you have delivered the service.'}{' '}
              {otherConfirmed && 'Confirming releases the money immediately.'}
            </p>
            <Button
              variant="primary"
              className="mt-3 w-full"
              disabled={confirm.isPending}
              onClick={() => confirm.mutate()}
            >
              {confirm.isPending ? 'Confirming…' : 'Confirm — everything is fine'}
            </Button>
            {confirm.isError && (
              <div className="mt-3">
                <ErrorNote message={confirm.error.message} />
              </div>
            )}
          </div>
        )}

        {alreadyConfirmed && d.status !== 'paid_out' && (
          <div className="border-t border-line bg-surface-2 px-6 py-4 text-sm text-fg-muted">
            You have confirmed.{' '}
            {otherConfirmed
              ? 'The money has been released.'
              : `Waiting on the ${otherSide}.`}
          </div>
        )}
      </Card>
    </PublicFrame>
  )
}

/** No jargon, no status codes — what this means for the person reading it. */
function plainStatus(deal: Deal, side: ConfirmSide): string {
  switch (deal.status) {
    case 'created':
    case 'checkout_started':
      return 'This payment has not been made yet.'
    case 'payment_pending':
      return side === 'buyer'
        ? 'Your payment is going through. This page will update when it lands.'
        : 'The buyer has started paying. Nothing is held until it goes through.'
    case 'payment_failed':
      return side === 'buyer'
        ? 'That payment did not go through. You have not been charged, and you can try again.'
        : 'The buyer’s payment did not go through. They can try again.'
    case 'expired':
      return 'This payment link has expired. Nobody was charged.'
    case 'canceled':
      return 'This was called off before any money moved.'
    case 'funded_held':
    case 'in_progress':
    case 'revision_requested':
    case 'confirmed_buyer':
    case 'confirmed_seller':
      return side === 'buyer'
        ? 'Your money is held safely. The seller cannot access it until you confirm.'
        : 'The buyer has paid and the money is held. It will reach you once both sides confirm.'
    case 'clearing':
      return side === 'buyer'
        ? 'Both sides confirmed — the money has been released to the seller.'
        : 'Both sides confirmed. Your payout is being prepared and will be sent shortly.'
    case 'released':
      return side === 'buyer'
        ? 'Both sides confirmed — the money has been released to the seller.'
        : 'Your payout is ready and will be sent to your account.'
    case 'payout_pending':
      return side === 'buyer'
        ? 'This is complete on your side. The seller is being paid.'
        : 'Your payout is on its way. Your provider will show it once it arrives.'
    case 'paid_out':
      return side === 'buyer'
        ? 'This is complete. The seller has been paid.'
        : 'You have been paid. This is complete.'
    case 'refunded':
      return side === 'buyer'
        ? 'This payment was refunded to you in full.'
        : 'This payment was refunded to the buyer.'
    case 'partially_refunded':
      return side === 'buyer'
        ? 'Part of this payment was refunded to you. The rest went to the seller.'
        : 'Part of this payment went back to the buyer. The rest is yours.'
    case 'disputed':
      return 'A dispute is open. The money stays held while it is reviewed — nobody can take it in the meantime.'
  }
}

function Steps({ deal }: { deal: Deal }) {
  const funded = deal.status !== 'created'
  const buyer = deal.confirmations.some((c) => c.side === 'buyer')
  const seller = deal.confirmations.some((c) => c.side === 'seller')

  const steps = [
    { label: 'Payment received', done: funded },
    { label: 'Buyer confirmed', done: buyer },
    { label: 'Seller confirmed', done: seller },
    { label: 'Money released', done: Boolean(deal.released_at) },
    { label: 'Seller paid', done: deal.status === 'paid_out' },
  ]

  return (
    <ol className="border-t border-line px-6 py-4">
      {steps.map((step) => (
        <li key={step.label} className="flex items-center gap-3 py-1.5">
          <Dot tone={step.done ? 'released' : 'neutral'} />
          <span
            className={cx('text-sm', step.done ? 'text-fg' : 'text-fg-subtle')}
          >
            {step.label}
          </span>
        </li>
      ))}
    </ol>
  )
}
