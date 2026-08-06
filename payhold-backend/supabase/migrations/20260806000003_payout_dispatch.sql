-- ---------------------------------------------------------------------------
-- Payout dispatch: the in-flight state
-- ---------------------------------------------------------------------------
--
-- `settle_payout` books a transfer that has completed. This is the state
-- between the two: the provider accepted the transfer and has not yet said it
-- settled.
--
-- African rails settle asynchronously — `FlutterwaveProvider.release` returns
-- `pending` for anything not already terminal. Without a state for that, the
-- dispatch cron has two bad options: book it as paid, which credits a payout
-- that can still fail, or leave it `scheduled`, where an operator looking at
-- the row cannot tell a transfer that has not been sent from one that has.
--
-- Re-sending on the next pass is safe regardless — every provider method is
-- idempotent on `idempotency_key` — so this state is for the humans reading
-- the table, and for keeping `attempts` honest about how many transfers were
-- actually attempted rather than how many times we polled one.

create or replace function mark_payout_processing(
  p_payout_id    uuid,
  p_provider_ref text
) returns payouts
language plpgsql
security definer
set search_path = public
as $$
declare
  p payouts;
begin
  -- Only from a state that has not yet reached the provider. A `paid` payout
  -- must never walk backwards into processing, and `held_for_review` is not
  -- dispatchable at all — that one is for a person.
  update payouts
     set status = 'processing',
         provider_ref = p_provider_ref
   where id = p_payout_id
     and status in ('scheduled', 'frozen', 'processing')
  returning * into p;

  if not found then
    raise exception 'invalid_state: payout % cannot be marked processing', p_payout_id
      using errcode = 'check_violation';
  end if;

  perform write_audit(p.tenant_id, p.deal_id, 'system', 'payout.processing',
    jsonb_build_object('payout_id', p.id, 'provider_ref', p_provider_ref));

  return p;
end;
$$;

revoke all on function mark_payout_processing(uuid, text) from public, anon, authenticated;
