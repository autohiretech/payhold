-- ---------------------------------------------------------------------------
-- Keeping a seller's name in sync with the client's own record of them
-- ---------------------------------------------------------------------------
--
-- `sellers.name` was write-once: `create` sets it and nothing ever touched it
-- again. A client's own name for that person can change after registration —
-- AutoHire's own example is a profile edit — and until now PayHold had no way
-- to be told. The Sellers dashboard kept showing whatever name was on file the
-- day the seller was created, drifting further from the truth every time the
-- client's side changed. A dashboard that identifies who money is owed to by a
-- name nobody can update again is a name an operator has no way to trust.
--
-- Shaped exactly like `set_seller_active` (20260815000001): the client is
-- restating a fact it already knows firsthand about its own business, so the
-- endpoint in front of this accepts an API key rather than an attestation.
-- Audited the same way, so a rename shows up next to `seller.activated` /
-- `seller.deactivated` in the same trail rather than going unrecorded.

create or replace function set_seller_name(
  p_seller uuid,
  p_tenant uuid,
  p_name   text,
  p_actor  text
) returns sellers
language plpgsql
security definer
set search_path = public
as $$
declare
  s      sellers;
  v_name text := btrim(p_name);
begin
  if v_name = '' then
    raise exception 'policy_violation: name cannot be blank'
      using errcode = 'raise_exception';
  end if;

  update sellers
     set name = v_name
   where id = p_seller and tenant_id = p_tenant
  returning * into s;

  if not found then
    raise exception 'not_found: seller % does not exist', p_seller
      using errcode = 'no_data_found';
  end if;

  perform write_audit(s.tenant_id, null, coalesce(nullif(btrim(p_actor), ''), 'api'),
    'seller.renamed', jsonb_build_object('seller_id', s.id, 'name', s.name));

  return s;
end;
$$;

revoke all on function set_seller_name(uuid, uuid, text, text)
  from public, anon, authenticated;
revoke all on function set_seller_name(uuid, uuid, text, text) from payhold_ai;
