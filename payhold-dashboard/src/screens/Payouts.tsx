import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api, type PayoutStatus } from '@/api'
import { AiSuggestionCard, SparkIcon } from '@/components/ai'
import { useAuth } from '@/auth/AuthProvider'
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  ErrorNote,
  Field,
  Input,
  Mono,
  PageHeader,
  Skeleton,
  Table,
  Td,
  Th,
} from '@/components/ui'
import { PAYOUT_STATUS_META, formatMoney, formatRelative } from '@/lib/format'
import {
  simNow,
  useAiMutation,
  useAiSuggestions,
  useAiUsage,
  useMoneyMutation,
  usePayouts,
  useRiskSignals,
  useSellers,
  useSettings,
  useTenant,
} from '@/lib/queries'

export function PayoutsPage() {
  const payouts = usePayouts()
  const sellers = useSellers()
  const settings = useSettings()
  const tenant = useTenant()
  const signals = useRiskSignals()
  const now = simNow()

  // Who the approval is recorded as. It comes from the session and never from a
  // form: invariant 11 wants a person, and a caller that can name its own
  // approver can name somebody who was not there.
  const { account } = useAuth()
  const me = account?.full_name ?? account?.email ?? ''

  const retry = useMoneyMutation((id: string) => api.retryPayout(id))
  const approve = useMoneyMutation((id: string) => api.approvePayoutReview(id, me))

  // Stopping one payout, for the operator who knows something the rules do not.
  // The alternative before this existed was freezing the whole account, which
  // stops every honest seller to stop one.
  const [holding, setHolding] = useState<string | null>(null)
  const hold = useMoneyMutation((args: { id: string; reason: string }) =>
    api.holdPayout(args.id, me, args.reason),
  )

  /** The rules that stopped this one, in the words they were written in. */
  const holdReasons = (dealId: string) =>
    signals.data?.filter((s) => s.deal_id === dealId && s.severity === 'review') ?? []

  // The risk narrator: a summary of who is about to be paid, on demand,
  // before a person approves. It reads and writes a suggestion — it has no
  // say in whether the payout goes.
  const usage = useAiUsage()
  const suggestions = useAiSuggestions()
  const [checking, setChecking] = useState<string | null>(null)
  const summarise = useAiMutation((dealId: string) => api.draftRiskSummary(dealId))
  const aiReady = usage.data?.enabled && !usage.data.over_budget

  const summaryFor = (dealId: string) =>
    suggestions.data?.find(
      (s) => s.deal_id === dealId && s.output.kind === 'risk_summary',
    )

  const sellerFor = (id: string) => sellers.data?.find((s) => s.id === id)

  return (
    <>
      <PageHeader
        title="Payouts"
        subtitle={
          settings.data
            ? `Funds are payable ${settings.data.clearance_days} days after release.`
            : undefined
        }
      />

      {tenant.data?.status === 'payouts_frozen' && (
        <div className="mb-4">
          <ErrorNote message="Payouts are frozen for this account pending a reconciliation review. Scheduled transfers will not send." />
        </div>
      )}

      {retry.isError && (
        <div className="mb-4">
          <ErrorNote message={retry.error.message} />
        </div>
      )}

      {approve.isError && (
        <div className="mb-4">
          <ErrorNote message={approve.error.message} />
        </div>
      )}

      {hold.isError && (
        <div className="mb-4">
          <ErrorNote message={hold.error.message} />
        </div>
      )}

      <Card>
        <CardHeader
          title="All payouts"
          subtitle="One per released deal. Dispatched automatically when the clearance window closes."
        />
        {payouts.isPending ? (
          <div className="space-y-2 p-6">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-9" />
            ))}
          </div>
        ) : !payouts.data?.length ? (
          <EmptyState
            title="No payouts yet"
            body="A payout is queued as soon as a deal releases."
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Seller</Th>
                <Th>Destination</Th>
                <Th>Deal</Th>
                <Th>Status</Th>
                <Th align="right">Amount</Th>
                <Th align="right">Due</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {payouts.data.flatMap((p) => {
                const seller = sellerFor(p.seller_id)
                const summary = summaryFor(p.deal_id)
                const showSummary = checking === p.deal_id && summary
                // A hold is not collapsed behind a toggle. It is the one row on
                // this screen that is waiting on a person, so it says why.
                const held = p.status === 'held_for_review' ? holdReasons(p.deal_id) : []

                return [
                  <tr key={p.id} className="hover:bg-surface-2">
                    <Td className="font-medium">
                      {seller ? (
                        <Link
                          className="text-brand hover:underline"
                          to={`/sellers/${seller.id}`}
                        >
                          {seller.name}
                        </Link>
                      ) : (
                        <Mono>{p.seller_id}</Mono>
                      )}
                    </Td>
                    <Td className="text-fg-muted">
                      {seller?.masked_destination ?? '—'}
                    </Td>
                    <Td>
                      <Link to={`/deals/${p.deal_id}`} className="hover:underline">
                        <Mono>{p.deal_id}</Mono>
                      </Link>
                    </Td>
                    <Td>
                      <Badge meta={PAYOUT_STATUS_META[p.status]} />
                      {p.failure_reason && (
                        <p className="mt-1 max-w-56 text-xs text-danger">
                          {p.failure_reason}
                        </p>
                      )}
                    </Td>
                    <Td align="right" className="tabular font-medium">
                      {formatMoney(p.amount, p.currency)}
                    </Td>
                    <Td align="right" className="text-fg-muted">
                      {p.paid_at
                        ? formatRelative(p.paid_at, now)
                        : formatRelative(p.scheduled_for, now)}
                    </Td>
                    <Td align="right">
                      <span className="flex justify-end gap-1.5">
                        {p.status === 'held_for_review' ? (
                          <Button
                            size="sm"
                            disabled={approve.isPending}
                            onClick={() => approve.mutate(p.id)}
                          >
                            Approve and send
                          </Button>
                        ) : (
                          <>
                            {(p.status === 'failed' || p.status === 'frozen') && (
                              <Button
                                size="sm"
                                disabled={retry.isPending}
                                onClick={() => retry.mutate(p.id)}
                              >
                                Retry
                              </Button>
                            )}
                            {p.status === 'scheduled' && aiReady && (
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={summarise.isPending}
                                onClick={() => {
                                  setChecking(showSummary ? null : p.deal_id)
                                  if (!summary) summarise.mutate(p.deal_id)
                                }}
                              >
                                <SparkIcon className="size-3.5" />
                                {showSummary ? 'Hide' : 'Check'}
                              </Button>
                            )}
                            {/* Anything that has not left yet can be stopped.
                                `processing` is already with the provider, and a
                                button that implied otherwise would be worse
                                than no button. */}
                            {HOLDABLE.includes(p.status) && (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => setHolding(holding === p.id ? null : p.id)}
                              >
                                {holding === p.id ? 'Cancel' : 'Hold'}
                              </Button>
                            )}
                          </>
                        )}
                      </span>
                    </Td>
                  </tr>,

                  holding === p.id && (
                    <tr key={`${p.id}-hold`}>
                      <td colSpan={7} className="border-b border-line bg-surface-2/40 px-6 py-4">
                        <HoldForm
                          pending={hold.isPending}
                          onSubmit={async (reason) => {
                            await hold.mutateAsync({ id: p.id, reason })
                            setHolding(null)
                          }}
                        />
                      </td>
                    </tr>
                  ),

                  p.status === 'held_for_review' && (
                    <tr key={`${p.id}-held`}>
                      <td
                        colSpan={7}
                        className="border-b border-line bg-pending-soft/40 px-6 py-4"
                      >
                        {/* Who stopped it is the first thing an approver needs.
                            A person's hold comes with a sentence; a rule's comes
                            with the arithmetic it fired on. */}
                        {p.review_held_by ? (
                          <>
                            <p className="text-sm font-medium text-fg">
                              Held by {p.review_held_by}
                            </p>
                            <p className="mt-2 text-sm text-fg-muted">
                              {p.review_hold_reason}
                            </p>
                          </>
                        ) : (
                          <>
                            <p className="text-sm font-medium text-fg">
                              Held by {held.length === 1 ? 'a rule' : `${held.length} rules`}
                            </p>
                            <ul className="mt-2 space-y-1">
                              {held.map((s) => (
                                <li key={s.id} className="text-sm text-fg-muted">
                                  {s.explanation}
                                </li>
                              ))}
                            </ul>
                          </>
                        )}
                        <p className="mt-2 text-xs text-fg-muted">
                          Nothing has been sent. Approving records the decision
                          against you and dispatches the transfer.
                        </p>
                      </td>
                    </tr>
                  ),

                  showSummary && (
                    <tr key={`${p.id}-summary`}>
                      <td colSpan={7} className="border-b border-line bg-surface-2/30 px-6 py-4">
                        <AiSuggestionCard suggestion={summary} variant="inline" dealLink={false} />
                      </td>
                    </tr>
                  ),
                ]
              })}
            </tbody>
          </Table>
        )}
      </Card>

      <p className="mt-3 text-xs text-fg-muted">
        Attempts are recorded per payout. A failed transfer never silently
        disappears — it stays here until it succeeds or is cancelled.
      </p>
    </>
  )
}

/**
 * Anything that has not left. `processing` is with the provider already, and
 * `paid` is gone — recalling either is a conversation with Flutterwave rather
 * than a button, so there is no button.
 */
const HOLDABLE: PayoutStatus[] = [
  'scheduled',
  'failed',
  'frozen',
  // Already stopped, but by arithmetic. A person holding one of these converts
  // a machine's stop into one with a name on it, which is the only kind that
  // then needs a named approval to clear — and the gate still re-applies on the
  // next pass, so a hold cannot be used to smuggle a payout past it.
  'blocked',
  'needs_verification',
]

/**
 * Stopping a payout, with the reason attached.
 *
 * The reason is required and the field says why: the next person to look at
 * this row has nothing else to go on, and "held" with no sentence under it
 * reads to them as a system fault rather than somebody's judgement.
 */
function HoldForm({
  pending,
  onSubmit,
}: {
  pending: boolean
  onSubmit: (reason: string) => Promise<void>
}) {
  const [reason, setReason] = useState('')

  return (
    <form
      className="flex flex-wrap items-end gap-3"
      onSubmit={(e) => {
        e.preventDefault()
        void onSubmit(reason.trim())
      }}
    >
      <div className="min-w-64 flex-1">
        <Field
          label="Why are you holding this?"
          hint="Recorded against you, and shown to whoever clears it."
        >
          <Input
            required
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Seller unreachable — confirming the booking by phone"
          />
        </Field>
      </div>
      <Button type="submit" variant="primary" disabled={pending || !reason.trim()}>
        {pending ? 'Holding…' : 'Hold this payout'}
      </Button>
    </form>
  )
}
