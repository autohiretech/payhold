/**
 * PayHold staff view. Deliberately separate from the tenant screens: this is
 * the only place where more than one tenant is visible at once, and the only
 * place a payout freeze can be lifted.
 */

import { useQuery } from '@tanstack/react-query'
import { api, type TenantStatus } from '@/api'
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Mono,
  PageHeader,
  Skeleton,
  Table,
  Td,
  Th,
} from '@/components/ui'
import { formatDate, formatDateTime, formatMoney, type StatusMeta } from '@/lib/format'
import { keys, useMoneyMutation } from '@/lib/queries'

const TENANT_STATUS_META: Record<TenantStatus, StatusMeta> = {
  active: { label: 'Active', tone: 'released', hint: 'Operating normally.' },
  suspended: { label: 'Suspended', tone: 'danger', hint: 'No API access.' },
  payouts_frozen: {
    label: 'Payouts frozen',
    tone: 'pending',
    hint: 'Under reconciliation review — no funds leave this account.',
  },
}

export function AdminPage() {
  const tenants = useQuery({
    queryKey: keys.tenants,
    queryFn: () => api.admin.listTenants(),
  })
  const alerts = useQuery({
    queryKey: keys.alerts,
    queryFn: () => api.admin.listReconciliationAlerts(),
  })

  const freeze = useMoneyMutation((id: string) => api.admin.freezePayouts(id))
  const unfreeze = useMoneyMutation((id: string) => api.admin.unfreezePayouts(id))

  const openAlerts = alerts.data?.filter((a) => !a.resolved_at) ?? []

  return (
    <>
      <PageHeader
        title="Master admin"
        subtitle="PayHold staff only. Every company on the platform, and anything that needs a human."
      />

      <Card className="mb-5">
        <CardHeader
          title="Reconciliation"
          subtitle="The cron job compares each account's ledger to the provider's real balance. Any drift freezes payouts."
        />
        {alerts.isPending ? (
          <div className="p-6">
            <Skeleton className="h-9" />
          </div>
        ) : !openAlerts.length ? (
          <EmptyState
            title="Everything reconciles"
            body="Every ledger matches its provider balance."
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Account</Th>
                <Th align="right">Ledger says</Th>
                <Th align="right">Provider says</Th>
                <Th align="right">Drift</Th>
                <Th align="right">Detected</Th>
              </tr>
            </thead>
            <tbody>
              {openAlerts.map((a) => {
                const tenant = tenants.data?.find((t) => t.id === a.tenant_id)
                return (
                  <tr key={a.id}>
                    <Td className="font-medium">{tenant?.name ?? a.tenant_id}</Td>
                    <Td align="right" className="tabular">
                      {formatMoney(a.ledger_balance, a.currency)}
                    </Td>
                    <Td align="right" className="tabular">
                      {formatMoney(a.provider_balance, a.currency)}
                    </Td>
                    <Td align="right" className="tabular font-semibold text-danger">
                      {a.drift > 0 ? '+' : ''}
                      {formatMoney(a.drift, a.currency)}
                    </Td>
                    <Td align="right" className="text-fg-muted">
                      {formatDateTime(a.detected_at)}
                    </Td>
                  </tr>
                )
              })}
            </tbody>
          </Table>
        )}
      </Card>

      <Card>
        <CardHeader title="Accounts" subtitle="Every tenant on the platform." />
        {tenants.isPending ? (
          <div className="space-y-2 p-6">
            {[0, 1].map((i) => (
              <Skeleton key={i} className="h-9" />
            ))}
          </div>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Slug</Th>
                <Th>Status</Th>
                <Th>Onboarded</Th>
                <Th align="right">Payouts</Th>
              </tr>
            </thead>
            <tbody>
              {tenants.data?.map((t) => (
                <tr key={t.id} className="hover:bg-surface-2">
                  <Td className="font-medium">{t.name}</Td>
                  <Td>
                    <Mono>{t.slug}</Mono>
                  </Td>
                  <Td>
                    <Badge meta={TENANT_STATUS_META[t.status]} />
                  </Td>
                  <Td className="text-fg-muted">{formatDate(t.created_at)}</Td>
                  <Td align="right">
                    {t.status === 'payouts_frozen' ? (
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={unfreeze.isPending}
                        onClick={() => unfreeze.mutate(t.id)}
                      >
                        Unfreeze
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        disabled={freeze.isPending}
                        onClick={() => freeze.mutate(t.id)}
                      >
                        Freeze
                      </Button>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <p className="mt-3 text-xs text-fg-muted">
        Unfreezing resolves the open reconciliation alerts for that account. Do it only
        once the drift is understood.
      </p>
    </>
  )
}
