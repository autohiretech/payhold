-- The gap: reconciliation asks every rail what it is holding, on every pass,
-- and `record_reconciliation` (`20260807000013`) throws most of those answers
-- away. `reconciliation_alerts` is a case log, not a balance store: a drift
-- opens or refreshes a row, a drift going away resolves one, and a clean pass
-- with no open alert **writes nothing at all**. A rail that has agreed with us
-- every night since launch has therefore never once had its provider balance
-- stored anywhere — and `balance/index.ts`'s `?live=1` fallback, which reads
-- exactly that table when a live provider call fails, finds nothing for the
-- common case: a healthy rail. Worse, "never disagreed" and "never checked"
-- both read back as `amount: null, stale: true` — the endpoint's own header
-- says so.
--
-- `last_rail_readings` is the fix, and it is deliberately a "last known", not
-- a history: one row per (tenant, provider, currency), upserted every pass.
-- `reconciliation_alerts` keeps doing exactly what it does today — this does
-- not replace it, and does not change one byte of its behaviour. The two
-- answer different questions: the alert log says whether something is wrong
-- *now*; this says what the last honest look actually found, whether or not
-- anything was wrong.

create table last_rail_readings (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id) on delete cascade,
  provider          provider not null,
  currency          currency_code not null,
  -- What our ledger said the provider should be holding, at the moment this
  -- reading was taken.
  ledger_balance    bigint not null,
  -- What the provider actually reported.
  provider_balance  bigint not null,
  read_at           timestamptz not null default now(),
  constraint last_rail_readings_cell unique (tenant_id, provider, currency)
);

create index last_rail_readings_tenant_idx on last_rail_readings(tenant_id);

comment on table last_rail_readings is
  'The latest provider-balance reading per (tenant, provider, currency), '
  'upserted by every record_reconciliation() call regardless of drift. '
  'Answers "when did we last actually check, and what did we find" — a '
  'question reconciliation_alerts cannot answer for a rail that has never '
  'disagreed.';

-- Same operational-data reasoning as reconciliation_alerts_read: a tenant
-- learning their own payouts are frozen is fine (tenants.status says so), but
-- raw provider-balance readings, theirs or another tenant's, are not a screen
-- they need. balance/index.ts reads this table with the service role, which
-- bypasses RLS entirely, so this policy is a second door rather than the only
-- one.
alter table last_rail_readings enable row level security;

create policy last_rail_readings_read on last_rail_readings
  for select to authenticated
  using (is_platform_admin());

grant select on last_rail_readings to authenticated;

-- ---------------------------------------------------------------------------
-- record_reconciliation, unchanged except for the one new statement at the
-- top of its body.
-- ---------------------------------------------------------------------------
--
-- Same signature, same return type, same alert behaviour, line for line, from
-- `20260807000013`. `create or replace` on an **unchanged** argument list is a
-- true replace rather than a sibling — unlike the parameter-adding case that
-- migration's own header warns about — so this stays the only
-- `record_reconciliation` in `pg_proc`, and every grant and revoke already
-- issued against it (including `payhold_ai`'s, `20260807000013` lines 508-510)
-- carries forward untouched. Nothing is reissued here, on purpose: reissuing
-- a revoke this signature never lost would read as a signature change that
-- did not happen.
--
-- The upsert runs first, before the drift branches, so it fires on every
-- call including the one case that used to write nothing: drift zero, no
-- alert row. It is not itself protected by `p_run is not null` the way the
-- run counters are — a hand-run comparison during an incident is exactly the
-- kind of look this table exists to remember, run or no run.

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
  insert into last_rail_readings (tenant_id, provider, currency, ledger_balance, provider_balance, read_at)
  values (p_tenant, p_provider, p_currency, p_ledger_balance, p_provider_balance, now())
  on conflict (tenant_id, provider, currency)
  do update set ledger_balance   = excluded.ledger_balance,
                provider_balance = excluded.provider_balance,
                read_at          = excluded.read_at;

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
