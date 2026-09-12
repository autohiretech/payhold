import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { api, type Balance, type Currency, type Money, type RailLiveBalance } from '@/api'
import {
  Badge,
  Card,
  CardHeader,
  cx,
  Dot,
  EmptyState,
  ErrorNote,
  Mono,
  PageHeader,
  Skeleton,
  Table,
  Td,
  Th,
} from '@/components/ui'
import {
  DEAL_STATUS_META,
  formatDateTime,
  formatMoney,
  formatMoneyShort,
  formatPercent,
  formatRelative,
  type Tone,
} from '@/lib/format'
import { PROVIDER_LABEL } from '@/lib/rails'
import {
  useBalance,
  useDeals,
  useDisputes,
  usePayouts,
  useSettings,
} from '@/lib/queries'

export function OverviewPage() {
  const balance = useBalance()
  const deals = useDeals({ limit: 8 })
  const payouts = usePayouts()
  const disputes = useDisputes()
  const settings = useSettings()

  // What each rail itself says it is holding right now, alongside the
  // ledger's own derived figures above. A separate query and a separate
  // loading/error state from `balance` on purpose: the ledger figures are the
  // product's own arithmetic and always answerable; a live call to a payment
  // rail is a network hop that can fail on its own, and one must not block
  // or hide the other.
  const atRail = useQuery({
    queryKey: ['balance', 'live'],
    queryFn: () => api.getBalanceWithRail(),
  })

  const now = new Date()
  const openDisputes = disputes.data?.filter((d) => d.status === 'open') ?? []
  const failedPayouts = payouts.data?.filter((p) => p.status === 'failed') ?? []

  const ledgerBalances = balance.data ?? []
  const ledgerByCurrency = new Map<Currency, Balance>(
    ledgerBalances.map((b) => [b.currency, b]),
  )
  const railRows = atRail.data?.atRail ?? []

  /**
   * The currency list is the union of PayHold's own ledger and whatever each
   * connected rail actually reports holding — not the ledger alone.
   *
   * A currency can have money at a rail with no ledger rows at all: sandbox
   * top-ups, an account funded before its first sale, a rail balance nobody
   * has made a deal against yet. `GET /balance?live=1`'s `atRail` reports one
   * of those for every currency the rail itself returns from
   * `provider.balances()` — see `payhold-backend/supabase/functions/balance
   * /index.ts` — so a currency missing from `balance.data` is not a currency
   * with nothing in it, only one the ledger has never had reason to book.
   * Driving this loop off `balance.data` alone, as it used to, made that
   * money invisible: no ledger row meant no key to `.map` over and no
   * section rendered, however much a rail actually held.
   *
   * Before `atRail` resolves there is no rail-currency list yet, so the union
   * falls back to the ledger alone for that one render; the rail-only
   * currencies appear as soon as the live call lands.
   */
  const currencies = atRail.isSuccess
    ? Array.from(
        new Set<Currency>([...ledgerByCurrency.keys(), ...railRows.map((r) => r.currency)]),
      )
    : Array.from(ledgerByCurrency.keys())

  function activityWeight(currency: Currency): number {
    const b = ledgerByCurrency.get(currency)
    const ledgerTotal = b
      ? b.held +
        b.pending_clearance +
        b.available +
        b.reserved +
        b.fees_retained +
        b.tenant_funds +
        b.paid_out
      : 0
    const railTotal = railRows
      .filter((r) => r.currency === currency)
      .reduce((sum, r) => sum + Math.abs(r.amount ?? 0), 0)
    return Math.abs(ledgerTotal) + railTotal
  }

  // Currencies with real money in them — in the ledger, at a rail, or both —
  // lead; anything sitting at exactly zero everywhere sinks to the bottom
  // rather than pushing the account's actual balances below the fold.
  const sortedCurrencies = [...currencies].sort(
    (a, b) => activityWeight(b) - activityWeight(a) || a.localeCompare(b),
  )

  return (
    <>
      <PageHeader
        title="Overview"
        subtitle="Where every shilling currently sits, and what needs attention."
      />

      {/* Balances, one section per currency — a tenant can hold more than
          one, and a currency shows up here whether the ledger or a rail is
          the one that knows about it. */}
      {balance.isPending ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-32" />
          ))}
        </div>
      ) : (
        <div className="space-y-8">
          {atRail.isError && (
            <ErrorNote message="Could not check what the payment providers are actually holding right now. The figures below are PayHold's own ledger only." />
          )}

          {sortedCurrencies.length === 0 ? (
            <EmptyState
              title="No balance yet"
              body="Balances appear here once a deal funds or a connected rail reports money."
            />
          ) : (
            sortedCurrencies.map((currency) => (
              <CurrencySection
                key={currency}
                currency={currency}
                balance={ledgerByCurrency.get(currency) ?? null}
                railRows={railRows}
                railPending={atRail.isPending}
                serviceFeeRate={settings.data?.service_fee_rate}
              />
            ))
          )}
        </div>
      )}

      {(openDisputes.length > 0 || failedPayouts.length > 0) && (
        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          {openDisputes.length > 0 && (
            <AttentionCard
              to="/disputes"
              tone="danger"
              title={`${openDisputes.length} open dispute${openDisputes.length > 1 ? 's' : ''}`}
              body="Funds are held and both release and refund are blocked until resolved."
            />
          )}
          {failedPayouts.length > 0 && (
            <AttentionCard
              to="/payouts"
              tone="danger"
              title={`${failedPayouts.length} failed payout${failedPayouts.length > 1 ? 's' : ''}`}
              body="The provider rejected these transfers. Fix the destination and retry."
            />
          )}
        </div>
      )}

      <Card className="mt-8">
        <CardHeader
          title="Recent deals"
          subtitle="The eight most recent, newest first."
          action={
            <Link
              to="/deals"
              className="rounded-lg px-2.5 py-1.5 text-sm font-semibold text-brand transition hover:bg-brand-soft"
            >
              View all →
            </Link>
          }
        />
        {deals.isPending ? (
          <div className="space-y-2 p-6">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-9" />
            ))}
          </div>
        ) : !deals.data?.length ? (
          <EmptyState
            title="No deals yet"
            body="Deals appear here as soon as a client site creates one through the API."
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Deal</Th>
                <Th>Status</Th>
                <Th align="right">Amount</Th>
                <Th align="right">Created</Th>
              </tr>
            </thead>
            <tbody>
              {deals.data.map((deal) => (
                <tr key={deal.id} className="hover:bg-surface-2">
                  <Td>
                    <Link to={`/deals/${deal.id}`} className="block hover:underline">
                      <span className="font-medium">{deal.description}</span>
                      <br />
                      <Mono>{deal.id}</Mono>
                    </Link>
                  </Td>
                  <Td>
                    <Badge meta={DEAL_STATUS_META[deal.status]} />
                  </Td>
                  <Td align="right" className="tabular font-medium">
                    {formatMoney(deal.amount, deal.currency)}
                  </Td>
                  <Td align="right" className="text-fg-muted">
                    {formatRelative(deal.created_at, now)}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  )
}

function AttentionCard({
  to,
  title,
  body,
}: {
  to: string
  tone: 'danger' | 'pending'
  title: string
  body: string
}) {
  return (
    <Link to={to} className="group block">
      <Card className="flex items-start gap-3.5 border-danger/20 bg-danger-soft p-5 transition group-hover:shadow-[var(--shadow-lift)]">
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-danger/12 text-danger">
          <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 8v5M12 16.5v.01" strokeLinecap="round" />
          </svg>
        </span>
        <span className="min-w-0">
          <span className="block text-sm font-semibold text-danger">{title}</span>
          <span className="mt-1 block text-sm leading-relaxed text-fg-muted">{body}</span>
        </span>
      </Card>
    </Link>
  )
}

// ---------------------------------------------------------------------------

/**
 * One currency, top to bottom: the rail's own headline figure and split
 * (`RailCard` — never PayHold's own arithmetic), then, only when PayHold
 * actually has a ledger balance in this currency, its own bookkeeping over
 * it (`LedgerFigures`) — secondary and compact.
 *
 * A currency reaches this component because the ledger has rows for it, a
 * rail reports holding it, or both; `balance` is `null` in the second case
 * rather than a fabricated zero `Balance`, and nothing below ever treats
 * `null` as zero. `RailCard` alone is what tells that story on the page: it
 * still renders the rail's figure and split, and says in plain text that
 * PayHold has no ledger balance to allocate it against — see its own header
 * comment.
 */
function CurrencySection({
  currency,
  balance,
  railRows,
  railPending,
  serviceFeeRate,
}: {
  currency: Currency
  balance: Balance | null
  railRows: RailLiveBalance[]
  railPending: boolean
  serviceFeeRate: number | undefined
}) {
  const mine = railRows.filter((r) => r.currency === currency)
  const ledgerExpected = balance
    ? balance.held +
      balance.pending_clearance +
      balance.available +
      balance.reserved +
      balance.fees_retained +
      balance.tenant_funds
    : null

  return (
    <section>
      <h2 className="mb-3 flex items-center gap-2 text-xs font-semibold tracking-[0.06em] text-fg-muted uppercase">
        {currency}
        <span className="h-px flex-1 bg-line" />
      </h2>

      {railPending ? (
        <div className="max-w-xl space-y-3">
          <Skeleton className="h-36" />
        </div>
      ) : (
        <RailCard currency={currency} rows={mine} ledgerExpected={ledgerExpected} />
      )}

      {balance && (
        <LedgerFigures currency={currency} balance={balance} serviceFeeRate={serviceFeeRate} />
      )}
    </section>
  )
}

/**
 * THE HEADLINE for one currency: what the rail itself says it holds right
 * now — summed from `atRail` — with the split it reports directly beneath.
 * This used to be two stacked cards, each carrying a paragraph of prose
 * under every line. The paragraphs are gone from the page, not from the
 * product: every one of them survives, either as a `title` tooltip on the
 * label it belongs to (the same mechanism `Badge`'s hint already uses) or,
 * where the fact is tied to a literal number the reader needs without
 * hovering — stale, unreachable, a diff against the ledger, no ledger row at
 * all — as one visible short line instead of a card of paragraphs.
 *
 * `ledgerExpected` is what `reconcile` expects a provider to be holding for
 * this currency — `held + pending_clearance + available + reserved +
 * fees_retained + tenant_funds` (`paid_out` excluded: that money already
 * left this rail) — or `null` when PayHold has no ledger balance in this
 * currency at all. `null` is not the same fact as a diff of zero: it means
 * there is nothing on the other side to compare against, so no comparison is
 * offered, and the card says so instead of a diff line.
 *
 * **This never adjusts either figure.** A difference renders as a fact and
 * nothing here decides which side is right — that is reconciliation's job.
 *
 * **A rail that did not answer renders as "could not be reached", never a
 * zero or a blank**, and no diff is claimed while any rail for this currency
 * is unreachable — a gap against a figure nobody could ask the rail for is
 * not the ledger's to explain.
 *
 * **Per-rail splits are never blended.** More than one rail backing a
 * currency gets its own row and its own three figures below; they clear on
 * their own schedules, and averaging a same-day mobile-money settlement with
 * a multi-day card settlement would describe a schedule nobody is on.
 *
 * **A field the split doesn't have renders as "not reported by <rail>",
 * never as zero and never computed** — see `notReported`.
 */
function RailCard({
  currency,
  rows,
  ledgerExpected,
}: {
  currency: Currency
  rows: RailLiveBalance[]
  ledgerExpected: Money | null
}) {
  const mine = rows.filter((r) => r.currency === currency)
  if (mine.length === 0) return null

  const reachable = mine.filter((r) => r.amount !== null && !r.error)
  const unreachable = mine.filter((r) => r.amount === null || r.error)
  const stale = mine.some((r) => r.stale)
  // Sandbox money is not money. A rail connected in test mode answers with a
  // test balance, and putting that beside the ledger without a word is the
  // one way this card could mislead while every figure on it is exactly what
  // the provider reported.
  const sandbox = mine.some((r) => r.mode === 'test')
  const allUnreachable = unreachable.length === mine.length

  const railSum = reachable.reduce((sum, r) => sum + (r.amount ?? 0), 0)
  const latestAsOf = reachable.map((r) => r.as_of).sort().at(-1) ?? null
  const diff =
    unreachable.length === 0 && ledgerExpected !== null ? railSum - ledgerExpected : null

  const tone: Tone = allUnreachable
    ? 'danger'
    : unreachable.length > 0
      ? 'pending'
      : diff !== null && diff !== 0
        ? 'danger'
        : 'released'

  return (
    <Card className="max-w-xl p-5">
      <div className="flex flex-wrap items-center gap-2">
        <Dot tone={tone} />
        <span className="text-xs font-semibold tracking-[0.06em] text-fg-muted uppercase">
          What the rail reports
        </span>
        {sandbox && (
          <Badge
            meta={{
              label: 'Sandbox',
              tone: 'pending',
              hint: 'This rail is connected in test mode, so the figure is its sandbox balance — not real money.',
            }}
          />
        )}
        {stale && (
          <Badge
            meta={{
              label: 'Stale',
              tone: 'pending',
              hint: 'The last stored reconciliation figure, not a call made just now.',
            }}
          />
        )}
        {allUnreachable && (
          <Badge
            meta={{
              label: 'Unreachable',
              tone: 'danger',
              hint: 'The rail did not answer. This is not the same as a zero balance.',
            }}
          />
        )}
        {ledgerExpected === null && (
          <Badge
            meta={{
              label: 'No PayHold ledger',
              tone: 'neutral',
              hint: 'PayHold has no deals or ledger entries in this currency. This figure and split are the rail’s own report, with nothing booked here to allocate it against.',
            }}
          />
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span
          className={cx(
            'tabular text-3xl leading-none font-semibold',
            allUnreachable ? 'text-danger' : 'text-fg',
          )}
        >
          {allUnreachable ? 'Unreachable' : formatMoneyShort(railSum, currency)}
        </span>
        {!allUnreachable && (
          <span className="text-xs text-fg-muted">
            {reachable.length === 1
              ? `Reported by ${PROVIDER_LABEL[reachable[0]!.provider] ?? reachable[0]!.provider}`
              : `Reported by ${reachable.length} rails`}
            {latestAsOf ? ` · as of ${formatDateTime(latestAsOf)}` : ''}
            {stale ? ' (last known)' : ''}
          </span>
        )}
      </div>

      {mine.length > 1 && (
        <div className="mt-2 space-y-0.5 text-xs text-fg-muted">
          {mine.map((r) => (
            <div key={r.provider}>
              {PROVIDER_LABEL[r.provider] ?? r.provider}:{' '}
              {r.amount === null || r.error ? (
                <span className="font-medium text-danger">
                  could not be reached{r.error ? ` (${r.error})` : ''}
                </span>
              ) : (
                formatMoney(r.amount, r.currency)
              )}
            </div>
          ))}
        </div>
      )}

      {mine.length === 1 && mine[0]?.error != null && (
        <div className="mt-2 text-xs font-medium text-danger">{mine[0]?.error}</div>
      )}

      {unreachable.length > 0 && !allUnreachable && (
        <div className="mt-2 text-xs text-fg-subtle">
          Total only counts what answered — {unreachable.length} of {mine.length} rails did not,
          so it understates the true figure.
        </div>
      )}

      {ledgerExpected === null ? (
        <p className="mt-3 text-xs font-medium text-fg-muted">
          PayHold holds no ledger balance in this currency — this is the rail's own figure only.
        </p>
      ) : (
        diff !== null && (
          <div className={cx('mt-3 text-xs', diff === 0 ? 'text-fg-muted' : 'font-semibold text-danger')}>
            {diff === 0
              ? "Matches PayHold's own books below."
              : `${formatMoney(Math.abs(diff), currency)} ${
                  diff > 0 ? 'more here than' : 'less here than'
                } PayHold's books below account for — not corrected here.`}
          </div>
        )
      )}

      <div className="mt-4 space-y-3 border-t border-line pt-3">
        {mine.map((r, i) => (
          <RailSplitRow
            key={r.provider}
            rail={PROVIDER_LABEL[r.provider] ?? r.provider}
            showLabel={mine.length > 1}
            row={r}
            bordered={i > 0}
          />
        ))}
      </div>
    </Card>
  )
}

/**
 * One rail's own clearing split, compact: how much of what it holds can move
 * right now, how much it is still holding back, and — where it says so —
 * when the held part frees up.
 *
 * **This is the rail's split, not PayHold's.** `available`/`pending` here
 * have nothing to do with `Balance.available`/`pending_clearance` in
 * `LedgerFigures`: those are PayHold's own allocation of the money by deal;
 * these three fields are one number the provider itself reports, unrelated
 * to which deal any of it belongs to.
 */
function RailSplitRow({
  rail,
  showLabel,
  row,
  bordered,
}: {
  rail: string
  showLabel: boolean
  row: RailLiveBalance
  bordered: boolean
}) {
  const unreachable = row.amount === null || row.error != null

  return (
    <div className={bordered ? 'border-t border-line pt-3' : ''}>
      {showLabel && (
        <div className="mb-1.5 text-xs font-semibold tracking-[0.04em] text-fg-muted">{rail}</div>
      )}

      {unreachable ? (
        <p className="text-xs font-medium text-danger">
          Could not be reached{row.error ? ` (${row.error})` : ''} — no split to show.
        </p>
      ) : (
        <div className="grid grid-cols-3 gap-3">
          <MiniFigure
            label="Available now"
            value={row.available === null ? notReported(rail) : formatMoney(row.available, row.currency)}
            hint={`What ${rail} itself says can be paid out today.`}
          />
          <MiniFigure
            label="Still clearing"
            value={row.pending === null ? notReported(rail) : formatMoney(row.pending, row.currency)}
            hint={`What ${rail} is holding back from the figure above.`}
            faint={row.pending === null}
          />
          <MiniFigure
            // "Expected", not "Frees up". No rail states a clearing date on
            // its balance response: this is today plus the account's own
            // payout delay, which Stripe reports and the others do not. It
            // is the rail's own number applied to the clock, not a date the
            // rail committed to.
            label="Expected to clear"
            value={row.available_on ? formatDateTime(row.available_on) : notReported(rail)}
            hint="When the clearing amount above becomes available, exactly as the rail itself reports it — never a computed estimate."
            faint={!row.available_on}
          />
        </div>
      )}
    </div>
  )
}

/** Null, rendered as the fact it is — never a zero and never a guess. */
function notReported(rail: string): ReactNode {
  return <span className="font-normal text-fg-subtle">not reported by {rail}</span>
}

/**
 * PayHold's own bookkeeping for one currency: who the money the rail card
 * above reports is held for, cleared for, and already paid to, plus what
 * this account has taken and what the rail took that never shows up here.
 * Secondary and compact on purpose — the rail's figure above is the answer
 * to "how much money do I have"; this answers "who is it owed to", which no
 * provider can, but no provider ever stood behind these figures either, and
 * that is why this no longer leads the screen.
 *
 * Folds together what used to be three stacked cards (the four ledger
 * buckets, "your revenue"/"yours to move" tiles, and a separate take
 * breakdown) into one compact row of figures. Nothing here is a new number:
 * `fees_retained` was shown twice before, under two labels ("Your revenue"
 * and "PayHold's own take") that said the same thing with different words —
 * they are one figure now, and every caveat either label carried is folded
 * into its tooltip.
 *
 * **The owner's actual profit is not a number this card produces, and it
 * does not try to.** Two of the five figures a full breakdown needs are
 * genuinely not available at this level: `fees_retained` bundles the
 * platform fee and tax with no per-currency read that splits them apart, and
 * the rail's own cut (Flutterwave's charged-minus-settled, Stripe's
 * `balance_transaction.fee`, PayPal's `paypal_fee`) leaves this balance the
 * instant the rail takes it, so there is no account-wide total of it to read
 * here at all — only on a deal's own Money card, one payment at a time.
 *
 * **Sellers' net is the one further figure safe to add**, and only because
 * it costs no new arithmetic: `pending_clearance` / `available` / `paid_out`
 * are already net of every deduction, the fee (and, before that, the rail's
 * own cut) having already been struck by the time money leaves `held`.
 */
function LedgerFigures({
  currency,
  balance,
  serviceFeeRate,
}: {
  currency: Currency
  balance: Balance
  serviceFeeRate: number | undefined
}) {
  const sellersNet = balance.pending_clearance + balance.available + balance.paid_out

  return (
    <Card className="mt-3 max-w-xl p-5">
      <div className="flex flex-wrap items-center gap-2">
        <Dot tone="neutral" />
        <span className="text-xs font-semibold tracking-[0.06em] text-fg-muted uppercase">
          PayHold's own books
        </span>
      </div>

      <div className="mt-3 flex flex-wrap gap-x-6 gap-y-3">
        <MiniFigure
          label="Held"
          value={formatMoneyShort(balance.held, currency)}
          hint="Buyer money in the vault against open deals."
        />
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
        <MiniFigure
          label="Paid out"
          value={formatMoneyShort(balance.paid_out, currency)}
          hint="Lifetime total sent to sellers."
        />
        <MiniFigure
          label="Your revenue"
          value={formatMoneyShort(balance.fees_retained, currency)}
          hint={`${
            serviceFeeRate !== undefined
              ? `${formatPercent(serviceFeeRate)} service fee, plus any tax collected`
              : 'Service fee plus any tax collected'
          }, bundled together — no per-currency read splits them apart. Still at the provider, not swept out anywhere. Not profit, and not netted against the rail’s own cut: the rail is paid from the seller’s pool, not this commission, so there is no single figure where the two offset.`}
        />
        {/* Shown only when there is any, because most accounts never have
            any: it appears when a deal is collected on one rail and paid out
            on another, which leaves what the buyer paid sitting where it was
            collected while the seller was paid from a different balance.
            Both signs are meaningful and they are different jobs, which is
            why the hint below is not the same sentence with the sign
            flipped. */}
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
          hint="The rail's own number — Flutterwave's charged-minus-settled, Stripe's balance_transaction.fee, PayPal's paypal_fee — but it leaves this balance the instant the rail takes it, so there is no account-wide total to read. Open a deal's Money card for the figure on that one payment."
          faint
        />
        <MiniFigure
          label="Sellers' net"
          value={formatMoneyShort(sellersNet, currency)}
          hint="Clearing + available + paid out, none of them gross — every deduction, including the rail's own cut, is already out of these three."
        />
      </div>
    </Card>
  )
}

/**
 * A compact label/value pair. The label carries its full explanation as a
 * native `title` tooltip — the same mechanism `Badge` already uses for its
 * hint — so the figure reads in one glance and the caveat survives for
 * whoever hovers the label.
 */
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
