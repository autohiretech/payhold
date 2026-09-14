import { type ReactNode, useState } from 'react'
import type { Balance, Currency, Money, Provider, RailBalance, RailLiveBalance } from '@/api'
import { Badge, Card, Dot, cx } from '@/components/ui'
import { formatDateTime, formatMoney, type Tone } from '@/lib/format'
import { PROVIDER_LABEL } from '@/lib/rails'

/**
 * One currency's worth of input, decided by `Overview.tsx` and only rendered
 * here: PayHold's own ledger balance for it (or `null` — most rail currencies
 * have no ledger row at all), the same books split per rail, every `atRail`
 * entry that named this currency (zero, one, or several — USD is Stripe and
 * PayPal at once), and what has actually been paid to sellers in it.
 */
export interface CurrencyBalanceData {
  currency: Currency
  balance: Balance | null
  rows: RailLiveBalance[]
  /**
   * PayHold's books for this currency split by rail. Empty until loaded, and
   * empty for a currency PayHold has no ledger row on at all. The card checks
   * the rails *individually* off this — see `moneyFor`.
   */
  railLedger: RailBalance[]
  /** Delivered payouts in this currency. `null` while the payouts query is out. */
  paidPayouts: { count: number; total: Money } | null
  /**
   * No rail money and no ledger activity, on a currency where every rail
   * that reports it actually answered. Never true for a currency any rail
   * failed to reach — an unreachable rail is not a zero balance, and must
   * never be filed alongside one.
   */
  isEmpty: boolean
}

/**
 * The balances view: one card per currency, the zero-balance currencies
 * collapsed behind a single control.
 *
 * **What a card says, in order.** How much is at the rail; whose it is, as one
 * bar that visibly adds up to that number; whether PayHold's books agree; and
 * what that means and what to do, in sentences. The seven ledger buckets are
 * still the source of every figure, but they are grouped into four kinds of
 * money a person recognises — buyers', sellers', yours, unexplained — and the
 * bucket names never reach the screen.
 *
 * Every caveat the old table drew is kept, because each stops the screen
 * stating something untrue: a rail that did not answer never renders as zero,
 * a rail that reports no figure says so rather than contributing a silent
 * zero, and no books-versus-rail difference is shown while any rail failed to
 * answer.
 */
export function BalancesTable({
  items,
  railStatus,
}: {
  items: CurrencyBalanceData[]
  /**
   * Whether `GET /balance?live=1` has answered at all. A currency with no
   * `atRail` rows means two different things depending on this: "checked,
   * and no rail reports it" once the call has succeeded, versus "not
   * checked yet" or "could not check" while it hasn't.
   */
  railStatus: 'pending' | 'error' | 'success'
}) {
  const [showEmpty, setShowEmpty] = useState(false)

  const active = items.filter((i) => !i.isEmpty)
  const empty = items.filter((i) => i.isEmpty)

  return (
    <div className="space-y-4">
      <Summary items={active} />

      {active.map((item) => (
        <CurrencyCard key={item.currency} item={item} railStatus={railStatus} />
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
        empty.map((item) => <CurrencyCard key={item.currency} item={item} railStatus={railStatus} faint />)}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Shared notes
// ---------------------------------------------------------------------------

function notReported(rail: string): ReactNode {
  return <span className="font-normal text-fg-subtle">not reported by {rail}</span>
}

function railLabel(r: { provider: Provider }): string {
  return PROVIDER_LABEL[r.provider] ?? r.provider
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}

// ---------------------------------------------------------------------------
// Per-currency summary of what the rails reported
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

/**
 * The rail's own word for each half of its balance. Flutterwave publishes a
 * total and the withdrawable subset of it; the remainder has no name at
 * Flutterwave at all, so it is described by what is true of it. Stripe's
 * pending really is awaiting settlement; PayPal's is a withheld reserve.
 */
function availableTerm(provider: Provider): string {
  return provider === 'flutterwave' ? 'payout wallet' : 'available'
}

function pendingTerm(provider: Provider): string {
  if (provider === 'flutterwave') return 'not withdrawable yet'
  if (provider === 'paypal') return 'withheld'
  return 'pending'
}

/** When the not-yet part clears — a date, none (moves on request), or unreported. */
type ScheduleDescriptor = { kind: 'date'; date: string } | { kind: 'none' } | { kind: 'unreported' }

function describeScheduleRow(r: RailLiveBalance): ScheduleDescriptor {
  if (r.available_on) return { kind: 'date', date: r.available_on }
  return r.provider === 'flutterwave' ? { kind: 'none' } : { kind: 'unreported' }
}

// ---------------------------------------------------------------------------
// The four kinds of money — the arithmetic every part of the card reads from
// ---------------------------------------------------------------------------

/**
 * What `reconcile` expects a rail to be holding: every bucket except
 * `paid_out`, which already left. `null` when there are no books at all.
 */
function ledgerExpected(balance: Balance | RailBalance | null): Money | null {
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

interface RailMoney {
  provider: Provider
  label: string
  holds: Money
  expected: Money
  /** `holds − expected`: what this rail has that the books don't explain. */
  diff: Money
  /** Money collected here and paid out from another rail — yours, sitting here. */
  parked: Money
  /** Money this rail paid out beyond what was collected on it — owed to it. */
  owed: Money
}

interface CurrencyMoney {
  buyers: Money
  sellers: Money
  reserved: Money
  fees: Money
  parked: Money
  /** Positive: at the rails and explained by nothing. Negative: the rails are short. */
  unexplained: Money
  owed: Money
  booksSay: Money
  /** The backend's own figure: rails held − Σ expected. Nets debts, so it can differ from `unexplained`. */
  officialDiff: Money
  perRail: RailMoney[]
}

/**
 * Seven ledger buckets, grouped into four kinds of money, checked rail by rail.
 *
 * The grouping: `held` is buyers' money on open deals. `pending_clearance`,
 * `available` and `reserved` are all the seller's — the reserve is carved out
 * so it cannot be paid yet, but it is still theirs. `fees_retained` is yours,
 * and so is a positive `tenant_funds`: money collected on this rail whose
 * seller was paid from another rail, so it never left. A *negative*
 * `tenant_funds` is the other side of that same event — a rail that paid a
 * seller for money it never collected — and it is not a segment of the bar,
 * because there is no money there to draw. It is a debt you owe that rail,
 * and it is said as one.
 *
 * "Unexplained" is what is physically at the rails beyond everything above.
 * It is computed from the bar's own terms so the bar always adds up to the
 * headline, and it is **not** the backend's drift figure: `reconcile` nets
 * each rail's debt into its expectation, so on a currency where one rail is
 * owed money the official difference is larger than what is actually
 * unexplained. Both are shown, because both are true, and the old card's
 * single netted number is exactly what made "to top up $282.37" stand in for
 * a $4,763.34 top-up and a $4,480.97 transfer.
 *
 * Per rail, because reconciliation is per rail: a shortfall on one rail hidden
 * by a surplus on another must never read as "agrees".
 */
function moneyFor(s: RailSummary, railLedger: RailBalance[]): CurrencyMoney {
  const perRail: RailMoney[] = s.reachable.map((r) => {
    const l = railLedger.find((x) => x.provider === r.provider)
    const expected = l ? (ledgerExpected(l) ?? 0) : 0
    const holds = r.amount as Money
    return {
      provider: r.provider,
      label: railLabel(r),
      holds,
      expected,
      diff: holds - expected,
      parked: Math.max(0, l?.tenant_funds ?? 0),
      owed: Math.max(0, -(l?.tenant_funds ?? 0)),
    }
  })
  // Books can exist for a rail nobody could reach just now; its buckets still
  // belong to the currency's totals, only its `holds` is unknown.
  const ledgers = railLedger
  const sum = (f: (l: RailBalance) => Money) => ledgers.reduce((a, l) => a + f(l), 0)
  const buyers = sum((l) => l.held)
  const reserved = sum((l) => l.reserved)
  const sellers = sum((l) => l.pending_clearance + l.available) + reserved
  const fees = sum((l) => l.fees_retained)
  const parked = sum((l) => Math.max(0, l.tenant_funds))
  const owed = sum((l) => Math.max(0, -l.tenant_funds))
  const booksSay = sum((l) => ledgerExpected(l) ?? 0)
  return {
    buyers,
    sellers,
    reserved,
    fees,
    parked,
    owed,
    booksSay,
    unexplained: s.railSum - (buyers + sellers + fees + parked),
    officialDiff: s.railSum - booksSay,
    perRail,
  }
}

// ---------------------------------------------------------------------------
// Across all currencies
// ---------------------------------------------------------------------------

function Summary({ items }: { items: CurrencyBalanceData[] }) {
  if (items.length === 0) return null
  let agree = 0
  let cases = 0
  let moves = 0
  let unchecked = 0
  for (const item of items) {
    const s = summarize(item.rows)
    if (s.unreachable.length > 0 || item.railLedger.length === 0) {
      unchecked += 1
      continue
    }
    const m = moneyFor(s, item.railLedger)
    if (m.perRail.every((r) => r.diff === 0)) agree += 1
    cases += m.perRail.filter((r) => r.diff !== 0).length
    if (m.owed > 0) moves += 1
  }
  const tile = (k: string, v: ReactNode, small?: string) => (
    <div className="rounded-lg border border-line bg-surface px-4 py-3">
      <div className="text-[11px] font-semibold tracking-[0.06em] text-fg-subtle uppercase">{k}</div>
      <div className="mt-0.5 text-lg font-semibold text-fg">
        {v}
        {small && <span className="ml-1.5 text-[13px] font-medium text-fg-muted">{small}</span>}
      </div>
    </div>
  )
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {tile('Currencies with money', items.length, items.map((i) => i.currency).join(' · '))}
      {tile(
        'Books agree',
        `${agree} of ${items.length}`,
        unchecked ? `${unchecked} not fully checked` : undefined,
      )}
      {tile('Open cases to write up', cases)}
      {tile('Things to do', moves, moves ? 'move money between rails' : undefined)}
    </div>
  )
}

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

function CurrencyCard({
  item,
  railStatus,
  faint,
}: {
  item: CurrencyBalanceData
  railStatus: 'pending' | 'error' | 'success'
  faint?: boolean
}) {
  const { currency, balance, rows, railLedger, paidPayouts } = item
  const s = summarize(rows)
  // No comparison while any rail for this currency failed to answer — a gap
  // against a figure nobody could ask the rail for is not the ledger's to
  // explain. And none while PayHold has no books here at all.
  const checkable = rows.length > 0 && s.unreachable.length === 0 && balance !== null
  const m = checkable ? moneyFor(s, railLedger) : null
  const allAgree = !!m && m.perRail.every((r) => r.diff === 0)
  const openCases = m ? m.perRail.filter((r) => r.diff !== 0).length : 0
  const short = !!m && m.unexplained < 0

  const tone: Tone = s.allUnreachable
    ? 'danger'
    : s.unreachable.length > 0
      ? 'pending'
      : !m
        ? 'neutral'
        : allAgree
          ? 'released'
          : 'danger'

  const railNames = Array.from(new Set(s.reachable.map(railLabel)))

  return (
    <Card className={cx('overflow-hidden', faint && 'opacity-70')}>
      {/* ---- header: what currency, what state, when ---- */}
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-5 pt-4">
        <div className="flex flex-wrap items-center gap-2">
          <Dot tone={tone} />
          <span className="text-[15px] font-semibold tracking-wide text-fg">{currency}</span>
          {s.sandbox && (
            <Badge
              meta={{
                label: 'Sandbox',
                tone: 'neutral',
                hint: 'Every rail holding this currency is connected in test mode. None of it is real money.',
              }}
            />
          )}
          {s.stale && (
            <Badge
              meta={{
                label: 'Last known',
                tone: 'pending',
                hint: 'A rail could not be reached just now, so this is the last figure PayHold read from it.',
              }}
            />
          )}
          {m && allAgree && <Pill tone="released">Books agree</Pill>}
          {m && !allAgree && !short && (
            <Pill tone="danger">{openCases === 1 ? 'Needs a write-up' : `${openCases} open cases`}</Pill>
          )}
          {short && <Pill tone="danger">Rails are short — payouts frozen</Pill>}
          {m && m.owed > 0 && <Pill tone="pending">Move money between rails</Pill>}
        </div>
        <span className="text-[11px] text-fg-subtle">
          {railNames.length > 0 && `${railNames.join(' · ')}`}
          {s.latestAsOf && s.unreachable.length === 0 && ` · as of ${formatDateTime(s.latestAsOf)}`}
        </span>
      </div>

      {/* ---- hero: how much, and where ---- */}
      <div className="px-5 pt-2">
        <Headline rows={rows} s={s} railStatus={railStatus} currency={currency} />
      </div>

      {/* ---- whose it is: one bar that adds up to the headline ---- */}
      {m && s.railSum > 0 && (
        <div className="px-5 pt-4">
          <MoneyBar m={m} currency={currency} />
          <Legend m={m} currency={currency} sandbox={s.sandbox} />
        </div>
      )}

      {/* ---- do the books agree ---- */}
      <div className="mt-4 border-t border-line px-5 py-3.5">
        <BooksCheck m={m} s={s} rows={rows} balance={balance} currency={currency} />
      </div>

      {/* ---- in words ---- */}
      {m && (
        <div className="border-t border-line px-5 py-4">
          <PlainWords m={m} s={s} currency={currency} />
        </div>
      )}

      {/* ---- rail by rail, when there is more than one or one needs explaining ---- */}
      {(rows.length > 1 || s.unreachable.length > 0 || s.stale) && (
        <div className="border-t border-line px-5 pb-4 pt-3">
          <RailTable rows={rows} railLedger={railLedger} currency={currency} />
        </div>
      )}

      {/* ---- footer: what the rail lets you move, and what has been paid ---- */}
      {rows.length > 0 && (
        <div className="flex flex-wrap gap-x-7 gap-y-1.5 border-t border-line bg-surface-2/40 px-5 py-3 text-[13px] text-fg-muted">
          <MoveLine s={s} currency={currency} />
          <span>
            Paid to sellers so far:{' '}
            {balance ? (
              <>
                <b className="tabular font-mono font-semibold text-fg">{formatMoney(balance.paid_out, currency)}</b>
                {paidPayouts === null ? (
                  <span className="text-fg-subtle"> · counting payouts…</span>
                ) : paidPayouts.count > 0 ? (
                  <span className="text-fg-subtle">
                    {' '}
                    ({paidPayouts.count} {paidPayouts.count === 1 ? 'payout' : 'payouts'}, delivered)
                  </span>
                ) : null}
              </>
            ) : (
              <b className="tabular font-mono font-semibold text-fg">{formatMoney(0, currency)}</b>
            )}
          </span>
        </div>
      )}
    </Card>
  )
}

function Pill({ tone, children }: { tone: 'released' | 'danger' | 'pending'; children: ReactNode }) {
  const cls =
    tone === 'released'
      ? 'bg-released-soft text-released'
      : tone === 'danger'
        ? 'bg-danger-soft text-danger'
        : 'bg-pending-soft text-pending'
  return (
    <span className={cx('inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold', cls)}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />
      {children}
    </span>
  )
}

/**
 * THE HEADLINE — summed from every rail that answered. **A rail that did not
 * answer never renders as 0.00.** Fully unreachable renders as the word
 * itself; partially unreachable keeps the partial sum but says so, so the
 * total is never mistaken for the whole truth.
 */
function Headline({
  rows,
  s,
  railStatus,
  currency,
}: {
  rows: RailLiveBalance[]
  s: RailSummary
  railStatus: 'pending' | 'error' | 'success'
  currency: Currency
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
      <p className="text-2xl font-semibold text-danger" title="No rail holding this currency answered. This is not the same as a zero balance.">
        Unreachable
      </p>
    )
  }
  const named = s.reachable.map((r) => `${railLabel(r)} ${formatMoney(r.amount!, currency)}`)
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <span className="tabular font-mono text-[30px] font-semibold leading-none tracking-tight text-fg">
        {formatMoney(s.railSum, currency)}
      </span>
      <span className="text-[13px] text-fg-muted">
        {s.reachable.length === 1
          ? `at ${railLabel(s.reachable[0]!)}`
          : `across ${s.reachable.length} rails — ${named.join(' · ')}`}
      </span>
      {s.unreachable.length > 0 && (
        <span className="text-[11px] font-medium text-danger">
          {s.unreachable.length} of {rows.length} rails did not answer — this total understates the truth
        </span>
      )}
    </div>
  )
}

/**
 * One bar, four kinds of money, adding up to the headline. Segments carry a
 * 2px gap so adjacent fills never merge; "unexplained" is hatched as well as
 * coloured, so it reads without colour. A shortfall cannot be drawn — there is
 * no money there to draw — so the bar shows what is explained and the check
 * below says the rest.
 */
function MoneyBar({ m, currency }: { m: CurrencyMoney; currency: Currency }) {
  const segs: { key: string; cls: string; amount: Money; tip: string; hatched?: boolean }[] = [
    { key: 'buyers', cls: 'bg-money-buyers', amount: m.buyers, tip: "Buyers' money on open deals" },
    { key: 'sellers', cls: 'bg-money-sellers', amount: m.sellers, tip: 'Waiting to go to sellers' },
    { key: 'yours', cls: 'bg-money-yours', amount: m.fees + m.parked, tip: 'Yours' },
    {
      key: 'unexplained',
      cls: 'bg-money-unexplained',
      amount: Math.max(0, m.unexplained),
      tip: 'Not explained by any deal',
      hatched: true,
    },
  ].filter((x) => x.amount > 0)
  return (
    <div className="flex h-5 gap-0.5 overflow-hidden rounded bg-canvas" role="img" aria-label={segs.map((x) => `${x.tip}: ${formatMoney(x.amount, currency)}`).join('; ')}>
      {segs.map((x) => (
        <div
          key={x.key}
          className={cx('relative min-w-[3px]', x.cls)}
          style={{
            flex: x.amount,
            backgroundImage: x.hatched
              ? 'repeating-linear-gradient(135deg, var(--money-hatch) 0 3px, transparent 3px 8px)'
              : undefined,
          }}
          title={`${x.tip} · ${formatMoney(x.amount, currency)}`}
        />
      ))}
    </div>
  )
}

function Legend({ m, currency, sandbox }: { m: CurrencyMoney; currency: Currency; sandbox: boolean }) {
  const parkedAt = m.perRail.filter((r) => r.parked > 0)
  const unexplained = Math.max(0, m.unexplained)
  const row = (
    key: string,
    swatch: ReactNode,
    label: string,
    amount: Money,
    sub?: ReactNode,
  ) => (
    <li key={key} className="grid grid-cols-[12px_minmax(0,1fr)_auto] items-baseline gap-x-2.5">
      {swatch}
      <span className="text-[13px] text-fg">
        {label}
        {sub && <span className="block text-[11px] text-fg-subtle">{sub}</span>}
      </span>
      <span className={cx('tabular font-mono text-[13px]', amount === 0 ? 'font-medium text-fg-subtle' : 'font-semibold text-fg')}>
        {formatMoney(amount, currency)}
      </span>
    </li>
  )
  const sw = (cls: string, hatched?: boolean) => (
    <span
      className={cx('mt-0.5 h-3 w-3 rounded-[3px]', cls)}
      style={hatched ? { backgroundImage: 'repeating-linear-gradient(135deg, var(--money-hatch) 0 2px, transparent 2px 5px)' } : undefined}
      aria-hidden
    />
  )
  return (
    <ul className="mt-3 grid gap-x-8 gap-y-1.5 md:grid-cols-2">
      {row('buyers', sw('bg-money-buyers'), "Buyers' money, still on open deals", m.buyers,
        m.buyers > 0 ? 'held until both sides confirm — nobody has been paid from it yet' : undefined)}
      {row('sellers', sw('bg-money-sellers'), 'Waiting to go to sellers', m.sellers,
        m.reserved > 0 ? `including ${formatMoney(m.reserved, currency)} held back as a new-seller reserve` : undefined)}
      {row('yours', sw('bg-money-yours'), 'Yours', m.fees + m.parked,
        m.fees + m.parked > 0 ? (
          <>
            {m.fees > 0 && `${formatMoney(m.fees, currency)} your fees`}
            {m.fees > 0 && m.parked > 0 && ' · '}
            {m.parked > 0 &&
              `${formatMoney(m.parked, currency)} collected ${parkedAt.length === 1 ? `at ${parkedAt[0]!.label}` : 'here'} but the seller was paid from another rail`}
          </>
        ) : undefined)}
      {row('unexplained', sw('bg-money-unexplained', true), 'Not explained by any deal', unexplained,
        unexplained > 0
          ? sandbox
            ? 'an open case — in sandbox this is usually test float'
            : 'an open case for PayHold to check'
          : undefined)}
    </ul>
  )
}

function BooksCheck({
  m,
  s,
  rows,
  balance,
  currency,
}: {
  m: CurrencyMoney | null
  s: RailSummary
  rows: RailLiveBalance[]
  balance: Balance | null
  currency: Currency
}) {
  if (rows.length === 0) return null
  if (!balance) {
    return (
      <p className="text-xs text-fg-muted">
        <span className="font-semibold text-fg">No PayHold books in {currency}.</span> No deal has ever been
        booked in this currency, so everything above is the rail's own report and none of it is allocated to a
        buyer, a seller or to you.
      </p>
    )
  }
  if (!m) {
    return (
      <p className="text-xs text-fg-muted">
        {s.unreachable.length} of {rows.length} rail{rows.length > 1 ? 's' : ''} did not answer, so PayHold's
        books are not compared against the rail here — a gap against a figure nobody could ask for is not the
        books' to explain.
      </p>
    )
  }
  const owedTo = m.perRail.filter((r) => r.owed > 0)
  const diffCls = m.officialDiff === 0 ? 'text-released' : 'text-danger'
  const k = (t: string) => (
    <div className="text-[11px] font-semibold tracking-[0.06em] text-fg-subtle uppercase">{t}</div>
  )
  return (
    <div className="grid gap-x-6 gap-y-3 sm:grid-cols-3">
      <div>
        {k('Books say')}
        <div className="tabular mt-0.5 font-mono text-lg font-semibold text-fg">{formatMoney(m.booksSay, currency)}</div>
        {owedTo.length > 0 && (
          <div className="mt-0.5 text-[11px] text-fg-muted">
            = {formatMoney(m.buyers + m.sellers + m.fees + m.parked, currency)} at the rails −{' '}
            {owedTo.map((r) => `${formatMoney(r.owed, currency)} you owe ${r.label}`).join(' − ')}
          </div>
        )}
      </div>
      <div>
        {k(s.reachable.length === 1 ? `${railLabel(s.reachable[0]!)} holds` : 'The rails hold')}
        <div className="tabular mt-0.5 font-mono text-lg font-semibold text-fg">{formatMoney(s.railSum, currency)}</div>
      </div>
      <div>
        {k('Difference')}
        <div className={cx('tabular mt-0.5 font-mono text-lg font-semibold', diffCls)}>
          {m.officialDiff > 0 ? '+' : ''}
          {formatMoney(m.officialDiff, currency)}
        </div>
        <div className="mt-0.5 text-[11px] text-fg-muted">
          {m.officialDiff === 0
            ? `to the ${currency === 'JPY' ? 'yen' : 'penny'}`
            : m.perRail.length > 1
              ? m.perRail
                  .filter((r) => r.diff !== 0)
                  .map((r) => `${r.label} ${r.diff > 0 ? '+' : ''}${formatMoney(r.diff, currency)}`)
                  .join(' · ')
              : m.officialDiff > 0
                ? 'more at the rail than any deal explains'
                : 'less at the rail than the books say — payouts are frozen'}
        </div>
      </div>
    </div>
  )
}

/**
 * The card in sentences, built from the figures and nothing else. Every
 * sentence names a fact and, where there is one, the thing you can do about it.
 */
function PlainWords({ m, s, currency }: { m: CurrencyMoney; s: RailSummary; currency: Currency }) {
  const f = (x: Money) => formatMoney(x, currency)
  const means: ReactNode[] = []
  const todo: ReactNode[] = []

  if (m.buyers > 0) {
    means.push(
      `${f(m.buyers)} is buyers' money on open deals — held until both sides confirm. Your fee comes out when it's released, which is why "Yours" can be 0 while money is held.`,
    )
  }
  if (m.sellers > 0) {
    means.push(
      `${f(m.sellers)} has cleared and is waiting to go to sellers${m.reserved > 0 ? `, of which ${f(m.reserved)} is held back a little longer as a new-seller reserve` : ''}.`,
    )
  }
  if (m.fees > 0) {
    means.push(`You've earned ${f(m.fees)} in fees. It stays at the rail until you move it — PayHold never sweeps it.`)
  }
  for (const r of m.perRail.filter((x) => x.parked > 0)) {
    means.push(
      `${f(r.parked)} was collected at ${r.label} but the seller was paid from another rail, so it is still sitting at ${r.label} and it's yours.`,
    )
  }
  for (const r of m.perRail.filter((x) => x.owed > 0)) {
    means.push(`${r.label} is ${f(r.owed)} down: it paid sellers for money that was collected elsewhere.`)
  }
  if (m.unexplained > 0) {
    means.push(
      `${f(m.unexplained)} at the rail${m.perRail.length > 1 ? 's' : ''} is not explained by any deal.${
        s.sandbox ? " In sandbox that's usually the rail's test float." : ''
      } PayHold can't know why, so it opened a case.`,
    )
  }
  if (m.unexplained < 0) {
    means.push(
      `The rail${m.perRail.length > 1 ? 's hold' : ' holds'} ${f(-m.unexplained)} less than the books say ${m.perRail.length > 1 ? 'they' : 'it'} should. PayHold has frozen payouts until a person explains it.`,
    )
  }
  if (means.length === 0) means.push('Nothing is booked against this money yet.')

  // What to do, in the order it matters: money first, paperwork second.
  const owedTo = m.perRail.filter((r) => r.owed > 0)
  const parkedAt = m.perRail.filter((r) => r.parked > 0)
  if (owedTo.length > 0) {
    const totalOwed = owedTo.reduce((a, r) => a + r.owed, 0)
    const parkedTotal = parkedAt.reduce((a, r) => a + r.parked, 0)
    const from = parkedAt.length > 0 ? `from ${joinNames(parkedAt.map((r) => r.label))}` : 'from your bank'
    const to = joinNames(owedTo.map((r) => r.label))
    todo.push(
      <>
        Move <b className="tabular font-mono text-fg">{f(Math.min(totalOwed, parkedTotal) || totalOwed)}</b> {from} to {to}
        {parkedTotal > 0 && parkedTotal < totalOwed && (
          <>
            {' '}— that's your own money and it covers most of it; the remaining{' '}
            <b className="tabular font-mono text-fg">{f(totalOwed - parkedTotal)}</b> was collected in another currency
          </>
        )}
        . PayHold cannot move it for you.
      </>,
    )
  }
  if (m.unexplained < 0) {
    todo.push('Find out why the rail is short. Payouts stay frozen until a person resolves the case and lifts the freeze.')
  } else if (m.perRail.some((r) => r.diff !== 0)) {
    const n = m.perRail.filter((r) => r.diff !== 0).length
    todo.push(
      `Write up the ${n === 1 ? 'open case' : `${n} open cases`}${
        s.sandbox ? ' — say the unexplained money is sandbox float' : ''
      }. Cases don't close on their own; a person has to say why the number is what it is.`,
    )
  }
  const nothing = todo.length === 0

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div>
        <h3 className="text-[11px] font-semibold tracking-[0.06em] text-fg-subtle uppercase">What this means</h3>
        <div className="mt-1 max-w-[62ch] space-y-1.5 text-[13px] text-fg">
          {means.map((t, i) => (
            <p key={i}>{t}</p>
          ))}
        </div>
      </div>
      <div>
        <h3 className="text-[11px] font-semibold tracking-[0.06em] text-fg-subtle uppercase">What to do</h3>
        <div className="mt-1 max-w-[62ch] space-y-1.5 text-[13px] text-fg">
          {nothing ? (
            <p className="border-l-[3px] border-released pl-3">Nothing. The books agree with the rail.</p>
          ) : (
            todo.map((t, i) => (
              <p key={i} className="border-l-[3px] border-pending pl-3">
                {t}
              </p>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * Rail by rail. Reconciliation is per rail — you cannot ask two providers
 * about one number — so this is where the check is actually made, and a
 * currency on several rails is only "agrees" when every row here is.
 */
function RailTable({ rows, railLedger, currency }: { rows: RailLiveBalance[]; railLedger: RailBalance[]; currency: Currency }) {
  const th = 'pb-1.5 pr-3 text-left text-[11px] font-semibold tracking-[0.06em] text-fg-subtle uppercase'
  const td = 'border-t border-line py-2 pr-3 align-top text-[13px]'
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        <thead>
          <tr>
            <th className={th}>Rail</th>
            <th className={cx(th, 'text-right')}>Holds</th>
            <th className={cx(th, 'text-right')}>Books say</th>
            <th className={cx(th, 'text-right')}>Difference</th>
            <th className={th}>You can move today</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const label = railLabel(r)
            const unreachable = r.amount === null || r.error != null
            const l = railLedger.find((x) => x.provider === r.provider)
            const expected = l ? (ledgerExpected(l) ?? 0) : 0
            const diff = unreachable ? null : (r.amount as Money) - expected
            const schedule = describeScheduleRow(r)
            return (
              <tr key={r.provider}>
                <td className={cx(td, 'font-medium text-fg')}>
                  {label}
                  {r.mode === 'test' && <span className="ml-1.5 text-[11px] font-medium text-fg-subtle">sandbox</span>}
                  {r.stale && <span className="ml-1.5 text-[11px] font-medium text-pending">last known</span>}
                </td>
                {unreachable ? (
                  <td className={cx(td, 'text-danger')} colSpan={4}>
                    Could not be reached{r.error ? ` (${r.error})` : ''}. Not the same as a zero balance.
                  </td>
                ) : (
                  <>
                    <td className={cx(td, 'tabular text-right font-mono text-fg')}>{formatMoney(r.amount!, currency)}</td>
                    <td className={cx(td, 'tabular text-right font-mono text-fg')}>
                      {expected < 0 ? (
                        <>
                          {formatMoney(expected, currency)}
                          <span className="block font-sans text-[11px] text-fg-subtle">you owe it this for payouts it sent</span>
                        </>
                      ) : (
                        formatMoney(expected, currency)
                      )}
                    </td>
                    <td className={cx(td, 'tabular text-right font-mono font-semibold', diff === 0 ? 'text-released' : 'text-danger')}>
                      {diff! > 0 ? '+' : ''}
                      {formatMoney(diff!, currency)}
                    </td>
                    <td className={td}>
                      <span className="tabular font-mono text-fg">
                        {r.available === null ? notReported(label) : formatMoney(r.available, currency)}
                      </span>
                      <span className="block text-[11px] text-fg-subtle">
                        {r.pending === null
                          ? `${pendingTerm(r.provider)}: ${'not reported'}`
                          : `${formatMoney(r.pending, currency)} ${pendingTerm(r.provider)}`}
                        {schedule.kind === 'date' && ` — clears ${formatDateTime(schedule.date)}`}
                        {schedule.kind === 'none' && ' — moves on request'}
                      </span>
                    </td>
                  </>
                )}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/** What the rails let you move now, in their own words, summed but never blended. */
function MoveLine({ s, currency }: { s: RailSummary; currency: Currency }) {
  if (s.reachable.length === 0) return null
  const availMissing = s.reachable.filter((r) => r.available === null).map(railLabel)
  const pendingMissing = s.reachable.filter((r) => r.pending === null).map(railLabel)
  const dates = Array.from(
    new Set(s.reachable.map(describeScheduleRow).filter((k) => k.kind === 'date').map((k) => (k as { date: string }).date)),
  )
  return (
    <>
      <span>
        You can move{' '}
        {s.availKnown.length > 0 ? (
          <b className="tabular font-mono font-semibold text-fg">{formatMoney(s.availSum, currency)}</b>
        ) : (
          notReported(availMissing.join(', '))
        )}{' '}
        today
        {s.availKnown.length > 0 && (
          <span className="text-fg-subtle">
            {' — '}
            {Array.from(new Set(s.availKnown.map((r) => `${railLabel(r)}: ${availableTerm(r.provider)}`))).join(' · ')}
          </span>
        )}
        {s.availKnown.length > 0 && availMissing.length > 0 && <> ({notReported(availMissing.join(', '))})</>}
      </span>
      <span>
        {s.pendingKnown.length > 0 ? (
          <b className="tabular font-mono font-semibold text-fg">{formatMoney(s.pendingSum, currency)}</b>
        ) : (
          notReported(pendingMissing.join(', '))
        )}{' '}
        not yet
        {s.pendingKnown.length > 0 && (
          <>
            {' — '}
            {Array.from(new Set(s.pendingKnown.map((r) => `${railLabel(r)}: ${pendingTerm(r.provider)}`))).join(' · ')}
            {dates.length === 1 && `, clears ${formatDateTime(dates[0]!)}`}
          </>
        )}
      </span>
    </>
  )
}
