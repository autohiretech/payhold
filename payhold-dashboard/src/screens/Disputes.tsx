import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api, type Dispute } from '@/api'
import {
  AiSuggestionCard,
  AiUnavailable,
  DisputeStatements,
  DraftButton,
} from '@/components/ai'
import {
  Button,
  Card,
  CardHeader,
  EmptyState,
  ErrorNote,
  Field,
  Mono,
  PageHeader,
  Skeleton,
  Textarea,
  cx,
} from '@/components/ui'
import { formatDateTime, formatMoney } from '@/lib/format'
import {
  useAiAction,
  useAiSuggestions,
  useAiUsage,
  useDeals,
  useDisputes,
  useMoneyMutation,
} from '@/lib/queries'

/** Who an approval is recorded as. Real auth will supply this. */
const ME = 'grace@autohire.rw'

export function DisputesPage() {
  const disputes = useDisputes()
  const deals = useDeals()

  const open = disputes.data?.filter((d) => d.status === 'open') ?? []
  const closed = disputes.data?.filter((d) => d.status !== 'open') ?? []

  return (
    <>
      <PageHeader
        title="Disputes"
        subtitle="While a dispute is open the money stays put — it can neither release nor refund."
      />

      {disputes.isPending ? (
        <div className="space-y-3">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-40" />
          ))}
        </div>
      ) : !disputes.data?.length ? (
        <Card>
          <EmptyState
            title="No disputes"
            body="Either side can open one from the deal page while funds are held."
          />
        </Card>
      ) : (
        <div className="space-y-5">
          {open.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-xs font-medium tracking-wide text-fg-muted uppercase">
                Open — {open.length}
              </h2>
              {open.map((d) => (
                <DisputeCard
                  key={d.id}
                  dispute={d}
                  amount={amountFor(deals.data, d.deal_id)}
                />
              ))}
            </section>
          )}

          {closed.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-xs font-medium tracking-wide text-fg-muted uppercase">
                Resolved
              </h2>
              {closed.map((d) => (
                <DisputeCard
                  key={d.id}
                  dispute={d}
                  amount={amountFor(deals.data, d.deal_id)}
                />
              ))}
            </section>
          )}
        </div>
      )}
    </>
  )
}

function amountFor(
  deals: ReturnType<typeof useDeals>['data'],
  dealId: string,
): string | null {
  const deal = deals?.find((d) => d.id === dealId)
  return deal ? formatMoney(deal.amount, deal.currency) : null
}

function DisputeCard({ dispute, amount }: { dispute: Dispute; amount: string | null }) {
  const [note, setNote] = useState('')
  const [choice, setChoice] = useState<'release' | 'refund' | null>(null)

  const resolve = useMoneyMutation((resolution: 'release' | 'refund') =>
    api.resolveDispute(dispute.id, resolution, note),
  )

  const usage = useAiUsage()
  const suggestions = useAiSuggestions(dispute.deal_id)
  const draft = useAiAction(() => api.draftDisputeSuggestion(dispute.id))
  // Approving a draft can move money, so it invalidates like any release.
  const decide = useMoneyMutation(
    ({ id, decision }: { id: string; decision: 'approved' | 'rejected' }) =>
      api.decideAiSuggestion(id, decision, ME),
  )

  const isOpen = dispute.status === 'open'
  const aiOff = usage.data && (!usage.data.enabled || usage.data.over_budget)
  const openDraft = suggestions.data?.find(
    (s) => s.decision === null && s.output.kind === 'dispute_resolution',
  )

  return (
    <Card>
      <CardHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            Raised by the {dispute.raised_by}
            <Link to={`/deals/${dispute.deal_id}`} className="hover:underline">
              <Mono>{dispute.deal_id}</Mono>
            </Link>
          </span>
        }
        subtitle={`Opened ${formatDateTime(dispute.opened_at)}${amount ? ` · ${amount} held` : ''}`}
        action={
          !isOpen ? (
            <span className="text-xs font-medium text-fg-muted">
              {dispute.status === 'resolved_released'
                ? 'Released to seller'
                : 'Refunded to buyer'}
            </span>
          ) : undefined
        }
      />

      <div className="space-y-4 px-6 py-5">
        <DisputeStatements dispute={dispute} />

        {!isOpen && dispute.resolution_note && (
          <p className="text-sm text-fg-muted">
            <span className="font-medium text-fg">Resolution:</span>{' '}
            {dispute.resolution_note}
          </p>
        )}

        {isOpen &&
          (openDraft ? (
            <AiSuggestionCard
              suggestion={openDraft}
              variant="inline"
              dealLink={false}
              pending={decide.isPending}
              error={decide.isError ? decide.error.message : undefined}
              onDecide={(decision) => decide.mutate({ id: openDraft.id, decision })}
            />
          ) : aiOff && usage.data ? (
            <AiUnavailable usage={usage.data} />
          ) : (
            <DraftButton
              label="Ask the assistant to draft a resolution"
              pending={draft.isPending}
              error={draft.isError ? draft.error.message : undefined}
              onClick={() => draft.mutate()}
            />
          ))}

        {isOpen && (
          <>
            <p className="text-[0.6875rem] font-semibold tracking-[0.06em] text-fg-subtle uppercase">
              {openDraft ? 'Or decide yourself' : 'Decide'}
            </p>
            <div className="flex flex-wrap gap-2">
              {(
                [
                  { key: 'release', label: 'Release to seller' },
                  { key: 'refund', label: 'Refund the buyer' },
                ] as const
              ).map((option) => (
                <button
                  key={option.key}
                  onClick={() => setChoice(option.key)}
                  className={cx(
                    'rounded-lg px-3 py-2 text-sm font-medium ring-1 ring-inset transition',
                    choice === option.key
                      ? 'bg-brand-soft text-brand ring-brand/30'
                      : 'bg-surface text-fg-muted ring-line hover:text-fg',
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>

            {choice && (
              <div className="space-y-3">
                <Field
                  label="Resolution note"
                  hint="Written to the audit trail and sent to both sides."
                >
                  <Textarea
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="Photos show the damage predates collection…"
                  />
                </Field>
                <Button
                  variant={choice === 'refund' ? 'danger' : 'primary'}
                  disabled={!note || resolve.isPending}
                  onClick={() => resolve.mutate(choice)}
                >
                  {resolve.isPending
                    ? 'Resolving…'
                    : choice === 'release'
                      ? 'Confirm release'
                      : 'Confirm refund'}
                </Button>
              </div>
            )}

            {resolve.isError && <ErrorNote message={resolve.error.message} />}
          </>
        )}
      </div>
    </Card>
  )
}
