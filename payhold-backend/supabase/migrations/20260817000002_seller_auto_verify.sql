-- `seller_auto_verify` — a tenant setting that lets sellers be paid without a
-- person clicking Verify in PayHold's dashboard, and without §5.1's hold on a
-- fresh destination.
--
-- Off by default, and off is the posture every tenant keeps unless its owner
-- turns this on from Settings (person-only; the endpoint refuses an API key).
-- Turning it on is that owner's attestation: "my own onboarding checks my
-- sellers' identity, and I take that responsibility" — which is the same shape
-- as `verify_seller`'s named attestation, made once for the account rather
-- than once per seller, and audited on the settings row that flipped it.
--
-- What it changes, and only on rows written after it is on:
--
--   * a seller is inserted `kyc_status = 'verified'` with a fresh
--     `sanctions_checked_at`, instead of `pending` with none
--   * a destination — seeded at registration or added later — lands
--     `verified_at = now()` and `security_hold_until = now()`, so neither
--     the verification gate nor the change-protection hold stops its payout
--
-- What it does not change: `screen_payout`, `seller_capabilities` and
-- `route_payout` are untouched. They still read the same columns and still
-- refuse an unverified seller or a held destination — the flag only decides
-- what gets *written* into those columns on the way in. That keeps one fact
-- with one set of readers, which `20260809000002`'s header explains the hard
-- way. It also means rows that existed before the flag stay exactly as they
-- were; a tenant with pending sellers verifies them once, or resets its
-- sandbox.
--
-- `security_hold_until` is `now()` rather than null on purpose, the same
-- reasoning as `end_destination_hold`: null means "never had a hold", and
-- every reader falls back to `sellers.destination_changed_at` for that case —
-- which the sync trigger stamps on every insert, so a null here would be a
-- 24-hour hold wearing the flag's name.

create or replace function seller_auto_verify(p_tenant uuid) returns boolean
language sql
stable
as $$
  select setting_num(p_tenant, 'seller_auto_verify', 0) <> 0;
$$;

-- ---------------------------------------------------------------------------
-- Sellers: verified on the way in
-- ---------------------------------------------------------------------------

create or replace function auto_verify_seller() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not seller_auto_verify(new.tenant_id) then
    return new;
  end if;

  new.kyc_status := 'verified';
  new.sanctions_checked_at := now();

  perform write_audit(new.tenant_id, null, 'system', 'seller.auto_verified',
    jsonb_build_object('seller_id', new.id, 'name', new.name));

  return new;
end;
$$;

-- Before, not after: it has to change the row being written, and it has to run
-- ahead of `sellers_seed_primary_destination` (an after-trigger) so the
-- seeded destination is written for a seller already known to be verified.
create trigger sellers_auto_verify
  before insert on sellers
  for each row execute function auto_verify_seller();

-- ---------------------------------------------------------------------------
-- The seeded primary destination
-- ---------------------------------------------------------------------------

create or replace function seed_primary_destination() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  trusted boolean;
begin
  if new.beneficiary_token is null then
    return new;
  end if;

  trusted := seller_auto_verify(new.tenant_id);

  insert into seller_destinations (
    tenant_id, seller_id, label, country, payout_currency, payout_provider,
    beneficiary_token, masked_destination, is_primary,
    verified_at, security_hold_until
  )
  values (
    new.tenant_id, new.id, 'Primary', new.country, new.payout_currency,
    new.payout_provider, new.beneficiary_token, new.masked_destination, true,
    case when trusted then now() end,
    case when trusted then now() end
  );

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- A destination added later
-- ---------------------------------------------------------------------------
--
-- Same signature as `20260809000001`, so `create or replace` is the right
-- tool — and the revokes still have to be reissued, because a replaced
-- function is granted to PUBLIC again.

create or replace function add_seller_destination(
  p_seller   uuid,
  p_tenant   uuid,
  p_country  country_code,
  p_currency currency_code,
  p_provider payout_provider,
  p_token    text,
  p_masked   text,
  p_label    text default null,
  p_role     text default 'primary',
  p_actor    text default null
) returns seller_destinations
language plpgsql
security definer
set search_path = public
as $$
declare
  s          sellers;
  d          seller_destinations;
  hold_hours integer;
  trusted    boolean;
begin
  if p_role not in ('primary', 'backup') then
    raise exception 'policy_violation: a destination is primary or backup, not %', p_role
      using errcode = 'check_violation';
  end if;

  if p_token is null or btrim(p_token) = '' or p_masked is null or btrim(p_masked) = '' then
    raise exception 'policy_violation: a destination needs a token and a mask'
      using errcode = 'check_violation';
  end if;

  select * into s from sellers
   where id = p_seller and tenant_id = p_tenant
     for update;

  if not found then
    raise exception 'not_found: seller % does not exist', p_seller
      using errcode = 'no_data_found';
  end if;

  if p_role = 'primary' then
    update seller_destinations
       set is_primary = false
     where seller_id = p_seller and is_primary;
  else
    update seller_destinations
       set is_backup = false
     where seller_id = p_seller and is_backup;
  end if;

  trusted    := seller_auto_verify(p_tenant);
  hold_hours := case when trusted then 0
                     else setting_num(p_tenant, 'destination_hold_hours', 24)::integer end;

  insert into seller_destinations (
    tenant_id, seller_id, label, country, payout_currency, payout_provider,
    beneficiary_token, masked_destination, is_primary, is_backup,
    verified_at, security_hold_until
  )
  values (
    p_tenant, p_seller, p_label, p_country, p_currency, p_provider,
    p_token, p_masked, p_role = 'primary', p_role = 'backup',
    case when trusted then now() end,
    now() + make_interval(hours => hold_hours)
  )
  returning * into d;

  perform write_audit(
    p_tenant, null, coalesce(nullif(btrim(p_actor), ''), 'api'),
    'seller.destination_added',
    jsonb_build_object(
      'seller_id', p_seller,
      'destination_id', d.id,
      'destination', d.masked_destination,
      'provider', d.payout_provider,
      'role', p_role,
      'security_hold_until', d.security_hold_until,
      'auto_verified', trusted
    )
  );

  return d;
end;
$$;

revoke all on function add_seller_destination(
  uuid, uuid, country_code, currency_code, payout_provider, text, text, text, text, text
) from public, anon, authenticated;
revoke all on function add_seller_destination(
  uuid, uuid, country_code, currency_code, payout_provider, text, text, text, text, text
) from payhold_ai;

revoke all on function auto_verify_seller() from public, anon, authenticated;
revoke all on function seed_primary_destination() from public, anon, authenticated;
grant execute on function seller_auto_verify(uuid) to authenticated, service_role;
