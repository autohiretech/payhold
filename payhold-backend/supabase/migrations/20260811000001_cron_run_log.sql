-- ---------------------------------------------------------------------------
-- The cron run log — what every scheduled job did, and when
-- ---------------------------------------------------------------------------
--
-- The five scheduled jobs (`reconcile`, `auto-release`, `payout-dispatch`,
-- `settle-pending`, `webhook-dispatch`) each write a row here as they run:
-- one at the start, one update when they finish, carrying the counters they
-- returned and the error when they did not finish.
--
-- pg_cron's own `cron.job_run_details` is the platform's record that a
-- schedule fired; this is the repository's record of what *our* code did with
-- that fire, and it is what the Admin console reads. The distinction is the
-- one `reconciliation_runs` draws against `reconciliation_alerts`: the alerts
-- say what is wrong now, a run says we looked.
--
-- Only the service role may touch it. The cron functions and the admin
-- console both run as `service_role` (which bypasses RLS), and there is no
-- policy for anyone else, so a tenant — and an anon caller — sees zero rows.

create table cron_job_runs (
  id          uuid primary key default gen_random_uuid(),
  job         text not null
              check (job in (
                'reconcile',
                'auto-release',
                'payout-dispatch',
                'settle-pending',
                'webhook-dispatch'
              )),
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  status      text not null default 'running'
              check (status in ('running', 'completed', 'failed')),
  counters    jsonb,
  error       text
);

-- The Admin console reads one job's or every job's history, newest first.
create index cron_job_runs_job_started
  on cron_job_runs (job, started_at desc);

-- "Which run is still open" and — in the start helper — "which open run is
-- clearly dead" both walk the running rows.
create index cron_job_runs_running
  on cron_job_runs (started_at) where status = 'running';

alter table cron_job_runs enable row level security;
