import { type ReactNode, useState } from 'react'
import type { Balance, Currency, Money, RailLiveBalance } from '@/api'
import { Badge, Card, Dot, cx } from '@/components/ui'
import { formatDateTime, formatMoney, formatMoneyShort, formatPercent, type Tone } from '@/lib/format'
import { PROVIDER_LABEL } from '@/lib/rails'

/**
 * One row's worth of input: a currency, PayHold's own ledger balance for it
 * (or `null` — most rail currencies have no ledger row at all), and every
 * `atRail` entry that named this currency (zero, one, or more than one —
 * USD here is both PayPal and Stripe at once).
 *
 * `Overview.tsx` decides the currency list, the sort, and which currencies
 * carry no activity at all; this component only renders what it is handed.
 */
export interface CurrencyBalanceData {
  currency: Currency
  balance: Balance | null
  rows: RailLiveBalance[]
  /**
   * No rail money and no ledger activity, on a currency where every rail
   * that reports it actually answered. Never true for a currency any rail
   * failed to reach — an unreachable rail is not a zero balance, and must
   * never be filed alongside one.
   */
  isEmpty: boolean
}

/**
 * The primary balances view: one row per currency, sorted by size, with the
 * 29-or-so zero-balance currencies collapsed behind a single control rather
 * than scattered through the page. See the file-level comments on each cell
 * function below for why each caveat renders where it does — every one of
 * them exists because the screen would otherwise show a number that isn't
 * true, or hide one that is.
 */
export function BalancesTable({
  items,
  serviceFeeRate,
  railStatus,
}: {
  items: CurrencyBalanceData[]
  serviceFeeRate: number | undefined
  /**
   * Whether `GET /balance?live=1` has answered at all. A currency with no
   * `atRail` rows means two different things depending on this: "checked,
   * and no rail reports it" once the call has succeeded, versus "not
   * checked yet" or "could not check" while it hasn't — and only the first
   * of those is safe to word as "not held at any connected rail".
   */
  railStatus: 'pending' | 'error' | 'success'
}) {
  const [showEmpty, setShowEmpty] = useState(false)
  const [expandOverride, setExpandOverride] = useState<Record<string, boolean>>({})

  const active = items.filter((i) => !i.isEmpty)
  const empty = items.filter((i) => i.isEmpty)

  return (
    <Card className="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr>
              <Th>Currency</Th>
              <Th align="right">What the rail holds</Th>
              <Th
                align="right"
                responsive
                hint="What each rail itself says is ready to move right now — Flutterwave's payout wallet, Stripe's available balance, PayPal's available balance. Each cell names which."
              >
                Available
              </Th>
              <Th
                align="right"
                responsive
                hint="Money the rail is holding back from the figure to the left, for a different reason per rail — Flutterwave's collection wallet (already collected, not yet moved to payout), Stripe's pending clearance, or PayPal's withheld reserve. Each cell names which."
              >
                Not yet available
              </Th>
              <Th
                responsive
                lgOnly
                hint="When the amount to the left is expected to move, exactly as the rail reports it. Flutterwave has none to report — that money moves only when you request a transfer, never on a timer."
              >
                Schedule
              </Th>
              <Th responsive>Your revenue</Th>
              <Th responsive>PayHold's allocation</Th>
            </tr>
          </thead>
          <tbody>
            {active.map((item) => (
              <CurrencyRow
                key={item.currency}
                item={item}
                serviceFeeRate={serviceFeeRate}
                railStatus={railStatus}
                expanded={expandOverride[item.currency] ?? item.rows.length > 1}
                onToggle={() =>
                  setExpandOverride((prev) => ({
                    ...prev,
                    [item.currency]: !(prev[item.currency] ?? item.rows.length > 1),
                  }))
                }
              />
            ))}

            {empty.length > 0 && (
              <>
                <tr>
                  <Td colSpan={7} className="bg-surface-2/40 py-2.5">
                    <button
                      type="button"
                      onClick={() => setShowEmpty((v) => !v)}
                      className="text-xs font-semibold text-brand hover:underline"
                    >
                      {showEmpty
                        ? `Hide ${empty.length} currencies with no balance`
                        : `Show ${empty.length} currencies with no balance`}
                    </button>
                  </Td>
                </tr>
                {showEmpty &&
                  empty.map((item) => (
                    <CurrencyRow
                      key={item.currency}
                      item={item}
                      serviceFeeRate={serviceFeeRate}
                      railStatus={railStatus}
                      expanded={expandOverride[item.currency] ?? false}
                      onToggle={() =>
                        setExpandOverride((prev) => ({
                          ...prev,
                          [item.currency]: !(prev[item.currency] ?? false),
                        }))
                      }
                      faint
                    />
                  ))}
              </>
            )}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Header / cell chrome
// ---------------------------------------------------------------------------

/**
 * `responsive` columns drop out below `md` — on a narrow screen only
 * Currency and the headline figure stay in the grid; everything else moves
 * into the row's own expansion, which is why every row keeps a working
 * expand toggle rather than only the multi-rail ones. `lgOnly` drops out a
 * step earlier still, for the column even a laptop can spare first.
 */
function Th({
  children,
  align = 'left',
  responsive,
  lgOnly,
  hint,
}: {
  children?: ReactNode
  align?: 'left' | 'right'
  responsive?: boolean
  lgOnly?: boolean
  /**
   * Header tooltip, same `title` mechanism `Badge` and `MiniFigure` already
   * use. Load-bearing on "Available" and "Not yet available": a shared
   * header can't be the rail's own word for all three rails at once, so the
   * header stays neutral and the hint plus each cell's own note is where the
   * per-rail truth lives.
   */
  hint?: string
}) {
  return (
    <th
      title={hint}
      className={cx(
        'border-b border-line bg-surface-2/60 px-4 py-3 text-xs font-semibold tracking-[0.06em] text-fg-muted uppercase',
        align === 'right' ? 'text-right' : 'text-left',
        hint && 'cursor-help',
        responsive && (lgOnly ? 'hidden lg:table-cell' : 'hidden md:table-cell'),
      )}
    >
      {children}
    </th>
  )
}

function Td({
  children,
  align = 'left',
  className,
  colSpan,
  responsive,
  lgOnly,
}: {
  children?: ReactNode
  align?: 'left' | 'right'
  className?: string
  colSpan?: number
  responsive?: boolean
  lgOnly?: boolean
}) {
  return (
    <td
      colSpan={colSpan}
      className={cx(
        'border-b border-line px-4 py-3 align-top text-fg',
        align === 'right' ? 'text-right' : 'text-left',
        responsive && (lgOnly ? 'hidden lg:table-cell' : 'hidden md:table-cell'),
        className,
      )}
    >
      {children}
    </td>
  )
}

/** Null, rendered as the fact it is — never a zero and never a guess. */
function notReported(rail: string): ReactNode {
  return <span className="font-normal text-fg-subtle">not reported by {rail}</span>
}

function notReportedBy(rails: string[]): ReactNode {
  if (rails.length === 0) return null
  return notReported(rails.join(', '))
}

// ---------------------------------------------------------------------------
// Per-currency summary — the arithmetic every cell in the row reads from
// ---------------------------------------------------------------------------

interface RailSummary {
  reachable: RailLiveBalance[]
  unreachable: RailLiveBalance[]
  allUnreachable: boolean
  sandbox: boolean
  stale: boolean
  railSum: Money
  availKnown: RailLiveBalance[]
  availSum: Money
  pendingKnown: RailLiveBalance[]
  pendingSum: Money
  latestAsOf: string | null
}

function summarize(rows: RailLiveBalance[]): RailSummary {
  const reachable = rows.filter((r) => r.amount !== null && !r.error)
  const unreachable = rows.filter((r) => r.amount === null || r.error)
  const availKnown = reachable.filter((r) => r.available !== null)
  const pendingKnown = reachable.filter((r) => r.pending !== null)
  const asOfs = reachable.map((r) => r.as_of).sort()

  return {
    reachable,
    unreachable,
    allUnreachable: rows.length > 0 && unreachable.length === rows.length,
    sandbox: rows.some((r) => r.mode === 'test'),
    stale: rows.some((r) => r.stale),
    railSum: reachable.reduce((sum, r) => sum + (r.amount ?? 0), 0),
    availKnown,
    availSum: availKnown.reduce((sum, r) => sum + (r.available ?? 0), 0),
    pendingKnown,
    pendingSum: pendingKnown.reduce((sum, r) => sum + (r.pending ?? 0), 0),
    latestAsOf: asOfs.length ? asOfs.at(-1)! : null,
  }
}

function railLabel(r: RailLiveBalance): string {
  return PROVIDER_LABEL[r.provider] ?? r.provider
}

/**
 * The two money columns mean a different thing per rail, confirmed against
 * the owner's own Flutterwave dashboard (2026-09-12): Flutterwave reports two
 * *wallets*, not a settled/unsettled split. `available_balance` — our
 * `available` field — is its **payout wallet**, money loaded and ready to
 * disburse; the remainder — our `pending` field — is its **collection
 * wallet**, money already collected from customers that has not been moved
 * to the payout wallet. Nothing there is "clearing": it does not settle on a
 * timer, it moves only when the account holder requests a transfer between
 * the two wallets.
 *
 * Stripe and PayPal keep their own genuine words: Stripe's `pending` really
 * is awaiting settlement, with `available_on` a real date from its schedule.
 * PayPal's is a **withheld** reserve — also not a clearing process, and also
 * not a Flutterwave-style wallet split.
 *
 * A single header cannot be truthful for all three at once, so the table
 * headers stay neutral ("Available" / "Not yet available") and every cell
 * that renders one of these numbers names the rail's own word alongside it —
 * `Overview.tsx`'s brief was explicit that the rail's own vocabulary must
 * reach the reader, not just a color-coded amount.
 */
function availableTerm(provider: RailLiveBalance['provider']): string {
  return provider === 'flutterwave' ? 'payout wallet' : 'available'
}

function pendingTerm(provider: RailLiveBalance['provider']): string {
  if (provider === 'flutterwave') return 'collection wallet'
  if (provider === 'paypal') return 'withheld'
  return 'pending'
}

/**
 * Per-rail schedule handling — the reason `available_on` is null differs by
 * rail, and only one of those reasons is a gap.
 *
 * Flutterwave never reports a clearing date, and correctly so: moving money
 * from its collection wallet to its payout wallet is a request the account
 * holder makes, not an event a clock fires. `null` there is the right
 * answer, not a missing one, and must never read as "not reported" — that
 * phrase implies the rail withheld something it actually has.
 */
type ScheduleDescriptor = { kind: 'date'; date: string } | { kind: 'none' } | { kind: 'unreported' }

function describeScheduleRow(r: RailLiveBalance): ScheduleDescriptor {
  if (r.available_on) return { kind: 'date', date: r.available_on }
  return r.provider === 'flutterwave' ? { kind: 'none' } : { kind: 'unreported' }
}

/** Neutral, and true for every rail: money moving on request, not on a timer. */
function NoScheduleNote() {
  return (
    <span
      className="text-fg-subtle"
      title="Flutterwave doesn't report a clearing date here because there isn't one — this money moves from the collection wallet to the payout wallet only when you request the transfer, not on a timer."
    >
      No schedule — moves on request
    </span>
  )
}

/**
 * What `reconcile` expects a provider to be holding for this currency —
 * every bucket except `paid_out`, which already left the rail. `null` means
 * PayHold has no ledger balance here at all, which is a different fact from
 * a diff of zero: there is nothing on the other side to compare against.
 */
function ledgerExpected(balance: Balance | null): Money | null {
  if (!balance) return null
  return (
    balance.held +
    balance.pending_clearance +
    balance.available +
    balance.reserved +
    balance.fees_retained +
    balance.tenant_funds
  )
}

// ---------------------------------------------------------------------------
// The row
// ---------------------------------------------------------------------------

function CurrencyRow({
  item,
  serviceFeeRate,
  railStatus,
  expanded,
  onToggle,
  faint,
}: {
  item: CurrencyBalanceData
  serviceFeeRate: number | undefined
  railStatus: 'pending' | 'error' | 'success'
  expanded: boolean
  onToggle: () => void
  faint?: boolean
}) {
  const { currency, balance, rows } = item
  const s = summarize(rows)
  const expected = ledgerExpected(balance)
  // Never computed while any rail for this currency failed to answer — a gap
  // against a figure nobody could ask the rail for is not the ledger's to
  // explain.
  const diff = s.unreachable.length === 0 && expected !== null ? s.railSum - expected : null

  const tone: Tone = s.allUnreachable
    ? 'danger'
    : s.unreachable.length > 0
      ? 'pending'
      : diff !== null && diff !== 0
        ? 'danger'
        : 'released'

  const hasDetail = rows.length > 0 || balance !== null

  return (
    <>
      <tr className="transition-colors hover:bg-surface-2/70">
        <Td>
          <div className="flex items-center gap-2">
            {hasDetail ? (
              <button
                type="button"
                onClick={onToggle}
                aria-label={expanded ? 'Collapse' : 'Expand'}
                className="flex size-5 shrink-0 items-center justify-center rounded-md text-fg-subtle transition hover:bg-surface-2 hover:text-fg"
              >
                <svg
                  viewBox="0 0 24 24"
                  className={cx('size-3.5 transition-transform', expanded && 'rotate-90')}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                >
                  <path d="M9 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            ) : (
              <span className="size-5 shrink-0" />
            )}
            <Dot tone={tone} />
            <span className={cx('font-mono text-sm font-semibold', faint ? 'text-fg-muted' : 'text-fg')}>
              {currency}
            </span>
            <div className="flex flex-wrap gap-1">
              {s.sandbox && (
                <Badge
                  meta={{
                    label: 'Sandbox',
                    tone: 'pending',
                    hint: 'At least one rail here is connected in test mode — that figure is its sandbox balance, not real money.',
                  }}
                />
              )}
              {s.stale && (
                <Badge
                  meta={{
                    label: 'Stale',
                    tone: 'pending',
                    hint: 'At least one figure here is the last stored reconciliation, not a call made just now.',
                  }}
                />
              )}
              {rows.length > 1 && (
                <Badge
                  meta={{
                    label: `${rows.length} rails`,
                    tone: 'neutral',
                    hint: `${rows.map(railLabel).join(' and ')} both hold ${currency} — each moves on its own terms. Expand for each rail's own figures.`,
                  }}
                />
              )}
            </div>
          </div>
          {/* Columns hidden below `md` collapse here, so the row stays
              legible narrow without a caveat silently disappearing. */}
          <div className="mt-1 pl-7 text-xs text-fg-muted md:hidden">
            {balance === null ? 'No PayHold ledger' : 'Has PayHold ledger — expand for detail'}
          </div>
        </Td>

        <Td align="right">
          <RailHoldsCell rows={rows} s={s} railStatus={railStatus} />
        </Td>

        <Td align="right" responsive>
          <AvailableCell s={s} currency={currency} />
        </Td>

        <Td align="right" responsive>
          <NotYetAvailableCell s={s} currency={currency} />
        </Td>

        <Td responsive lgOnly>
          <ScheduleCell s={s} />
        </Td>

        <Td responsive>
          <RevenueCell balance={balance} currency={currency} />
        </Td>

        <Td responsive>
          <LedgerCell balance={balance} currency={currency} diff={diff} />
        </Td>
      </tr>

      {expanded && hasDetail && (
        <tr>
          <Td colSpan={7} className="bg-surface-2/40">
            <RowDetail item={item} s={s} expected={expected} diff={diff} serviceFeeRate={serviceFeeRate} />
          </Td>
        </tr>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------

/**
 * THE HEADLINE for one currency — summed from every rail that answered.
 * **A rail that did not answer never renders as 0.00, here or in any other
 * cell on this row** — this is the single most important rule on the
 * screen. Fully unreachable renders as the word itself, in danger red;
 * partially unreachable keeps the partial sum but says so underneath, so the
 * total is never mistaken for the whole truth.
 */
function RailHoldsCell({
  rows,
  s,
  railStatus,
}: {
  rows: RailLiveBalance[]
  s: RailSummary
  railStatus: 'pending' | 'error' | 'success'
}) {
  if (rows.length === 0) {
    if (railStatus === 'pending') {
      return <span className="text-xs text-fg-subtle">checking…</span>
    }
    if (railStatus === 'error') {
      return <span className="text-xs text-fg-subtle">could not check — see notice above</span>
    }
    return <span className="text-xs text-fg-subtle">not held at any connected rail</span>
  }
  if (s.allUnreachable) {
    return (
      <span
        className="font-semibold text-danger"
        title="No rail holding this currency answered. This is not the same as a zero balance."
      >
        Unreachable
      </span>
    )
  }
  return (
    <div>
      <span className="tabular font-semibold text-fg">{formatMoneyShort(s.railSum, rows[0]!.currency)}</span>
      {s.unreachable.length > 0 && (
        <div className="mt-0.5 text-[11px] font-medium text-danger">
          {s.unreachable.length} of {rows.length} rails did not answer — total understates the truth
        </div>
      )}
      {s.latestAsOf && s.unreachable.length === 0 && (
        <div className="mt-0.5 text-[11px] text-fg-subtle">as of {formatDateTime(s.latestAsOf)}</div>
      )}
    </div>
  )
}

/**
 * Every reachable rail's own "ready to move" figure summed — a genuine sum,
 * since the concept (Flutterwave's payout wallet, Stripe's available,
 * PayPal's available) is the same shape everywhere even though the words
 * differ. The words ride along underneath, one line per distinct
 * (rail, term) pair, so a single-rail row — which is most of them — states
 * its own vocabulary without needing the expansion.
 */
function AvailableCell({ s, currency }: { s: RailSummary; currency: Currency }) {
  if (s.allUnreachable) return <UnreachableNote />
  if (s.reachable.length === 0) return <span className="text-fg-subtle">—</span>
  if (s.availKnown.length === 0) {
    return notReportedBy(Array.from(new Set(s.reachable.map(railLabel))))
  }
  const missing = s.reachable.filter((r) => r.available === null)
  const terms = Array.from(new Set(s.availKnown.map((r) => `${railLabel(r)}: ${availableTerm(r.provider)}`)))
  return (
    <div>
      <span className="tabular">{formatMoney(s.availSum, currency)}</span>
      <div className="mt-0.5 text-[11px] text-fg-subtle">{terms.join(' · ')}</div>
      {missing.length > 0 && (
        <div className="mt-0.5 text-[11px]">{notReportedBy(missing.map(railLabel))}</div>
      )}
    </div>
  )
}

/**
 * The other side of each rail's split, summed the same way — and summed
 * honestly rather than blended: Flutterwave's collection wallet, Stripe's
 * pending clearance and PayPal's withheld reserve are three different
 * reasons money isn't in the figure to the left, and the per-(rail, term)
 * note underneath is what keeps the sum from reading as one thing. Never
 * clamped — a real figure (Stripe's included) can be negative.
 */
function NotYetAvailableCell({ s, currency }: { s: RailSummary; currency: Currency }) {
  if (s.allUnreachable) return <UnreachableNote />
  if (s.reachable.length === 0) return <span className="text-fg-subtle">—</span>
  if (s.pendingKnown.length === 0) {
    return notReportedBy(Array.from(new Set(s.reachable.map(railLabel))))
  }
  const missing = s.reachable.filter((r) => r.pending === null)
  const terms = Array.from(new Set(s.pendingKnown.map((r) => `${railLabel(r)}: ${pendingTerm(r.provider)}`)))
  return (
    <div>
      <span className="tabular">{formatMoney(s.pendingSum, currency)}</span>
      <div className="mt-0.5 text-[11px] text-fg-subtle">{terms.join(' · ')}</div>
      {missing.length > 0 && (
        <div className="mt-0.5 text-[11px]">{notReportedBy(missing.map(railLabel))}</div>
      )}
    </div>
  )
}

/**
 * When the figure to the left moves, exactly as each rail reports it — and
 * "Flutterwave never reports one" renders as the structural fact it is, not
 * as a gap. `describeScheduleRow` is what tells the two apart: `'none'`
 * (Flutterwave, always) is a correct null, `'unreported'` (Stripe or PayPal,
 * were it ever null) is a genuine one, and only the second gets
 * `notReportedBy`.
 */
function ScheduleCell({ s }: { s: RailSummary }) {
  if (s.allUnreachable) return <UnreachableNote />
  if (s.reachable.length === 0) return <span className="text-fg-subtle">—</span>

  const descriptors = s.reachable.map((r) => ({ row: r, d: describeScheduleRow(r) }))
  const allNone = descriptors.every((x) => x.d.kind === 'none')
  const allUnreported = descriptors.every((x) => x.d.kind === 'unreported')
  const dateOnly = descriptors.filter(
    (x): x is { row: RailLiveBalance; d: { kind: 'date'; date: string } } => x.d.kind === 'date',
  )
  const allSameDate = dateOnly.length === descriptors.length && new Set(dateOnly.map((x) => x.d.date)).size === 1

  if (allSameDate) {
    return <span>{formatDateTime(dateOnly[0]!.d.date)}</span>
  }
  if (allNone) {
    return <NoScheduleNote />
  }
  if (allUnreported) {
    return notReportedBy(Array.from(new Set(descriptors.map((x) => railLabel(x.row)))))
  }
  return (
    <span
      className="cursor-help border-b border-dotted border-fg-subtle/50 text-fg-muted"
      title="Each rail here handles timing differently — one has a schedule, one doesn't, or their dates differ. Expand the row for each one."
    >
      Varies by rail
    </span>
  )
}

function UnreachableNote() {
  return (
    <span className="text-xs font-medium text-danger" title="The rail did not answer. Not the same as zero.">
      unreachable
    </span>
  )
}

/**
 * PayHold's own allocation, secondary and compact — a column, not a card.
 * `null` renders as "No PayHold ledger" exactly where the rail holds a
 * currency PayHold has no books for. Where a ledger balance exists, the diff
 * against the rail rides along here as a small colored note, and is never
 * shown while any rail for this currency failed to answer.
 */
/**
 * What this account has earned, in its own column rather than buried in a
 * row's expansion — the owner asked to see it without hunting for it.
 *
 * It is `fees_retained`: the service fee plus any tax collected, bundled,
 * because no per-currency read splits the two. A zero here is not an error
 * and usually is not a shortfall either: the fee is struck when a deal is
 * RELEASED, so money sitting in `held` against open deals has earned nothing
 * yet. That is the difference worth showing, so a zero says which of the two
 * it is rather than leaving the reader to guess — "nothing released yet"
 * while a deal is open and holding money, "nothing to earn yet" when there
 * isn't even that.
 */
function RevenueCell({ balance, currency }: { balance: Balance | null; currency: Currency }) {
  if (!balance) {
    return <span className="text-fg-subtle">—</span>
  }
  const earned = balance.fees_retained
  const awaitingRelease = earned === 0 && balance.held > 0
  const nothingToEarn = earned === 0 && balance.held <= 0
  return (
    <div>
      <span className="tabular font-medium">{formatMoneyShort(earned, currency)}</span>
      <div
        className="mt-0.5 text-[11px] text-fg-subtle"
        title="Your service fee plus any tax collected, bundled — no per-currency read splits them. Struck when a deal is released, and still sitting at the provider: nothing sweeps it out."
      >
        {awaitingRelease
          ? 'nothing released yet'
          : nothingToEarn
            ? 'nothing to earn yet'
            : 'fee + tax, at the provider'}
      </div>
    </div>
  )
}

function LedgerCell({
  balance,
  currency,
  diff,
}: {
  balance: Balance | null
  currency: Currency
  diff: Money | null
}) {
  if (!balance) {
    return (
      <Badge
        meta={{
          label: 'No PayHold ledger',
          tone: 'neutral',
          hint: 'PayHold has no deals or ledger entries in this currency. The figures to the left are the rail’s own report, with nothing booked here to allocate them against.',
        }}
      />
    )
  }
  return (
    <div>
      <span className="tabular">
        {formatMoneyShort(balance.available, currency)} avail · {formatMoneyShort(balance.pending_clearance, currency)}{' '}
        clearing
      </span>
      {diff !== null && (
        <div className={cx('mt-0.5 text-[11px] font-medium', diff === 0 ? 'text-fg-subtle' : 'text-danger')}>
          {diff === 0
            ? 'matches rail'
            : `${formatMoney(Math.abs(diff), currency)} ${diff > 0 ? 'more at rail' : 'less at rail'}`}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Expansion — everything a table cell can't hold
// ---------------------------------------------------------------------------

/**
 * Per-rail splits, in full, plus PayHold's own seven buckets when there is a
 * ledger balance. This is where a multi-rail currency's breakdown lives —
 * the combined figures above are never the only view of it — and where every
 * caveat that didn't fit a cell gets its full sentence.
 */
function RowDetail({
  item,
  s,
  expected,
  diff,
  serviceFeeRate,
}: {
  item: CurrencyBalanceData
  s: RailSummary
  expected: Money | null
  diff: Money | null
  serviceFeeRate: number | undefined
}) {
  const { currency, balance, rows } = item

  return (
    <div className="space-y-4 py-2">
      {rows.length > 0 && (
        <div>
          <div className="mb-2 text-xs font-semibold tracking-[0.06em] text-fg-muted uppercase">
            Per-rail split
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {rows.map((r) => (
              <RailSplitCard key={r.provider} row={r} />
            ))}
          </div>
        </div>
      )}

      {expected === null ? (
        rows.length > 0 && (
          <p className="text-xs font-medium text-fg-muted">
            PayHold holds no ledger balance in {currency} — the figures above are the rail's own report only.
          </p>
        )
      ) : diff !== null ? (
        <p className={cx('text-xs', diff === 0 ? 'text-fg-muted' : 'font-semibold text-danger')}>
          {diff === 0
            ? "Matches PayHold's own books below."
            : `${formatMoney(Math.abs(diff), currency)} ${
                diff > 0 ? 'more at the rail than' : 'less at the rail than'
              } PayHold's books below account for — not corrected here.`}
        </p>
      ) : (
        s.unreachable.length > 0 && (
          <p className="text-xs font-medium text-fg-muted">
            {s.unreachable.length} of {rows.length} rail{rows.length > 1 ? 's' : ''} did not answer, so the
            difference against PayHold's own books is not shown — a gap against a figure nobody could ask the
            rail for is not the ledger's to explain.
          </p>
        )
      )}

      {balance && (
        <div>
          <div className="mb-2 text-xs font-semibold tracking-[0.06em] text-fg-muted uppercase">
            PayHold's own books
          </div>
          <LedgerBuckets balance={balance} currency={currency} serviceFeeRate={serviceFeeRate} />
        </div>
      )}
    </div>
  )
}

function RailSplitCard({ row }: { row: RailLiveBalance }) {
  const unreachable = row.amount === null || row.error != null
  const label = railLabel(row)
  const isFlutterwave = row.provider === 'flutterwave'
  const isPaypal = row.provider === 'paypal'

  const availableLabel = isFlutterwave ? 'Payout wallet' : 'Available'
  const availableHint = isFlutterwave
    ? `${label} calls this the payout balance — money loaded and ready to disburse.`
    : `What ${label} itself says can be paid out today.`

  const pendingLabel = isFlutterwave ? 'Collection wallet' : isPaypal ? 'Withheld' : 'Pending'
  const pendingHint = isFlutterwave
    ? `${label} calls this the collection balance — money already collected from customers that has not been moved to the payout wallet. Not a clearing process: it moves only when you request the transfer.`
    : isPaypal
      ? `Money ${label} is withholding as a reserve — not the same as a clearing process, and not on a published timer.`
      : `What ${label} is holding back from the figure above, still clearing. Never clamped — a real figure can be negative.`

  const schedule = describeScheduleRow(row)

  return (
    <Card className="p-3.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold tracking-[0.04em] text-fg">{label}</span>
        <div className="flex gap-1">
          {row.mode === 'test' && (
            <Badge meta={{ label: 'Sandbox', tone: 'pending', hint: `${label} is connected in test mode.` }} />
          )}
          {row.stale && (
            <Badge
              meta={{
                label: 'Stale',
                tone: 'pending',
                hint: 'The last stored reconciliation figure, not a call made just now.',
              }}
            />
          )}
        </div>
      </div>

      {unreachable ? (
        <p className="mt-2 text-xs font-medium text-danger">
          Could not be reached{row.error ? ` (${row.error})` : ''} — no split to show. Not the same as a zero
          balance.
        </p>
      ) : (
        <>
          <div className="mt-1.5 tabular text-sm font-semibold text-fg">
            {formatMoney(row.amount!, row.currency)}
          </div>
          <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
            <MiniFigure
              label={availableLabel}
              value={row.available === null ? notReported(label) : formatMoney(row.available, row.currency)}
              hint={availableHint}
            />
            <MiniFigure
              label={pendingLabel}
              value={row.pending === null ? notReported(label) : formatMoney(row.pending, row.currency)}
              hint={pendingHint}
              faint={row.pending === null}
            />
            <MiniFigure
              label="Schedule"
              value={
                schedule.kind === 'date' ? (
                  formatDateTime(schedule.date)
                ) : schedule.kind === 'none' ? (
                  <NoScheduleNote />
                ) : (
                  notReported(label)
                )
              }
              hint={
                schedule.kind === 'none'
                  ? `${label} doesn't report a clearing date here because there isn't one — this moves from the collection wallet to the payout wallet only when you request the transfer, not on a timer.`
                  : 'When the amount above becomes available, exactly as the rail itself reports it — never a computed estimate.'
              }
              faint={schedule.kind !== 'date'}
            />
          </div>
          <div className="mt-2 text-[11px] text-fg-subtle">as of {formatDateTime(row.as_of)}</div>
        </>
      )}
    </Card>
  )
}

/**
 * PayHold's seven ledger buckets for one currency — folded out of the row
 * rather than a second card, per §-level convention: the rail's figure
 * answers "how much money do I have", this answers "who is it owed to".
 */
function LedgerBuckets({
  balance,
  currency,
  serviceFeeRate,
}: {
  balance: Balance
  currency: Currency
  serviceFeeRate: number | undefined
}) {
  const sellersNet = balance.pending_clearance + balance.available + balance.paid_out

  return (
    <div className="flex flex-wrap gap-x-6 gap-y-3">
      <MiniFigure label="Held" value={formatMoneyShort(balance.held, currency)} hint="Buyer money in the vault against open deals." />
      <MiniFigure
        label="Clearing"
        value={formatMoneyShort(balance.pending_clearance, currency)}
        hint="Released, waiting out the clearance window."
      />
      <MiniFigure
        label="Available"
        value={formatMoneyShort(balance.available, currency)}
        hint="Cleared and payable to sellers now."
      />
      <MiniFigure label="Paid out" value={formatMoneyShort(balance.paid_out, currency)} hint="Lifetime total sent to sellers." />
      <MiniFigure
        label="Your revenue"
        value={formatMoneyShort(balance.fees_retained, currency)}
        hint={`${
          serviceFeeRate !== undefined
            ? `${formatPercent(serviceFeeRate)} service fee, plus any tax collected`
            : 'Service fee plus any tax collected'
        }, bundled together. Still at the provider, not swept out anywhere. Not profit, and not netted against the rail's own cut.`}
      />
      {balance.tenant_funds !== 0 && (
        <MiniFigure
          label={balance.tenant_funds > 0 ? 'Yours to move' : 'To top up'}
          value={formatMoneyShort(Math.abs(balance.tenant_funds), currency)}
          hint={
            balance.tenant_funds > 0
              ? 'Collected here but paid out from another rail — no seller is owed it.'
              : 'Paid out of this currency beyond what you have funded it with.'
          }
        />
      )}
      <MiniFigure
        label="Rail's cut"
        value={<span className="text-fg-subtle">not shown here</span>}
        hint="The rail's own number — leaves this balance the instant the rail takes it, so there is no account-wide total to read. Open a deal's Money card for the figure on that one payment."
        faint
      />
      <MiniFigure
        label="Sellers' net"
        value={formatMoneyShort(sellersNet, currency)}
        hint="Clearing + available + paid out, none of them gross — every deduction, including the rail's own cut, is already out of these three."
      />
    </div>
  )
}

function MiniFigure({
  label,
  value,
  hint,
  faint,
}: {
  label: string
  value: ReactNode
  hint: string
  faint?: boolean
}) {
  return (
    <div className="min-w-[6.5rem]">
      <div
        className="cursor-help border-b border-dotted border-fg-subtle/50 text-[11px] font-medium tracking-[0.02em] text-fg-subtle uppercase"
        title={hint}
      >
        {label}
      </div>
      <div className={cx('tabular mt-1 text-sm font-semibold', faint ? 'font-normal text-fg-subtle' : 'text-fg')}>
        {value}
      </div>
    </div>
  )
}
