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
  StatTile,
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

  return (
    <>
      <PageHeader
        title="Overview"
        subtitle="Where every shilling currently sits, and what needs attention."
      />

      {/* Balances, one row per currency — a tenant can hold more than one. */}
      {balance.isPending ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-32" />
          ))}
        </div>
      ) : (
        <div className="space-y-8">
          {atRail.isError && (
            <ErrorNote message="Could not check what the payment providers are actually holding right now. The figures above are PayHold's own ledger only." />
          )}

          {balance.data?.map((b) => (
            <section key={b.currency}>
              <h2 className="mb-3 flex items-center gap-2 text-xs font-semibold tracking-[0.06em] text-fg-muted uppercase">
                {b.currency} balance
                <span className="h-px flex-1 bg-line" />
              </h2>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <StatTile
                  label="Held"
                  tone="held"
                  value={formatMoneyShort(b.held, b.currency)}
                  hint="Buyer money in the vault against open deals"
                />
                <StatTile
                  label="Clearing"
                  tone="pending"
                  value={formatMoneyShort(b.pending_clearance, b.currency)}
                  hint="Released, waiting out the clearance window"
                />
                <StatTile
                  label="Available"
                  tone="released"
                  value={formatMoneyShort(b.available, b.currency)}
                  hint="Cleared and payable to sellers now"
                />
                <StatTile
                  label="Paid out"
                  value={formatMoneyShort(b.paid_out, b.currency)}
                  hint="Lifetime total sent to sellers"
                />
              </div>

              {/* Deliberately separate from the four tiles above, not a fifth
                  one in the same row: those are money moving toward a seller,
                  this is money that already stopped being theirs — the same
                  reason a seller's own wallet never shows fees_retained at
                  all. It is still sitting in the provider balance rather than
                  anywhere PayHold can pay it out to — there is no sweep, and
                  no button here changes that. */}
              <div className="mt-3 grid max-w-xl gap-3 sm:grid-cols-2">
                <StatTile
                  label="Your revenue"
                  tone="confirmed"
                  value={formatMoneyShort(b.fees_retained, b.currency)}
                  hint={
                    settings.data
                      ? `${formatPercent(settings.data.service_fee_rate)} service fee, plus any tax collected — still at the provider, not swept out anywhere`
                      : 'Service fee plus any tax collected — still at the provider, not swept out anywhere'
                  }
                />

                {/* Shown only when there is any, because most accounts never
                    have any: it appears when a deal is collected on one rail
                    and paid out on another, which leaves what the buyer paid
                    sitting where it was collected while the seller was paid
                    from a different balance.

                    **Both signs are meaningful and they are different jobs.**
                    Positive is money sitting in one of your balances that no
                    seller is owed — yours to sweep. Negative means you have
                    paid more out of that currency than you have funded it
                    with, which is the shortfall to cover before the next
                    payout in it fails. Labelling it one way would make the
                    other read as a bug. */}
                {b.tenant_funds !== 0 && (
                  <StatTile
                    label={b.tenant_funds > 0 ? 'Yours to move' : 'To top up'}
                    tone={b.tenant_funds > 0 ? undefined : 'held'}
                    value={formatMoneyShort(Math.abs(b.tenant_funds), b.currency)}
                    hint={
                      b.tenant_funds > 0
                        ? 'Collected here but paid out from another rail — no seller is owed it'
                        : 'Paid out of this currency beyond what you have funded it with'
                    }
                  />
                )}
              </div>

              {/* Not profit, and not the rail's cut — see `TakeBreakdown`'s
                  own header comment for why the rail's number cannot be
                  totalled here at all. */}
              <TakeBreakdown currency={b.currency} balance={b} />

              {/* What the rail itself says it holds right now, next to what
                  the ledger above expects it to hold. Loading and error are
                  scoped to this query alone — a live rail call can fail on
                  its own, and must never block or hide the ledger figures
                  above it. */}
              {atRail.isPending ? (
                <Skeleton className="mt-3 h-28 max-w-xl" />
              ) : (
                atRail.data && (
                  <RailReality
                    currency={b.currency}
                    rows={atRail.data.atRail}
                    ledgerExpected={
                      b.held +
                      b.pending_clearance +
                      b.available +
                      b.reserved +
                      b.fees_retained +
                      b.tenant_funds
                    }
                  />
                )
              )}
            </section>
          ))}
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

/**
 * What the rail itself says it holds for one currency, right now — summed
 * from `atRail` — next to `ledgerExpected`, which is exactly the six buckets
 * `reconcile` expects a provider to be holding for this currency: `held`,
 * `pending_clearance`, `available`, `reserved`, `fees_retained` and
 * `tenant_funds`. `paid_out` is excluded because that money has already left
 * this rail.
 *
 * **This never adjusts either figure.** A difference is rendered as a fact —
 * `diff` — and nothing here decides which side is right; that is what
 * reconciliation is for.
 *
 * **A rail that did not answer renders as "could not be reached", never as a
 * zero or a blank.** A zero balance and an unreachable rail are different
 * facts, and confusing them is the one thing this component exists to avoid.
 * When any provider for this currency is unreachable, the sum is shown as a
 * floor rather than a total, and no diff is claimed against it — a gap
 * against a figure nobody could ask the rail for is not the ledger's to
 * explain.
 */
function RailReality({
  currency,
  rows,
  ledgerExpected,
}: {
  currency: Currency
  rows: RailLiveBalance[]
  ledgerExpected: Money
}) {
  const mine = rows.filter((r) => r.currency === currency)
  if (mine.length === 0) return null

  const reachable = mine.filter((r) => r.amount !== null && !r.error)
  const unreachable = mine.filter((r) => r.amount === null || r.error)
  const stale = mine.some((r) => r.stale)
  // Sandbox money is not money. A rail connected in test mode answers with a
  // test balance, and putting that beside the ledger without a word is the one
  // way this card could mislead while every figure on it is exactly what the
  // provider reported.
  const sandbox = mine.some((r) => r.mode === 'test')
  const allUnreachable = unreachable.length === mine.length

  const railSum = reachable.reduce((sum, r) => sum + (r.amount ?? 0), 0)
  const latestAsOf = reachable.map((r) => r.as_of).sort().at(-1) ?? null
  const diff = unreachable.length === 0 ? railSum - ledgerExpected : null

  const tone: Tone = allUnreachable
    ? 'danger'
    : unreachable.length > 0
      ? 'pending'
      : diff !== 0
        ? 'danger'
        : 'released'

  return (
    <Card className="mt-3 max-w-xl p-5">
      <div className="flex flex-wrap items-center gap-2">
        <Dot tone={tone} />
        <span className="text-xs font-semibold tracking-[0.06em] text-fg-muted uppercase">
          At the rail
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
      </div>

      <div
        className={cx(
          'tabular mt-3 text-3xl leading-none font-semibold',
          allUnreachable ? 'text-danger' : 'text-fg',
        )}
      >
        {allUnreachable ? 'Unreachable' : formatMoneyShort(railSum, currency)}
      </div>

      <div className="mt-2.5 space-y-1.5 text-xs leading-relaxed text-fg-muted">
        {latestAsOf && (
          <div>
            as of {formatDateTime(latestAsOf)}
            {stale ? ' — last known, not a live call' : ''}
          </div>
        )}

        {mine.length > 1 &&
          mine.map((r) => (
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

        {mine.length === 1 && mine[0]?.error != null && (
          <div className="font-medium text-danger">{mine[0]?.error}</div>
        )}

        {unreachable.length > 0 && !allUnreachable && (
          <div>
            The total above only counts what answered — {unreachable.length} of{' '}
            {mine.length} rails did not, so it understates the true figure.
          </div>
        )}

        {diff !== null && (
          <div className={diff === 0 ? '' : 'font-semibold text-danger'}>
            {diff === 0
              ? 'Matches what the ledger expects the rail to hold.'
              : `${formatMoney(Math.abs(diff), currency)} ${
                  diff > 0 ? 'more' : 'less'
                } at the rail than the ledger expects — not corrected here.`}
          </div>
        )}
      </div>
    </Card>
  )
}

// ---------------------------------------------------------------------------

/**
 * §7's platform-fee-vs-rail-fee split, at the account level — the thing
 * "Your revenue" above cannot show on its own, because `fees_retained` is
 * PayHold's commission *and* any tax collected, added together, and it is
 * not profit.
 *
 * **The owner's actual profit is not a number this card can produce
 * honestly, and it does not try to.** Two of the five figures a full
 * breakdown needs are genuinely not available at this level:
 *
 * - `fees_retained` bundles the platform fee and tax with no per-currency
 *   read that splits them — only `deal_amounts()`, on one deal at a time,
 *   returns `platform_fee` and `tax` apart.
 * - The rail's own cut (`provider_fee` — Flutterwave's charged-minus-settled,
 *   Stripe's `balance_transaction.fee`, PayPal's `paypal_fee`) never reaches
 *   a retained bucket at all: §7's own table has it leaving the balance the
 *   instant the rail takes it, so there is no account-wide total of it to
 *   read here, correct or otherwise.
 *
 * Summing whatever deals happen to be on this page to fake one would be
 * exactly the failure this was built to stop: a number nobody asked the
 * provider to confirm, on the screen the owner asked for *because* PayHold's
 * own numbers keep getting shown as though a provider stood behind them. So
 * this card says what is true instead — what is shown, what is not, why, and
 * where the real, provider-sourced figure for one payment actually lives (a
 * deal's own Money card, which already labels exactly this split as
 * "PayHold fee" against "Rail fee").
 *
 * **Sellers' net is the one further figure safe to add**, and only because
 * it costs no new arithmetic: `held` is gross and `pending_clearance` /
 * `available` / `paid_out` are not — the fee (and, before that, the rail's
 * own cut) is already struck by the time money leaves `held` — so their sum
 * already *is* "what sellers are owed or have been paid, after every
 * deduction," using nothing but three fields this screen already fetched.
 */
function TakeBreakdown({ currency, balance }: { currency: Currency; balance: Balance }) {
  const sellersNet = balance.pending_clearance + balance.available + balance.paid_out

  return (
    <Card className="mt-3 max-w-xl p-5">
      <div className="flex flex-wrap items-center gap-2">
        <Dot tone="neutral" />
        <span className="text-xs font-semibold tracking-[0.06em] text-fg-muted uppercase">
          What this account kept — and what it did not
        </span>
      </div>

      <dl className="mt-3 space-y-3 text-sm">
        <TakeRow
          label="PayHold's own take"
          value={formatMoneyShort(balance.fees_retained, currency)}
          hint="PayHold's own number: our service fee plus any tax collected, bundled together — this API has no per-currency read that splits them apart. Still sitting at the provider; nothing sweeps it out."
        />
        <TakeRow
          label="What the rail kept"
          value="not shown here"
          faint
          hint="The rail's own number — Flutterwave's charged-minus-settled, Stripe's balance_transaction.fee, PayPal's paypal_fee — but it leaves this balance the instant the rail takes it, so there is no account-wide total to read. Open a deal's Money card for the figure on that one payment."
        />
        <TakeRow
          label="Sellers' net"
          value={formatMoneyShort(sellersNet, currency)}
          hint="Derived from the rows above, not a new figure: clearing, available and paid out, none of them gross. Every deduction — including the rail's own cut — is already out of these three."
        />
      </dl>

      <p className="mt-3 border-t border-line pt-2.5 text-xs leading-relaxed text-fg-muted">
        Not profit, and not netted against the rail's cut: the rail is paid
        out of the seller's pool, not this account's commission, so there is
        no single figure where the two offset.
      </p>
    </Card>
  )
}

function TakeRow({
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
    <div className="flex items-baseline justify-between gap-3 border-t border-line pt-2.5 first:border-0 first:pt-0">
      <dt className="max-w-56 text-fg-muted">
        {label}
        <span className="mt-1 block text-xs leading-relaxed text-fg-subtle">{hint}</span>
      </dt>
      <dd
        className={cx(
          'tabular shrink-0 text-right font-semibold',
          faint ? 'text-fg-subtle' : 'text-fg',
        )}
      >
        {value}
      </dd>
    </div>
  )
}
