-- A full refund left a cancelled deal's payout alive, sometimes with a
-- nonsensical amount.
--
-- Found on AutoHire's tenant: `af3daee7-3425-4e07-bc0b-a03e8cb0c936` refunded
-- in full after release, and its payout row sat at `needs_verification`
-- showing "RWF 1" — a payout that read as owing a nominal amount to a seller
-- who was, after a full refund, owed nothing at all.
--
-- Two bugs, both in `refund_deal`, both from the same root cause: the
-- proportional-scaling block below ran unconditionally, including for a full
-- refund.
--
--   1. §7.1.3 reverses the seller's own payable (the release entries) on a
--      refund, but never reverses the platform fee or the provider fee —
--      both are booked once, at release, and stay booked. That is very
--      likely correct for a *partial* refund (the seller keeps working the
--      trip, the platform did the work of running the transaction), but it
--      means a *fully* refunded deal's clearing pool goes negative by
--      exactly those two fees: nothing released to the seller, minus what
--      was already charged against it. `greatest(1, …)` silently floored
--      that negative truth to a positive-looking "1" instead of surfacing it.
--   2. The full-refund cleanup that cancels a payout only matched
--      `('scheduled', 'frozen', 'held_for_review')`. `needs_verification`
--      and `blocked` were never in that list, so a payout sitting in either
--      state at the moment of a full refund survived it — carrying the
--      stale, floor-clamped amount above forever, because nothing was ever
--      going to move it out of `needs_verification` on its own.
--
-- The fix is two matching changes: skip the proportional-scaling update
-- entirely when the refund is full (there is nothing to scale toward — the
-- payout is about to be cancelled a few lines down), and widen the
-- cancellation to every status that isn't already `paid` or `processing`,
-- the same boundary the in-flight check earlier in this function already
-- draws. `payouts.amount` is left showing whatever it read at release for a
-- *partial* refund, which is the case the scaling logic still exists for.
--
-- Same five-argument signature as the live function, so this is
-- `create or replace`, not a drop — but the revoke is reissued anyway,
-- matching every other money-function change in this codebase, because the
-- risk it guards against is real regardless of whether this particular call
-- needed it.

create or replace function refund_deal(
  p_deal_id    uuid,
  p_reason     text,
  p_actor      text default 'dashboard',
  -- Null means "everything still refundable", which is what every V1 caller
  -- meant and still means.
  p_amount     bigint default null,
  p_line_items jsonb default null
) returns deals
language plpgsql
security definer
set search_path = public
as $$
declare
  d             deals;
  v_paid        bigint;
  v_already     bigint;
  v_refundable  bigint;
  v_amount      bigint;
  v_full        boolean;
  v_pool_before bigint;
  v_payout      payouts;
  v_refund      refunds;
begin
  -- The lock. The cumulative guard below is only a guard because of this line:
  -- two concurrent refunds each reading "90,000 still refundable" and each
  -- sending 90,000 is precisely what it exists to prevent.
  select * into d from deals where id = p_deal_id for update;

  if not found then
    raise exception 'not_found: deal % does not exist', p_deal_id
      using errcode = 'no_data_found';
  end if;

  -- Idempotent: refunding a fully refunded deal is a no-op, not an error.
  if d.status = 'refunded' then
    return d;
  end if;

  -- §7.1.1. Nothing has been captured, so there is nothing to send back.
  if d.status in ('created', 'checkout_started', 'payment_pending',
                  'payment_failed', 'expired', 'canceled') then
    raise exception 'invalid_state: nothing has been collected to refund'
      using errcode = 'check_violation';
  end if;

  -- A transfer that is with the provider cannot be unwound from here. Recalling
  -- one is a conversation with the rail, and a refund that pretended otherwise
  -- would be a lie an operator acts on — the same rule `hold_payout` follows.
  select * into v_payout from payouts where deal_id = d.id for update;

  if found and v_payout.status = 'processing' then
    raise exception 'policy_violation: a payout for this deal is in flight — wait for it to settle'
      using errcode = 'check_violation';
  end if;

  select coalesce(sum(amount) filter (where entry_type = 'hold'), 0)
    into v_paid
    from ledger where deal_id = d.id;

  -- A failed refund never left, so it does not count against what is still
  -- refundable. A pending one does: it is expected to.
  select coalesce(sum(amount), 0)
    into v_already
    from refunds where deal_id = d.id and status <> 'failed';

  v_refundable := v_paid - v_already;

  if v_refundable <= 0 then
    raise exception 'policy_violation: nothing further is refundable on this deal'
      using errcode = 'check_violation';
  end if;

  v_amount := coalesce(p_amount, v_refundable);

  if v_amount <= 0 then
    raise exception 'policy_violation: a refund must be a positive amount'
      using errcode = 'check_violation';
  end if;

  -- §7.1's cumulative guard. Checked under the same lock that guards release.
  if v_amount > v_refundable then
    raise exception 'policy_violation: refund of % exceeds the % still refundable on this deal',
      v_amount, v_refundable
      using errcode = 'check_violation';
  end if;

  v_full := (v_amount = v_refundable);

  insert into refunds (
    tenant_id, deal_id, amount, currency, reason, line_items, actor, status, settled_at
  )
  values (
    d.tenant_id, d.id, v_amount, d.presentment_currency, p_reason, p_line_items, p_actor,
    -- Post-payout refunds wait for a person; everything else is booked here.
    case when d.status = 'paid_out' then 'pending'::refund_status
         else 'succeeded'::refund_status end,
    case when d.status = 'paid_out' then null else now() end
  )
  returning * into v_refund;

  if d.status = 'paid_out' then
    -- §7.1.4. The money is with the seller. Book what they owe rather than
    -- moving funds we do not have, and leave the refund `pending` so it appears
    -- as work rather than as something already done.
    perform write_ledger(d, 'receivable', v_amount);

    perform write_audit(d.tenant_id, d.id, p_actor, 'refund.receivable_raised',
      jsonb_build_object(
        'refund_id', v_refund.id,
        'amount', v_amount,
        'reason', p_reason,
        'note', 'The seller has already been paid. This needs a person.'
      ));

    return d;
  end if;

  if d.status in ('clearing', 'released', 'payout_pending') then
    -- §7.1.3. Put it back in the hold, then take it out to the buyer. The
    -- release entry is positive here — the mirror of the negative one that
    -- created the pool — so `held` returns to zero rather than going negative.
    v_pool_before := deal_clearing_pool(d.id);

    perform write_ledger(d, 'release', v_amount);
    perform write_ledger(d, 'refund', -v_amount);

    -- What the seller is told they will receive has to shrink with the pool.
    -- Proportionally rather than by conversion: `payouts.amount` is in the
    -- seller's currency and the refund is in the buyer's, and scaling avoids
    -- inventing a rate that would disagree with `amountLeaving` at dispatch.
    --
    -- Only for a partial refund — see this migration's header. A full refund
    -- cancels the payout outright below instead of scaling toward a pool that
    -- is about to go negative (the platform fee and provider fee are never
    -- reversed, only the seller's own payable is).
    if not v_full and v_payout.id is not null and v_pool_before > 0 then
      update payouts
         set amount = greatest(
               1,
               floor(v_payout.amount::numeric * deal_clearing_pool(d.id) / v_pool_before)::bigint
             )
       where id = v_payout.id
         and status not in ('paid', 'processing');
    end if;
  else
    -- §7.1.2. Straight out of the hold. Everything not refunded stays held and
    -- the deal carries on to release for the remainder.
    perform write_ledger(d, 'refund', -v_amount);
  end if;

  if v_full then
    -- A deposit that was never settled goes back with the last of the money.
    if d.deposit_amount is not null and not deposit_settled(d.id) then
      perform write_ledger(d, 'deposit_release', -d.deposit_amount);
    end if;

    -- The one refund that is a lifecycle event.
    update deals set status = 'refunded' where id = d.id returning * into d;

    -- Nothing is owed any more, so nothing should be scheduled — whatever
    -- state the payout was in. Widened from `('scheduled', 'frozen',
    -- 'held_for_review')`, which missed `needs_verification` and `blocked`
    -- entirely — see this migration's header. `paid`/`processing` stay
    -- excluded, the same boundary the in-flight check above already draws:
    -- money already with the provider is not this function's to cancel.
    update payouts set status = 'failed', failure_reason = 'Deal was refunded'
     where deal_id = d.id and status not in ('paid', 'processing');
  end if;

  perform write_audit(d.tenant_id, d.id, p_actor,
    case when v_full then 'deal.refunded' else 'deal.partially_refunded' end,
    jsonb_build_object(
      'refund_id', v_refund.id,
      'amount', v_amount,
      'refundable_before', v_refundable,
      'reason', p_reason,
      'line_items', p_line_items
    ));

  return d;
end;
$$;

-- Reissued regardless of whether this particular change needed it — a
-- recreated money function is granted to PUBLIC by default, and that has
-- bitten this exact function before (`20260807000006`, `20260809000003`).
revoke all on function refund_deal(uuid, text, text, bigint, jsonb)
  from public, anon, authenticated;
revoke all on function refund_deal(uuid, text, text, bigint, jsonb) from payhold_ai;
