-- Row-level security — spec §5, §6.
--
-- The rule in one sentence: **dashboard sessions can read their own tenant and
-- write nothing.** Every write in this system goes through an Edge Function
-- using the service role, which bypasses RLS entirely. So the policies below
-- are all `for select`, and the absence of insert/update/delete policies is
-- the security control, not an oversight.
--
-- RLS is row-level, but some columns must not be readable at all — a key hash,
-- an encrypted credential blob, a signing secret. Those are handled with
-- column-level grants underneath the policies. Both layers have to agree
-- before a byte reaches the browser.

-- ---------------------------------------------------------------------------
-- Who is asking
-- ---------------------------------------------------------------------------

-- The tenants the current auth user belongs to. Marked stable so the planner
-- evaluates it once per statement rather than once per row.
create or replace function current_tenant_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select tenant_id from tenant_users where auth_user_id = auth.uid();
$$;

-- PayHold staff. A separate axis from tenant role: a client's "owner" must
-- never be one step away from seeing other tenants.
create or replace function is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from platform_admins where auth_user_id = auth.uid());
$$;

grant execute on function current_tenant_ids() to authenticated;
grant execute on function is_platform_admin() to authenticated;

-- ---------------------------------------------------------------------------
-- Enable RLS everywhere. Default deny.
-- ---------------------------------------------------------------------------

alter table tenants                  enable row level security;
alter table tenant_users             enable row level security;
alter table platform_admins          enable row level security;
alter table api_keys                 enable row level security;
alter table tenant_provider_accounts enable row level security;
alter table settings                 enable row level security;
alter table sellers                  enable row level security;
alter table deals                    enable row level security;
alter table confirmations            enable row level security;
alter table ledger                   enable row level security;
alter table payouts                  enable row level security;
alter table disputes                 enable row level security;
alter table webhook_endpoints        enable row level security;
alter table webhook_deliveries       enable row level security;
alter table provider_events          enable row level security;
alter table audit_log                enable row level security;
alter table reconciliation_alerts    enable row level security;

-- Force RLS even for the table owner, so a mistakenly-owner-connected function
-- does not quietly see everything.
alter table deals   force row level security;
alter table ledger  force row level security;
alter table payouts force row level security;

-- ---------------------------------------------------------------------------
-- Tenant-scoped read policies
-- ---------------------------------------------------------------------------

create policy tenants_read on tenants
  for select to authenticated
  using (id in (select current_tenant_ids()) or is_platform_admin());

create policy tenant_users_read on tenant_users
  for select to authenticated
  using (tenant_id in (select current_tenant_ids()) or is_platform_admin());

create policy platform_admins_read on platform_admins
  for select to authenticated
  using (auth_user_id = auth.uid());

create policy settings_read on settings
  for select to authenticated
  using (tenant_id in (select current_tenant_ids()) or is_platform_admin());

create policy sellers_read on sellers
  for select to authenticated
  using (tenant_id in (select current_tenant_ids()) or is_platform_admin());

create policy deals_read on deals
  for select to authenticated
  using (tenant_id in (select current_tenant_ids()) or is_platform_admin());

create policy confirmations_read on confirmations
  for select to authenticated
  using (exists (
    select 1 from deals d
    where d.id = confirmations.deal_id
      and (d.tenant_id in (select current_tenant_ids()) or is_platform_admin())
  ));

create policy ledger_read on ledger
  for select to authenticated
  using (tenant_id in (select current_tenant_ids()) or is_platform_admin());

create policy payouts_read on payouts
  for select to authenticated
  using (tenant_id in (select current_tenant_ids()) or is_platform_admin());

create policy disputes_read on disputes
  for select to authenticated
  using (tenant_id in (select current_tenant_ids()) or is_platform_admin());

create policy webhook_endpoints_read on webhook_endpoints
  for select to authenticated
  using (tenant_id in (select current_tenant_ids()) or is_platform_admin());

create policy webhook_deliveries_read on webhook_deliveries
  for select to authenticated
  using (tenant_id in (select current_tenant_ids()) or is_platform_admin());

create policy api_keys_read on api_keys
  for select to authenticated
  using (tenant_id in (select current_tenant_ids()) or is_platform_admin());

-- Write-only from functions (§5). Readable by the tenant it belongs to; the
-- append-only trigger and the absence of a write policy do the rest.
create policy audit_log_read on audit_log
  for select to authenticated
  using (tenant_id in (select current_tenant_ids()) or is_platform_admin());

-- ---------------------------------------------------------------------------
-- Master-admin only
-- ---------------------------------------------------------------------------

-- Reconciliation drift is a PayHold operational concern. A tenant learning
-- their own payouts are frozen is fine (tenants.status tells them); the drift
-- figures and other tenants' alerts are not theirs to see.
create policy reconciliation_alerts_read on reconciliation_alerts
  for select to authenticated
  using (is_platform_admin());

-- Raw provider payloads can carry buyer detail the client never sent us.
-- Staff only.
create policy provider_events_read on provider_events
  for select to authenticated
  using (is_platform_admin());

-- Credentials are never readable through PostgREST by anyone. Only the service
-- role, which bypasses RLS, can decrypt them inside an Edge Function. There is
-- deliberately NO select policy here — the table is invisible to sessions.
-- (tenant_provider_accounts: no policy = deny all.)

-- ---------------------------------------------------------------------------
-- Column-level grants: secrets never leave, even to their owner
-- ---------------------------------------------------------------------------

-- Nothing is writable through the API layer. Service role bypasses all of this.
revoke insert, update, delete on all tables in schema public from anon, authenticated;

-- api_keys: the tenant may list their keys, but key_hash is not among the
-- columns they can select. Hash comparison happens in an Edge Function.
revoke select on api_keys from anon, authenticated;
grant select (id, tenant_id, label, masked_key, created_at, revoked_at, last_used_at)
  on api_keys to authenticated;

-- webhook_endpoints: same shape. The signing secret is shown once at creation
-- by the function that generated it, and never again.
revoke select on webhook_endpoints from anon, authenticated;
grant select (id, tenant_id, url, masked_secret, created_at, disabled_at)
  on webhook_endpoints to authenticated;

-- Provider credentials: no grant at all.
revoke all on tenant_provider_accounts from anon, authenticated;

-- Anonymous sessions get nothing. The public checkout and status pages are
-- served by Edge Functions holding a per-deal token, not by direct table reads.
revoke all on all tables in schema public from anon;
