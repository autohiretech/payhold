-- A tenant's own "start over": wipe everything a company has accumulated
-- while testing PayHold, without touching its login, its role assignments,
-- its settings, or its connected provider credentials — those are
-- configuration, not test data, and a reset that logged everybody out or
-- forgot the fee rate would be a worse footgun than the one it fixes.
--
-- **This is a sandbox reset, not a delete-my-account.** It is refused
-- permanently, for any tenant that has ever connected a `mode: 'live'`
-- provider account — real buyer money is exactly the thing invariant 6
-- ("ledgered + audited") and the append-only ledger exist to make
-- unforgettable, and reconciliation, a chargeback response or a regulator's
-- question all depend on that history outliving the tenant's own wish to
-- clear a screen.
--
-- `tenant_provider_accounts.mode` cannot be that check by itself —
-- `20260816000002`'s own header says why: it is overwritten on reconnect,
-- so a tenant who went live and later reconnected in test mode would read as
-- if it never had. `went_live_at` is the fix already used elsewhere in this
-- schema (`security_hold_until`, `destination_changed_at`): a timestamp
-- stamped once, on the way in, that nothing is ever allowed to clear.

alter table tenants add column went_live_at timestamptz;

comment on column tenants.went_live_at is
  'Stamped once, the first time this tenant ever connects a mode=live '
  'provider account. Never cleared by anything, including a later '
  'disconnect or a reconnect in test mode — it answers "has real money ever '
  'moved here", which a reconnect must not be able to erase. Null means '
  'never; reset_tenant_sandbox() refuses permanently once this is set.';

-- ---------------------------------------------------------------------------
-- The append-only guard gets one narrow, explicit bypass
-- ---------------------------------------------------------------------------
--
-- `reject_mutation()` (20260805000001) has refused every update and delete on
-- `ledger` and `audit_log` unconditionally since the tables existed, and nothing
-- about that changes for an ordinary caller. `reset_tenant_sandbox` below is
-- the one exception, and it is written so the exception cannot leak past it:
--
--   * the flag is a transaction-local GUC (`set_config(..., true)`) — invisible
--     to every other session, and gone the instant this transaction ends,
--     committed or not. No concurrent caller can ever observe it set.
--   * it only ever answers `true` from inside `reset_tenant_sandbox`, which is
--     `security definer`, service-role only, and has already refused a tenant
--     with `went_live_at` set before it gets anywhere near this.
--   * it permits DELETE only. An UPDATE on either table is refused exactly as
--     before — a reset has no reason to rewrite a row, only to remove one.
create or replace function reject_mutation() returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE'
     and coalesce(current_setting('payhold.sandbox_wipe', true), 'off') = 'on'
  then
    return old;
  end if;

  raise exception 'ledger is append-only: % is not permitted', tg_op
    using errcode = 'restrict_violation';
end;
$$;

-- ---------------------------------------------------------------------------
-- reset_tenant_sandbox — the whole of "start over"
-- ---------------------------------------------------------------------------
--
-- Deletes every row this tenant has accumulated: deals and everything hung
-- off a deal (confirmations, refunds, checkout sessions, disputes and their
-- offers/evidence, risk signals, request context, AI suggestions and
-- outcomes), payouts and their routing decisions, sellers and their
-- destinations, the ledger, the audit log, registered webhook endpoints and
-- their delivery history, inbound provider-webhook records, and this
-- tenant's own reconciliation history.
--
-- Deliberately untouched: `tenants` itself (the login and the slug survive),
-- `tenant_users` (nobody is signed out), `settings` (a fee rate a tenant
-- configured on purpose is not test data), `api_keys` and
-- `tenant_provider_accounts` (credentials stay connected — reconnecting a
-- sandbox key is not what this button is for), and any tenant-owned override
-- rows in `payout_routes` / `provider_capabilities` / `payment_markets`
-- (policy, not history).
--
-- Order matters and is FK-driven, not arbitrary: `ledger.deal_id` and
-- `ledger.tenant_id` are `on delete restrict` (so is `payouts.deal_id`,
-- `payouts.seller_id`, `refunds.deal_id`, `deals.seller_id`) precisely so a
-- careless `delete from tenants` can never silently take the ledger with it.
-- This function is the deliberate, narrow door that same restrict is meant to
-- make you walk through on purpose: ledger and payouts and refunds go first,
-- then deals (which cascades confirmations, checkout sessions, disputes and
-- their offers/evidence, risk signals, request context, AI suggestions and
-- deal outcomes for free), then sellers, with everything unrelated to a deal
-- swept up by explicit tenant-scoped deletes alongside.
create or replace function reset_tenant_sandbox(
  p_tenant uuid,
  p_actor  text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  t tenants;
begin
  if p_actor is null or btrim(p_actor) = '' then
    raise exception 'policy_violation: a reset needs a named actor'
      using errcode = 'check_violation';
  end if;

  select * into t from tenants where id = p_tenant for update;

  if not found then
    raise exception 'not_found: tenant % does not exist', p_tenant
      using errcode = 'no_data_found';
  end if;

  if t.went_live_at is not null then
    raise exception
      'policy_violation: this company connected live payment credentials on %'
      ' — its history cannot be reset, only a new company can start clean',
      t.went_live_at
      using errcode = 'check_violation';
  end if;

  -- Everything with no path to a deal, deleted directly by tenant.
  delete from webhook_deliveries    where tenant_id = p_tenant;
  delete from webhook_endpoints     where tenant_id = p_tenant;
  delete from provider_events       where tenant_id = p_tenant;
  delete from reconciliation_alerts where tenant_id = p_tenant;
  delete from reconciliation_runs   where tenant_id = p_tenant;
  delete from ai_chat               where tenant_id = p_tenant;

  -- Restrict-guarded parents of `deals`, deleted before it.
  delete from refunds where tenant_id = p_tenant;
  delete from payouts where tenant_id = p_tenant;

  -- The bypass window: narrow, transaction-local, DELETE-only (see
  -- `reject_mutation` above), and closed again before this function returns
  -- control to anything else that might run later in the same transaction.
  perform set_config('payhold.sandbox_wipe', 'on', true);
  delete from ledger    where tenant_id = p_tenant;
  delete from audit_log where tenant_id = p_tenant;
  perform set_config('payhold.sandbox_wipe', 'off', true);

  -- Cascades confirmations, checkout_sessions, disputes (and dispute_offers /
  -- dispute_evidence off that), risk_signals, request_context, ai_suggestions
  -- and deal_outcomes — every one of them `on delete cascade` off `deal_id`.
  delete from deals where tenant_id = p_tenant;

  -- Last: `deals.seller_id` and `payouts.seller_id` both restrict, and both
  -- tables are already empty for this tenant.
  delete from sellers where tenant_id = p_tenant;

  -- The audit log is empty now, so this is the first row in it — a fresh
  -- tenant's history starts with the record that it was cleared, by whom,
  -- and when.
  perform write_audit(
    p_tenant, null, p_actor, 'tenant.sandbox_reset',
    jsonb_build_object('reset_at', now())
  );
end;
$$;

revoke all on function reset_tenant_sandbox(uuid, text) from public, anon, authenticated;
revoke all on function reset_tenant_sandbox(uuid, text) from payhold_ai;
grant execute on function reset_tenant_sandbox(uuid, text) to service_role;
