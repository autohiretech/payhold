/**
 * The cron run log — what the five scheduled jobs write, and who may read it.
 *
 * pg_cron's own `job_run_details` proves a schedule fired; `cron_job_runs`
 * is the repository's record of what our code did with that fire. The table
 * itself is deliberately small and the assertions here are deliberately few:
 * the interesting behaviour is in the cron functions' wrappers (Deno-side,
 * tested by `test:functions`), and what the database has to stand behind is
 * that the shape holds and that nobody but the service role can see it.
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { migrated, rejects, type Harness } from './harness'

let h: Harness

beforeAll(async () => {
  h = await migrated()
}, 120_000)

afterAll(async () => {
  await h?.close()
})

describe('cron_job_runs', () => {
  test('a run starts running and finishes with its counters', async () => {
    const { rows } = await h.db.query<{ id: string }>(
      `insert into cron_job_runs (job) values ('reconcile') returning id`,
    )
    const runId = rows[0].id

    const open = await h.db.query<{ status: string; finished_at: string | null }>(
      `select status, finished_at from cron_job_runs where id = $1`,
      [runId],
    )
    expect(open.rows[0].status).toBe('running')
    expect(open.rows[0].finished_at).toBeNull()

    await h.db.query(
      `update cron_job_runs
          set status = 'completed',
              finished_at = now(),
              counters = '{"tenants": 3, "runs": 9, "checked": 9, "drifted": 0, "skipped": 0}'
        where id = $1`,
      [runId],
    )

    const closed = await h.db.query<{
      status: string
      finished_at: string | null
      counters: { tenants: number; checked: number } | null
    }>(
      `select status, finished_at, counters from cron_job_runs where id = $1`,
      [runId],
    )
    expect(closed.rows[0].status).toBe('completed')
    expect(closed.rows[0].finished_at).not.toBeNull()
    expect(closed.rows[0].counters).toMatchObject({ tenants: 3, checked: 9 })
  })

  test('a failed run records why, and only the five jobs exist', async () => {
    const { rows } = await h.db.query<{ id: string }>(
      `insert into cron_job_runs (job) values ('payout-dispatch') returning id`,
    )
    await h.db.query(
      `update cron_job_runs
          set status = 'failed',
              finished_at = now(),
              error = 'payout lookup failed: connection refused'
        where id = $1`,
      [rows[0].id],
    )

    const { rows: failed } = await h.db.query<{ error: string }>(
      `select error from cron_job_runs where id = $1`,
      [rows[0].id],
    )
    expect(failed[0].error).toContain('connection refused')

    await rejects(
      () => h.db.query(`insert into cron_job_runs (job) values ('backup')`),
      /cron_job_runs_job_check/,
    )
    await rejects(
      () => h.db.query(`insert into cron_job_runs (job, status) values ('reconcile', 'paused')`),
      /cron_job_runs_status_check/,
    )
  })

  test('a tenant cannot read the log at all', async () => {
    await h.db.query(`insert into cron_job_runs (job) values ('webhook-dispatch')`)

    // No RLS policy exists and no grant was issued — the table is service-role
    // only, so even the act of selecting is refused rather than silently empty.
    await rejects(
      () =>
        h.asUser('00000000-0000-0000-0000-000000000001', () =>
          h.db.query(`select id from cron_job_runs`),
        ),
      /permission denied/,
    )
  })

  test('the running rows are indexed for the stale-run sweep', async () => {
    const { rows } = await h.db.query<{ indexdef: string }>(
      `select indexdef from pg_indexes where tablename = 'cron_job_runs' order by indexname`,
    )
    const partial = rows.find((r) => r.indexdef.includes("status = 'running'"))
    expect(partial).toBeDefined()
    expect(partial?.indexdef).toContain('started_at')
  })
})
