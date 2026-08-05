import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, type ConfirmSide, type Deal } from '@/api'
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Dot,
  EmptyState,
  ErrorNote,
  Field,
  Input,
  Mono,
  PageHeader,
  Skeleton,
  Table,
  Td,
  Textarea,
  Th,
  cx,
} from '@/components/ui'
import {
  DEAL_STATUS_META,
  formatDateTime,
  formatMoney,
  formatRelative,
} from '@/lib/format'
import {
  simNow,
  useAudit,
  useDeal,
  useLedger,
  useMoneyAction,
  useMoneyMutation,
  useSellers,
} from '@/lib/queries'

export function DealDetailPage() {
  const { id = '' } = useParams()
  const deal = useDeal(id)
  const sellers = useSellers()
  const ledger = useLedger(id)
  const audit = useAudit(id)
  const now = simNow()

  if (deal.isPending) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40" />
        <Skeleton className="h-60" />
      </div>
    )
  }

  if (deal.isError || !deal.data) {
    return (
      <Card>
        <EmptyState
          title="Deal not found"
          body="It may belong to another account, or the id is wrong."
          action={
            <Link to="/deals">
              <Button>Back to deals</Button>
            </Link>
          }
        />
      </Card>
    )
  }

  const d = deal.data
  const seller = sellers.data?.find((s) => s.id === d.seller_id)
  const net = d.amount - d.fee_amount

  return (
    <>
      <Link to="/deals" className="mb-3 inline-block text-sm text-fg-muted hover:text-fg">
        ← Deals
      </Link>

      <PageHeader
        title={d.description}
        subtitle={`${d.id} · buyer ref ${d.buyer_ref}`}
        action={<Badge meta={DEAL_STATUS_META[d.status]} />}
      />

      <p className="mb-6 max-w-2xl text-sm text-fg-muted">
        {DEAL_STATUS_META[d.status].hint}
      </p>

      <div className="grid gap-5 lg:grid-cols-[1fr_20rem]">
        <div className="min-w-0 space-y-5">
          <Timeline deal={d} now={now} />

          <Card>
            <CardHeader
              title="Ledger"
              subtitle="Every movement of money on this deal. Balances are derived from these entries."
            />
            {!ledger.data?.length ? (
              <EmptyState
                title="No entries yet"
                body="Nothing has moved — the buyer has not paid."
              />
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Entry</Th>
                    <Th>Provider ref</Th>
                    <Th align="right">Amount</Th>
                    <Th align="right">When</Th>
                  </tr>
                </thead>
                <tbody>
                  {ledger.data.map((e) => (
                    <tr key={e.id}>
                      <Td className="font-medium">{e.entry_type.replace(/_/g, ' ')}</Td>
                      <Td>
                        <Mono>{e.provider_ref ?? '—'}</Mono>
                      </Td>
                      <Td
                        align="right"
                        className={cx(
                          'tabular font-medium',
                          e.amount < 0 ? 'text-fg-muted' : 'text-fg',
                        )}
                      >
                        {e.amount > 0 ? '+' : ''}
                        {formatMoney(e.amount, e.currency)}
                      </Td>
                      <Td align="right" className="text-fg-muted">
                        {formatDateTime(e.created_at)}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>

          <Card>
            <CardHeader
              title="Audit trail"
              subtitle="Append-only. Written by the system on every transition and provider call."
            />
            <ol className="divide-y divide-line">
              {audit.data?.map((entry) => (
                <li key={entry.id} className="flex gap-3 px-5 py-3 text-sm">
                  <span className="w-32 shrink-0 text-fg-muted">
                    {formatDateTime(entry.created_at)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="font-medium text-fg">{entry.action}</span>
                    <span className="ml-2 text-fg-muted">by {entry.actor}</span>
                  </span>
                </li>
              ))}
            </ol>
          </Card>
        </div>

        <div className="space-y-5">
          <Card className="p-5">
            <h2 className="text-sm font-semibold text-fg">Money</h2>
            <dl className="mt-3 space-y-2 text-sm">
              <Row label="Deal amount" value={formatMoney(d.amount, d.currency)} />
              <Row
                label="Your fee"
                value={`− ${formatMoney(d.fee_amount, d.currency)}`}
                muted
              />
              <div className="border-t border-line pt-2">
                <Row label="Seller receives" value={formatMoney(net, d.currency)} strong />
              </div>
              {d.deposit_amount !== null && (
                <Row
                  label="Security deposit"
                  value={formatMoney(d.deposit_amount, d.currency)}
                  muted
                />
              )}
            </dl>

            <dl className="mt-4 space-y-2 border-t border-line pt-3 text-sm">
              <Row label="Seller" value={seller?.name ?? d.seller_id} muted />
              <Row label="Payout to" value={seller?.masked_destination ?? '—'} muted />
              <Row label="Provider" value={d.provider} muted />
              <Row
                label="Auto-release"
                value={
                  d.auto_release_at
                    ? `${formatRelative(d.auto_release_at, now)}`
                    : 'not started'
                }
                muted
              />
              <Row
                label="Payout due"
                value={d.payout_due_at ? formatRelative(d.payout_due_at, now) : '—'}
                muted
              />
            </dl>
          </Card>

          <Actions deal={d} />
        </div>
      </div>
    </>
  )
}

function Row({
  label,
  value,
  muted,
  strong,
}: {
  label: string
  value: string
  muted?: boolean
  strong?: boolean
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-fg-muted">{label}</dt>
      <dd
        className={cx(
          'tabular text-right',
          strong ? 'font-semibold text-fg' : muted ? 'text-fg-muted' : 'text-fg',
        )}
      >
        {value}
      </dd>
    </div>
  )
}

// ---------------------------------------------------------------------------

/**
 * The lifecycle, shown as a fixed set of steps rather than a scroll of events.
 * The whole product rests on people understanding *why* their money has not
 * moved yet, so the two confirmations get their own row.
 */
function Timeline({ deal, now }: { deal: Deal; now: Date }) {
  const buyer = deal.confirmations.find((c) => c.side === 'buyer')
  const seller = deal.confirmations.find((c) => c.side === 'seller')
  const funded = deal.status !== 'created'

  const steps = [
    {
      label: 'Deal created',
      done: true,
      detail: formatDateTime(deal.created_at),
    },
    {
      label: 'Buyer paid — funds held',
      done: funded,
      detail: funded ? 'Money is in the vault' : 'Waiting for payment',
    },
    {
      label: 'Buyer confirmed',
      done: Boolean(buyer),
      detail: buyer
        ? `${formatDateTime(buyer.confirmed_at)}${buyer.actor === 'auto' ? ' (timer)' : ''}`
        : deal.auto_release_at
          ? `Auto-confirms ${formatRelative(deal.auto_release_at, now)}`
          : '—',
    },
    {
      label: 'Seller confirmed',
      done: Boolean(seller),
      detail: seller
        ? `${formatDateTime(seller.confirmed_at)}${seller.actor === 'auto' ? ' (timer)' : ''}`
        : '—',
    },
    {
      label: 'Funds released',
      done: Boolean(deal.released_at),
      detail: deal.released_at ? formatDateTime(deal.released_at) : 'Needs both sides',
    },
    {
      label: 'Paid out to seller',
      done: deal.status === 'paid_out',
      detail:
        deal.status === 'paid_out'
          ? 'Complete'
          : deal.payout_due_at
            ? `Clears ${formatRelative(deal.payout_due_at, now)}`
            : '—',
    },
  ]

  if (deal.status === 'refunded') {
    steps.splice(2, 4, {
      label: 'Refunded to buyer',
      done: true,
      detail: 'The hold was reversed',
    })
  }

  return (
    <Card>
      <CardHeader title="Lifecycle" />
      <ol className="px-5 py-4">
        {steps.map((step, i) => (
          <li key={step.label} className="flex gap-3">
            <div className="flex flex-col items-center">
              <Dot tone={step.done ? 'released' : 'neutral'} />
              {i < steps.length - 1 && (
                <span
                  className={cx(
                    'w-px flex-1',
                    step.done ? 'bg-released/40' : 'bg-line',
                  )}
                />
              )}
            </div>
            <div className={cx('pb-4', i === steps.length - 1 && 'pb-0')}>
              <p
                className={cx(
                  'text-sm leading-none font-medium',
                  step.done ? 'text-fg' : 'text-fg-subtle',
                )}
              >
                {step.label}
              </p>
              <p className="mt-1 text-xs text-fg-muted">{step.detail}</p>
            </div>
          </li>
        ))}
      </ol>
    </Card>
  )
}

// ---------------------------------------------------------------------------

function Actions({ deal }: { deal: Deal }) {
  const [refundReason, setRefundReason] = useState('')
  const [disputeReason, setDisputeReason] = useState('')
  const [captureAmount, setCaptureAmount] = useState('')
  const [panel, setPanel] = useState<'refund' | 'dispute' | 'deposit' | null>(null)

  const confirmMutation = useMoneyMutation((side: ConfirmSide) =>
    api.confirmDeal(deal.id, side),
  )
  const refund = useMoneyAction(() => api.refundDeal(deal.id, refundReason))
  const dispute = useMoneyAction(() =>
    api.openDispute(deal.id, 'buyer', disputeReason),
  )
  const capture = useMoneyAction(() =>
    api.captureDeposit(deal.id, Math.round(Number(captureAmount) * 100)),
  )
  const releaseDeposit = useMoneyAction(() => api.releaseDeposit(deal.id))

  const canConfirm = ['funded_held', 'confirmed_buyer', 'confirmed_seller'].includes(
    deal.status,
  )
  const canRefund = canConfirm || deal.status === 'disputed'
  const canDispute = canConfirm
  const hasDeposit = deal.deposit_amount !== null && deal.deposit_amount > 0

  const error =
    confirmMutation.error ?? refund.error ?? dispute.error ?? capture.error ?? releaseDeposit.error

  return (
    <Card className="p-5">
      <h2 className="text-sm font-semibold text-fg">Actions</h2>

      {!canConfirm && !canRefund && !hasDeposit && (
        <p className="mt-2 text-sm text-fg-muted">
          This deal is settled. Nothing further can be done to it.
        </p>
      )}

      <div className="mt-3 space-y-2">
        {canConfirm && (
          <>
            <p className="text-xs text-fg-muted">
              Both sides must confirm before funds move. Confirming the second side
              releases immediately.
            </p>
            <div className="flex gap-2">
              {(['buyer', 'seller'] as ConfirmSide[]).map((side) => {
                const already = deal.confirmations.some((c) => c.side === side)
                return (
                  <Button
                    key={side}
                    size="sm"
                    variant={already ? 'ghost' : 'primary'}
                    disabled={already || confirmMutation.isPending}
                    onClick={() => confirmMutation.mutate(side)}
                  >
                    {already ? `${side} confirmed` : `Confirm as ${side}`}
                  </Button>
                )
              })}
            </div>
          </>
        )}

        {canDispute && (
          <ActionPanel
            open={panel === 'dispute'}
            onToggle={() => setPanel(panel === 'dispute' ? null : 'dispute')}
            label="Raise a dispute"
          >
            <Field label="What went wrong?">
              <Textarea
                value={disputeReason}
                onChange={(e) => setDisputeReason(e.target.value)}
                placeholder="Vehicle returned with damage…"
              />
            </Field>
            <Button
              size="sm"
              variant="danger"
              disabled={!disputeReason || dispute.isPending}
              onClick={() => dispute.mutate()}
            >
              Open dispute
            </Button>
          </ActionPanel>
        )}

        {canRefund && (
          <ActionPanel
            open={panel === 'refund'}
            onToggle={() => setPanel(panel === 'refund' ? null : 'refund')}
            label="Refund the buyer"
          >
            <Field label="Reason" hint="Recorded in the audit trail.">
              <Input
                value={refundReason}
                onChange={(e) => setRefundReason(e.target.value)}
                placeholder="Host cancelled"
              />
            </Field>
            <Button
              size="sm"
              variant="danger"
              disabled={!refundReason || refund.isPending}
              onClick={() => refund.mutate()}
            >
              Refund {formatMoney(deal.amount, deal.currency)}
            </Button>
          </ActionPanel>
        )}

        {hasDeposit && (
          <ActionPanel
            open={panel === 'deposit'}
            onToggle={() => setPanel(panel === 'deposit' ? null : 'deposit')}
            label="Security deposit"
          >
            <p className="text-xs text-fg-muted">
              {formatMoney(deal.deposit_amount ?? 0, deal.currency)} is pre-authorised
              on the buyer's card. Capture what you need for damage, or release it all.
            </p>
            <Field label="Capture amount">
              <Input
                type="number"
                min="0"
                step="0.01"
                value={captureAmount}
                onChange={(e) => setCaptureAmount(e.target.value)}
                placeholder="0"
              />
            </Field>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="primary"
                disabled={!captureAmount || capture.isPending}
                onClick={() => capture.mutate()}
              >
                Capture
              </Button>
              <Button
                size="sm"
                disabled={releaseDeposit.isPending}
                onClick={() => releaseDeposit.mutate()}
              >
                Release in full
              </Button>
            </div>
          </ActionPanel>
        )}
      </div>

      {error && <div className="mt-3"><ErrorNote message={error.message} /></div>}
    </Card>
  )
}

function ActionPanel({
  open,
  onToggle,
  label,
  children,
}: {
  open: boolean
  onToggle: () => void
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="border-t border-line pt-2">
      <button
        onClick={onToggle}
        className="flex w-full items-center justify-between text-sm font-medium text-fg-muted hover:text-fg"
      >
        {label}
        <span className="text-fg-subtle">{open ? '−' : '+'}</span>
      </button>
      {open && <div className="mt-3 space-y-3">{children}</div>}
    </div>
  )
}
