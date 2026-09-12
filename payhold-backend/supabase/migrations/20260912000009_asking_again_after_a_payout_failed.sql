-- A seller may ask again after a payout failed.
--
-- `request_withdrawal` selected only payouts with `withdrawal_requested_at is
-- null`, and its own comment gives the reason: "two taps on a slow connection
-- are the ordinary case, and the second must find the rows already stamped
-- rather than stamp them again." That is right and worth keeping. What it also
-- did, unintentionally, was make the ask a **once-per-payout-ever** action —
-- the column is never cleared, including when the payout is sent, because it
-- answers "was this pulled or did it go out on the clock". So a seller whose
-- transfer then failed had no way to ask again: the next press matched nothing
-- and raised `nothing cleared to withdraw`, which is false and reads as an
-- accusation to somebody looking at money they can see.
--
-- That mattered little while the scheduled pass would pick a failed payout up
-- on its own. It matters entirely in `payout_mode = 'wallet'`, where
-- `due_payouts` sends only what has been asked for and the ask is the whole
-- mechanism.
--
-- So the filter is narrowed rather than dropped: a payout may be asked for
-- again once its last attempt is definitively over — `failed` or `blocked`.
-- A double tap on a `scheduled` payout still matches nothing on the second
-- press, which is the protection the original comment describes.
--
-- **The first stamp is kept**, via `coalesce`. "Was this pulled" is answered by
-- the first ask and re-stamping would erase it; the per-press history belongs
-- in `audit_log`, where `seller.withdrawal_requested` already writes one row
-- per call.
--
-- **`attempts` is still untouched**, so a person asking again gets one more
-- attempt rather than a fresh series — the rule `reset_payout_retry` follows
-- and for the same reason: the counter is §13's budget, and zeroing it would
-- hand a rail that keeps refusing an unlimited run.
--
-- **`held_for_review` stays out of the list.** A payout a rule or a person
-- stopped is waiting on a named person, and a seller pressing a button in
-- their own app is not that (invariant 11).
--
-- The refusal is also rewritten. AutoHire puts our `message` straight into a
-- toast, so this text is read by a car owner: it now says which of the real
-- cases applies instead of one sentence that was wrong in four of them.
--
-- **Rebuilt on `20260911000003`'s definition, not `20260808000002`'s.** The
-- first draft of this migration copied the original and silently reverted
-- §29.17 with it — the destination lookup's `archived_at is null and
-- is_primary`, and the `destination_not_live` refusal that replaced a
-- `not_found`. `tests/seller-wallet.test.ts` caught it on the first run, which
-- is the argument for reading the live definition rather than the one a
-- feature's own migration happens to contain.

create or replace function request_withdrawal(
  p_seller       uuid,
  p_actor        text,
  p_destination  uuid default null
)
returns setof payouts
language plpgsql
security definer
set search_path = public
as $$
declare
  s        sellers;
  dest     seller_destinations;
  v_count  integer;
  v_why    text;
begin
  if coalesce(trim(p_actor), '') = '' then
    raise exception 'policy_violation: a withdrawal request needs a name'
      using errcode = 'check_violation';
  end if;

  select * into s from sellers where id = p_seller;

  if not found then
    raise exception 'not_found: seller % does not exist', p_seller
      using errcode = 'no_data_found';
  end if;

  if p_destination is not null then
    select * into dest
      from seller_destinations
     where id = p_destination
       and seller_id = p_seller
       and archived_at is null
       and is_primary;

    if not found then
      raise exception 'destination_not_live: destination % is not this seller''s current payout destination. Leave destination_id out to withdraw to the current one.',
        p_destination
        using errcode = 'check_violation';
    end if;

    if dest.verified_at is null then
      raise exception 'policy_violation: destination % has not been verified',
        p_destination
        using errcode = 'check_violation';
    end if;

    if dest.security_hold_until is not null and dest.security_hold_until > now() then
      raise exception
        'policy_violation: destination % is in its security hold until %',
        p_destination, dest.security_hold_until
        using errcode = 'check_violation';
    end if;
  end if;

  with due as (
    select p.id
      from payouts p
      join deals d on d.id = p.deal_id
     where p.seller_id = p_seller
       and p.status in ('scheduled', 'blocked', 'needs_verification', 'failed', 'frozen')
       and d.status in ('released', 'payout_pending')
       and (
         p.withdrawal_requested_at is null
         -- Asked for before, tried, and finished trying. This is a new ask,
         -- not the second half of a double tap.
         or p.status in ('failed', 'blocked')
       )
     for update of p
  )
  update payouts p
     -- The first ask is what this column records — "was this pulled, or did
     -- it go out on the clock". Re-stamping would erase that answer; the
     -- per-press history is in `audit_log`, one row per call.
     set withdrawal_requested_at  = coalesce(p.withdrawal_requested_at, now()),
         requested_destination_id = coalesce(p_destination, p.requested_destination_id),
         next_attempt_at          = now()
    from due
   where p.id = due.id;

  get diagnostics v_count = row_count;

  if v_count = 0 then
    -- Which of the real cases this is. AutoHire puts this straight into a
    -- toast, so a car owner reads it.
    select case
      when count(*) = 0
        then 'there is nothing to withdraw yet'
      when count(*) filter (where p.status = 'held_for_review') > 0
        then 'a payout is waiting on a review before it can be sent'
      when count(*) filter (where p.status = 'processing') > 0
        then 'the money has already been sent and is with the payout provider'
      when count(*) filter (where p.status = 'paid') = count(*)
        then 'everything earned so far has already been paid out'
      else 'the payout has already been asked for and goes out on the next run'
    end
      into v_why
      from payouts p
     where p.seller_id = p_seller;

    raise exception 'invalid_state: %', v_why
      using errcode = 'check_violation';
  end if;

  perform write_audit(s.tenant_id, null, p_actor, 'seller.withdrawal_requested',
    jsonb_build_object(
      'seller_id', p_seller,
      'payouts', v_count,
      'destination_id', p_destination
    ));

  return query
    select * from payouts
     where seller_id = p_seller and withdrawal_requested_at is not null
       and status <> 'paid'
     order by scheduled_for;
end;
$$;
revoke all on function request_withdrawal(uuid, text, uuid) from public, anon, authenticated;
revoke all on function request_withdrawal(uuid, text, uuid) from payhold_ai;
grant execute on function request_withdrawal(uuid, text, uuid) to service_role;
