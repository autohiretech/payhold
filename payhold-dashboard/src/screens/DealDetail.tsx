import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  api,
  HOLDING_STATUSES,
  PAST_HOLD_STATUSES,
  PRE_FUNDING_STATUSES,
  type CheckoutSession,
  type ConfirmSide,
  type Deal,
  type DealAmounts,
  type DealStatus,
  type Money,
  type RefundStatus,
} from '@/api'
import { ZERO_DECIMAL_CURRENCIES } from '@/lib/countries'
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
  toMajorUnits,
  toMinorUnits,
  type StatusMeta,
  type Tone,
} from '@/lib/format'
import { COUNTRY_LABEL, METHOD_LABEL, PROVIDER_LABEL } from '@/lib/rails'
import { formatRate } from '@/lib/fx'
import {
  useAudit,
  useCheckoutSessions,
  useDeal,
  useDealAmounts,
  useLedger,
  useMoneyAction,
  useMoneyMutation,
  useRefunds,
  useSellers,
} from '@/lib/queries'

export function DealDetailPage() {
  const { id = '' } = useParams()
  const deal = useDeal(id)
  const sellers = useSellers()
  const ledger = useLedger(id)
  const audit = useAudit(id)
  const amounts = useDealAmounts(id)
  const refunds = useRefunds(id)
  const now = new Date()

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

          {refunds.data && refunds.data.length > 0 && (
            <Card>
              <CardHeader
                title="Refunds"
                subtitle="A refund is a record with a lifetime, not a single entry — some rails settle one weeks after it is issued."
              />
              <Table>
                <thead>
                  <tr>
                    <Th>Reason</Th>
                    <Th>Issued by</Th>
                    <Th>State</Th>
                    <Th align="right">Amount</Th>
                    <Th align="right">When</Th>
                  </tr>
                </thead>
                <tbody>
                  {refunds.data.map((r) => (
                    <tr key={r.id}>
                      <Td className="max-w-64 truncate font-medium">{r.reason}</Td>
                      <Td className="text-fg-muted">{r.actor}</Td>
                      <Td>
                        <Badge meta={REFUND_STATUS_META[r.status]} />
                      </Td>
                      <Td align="right" className="tabular font-medium">
                        {formatMoney(r.amount, r.currency)}
                      </Td>
                      <Td align="right" className="text-fg-muted">
                        {formatDateTime(r.settled_at ?? r.created_at)}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Card>
          )}

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
                <li key={entry.id} className="flex gap-4 px-6 py-3 text-sm">
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
          <PaymentLink deal={d} now={now} />

          <Card className="p-6">
            <Breakdown deal={d} amounts={amounts.data} loading={amounts.isPending} />

            <dl className="mt-4 space-y-2 border-t border-line pt-3 text-sm">
              <Row
                label="Seller"
                value={
                  seller ? (
                    <Link className="text-brand hover:underline" to={`/sellers/${seller.id}`}>
                      {seller.name}
                    </Link>
                  ) : (
                    d.seller_id
                  )
                }
                muted
              />
              <Row label="Payout to" value={seller?.masked_destination ?? '—'} muted />
              <Row
                label="Paid with"
                value={
                  d.payment_method
                    ? [d.payment_network, METHOD_LABEL[d.payment_method]]
                        .filter(Boolean)
                        .join(' · ')
                    : 'not paid yet'
                }
                muted
              />
              <Row
                label="Buyer market"
                value={COUNTRY_LABEL[d.buyer_country] ?? d.buyer_country}
                muted
              />
              <Row label="Rail" value={PROVIDER_LABEL[d.provider]} muted />
              <Row label="Provider ref" value={d.provider_ref ?? '—'} muted />
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
  hint,
}: {
  label: string
  value: React.ReactNode
  muted?: boolean
  strong?: boolean
  hint?: string
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-fg-muted">
        {label}
        {hint && (
          <span className="mt-0.5 block max-w-44 text-xs leading-relaxed text-fg-subtle">
            {hint}
          </span>
        )}
      </dt>
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

const REFUND_STATUS_META: Record<RefundStatus, StatusMeta> = {
  pending: {
    label: 'Pending',
    tone: 'pending',
    hint: 'Issued and not yet settled by the rail.',
  },
  succeeded: {
    label: 'Settled',
    tone: 'released',
    hint: 'The money is back with the buyer.',
  },
  failed: {
    label: 'Failed',
    tone: 'danger',
    hint: 'The rail could not return it. It no longer counts against what is refundable.',
  },
}

// ---------------------------------------------------------------------------

/**
 * §7's breakdown — nine figures, all in the presentment currency, all derived
 * from the ledger.
 *
 * The distinction the card is built around is **agreed against happened**. Until
 * money arrives every figure here is zero, and showing zeroes would read as a
 * deal worth nothing; so an unfunded deal shows what was agreed, labelled as
 * such, and a funded one shows what the ledger says. They are never mixed —
 * `Deal.fee_amount` is settlement currency and `DealAmounts.platform_fee` is
 * presentment, and adding the two sets together is the mistake this note exists
 * to prevent.
 */
function Breakdown({
  deal,
  amounts,
  loading,
}: {
  deal: Deal
  amounts: DealAmounts | undefined
  loading: boolean
}) {
  const converted = deal.presentment_currency !== deal.currency
  const rate = deal.fx_rate
    ? formatRate(deal.currency, deal.presentment_currency, deal.fx_rate)
    : 'locks when paid'

  if (loading) {
    return (
      <>
        <h2 className="text-sm font-semibold text-fg">Money</h2>
        <Skeleton className="mt-3 h-32" />
      </>
    )
  }

  // `buyer_paid` is the one figure that cannot be zero once anything happened,
  // so it is what tells the two halves apart.
  const funded = Boolean(amounts && amounts.buyer_paid !== 0)

  if (!funded) {
    return (
      <>
        <h2 className="text-sm font-semibold text-fg">Money</h2>
        <p className="mt-1 text-xs text-fg-muted">
          What was agreed. Nothing has moved yet.
        </p>
        <dl className="mt-3 space-y-2 text-sm">
          <Row label="Deal amount" value={formatMoney(deal.amount, deal.currency)} />
          {converted && (
            <>
              <Row
                label="Buyer charged"
                value={formatMoney(deal.presentment_amount, deal.presentment_currency)}
                muted
              />
              <Row label="Rate" value={rate} muted />
            </>
          )}
          <Row
            label="Your fee"
            value={`− ${formatMoney(deal.fee_amount, deal.currency)}`}
            muted
          />
          <div className="border-t border-line pt-2">
            <Row
              label="Seller receives"
              value={formatMoney(deal.amount - deal.fee_amount, deal.currency)}
              strong
            />
          </div>
          {deal.deposit_amount !== null && (
            <Row
              label="Security deposit"
              value={formatMoney(deal.deposit_amount, deal.currency)}
              muted
            />
          )}
          {deal.split_percent !== null && (
            <Row
              label="Due on return"
              value={formatMoney(deal.balance_amount ?? 0, deal.presentment_currency)}
              muted
              hint="Charged automatically once the rental is confirmed returned — no review step."
            />
          )}
        </dl>
      </>
    )
  }

  const a = amounts!
  const money = (value: Money) => formatMoney(value, a.currency)

  // Zero rows are dropped rather than shown as nothing: tax, reserve and
  // receivable apply to a minority of deals, and six permanent zeroes would
  // bury the four figures that are always true.
  const deductions: [string, Money, string][] = [
    ['PayHold fee', a.platform_fee, 'Our commission. Reclassified, not sent anywhere.'],
    ['Rail fee', a.provider_fee, 'What the provider charged. This one really left.'],
    ['Tax', a.tax, 'Collected and held to pass on.'],
    ['Refunded', a.refunded, 'Returned to the buyer.'],
    ['Held back', a.reserve, 'A new seller’s reserve. Unpayable until it is released.'],
  ]

  return (
    <>
      <h2 className="text-sm font-semibold text-fg">Money</h2>
      <p className="mt-1 text-xs text-fg-muted">
        Derived from the ledger, never stored.
      </p>
      <dl className="mt-3 space-y-2 text-sm">
        <Row label="Buyer paid" value={money(a.buyer_paid)} />
        {converted && <Row label="Rate" value={rate} muted />}

        {deductions
          .filter(([, value]) => value !== 0)
          .map(([label, value, hint]) => (
            <Row key={label} label={label} value={`− ${money(value)}`} muted hint={hint} />
          ))}

        <div className="border-t border-line pt-2">
          <Row label="Seller receives" value={money(a.seller_net)} strong />
        </div>

        {a.paid_out !== 0 && <Row label="Already paid out" value={money(a.paid_out)} muted />}
        {a.receivable !== 0 && (
          <Row
            label="Owed back by seller"
            value={money(a.receivable)}
            muted
            hint="A refund landed after they were paid. No provider is holding this — somebody has to collect it."
          />
        )}
        {deal.deposit_amount !== null && (
          <Row
            label="Security deposit"
            value={formatMoney(deal.deposit_amount, deal.currency)}
            muted
          />
        )}
        {deal.split_percent !== null && (
          <Row
            label={deal.balance_amount ? 'Balance still due on return' : 'Balance'}
            value={
              deal.balance_amount
                ? formatMoney(deal.balance_amount, deal.presentment_currency)
                : 'Collected'
            }
            muted
            hint={
              deal.balance_amount
                ? 'Charged automatically once the rental is confirmed returned, plus overage if it comes back late.'
                : 'Charged when the rental was confirmed returned. Any overage is folded into what was collected.'
            }
          />
        )}
      </dl>
    </>
  )
}

// ---------------------------------------------------------------------------

/**
 * §10.1's payment link, where the person who has to re-send it works.
 *
 * The card only exists while a link could do something. A session is a scoped,
 * expiring credential for one payment, so issuing one is idempotent — the button
 * hands back the live link rather than minting a second, because two live links
 * against one hold is two charges for one booking.
 *
 * The token is shown because the token *is* the link. It is the one credential
 * in the product that has to stay re-derivable: re-sending a payment link is
 * ordinary support, and a link nobody can read again is a deal nobody can
 * rescue.
 */
function PaymentLink({ deal, now }: { deal: Deal; now: Date }) {
  const sessions = useCheckoutSessions(deal.id)
  const open = useMoneyAction(() => api.openCheckoutSession(deal.id))
  const [withdrawing, setWithdrawing] = useState<string | null>(null)
  const cancel = useMoneyAction(() =>
    api.cancelCheckoutSession(withdrawing ?? ''),
  )

  const live = sessions.data?.find((s) => sessionState(s, now) === 'open')
  const past = (sessions.data ?? []).filter((s) => s !== live)

  // Once the buyer has paid there is nothing a link can do, and offering one
  // would invite a second charge against a hold that is already funded.
  const issuable = ['created', 'checkout_started', 'payment_failed'].includes(deal.status)

  if (!issuable && past.length === 0) return null

  const error = open.error ?? cancel.error

  return (
    <Card className="p-6">
      <h2 className="text-sm font-semibold text-fg">Payment link</h2>

      {live ? (
        <>
          <p className="mt-1 text-xs text-fg-muted">
            Live until {formatDateTime(live.expires_at)} (
            {formatRelative(live.expires_at, now)}). Send the buyer here.
          </p>
          <div className="mt-3 rounded-lg bg-surface-2 px-3 py-2 break-all">
            <Mono>{`${location.origin}/pay/${live.token}`}</Mono>
          </div>
          <div className="mt-3 flex gap-2">
            <Button
              size="sm"
              onClick={() =>
                void navigator.clipboard?.writeText(
                  `${location.origin}/pay/${live.token}`,
                )
              }
            >
              Copy
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={cancel.isPending}
              onClick={() => {
                setWithdrawing(live.id)
                cancel.mutate()
              }}
            >
              Withdraw
            </Button>
          </div>
        </>
      ) : issuable ? (
        <>
          <p className="mt-1 text-xs leading-relaxed text-fg-muted">
            No live link. Issuing one lets the buyer choose how to pay without an
            account — and cannot fund the deal by itself.
          </p>
          <Button
            className="mt-3"
            size="sm"
            variant="primary"
            disabled={open.isPending}
            onClick={() => open.mutate()}
          >
            {open.isPending ? 'Issuing…' : 'Issue a payment link'}
          </Button>
        </>
      ) : null}

      {past.length > 0 && (
        <ul className="mt-4 space-y-1.5 border-t border-line pt-3 text-xs text-fg-muted">
          {past.map((s) => (
            <li key={s.id} className="flex justify-between gap-3">
              <span>{SESSION_STATE_LABEL[sessionState(s, now)]}</span>
              <span>{formatDateTime(s.completed_at ?? s.created_at)}</span>
            </li>
          ))}
        </ul>
      )}

      {error && <div className="mt-3"><ErrorNote message={error.message} /></div>}
    </Card>
  )
}

/**
 * Expiry is derived here as it is in the engine — a stored value would need a
 * writer, and the writer would be a sweep that had not run yet.
 */
function sessionState(session: CheckoutSession, now: Date) {
  if (session.status === 'open' && new Date(session.expires_at) <= now) return 'expired'
  return session.status
}

const SESSION_STATE_LABEL: Record<string, string> = {
  open: 'Live',
  completed: 'Used — buyer went to pay',
  canceled: 'Withdrawn',
  expired: 'Expired unused',
}

// ---------------------------------------------------------------------------

/**
 * How far through the machine a status is.
 *
 * Only the states that are a *sequence* get a rank. `disputed`, `refunded`,
 * `expired` and `canceled` are branches off it, so they take the rank of the
 * point they branched from and the branch is rendered separately — a dispute is
 * not "further along" than a hold, and a stage bar that said so would be
 * telling an operator the money had progressed.
 */
const REACHED: Record<DealStatus, number> = {
  created: 0,
  checkout_started: 1,
  payment_pending: 1,
  payment_failed: 1,
  expired: 0,
  canceled: 0,
  funded_held: 2,
  in_progress: 2,
  revision_requested: 2,
  confirmed_buyer: 2,
  confirmed_seller: 2,
  clearing: 3,
  released: 4,
  payout_pending: 5,
  paid_out: 6,
  refunded: 2,
  partially_refunded: 2,
  disputed: 2,
}

/** The state a step is in, which is three things and not two. */
type StepTone = 'done' | 'current' | 'pending' | 'stopped'

interface Step {
  label: string
  tone: StepTone
  detail: string
}

/**
 * The lifecycle, shown as a fixed set of steps rather than a scroll of events.
 * The whole product rests on people understanding *why* their money has not
 * moved yet, so the two confirmations get their own row.
 *
 * §6 has eighteen states and this has eight steps, which is deliberate: most of
 * the new ones are *positions within* a step rather than steps of their own.
 * `checkout_started`, `payment_pending` and `payment_failed` are three things
 * that can be true while the buyer is paying; `in_progress` and
 * `revision_requested` are two things that can be true while the money is held.
 * Giving each a row of its own would produce a list where six rows are
 * permanently grey on every deal that went smoothly.
 *
 * The exception is **clearing against released**, which do get separate rows.
 * They are the same money in the same place and they differ in exactly one way
 * that matters to whoever is looking: whether the payout may go. A deal sitting
 * in `released` is one where something is stopping it, and collapsing the two
 * would hide precisely the state somebody needs to see.
 */
function Timeline({ deal, now }: { deal: Deal; now: Date }) {
  const buyer = deal.confirmations.find((c) => c.side === 'buyer')
  const seller = deal.confirmations.find((c) => c.side === 'seller')
  const at = REACHED[deal.status]

  /** A step in the sequence: done past its rank, current on it, pending after. */
  const stage = (rank: number): StepTone =>
    at > rank ? 'done' : at === rank ? 'current' : 'pending'

  const confirmDetail = (side: typeof buyer) =>
    side
      ? `${formatDateTime(side.confirmed_at)}${side.actor === 'auto' ? ' (timer)' : ''}`
      : deal.auto_release_at
        ? `Auto-confirms ${formatRelative(deal.auto_release_at, now)}`
        : 'Waiting'

  const steps: Step[] = [
    {
      label: 'Deal created',
      tone: 'done',
      detail: formatDateTime(deal.created_at),
    },
    {
      label:
        deal.status === 'payment_failed' ? 'Payment failed' : 'Buyer at the checkout',
      tone: deal.status === 'payment_failed' ? 'stopped' : stage(1),
      detail:
        deal.status === 'payment_failed'
          ? 'The charge did not go through. A new link lets them try again.'
          : deal.status === 'payment_pending'
            ? 'They chose a method and were handed to the provider.'
            : at > 1
              ? 'Done'
              : 'No payment started',
    },
    {
      label: 'Funds held',
      tone: stage(2),
      detail:
        at < 2
          ? 'Nothing has arrived'
          : deal.status === 'revision_requested'
            ? 'The buyer asked for something to be put right. Still held.'
            : deal.status === 'in_progress'
              ? 'The work is under way. Still held.'
              : 'Neither side can touch it',
    },
    {
      label: 'Buyer confirmed',
      tone: buyer ? 'done' : at < 2 ? 'pending' : 'current',
      detail: confirmDetail(buyer),
    },
    {
      label: 'Seller confirmed',
      tone: seller ? 'done' : at < 2 ? 'pending' : 'current',
      detail: seller
        ? `${formatDateTime(seller.confirmed_at)}${seller.actor === 'auto' ? ' (timer)' : ''}`
        : 'Waiting',
    },
    {
      label: 'Clearing',
      tone: stage(3),
      detail: deal.released_at
        ? `Released ${formatDateTime(deal.released_at)}${
            deal.payout_due_at && at === 3
              ? ` · clears ${formatRelative(deal.payout_due_at, now)}`
              : ''
          }`
        : 'Needs both sides',
    },
    {
      label: 'Ready to pay out',
      tone: stage(4),
      detail:
        at === 4
          ? 'The window has passed and the payout has not gone. Check the Payouts screen.'
          : at > 4
            ? 'Cleared'
            : 'Inside the clearance window',
    },
    {
      label: 'Paid out to seller',
      tone: stage(6),
      detail:
        deal.status === 'paid_out'
          ? 'Complete'
          : deal.status === 'payout_pending'
            ? 'The transfer is with the provider'
            : deal.payout_due_at
              ? `Due ${formatRelative(deal.payout_due_at, now)}`
              : '—',
    },
  ]

  // The branches. Each one replaces the tail rather than sitting after it: a
  // refunded deal did not go on to clear, and a row saying it is still waiting
  // to would be a claim about money that went back.
  if (deal.status === 'refunded') {
    steps.splice(3, steps.length, {
      label: 'Refunded to buyer',
      tone: 'done',
      detail: 'The hold was reversed in full',
    })
  } else if (deal.status === 'expired' || deal.status === 'canceled') {
    steps.splice(1, steps.length, {
      label: deal.status === 'expired' ? 'Expired unpaid' : 'Cancelled',
      tone: 'stopped',
      detail: 'Nothing was charged and nothing is owed',
    })
  } else if (deal.status === 'disputed') {
    // A dispute is appended rather than substituted: everything above it really
    // happened, and it is what stopped the rest.
    steps.splice(REACHED.clearing, steps.length, {
      label: 'Disputed',
      tone: 'stopped',
      detail: 'Release and payout are both blocked until this resolves',
    })
  }

  return (
    <Card>
      <CardHeader
        title="Lifecycle"
        subtitle="Where this deal is, and what it is waiting on."
      />
      <ol className="px-6 py-5">
        {steps.map((step, i) => (
          <li key={step.label} className="flex gap-3">
            <div className="flex flex-col items-center">
              <Dot tone={STEP_TONE[step.tone]} />
              {i < steps.length - 1 && (
                <span
                  className={cx(
                    'w-px flex-1',
                    step.tone === 'done' ? 'bg-released/40' : 'bg-line',
                  )}
                />
              )}
            </div>
            <div className={cx('pb-4', i === steps.length - 1 && 'pb-0')}>
              <p
                className={cx(
                  'text-sm leading-none font-medium',
                  step.tone === 'pending' ? 'text-fg-subtle' : 'text-fg',
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

const STEP_TONE: Record<StepTone, Tone> = {
  done: 'released',
  current: 'held',
  pending: 'neutral',
  stopped: 'danger',
}

// ---------------------------------------------------------------------------

function Actions({ deal }: { deal: Deal }) {
  const [refundReason, setRefundReason] = useState('')
  const [refundAmount, setRefundAmount] = useState('')
  const [disputeReason, setDisputeReason] = useState('')
  const [captureAmount, setCaptureAmount] = useState('')
  const [panel, setPanel] = useState<'refund' | 'dispute' | 'deposit' | null>(null)
  const refunds = useRefunds(deal.id)

  // What is still refundable, derived rather than stored — the same sum the
  // engine guards with, so the form cannot offer more than the call will take.
  // A failed refund never left, so it does not count; a pending one is expected
  // to, so it does.
  const alreadyRefunded = (refunds.data ?? [])
    .filter((r) => r.status !== 'failed')
    .reduce((n, r) => n + r.amount, 0)
  const refundable = deal.presentment_amount - alreadyRefunded

  const confirmMutation = useMoneyMutation((side: ConfirmSide) =>
    api.confirmDeal(deal.id, side),
  )
  // §7.1: an empty amount means everything still refundable, which is what
  // every caller meant before partials existed.
  const refund = useMoneyAction(() =>
    api.refundDeal(
      deal.id,
      refundReason,
      refundAmount ? toMinorUnits(Number(refundAmount), deal.presentment_currency) : undefined,
    ),
  )
  const dispute = useMoneyAction(() =>
    api.openDispute(deal.id, 'buyer', disputeReason),
  )
  const capture = useMoneyAction(() =>
    // `deposit_amount` is a Deal column — the agreement, in the settlement
    // currency (`deal.currency`) — not `presentment_currency`, which is
    // §7's ledger-derived figures. The two can differ.
    api.captureDeposit(deal.id, toMinorUnits(Number(captureAmount), deal.currency)),
  )
  const releaseDeposit = useMoneyAction(() => api.releaseDeposit(deal.id))

  const canConfirm = HOLDING_STATUSES.includes(deal.status) && deal.status !== 'disputed'
  // §7.1 reaches past the hold: after release the ledger puts the money back
  // and takes it out again, and after payout it books what the seller owes. So
  // the four cases differ in what the ledger does, not in whether the button
  // exists — the engine decides which one applies.
  const canRefund =
    HOLDING_STATUSES.includes(deal.status) || PAST_HOLD_STATUSES.includes(deal.status)
  // §6 adds `clearing -> disputed`: a chargeback arrives when it arrives, and
  // the safety window is most of what it is for.
  const canDispute = canConfirm || deal.status === 'clearing'
  const hasDeposit = deal.deposit_amount !== null && deal.deposit_amount > 0
  const isPreFunding = PRE_FUNDING_STATUSES.includes(deal.status)

  const error =
    confirmMutation.error ?? refund.error ?? dispute.error ?? capture.error ?? releaseDeposit.error

  return (
    <Card className="p-6">
      <h2 className="text-sm font-semibold text-fg">Actions</h2>

      {!canConfirm && !canRefund && !hasDeposit && (
        <p className="mt-2 text-sm text-fg-muted">
          {isPreFunding
            ? "Waiting for the buyer to pay. There's nothing to do here yet."
            : 'This deal is settled. Nothing further can be done to it.'}
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
            <Field
              label="Amount"
              hint={`Leave empty to refund all ${formatMoney(
                refundable,
                deal.presentment_currency,
              )} still refundable.`}
            >
              <Input
                type="number"
                min="0"
                step={ZERO_DECIMAL_CURRENCIES.includes(deal.presentment_currency) ? '1' : '0.01'}
                max={toMajorUnits(refundable, deal.presentment_currency)}
                value={refundAmount}
                onChange={(e) => setRefundAmount(e.target.value)}
                placeholder="everything"
              />
            </Field>
            {alreadyRefunded > 0 && (
              <p className="text-xs leading-relaxed text-fg-muted">
                {formatMoney(alreadyRefunded, deal.presentment_currency)} has already
                gone back. A partial refund does not change the deal's status — the
                rest still has to be delivered and paid out.
              </p>
            )}
            <Button
              size="sm"
              variant="danger"
              disabled={!refundReason || refund.isPending || refundable <= 0}
              onClick={() => refund.mutate()}
            >
              Refund{' '}
              {refundAmount
                ? formatMoney(
                    toMinorUnits(Number(refundAmount), deal.presentment_currency),
                    deal.presentment_currency,
                  )
                : formatMoney(refundable, deal.presentment_currency)}
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
                step={ZERO_DECIMAL_CURRENCIES.includes(deal.currency) ? '1' : '0.01'}
                max={toMajorUnits(deal.deposit_amount ?? 0, deal.currency)}
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
