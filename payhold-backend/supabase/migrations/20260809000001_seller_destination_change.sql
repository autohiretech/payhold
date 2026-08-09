-- ---------------------------------------------------------------------------
-- §5.1: a seller may move where they are paid
-- ---------------------------------------------------------------------------
--
-- `seller_destinations` has been the record since migration 007, and every
-- reader of it — `route_payout`, `seller_capabilities`, `request_withdrawal`,
-- `dispatch` — has been able to cope with a seller who has several. Nothing
-- could give them one. The table had exactly two writers: the trigger that
-- seeds the primary when a seller is created, and `verify_seller` stamping a
-- verification onto it. A seller whose MoMo line was cut off, or who closed the
-- bank account, had no way through the API to say so.
--
-- §5.1 requires the opposite: "the seller selects a preferred payout
-- destination, verifies ownership, and may add a backup." This is the writer
-- that makes that sentence true, and `POST /v1/sellers/:id/destinations` is its
-- only caller.
--
-- ## Why this is SQL and not three statements in the endpoint
--
-- Moving the primary is a swap: the old row has to stop being primary before
-- the new one can start, because `seller_destinations_one_primary` is a unique
-- index and will refuse the overlap. Two statements from an Edge Function are
-- two transactions, and the window between them is a seller with no primary
-- destination at all — which `route_payout` reads as "no eligible verified
-- destination" and `seller_capabilities` reads as "no payout destination has
-- been registered". A payout dispatched in that window is one nobody could
-- explain afterwards.
--
-- The provider call stays outside: tokenizing is the Edge Function's job, and
-- this takes the token it got back. Postgres does not make HTTP requests, and a
-- transaction held open across a provider round trip is a lock held across
-- somebody else's outage.
--
-- ## What it deliberately does not do
--
-- It does not verify the new destination, and it does not skip the security
-- hold. §5.1's change protection is the whole reason a destination change is a
-- different operation from a registration: "a newly added destination enters a
-- short security hold and may require re-authentication or step-up verification
-- before use." Both fall out of the row this writes — `verified_at` null and
-- `security_hold_until` in the future are each independently enough for
-- `seller_capabilities` to refuse a payout, and `screen_payout` holds anything
-- already scheduled off the back of `destination_changed_at`.
--
-- That is the point rather than an inconvenience. The shape of an account
-- takeover is exactly this call: get in, move the destination, withdraw. The
-- hold is what makes that attempt visible to a person before the money leaves,
-- and a client that could turn it off would have removed the only defence.

create or replace function add_seller_destination(
  p_seller   uuid,
  p_tenant   uuid,
  p_country  country_code,
  p_currency currency_code,
  p_provider payout_provider,
  p_token    text,
  p_masked   text,
  p_label    text default null,
  -- 'primary' moves where the money goes; 'backup' is §5.1's secondary, reached
  -- only after a failed primary payout and an explicit routing check.
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
begin
  if p_role not in ('primary', 'backup') then
    raise exception 'policy_violation: a destination is primary or backup, not %', p_role
      using errcode = 'check_violation';
  end if;

  if p_token is null or btrim(p_token) = '' or p_masked is null or btrim(p_masked) = '' then
    raise exception 'policy_violation: a destination needs a token and a mask'
      using errcode = 'check_violation';
  end if;

  -- Locked, and tenant-scoped in the same statement. The lock is what serializes
  -- two concurrent changes: without it both read the same primary, both demote
  -- it, and the second insert loses to the unique index with a message about an
  -- index rather than about what happened.
  select * into s from sellers
   where id = p_seller and tenant_id = p_tenant
     for update;

  if not found then
    raise exception 'not_found: seller % does not exist', p_seller
      using errcode = 'no_data_found';
  end if;

  -- The outgoing row is demoted, never deleted. Payouts reference destinations,
  -- a paid one has to keep saying where it went, and a seller moving back to an
  -- account they used before should find it already verified rather than serving
  -- a second hold for a destination PayHold has seen paid.
  if p_role = 'primary' then
    update seller_destinations
       set is_primary = false
     where seller_id = p_seller and is_primary;
  else
    update seller_destinations
       set is_backup = false
     where seller_id = p_seller and is_backup;
  end if;

  hold_hours := setting_num(p_tenant, 'destination_hold_hours', 24)::integer;

  insert into seller_destinations (
    tenant_id, seller_id, label, country, payout_currency, payout_provider,
    beneficiary_token, masked_destination, is_primary, is_backup,
    security_hold_until
  )
  values (
    p_tenant, p_seller, p_label, p_country, p_currency, p_provider,
    p_token, p_masked, p_role = 'primary', p_role = 'backup',
    now() + make_interval(hours => hold_hours)
  )
  returning * into d;

  -- The mask, never the token. An audit log is where a payout destination would
  -- survive longest, and §19 says the real one exists nowhere on this side.
  perform write_audit(
    p_tenant, null, coalesce(nullif(btrim(p_actor), ''), 'api'),
    'seller.destination_added',
    jsonb_build_object(
      'seller_id', p_seller,
      'destination_id', d.id,
      'destination', d.masked_destination,
      'provider', d.payout_provider,
      'role', p_role,
      'security_hold_until', d.security_hold_until
    )
  );

  return d;
end;
$$;

revoke all on function add_seller_destination(
  uuid, uuid, country_code, currency_code, payout_provider, text, text, text, text, text
) from public, anon, authenticated;

grant execute on function add_seller_destination(
  uuid, uuid, country_code, currency_code, payout_provider, text, text, text, text, text
) to service_role;

comment on function add_seller_destination(
  uuid, uuid, country_code, currency_code, payout_provider, text, text, text, text, text
) is
  '§5.1: register a payout destination for a seller and make it their primary or '
  'backup, atomically. The new row is unverified and inside its security hold — '
  'both by design, and neither is skippable by the caller.';
