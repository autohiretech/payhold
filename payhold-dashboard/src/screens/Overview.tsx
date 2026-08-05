import { Link } from 'react-router-dom'
import {
  Badge,
  Card,
  CardHeader,
  EmptyState,
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
  formatMoney,
  formatMoneyShort,
  formatRelative,
} from '@/lib/format'
import { simNow, useBalance, useDeals, useDisputes, usePayouts } from '@/lib/queries'

export function OverviewPage() {
  const balance = useBalance()
  const deals = useDeals({ limit: 8 })
  const payouts = usePayouts()
  const disputes = useDisputes()

  const now = simNow()
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
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
      ) : (
        <div className="space-y-6">
          {balance.data?.map((b) => (
            <section key={b.currency}>
              <h2 className="mb-2 text-xs font-medium tracking-wide text-fg-muted uppercase">
                {b.currency} balance
              </h2>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
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
            </section>
          ))}
        </div>
      )}

      {(openDisputes.length > 0 || failedPayouts.length > 0) && (
        <div className="mt-6 grid gap-3 sm:grid-cols-2">
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

      <Card className="mt-6">
        <CardHeader
          title="Recent deals"
          action={
            <Link to="/deals" className="text-sm font-medium text-brand hover:underline">
              View all
            </Link>
          }
        />
        {deals.isPending ? (
          <div className="space-y-2 p-5">
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
    <Link to={to} className="block">
      <Card className="border-danger/25 bg-danger-soft p-4 transition hover:brightness-[0.98]">
        <p className="text-sm font-semibold text-danger">{title}</p>
        <p className="mt-1 text-sm text-fg-muted">{body}</p>
      </Card>
    </Link>
  )
}
