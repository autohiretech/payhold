/**
 * Cron — the five scheduled jobs, their runs, and the work they leave behind.
 *
 * pg_cron in the database fires the schedules; each Edge Function records what
 * it did in `cron_job_runs`. That log is what this screen reads — pg_cron knows
 * a schedule fired, and these rows are what our code did with the fire.
 *
 * The per-job human work lives here too, because each job has exactly one kind
 * of thing a person can do about it: reconcile leaves drift to sign off in
 * Master admin, payout-dispatch leaves failed and blocked payouts to retry,
 * webhook-dispatch leaves exhausted deliveries to resend. auto-release and
 * settle-pending leave nothing to do from here — their failures surface as held
 * deals and `payment_pending` deals respectively.
 */

import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  api,
  PayHoldError,
  type AdminPayout,
  type AdminWebhookDelivery,
  type CronJobName,
  type CronRun,
} from '@/api'
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  ErrorNote,
  Mono,
  PageHeader,
  RestrictedState,
  Skeleton,
  Table,
  Td,
  Th,
  Tr,
  cx,
} from '@/components/ui'
import {
  DELIVERY_STATUS_META,
  PAYOUT_STATUS_META,
  formatDateTime,
  formatMoney,
  formatRelative,
  type StatusMeta,
} from '@/lib/format'
import { keys, useMoneyAction, useMoneyMutation } from '@/lib/queries'

const JOBS: { name: CronJobName | 'all'; label: string }[] = [
  { name: 'all', label: 'All' },
  { name: 'reconcile', label: 'Reconcile' },
  { name: 'auto-release', label: 'Auto-release' },
  { name: 'payout-dispatch', label: 'Payout dispatch' },
  { name: 'settle-pending', label: 'Settlement sweep' },
  { name: 'webhook-dispatch', label: 'Webhook dispatch' },
]

const JOB_META: Record<CronJobName, { label: string; schedule: string; does: string }> = {
  reconcile: {
    label: 'Reconcile',
    schedule: 'Hourly',
    does: 'Compares every ledger to its provider. Drift freezes payouts.',
  },
  'auto-release': {
    label: 'Auto-release',
    schedule: 'Every 10 min',
    does: 'Clears releases whose completion window has closed.',
  },
  'payout-dispatch': {
    label: 'Payout dispatch',
    schedule: 'Every 20 min',
    does: 'Sweeps the payout queue, retrying its own failures.',
  },
  'settle-pending': {
    label: 'Settlement sweep',
    schedule: 'Every 5 min',
    does: 'Re-checks payment_pending deals against the rails.',
  },
  'webhook-dispatch': {
    label: 'Webhook dispatch',
    schedule: 'Every minute',
    does: 'Delivers queued webhooks, retrying on a backoff.',
  },
}

const RUN_STATUS_META: Record<CronRun['status'], StatusMeta> = {
  running: {
    label: 'Running',
    tone: 'pending',
    hint: 'Still going — or a run that died before finishing. The next pass records it as failed.',
  },
  completed: {
    label: 'Completed',
    tone: 'released',
    hint: 'The pass finished and reported what it did.',
  },
  failed: {
    label: 'Failed',
    tone: 'danger',
    hint: 'It threw and recorded why.',
  },
}

function duration(started: string, finished: string | null): string {
  if (!finished) return '—'
  const seconds = Math.max(0, Math.round((new Date(finished).getTime() - new Date(started).getTime()) / 1000))
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

function Counters({ counters }: { counters: CronRun['counters'] }) {
  if (!counters) return <span className="text-fg-muted">No counters</span>
  return (
    <span className="flex flex-wrap gap-1">
      {Object.entries(counters).map(([key, value]) => (
        <span
          key={key}
          className="rounded-full bg-surface-2 px-2 py-0.5 text-xs font-medium text-fg-muted ring-1 ring-line ring-inset"
        >
          {key} <span className="tabular text-fg">{value}</span>
        </span>
      ))}
    </span>
  )
}

export function CronPage() {
  const [job, setJob] = useState<CronJobName | 'all'>('all')
  const now = new Date()

  const runs = useQuery({
    queryKey: keys.cronRuns(job === 'all' ? undefined : { job }),
    queryFn: () => api.admin.listCronRuns(job === 'all' ? undefined : { job }),
  })
  const tenants = useQuery({
    queryKey: keys.tenants,
    queryFn: () => api.admin.listTenants(),
  })
  const payouts = useQuery({
    queryKey: keys.adminPayouts('failed,blocked'),
    queryFn: () => api.admin.listAdminPayouts('failed,blocked'),
  })
  const deliveries = useQuery({
    queryKey: keys.adminWebhookDeliveries('failed'),
    queryFn: () => api.admin.listAdminWebhookDeliveries('failed'),
  })

  const reconcile = useMoneyAction(() => api.admin.runReconciliation())
  const retryPayout = useMoneyMutation((id: string) => api.admin.retryAdminPayout(id))
  const retryDelivery = useMoneyMutation((id: string) =>
    api.admin.retryAdminWebhookDelivery(id),
  )

  const tenantName = (id: string) => tenants.data?.find((t) => t.id === id)?.name ?? id
  const showReconcile = job === 'all' || job === 'reconcile'
  const showPayouts = job === 'all' || job === 'payout-dispatch'
  const showDeliveries = job === 'all' || job === 'webhook-dispatch'

  const failure = reconcile.error ?? retryPayout.error ?? retryDelivery.error

  // `platformAdminFromJwt` 404s every one of these calls identically for a
  // signed-in tenant session — the same response an operator would get for a
  // resource that genuinely does not exist. Without this check that reads as
  // "Never" and "No runs yet" on every card below: an empty, healthy log
  // rather than a page this account was never going to be able to see.
  const restricted = tenants.error instanceof PayHoldError && tenants.error.code === 'not_found'

  return (
    <>
      <PageHeader
        title="Cron"
        subtitle="The five scheduled jobs, what each pass did, and the payouts and webhooks a person still has to see to."
      />

      {restricted ? (
        <Card>
          <RestrictedState
            title="PayHold staff only"
            body="Cron is scoped to platform_admins, a separate axis from your role on this tenant — signing in as an owner, staff member or viewer here does not carry it. Ask someone with platform-admin access if you need this page."
          />
        </Card>
      ) : (
      <>
      <Card className="mb-5">
        <CardHeader
          title="Schedules"
          subtitle="Schedules live in the database's pg_cron; this screen reads what the jobs recorded."
        />
        <Table>
          <thead>
            <tr>
              <Th>Job</Th>
              <Th>Schedule</Th>
              <Th>What it does</Th>
              <Th align="right">Last pass</Th>
            </tr>
          </thead>
          <tbody>
            {(Object.keys(JOB_META) as CronJobName[]).map((name) => {
              const last = runs.data?.find((r) => r.job === name)
              return (
                <tr key={name}>
                  <Td className="font-medium">
                    <button
                      onClick={() => setJob(name)}
                      className="text-left underline-offset-2 hover:underline"
                    >
                      {JOB_META[name].label}
                    </button>
                  </Td>
                  <Td className="text-fg-muted">{JOB_META[name].schedule}</Td>
                  <Td className="text-fg-muted">{JOB_META[name].does}</Td>
                  <Td align="right">
                    {last ? (
                      <span className="inline-flex items-center gap-2">
                        <Badge meta={RUN_STATUS_META[last.status]} />
                        <span className="text-fg-muted">
                          {formatDateTime(last.started_at)}
                        </span>
                      </span>
                    ) : (
                      <span className="text-fg-muted">Never</span>
                    )}
                  </Td>
                </tr>
              )
            })}
          </tbody>
        </Table>
      </Card>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {JOBS.map((j) => (
          <button
            key={j.label}
            onClick={() => setJob(j.name)}
            className={cx(
              'rounded-full px-3.5 py-1.5 text-sm font-semibold transition',
              j.name === job
                ? 'bg-brand text-brand-fg shadow-[var(--shadow-card)]'
                : 'bg-surface text-fg-muted ring-1 ring-line ring-inset hover:bg-surface-2 hover:text-fg',
            )}
          >
            {j.label}
          </button>
        ))}
      </div>

      <Card>
        <CardHeader
          title="Runs"
          subtitle="Newest first. A run's counters say what the pass covered — the reconcile pass counts tenants and rails, the dispatchers count outcomes."
        />
        {runs.isPending ? (
          <div className="space-y-2 p-6">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-9" />
            ))}
          </div>
        ) : !runs.data?.length ? (
          <EmptyState
            title="No runs yet"
            body="Nothing in the log for this filter. The first scheduled pass will land here."
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Job</Th>
                <Th>Started</Th>
                <Th align="right">Took</Th>
                <Th>Status</Th>
                <Th>Counters</Th>
              </tr>
            </thead>
            <tbody>
              {runs.data.map((r) => (
                <Tr key={r.id}>
                  <Td className="font-medium">{JOB_META[r.job]?.label}</Td>
                  <Td className="text-fg-muted">
                    {formatDateTime(r.started_at)}
                    <span className="text-fg-subtle"> · {formatRelative(r.started_at, now)}</span>
                  </Td>
                  <Td align="right" className="text-fg-muted tabular">
                    {duration(r.started_at, r.finished_at)}
                  </Td>
                  <Td>
                    <Badge meta={RUN_STATUS_META[r.status]} />
                    {r.error && (
                      <div className="mt-1 text-xs text-danger">{r.error}</div>
                    )}
                  </Td>
                  <Td>
                    <Counters counters={r.counters} />
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {showReconcile && (
        <Card className="mt-5">
          <CardHeader
            title="Reconciliation sign-off"
            subtitle="A completed reconcile run froze payouts wherever it found drift. Signing a run off — and lifting the freeze — is Master admin's job, because it is a judgement, not a fix."
            action={
              <Link to="/admin">
                <Button size="sm" variant="secondary">
                  Master admin
                </Button>
              </Link>
            }
          />
          <div className="p-4">
            <Button
              size="sm"
              disabled={reconcile.isPending}
              onClick={() => reconcile.mutate()}
            >
              {reconcile.isPending ? 'Checking…' : 'Run now'}
            </Button>
          </div>
        </Card>
      )}

      {showPayouts && (
        <Card className="mt-5">
          <CardHeader
            title="Failed payouts"
            subtitle="The dispatch job re-arms its own attempts; these are the ones it gave up on, or blocked for want of an eligible route. Retry is idempotent — it puts the payout back on the clock and tries again."
          />
          {payouts.isPending ? (
            <div className="space-y-2 p-6">
              <Skeleton className="h-9" />
            </div>
          ) : !payouts.data?.length ? (
            <EmptyState
              title="Nothing needs a person"
              body="No failed or blocked payouts right now."
            />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Tenant</Th>
                  <Th>Deal</Th>
                  <Th align="right">Amount</Th>
                  <Th>Status</Th>
                  <Th align="right">Attempts</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {payouts.data.map((p) => (
                  <PayoutRow
                    key={p.id}
                    payout={p}
                    tenantName={tenantName(p.tenant_id)}
                    retrying={retryPayout.isPending}
                    onRetry={() => retryPayout.mutate(p.id)}
                  />
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      )}

      {showDeliveries && (
        <Card className="mt-5">
          <CardHeader
            title="Exhausted webhooks"
            subtitle="Five attempts, no success. The dispatch job moves on; sending one again is a person's call once the endpoint is back."
          />
          {deliveries.isPending ? (
            <div className="space-y-2 p-6">
              <Skeleton className="h-9" />
            </div>
          ) : !deliveries.data?.length ? (
            <EmptyState
              title="Every endpoint is answering"
              body="No delivery has exhausted its attempts."
            />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Tenant</Th>
                  <Th>Event</Th>
                  <Th>Deal</Th>
                  <Th align="right">Attempts</Th>
                  <Th>Last response</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {deliveries.data.map((d) => (
                  <DeliveryRow
                    key={d.id}
                    delivery={d}
                    tenantName={tenantName(d.tenant_id)}
                    retrying={retryDelivery.isPending}
                    onRetry={() => retryDelivery.mutate(d.id)}
                  />
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      )}

      {failure && <ErrorNote message={failure.message} />}
      </>
      )}
    </>
  )
}

function PayoutRow({
  payout,
  tenantName,
  retrying,
  onRetry,
}: {
  payout: AdminPayout
  tenantName: string
  retrying: boolean
  onRetry: () => void
}) {
  return (
    <Tr>
      <Td className="font-medium">{tenantName}</Td>
      <Td className="text-fg-muted">
        <Mono>{payout.deal_id.slice(0, 8)}</Mono>
      </Td>
      <Td align="right" className="tabular font-semibold">
        {formatMoney(payout.amount, payout.currency)}
      </Td>
      <Td>
        <Badge meta={PAYOUT_STATUS_META[payout.status]} />
        {payout.failure_reason && (
          <div className="mt-1 text-xs text-danger">{payout.failure_reason}</div>
        )}
      </Td>
      <Td align="right" className="text-fg-muted tabular">
        {payout.attempts}
      </Td>
      <Td align="right">
        <Button size="sm" variant="secondary" disabled={retrying} onClick={onRetry}>
          Retry
        </Button>
      </Td>
    </Tr>
  )
}

function DeliveryRow({
  delivery,
  tenantName,
  retrying,
  onRetry,
}: {
  delivery: AdminWebhookDelivery
  tenantName: string
  retrying: boolean
  onRetry: () => void
}) {
  return (
    <Tr>
      <Td className="font-medium">{tenantName}</Td>
      <Td className="text-fg-muted">
        <Mono>{delivery.event}</Mono>
      </Td>
      <Td className="text-fg-muted">
        {delivery.deal_id ? <Mono>{delivery.deal_id.slice(0, 8)}</Mono> : '—'}
      </Td>
      <Td align="right" className="text-fg-muted tabular">
        {delivery.attempts}
      </Td>
      <Td className="text-fg-muted">
        <span className="flex items-center gap-2">
          <Badge meta={DELIVERY_STATUS_META[delivery.status]} />
          <span>
            {delivery.error ??
              (delivery.status_code ? `HTTP ${delivery.status_code}` : '—')}
          </span>
        </span>
      </Td>
      <Td align="right">
        <Button size="sm" variant="secondary" disabled={retrying} onClick={onRetry}>
          Resend
        </Button>
      </Td>
    </Tr>
  )
}
