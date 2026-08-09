-- ---------------------------------------------------------------------------
-- The scheduled jobs.
-- ---------------------------------------------------------------------------
--
-- THIS IS NOT A MIGRATION AND MUST NOT BECOME ONE. `pg_cron` does not exist in
-- PGlite, so a migration creating schedules would fail the local test harness
-- on every run — and which environment runs the jobs is a deploy concern, not
-- a schema one. Run this by hand against the linked project, once:
--
--   psql "$SUPABASE_DB_URL" -f scripts/schedule-cron.sql
--
-- or paste it into the SQL editor. It is idempotent: `cron.schedule` on an
-- existing job name replaces that job rather than adding a second one.
--
-- Before running, set the shared secret ONCE, matching the CRON_SECRET
-- function secret (`npx supabase secrets set CRON_SECRET=…`):
--
--   select vault.create_secret('…', 'payhold_cron_secret',
--     'Shared secret the scheduled jobs send as x-cron-secret.');
--
-- **It goes in Vault rather than in a GUC, because on Supabase a GUC is not
-- available.** The obvious form — `alter database postgres set
-- payhold.cron_secret = '…'` — fails with `permission denied to set parameter`:
-- the database is owned by `supabase_admin` and the `postgres` role we connect
-- as is not a superuser, so it may set neither a database-level nor a
-- role-level custom parameter. Vault is the platform's own answer, and it is
-- the better one anyway: the value is encrypted at rest instead of sitting in
-- plaintext in `pg_db_role_setting`.
--
-- To rotate it, update in place rather than creating a second row:
--
--   select vault.update_secret(
--     (select id from vault.secrets where name = 'payhold_cron_secret'), '…');
--
-- Keep the value out of this file and out of git. A job whose secret does not
-- match the function's gets a 401 from every call — visible within a day in
-- cron.job_run_details, which is the failure mode we want over the alternative.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ---------------------------------------------------------------------------
-- Ordering
-- ---------------------------------------------------------------------------
--
-- The times are staggered rather than aligned, and the order is the safety
-- argument:
--
--   :00  reconcile        drift freezes a tenant's payouts
--   :10  auto-release     timers fire, queueing payouts with a clearance date
--   :20  payout-dispatch  sends whatever has cleared
--
-- Reconciliation goes first because a dispatch that ran before it would send
-- money out of a balance we already know we cannot explain. Auto-release goes
-- before dispatch only so a deal whose timer fires this hour is not waiting a
-- full clearance window plus an hour; nothing breaks if that order slips.
--
-- Webhook delivery runs every minute on its own, independent of all of it.

select cron.schedule('payhold-reconcile', '0 * * * *', $$
  select net.http_post(
    url := 'https://mwnbjjlilqrwdmwutbxr.supabase.co/functions/v1/reconcile',
    headers := jsonb_build_object('x-cron-secret',
      (select decrypted_secret from vault.decrypted_secrets
        where name = 'payhold_cron_secret'))
  );
$$);

select cron.schedule('payhold-auto-release', '10 * * * *', $$
  select net.http_post(
    url := 'https://mwnbjjlilqrwdmwutbxr.supabase.co/functions/v1/auto-release',
    headers := jsonb_build_object('x-cron-secret',
      (select decrypted_secret from vault.decrypted_secrets
        where name = 'payhold_cron_secret'))
  );
$$);

select cron.schedule('payhold-payout-dispatch', '20 * * * *', $$
  select net.http_post(
    url := 'https://mwnbjjlilqrwdmwutbxr.supabase.co/functions/v1/payout-dispatch',
    headers := jsonb_build_object('x-cron-secret',
      (select decrypted_secret from vault.decrypted_secrets
        where name = 'payhold_cron_secret'))
  );
$$);

-- Every minute. A client waiting on a notification is waiting on this, and the
-- retry backoff (1m, 5m, 30m, 2h) assumes a pass at least that often.
select cron.schedule('payhold-webhooks', '* * * * *', $$
  select net.http_post(
    url := 'https://mwnbjjlilqrwdmwutbxr.supabase.co/functions/v1/webhook-dispatch',
    headers := jsonb_build_object('x-cron-secret',
      (select decrypted_secret from vault.decrypted_secrets
        where name = 'payhold_cron_secret'))
  );
$$);

-- ---------------------------------------------------------------------------
-- Checking on them
-- ---------------------------------------------------------------------------
--
--   select jobname, schedule, active from cron.job order by jobname;
--
--   select j.jobname, r.status, r.return_message, r.start_time
--   from cron.job_run_details r
--   join cron.job j on j.jobid = r.jobid
--   where r.start_time > now() - interval '6 hours'
--   order by r.start_time desc;
--
-- `net.http_post` returns a request id immediately, so a cron run recorded as
-- succeeded means the request was queued, NOT that the function returned 200.
-- The response is in net._http_response:
--
--   select status_code, content, created
--   from net._http_response
--   order by created desc limit 20;
--
-- To stop one:  select cron.unschedule('payhold-payout-dispatch');
