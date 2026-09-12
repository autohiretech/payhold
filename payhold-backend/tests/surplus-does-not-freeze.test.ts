/**
 * A reconciliation SURPLUS raises a case but does not freeze payouts —
 * migration `20260912000007`.
 *
 * `record_reconciliation` computes `v_drift := p_provider_balance -
 * p_ledger_balance`. A **shortfall** (`v_drift < 0`) is the provider holding
 * less than the ledger expects — money missing — and that still freezes,
 * exactly as before this migration. A **surplus** (`v_drift > 0`) is the
 * provider holding *more* than the ledger expects. It cannot cause an
 * overpayment, so it opens the identical kind of case and leaves the tenant
 * `active`. Neither direction gets a free pass on sign-off: a case, surplus
 * or shortfall, still has to be closed by a named person before
 * `resolve_reconciliation_run` will lift anything, and nothing here adds a
 * timer that unfreezes on its own.
 */

import { beforeAll, afterAll, describe, expect, test } from 'vitest'
import { migrated, rejects, type Harness } from './harness'

let h: Harness

beforeAll(async () => {
  h = await migrated()
}, 120_000)

afterAll(async () => {
  await h?.close()
})

const newTenant = async (): Promise<string> => {
  const { rows: [t] } = await h.db.query<{ id: string }>(
    `insert into tenants (name, slug) values ('Acme', 'acme-' || gen_random_uuid())
     returning id`,
  )
  return t.id
}

const startRun = async (tenant: string, provider = 'flutterwave'): Promise<string> => {
  const { rows: [r] } = await h.db.query<{ id: string }>(
    `select id from start_reconciliation_run($1, $2::provider)`,
    [tenant, provider],
  )
  return r.id
}

/** The comparison the cron makes, with the run threaded through it. */
const record = (
  tenant: string,
  run: string | null,
  ledger: number,
  provider: number,
  currency = 'RWF',
  rail = 'flutterwave',
) =>
  h.db.query(
    `select record_reconciliation($1, $2::provider, $3::currency_code, $4, $5, $6)`,
    [tenant, rail, currency, ledger, provider, run],
  )

const tenantStatus = async (tenant: string): Promise<string> => {
  const { rows: [t] } = await h.db.query<{ status: string }>(
    `select status from tenants where id = $1`, [tenant],
  )
  return t.status
}

const openAlert = async (tenant: string) => {
  const { rows } = await h.db.query<{ drift: string; resolved_at: Date | null }>(
    `select drift, resolved_at from reconciliation_alerts
      where tenant_id = $1 and resolved_at is null`, [tenant],
  )
  return rows[0] ?? null
}

const lastMismatchAudit = async (tenant: string) => {
  const { rows: [row] } = await h.db.query<{ action: string; details: { action: string } }>(
    `select action, details from audit_log
      where tenant_id = $1 and action = 'reconciliation.mismatch'
      order by created_at desc limit 1`, [tenant],
  )
  return row
}

describe('a shortfall still freezes', () => {
  test('opens a case and sets status to payouts_frozen', async () => {
    const tenant = await newTenant()
    const run = await startRun(tenant)

    // ledger says 125,000 should be at the rail; the rail reports 100,000 —
    // 25,000 is missing.
    await record(tenant, run, 125_000, 100_000)
    await h.db.query(`select finish_reconciliation_run($1, 0)`, [run])

    const alert = await openAlert(tenant)
    expect(alert).not.toBeNull()
    expect(Number(alert!.drift)).toBe(-25_000)

    expect(await tenantStatus(tenant)).toBe('payouts_frozen')

    const audit = await lastMismatchAudit(tenant)
    expect(audit.details.action).toBe('payouts frozen')
  })
})

describe('a surplus raises a case and does not freeze', () => {
  test('opens a case and leaves status active', async () => {
    const tenant = await newTenant()
    const run = await startRun(tenant)

    // the rail reports 125,000 against a ledger of 100,000 — 25,000 more
    // than expected, unexplained but not a shortage.
    await record(tenant, run, 100_000, 125_000)
    await h.db.query(`select finish_reconciliation_run($1, 0)`, [run])

    const alert = await openAlert(tenant)
    expect(alert).not.toBeNull()
    expect(Number(alert!.drift)).toBe(25_000)

    expect(await tenantStatus(tenant)).toBe('active')

    const audit = await lastMismatchAudit(tenant)
    expect(audit.details.action).toBe('case raised, payouts not frozen')
  })

  test('a refreshed surplus on a later pass still does not freeze', async () => {
    const tenant = await newTenant()
    const run = await startRun(tenant)

    await record(tenant, run, 100_000, 125_000)
    await record(tenant, run, 100_000, 130_000)
    await h.db.query(`select finish_reconciliation_run($1, 0)`, [run])

    const { rows } = await h.db.query(
      `select 1 from reconciliation_alerts where tenant_id = $1 and resolved_at is null`,
      [tenant],
    )
    expect(rows).toHaveLength(1)
    expect(await tenantStatus(tenant)).toBe('active')
  })
})

describe('a later zero-drift pass resolves either case, and never flips status back', () => {
  test('a resolved shortfall stays frozen', async () => {
    const tenant = await newTenant()
    const run = await startRun(tenant)
    await record(tenant, run, 125_000, 100_000)
    await h.db.query(`select finish_reconciliation_run($1, 0)`, [run])
    expect(await tenantStatus(tenant)).toBe('payouts_frozen')

    // The books agree on the next pass.
    await record(tenant, null, 125_000, 125_000)

    expect(await openAlert(tenant)).toBeNull()
    // The alert closed itself; the freeze is still a person's decision.
    expect(await tenantStatus(tenant)).toBe('payouts_frozen')
  })

  test('a resolved surplus stays active', async () => {
    const tenant = await newTenant()
    const run = await startRun(tenant)
    await record(tenant, run, 100_000, 125_000)
    await h.db.query(`select finish_reconciliation_run($1, 0)`, [run])
    expect(await tenantStatus(tenant)).toBe('active')

    // The books agree on the next pass.
    await record(tenant, null, 100_000, 100_000)

    expect(await openAlert(tenant)).toBeNull()
    // Nothing here ever froze it, and resolving does not freeze it either.
    expect(await tenantStatus(tenant)).toBe('active')
  })
})

describe('resolve_reconciliation_run still refuses while a surplus case is open', () => {
  test('an unrelated open surplus case blocks sign-off, the same as a shortfall would', async () => {
    const tenant = await newTenant()
    const run = await startRun(tenant)
    await record(tenant, run, 100_000, 125_000)
    await h.db.query(`select finish_reconciliation_run($1, 0)`, [run])
    expect(await openAlert(tenant)).not.toBeNull()

    // A second rail nobody has looked at yet — its own surplus, still open.
    const stripeRun = await startRun(tenant, 'stripe')
    await record(tenant, stripeRun, 5_000, 5_500, 'USD', 'stripe')
    await h.db.query(`select finish_reconciliation_run($1, 0)`, [stripeRun])

    // Resolving `run` would close the case it raised, then try to lift the
    // freeze — and is refused, because the stripe case is still open. This
    // is `resolve_reconciliation_run`'s ordinary rule
    // (tests/reconciliation-runs.test.ts's "it cannot be lifted while
    // another case is still open"), and a surplus case counts exactly the
    // same as a shortfall's toward it — being unexplained is what blocks
    // sign-off, not whether it ever froze anything.
    await rejects(
      () =>
        h.db.query(
          `select resolve_reconciliation_run($1, 'grace@payhold.io', 'Explained', true)`,
          [run],
        ),
      /still open/,
    )

    // Neither surplus ever froze this tenant, and the refused sign-off did
    // not change that.
    expect(await tenantStatus(tenant)).toBe('active')
  })

  test('a plain resolve (no unfreeze) still succeeds, and does not need the other case closed', async () => {
    // The distinction the account holder drew for freezing carries over to
    // sign-off unchanged: resolving a run and declaring the money accounted
    // for are two different claims (`resolve_reconciliation_run`'s own
    // header). Recording that a surplus was explained does not require every
    // other open case, anywhere on the tenant, to be closed first — only
    // *lifting a freeze* does.
    const tenant = await newTenant()
    const run = await startRun(tenant)
    await record(tenant, run, 100_000, 125_000)
    await h.db.query(`select finish_reconciliation_run($1, 0)`, [run])

    const stripeRun = await startRun(tenant, 'stripe')
    await record(tenant, stripeRun, 5_000, 5_500, 'USD', 'stripe')
    await h.db.query(`select finish_reconciliation_run($1, 0)`, [stripeRun])

    await h.db.query(
      `select resolve_reconciliation_run($1, 'grace@payhold.io', 'Explained')`, [run],
    )

    const { rows: [r] } = await h.db.query<{ resolution: string }>(
      `select resolution::text from reconciliation_runs where id = $1`, [run],
    )
    expect(r.resolution).toBe('resolved')
    expect(await tenantStatus(tenant)).toBe('active')
  })
})
