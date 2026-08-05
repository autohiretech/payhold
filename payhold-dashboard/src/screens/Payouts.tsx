import { Link } from 'react-router-dom'
import { api } from '@/api'
import {
  Badge,
  Button,
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
import { PAYOUT_STATUS_META, formatMoney, formatRelative } from '@/lib/format'
import {
  simNow,
  useMoneyMutation,
  usePayouts,
  useSellers,
  useSettings,
  useTenant,
} from '@/lib/queries'

export function PayoutsPage() {
  const payouts = usePayouts()
  const sellers = useSellers()
  const settings = useSettings()
  const tenant = useTenant()
  const now = simNow()

  const retry = useMoneyMutation((id: string) => api.retryPayout(id))

  const sellerFor = (id: string) => sellers.data?.find((s) => s.id === id)

  return (
    <>
      <PageHeader
        title="Payouts"
        subtitle={
          settings.data
            ? `Funds are payable ${settings.data.clearance_days} days after release.`
            : undefined
        }
      />

      {tenant.data?.status === 'payouts_frozen' && (
        <div className="mb-4">
          <ErrorNote message="Payouts are frozen for this account pending a reconciliation review. Scheduled transfers will not send." />
        </div>
      )}

      {retry.isError && (
        <div className="mb-4">
          <ErrorNote message={retry.error.message} />
        </div>
      )}

      <Card>
        <CardHeader
          title="All payouts"
          subtitle="One per released deal. Dispatched automatically when the clearance window closes."
        />
        {payouts.isPending ? (
          <div className="space-y-2 p-5">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-9" />
            ))}
          </div>
        ) : !payouts.data?.length ? (
          <EmptyState
            title="No payouts yet"
            body="A payout is queued as soon as a deal releases."
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Seller</Th>
                <Th>Destination</Th>
                <Th>Deal</Th>
                <Th>Status</Th>
                <Th align="right">Amount</Th>
                <Th align="right">Due</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {payouts.data.map((p) => {
                const seller = sellerFor(p.seller_id)
                return (
                  <tr key={p.id} className="hover:bg-surface-2">
                    <Td className="font-medium">{seller?.name ?? p.seller_id}</Td>
                    <Td className="text-fg-muted">
                      {seller?.masked_destination ?? '—'}
                    </Td>
                    <Td>
                      <Link to={`/deals/${p.deal_id}`} className="hover:underline">
                        <Mono>{p.deal_id}</Mono>
                      </Link>
                    </Td>
                    <Td>
                      <Badge meta={PAYOUT_STATUS_META[p.status]} />
                      {p.failure_reason && (
                        <p className="mt-1 max-w-56 text-xs text-danger">
                          {p.failure_reason}
                        </p>
                      )}
                    </Td>
                    <Td align="right" className="tabular font-medium">
                      {formatMoney(p.amount, p.currency)}
                    </Td>
                    <Td align="right" className="text-fg-muted">
                      {p.paid_at
                        ? formatRelative(p.paid_at, now)
                        : formatRelative(p.scheduled_for, now)}
                    </Td>
                    <Td align="right">
                      {(p.status === 'failed' || p.status === 'frozen') && (
                        <Button
                          size="sm"
                          disabled={retry.isPending}
                          onClick={() => retry.mutate(p.id)}
                        >
                          Retry
                        </Button>
                      )}
                    </Td>
                  </tr>
                )
              })}
            </tbody>
          </Table>
        )}
      </Card>

      <p className="mt-3 text-xs text-fg-muted">
        Attempts are recorded per payout. A failed transfer never silently
        disappears — it stays here until it succeeds or is cancelled.
      </p>
    </>
  )
}
