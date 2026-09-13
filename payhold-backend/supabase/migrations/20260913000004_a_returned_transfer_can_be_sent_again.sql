-- A transfer the rail gave back can be sent again.
--
-- Today it cannot, and the two reasons compound each other:
--
--   1. **`provider_ref` is never cleared.** `dispatchPayout` decides between
--      asking and sending on the presence of that reference, deliberately — it
--      is what stopped the re-POST that PayPal refused as a duplicate. But a
--      rail that reports the transfer FAILED, RETURNED, REVERSED or CANCELED
--      has given the money back, and the reference now points at a transfer
--      that no longer exists. The next pass polls it, gets the same terminal
--      answer, books another failure, and climbs §13's ladder to `blocked`
--      without ever attempting the send that would work.
--
--   2. **The idempotency key is `payout:<id>`, forever.** PayPal anchors on it
--      as `sender_batch_id` and refuses a repeat outright. So even with the
--      reference cleared, a second send of the same payout is rejected with
--      the exact error this whole investigation started from — "Batch with
--      given sender_batch_id already exists". A payout can be sent to PayPal
--      **once in its life**, and a legitimate second attempt is impossible.
--
-- Together those mean a payout returned after PayPal's 30-day unclaimed window
-- is money the seller can never be paid: it is theirs, it is back in our
-- balance, and nothing can move it.
--
-- `send_seq` fixes the second and this function fixes the first. The sequence
-- starts at zero and the key stays exactly `payout:<id>` while it is zero, so
-- every payout already in flight keeps the idempotency it was sent under —
-- this must not make a live transfer look new to a rail that is still holding
-- it. Only a genuine re-send moves the counter, and only after a rail has said
-- it is finished with the money.
--
-- **This clears the rail leg and nothing else.** No status, no attempts, no
-- next_attempt_at: `fail_payout` owns the ladder and has already run by the
-- time this is called. One thing, so the two cannot disagree about the retry
-- policy.

alter table payouts
  add column if not exists send_seq integer not null default 0
    check (send_seq >= 0);

comment on column payouts.send_seq is
  'How many times this payout has been handed to a rail as a NEW transfer. '
  'Zero for one that has never been re-sent, which keeps its original '
  'idempotency key unchanged. Incremented only when a rail has reported the '
  'previous attempt terminally failed and returned the money.';

create or replace function clear_payout_rail_leg(
  p_payout_id uuid,
  p_reason    text
)
returns payouts
language plpgsql
security definer
set search_path = public
as $$
declare
  p payouts;
begin
  select * into p from payouts where id = p_payout_id for update;

  if not found then
    raise exception 'not_found: payout % does not exist', p_payout_id
      using errcode = 'no_data_found';
  end if;

  -- A paid payout is finished, and a processing one is still with the rail.
  -- Clearing either would let a second transfer be sent against money that has
  -- already gone — the precise accident `provider_ref` exists to prevent.
  if p.status in ('paid', 'processing') then
    raise exception 'invalid_state: payout % is % and its rail leg must not be cleared',
      p_payout_id, p.status
      using errcode = 'check_violation';
  end if;

  -- Nothing to clear. Not an error: the caller asks whenever a rail reports a
  -- failure, including failures that never reached a rail at all.
  if p.provider_ref is null then
    return p;
  end if;

  update payouts
     set provider_ref   = null,
         rail_status    = null,
         rail_status_at = null,
         send_seq       = p.send_seq + 1
   where id = p.id
  returning * into p;

  -- The old reference is written into the audit row rather than dropped. It is
  -- the only remaining link between this payout and a transfer the rail still
  -- has records of, and "which batch was that" is the first question anybody
  -- asks when reconciling a return.
  perform write_audit(p.tenant_id, p.deal_id, 'system', 'payout.rail_leg_cleared',
    jsonb_build_object(
      'payout_id', p.id,
      'reason', p_reason,
      'send_seq', p.send_seq
    ));

  return p;
end;
$$;

comment on function clear_payout_rail_leg(uuid, text) is
  'Forget a transfer a rail has terminally failed and returned, so the payout '
  'can be sent again under a fresh idempotency key. Touches no status, no '
  'attempts and no clock — fail_payout owns those.';

revoke all on function clear_payout_rail_leg(uuid, text) from public, anon, authenticated;
revoke all on function clear_payout_rail_leg(uuid, text) from payhold_ai;
grant execute on function clear_payout_rail_leg(uuid, text) to service_role;
