-- A reconciliation SURPLUS raises a case. It does not freeze payouts.
--
-- `record_reconciliation` (`20260912000005`) computes
-- `v_drift := p_provider_balance - p_ledger_balance` and, until now, treated
-- every nonzero drift the same way: open or refresh a case, then freeze the
-- tenant. The freeze exists so PayHold never pays a seller out of a balance
-- that is not there — that is a **shortfall**, `v_drift < 0`, the provider
-- holding less than the ledger says it should. A **surplus**, `v_drift > 0`,
-- is the provider holding *more* than the ledger expects. It cannot cause an
-- overpayment — there is nothing here a payout could draw down past zero —
-- and it is unexplained rather than dangerous. Freezing every honest seller's
-- cleared money over a rail that appears to be holding extra was the wrong
-- trade, decided by the account holder.
--
-- The only behavioural change is the sign split below:
--
--   v_drift < 0 (shortfall) — unchanged in every respect. Opens or refreshes
--   the case, writes its audit row, and freezes via
--   `update tenants set status = 'payouts_frozen' where id = p_tenant and
--   status = 'active'`.
--
--   v_drift > 0 (surplus) — opens or refreshes the case exactly as before and
--   writes its audit row. Does **not** touch `tenants.status`.
--
--   v_drift = 0 — unchanged. Resolves an open case if there is one and never
--   touches status, exactly as it already did not.
--
-- Everything else is byte-identical to `20260912000005`'s function: the
-- `last_rail_readings` upsert, every column written on the alert row, the
-- resolve path, the return value, the signature. `create or replace` on an
-- **unchanged** argument list is a true replace rather than a sibling, so
-- this stays the only `record_reconciliation` in `pg_proc` and every grant
-- and revoke already issued against it carries forward untouched. Nothing is
-- reissued here, on purpose, for the same reason `20260912000005` reissued
-- nothing: a signature that did not change needs no new revoke.
--
-- **What this deliberately does not do.** `resolve_reconciliation_run` still
-- refuses to lift a freeze while any case on the tenant is open, surplus
-- cases included — a case still has to be closed by a named person, and
-- nothing here weakens that. Nothing here adds an auto-unfreeze; nothing in this
-- system lifts a freeze on a timer, by design, and a surplus is no exception.
-- And this migration does not touch a tenant already frozen by an earlier
-- shortfall — lifting that is `resolve_reconciliation_run`'s job, done by a
-- person, never this function's.
--
-- The audit line matters here more than most: it is read during an incident,
-- by someone trying to work out what the system did. Before this migration
-- the mismatch audit's `action` detail always read `'payouts frozen'`, which
-- would now be a lie on the surplus branch. It reads `'payouts frozen'` only
-- when that is what happened, and `'case raised, payouts not frozen'` on a
-- surplus — matching the existing lowercase, plain-English style of that
-- field rather than inventing a new vocabulary. The audit *action name*
-- itself, `reconciliation.mismatch`, is unchanged in both branches: a
-- mismatch is a mismatch whichever way the balance leans, and
-- `tenant.payouts_frozen` is still its own, separate audit row, still written
-- only when the update to `tenants.status` actually flips a row.

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

  -- Shortfall: the provider is holding less than the ledger says it should.
  -- Money is missing, so this freezes — unchanged from before this migration.
  if v_drift < 0 then
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
  else
    -- Surplus: the provider is holding more than the ledger expects. That is
    -- unexplained and deserves the same loud case, but it cannot cause an
    -- overpayment, so it does not touch `tenants.status`.
    perform write_audit(p_tenant, null, 'system', 'reconciliation.mismatch', jsonb_build_object(
      'provider', p_provider,
      'currency', p_currency,
      'ledger_balance', p_ledger_balance,
      'provider_balance', p_provider_balance,
      'drift', v_drift,
      'run_id', p_run,
      'action', 'case raised, payouts not frozen'
    ));
  end if;

  return a;
end;
$$;
