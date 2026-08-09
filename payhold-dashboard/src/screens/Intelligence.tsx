import { api } from '@/api'
import {
  AiDemoNote,
  AiSuggestionCard,
  AiUnavailable,
  DecidedSuggestion,
  SectionHeading,
} from '@/components/ai'
import { useAssistant } from '@/components/assistant'
import { Button, PageHeader, Skeleton } from '@/components/ui'
import { SparkIcon } from '@/components/ai'
import { formatMoney } from '@/lib/format'
import {
  useAiSuggestions,
  useAiUsage,
  useDealOutcomes,
  useMoneyMutation,
} from '@/lib/queries'

/**
 * A queue, not a dashboard.
 *
 * One column, because the page is a short list of decisions and a place to
 * ask a question — two columns only produced an L-shaped hole whenever the
 * queue was empty, which is most of the time. Nothing here gets a card unless
 * it is something you act on.
 */
export function IntelligencePage() {
  const assistant = useAssistant()
  const usage = useAiUsage()
  const suggestions = useAiSuggestions()
  const outcomes = useDealOutcomes()

  // Deliberately a *money* mutation: approving a release or refund draft moves
  // funds, so it has to invalidate everything a release would.
  const decide = useMoneyMutation(
    ({ id, decision }: { id: string; decision: 'approved' | 'rejected' }) =>
      api.decideAiSuggestion(id, decision),
  )

  const pending = suggestions.data?.filter((s) => s.decision === null) ?? []
  const decided = suggestions.data?.filter((s) => s.decision !== null) ?? []
  const off = usage.data && (!usage.data.enabled || usage.data.over_budget)

  const tally = (outcomes.data ?? []).reduce<Record<string, number>>((acc, o) => {
    acc[o.outcome] = (acc[o.outcome] ?? 0) + 1
    return acc
  }, {})

  return (
    <div className="max-w-3xl">
      <PageHeader
        title="Intelligence"
        subtitle="Drafts and answers from your own data. Each one is a suggestion — you decide, and your approval is what acts."
      />

      {off && usage.data && (
        <div className="mb-6">
          <AiUnavailable usage={usage.data} />
        </div>
      )}

      {!off && usage.data?.demo && (
        <div className="mb-6">
          <AiDemoNote />
        </div>
      )}

      <section>
        <SectionHeading count={pending.length}>Waiting on you</SectionHeading>

        {suggestions.isPending ? (
          <Skeleton className="h-32" />
        ) : pending.length === 0 ? (
          <p className="text-sm leading-relaxed text-fg-muted">
            Nothing waiting. Ask for a draft from an open dispute, or a risk
            summary before approving a payout.
          </p>
        ) : (
          <div className="space-y-4">
            {pending.map((s) => (
              <AiSuggestionCard
                key={s.id}
                suggestion={s}
                pending={decide.isPending}
                error={decide.isError ? decide.error.message : undefined}
                onDecide={(decision) => decide.mutate({ id: s.id, decision })}
              />
            ))}
          </div>
        )}
      </section>

      <section className="mt-9">
        <SectionHeading>Ask about your account</SectionHeading>
        <div className="rounded-2xl border border-line bg-surface px-5 py-5 shadow-[var(--shadow-card)]">
          <p className="max-w-xl text-sm leading-relaxed text-fg-muted">
            The assistant opens over whatever you are looking at, so you never
            lose your place. It can read any deal, dispute, payout or balance on
            this account, pull the evidence on a case, draft a resolution — and
            you can approve it without leaving the conversation.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button variant="primary" onClick={assistant.open}>
              <SparkIcon className="size-4" />
              Ask the assistant
            </Button>
            <span className="text-xs text-fg-subtle">
              or press ⌘K from anywhere · type <code className="font-mono">/help</code> for
              commands
            </span>
          </div>
        </div>
      </section>

      {decided.length > 0 && (
        <section className="mt-9">
          <SectionHeading count={decided.length}>Already decided</SectionHeading>
          <div className="space-y-2">
            {decided.map((s) => (
              <DecidedSuggestion key={s.id} suggestion={s} />
            ))}
          </div>
        </section>
      )}

      <div className="mt-9 space-y-2 border-t border-line pt-5 text-xs leading-relaxed text-fg-muted">
        <p>
          The assistant reads. It cannot release, refund, capture or pay out, and
          holds no credentials that would let it try — if it were switched off
          entirely, every deal, release and payout would behave exactly as it
          does now.
        </p>
        {usage.data && (
          <p>
            <span className="font-semibold text-fg">
              {formatMoney(usage.data.spend_usd, 'USD')}
            </span>{' '}
            spent this month of a {formatMoney(usage.data.budget_usd, 'USD')}{' '}
            budget, set in Settings. Reaching it turns drafts off, never a
            payment.
          </p>
        )}
        {outcomes.data && outcomes.data.length > 0 && (
          <p>
            <span className="font-semibold text-fg">
              {outcomes.data.length} labelled outcomes
            </span>{' '}
            so far —{' '}
            {Object.entries(tally)
              .sort((a, b) => b[1] - a[1])
              .map(([label, count]) => `${label.replace(/_/g, ' ')} ${count}`)
              .join(' · ')}
            . This is the record a fraud model of our own is trained on later,
            and it cannot be reconstructed after the fact.
          </p>
        )}
      </div>
    </div>
  )
}
