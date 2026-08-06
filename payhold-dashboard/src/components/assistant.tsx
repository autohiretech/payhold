/**
 * The assistant, as a modal you summon from anywhere.
 *
 * It is deliberately *not* a page. Questions arrive while you are looking at
 * something else — a payout you are unsure about, a dispute you half remember
 * — so the assistant overlays the screen you are on and gets out of the way,
 * rather than making you navigate away and lose your place.
 *
 * Answers can carry records, not just prose. Those render as the same cards
 * the rest of the product uses, and they resolve **by id at render time**: a
 * draft shown an hour ago that has since been approved says so now. Which
 * also means the Approve button inside a transcript is the same button, doing
 * the same thing, recorded against the same person.
 */

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { Link } from 'react-router-dom'
import { api, type AiChatAttachment, type AiChatMessage, type Deal } from '@/api'
import { AiSuggestionCard, DisputeStatements, SparkIcon } from '@/components/ai'
import { Badge, ErrorNote, Input, Mono, cx } from '@/components/ui'
import { DEAL_STATUS_META, formatMoney } from '@/lib/format'
import {
  useAiChat,
  useAiMutation,
  useAiSuggestions,
  useAiUsage,
  useDeals,
  useDisputes,
  useMoneyMutation,
} from '@/lib/queries'

/** Who an approval is recorded as. Real auth will supply this. */
const ME = 'grace@autohire.rw'

// ---------------------------------------------------------------------------

const AssistantContext = createContext<{ open: () => void } | null>(null)

/** Lets any screen summon the assistant without owning its state. */
export function useAssistant() {
  const ctx = useContext(AssistantContext)
  if (!ctx) throw new Error('useAssistant used outside AssistantProvider')
  return ctx
}

export function AssistantProvider({ children }: { children: ReactNode }) {
  // `?ask=1` opens it on load, so a support reply or a runbook can link
  // straight to the assistant rather than describing where the button is.
  const [open, setOpen] = useState(
    () => new URLSearchParams(window.location.search).get('ask') !== null,
  )

  // ⌘K / Ctrl-K from anywhere, Escape to leave.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((v) => !v)
      }
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <AssistantContext.Provider value={{ open: () => setOpen(true) }}>
      {children}
      <AssistantLauncher onClick={() => setOpen(true)} hidden={open} />
      {open && <AssistantModal onClose={() => setOpen(false)} />}
    </AssistantContext.Provider>
  )
}

function AssistantLauncher({
  onClick,
  hidden,
}: {
  onClick: () => void
  hidden: boolean
}) {
  if (hidden) return null
  return (
    <button
      onClick={onClick}
      title="Ask the assistant  (⌘K)"
      className="fixed right-4 bottom-4 z-50 flex items-center gap-2 rounded-full bg-brand px-4 py-3 text-sm font-semibold text-brand-fg shadow-[var(--shadow-pop)] transition hover:bg-brand-deep active:scale-[0.98] print:hidden"
    >
      <SparkIcon className="size-4" />
      Ask
    </button>
  )
}

// ---------------------------------------------------------------------------

const STARTERS = ['/help', '/queue', '/balance', '/disputes']

function AssistantModal({ onClose }: { onClose: () => void }) {
  const chat = useAiChat()
  const usage = useAiUsage()
  const suggestions = useAiSuggestions()
  const deals = useDeals()
  const disputes = useDisputes()

  const ask = useAiMutation((question: string) => api.askAssistant(question))
  // Approving from a transcript is still approving: same call, same actor,
  // same audit row as the button on the Disputes screen.
  const decide = useMoneyMutation(
    ({ id, decision }: { id: string; decision: 'approved' | 'rejected' }) =>
      api.decideAiSuggestion(id, decision, ME),
  )

  const [draft, setDraft] = useState('')
  const endRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const off = usage.data && (!usage.data.enabled || usage.data.over_budget)
  const messages = chat.data ?? []

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [messages.length, ask.isPending])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const send = (text: string) => {
    const question = text.trim()
    if (!question || ask.isPending || off) return
    ask.mutate(question)
    setDraft('')
  }

  return (
    <div className="fixed inset-0 z-60 flex items-end justify-end p-0 sm:inset-auto sm:right-4 sm:bottom-4 print:hidden">
      {/* Only the small-screen presentation needs a scrim: docked in the
          corner it is a panel beside your work, not a mode you are in. */}
      <div
        className="absolute inset-0 bg-canvas/70 backdrop-blur-[2px] sm:hidden"
        onClick={onClose}
        aria-hidden
      />

      <div
        role="dialog"
        aria-label="Assistant"
        className="relative flex h-[85vh] w-full flex-col overflow-hidden rounded-t-2xl border border-line bg-surface shadow-[var(--shadow-pop)] sm:h-[min(34rem,calc(100vh-6rem))] sm:w-[24rem] sm:rounded-2xl"
      >
        <header className="flex items-center gap-2.5 border-b border-line px-4 py-3">
          <span className="flex size-7 items-center justify-center rounded-full bg-brand-soft">
            <SparkIcon className="size-4 text-brand" />
          </span>
          <span className="min-w-0">
            <span className="block text-sm leading-tight font-semibold text-fg">
              Assistant
            </span>
            <span className="block text-[0.6875rem] leading-tight text-fg-subtle">
              reads everything · moves nothing
            </span>
          </span>
          <span className="flex-1" />
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-1.5 text-fg-muted transition hover:bg-surface-2 hover:text-fg"
          >
            <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
          {off && usage.data ? (
            <p className="text-sm leading-relaxed text-fg-muted">
              {usage.data.enabled
                ? "This month's AI budget is spent, so the assistant is off until next month."
                : 'Intelligence is switched off for this company.'}{' '}
              Deals, releases, refunds and payouts are unaffected.
            </p>
          ) : messages.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center px-2 text-center">
              <span className="flex size-11 items-center justify-center rounded-full bg-brand-soft">
                <SparkIcon className="size-5 text-brand" />
              </span>
              <p className="mt-3 text-sm leading-relaxed text-fg-muted">
                Ask how anything works, look up any record, or pull a draft and
                decide it here.
              </p>
              <p className="mt-2 text-xs text-fg-subtle">
                Start with <Mono>/help</Mono>
              </p>
            </div>
          ) : (
            messages.map((m) => (
              <Turn
                key={m.id}
                message={m}
                deals={deals.data}
                disputes={disputes.data}
                suggestions={suggestions.data}
                decidePending={decide.isPending}
                onDecide={(id, decision) => decide.mutate({ id, decision })}
              />
            ))
          )}

          {ask.isPending && (
            <div className="flex justify-start">
              <span className="rounded-2xl rounded-bl-md bg-surface-2 px-3.5 py-2.5 text-sm text-fg-subtle ring-1 ring-line ring-inset">
                Reading your data…
              </span>
            </div>
          )}

          {ask.isError && <ErrorNote message={ask.error.message} />}
          {decide.isError && <ErrorNote message={decide.error.message} />}

          <div ref={endRef} />
        </div>

        {!off && (
          <div className="border-t border-line px-4 py-3">
            {messages.length === 0 && (
              <div className="mb-2.5 flex flex-wrap gap-1.5">
                {STARTERS.map((s) => (
                  <button
                    key={s}
                    onClick={() => send(s)}
                    className="rounded-full px-2.5 py-1 font-mono text-[0.6875rem] text-fg-muted ring-1 ring-line ring-inset transition hover:text-fg hover:ring-line-strong"
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
            <form
              className="flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                send(draft)
              }}
            >
              <Input
                ref={inputRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Ask, or / for commands…"
                className="rounded-full py-2"
              />
              <button
                type="submit"
                disabled={!draft.trim()}
                aria-label="Send"
                className="flex size-9 shrink-0 items-center justify-center rounded-full bg-brand text-brand-fg transition hover:bg-brand-deep disabled:pointer-events-none disabled:opacity-40"
              >
                <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4.5 12h13M12 5.5l6 6.5-6 6.5" />
                </svg>
              </button>
            </form>
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------

function Turn({
  message,
  deals,
  disputes,
  suggestions,
  onDecide,
  decidePending,
}: {
  message: AiChatMessage
  deals?: Deal[]
  disputes?: ReturnType<typeof useDisputes>['data']
  suggestions?: ReturnType<typeof useAiSuggestions>['data']
  onDecide: (id: string, decision: 'approved' | 'rejected') => void
  decidePending: boolean
}) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <p
          className={cx(
            'max-w-[85%] rounded-2xl rounded-br-md bg-brand px-3.5 py-2 text-sm leading-relaxed text-brand-fg',
            message.text.startsWith('/') && 'font-mono',
          )}
        >
          {message.text}
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <div className="flex justify-start">
        <p className="max-w-[90%] rounded-2xl rounded-bl-md bg-surface-2 px-3.5 py-2 text-sm leading-relaxed text-fg ring-1 ring-line ring-inset">
          {message.text}
        </p>
      </div>

      {/* Records are too wide for a bubble, so they sit under it at full
          width — the bubble says what it found, the card is the thing. */}
      {(message.attachments ?? []).map((a, i) => (
        <Attachment
          key={i}
          attachment={a}
          deals={deals}
          disputes={disputes}
          suggestions={suggestions}
          onDecide={onDecide}
          decidePending={decidePending}
        />
      ))}

      {message.sources.length > 0 && (
        <p className="px-1 text-[0.6875rem] text-fg-subtle">
          {message.sources.join(' · ')}
        </p>
      )}
    </div>
  )
}

function Attachment({
  attachment,
  deals,
  disputes,
  suggestions,
  onDecide,
  decidePending,
}: {
  attachment: AiChatAttachment
  deals?: Deal[]
  disputes?: ReturnType<typeof useDisputes>['data']
  suggestions?: ReturnType<typeof useAiSuggestions>['data']
  onDecide: (id: string, decision: 'approved' | 'rejected') => void
  decidePending: boolean
}) {
  switch (attachment.kind) {
    case 'suggestion': {
      const suggestion = suggestions?.find((s) => s.id === attachment.id)
      if (!suggestion) return null
      return (
        <AiSuggestionCard
          suggestion={suggestion}
          variant="inline"
          pending={decidePending}
          onDecide={
            suggestion.decision
              ? undefined
              : (decision) => onDecide(suggestion.id, decision)
          }
        />
      )
    }

    case 'deal': {
      const deal = deals?.find((d) => d.id === attachment.id)
      if (!deal) return null
      return <DealCard deal={deal} />
    }

    case 'evidence': {
      const dispute = disputes?.find((d) => d.id === attachment.dispute_id)
      if (!dispute) return null
      return (
        <div className="rounded-xl border border-line bg-surface-2/40 px-4 py-3">
          <DisputeStatements dispute={dispute} />
        </div>
      )
    }

    case 'table':
      return <TableCard attachment={attachment} />
  }
}

function DealCard({ deal }: { deal: Deal }) {
  return (
    <div className="rounded-xl border border-line bg-surface-2/40 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Link to={`/deals/${deal.id}`} className="hover:underline">
          <Mono>{deal.id}</Mono>
        </Link>
        <span className="flex-1 text-sm font-medium text-fg">{deal.description}</span>
        <Badge meta={DEAL_STATUS_META[deal.status]} />
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-4">
        <Cell label="Amount" value={formatMoney(deal.amount, deal.currency)} />
        <Cell label="Fee" value={formatMoney(deal.fee_amount, deal.currency)} />
        <Cell label="Buyer" value={deal.buyer_ref} />
        <Cell
          label="Deposit"
          value={
            deal.deposit_amount
              ? formatMoney(deal.deposit_amount, deal.currency)
              : 'none'
          }
        />
      </dl>
    </div>
  )
}

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-fg-subtle">{label}</dt>
      <dd className="mt-0.5 font-medium text-fg">{value}</dd>
    </div>
  )
}

function TableCard({
  attachment,
}: {
  attachment: Extract<AiChatAttachment, { kind: 'table' }>
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-line">
      {attachment.caption && (
        <p className="border-b border-line bg-surface-2/60 px-4 py-2 text-[0.6875rem] font-semibold tracking-[0.06em] text-fg-muted uppercase">
          {attachment.caption}
        </p>
      )}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr>
              {attachment.columns.map((c) => (
                <th
                  key={c}
                  className="border-b border-line bg-surface-2/40 px-3 py-2 text-left text-[0.6875rem] font-semibold tracking-[0.06em] text-fg-muted uppercase"
                >
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {attachment.rows.map((row, i) => (
              <tr key={i}>
                {row.map((cell, j) => (
                  <td
                    key={j}
                    className={cx(
                      'border-b border-line px-3 py-2 last:border-b-0',
                      j === 0 ? 'font-mono text-xs text-fg-muted' : 'text-fg',
                    )}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
