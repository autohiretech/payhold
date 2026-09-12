import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { api, type Balance, type Currency } from '@/api'
import { BalancesTable, type CurrencyBalanceData } from '@/components/BalancesTable'
import {
  Badge,
  Card,
  CardHeader,
  EmptyState,
  ErrorNote,
  Mono,
  PageHeader,
  Skeleton,
  Table,
  Td,
  Th,
} from '@/components/ui'
import { DEAL_STATUS_META, formatMoney, formatRelative } from '@/lib/format'
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

  const railStatus: 'pending' | 'error' | 'success' = atRail.isPending
    ? 'pending'
    : atRail.isError
      ? 'error'
      : 'success'

  // One row's worth of everything the table needs: the ledger balance (or
  // `null` — most rail currencies have no ledger row at all), every `atRail`
  // entry naming this currency, and whether it belongs behind the
  // no-balance toggle. `isEmpty` only ever fires once the live call has
  // actually succeeded and every rail for this currency answered — a
  // currency is never filed as "no balance" on the strength of a call that
  // hasn't finished or failed, and a currency any rail failed to reach is
  // never filed there either: unreachable is not the same fact as zero.
  const balanceItems: CurrencyBalanceData[] = sortedCurrencies.map((currency) => {
    const rows = railRows.filter((r) => r.currency === currency)
    const anyUnreachable = rows.some((r) => r.amount === null || r.error)
    return {
      currency,
      balance: ledgerByCurrency.get(currency) ?? null,
      rows,
      isEmpty: railStatus === 'success' && activityWeight(currency) === 0 && !anyUnreachable,
    }
  })

  return (
    <>
      <PageHeader
        title="Overview"
        subtitle="Where every shilling currently sits, and what needs attention."
      />

      {/* Balances, one row per currency — a tenant can hold more than one,
          and a currency shows up here whether the ledger or a rail is the
          one that knows about it. */}
      {balance.isPending ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-32" />
          ))}
        </div>
      ) : (
        <div className="space-y-3">
          {atRail.isError && (
            <ErrorNote message="Could not check what the payment providers are actually holding right now. The figures below are PayHold's own ledger only." />
          )}

          {sortedCurrencies.length === 0 ? (
            <EmptyState
              title="No balance yet"
              body="Balances appear here once a deal funds or a connected rail reports money."
            />
          ) : (
            <BalancesTable
              items={balanceItems}
              serviceFeeRate={settings.data?.service_fee_rate}
              railStatus={railStatus}
            />
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

