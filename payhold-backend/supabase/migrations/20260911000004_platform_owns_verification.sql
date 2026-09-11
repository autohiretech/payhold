-- ---------------------------------------------------------------------------
-- The tenant's own platform owns seller and destination verification
-- ---------------------------------------------------------------------------
--
-- Spec §29.18. Until now three things could say a seller, or a seller's payout
-- account, had been checked: a person signed in to PayHold clicking Verify,
-- `seller_auto_verify` writing `verified` at insert, and — for sellers only —
-- the tenant's API key under `seller_verification_relay`. AutoHire's admins are
-- the ones who actually look at a host's documents and payout account. A
-- decision transcribed into a second dashboard is not a second check, and a
-- flag that verifies everyone at signup is not a check at all.
--
-- So a new tenant setting, `platform_owns_verification`, **on by default**:
--
--   * while on, `verify_seller` and `verify_seller_destination` accept only a
--     relayed decision — the tenant's API key, naming the person on its platform
--     who decided — and refuse a signed-in person in both directions
--     (`verification_owned_by_platform`)
--   * it **supersedes** `seller_verification_relay`: a stored relay of 0 does not
--     refuse a relayed seller verification while ownership is on. Both are
--     re-read here, under the row lock
--   * `seller_auto_verify` writes nothing verified while it is on:
--     `auto_verify_seller`, `seed_primary_destination` and
--     `add_seller_destination` compute `trusted := seller_auto_verify(t) and
--     not platform_owns_verification(t)` at insert
--   * with it off, everything is as it was, and a destination still cannot be
--     verified over an API key (`destination_relay_off`)
--
-- **What it does not change.** `end_destination_hold` stays person-only and the
-- endpoint still refuses an API key: a platform that could add a destination,
-- verify it and end its hold would have deleted §5.1's change protection, not
-- satisfied it. Verifying never ends or shortens a hold. The gates —
-- `seller_capabilities`, `screen_payout`, `route_payout` — still read the same
-- columns and still refuse an unverified seller, an unverified destination and a
-- live hold; a setting decides who may write a column, never what reading it
-- means.
--
-- **Already-verified rows stay verified.** Sellers grandfathered as verified by
-- `20260807000007`, rows a person verified in the dashboard, and rows
-- `seller_auto_verify` wrote verified all keep their `kyc_status` and
-- `verified_at`. Nothing here un-verifies retroactively: withdrawing a
-- verification is a decision, and a migration is nobody's.
--
-- ## What a relayed decision records
--
-- PayHold authenticates the credential, not the person, so the name is stored as
-- the platform's report — `20260911000002`'s shape for disputes:
--
--   actor (audit)       the credential, `api_key:<label>`
--   reported_verifier   the name the platform reported
--   verifier_source     `platform_reported`, beside `person`
--
-- on both `sellers` and `seller_destinations`, describing the latest
-- verification decision on that row (a withdrawal included). Rows no
-- verification call has touched since this migration carry null in both.
--
-- A call is relayed when `p_via_api_key` is set **or** the actor is an
-- `api_key:` credential, so a caller written without the flag cannot reach the
-- person path by forgetting it. A relayed seller verification still stamps no
-- destination.
--
-- ## One routing change, and why it is here
--
-- `route_payout` checked the security hold only on a *requested* destination;
-- the primary it falls back to was routed as soon as it was verified.
-- `screen_payout` runs first in `dispatchPayout` and holds such a payout, so no
-- money moved — but with verification now arriving over an API key, "the hold
-- is what stands between a verified destination and a transfer" should be true
-- of every reader, not only of the one that runs first. A held primary is now a
-- no-route with its own reason, `destination_in_security_hold`.

-- ---------------------------------------------------------------------------
-- The setting
-- ---------------------------------------------------------------------------

create or replace function platform_owns_verification(p_tenant uuid) returns boolean
language sql
stable
as $$
  select setting_num(p_tenant, 'platform_owns_verification', 1) <> 0;
$$;

comment on function platform_owns_verification(uuid) is
  'Whether this tenant''s own platform owns seller and destination verification '
  '(§29.18). On by default (20260911000004). Supersedes seller_verification_relay. '
  'Read under the row lock by verify_seller and verify_seller_destination, and at '
  'insert by auto_verify_seller, seed_primary_destination and add_seller_destination.';

grant execute on function platform_owns_verification(uuid) to authenticated, service_role;

-- The reported name, validated once for both functions. A credential or the
-- system reports nobody; a blank reports nobody either.
create or replace function relayed_verifier(p_reported text) returns text
language plpgsql
immutable
as $$
declare
  v text := nullif(btrim(p_reported), '');
begin
  if v is null then
    raise exception 'invalid_request: a relayed verification must name the person on your platform who checked it (verified_by)'
      using errcode = 'check_violation';
  end if;
  if length(v) > 200 then
    raise exception 'invalid_request: verified_by must be 200 characters or fewer'
      using errcode = 'check_violation';
  end if;
  if starts_with(lower(v), 'api_key:') or starts_with(lower(v), 'system') then
    raise exception 'invalid_request: verified_by must name the person who checked it, not "%"', v
      using errcode = 'check_violation';
  end if;
  return v;
end;
$$;

revoke all on function relayed_verifier(text) from public, anon, authenticated;
revoke all on function relayed_verifier(text) from payhold_ai;

-- ---------------------------------------------------------------------------
-- What a verification records
-- ---------------------------------------------------------------------------

alter table sellers
  add column if not exists verifier_source text,
  add column if not exists reported_verifier text;

alter table seller_destinations
  add column if not exists verifier_source text,
  add column if not exists reported_verifier text;

alter table sellers drop constraint if exists sellers_verifier_source_known;
alter table sellers add constraint sellers_verifier_source_known
  check (verifier_source in ('person', 'platform_reported'));
alter table sellers drop constraint if exists sellers_reported_verifier_shape;
alter table sellers add constraint sellers_reported_verifier_shape
  check ((verifier_source is not distinct from 'platform_reported') = (reported_verifier is not null)
         and (reported_verifier is null or btrim(reported_verifier) <> ''));

alter table seller_destinations drop constraint if exists seller_destinations_verifier_source_known;
alter table seller_destinations add constraint seller_destinations_verifier_source_known
  check (verifier_source in ('person', 'platform_reported'));
alter table seller_destinations drop constraint if exists seller_destinations_reported_verifier_shape;
alter table seller_destinations add constraint seller_destinations_reported_verifier_shape
  check ((verifier_source is not distinct from 'platform_reported') = (reported_verifier is not null)
         and (reported_verifier is null or btrim(reported_verifier) <> ''));

comment on column sellers.verifier_source is
  '§29.18: whose word the latest identity decision was — person (signed in to '
  'PayHold) or platform_reported (relayed over the tenant''s API key). Null on a '
  'row no verification call has touched since 20260911000004.';
comment on column sellers.reported_verifier is
  'The name the tenant''s platform reported with a relayed decision. PayHold '
  'authenticated the credential, not this person.';
comment on column seller_destinations.verifier_source is
  '§29.18: whose word the latest verification decision on this destination was.';
comment on column seller_destinations.reported_verifier is
  'The name the tenant''s platform reported with a relayed decision.';

-- ---------------------------------------------------------------------------
-- Seller verification
-- ---------------------------------------------------------------------------
--
-- `20260910000011`'s function, dropped for the new parameter and recreated. The
-- revokes at the bottom are reissued because a recreated function is granted to
-- PUBLIC again.

drop function if exists verify_seller(uuid, text, boolean, boolean);

create function verify_seller(
  p_seller            uuid,
  p_actor             text,
  p_verified          boolean default true,
  p_via_api_key       boolean default false,
  p_reported_verifier text default null
) returns sellers
language plpgsql
security definer
set search_path = public
as $$
declare
  s          sellers;
  v_relayed  boolean;
  v_reported text;
begin
  if p_actor is null or btrim(p_actor) = '' then
    raise exception 'policy_violation: a verification must record who made it'
      using errcode = 'check_violation';
  end if;

  -- Locked and read before either setting is asked, because the tenant whose
  -- settings govern this call is the seller's. The lock is the one
  -- `add_seller_destination` takes on the same row.
  select * into s from sellers where id = p_seller for update;

  if not found then
    raise exception 'not_found: seller % does not exist', p_seller
      using errcode = 'no_data_found';
  end if;

  -- A credential is relayed whether or not the caller remembered to say so.
  v_relayed := coalesce(p_via_api_key, false) or starts_with(p_actor, 'api_key:');

  if v_relayed then
    -- Ownership supersedes the relay: with it on, a stored relay of 0 does not
    -- make a seller unverifiable.
    if not platform_owns_verification(s.tenant_id)
       and not seller_verification_relay(s.tenant_id) then
      raise exception 'verification_relay_off: seller % belongs to an account that has not turned on verification relay, so only a person may verify them', p_seller
        using errcode = 'check_violation';
    end if;
    v_reported := relayed_verifier(p_reported_verifier);
  else
    -- Both directions. Withdrawing is the safe direction, but a person here
    -- overturning the platform's decision is exactly what the owner said should
    -- not happen, and the platform can withdraw it itself.
    if platform_owns_verification(s.tenant_id) then
      raise exception 'verification_owned_by_platform: Your platform verifies sellers and their payout accounts for this account, so neither can be verified or un-verified in PayHold.'
        using errcode = 'check_violation';
    end if;
    if p_reported_verifier is not null then
      raise exception 'invalid_request: only a relayed verification reports a verifier'
        using errcode = 'check_violation';
    end if;
  end if;

  update sellers
     set kyc_status = case when p_verified then 'verified'::kyc_status
                           else 'review_required'::kyc_status end,
         sanctions_checked_at = case when p_verified then now() else sanctions_checked_at end,
         verifier_source = case when v_relayed then 'platform_reported' else 'person' end,
         reported_verifier = v_reported
   where id = s.id
  returning * into s;

  -- The identity attestation carries the destination with it only where the
  -- person making it was looking at both. A relayed one never does: a payout
  -- account is its own relayed decision.
  if p_verified and not v_relayed then
    update seller_destinations
       set verifier_source   = case when verified_at is null then 'person' else verifier_source end,
           reported_verifier = case when verified_at is null then null else reported_verifier end,
           verified_at       = coalesce(verified_at, now())
     where seller_id = p_seller and is_primary;
  end if;

  perform write_audit(s.tenant_id, null, p_actor,
    case when p_verified then 'seller.verified' else 'seller.review_required' end,
    jsonb_build_object(
      'seller_id', s.id,
      'name', s.name,
      'attested_by', case when v_relayed then 'tenant_verification_relay'
                          else 'person' end,
      'verifier_source', s.verifier_source,
      'reported_verifier', s.reported_verifier));

  return s;
end;
$$;

comment on function verify_seller(uuid, text, boolean, boolean, text) is
  'Records §12''s attestation for one seller (§29.18). Relayed (an API key, or an '
  'api_key: actor) it needs a reported verifier and is accepted while the tenant '
  'owns verification or has the relay on; from a person it is refused while the '
  'tenant owns verification. A relayed call stamps no destination.';

revoke all on function verify_seller(uuid, text, boolean, boolean, text)
  from public, anon, authenticated;
revoke all on function verify_seller(uuid, text, boolean, boolean, text) from payhold_ai;

-- ---------------------------------------------------------------------------
-- Destination verification
-- ---------------------------------------------------------------------------
--
-- `20260911000003`'s function, dropped for the new parameters and recreated.
-- The archived refusal stays. The security hold is not touched, in either
-- direction, on either path.

drop function if exists verify_seller_destination(uuid, uuid, text, boolean);

create function verify_seller_destination(
  p_destination       uuid,
  p_tenant            uuid,
  p_actor             text,
  p_verified          boolean default true,
  p_via_api_key       boolean default false,
  p_reported_verifier text default null
) returns seller_destinations
language plpgsql
security definer
set search_path = public
as $$
declare
  d          seller_destinations;
  v_relayed  boolean;
  v_reported text;
begin
  if p_actor is null or btrim(p_actor) = '' then
    raise exception 'policy_violation: verifying a destination must record who verified it'
      using errcode = 'check_violation';
  end if;

  select * into d from seller_destinations
   where id = p_destination and tenant_id = p_tenant
     for update;

  if not found then
    raise exception 'not_found: destination % does not exist', p_destination
      using errcode = 'no_data_found';
  end if;

  v_relayed := coalesce(p_via_api_key, false) or starts_with(p_actor, 'api_key:');

  if v_relayed then
    -- No relay setting reaches this: a payout account is relayed only by an
    -- account that has handed verification to its platform.
    if not platform_owns_verification(p_tenant) then
      raise exception 'destination_relay_off: This account verifies payout destinations in PayHold, so an API key cannot.'
        using errcode = 'check_violation';
    end if;
    v_reported := relayed_verifier(p_reported_verifier);
  else
    if platform_owns_verification(p_tenant) then
      raise exception 'verification_owned_by_platform: Your platform verifies sellers and their payout accounts for this account, so neither can be verified or un-verified in PayHold.'
        using errcode = 'check_violation';
    end if;
    if p_reported_verifier is not null then
      raise exception 'invalid_request: only a relayed verification reports a verifier'
        using errcode = 'check_violation';
    end if;
  end if;

  if d.archived_at is not null then
    raise exception 'destination_archived: This payout destination was replaced, so it can no longer be verified. Verify the seller''s current destination instead.'
      using errcode = 'check_violation';
  end if;

  if (p_verified and d.verified_at is not null)
     or (not p_verified and d.verified_at is null) then
    return d;
  end if;

  update seller_destinations
     set verified_at = case when p_verified then now() else null end,
         verifier_source = case when v_relayed then 'platform_reported' else 'person' end,
         reported_verifier = v_reported
   where id = d.id
  returning * into d;

  perform write_audit(
    p_tenant, null, p_actor,
    case when p_verified then 'seller.destination_verified'
         else 'seller.destination_verification_withdrawn' end,
    jsonb_build_object(
      'seller_id', d.seller_id,
      'destination_id', d.id,
      'destination', d.masked_destination,
      'is_primary', d.is_primary,
      'verifier_source', d.verifier_source,
      'reported_verifier', d.reported_verifier
    )
  );

  return d;
end;
$$;

comment on function verify_seller_destination(uuid, uuid, text, boolean, boolean, text) is
  '§5.1''s per-destination attestation (§29.18). Relayed only while the tenant owns '
  'verification, with a reported verifier; refused from a person while it does. '
  'Refuses an archived destination. Never touches the security hold.';

revoke all on function verify_seller_destination(uuid, uuid, text, boolean, boolean, text)
  from public, anon, authenticated;
revoke all on function verify_seller_destination(uuid, uuid, text, boolean, boolean, text)
  from payhold_ai;

-- ---------------------------------------------------------------------------
-- Auto-verify writes nothing verified while the platform owns verification
-- ---------------------------------------------------------------------------
--
-- `20260817000002`'s two functions and `20260911000003`'s
-- `add_seller_destination`, each with one line changed: what counts as
-- `trusted`. Same signatures, so `create or replace`; the revokes and the grant
-- are reissued anyway.

create or replace function auto_verify_seller() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  trusted boolean;
begin
  trusted := seller_auto_verify(new.tenant_id)
             and not platform_owns_verification(new.tenant_id);

  if not trusted then
    return new;
  end if;

  new.kyc_status := 'verified';
  new.sanctions_checked_at := now();

  perform write_audit(new.tenant_id, null, 'system', 'seller.auto_verified',
    jsonb_build_object('seller_id', new.id, 'name', new.name));

  return new;
end;
$$;

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

  trusted := seller_auto_verify(new.tenant_id)
             and not platform_owns_verification(new.tenant_id);

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

revoke all on function auto_verify_seller() from public, anon, authenticated;
revoke all on function seed_primary_destination() from public, anon, authenticated;

create or replace function add_seller_destination(
  p_seller   uuid,
  p_tenant   uuid,
  p_country  country_code,
  p_currency currency_code,
  p_provider payout_provider,
  p_token    text,
  p_masked   text,
  p_label    text default null,
  -- Kept for the functions deployed before `20260911000003`, which still send
  -- it. `'primary'` (or nothing) is the only thing it can mean now.
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
  v_archived uuid[];
begin
  if p_role is not null and p_role <> 'primary' then
    raise exception 'backup_destination_removed: A seller has one payout destination; adding one replaces the current one.'
      using errcode = 'check_violation';
  end if;

  if p_token is null or btrim(p_token) = '' or p_masked is null or btrim(p_masked) = '' then
    raise exception 'policy_violation: a destination needs a token and a mask'
      using errcode = 'check_violation';
  end if;

  -- Locked, and tenant-scoped in the same statement. Two concurrent changes
  -- would otherwise both archive the same row and the second insert would lose
  -- to `seller_destinations_one_live` with a message about an index.
  select * into s from sellers
   where id = p_seller and tenant_id = p_tenant
     for update;

  if not found then
    raise exception 'not_found: seller % does not exist', p_seller
      using errcode = 'no_data_found';
  end if;

  -- Archive first. `seller_destinations_one_primary` and `_one_live` both refuse
  -- the overlap, so the order is forced. `replaced_by` is filled in after the
  -- insert: the new row's id does not exist yet, and the foreign key is checked
  -- per statement. Writing `is_primary = false` is what the sync trigger reads
  -- as "not mine", so the seller's columns are untouched until the insert.
  with archived as (
    update seller_destinations
       set archived_at = now(),
           is_primary  = false,
           is_backup   = false
     where seller_id = p_seller
       and archived_at is null
    returning id
  )
  select coalesce(array_agg(id order by id), '{}') into v_archived from archived;

  -- A tenant that attests to its own onboarding gets a verified row out of
  -- hold — unless its platform owns verification (§29.18), in which case the
  -- platform relays the decision and the hold runs like anyone's.
  trusted    := seller_auto_verify(p_tenant) and not platform_owns_verification(p_tenant);
  hold_hours := case when trusted then 0
                     else setting_num(p_tenant, 'destination_hold_hours', 24)::integer end;

  insert into seller_destinations (
    tenant_id, seller_id, label, country, payout_currency, payout_provider,
    beneficiary_token, masked_destination, is_primary, is_backup,
    verified_at, security_hold_until
  )
  values (
    p_tenant, p_seller, p_label, p_country, p_currency, p_provider,
    p_token, p_masked, true, false,
    case when trusted then now() end,
    now() + make_interval(hours => hold_hours)
  )
  returning * into d;

  -- Not `returning * into d`: that would overwrite the row this returns. The
  -- archived rows are not primary, so the sync trigger ignores this write.
  update seller_destinations
     set replaced_by = d.id
   where id = any(v_archived);

  -- The mask, never the token (§19).
  perform write_audit(
    p_tenant, null, coalesce(nullif(btrim(p_actor), ''), 'api'),
    'seller.destination_added',
    jsonb_build_object(
      'seller_id', p_seller,
      'destination_id', d.id,
      'destination', d.masked_destination,
      'provider', d.payout_provider,
      'role', 'primary',
      'security_hold_until', d.security_hold_until,
      'auto_verified', trusted,
      'archived_destination_ids', to_jsonb(v_archived)
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
grant execute on function add_seller_destination(
  uuid, uuid, country_code, currency_code, payout_provider, text, text, text, text, text
) to service_role;

-- ---------------------------------------------------------------------------
-- A held destination is a no-route, wherever it is read
-- ---------------------------------------------------------------------------
--
-- `20260910000009`'s sentence table with one sentence added.

create or replace function route_reason_text(
  p_code     text,
  p_rail     payout_provider,
  p_country  country_code,
  p_currency currency_code
) returns text
language sql
immutable
as $$
  select case p_code
    when 'routed' then
      format('Paid by %s.', rail_label(p_rail))
    when 'market_closed' then
      'Payouts to this market are paused at the moment.'
    when 'provider_unavailable' then
      format('%s payouts are not available yet.', rail_label(p_rail))
    when 'provider_disabled' then
      format('%s payouts are not available yet.', rail_label(p_rail))
    when 'route_suspended' then
      format('%s payouts are suspended.', rail_label(p_rail))
    when 'route_under_review' then
      format('%s payouts are under review and cannot be used right now.', rail_label(p_rail))
    when 'payouts_not_supported' then
      format('%s can collect payments but cannot send them.', rail_label(p_rail))
    when 'country_not_supported' then
      format('%s payouts are not available in this market.', rail_label(p_rail))
    -- The currency code stays, and stays deliberately: it is what the money
    -- arrives as, and a host who is owed RWF should see RWF. The rail id and
    -- the country code are ours; the currency is theirs.
    when 'currency_not_supported' then
      format('%s cannot pay out in %s.', rail_label(p_rail), p_currency)
    when 'below_route_minimum' then
      format('This amount is below the minimum %s will send.', rail_label(p_rail))
    when 'above_route_maximum' then
      format('This amount is above the maximum %s will send.', rail_label(p_rail))
    when 'destination_not_verified' then
      'The payout destination has not been verified.'
    when 'destination_in_security_hold' then
      'The payout destination is new and still in its security hold.'
    when 'no_eligible_verified_destination' then
      'No verified payout destination has been registered.'
    else
      format('%s cannot be used for this payout.', rail_label(p_rail))
  end;
$$;

grant execute on function route_reason_text(text, payout_provider, country_code, currency_code)
  to authenticated, service_role;

-- `20260911000003`'s function. One change: the destination it would route to
-- must be out of its security hold, or the answer is
-- `destination_in_security_hold`. The requested-destination read already
-- required that; the primary it falls back to now does too.

create or replace function route_payout(p_payout uuid)
returns payout_decisions
language plpgsql
security definer
set search_path = public
as $$
declare
  p            payouts;
  d            deals;
  s            sellers;
  dest         seller_destinations;
  v_route_id   uuid;
  v_provider   provider;
  v_rail       payout_provider;
  v_method     payout_method;
  v_rank       integer;
  v_fee        bigint;
  checks       jsonb;
  v_reason     text;
  v_fx_source  text;
  decision     payout_decisions;
  previous     payout_decisions;
begin
  select * into p from payouts where id = p_payout for update;

  if not found then
    raise exception 'not_found: payout % does not exist', p_payout
      using errcode = 'no_data_found';
  end if;

  -- A payout the provider already has is not re-routed. Choosing a different
  -- destination for money in flight is the silent redirection §5.1 forbids, and
  -- it could not take effect anyway.
  if p.status in ('paid', 'processing') then
    raise exception 'invalid_state: payout % is already with the provider', p_payout
      using errcode = 'check_violation';
  end if;

  select * into d from deals where id = p.deal_id;
  select * into s from sellers where id = p.seller_id;

  -- The seller's own choice, if this payout carries one and it still stands.
  -- Re-checked here rather than trusted from `request_withdrawal`: a
  -- verification can be withdrawn between the ask and the pass that sends it,
  -- and this is the read that happens under the payout's own lock.
  if p.requested_destination_id is not null then
    select * into dest
      from seller_destinations
     where id = p.requested_destination_id
       and seller_id = p.seller_id
       and archived_at is null
       and verified_at is not null
       and (security_hold_until is null or security_hold_until <= now());
  end if;

  -- No choice, or one that no longer holds: their primary, exactly as before.
  -- Falling back to the primary rather than refusing is not the silent
  -- redirection §5.1 forbids — the primary is the destination the seller
  -- already nominated, and every eligibility check below still applies to it.
  if dest.id is null then
    select * into dest
      from seller_destinations
     where seller_id = p.seller_id and is_primary and archived_at is null;
  end if;

  -- The evaluation is recorded against the destination we would prefer to use,
  -- so `checks` answers "why not the seller's own choice" rather than "why not
  -- some rail nobody asked for".
  select coalesce(jsonb_agg(to_jsonb(e) order by e.eligible desc, e.rank), '[]'::jsonb)
    into checks
    from route_evaluation(
      p.tenant_id,
      coalesce(dest.country, s.country),
      p.currency,
      p.amount,
      coalesce(dest.payout_provider, s.payout_provider)
    ) e;

  -- §5.1's change protection, read here as well as in `screen_payout`: a
  -- destination still inside its hold is not one money may be routed to,
  -- however it came to be verified.
  if dest.id is not null and dest.verified_at is not null
     and (dest.security_hold_until is null or dest.security_hold_until <= now()) then
    select e.route_id, e.provider, e.payout_provider, e.method, e.rank, e.fee_estimate
      into v_route_id, v_provider, v_rail, v_method, v_rank, v_fee
      from route_evaluation(p.tenant_id, dest.country, p.currency, p.amount,
                            dest.payout_provider) e
     where e.eligible and e.preferred
     limit 1;
  end if;

  -- §5.1's currency handling. A payout in the currency that was collected has
  -- no rate to show; one that was converted names where the rate came from.
  if d.presentment_currency is distinct from p.currency then
    v_fx_source := case
      when d.fx_rate is not null then 'deal_locked_rate'
      else 'payhold_indicative'
    end;
  end if;

  if v_route_id is null then
    -- The most specific true statement, in the order a seller can act on it.
    v_reason := case
      when dest.id is null then 'no_eligible_verified_destination'
      when dest.verified_at is null then 'destination_not_verified'
      when dest.security_hold_until is not null and dest.security_hold_until > now()
        then 'destination_in_security_hold'
      else coalesce(
        (select e.reason_code
           from route_evaluation(p.tenant_id, dest.country, p.currency, p.amount,
                                 dest.payout_provider) e
          where e.preferred
          limit 1),
        'no_route_for_destination'
      )
    end;
  else
    v_reason := 'routed';
  end if;

  select * into previous
    from payout_decisions
   where payout_id = p.id
   order by created_at desc, id desc
   limit 1;

  if previous.id is not null
     and previous.reason_code = v_reason
     and previous.destination_id is not distinct from dest.id
     and previous.route_id is not distinct from v_route_id
  then
    decision := previous;
  else
    insert into payout_decisions (
      tenant_id, payout_id, route_id, destination_id, provider, payout_provider,
      method, currency, amount, ranking_score, fee_estimate, fx_source, fx_rate,
      is_fallback, reason_code, checks
    ) values (
      p.tenant_id, p.id, v_route_id, dest.id, v_provider, v_rail, v_method,
      p.currency, p.amount, v_rank, v_fee, v_fx_source,
      case when v_fx_source is null then null else d.fx_rate end,
      false, v_reason, checks
    )
    returning * into decision;
  end if;

  if v_route_id is null then
    -- §5.1's no-route behaviour: keep the amount, say why, ask for a
    -- destination. Nothing is discarded and nothing is rerouted.
    --
    -- `failed` is left alone. A provider that refused a transfer is a more
    -- specific fact than "no route", and it is what the retry backoff reads.
    if p.status not in ('failed', 'blocked') then
      update payouts
         set status = 'blocked',
             failure_reason = route_reason_text(
               v_reason,
               coalesce(dest.payout_provider, s.payout_provider),
               coalesce(dest.country, s.country),
               p.currency)
       where id = p.id;
    end if;

    perform write_audit(p.tenant_id, p.deal_id, 'system', 'payout.blocked',
      jsonb_build_object(
        'payout_id', p.id,
        'reason_code', v_reason,
        'checks', checks
      ));

    return decision;
  end if;

  update payouts
     set destination_id = dest.id,
         -- A route exists again, so whatever the routing engine last said no
         -- longer holds. Leaving the old sentence would have an operator
         -- reading a stale reason against a payout that is about to go.
         failure_reason = case when p.status = 'blocked' then null
                               else p.failure_reason end,
         status = case when p.status = 'blocked' then 'scheduled'::payout_status
                       else p.status end
   where id = p.id;

  return decision;
end;
$$;

revoke all on function route_payout(uuid) from public, anon, authenticated;
revoke all on function route_payout(uuid) from payhold_ai;
