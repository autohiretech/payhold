-- ---------------------------------------------------------------------------
-- `set_seller_active` writes an audit row only when the value actually moves
-- ---------------------------------------------------------------------------
--
-- Found wiring AutoHire's side up: `payhold-ensure-seller`'s cheap "already
-- linked" path needs to reactivate a seller that went inactive, and the only
-- way to know whether one is inactive without a second round trip is to call
-- `set_seller_active(..., true, ...)` unconditionally on every toggle to host
-- mode. That is the overwhelmingly common case, and an unconditional write
-- would audit-log a no-op every single time — the same failure class
-- `destination_changed_at` avoids by stamping "only when it actually moved"
-- and `route_payout` avoids by not inserting an unchanged `payout_decisions`
-- row.
--
-- `create or replace` with an identical signature: same function, no `drop`,
-- and the revoke is reissued because a recreated function is granted to
-- PUBLIC again.

create or replace function set_seller_active(
  p_seller uuid,
  p_tenant uuid,
  p_active boolean,
  p_actor  text
) returns sellers
language plpgsql
security definer
set search_path = public
as $$
declare
  s      sellers;
  v_prev boolean;
begin
  select active into v_prev from sellers where id = p_seller and tenant_id = p_tenant;

  if not found then
    raise exception 'not_found: seller % does not exist', p_seller
      using errcode = 'no_data_found';
  end if;

  update sellers
     set active = p_active
   where id = p_seller and tenant_id = p_tenant
  returning * into s;

  if v_prev is distinct from p_active then
    perform write_audit(s.tenant_id, null, coalesce(nullif(btrim(p_actor), ''), 'api'),
      case when p_active then 'seller.activated' else 'seller.deactivated' end,
      jsonb_build_object('seller_id', s.id, 'name', s.name));
  end if;

  return s;
end;
$$;

revoke all on function set_seller_active(uuid, uuid, boolean, text)
  from public, anon, authenticated;
revoke all on function set_seller_active(uuid, uuid, boolean, text) from payhold_ai;
