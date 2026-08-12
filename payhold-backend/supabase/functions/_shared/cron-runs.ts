/**
 * The run log every scheduled job writes — `cron_job_runs`.
 *
 * A job starts by asking for a run id, does its work, and ends by marking the
 * run finished: `completed` with the counters it returned, or `failed` with
 * the error that stopped it. That gives the Admin console a uniform answer to
 * "what is each cron doing" — the schedule's own record (pg_cron's
 * `job_run_details`) only proves the timer fired, not what our code did with
 * the fire.
 *
 * The row is written through the same service client the job works with, so it
 * is only as good as that connection. Recording a run is never allowed to take
 * the job down with it: a job that did not run is worse news than a log that
 * missed a row, so both helpers swallow and log their own failures.
 */

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'

/** The five scheduled jobs. Mirrors the `job` check on `cron_job_runs`. */
export type CronJobName =
  | 'reconcile'
  | 'auto-release'
  | 'payout-dispatch'
  | 'settle-pending'
  | 'webhook-dispatch'

export type CronRunStatus = 'running' | 'completed' | 'failed'

/**
 * A run open longer than this is dead. No job legitimately runs for two hours,
 * and `startCronRun` closes any such row as failed, so a process that vanished
 * mid-pass cannot leave a phantom "still running" row behind — and the next
 * run's start is the moment that is recorded, not the crash.
 */
const STALE_AFTER_MS = 2 * 60 * 60 * 1_000

/** Open the next run for a job, closing any predecessor that clearly died. */
export async function startCronRun(
  db: SupabaseClient,
  job: CronJobName,
): Promise<string | null> {
  try {
    await db
      .from('cron_job_runs')
      .update({
        status: 'failed',
        finished_at: new Date().toISOString(),
        error: 'Run was interrupted and never finished.',
      })
      .eq('job', job)
      .eq('status', 'running')
      .lt('started_at', new Date(Date.now() - STALE_AFTER_MS).toISOString())

    const { data, error } = await db
      .from('cron_job_runs')
      .insert({ job })
      .select('id')
      .single()

    if (error) throw error
    return (data as { id: string }).id
  } catch (err) {
    console.error('cron run log start failed', {
      job,
      message: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

/**
 * Mark a run finished. `null` run id means the start was never recorded —
 * then there is nothing to finish, and that is fine.
 */
export async function finishCronRun(
  db: SupabaseClient,
  runId: string | null,
  status: CronRunStatus,
  counters?: Record<string, number>,
  error?: string,
): Promise<void> {
  if (!runId) return

  const patch: Record<string, unknown> = {
    status,
    finished_at: new Date().toISOString(),
  }
  if (counters !== undefined) patch.counters = counters
  if (error !== undefined) patch.error = error

  try {
    const { error: err } = await db
      .from('cron_job_runs')
      .update(patch)
      .eq('id', runId)
    if (err) throw err
  } catch (err) {
    console.error('cron run log finish failed', {
      run_id: runId,
      message: err instanceof Error ? err.message : String(err),
    })
  }
}
