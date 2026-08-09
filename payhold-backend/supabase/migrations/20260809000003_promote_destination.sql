-- ---------------------------------------------------------------------------
-- §5.1: moving back to a destination we have already checked
-- ---------------------------------------------------------------------------
--
-- `20260809000001` said this in its own header and did not implement it:
--
--   "a seller moving back to an account PayHold has already verified should
--    not serve a second hold for it"
--
-- `add_seller_destination` is the only way to change where a seller is paid,
-- and it always **inserts**. So a seller whose card destination turned out to
-- be unroutable and who wanted their old mobile-money line back got a brand new
-- row, unverified, inside a fresh 24-hour hold — for a destination this system
-- had already tokenized, already verified and already held once. The demoted
-- row sat right beside it, verified, unreachable by any endpoint.
--
-- That is a gap rather than a policy, and it is the expensive kind: the safe
-- action was the slow one, so the pressure was always to reach for something
-- looser instead.
--
-- ## What keeps this from being a way around the hold
--
-- Promotion is refused unless the destination is **already verified** and its
-- hold has **already lapsed**. Both are checked under the seller's lock, so the
-- only thing this can reach is a destination a person has already attested to
-- and which has already served its time. A takeover cannot promote its way to
-- anything: a freshly added destination fails both checks, and the way in
-- stays `add_seller_destination` with its hold intact.
--
-- That is a narrower door than `end_destination_hold` next door, which a person
-- can open on a destination nobody has checked. Promotion opens nothing — it
-- picks between destinations already checked.
--
-- ## Why it stamps `security_hold_until` on the way through
--
-- `sync_primary_destination` sets `sellers.destination_changed_at = now()`
-- whenever the primary's token moves, and it is right to: the primary really
-- did move. But `screen_payout` reads that timestamp as a hold, so a promotion
-- would arm a fresh 24 hours against a destination that just passed the test
-- for having none.
--
-- `20260809000002` is what makes this expressible. `screen_payout` now reads
-- `seller_destinations.security_hold_until` wherever it exists and falls back
-- to the seller timestamp only where it does not — so stamping the promoted row
-- with `coalesce(security_hold_until, now())` says the thing that is true:
-- this destination's hold is over. A row seeded by
-- `sellers_seed_primary_destination` carries no stamp at all, which is exactly
-- the row this is for, and it acquires one here rather than falling through to
-- a timestamp the trigger is about to overwrite.

create or replace function promote_seller_destination(
  p_destination uuid,
  p_tenant      uuid,
  p_actor       text
) returns seller_destinations
language plpgsql
security definer
set search_path = public
as $$
declare
  s      sellers;
  d      seller_destinations;
  v_from text;
begin
  if p_actor is null or btrim(p_actor) = '' then
    raise exception 'policy_violation: moving a payout destination must record who moved it'
      using errcode = 'check_violation';
  end if;

  select * into d from seller_destinations
   where id = p_destination and tenant_id = p_tenant;

  if not found then
    raise exception 'not_found: destination % does not exist', p_destination
      using errcode = 'no_data_found';
  end if;

  -- The seller, locked, for the reason `add_seller_destination` locks it: two
  -- concurrent changes would both read the same primary, both demote it, and
  -- the second promotion would lose to `seller_destinations_one_primary` with a
  -- message about an index rather than about what happened.
  select * into s from sellers
   where id = d.seller_id and tenant_id = p_tenant
     for update;

  if not found then
    raise exception 'not_found: seller % does not exist', d.seller_id
      using errcode = 'no_data_found';
  end if;

  -- Idempotent. Promoting the destination that is already primary is not an
  -- error, and it must not write an audit row saying somebody moved something.
  if d.is_primary then
    return d;
  end if;

  -- The two conditions that make this narrower than adding a destination. Both
  -- are re-read here rather than trusted from the endpoint, because this is the
  -- read that happens under the lock — a verification can be withdrawn between
  -- the click and the statement.
  if d.verified_at is null then
    raise exception 'policy_violation: only a verified destination can be made primary — add it as a new destination instead'
      using errcode = 'check_violation';
  end if;

  if d.security_hold_until is not null and d.security_hold_until > now() then
    raise exception 'policy_violation: this destination is still inside its security hold'
      using errcode = 'check_violation';
  end if;

  v_from := s.masked_destination;

  -- Demote first. `seller_destinations_one_primary` is a unique index and will
  -- refuse the overlap, so the order is forced rather than chosen — and both
  -- statements being one transaction is why this is SQL and not two calls from
  -- the Edge Function.
  update seller_destinations
     set is_primary = false
   where seller_id = d.seller_id and is_primary;

  update seller_destinations
     set is_primary = true,
         -- No longer the backup if it was: §5.1's backup is the destination a
         -- failed primary falls to, and one row cannot be both.
         is_backup = false,
         -- Says what is true — this destination's hold is over — in the column
         -- `screen_payout` now reads first. Without it the trigger below stamps
         -- `destination_changed_at` and the fallback arms a hold against a
         -- destination that just proved it needs none.
         security_hold_until = coalesce(security_hold_until, now())
   where id = d.id
  returning * into d;

  -- The mask, never the token (§19).
  perform write_audit(
    p_tenant, null, p_actor, 'seller.destination_promoted',
    jsonb_build_object(
      'seller_id', d.seller_id,
      'destination_id', d.id,
      'moved_from', v_from,
      'moved_to', d.masked_destination,
      'provider', d.payout_provider,
      'verified_at', d.verified_at
    )
  );

  return d;
end;
$$;

comment on function promote_seller_destination(uuid, uuid, text) is
  '§5.1: make an already-verified destination the primary again, without the '
  'second security hold `add_seller_destination` would impose on a row this '
  'system has already checked. Refuses an unverified destination and one still '
  'inside its hold, so it cannot be used to reach anything new.';

revoke all on function promote_seller_destination(uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function promote_seller_destination(uuid, uuid, text) from payhold_ai;
