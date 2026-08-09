/**
 * The Intelligence vocabulary — a suggestion, a decided record, a transcript.
 *
 * Two rules the look is built on:
 *
 *   1. **A draft must read as a proposal, never as a completed action.** The
 *      reasoning sits above the buttons rather than behind a disclosure: an
 *      admin who cannot see the reasoning cannot check it, and one who cannot
 *      check it is rubber-stamping.
 *   2. **Provenance is available, not loud.** Model, prompt version and input
 *      hash are what make a decision reproducible, and they are also noise at
 *      a glance — so they collapse into one line with the audit detail behind
 *      a toggle.
 *
 * Everything renders on the product's own white surface. A suggestion never
 * gets its own tinted box inside another box; on a page it *is* the card, and
 * inside another card it is an inset panel.
 */

import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { AiSuggestion, AiUsage, Dispute, DisputeEvidence } from '@/api'
import { Button, ErrorNote, Mono, cx } from '@/components/ui'
import { formatDateTime, formatMoney, formatRelative } from '@/lib/format'

// ---------------------------------------------------------------------------

/** The standing caveat, where the decision is actually made. */
export function AdvisoryNote({ className }: { className?: string }) {
  return (
    <p className={cx('text-xs leading-relaxed text-fg-muted', className)}>
      A suggestion, not a decision — nothing moves until you approve it.
    </p>
  )
}

/** The section rule used across the product, so this page matches Overview. */
export function SectionHeading({
  children,
  count,
}: {
  children: React.ReactNode
  count?: number
}) {
  return (
    <h2 className="mb-3 flex items-center gap-2 text-xs font-semibold tracking-[0.06em] text-fg-muted uppercase">
      {children}
      {count !== undefined && count > 0 && (
        <span className="text-fg-subtle">{count}</span>
      )}
      <span className="h-px flex-1 bg-line" />
    </h2>
  )
}

// ---------------------------------------------------------------------------

const RECOMMENDATION_LABEL = {
  release: 'Release to seller',
  refund: 'Refund the buyer',
  escalate: 'Needs a person',
} as const

const RECOMMENDATION_CLASS = {
  release: 'bg-released-soft text-released ring-released/20',
  refund: 'bg-pending-soft text-pending ring-pending/25',
  escalate: 'bg-surface-2 text-fg-muted ring-line-strong/60',
} as const

export function AiSuggestionCard({
  suggestion,
  onDecide,
  pending,
  error,
  dealLink = true,
  variant = 'standalone',
}: {
  suggestion: AiSuggestion
  onDecide?: (decision: 'approved' | 'rejected') => void
  pending?: boolean
  error?: string
  dealLink?: boolean
  /** `inline` when it sits inside another card, so boxes never nest. */
  variant?: 'standalone' | 'inline'
}) {
  const { output } = suggestion
  const decided = suggestion.decision !== null

  // Approving an escalation is agreeing it needs a human — it deliberately
  // resolves nothing, so the button must not promise that it will.
  const willMoveMoney =
    output.kind === 'dispute_resolution' && output.recommendation !== 'escalate'

  return (
    <div
      className={cx(
        'overflow-hidden',
        variant === 'standalone'
          ? 'rounded-2xl border border-line bg-surface shadow-[var(--shadow-card)]'
          : 'rounded-xl border border-line bg-surface-2/40',
      )}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-5 py-3">
        <SparkIcon className="size-4 shrink-0 text-brand" />
        <span className="text-xs font-semibold text-fg">
          {output.kind === 'dispute_resolution' ? 'Dispute assistant' : 'Risk summary'}
        </span>
        {dealLink && (
          <Link
            to={`/deals/${suggestion.deal_id}`}
            className="hover:underline"
            title="Open the deal"
          >
            <Mono>{suggestion.deal_id}</Mono>
          </Link>
        )}
        <span className="flex-1" />
        {output.kind === 'dispute_resolution' && (
          <span
            className={cx(
              'rounded-full px-2.5 py-1 text-xs font-semibold whitespace-nowrap ring-1 ring-inset',
              RECOMMENDATION_CLASS[output.recommendation],
            )}
          >
            {RECOMMENDATION_LABEL[output.recommendation]}
          </span>
        )}
      </div>

      <div className="space-y-4 px-5 py-4">
        <p className="text-[0.9375rem] leading-snug font-semibold text-fg">
          {output.headline}
        </p>

        <ul className="space-y-2">
          {(output.kind === 'dispute_resolution'
            ? output.rationale
            : output.points
          ).map((line, i) => (
            <li key={i} className="flex gap-2.5 text-sm leading-relaxed text-fg-muted">
              <span className="mt-[0.5rem] size-1 shrink-0 rounded-full bg-fg-subtle" />
              {line}
            </li>
          ))}
        </ul>

        {output.kind === 'risk_summary' && output.flags.length > 0 && (
          <ul className="space-y-1.5 rounded-xl bg-pending-soft px-4 py-3">
            {output.flags.map((flag, i) => (
              <li key={i} className="flex gap-2.5 text-sm leading-relaxed text-pending">
                <span className="mt-[0.5rem] size-1 shrink-0 rounded-full bg-current" />
                {flag}
              </li>
            ))}
          </ul>
        )}

        {output.cited.length > 0 && (
          <div className="rounded-xl border border-line px-4 py-3">
            <p className="text-[0.6875rem] font-semibold tracking-[0.06em] text-fg-subtle uppercase">
              Based on
            </p>
            <ul className="mt-2 space-y-1.5">
              {output.cited.map((c) => (
                <li
                  key={c.ref}
                  className="flex flex-wrap items-baseline gap-x-2 text-sm text-fg-muted"
                >
                  <span className="flex-1">{c.label}</span>
                  <span className="text-xs text-fg-subtle">
                    {formatDateTime(c.at)}
                  </span>
                  <Mono>{c.ref}</Mono>
                </li>
              ))}
            </ul>
          </div>
        )}

        {decided ? (
          <p className="text-sm text-fg-muted">
            <span className="font-semibold text-fg">
              {suggestion.decision === 'approved' ? 'Approved' : 'Rejected'}
            </span>{' '}
            by {suggestion.decided_by} · {formatDateTime(suggestion.decided_at)}
          </p>
        ) : (
          onDecide && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <Button
                size="sm"
                variant="primary"
                disabled={pending}
                onClick={() => onDecide('approved')}
              >
                {pending ? 'Working…' : willMoveMoney ? 'Approve and do it' : 'Approve'}
              </Button>
              <Button size="sm" disabled={pending} onClick={() => onDecide('rejected')}>
                Reject
              </Button>
              <AdvisoryNote className="basis-full sm:basis-auto" />
            </div>
          )
        )}

        {error && <ErrorNote message={error} />}
      </div>

      <Provenance suggestion={suggestion} />
    </div>
  )
}

/**
 * One quiet line, with the audit detail one click away. Everything here is
 * what makes a decision reproducible later — and nothing here helps you make
 * it now, which is why it sits at the bottom in the smallest type on screen.
 */
function Provenance({ suggestion }: { suggestion: AiSuggestion }) {
  const { output } = suggestion
  return (
    <details className="group border-t border-line bg-surface-2/40 px-5 py-2.5">
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-2 text-xs text-fg-subtle">
        <span>{suggestion.model}</span>
        <span aria-hidden>·</span>
        {output.kind === 'dispute_resolution' && (
          <>
            <span>{Math.round(output.confidence * 100)}% confident</span>
            <span aria-hidden>·</span>
          </>
        )}
        <span>{formatMoney(suggestion.cost_usd, 'USD')}</span>
        <span aria-hidden>·</span>
        <span>{formatRelative(suggestion.created_at, new Date())}</span>
        <span className="ml-auto font-medium text-fg-muted group-open:hidden">
          Details
        </span>
        <span className="ml-auto hidden font-medium text-fg-muted group-open:inline">
          Hide
        </span>
      </summary>
      <dl className="mt-2.5 grid gap-x-4 gap-y-1 text-xs sm:grid-cols-[8rem_1fr]">
        <dt className="text-fg-subtle">Prompt version</dt>
        <dd className="text-fg-muted">{suggestion.prompt_version}</dd>
        <dt className="text-fg-subtle">Input hash</dt>
        <dd>
          <Mono>{suggestion.input_hash}</Mono>
        </dd>
        <dt className="text-fg-subtle">Drafted</dt>
        <dd className="text-fg-muted">{formatDateTime(suggestion.created_at)}</dd>
      </dl>
    </details>
  )
}

// ---------------------------------------------------------------------------

/** History. Collapsed by default — it is a record, not a queue. */
export function DecidedSuggestion({ suggestion }: { suggestion: AiSuggestion }) {
  const [open, setOpen] = useState(false)
  const { output } = suggestion

  return (
    <div className="rounded-xl border border-line bg-surface">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left"
      >
        <SparkIcon className="size-3.5 shrink-0 text-fg-subtle" />
        <span className="min-w-0 flex-1 truncate text-sm text-fg">
          {output.headline}
        </span>
        <span
          className={cx(
            'shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-inset',
            suggestion.decision === 'approved'
              ? 'bg-released-soft text-released ring-released/20'
              : 'bg-surface-2 text-fg-muted ring-line-strong/60',
          )}
        >
          {suggestion.decision === 'approved' ? 'Approved' : 'Rejected'}
        </span>
        <span className="hidden shrink-0 text-xs text-fg-subtle sm:inline">
          {formatRelative(suggestion.decided_at, new Date())}
        </span>
      </button>

      {open && (
        <div className="border-t border-line px-4 py-3">
          <ul className="space-y-1.5">
            {(output.kind === 'dispute_resolution'
              ? output.rationale
              : output.points
            ).map((line, i) => (
              <li key={i} className="text-sm leading-relaxed text-fg-muted">
                {line}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-fg-muted">
            {suggestion.decision === 'approved' ? 'Approved' : 'Rejected'} by{' '}
            {suggestion.decided_by} · {formatDateTime(suggestion.decided_at)}
          </p>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------

/**
 * Shown wherever a draft would be, when Intelligence is off or out of budget.
 *
 * **Three states, not two.** An unconfigured deployment used to read as "off —
 * turn it on in Settings", which is a cure that cannot work: the switch is
 * already on, and what is missing is a function secret nobody can set from a
 * browser. `aiOffReason` is the one place that distinction is drawn, so the
 * panel and this card cannot tell different stories about the same account.
 */
export function aiOffReason(usage: AiUsage): { title: string; fix: string } {
  if (!usage.configured) {
    return {
      title: 'Intelligence cannot run on this deployment.',
      fix: 'Nothing in Settings changes this — the backend is missing the secret ' +
        'that reaches the read-only AI role.',
    }
  }
  if (!usage.enabled) {
    return {
      title: 'Intelligence is off for this company.',
      fix: 'Turn it on in Settings for drafts and answers.',
    }
  }
  return {
    title: "This month's AI budget is spent.",
    fix: 'Drafts and answers resume next month, or raise the budget in Settings.',
  }
}

/**
 * Shown wherever a draft can be produced but no model is behind it.
 *
 * This is not an error state and is deliberately not styled as one — demo mode
 * works end to end, which is the point of it. What it must not do is let a
 * fixed rule's output pass for a model's reading of a case: every draft made
 * this way is labelled in its own text and recorded as `demo-stand-in`, and
 * this is the standing reminder above them.
 */
export function AiDemoNote() {
  return (
    <div className="rounded-xl border border-line bg-surface-2/50 px-4 py-3">
      <p className="text-sm text-fg">
        <span className="font-semibold">Demo mode — no model is connected.</span>{' '}
        <span className="text-fg-muted">
          Drafts and answers come from a fixed rule over your own records, so the
          whole path works and nothing here is a model's judgement. Set a model
          key on the backend for real drafts.
        </span>
      </p>
    </div>
  )
}

export function AiUnavailable({ usage }: { usage: AiUsage }) {
  const { title, fix } = aiOffReason(usage)
  return (
    <div className="rounded-xl border border-line bg-surface-2/50 px-4 py-3">
      <p className="text-sm text-fg">
        <span className="font-semibold">{title}</span>{' '}
        <span className="text-fg-muted">
          {fix} Deals, releases, refunds and payouts are unaffected.
        </span>
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------

/**
 * Both sides of a dispute, with what each of them submitted.
 *
 * Shared by the Disputes screen and the assistant so the two can never tell
 * different stories about the same case.
 */
export function DisputeStatements({ dispute }: { dispute: Dispute }) {
  const other = dispute.raised_by === 'buyer' ? 'seller' : 'buyer'
  return (
    <div className="space-y-4">
      <Statement side={dispute.raised_by} text={dispute.reason} />
      {dispute.counter_statement ? (
        <Statement side={other} text={dispute.counter_statement} />
      ) : (
        <p className="text-sm text-fg-subtle">
          The {other} has not answered.
        </p>
      )}

      {dispute.evidence.length > 0 && <EvidenceGrid evidence={dispute.evidence} />}
    </div>
  )
}

/**
 * What each side submitted, as thumbnails you can open.
 *
 * The images are served by the client's own site — we hold the reference, not
 * the file. Showing them matters: "six photos of the rear bumper" is a claim,
 * and the whole point of a dispute screen is to let a person check the claim
 * rather than take the description's word for it.
 */
function EvidenceGrid({ evidence }: { evidence: DisputeEvidence[] }) {
  const [open, setOpen] = useState<DisputeEvidence | null>(null)

  return (
    <div>
      <p className="text-[0.6875rem] font-semibold tracking-[0.06em] text-fg-subtle uppercase">
        Submitted
      </p>

      {/* Auto-fill rather than a fixed column count: the same grid has to sit
          in a 24rem chat panel and across a full-width dispute card without
          the tiles stretching into billboards. */}
      <div className="mt-2 grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(8.5rem,1fr))]">
        {evidence.map((e, i) =>
          e.url ? (
            <button
              key={i}
              onClick={() => setOpen(e)}
              className="group overflow-hidden rounded-lg border border-line bg-surface text-left transition hover:border-line-strong"
            >
              <img
                src={e.url}
                alt={e.description}
                loading="lazy"
                className="aspect-[4/3] w-full bg-surface-2 object-cover"
              />
              <span className="block px-2 py-1.5">
                <span className="block truncate text-xs font-medium text-fg capitalize">
                  {e.side}
                </span>
                <span className="block truncate text-[0.6875rem] text-fg-muted">
                  {e.description}
                </span>
              </span>
            </button>
          ) : (
            <div
              key={i}
              className="rounded-lg border border-line border-dashed px-2 py-1.5"
            >
              <span className="block text-xs font-medium text-fg capitalize">
                {e.side}
              </span>
              <span className="block text-[0.6875rem] text-fg-muted">
                {e.description}
              </span>
              <span className="mt-1 block text-[0.6875rem] text-fg-subtle">
                description only
              </span>
            </div>
          ),
        )}
      </div>

      {open && <Lightbox item={open} onClose={() => setOpen(null)} />}
    </div>
  )
}

function Lightbox({
  item,
  onClose,
}: {
  item: DisputeEvidence
  onClose: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-70 flex items-center justify-center bg-canvas/80 p-6 backdrop-blur-[3px]"
      onClick={onClose}
    >
      <figure
        className="max-h-full w-full max-w-3xl overflow-hidden rounded-2xl border border-line bg-surface shadow-[var(--shadow-pop)]"
        onClick={(e) => e.stopPropagation()}
      >
        <img src={item.url ?? ''} alt={item.description} className="w-full" />
        <figcaption className="flex flex-wrap items-baseline gap-x-2 border-t border-line px-5 py-3">
          <span className="text-sm font-semibold text-fg capitalize">{item.side}</span>
          <span className="flex-1 text-sm text-fg-muted">{item.description}</span>
          <span className="text-xs text-fg-subtle">
            {formatDateTime(item.submitted_at)}
          </span>
        </figcaption>
      </figure>
    </div>
  )
}

/** One side's account of what happened, attributed. */
function Statement({ side, text }: { side: 'buyer' | 'seller'; text: string }) {
  return (
    <div className="border-l-2 border-line pl-3">
      <p className="text-xs font-semibold text-fg-subtle capitalize">{side}</p>
      <p className="mt-0.5 text-sm leading-relaxed text-fg">{text}</p>
    </div>
  )
}

// ---------------------------------------------------------------------------

/** A draft button with the standing caveat beside it. */
export function DraftButton({
  label,
  onClick,
  pending,
  error,
}: {
  label: string
  onClick: () => void
  pending?: boolean
  error?: string
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <Button size="sm" disabled={pending} onClick={onClick}>
        <SparkIcon className="size-3.5" />
        {pending ? 'Reading the file…' : label}
      </Button>
      <AdvisoryNote />
      {error && <ErrorNote message={error} />}
    </div>
  )
}

export function SparkIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={cx('size-4', className)}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3.5 13.6 8.4 18.5 10 13.6 11.6 12 16.5 10.4 11.6 5.5 10 10.4 8.4z" />
      <path d="M18 16.5l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z" />
    </svg>
  )
}
