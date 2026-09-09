-- `verify_seller_destination` — the attestation §5.1 asks for per destination,
-- which until now could only be made for whichever one happened to be primary.
--
-- `verify_seller` stamps `verified_at` with `where seller_id = p_seller and
-- is_primary`, and that was right while a seller had one destination. §5.1 gave
-- them two — "a preferred destination and a **verified backup**" — and nothing
-- was ever able to verify the second one. The result is a deadlock a seller
-- cannot get out of and an operator cannot help with:
--
--   * `verify_seller` will not stamp a destination that is not primary
--   * `promote_seller_destination` refuses one whose `verified_at is null`
--
-- so a destination that was displaced before anybody verified it can never be
-- verified, and can never become primary in order to be verified. It is not a
-- missing button — there is no function underneath it. The visible cost is a
-- row reading "Not verified" forever; the real one is that `route_payout`'s
-- backup-destination fallback requires `verified_at is not null`, so §5.1's
-- whole failover path is unreachable for any backup that was not verified
-- during its own turn as primary.
--
-- One attestation per destination, deliberately, rather than widening
-- `verify_seller` to stamp them all. Verifying a seller answers "is this person
-- who they say they are"; verifying a destination answers "does this account
-- belong to them", and a seller can add a destination years after their
-- identity was checked. Stamping every row from one click would let a single
-- press cover destinations nobody has looked at, including ones added later —
-- which is the shape `add_seller_destination`'s header already refuses for the
-- security hold, for the same reason.
--
-- What it does not do, and must not:
--
--   * **It does not end the security hold.** `end_destination_hold` is the
--     other stop and they attest to different things — that this change was
--     the seller's own act, versus that the account behind it is theirs. Each
--     stops a payout on its own and §5.1 wants both, so one quietly satisfying
--     the other is exactly what is being defended against.
--   * **It does not touch `sellers.kyc_status`.** That is `verify_seller`'s,
--     and a destination check is not an identity check.
--   * **It does not promote anything.** A verified non-primary destination is
--     a backup, which is what §5.1 calls it.
--
-- Withdrawing is the same function with `p_verified = false`, and it is allowed
-- on any destination including the primary: "I no longer stand behind this"
-- must never be the harder direction. It sets `verified_at` back to null, which
-- every reader already treats as unverified, and holds any payout that has not
-- gone.
--
-- Idempotent, and silent when it changes nothing — a second call must not put a
-- second person's name against a decision the first one made, which is
-- `end_destination_hold`'s rule and the reason the no-op path writes no audit
-- row.

create or replace function verify_seller_destination(
  p_destination uuid,
  p_tenant      uuid,
  p_actor       text,
  p_verified    boolean default true
) returns seller_destinations
language plpgsql
security definer
set search_path = public
as $$
declare
  d seller_destinations;
begin
  if p_actor is null or btrim(p_actor) = '' then
    raise exception 'policy_violation: verifying a destination must record who verified it'
      using errcode = 'check_violation';
  end if;

  -- Tenant-scoped in the same statement as the lock, for `end_destination_hold`'s
  -- reason: this is the row a concurrent destination change is also writing.
  select * into d from seller_destinations
   where id = p_destination and tenant_id = p_tenant
     for update;

  if not found then
    raise exception 'not_found: destination % does not exist', p_destination
      using errcode = 'no_data_found';
  end if;

  -- Already in the state being asked for. Return it unchanged and write
  -- nothing: see the header on why a no-op must not carry a name.
  if (p_verified and d.verified_at is not null)
     or (not p_verified and d.verified_at is null) then
    return d;
  end if;

  update seller_destinations
     set verified_at = case when p_verified then now() else null end
   where id = d.id
  returning * into d;

  -- The mask, never the token. §19: the real destination exists nowhere on
  -- this side, and an audit log is where one would survive longest.
  perform write_audit(
    p_tenant, null, p_actor,
    case when p_verified then 'seller.destination_verified'
         else 'seller.destination_verification_withdrawn' end,
    jsonb_build_object(
      'seller_id', d.seller_id,
      'destination_id', d.id,
      'destination', d.masked_destination,
      'is_primary', d.is_primary
    )
  );

  return d;
end;
$$;

revoke all on function verify_seller_destination(uuid, uuid, text, boolean)
  from public, anon, authenticated;
