import { type ReactNode, useState } from 'react'
import type { Balance, Currency, Money, RailLiveBalance } from '@/api'
import { Badge, Card, Dot, cx } from '@/components/ui'
import { formatDateTime, formatMoney, formatPercent, type Tone } from '@/lib/format'
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
    <div className="space-y-3">
      {active.map((item) => (
        <CurrencyCard
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
        />
      ))}

      {empty.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setShowEmpty((v) => !v)}
            className="text-xs font-semibold text-brand hover:underline"
          >
            {`${showEmpty ? 'Hide' : 'Show'} ${empty.length} ${
              empty.length === 1 ? 'currency' : 'currencies'
            } with no balance`}
          </button>
        </div>
      )}

      {showEmpty &&
        empty.map((item) => (
          <CurrencyCard
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
    </div>
  )
}

// ---------------------------------------------------------------------------
// Shared notes
// ---------------------------------------------------------------------------

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
 * The two money figures mean a different thing per rail, and Flutterwave's
 * were named wrongly here until 2026-09-12 — on a money screen, which is the
 * worst place for a wrong noun.
 *
 * What Flutterwave actually publishes is a **total and a subset of it**, not
 * two wallets that add up. `ledger_balance` — our `amount` — is the total, and
 * is what its dashboard labels *Collection balance*. `available_balance` — our
 * `available` — is the withdrawable part of that same money, its *Payout
 * balance*. On this account today: 59,664.57 total, 59,564.57 withdrawable.
 *
 * So the remainder our `pending` field carries is `total − withdrawable`, here
 * NGN 100.00, and it **has no name at Flutterwave at all**. Calling it the
 * "collection wallet" told the owner his collection balance was one hundred
 * naira when Flutterwave was calling nearly sixty thousand by that name. It is
 * described by what is true of it and nothing more: not withdrawable yet.
 * Nothing there is "clearing" either — it does not settle on a timer.
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
  if (provider === 'flutterwave') return 'not withdrawable yet'
  if (provider === 'paypal') return 'withheld'
  return 'pending'
}

/**
 * Per-rail schedule handling — the reason `available_on` is null differs by
 * rail, and only one of those reasons is a gap.
 *
 * Flutterwave never reports a clearing date, and correctly so: moving money
 * the part of a balance that is not withdrawable yet becomes withdrawable when
 * Flutterwave settles it, not when a clock fires. `null` there is the right
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
      title="Flutterwave doesn't report a clearing date here because there isn't one — the part of your balance that is not withdrawable yet becomes withdrawable when Flutterwave settles it or you ask, not on a published timer."
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
// The card
// ---------------------------------------------------------------------------

/**
 * One currency, as a card rather than a row in a seven-column table.
 *
 * The table this replaces asked the reader to hold seven headers in their head
 * — every one of which wrapped onto two lines — and then hid the answer to the
 * only question the screen exists for. "PayHold's allocation" showed
 * `available` and `clearing` and never `held`, so an account holding
 * NGN 59,664.57 against an open deal read as "NGN 0.00 avail · NGN 0.00
 * clearing", and the money PayHold is actually accounting for appeared only
 * after expanding the row.
 *
 * So the card states three things in the order they are asked:
 *
 *   1. **How much is at the rail**, which is the observable fact, with the
 *      rail's own word for each part of it.
 *   2. **Whether PayHold's books agree** — one line, because that is the whole
 *      question reconciliation answers, and a disagreement is the only thing on
 *      this screen that means something is wrong.
 *   3. **What PayHold says the money is for** — held, clearing, available,
 *      earned. Surfaced, not folded away.
 *
 * Every distinction the table drew is kept, because each exists to stop the
 * screen stating something untrue: a rail that did not answer never renders as
 * zero, a rail that reports no figure is "not reported by" rather than a dash,
 * Flutterwave's absent schedule says it moves on request rather than that
 * something is missing, and no ledger-versus-rail difference is shown while any
 * rail failed to answer.
 */
function CurrencyCard({
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

  // Green means "checked, and it agrees" — so a currency with no books to
  // compare against is neutral rather than green. Reading a rail-only balance
  // as reconciled is the same mistake as reading an unreachable rail as zero.
  const tone: Tone = s.allUnreachable
    ? 'danger'
    : s.unreachable.length > 0
      ? 'pending'
      : diff === null
        ? 'neutral'
        : diff === 0
          ? 'released'
          : 'danger'

  return (
    <Card className={cx('overflow-hidden', faint && 'opacity-70')}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 px-5 pt-4">
        <div className="flex items-center gap-2">
          <Dot tone={tone} />
          <span className="text-sm font-semibold tracking-wide text-fg">{currency}</span>
          {s.sandbox && (
            <span
              className="text-[11px] font-medium text-pending"
              title="Every rail holding this currency is connected in test mode. None of it is real money."
            >
              Sandbox
            </span>
          )}
          {s.stale && (
            <span
              className="text-[11px] font-medium text-fg-subtle"
              title="A rail could not be reached just now, so this is the last figure PayHold read from it."
            >
              last known
            </span>
          )}
        </div>
        {s.latestAsOf && s.unreachable.length === 0 && (
          <span className="text-[11px] text-fg-subtle">as of {formatDateTime(s.latestAsOf)}</span>
        )}
      </div>

      {/* 1 — what the rail holds, and the rail's own words for the parts of it */}
      <div className="px-5 pb-4 pt-2">
        <RailHeadline rows={rows} s={s} railStatus={railStatus} />
        <RailParts s={s} currency={currency} />
      </div>

      {/* 2 and 3 — PayHold's side, on the same card rather than behind a chevron */}
      <div className="border-t border-line bg-surface-2/40 px-5 py-4">
        <LedgerSide
          balance={balance}
          currency={currency}
          diff={diff}
          s={s}
          rows={rows}
          serviceFeeRate={serviceFeeRate}
        />
      </div>

      {/* A single reachable rail's split is already on the card above, so the
          toggle would open a card restating it. It earns its place once there
          is more than one rail, or a rail whose own state needs explaining. */}
      {(rows.length > 1 || s.unreachable.length > 0 || s.stale) && (
        <div className="border-t border-line px-5 py-2.5">
          <button
            type="button"
            onClick={onToggle}
            className="text-xs font-semibold text-brand hover:underline"
          >
            {expanded ? 'Hide per-rail detail' : `Per-rail detail (${rows.length})`}
          </button>
          {expanded && (
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {rows.map((r) => (
                <RailSplitCard key={r.provider} row={r} />
              ))}
            </div>
          )}
        </div>
      )}
    </Card>
  )
}

/**
 * THE HEADLINE for one currency — summed from every rail that answered.
 * **A rail that did not answer never renders as 0.00** — the single most
 * important rule on the screen. Fully unreachable renders as the word itself,
 * in danger red; partially unreachable keeps the partial sum but says so, so
 * the total is never mistaken for the whole truth.
 */
function RailHeadline({
  rows,
  s,
  railStatus,
}: {
  rows: RailLiveBalance[]
  s: RailSummary
  railStatus: 'pending' | 'error' | 'success'
}) {
  if (rows.length === 0) {
    return (
      <p className="text-sm text-fg-subtle">
        {railStatus === 'pending'
          ? 'checking…'
          : railStatus === 'error'
            ? 'could not check — see notice above'
            : 'not held at any connected rail'}
      </p>
    )
  }
  if (s.allUnreachable) {
    return (
      <p
        className="text-2xl font-semibold text-danger"
        title="No rail holding this currency answered. This is not the same as a zero balance."
      >
        Unreachable
      </p>
    )
  }

  const railNames = Array.from(new Set(s.reachable.map(railLabel)))
  return (
    <div>
      <span className="tabular text-2xl font-semibold text-fg">
        {formatMoney(s.railSum, rows[0]!.currency)}
      </span>
      <span className="ml-2 text-xs text-fg-muted">
        at {railNames.length === 1 ? railNames[0] : `${railNames.length} rails`}
      </span>
      {s.unreachable.length > 0 && (
        <p className="mt-1 text-[11px] font-medium text-danger">
          {s.unreachable.length} of {rows.length} rails did not answer — this total understates the truth
        </p>
      )}
    </div>
  )
}

/**
 * The rail's own split of that headline, on one line, in the rail's own
 * vocabulary — Flutterwave's withdrawable payout balance against the part of
 * the total that is not withdrawable yet, Stripe's available against pending,
 * PayPal's available against withheld.
 *
 * They are summed across rails but never blended into one word: three rails
 * hold money back for three different reasons, so each figure carries the name
 * of the rail and the term that rail uses. A rail reporting no figure says so
 * rather than contributing a silent zero.
 */
function RailParts({ s, currency }: { s: RailSummary; currency: Currency }) {
  if (s.reachable.length === 0) return null

  const availTerms = Array.from(
    new Set(s.availKnown.map((r) => `${railLabel(r)}: ${availableTerm(r.provider)}`)),
  )
  const pendingTerms = Array.from(
    new Set(s.pendingKnown.map((r) => `${railLabel(r)}: ${pendingTerm(r.provider)}`)),
  )
  const availMissing = s.reachable.filter((r) => r.available === null).map(railLabel)
  const pendingMissing = s.reachable.filter((r) => r.pending === null).map(railLabel)

  return (
    <div className="mt-3 flex flex-wrap gap-x-8 gap-y-3">
      <Part
        label="Ready to move"
        value={s.availKnown.length > 0 ? formatMoney(s.availSum, currency) : null}
        terms={availTerms}
        missing={availMissing}
      />
      <Part
        label="Not yet"
        value={s.pendingKnown.length > 0 ? formatMoney(s.pendingSum, currency) : null}
        terms={pendingTerms}
        missing={pendingMissing}
      />
      <div className="min-w-[9rem]">
        <div className="text-[11px] font-medium tracking-[0.02em] text-fg-subtle uppercase">Schedule</div>
        <div className="mt-1 text-xs">
          <ScheduleLine s={s} />
        </div>
      </div>
    </div>
  )
}

function Part({
  label,
  value,
  terms,
  missing,
}: {
  label: string
  value: string | null
  terms: string[]
  missing: string[]
}) {
  return (
    <div className="min-w-[9rem]">
      <div className="text-[11px] font-medium tracking-[0.02em] text-fg-subtle uppercase">{label}</div>
      <div className="tabular mt-1 text-sm font-semibold text-fg">
        {value ?? notReportedBy(missing.length ? missing : ['this rail'])}
      </div>
      {value !== null && terms.length > 0 && (
        <div className="mt-0.5 text-[11px] text-fg-subtle">{terms.join(' · ')}</div>
      )}
      {value !== null && missing.length > 0 && (
        <div className="mt-0.5 text-[11px]">{notReportedBy(missing)}</div>
      )}
    </div>
  )
}

function ScheduleLine({ s }: { s: RailSummary }) {
  if (s.reachable.length === 0) return <span className="text-fg-subtle">—</span>
  const kinds = s.reachable.map(describeScheduleRow)
  const dates = Array.from(new Set(kinds.filter((k) => k.kind === 'date').map((k) => k.date)))
  const allNone = kinds.every((k) => k.kind === 'none')

  if (allNone) return <NoScheduleNote />
  if (dates.length === 1 && kinds.every((k) => k.kind === 'date')) {
    return <span className="text-fg-muted">{formatDateTime(dates[0]!)}</span>
  }
  if (dates.length === 0) {
    return notReportedBy(Array.from(new Set(s.reachable.map(railLabel))))
  }
  return (
    <span
      className="cursor-help border-b border-dotted border-fg-subtle/50 text-fg-muted"
      title="Each rail here handles timing differently — one has a schedule, one doesn't, or their dates differ. Open the per-rail detail."
    >
      Varies by rail
    </span>
  )
}

/**
 * PayHold's own side of the card: whether the books agree with the rail, and
 * then what the books say the money is for.
 *
 * The agreement line comes first and is the only thing here that can be wrong.
 * A currency PayHold has no ledger for says exactly that, once, instead of
 * rendering a row of zeroes that would read as "PayHold holds nothing of
 * yours" rather than "PayHold has never booked anything in this currency".
 */
function LedgerSide({
  balance,
  currency,
  diff,
  s,
  rows,
  serviceFeeRate,
}: {
  balance: Balance | null
  currency: Currency
  diff: Money | null
  s: RailSummary
  rows: RailLiveBalance[]
  serviceFeeRate: number | undefined
}) {
  if (!balance) {
    return (
      <p className="text-xs text-fg-muted">
        <span className="font-semibold text-fg">No PayHold ledger in {currency}.</span> No deal has ever been
        booked in this currency, so everything above is the rail's own report and none of it is allocated to a
        buyer, a seller or to you.
      </p>
    )
  }

  return (
    <div className="space-y-3">
      <p className="text-xs">
        {diff === null ? (
          <span className="text-fg-muted">
            {s.unreachable.length > 0
              ? `${s.unreachable.length} of ${rows.length} rail${rows.length > 1 ? 's' : ''} did not answer, so PayHold's books are not compared against the rail here — a gap against a figure nobody could ask for is not the ledger's to explain.`
              : "PayHold's books, not yet compared against the rail."}
          </span>
        ) : diff === 0 ? (
          <span className="font-medium text-released">
            PayHold's books agree with the rail, to the {currency === 'JPY' ? 'yen' : 'penny'}.
          </span>
        ) : (
          <span className="font-semibold text-danger">
            {formatMoney(Math.abs(diff), currency)} {diff > 0 ? 'more' : 'less'} at the rail than PayHold's
            books account for — not corrected here.
          </span>
        )}
      </p>
      <LedgerBuckets balance={balance} currency={currency} serviceFeeRate={serviceFeeRate} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Per-rail detail
// ---------------------------------------------------------------------------

function RailSplitCard({ row }: { row: RailLiveBalance }) {
  const unreachable = row.amount === null || row.error != null
  const label = railLabel(row)
  const isFlutterwave = row.provider === 'flutterwave'
  const isPaypal = row.provider === 'paypal'

  const availableLabel = isFlutterwave ? 'Payout wallet' : 'Available'
  const availableHint = isFlutterwave
    ? `${label} calls this the payout balance — money loaded and ready to disburse.`
    : `What ${label} itself says can be paid out today.`

  const pendingLabel = isFlutterwave ? 'Not withdrawable yet' : isPaypal ? 'Withheld' : 'Pending'
  const pendingHint = isFlutterwave
    ? `${label} publishes a total and the withdrawable part of it, not two wallets — its dashboard calls the total the collection balance and the withdrawable part the payout balance. This is the difference between them, which ${label} does not name at all. Not a clearing process: nothing here moves on a timer.`
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
                  ? `${label} doesn't report a clearing date here because there isn't one — this becomes withdrawable when ${label} settles it, not on a published timer.`
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
      <MiniFigure
        label="Held"
        value={formatMoney(balance.held, currency)}
        zero={balance.held === 0}
        hint="Buyer money in the vault against open deals."
      />
      <MiniFigure
        label="Clearing"
        value={formatMoney(balance.pending_clearance, currency)}
        zero={balance.pending_clearance === 0}
        hint="Released, waiting out the clearance window."
      />
      <MiniFigure
        label="Available"
        value={formatMoney(balance.available, currency)}
        zero={balance.available === 0}
        hint="Cleared and payable to sellers now."
      />
      <MiniFigure
        label="Paid out"
        value={formatMoney(balance.paid_out, currency)}
        zero={balance.paid_out === 0}
        hint="Lifetime total sent to sellers."
      />
      <MiniFigure
        label="Your revenue"
        value={formatMoney(balance.fees_retained, currency)}
        zero={balance.fees_retained === 0}
        hint={`${
          serviceFeeRate !== undefined
            ? `${formatPercent(serviceFeeRate)} service fee, plus any tax collected`
            : 'Service fee plus any tax collected'
        }, bundled together. Still at the provider, not swept out anywhere. Not profit, and not netted against the rail's own cut.`}
      />
      {balance.tenant_funds !== 0 && (
        <MiniFigure
          label={balance.tenant_funds > 0 ? 'Yours to move' : 'To top up'}
          value={formatMoney(Math.abs(balance.tenant_funds), currency)}
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
        value={formatMoney(sellersNet, currency)}
        zero={sellersNet === 0}
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
  zero,
}: {
  label: string
  value: ReactNode
  hint: string
  faint?: boolean
  /** A bucket at zero recedes, so the eye lands on the ones holding money. */
  zero?: boolean
}) {
  return (
    <div className="min-w-[6.5rem]">
      <div
        className="cursor-help border-b border-dotted border-fg-subtle/50 text-[11px] font-medium tracking-[0.02em] text-fg-subtle uppercase"
        title={hint}
      >
        {label}
      </div>
      <div
        className={cx(
          'tabular mt-1 text-sm font-semibold',
          faint || zero ? 'font-normal text-fg-subtle' : 'text-fg',
        )}
      >
        {value}
      </div>
    </div>
  )
}
