-- ---------------------------------------------------------------------------
-- Whether a seller is currently active — a fact only the tenant knows
-- ---------------------------------------------------------------------------
--
-- `kyc_status` says whether a seller has been checked; nothing on the row said
-- whether they are *currently* one of the tenant's active sellers, as opposed
-- to someone who used to be. AutoHire's own example is exactly this: a host
-- who switches back to renting is not deleted from anywhere — money may still
-- be owed to them — but their own system knows they stopped hosting, and
-- PayHold had no column to be told.
--
-- Status only, and deliberately so. `active` carries no weight in
-- `screen_payout` or anywhere else on the payout path: a seller who steps back
-- mid-clearance-window is still owed whatever they already earned, and
-- invariant 11 already draws the line on what may stop a payout — a fact a
-- client toggles about its own business is not that. If a tenant later wants
-- inactivity to *hold* a payout, that is a deliberate policy decision belonging
-- next to the eligibility gate, not a side effect of this column existing.
--
-- Defaults `true`: every seller that already exists is presumed active, and a
-- migration is not the place to guess otherwise.

alter table sellers
  add column active boolean not null default true;

-- ---------------------------------------------------------------------------
-- Setting it
-- ---------------------------------------------------------------------------
--
-- Shaped like `verify_seller` with one difference: this is not an attestation,
-- it is the client restating a fact about its own business, so the endpoint in
-- front of it accepts an API key — the same reasoning `request_withdrawal`
-- accepts one for "ask for money that already cleared every check". A tenant
-- that could not tell PayHold "this host stopped hosting" without a person in
-- the loop would have to route every role toggle through its dashboard, which
-- is not where its hosts are.

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
  s sellers;
begin
  update sellers
     set active = p_active
   where id = p_seller and tenant_id = p_tenant
  returning * into s;

  if not found then
    raise exception 'not_found: seller % does not exist', p_seller
      using errcode = 'no_data_found';
  end if;

  perform write_audit(s.tenant_id, null, coalesce(nullif(btrim(p_actor), ''), 'api'),
    case when p_active then 'seller.activated' else 'seller.deactivated' end,
    jsonb_build_object('seller_id', s.id, 'name', s.name));

  return s;
end;
$$;

revoke all on function set_seller_active(uuid, uuid, boolean, text)
  from public, anon, authenticated;
revoke all on function set_seller_active(uuid, uuid, boolean, text) from payhold_ai;
