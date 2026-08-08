/**
 * PayHold staff view. Deliberately separate from the tenant screens: this is
 * the only place where more than one tenant is visible at once, and the only
 * place a payout freeze can be lifted.
 */

import { Fragment, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type ReconciliationRun, type Tenant, type TenantStatus } from '@/api'
import { useAuth } from '@/auth/AuthProvider'
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  ErrorNote,
  Field,
  Mono,
  PageHeader,
  Skeleton,
  Table,
  Td,
  Textarea,
  Th,
  Tr,
} from '@/components/ui'
import { formatDate, formatDateTime, formatMoney, type StatusMeta } from '@/lib/format'
import { PROVIDER_LABEL } from '@/lib/rails'
import { keys, useMoneyAction, useMoneyMutation } from '@/lib/queries'

const TENANT_STATUS_META: Record<TenantStatus, StatusMeta> = {
  active: { label: 'Active', tone: 'released', hint: 'Operating normally.' },
  suspended: { label: 'Suspended', tone: 'danger', hint: 'No API access.' },
  payouts_frozen: {
    label: 'Payouts frozen',
    tone: 'pending',
    hint: 'Under reconciliation review — no funds leave this account.',
  },
}

const RUN_STATUS_META: Record<ReconciliationRun['status'], StatusMeta> = {
  running: {
    label: 'Running',
    tone: 'pending',
    hint: 'The pass is still going. A pass that dies leaves this open and the next one records it as failed.',
  },
  completed: {
    label: 'Completed',
    tone: 'released',
    hint: 'The pass finished and wrote what it found.',
  },
  failed: {
    label: 'Failed',
    tone: 'danger',
    hint: 'It did not finish. A failed pass is not a clean one — nothing was proven.',
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
  const runs = useQuery({
    queryKey: keys.reconciliationRuns,
    queryFn: () => api.admin.listReconciliationRuns(),
  })

  const freeze = useMoneyMutation((id: string) => api.admin.freezePayouts(id))
  const unfreeze = useMoneyMutation((id: string) => api.admin.unfreezePayouts(id))
  const reconcile = useMoneyAction(() => api.admin.runReconciliation())

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
          action={
            <Button
              size="sm"
              disabled={reconcile.isPending}
              onClick={() => reconcile.mutate()}
            >
              {reconcile.isPending ? 'Checking…' : 'Run now'}
            </Button>
          }
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
                <Th>Rail</Th>
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
                    {/* Per rail, not per currency — you cannot ask two
                        providers about one number. */}
                    <Td className="text-fg-muted">
                      {PROVIDER_LABEL[a.provider]} · {a.currency}
                    </Td>
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

      <RunsCard runs={runs} tenants={tenants.data} />

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

      {/* The button above is the blunt instrument and says so. §13 put the
          recorded path on the pass itself: a name, a note, and a refusal while
          any other case on that tenant is still open. This one asks for none of
          that, which is why it is described rather than recommended. */}
      <p className="mt-3 text-xs text-fg-muted">
        Freezing and unfreezing here closes an account's open cases without recording who
        decided or why. Prefer signing off the pass that raised the drift — that is the
        one path that leaves an answer to “who said this was accounted for”.
      </p>
    </>
  )
}

/**
 * §13's record of the passes themselves.
 *
 * The alerts table above says what is wrong *now* and structurally cannot say
 * that we looked — a nightly control nobody can prove ran is not a control. So
 * every pass writes a row per tenant per rail, and this is where somebody reads
 * it. Per rail rather than per pass because you cannot ask two providers about
 * one number.
 *
 * Four counters, and `skipped` is the one that catches people out: a rail with
 * no external figure was not checked, so a pass with skips is `incomplete`
 * rather than clean. A week of provider outages must not read as a week of
 * clean books.
 */
function RunsCard({
  runs,
  tenants,
}: {
  runs: ReturnType<typeof useQuery<ReconciliationRun[]>>
  tenants: Tenant[] | undefined
}) {
  const [signing, setSigning] = useState<string | null>(null)

  return (
    <Card className="mb-5">
      <CardHeader
        title="Passes"
        subtitle="Every reconciliation pass, one row per account per rail. What we checked, over what window, and what we could not prove."
      />

      {runs.isPending ? (
        <div className="p-6">
          <Skeleton className="h-9" />
        </div>
      ) : !runs.data?.length ? (
        <EmptyState
          title="No passes recorded"
          body="The nightly job writes one row per account per rail. Nothing has run yet."
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Account</Th>
              <Th>Rail</Th>
              <Th>Window</Th>
              <Th align="right">Matched</Th>
              <Th align="right">Drift</Th>
              <Th align="right">Not checked</Th>
              <Th align="right">Unposted</Th>
              <Th>Status</Th>
              <Th align="right">Signed off</Th>
            </tr>
          </thead>
          <tbody>
            {runs.data.map((run) => {
              const tenant = tenants?.find((t) => t.id === run.tenant_id)
              return (
                <Fragment key={run.id}>
                  <Tr>
                    <Td className="font-medium">{tenant?.name ?? run.tenant_id}</Td>
                    <Td className="text-fg-muted">{PROVIDER_LABEL[run.provider]}</Td>
                    <Td className="text-fg-muted">
                      {formatDate(run.period_start)} → {formatDate(run.period_end)}
                    </Td>
                    <Td align="right" className="tabular">
                      {run.matched}
                    </Td>
                    <Td
                      align="right"
                      className={
                        run.mismatched
                          ? 'tabular font-semibold text-danger'
                          : 'tabular text-fg-muted'
                      }
                    >
                      {run.mismatched}
                    </Td>
                    {/* Skipped and missing are separate questions: one rail we
                        could not reach, one set of events the provider told us
                        about and the ledger never posted. */}
                    <Td align="right" className="tabular text-fg-muted">
                      {run.skipped}
                    </Td>
                    <Td
                      align="right"
                      className={
                        run.missing
                          ? 'tabular font-semibold text-danger'
                          : 'tabular text-fg-muted'
                      }
                    >
                      {run.missing}
                    </Td>
                    <Td>
                      <Badge meta={RUN_STATUS_META[run.status]} />
                    </Td>
                    <Td align="right">
                      {run.resolved_at ? (
                        <span
                          className="text-xs text-fg-muted"
                          title={run.resolution_note ?? undefined}
                        >
                          {run.resolution} · {run.resolved_by}
                        </span>
                      ) : run.status === 'completed' ? (
                        <Button
                          size="sm"
                          onClick={() => setSigning(signing === run.id ? null : run.id)}
                        >
                          {signing === run.id ? 'Cancel' : 'Sign off'}
                        </Button>
                      ) : (
                        <span className="text-xs text-fg-subtle">
                          {run.error ?? '—'}
                        </span>
                      )}
                    </Td>
                  </Tr>
                  {signing === run.id && (
                    <tr>
                      <Td className="bg-surface-2" />
                      <td className="border-b border-line bg-surface-2 px-6 py-4" colSpan={8}>
                        <SignOff run={run} onDone={() => setSigning(null)} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </Table>
      )}
    </Card>
  )
}

/**
 * Signing a pass off, and — separately — lifting the freeze it caused.
 *
 * They are two arguments because they are two claims. Writing down what
 * happened is one thing; declaring the money accounted for is another, and an
 * operator has to be able to make the first without making the second. Nothing
 * lifts a freeze on a timer: the numbers agreeing again is not the same as
 * somebody having understood why they did not.
 */
function SignOff({ run, onDone }: { run: ReconciliationRun; onDone: () => void }) {
  const { account } = useAuth()
  const actor = account?.full_name ?? account?.email ?? ''

  const [note, setNote] = useState('')
  const [unfreeze, setUnfreeze] = useState(false)

  const resolve = useMoneyAction(async () => {
    const result = await api.admin.resolveReconciliationRun(run.id, actor, note, unfreeze)
    onDone()
    return result
  })

  return (
    <div className="space-y-3">
      <Field
        label="What happened"
        hint="The explanation, not the outcome. This is what the next person reads when they ask why the books disagreed."
      >
        <Textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Provider settled a batch after the window closed; the entries posted the next morning…"
        />
      </Field>

      <label className="flex items-start gap-2 text-sm text-fg">
        <input
          type="checkbox"
          checked={unfreeze}
          onChange={(e) => setUnfreeze(e.target.checked)}
          className="mt-0.5 size-4 rounded border-line-strong"
        />
        <span>
          Also lift this account's payout freeze.
          <span className="block text-xs text-fg-muted">
            A separate claim: that the money is accounted for, not just that the pass was
            read. Refused while any other case on this account is still open.
          </span>
        </span>
      </label>

      <div className="flex items-center gap-3">
        <Button
          variant="primary"
          size="sm"
          disabled={!note || !actor || resolve.isPending}
          onClick={() => resolve.mutate()}
        >
          {resolve.isPending ? 'Recording…' : 'Record it'}
        </Button>
        <span className="text-xs text-fg-muted">
          Recorded against {actor || 'nobody — you are not signed in'}.
        </span>
      </div>

      {resolve.isError && <ErrorNote message={resolve.error.message} />}
    </div>
  )
}
