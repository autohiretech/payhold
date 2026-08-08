-- Reconciliation runs — spec §13, V2 plan phase 9.
--
-- We already compared ledger against provider balance every night, and already
-- froze a tenant's payouts on any drift. What we had no record of was the
-- *pass*: which rails were compared, when, how many agreed, and whether anyone
-- ever looked at the ones that did not. `reconciliation_alerts` answers "is
-- something wrong right now"; it cannot answer "did last Tuesday's pass run,
-- and did it check Stripe" — and a nightly control nobody can prove ran is not
-- a control.
--
-- One migration, not two: nothing here uses a value added to an existing enum,
-- and a type created inside a transaction is usable inside it. Same rule the
-- checkout-session migration follows.
--
-- ## One run per tenant per rail
--
-- Not per pass. §26 already says balances reconcile per rail because you cannot
-- ask two providers about one number, and a run that averaged Flutterwave and
-- Stripe into a single "12 matched" would be the same mistake one level up. A
-- pass over a tenant with two connected rails writes two runs.
--
-- ## What the four counters mean
--
-- `matched` / `mismatched` — currency comparisons on this rail that agreed or
-- did not. Every mismatch also opens (or refreshes) a `reconciliation_alerts`
-- case, and `run_id` on that table is which pass first raised it.
--
-- `skipped` — rails we could not get an external figure for: an unreachable
-- provider API, or a tenant still on `FakeProvider` with no external truth to
-- compare against. A skipped rail is not a clean rail, which is why a run with
-- any of them cannot report `clean`.
--
-- `missing` — inbound events that arrived, verified, and never finished
-- processing: `provider_events` rows in the period with `signature_ok` and no
-- `processed_at`. That is money the provider has told us about which our ledger
-- has not posted, and it is the arrears half of §13's inbox design.
--
-- **`missing` is deliberately not a transaction-export diff**, which is what
-- §13's sentence literally describes. No adapter has a transaction-listing call
-- — `PaymentProvider` exposes `balances()` and nothing else that enumerates —
-- so an export comparison today would return zero for every real rail while
-- looking authoritative. Counting the inbox is a smaller claim that is true.
-- Widening it is an adapter method and a run column, not a redesign.
--
-- ## The run never touches money
--
-- §13: "any mismatch produces a case rather than silently altering balances."
-- That was already true and is now structural — none of the functions below
-- writes a ledger entry, and `tests/webhooks-risk-reconciliation.test.ts`
-- asserts it against their bodies with the comments stripped, the same way the
-- checkout tests assert that a session cannot fund a deal.

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------

do $$ begin
  create type reconciliation_run_status as enum ('running', 'completed', 'failed');
exception when duplicate_object then null; end $$;

-- `incomplete` is the value worth explaining: nothing disagreed, and nothing
-- was proven either, because a rail could not be reached. Folding it into
-- `clean` would let a week of unreachable providers read as a week of clean
-- books.
do $$ begin
  create type reconciliation_resolution as enum
    ('clean', 'incomplete', 'cases_open', 'resolved');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- The run record
-- ---------------------------------------------------------------------------

create table if not exists reconciliation_runs (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  provider       provider not null,
  -- What the pass covers. `missing` is counted over this window; the balance
  -- comparison is a point-in-time reading at `period_end`.
  period_start   timestamptz not null,
  period_end     timestamptz not null,
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  rails_checked  integer not null default 0 check (rails_checked >= 0),
  matched        integer not null default 0 check (matched >= 0),
  mismatched     integer not null default 0 check (mismatched >= 0),
  skipped        integer not null default 0 check (skipped >= 0),
  missing        integer not null default 0 check (missing >= 0),
  status         reconciliation_run_status not null default 'running',
  resolution     reconciliation_resolution,
  resolved_by    text,
  resolved_at    timestamptz,
  resolution_note text,
  error          text,

  constraint reconciliation_runs_period check (period_end > period_start),
  -- Signing a case off is a person's act, like clearing a held payout. A row
  -- that says `resolved` with nobody's name on it is a row nobody can be asked
  -- about.
  constraint reconciliation_runs_resolved_needs_a_person
    check ((resolution = 'resolved') is not true or resolved_by is not null)
);

create index if not exists reconciliation_runs_tenant_idx
  on reconciliation_runs(tenant_id, started_at desc);

-- One pass at a time per rail. Two overlapping passes would each count half the
-- rails and both look complete.
create unique index if not exists reconciliation_runs_open_key
  on reconciliation_runs(tenant_id, provider)
  where status = 'running';

-- Which pass first raised this case. Null on alerts predating phase 9.
alter table reconciliation_alerts
  add column if not exists run_id uuid references reconciliation_runs(id) on delete set null;

comment on column reconciliation_alerts.run_id is
  'The reconciliation run that first raised this case. An alert is refreshed '
  'rather than duplicated on later passes, so this stays the pass that found it.';

alter table reconciliation_runs enable row level security;

-- Same reasoning as `reconciliation_alerts_read`: drift figures are a PayHold
-- operational concern. A tenant learning its own payouts are frozen is fine —
-- `tenants.status` says so — but the numbers behind it are not theirs.
drop policy if exists reconciliation_runs_read on reconciliation_runs;
create policy reconciliation_runs_read on reconciliation_runs
  for select to authenticated
  using (is_platform_admin());

-- ---------------------------------------------------------------------------
-- Opening a run
-- ---------------------------------------------------------------------------
--
-- The period defaults are computed here rather than in the Edge Function
-- because they are a question about our own history: the window runs from where
-- the last completed pass stopped, so an inbound event cannot fall between two
-- passes and be counted by neither.

create or replace function start_reconciliation_run(
  p_tenant       uuid,
  p_provider     provider,
  p_period_start timestamptz default null,
  p_period_end   timestamptz default null
) returns reconciliation_runs
language plpgsql
security definer
set search_path = public
as $$
declare
  r      reconciliation_runs;
  v_end  timestamptz := coalesce(p_period_end, now());
  v_start timestamptz;
begin
  -- A previous pass still marked `running` did not finish — the function timed
  -- out, the deploy restarted, the provider hung. Recording that is the point:
  -- an abandoned run left open would block this one on the unique index and
  -- would also read, forever, as a pass in progress.
  update reconciliation_runs
     set status = 'failed',
         finished_at = now(),
         error = coalesce(error, 'The pass did not finish')
   where tenant_id = p_tenant and provider = p_provider and status = 'running';

  v_start := coalesce(
    p_period_start,
    (select max(period_end) from reconciliation_runs
      where tenant_id = p_tenant and provider = p_provider and status = 'completed'),
    v_end - interval '1 day'
  );

  -- A second pass inside the same second would otherwise fail the period check
  -- rather than doing nothing useful, which is a confusing way to say "you have
  -- already run this".
  if v_start >= v_end then
    v_start := v_end - interval '1 second';
  end if;

  insert into reconciliation_runs (tenant_id, provider, period_start, period_end)
  values (p_tenant, p_provider, v_start, v_end)
  returning * into r;

  return r;
end;
$$;

-- ---------------------------------------------------------------------------
-- Recording one rail's comparison
-- ---------------------------------------------------------------------------
--
-- **Signature change: this gained `p_run`.** `create or replace` cannot add a
-- parameter — it creates a sibling, and a five-argument call would then be
-- ambiguous rather than wrong in any way Postgres could point at. So the old
-- one is dropped by its exact argument list and the revokes are reissued
-- below, the same trap `fund_deal` and `seller_capabilities` already carry.
--
-- The asymmetry inside is unchanged and deliberate. Drift freezes payouts by
-- itself, because money we cannot account for must stop moving immediately.
-- Nothing unfreezes by itself: the drift going away is not the same as someone
-- having understood why it was there.

drop function if exists record_reconciliation(uuid, provider, currency_code, bigint, bigint);

create or replace function record_reconciliation(
  p_tenant           uuid,
  p_provider         provider,
  p_currency         currency_code,
  p_ledger_balance   bigint,
  p_provider_balance bigint,
  p_run              uuid default null
) returns reconciliation_alerts
language plpgsql
security definer
set search_path = public
as $$
declare
  a       reconciliation_alerts;
  v_drift bigint := p_provider_balance - p_ledger_balance;
begin
  select * into a from reconciliation_alerts
  where tenant_id = p_tenant and provider = p_provider
    and currency = p_currency and resolved_at is null;

  -- The counters move whether or not this rail is part of a run, so a
  -- hand-run comparison during an incident does not have to know about runs.
  --
  -- **The open alert is tested by `a.id`, not by `found`, from here down.**
  -- `found` reflects the *last* statement, and this update is a statement — an
  -- earlier draft of this function put it here and silently turned every
  -- "no open alert" into "there is one", which meant a first mismatch updated a
  -- null row and never inserted the case at all.
  if p_run is not null then
    update reconciliation_runs
       set rails_checked = rails_checked + 1,
           matched    = matched    + (case when v_drift = 0 then 1 else 0 end),
           mismatched = mismatched + (case when v_drift = 0 then 0 else 1 end)
     where id = p_run;
  end if;

  if v_drift = 0 then
    if a.id is not null then
      update reconciliation_alerts
         set resolved_at = now(),
             ledger_balance = p_ledger_balance,
             provider_balance = p_provider_balance,
             drift = 0,
             resolution_note = 'Balances agree on a later pass'
       where id = a.id
      returning * into a;

      perform write_audit(p_tenant, null, 'system', 'reconciliation.cleared',
        jsonb_build_object('provider', p_provider, 'currency', p_currency));
    end if;
    return a;
  end if;

  if a.id is not null then
    update reconciliation_alerts
       set ledger_balance = p_ledger_balance,
           provider_balance = p_provider_balance,
           drift = v_drift,
           last_seen_at = now()
     where id = a.id
    returning * into a;
    return a;
  end if;

  insert into reconciliation_alerts (
    tenant_id, provider, currency, ledger_balance, provider_balance, drift, run_id
  )
  values (p_tenant, p_provider, p_currency, p_ledger_balance, p_provider_balance,
          v_drift, p_run)
  returning * into a;

  perform write_audit(p_tenant, null, 'system', 'reconciliation.mismatch', jsonb_build_object(
    'provider', p_provider,
    'currency', p_currency,
    'ledger_balance', p_ledger_balance,
    'provider_balance', p_provider_balance,
    'drift', v_drift,
    'run_id', p_run,
    'action', 'payouts frozen'
  ));

  update tenants set status = 'payouts_frozen'
   where id = p_tenant and status = 'active';

  if found then
    perform write_audit(p_tenant, null, 'system', 'tenant.payouts_frozen',
      jsonb_build_object('reason', 'Reconciliation found a balance we cannot explain'));
  end if;

  return a;
end;
$$;

-- ---------------------------------------------------------------------------
-- Closing a run
-- ---------------------------------------------------------------------------

create or replace function finish_reconciliation_run(
  p_run     uuid,
  p_skipped integer default 0
) returns reconciliation_runs
language plpgsql
security definer
set search_path = public
as $$
declare
  r         reconciliation_runs;
  v_missing integer;
begin
  select * into r from reconciliation_runs where id = p_run for update;

  if not found then
    raise exception 'not_found: reconciliation run % does not exist', p_run
      using errcode = 'no_data_found';
  end if;

  if r.status <> 'running' then
    raise exception 'invalid_state: reconciliation run % is already %', p_run, r.status
      using errcode = 'check_violation';
  end if;

  -- Signed, recorded, and never finished. A signature failure is not arrears —
  -- it is a forgery we correctly refused — so `signature_ok` bounds this.
  select count(*) into v_missing
    from provider_events e
   where e.tenant_id = r.tenant_id
     and e.provider = r.provider
     and e.signature_ok
     and e.processed_at is null
     and e.created_at >= r.period_start
     and e.created_at < r.period_end;

  update reconciliation_runs
     set status = 'completed',
         finished_at = now(),
         skipped = p_skipped,
         missing = v_missing,
         resolution = case
           when mismatched > 0 or v_missing > 0 then 'cases_open'::reconciliation_resolution
           when p_skipped > 0 or rails_checked = 0 then 'incomplete'::reconciliation_resolution
           else 'clean'::reconciliation_resolution
         end
   where id = r.id
  returning * into r;

  perform write_audit(r.tenant_id, null, 'system', 'reconciliation.run_completed',
    jsonb_build_object(
      'run_id', r.id,
      'provider', r.provider,
      'period_start', r.period_start,
      'period_end', r.period_end,
      'rails_checked', r.rails_checked,
      'matched', r.matched,
      'mismatched', r.mismatched,
      'skipped', r.skipped,
      'missing', r.missing,
      'resolution', r.resolution
    ));

  return r;
end;
$$;

-- A pass that threw. Recorded rather than left open, so the next one is not
-- reading "still running" from an hour ago.
create or replace function fail_reconciliation_run(p_run uuid, p_error text)
returns reconciliation_runs
language plpgsql
security definer
set search_path = public
as $$
declare
  r reconciliation_runs;
begin
  update reconciliation_runs
     set status = 'failed',
         finished_at = now(),
         error = p_error
   where id = p_run and status = 'running'
  returning * into r;

  if not found then
    raise exception 'invalid_state: reconciliation run % is not running', p_run
      using errcode = 'check_violation';
  end if;

  perform write_audit(r.tenant_id, null, 'system', 'reconciliation.run_failed',
    jsonb_build_object('run_id', r.id, 'provider', r.provider, 'error', p_error));

  return r;
end;
$$;

-- ---------------------------------------------------------------------------
-- Signing a case off — and the one place a freeze is lifted
-- ---------------------------------------------------------------------------
--
-- Freezing is arithmetic and automatic. Unfreezing is a judgement about whether
-- the difference has been *explained*, which is why it takes a name, refuses
-- while any case on that tenant is still open, and is a separate argument
-- rather than a side effect of closing the run: resolving the paperwork and
-- deciding the money is accounted for are two different claims, and an operator
-- must be able to make the first without making the second.
--
-- This does not weaken the rule that nothing unfreezes automatically. Nothing
-- here runs on a timer; a person is on the row.

create or replace function resolve_reconciliation_run(
  p_run      uuid,
  p_actor    text,
  p_note     text,
  p_unfreeze boolean default false
) returns reconciliation_runs
language plpgsql
security definer
set search_path = public
as $$
declare
  r    reconciliation_runs;
  open_cases integer;
begin
  if coalesce(trim(p_actor), '') = '' then
    raise exception 'policy_violation: resolving a reconciliation case needs a name'
      using errcode = 'check_violation';
  end if;

  select * into r from reconciliation_runs where id = p_run for update;

  if not found then
    raise exception 'not_found: reconciliation run % does not exist', p_run
      using errcode = 'no_data_found';
  end if;

  if r.status <> 'completed' then
    raise exception 'invalid_state: reconciliation run % is %, not completed', p_run, r.status
      using errcode = 'check_violation';
  end if;

  -- The cases this run raised are closed with it, carrying the same note. An
  -- alert left open behind a resolved run would be a case nobody is looking at
  -- and a run saying somebody did.
  update reconciliation_alerts
     set resolved_at = now(),
         resolution_note = p_note
   where run_id = r.id and resolved_at is null;

  update reconciliation_runs
     set resolution = 'resolved',
         resolved_by = p_actor,
         resolved_at = now(),
         resolution_note = p_note
   where id = r.id
  returning * into r;

  perform write_audit(r.tenant_id, null, p_actor, 'reconciliation.run_resolved',
    jsonb_build_object('run_id', r.id, 'provider', r.provider, 'note', p_note));

  if p_unfreeze then
    select count(*) into open_cases
      from reconciliation_alerts
     where tenant_id = r.tenant_id and resolved_at is null;

    if open_cases > 0 then
      raise exception
        'policy_violation: % reconciliation cases are still open on this tenant', open_cases
        using errcode = 'check_violation';
    end if;

    update tenants set status = 'active'
     where id = r.tenant_id and status = 'payouts_frozen';

    if found then
      perform write_audit(r.tenant_id, null, p_actor, 'tenant.payouts_resumed',
        jsonb_build_object('run_id', r.id, 'note', p_note));
    end if;
  end if;

  return r;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants — service role only, like every other money-adjacent function
-- ---------------------------------------------------------------------------

revoke all on function start_reconciliation_run(uuid, provider, timestamptz, timestamptz)
  from public, anon, authenticated;
revoke all on function record_reconciliation(uuid, provider, currency_code, bigint, bigint, uuid)
  from public, anon, authenticated;
revoke all on function finish_reconciliation_run(uuid, integer)
  from public, anon, authenticated;
revoke all on function fail_reconciliation_run(uuid, text)
  from public, anon, authenticated;
revoke all on function resolve_reconciliation_run(uuid, text, text, boolean)
  from public, anon, authenticated;

-- And explicitly from the AI role. It inherits nothing here once PUBLIC is
-- revoked, but `resolve_reconciliation_run` can lift a payout freeze on a named
-- person's say-so, and a function with that in it is worth naming in the same
-- list as the money functions rather than leaving to inference.
revoke all on function start_reconciliation_run(uuid, provider, timestamptz, timestamptz)
  from payhold_ai;
revoke all on function record_reconciliation(uuid, provider, currency_code, bigint, bigint, uuid)
  from payhold_ai;
revoke all on function finish_reconciliation_run(uuid, integer) from payhold_ai;
revoke all on function fail_reconciliation_run(uuid, text) from payhold_ai;
revoke all on function resolve_reconciliation_run(uuid, text, text, boolean) from payhold_ai;
