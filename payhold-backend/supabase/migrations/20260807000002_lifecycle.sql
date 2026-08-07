-- ---------------------------------------------------------------------------
-- V2 §6: the order lifecycle, part two — the transitions
-- ---------------------------------------------------------------------------
--
-- The states landed in `20260807000001`. This is the first migration allowed to
-- name them (see that file's header for why).
--
-- The change that matters most here is what `released` means.
--
-- V1 wrote the release ledger entry, set `status = 'released'`, and used
-- `payout_due_at` to hold the money for the clearance window. So "released"
-- meant "out of the hold, not yet payable" — which is precisely what §6 calls
-- `clearing`. The window was real; it just had no name a client could read.
--
-- V2 gives it one:
--
--   clearing        money has left the hold, safety window running
--   released        the window has passed; this is §5.1's `available`
--   payout_pending  a transfer is with the provider and not yet settled
--   paid_out        booked
--
-- Nothing about *when money moves* changes. The release ledger entry, the fee,
-- the deposit return and the payout row are all still written by `release_deal`
-- at the second confirmation, under the same row lock. Invariant 5 is untouched.
-- What changes is that the deal now says which side of the window it is on.
--
-- `released` looks transient — `mature_clearing_deals` promotes a deal and the
-- same cron pass usually dispatches it moments later. It is not decorative: a
-- payout held by a risk rule (invariant 11), frozen by reconciliation drift, or
-- with no eligible route (§5.1, Phase 5) leaves the deal sitting in `released`
-- for as long as that takes. That is exactly the state an operator needs to see.

-- ---------------------------------------------------------------------------
-- Per-deal completion policy — §6.1, §14
-- ---------------------------------------------------------------------------
--
-- V1 read the timing model from tenant settings only. §14's create-order payload
-- carries a `completion_policy` per order, because a three-day rental and a
-- ninety-day equipment lease cannot share one auto-complete window.
--
-- Null means "use the tenant setting", so every existing deal keeps its
-- behaviour and a client that sends nothing is unaffected.

alter table deals
  add column completion_event         text,
  add column auto_complete_after_hours integer
    check (auto_complete_after_hours is null or auto_complete_after_hours > 0),
  add column clearing_days            integer
    check (clearing_days is null or clearing_days >= 0);

comment on column deals.clearing_days is
  'Overrides the tenant''s clearance_days for this deal. Locked at creation: '
  '§27 says in-flight deals keep the settings they were created with.';

-- ---------------------------------------------------------------------------
-- `released_at` now spans four states, not two
-- ---------------------------------------------------------------------------
--
-- `released_at` still means one thing: when the money left the hold. That
-- happens on entry to `clearing`, so every state at or past clearing carries it.
--
-- Two states are exempt in both directions rather than listed, because for
-- them the column legitimately may or may not be set:
--
--   `partially_refunded` — §7.1 allows a partial refund before release
--   (case 2) and after it (cases 3 and 4). Phase 3 owns that path and the
--   constraint must not decide it in advance.
--
--   `disputed` — §6 adds `clearing -> disputed`. V1 could only dispute a held
--   deal, so `disputed` implied no release had happened; a chargeback during
--   the clearance window breaks that, and it arrives on a deal whose money has
--   already left the hold.

alter table deals drop constraint released_at_matches_status;

alter table deals add constraint released_at_matches_status check (
  status in ('partially_refunded', 'disputed')
  or ((status in ('clearing', 'released', 'payout_pending', 'paid_out'))
      = (released_at is not null))
);

-- ---------------------------------------------------------------------------
-- The transition guard
-- ---------------------------------------------------------------------------
--
-- A trigger rather than a call at the top of each money function, for the same
-- reason `enqueue_webhooks` is a trigger: a rule every future code path must
-- remember to invoke is a rule that will eventually be skipped — including by a
-- correction someone runs by hand at 2am, which is exactly when a deal should
-- not be able to teleport from `created` to `paid_out`.
--
-- This guards *shape*, not policy. `release_deal` still decides whether both
-- confirmations are present; `refund_deal` still decides whether a refund is
-- allowed this late. The guard only says which pairs are describable at all, so
-- a permissive edge here does not weaken the function that owns the decision.

create or replace function deal_transition_allowed(
  p_from deal_status,
  p_to   deal_status
) returns boolean
language sql
immutable
as $$
  select case p_from
    when 'created'            then p_to in ('checkout_started', 'payment_pending', 'funded_held', 'disputed', 'expired', 'canceled')
    when 'checkout_started'   then p_to in ('payment_pending', 'funded_held', 'disputed', 'expired', 'canceled')
    when 'payment_pending'    then p_to in ('funded_held', 'payment_failed', 'disputed', 'expired', 'canceled')
    -- `payment_failed -> funded_held` is not a contradiction: an async rail can
    -- report a failure and then settle, and `fund_deal` accepts the state for
    -- exactly that reason. Refusing it here would leave money at the provider
    -- with no deal willing to admit it arrived.
    when 'payment_failed'     then p_to in ('checkout_started', 'payment_pending', 'funded_held', 'disputed', 'expired', 'canceled')
    when 'funded_held'        then p_to in ('in_progress', 'confirmed_buyer', 'confirmed_seller', 'clearing', 'refunded', 'disputed', 'canceled')
    when 'in_progress'        then p_to in ('revision_requested', 'confirmed_buyer', 'confirmed_seller', 'clearing', 'refunded', 'disputed')
    when 'revision_requested' then p_to in ('in_progress', 'confirmed_buyer', 'confirmed_seller', 'clearing', 'refunded', 'disputed')
    when 'confirmed_buyer'    then p_to in ('confirmed_seller', 'clearing', 'revision_requested', 'refunded', 'disputed')
    when 'confirmed_seller'   then p_to in ('confirmed_buyer', 'clearing', 'revision_requested', 'refunded', 'disputed')
    when 'clearing'           then p_to in ('released', 'disputed', 'refunded', 'partially_refunded')
    -- `released -> paid_out` skips `payout_pending` deliberately: a synchronous
    -- rail settles inside the dispatch call, so `mark_payout_processing` is
    -- never reached. Requiring the intermediate state would make a card payout
    -- illegal. `payout_pending -> released` is the other direction of the same
    -- fact — a failed transfer returns the money to available, retryable.
    when 'released'           then p_to in ('payout_pending', 'paid_out', 'disputed', 'refunded', 'partially_refunded')
    when 'payout_pending'     then p_to in ('paid_out', 'released', 'partially_refunded')
    when 'paid_out'           then p_to in ('partially_refunded')
    when 'partially_refunded' then p_to in ('released', 'payout_pending', 'paid_out', 'refunded', 'disputed')
    -- `resolve_dispute` backs a deal out to `funded_held` so the release guard
    -- sees an ordinary held deal. That is the only way out to release.
    when 'disputed'           then p_to in ('funded_held', 'refunded')
    -- Terminal.
    when 'refunded'           then false
    when 'expired'            then false
    when 'canceled'           then false
    else false
  end;
$$;

create or replace function assert_deal_transition() returns trigger
language plpgsql
as $$
begin
  if new.status is not distinct from old.status then
    return new;
  end if;

  if not deal_transition_allowed(old.status, new.status) then
    raise exception 'invalid_transition: a deal cannot go from % to %', old.status, new.status
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

-- Before the emit trigger, so an illegal transition never queues a webhook
-- telling a client something that did not happen. Trigger order within a timing
-- class is alphabetical; `deals_assert_transition` sorts before `deals_emit_
-- webhook`, and the emit trigger is AFTER UPDATE regardless.
create trigger deals_assert_transition
  before update of status on deals
  for each row execute function assert_deal_transition();

-- ---------------------------------------------------------------------------
-- Release now lands in `clearing`
-- ---------------------------------------------------------------------------

create or replace function release_deal(
  p_deal_id          uuid,
  p_payout_amount    bigint,
  p_payout_currency  currency_code,
  p_fee_presentment  bigint
) returns deals
language plpgsql
security definer
set search_path = public
as $$
declare
  d               deals;
  v_clearance     integer;
  v_released_at   timestamptz := now();
  v_has_buyer     boolean;
  v_has_seller    boolean;
begin
  -- The lock. Everything below is safe only because of this line.
  select * into d from deals where id = p_deal_id for update;

  if not found then
    raise exception 'not_found: deal % does not exist', p_deal_id
      using errcode = 'no_data_found';
  end if;

  -- Idempotent: releasing twice is a no-op, not an error (§21.4). Every state
  -- at or past clearing has already had its release written.
  if d.status in ('clearing', 'released', 'payout_pending', 'paid_out') then
    return d;
  end if;

  if d.status = 'refunded' then
    raise exception 'invalid_state: deal % was refunded and cannot be released', p_deal_id
      using errcode = 'check_violation';
  end if;

  -- Re-verify under the lock. The caller's check was advisory; this one counts.
  select
    exists (select 1 from confirmations where deal_id = d.id and side = 'buyer'),
    exists (select 1 from confirmations where deal_id = d.id and side = 'seller')
  into v_has_buyer, v_has_seller;

  if not (v_has_buyer and v_has_seller) then
    raise exception 'invalid_state: release requires both confirmations'
      using errcode = 'check_violation';
  end if;

  -- §29.7: the default moved from 7 days to 14, matching §6.1. A deal that
  -- carried its own policy at creation wins over the tenant setting — §14.
  v_clearance := coalesce(
    d.clearing_days,
    setting_num(d.tenant_id, 'clearance_days', 14)::integer
  );

  update deals
     set status        = 'clearing',
         released_at   = v_released_at,
         payout_due_at = v_released_at + make_interval(days => v_clearance)
   where id = d.id
  returning * into d;

  -- Money out of the hold, fee taken, deposit returned if it was never settled.
  perform write_ledger(d, 'release', -d.presentment_amount);
  perform write_ledger(d, 'fee', -p_fee_presentment);

  if d.deposit_amount is not null and not deposit_settled(d.id) then
    perform write_ledger(d, 'deposit_release', -d.deposit_amount);
  end if;

  -- One payout per deal, enforced by payouts_deal_key. `on conflict do
  -- nothing` makes a retried release idempotent rather than a constraint error.
  insert into payouts (tenant_id, deal_id, seller_id, amount, currency, status, scheduled_for)
  values (d.tenant_id, d.id, d.seller_id, p_payout_amount, p_payout_currency,
          'scheduled', d.payout_due_at)
  on conflict (deal_id) do nothing;

  perform write_audit(d.tenant_id, d.id, 'system', 'deal.released', jsonb_build_object(
    'fee_amount', d.fee_amount,
    'net', p_payout_amount,
    'paid_in', p_payout_currency,
    'clearing_days', v_clearance,
    'payout_due_at', d.payout_due_at
  ));

  return d;
end;
$$;

-- ---------------------------------------------------------------------------
-- Clearing → released, when the window has passed
-- ---------------------------------------------------------------------------
--
-- Time is the only input, so this is a set-based pass rather than a per-deal
-- call: it is the same shape as `auto-release`, and for the same reason. It
-- moves no money and writes no ledger entry — the money moved at release. All
-- it does is say the window is over, which is what makes the payout
-- dispatchable and what `order.released` tells the client.
--
-- Disputed and refunded deals are excluded by the status filter, so a dispute
-- opened during clearing freezes the promotion for as long as it stays open.

create or replace function mature_clearing_deals(p_limit int default 500)
returns setof deals
language plpgsql
security definer
set search_path = public
as $$
declare
  d deals;
begin
  for d in
    select * from deals
    where status = 'clearing'
      and payout_due_at is not null
      and payout_due_at <= now()
    order by payout_due_at
    limit p_limit
    for update skip locked
  loop
    update deals set status = 'released' where id = d.id returning * into d;

    perform write_audit(d.tenant_id, d.id, 'system', 'deal.cleared', jsonb_build_object(
      'payout_due_at', d.payout_due_at
    ));

    return next d;
  end loop;
end;
$$;

create index deals_clearing_due_idx on deals(payout_due_at)
  where status = 'clearing';

-- ---------------------------------------------------------------------------
-- The payout states drag the deal along with them
-- ---------------------------------------------------------------------------

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

  -- The transfer is with the provider. Only `released` moves — a re-poll of an
  -- already-processing payout must not walk the deal backwards.
  update deals set status = 'payout_pending'
   where id = p.deal_id and status = 'released';

  perform write_audit(p.tenant_id, p.deal_id, 'system', 'payout.processing',
    jsonb_build_object('payout_id', p.id, 'provider_ref', p_provider_ref));

  return p;
end;
$$;

create or replace function fail_payout(p_payout_id uuid, p_reason text)
returns payouts
language plpgsql
security definer
set search_path = public
as $$
declare
  p payouts;
begin
  update payouts
     set status = 'failed',
         failure_reason = p_reason,
         attempts = attempts + 1
   where id = p_payout_id and status <> 'paid'
  returning * into p;

  if not found then
    raise exception 'invalid_state: payout % is missing or already paid', p_payout_id
      using errcode = 'check_violation';
  end if;

  -- §5.1: a failed payout does not lose funds. The money is back to available
  -- and the payout is retryable; the deal must not sit in `payout_pending`
  -- claiming a transfer is in flight when none is.
  update deals set status = 'released'
   where id = p.deal_id and status = 'payout_pending';

  perform write_audit(p.tenant_id, p.deal_id, 'system', 'payout.failed', jsonb_build_object(
    'reason', p_reason,
    'attempts', p.attempts
  ));

  return p;
end;
$$;

-- A settled transfer proves the window is over, so `settle_payout` promotes a
-- deal still sitting in `clearing` rather than refusing it. The alternative was
-- making `clearing -> paid_out` a legal edge, which would have let a forced
-- retry pay a seller inside the safety window and leave no trace that it had
-- skipped one. This way the promotion is a state change like any other, and the
-- `deal.cleared` audit row records that a payout, not the clock, caused it.
create or replace function settle_payout(
  p_payout_id    uuid,
  p_leaving      bigint,
  p_provider_ref text
) returns payouts
language plpgsql
security definer
set search_path = public
as $$
declare
  p  payouts;
  d  deals;
begin
  select * into p from payouts where id = p_payout_id for update;

  if not found then
    raise exception 'not_found: payout % does not exist', p_payout_id
      using errcode = 'no_data_found';
  end if;

  if p.status = 'paid' then
    return p;
  end if;

  select * into d from deals where id = p.deal_id for update;

  -- §8: a dispute freezes release and payout. V1 did not need this check —
  -- a dispute could only be opened on a held deal, so no payout row existed
  -- yet. `clearing -> disputed` changes that: the payout is already scheduled
  -- when the chargeback arrives, and without this it would simply go.
  --
  -- Under the same lock as the booking, so a dispute opened mid-dispatch
  -- either lands before this check or waits behind it.
  if d.status = 'disputed' then
    raise exception 'policy_violation: deal % is disputed — its payout is frozen', d.id
      using errcode = 'check_violation';
  end if;

  -- The balance guard the spec demands: a payout may never exceed the tenant's
  -- available balance, checked inside the same transaction that books it.
  if p_leaving > (
    select coalesce(available, 0) from rail_balances(p.tenant_id)
    where provider = d.provider and currency = d.presentment_currency
  ) then
    raise exception 'insufficient_balance: payout of % exceeds available balance on % %',
      p_leaving, d.provider, d.presentment_currency
      using errcode = 'check_violation';
  end if;

  update payouts
     set status = 'paid',
         paid_at = now(),
         failure_reason = null,
         attempts = attempts + 1,
         provider_ref = p_provider_ref
   where id = p.id
  returning * into p;

  perform write_ledger(d, 'payout', -p_leaving);

  if d.status = 'clearing' then
    update deals set status = 'released' where id = d.id;
    perform write_audit(d.tenant_id, d.id, 'system', 'deal.cleared', jsonb_build_object(
      'reason', 'payout settled', 'payout_due_at', d.payout_due_at
    ));
  end if;

  update deals set status = 'paid_out' where id = d.id;

  perform write_audit(p.tenant_id, p.deal_id, 'system', 'payout.paid', jsonb_build_object(
    'amount', p.amount,
    'currency', p.currency,
    'seller_id', p.seller_id
  ));

  return p;
end;
$$;

-- ---------------------------------------------------------------------------
-- Guards that named `released` and meant "past the hold"
-- ---------------------------------------------------------------------------

create or replace function refund_deal(
  p_deal_id  uuid,
  p_reason   text,
  p_actor    text default 'dashboard'
) returns deals
language plpgsql
security definer
set search_path = public
as $$
declare
  d deals;
begin
  select * into d from deals where id = p_deal_id for update;

  if not found then
    raise exception 'not_found: deal % does not exist', p_deal_id
      using errcode = 'no_data_found';
  end if;

  -- §7.1 cases 3 and 4 will open these up — reversing the payable before
  -- payout, and a receivable from the seller after it. Both need the partial
  -- primitive and the reserve bucket to exist first, so Phase 3 owns them.
  -- Until then this stays a full stop, extended to cover the states that used
  -- to be spelled `released`.
  if d.status in ('clearing', 'released', 'payout_pending', 'paid_out') then
    raise exception 'policy_violation: funds have already been released — refund is no longer possible'
      using errcode = 'check_violation';
  end if;

  if d.status = 'refunded' then
    return d;
  end if;

  if d.status in ('created', 'checkout_started', 'payment_pending', 'payment_failed') then
    raise exception 'invalid_state: nothing has been collected to refund'
      using errcode = 'check_violation';
  end if;

  update deals set status = 'refunded' where id = d.id returning * into d;

  perform write_ledger(d, 'refund', -d.presentment_amount);

  if d.deposit_amount is not null and not deposit_settled(d.id) then
    perform write_ledger(d, 'deposit_release', -d.deposit_amount);
  end if;

  perform write_audit(d.tenant_id, d.id, p_actor, 'deal.refunded',
                      jsonb_build_object('reason', p_reason));

  return d;
end;
$$;

-- §6: `clearing -> disputed` is a legal path. A chargeback or a complaint does
-- not wait politely for the safety window to end — and freezing during clearing
-- is the whole point of having a window.
create or replace function open_dispute(
  p_deal_id    uuid,
  p_raised_by  confirm_side,
  p_reason     text
) returns disputes
language plpgsql
security definer
set search_path = public
as $$
declare
  d    deals;
  dsp  disputes;
begin
  select * into d from deals where id = p_deal_id for update;

  if not found then
    raise exception 'not_found: deal % does not exist', p_deal_id
      using errcode = 'no_data_found';
  end if;

  if d.status not in ('funded_held', 'in_progress', 'revision_requested',
                      'confirmed_buyer', 'confirmed_seller', 'clearing', 'disputed') then
    raise exception 'invalid_state: a deal in % cannot be disputed', d.status
      using errcode = 'check_violation';
  end if;

  insert into disputes (tenant_id, deal_id, raised_by, reason)
  values (d.tenant_id, d.id, p_raised_by, p_reason)
  returning * into dsp;

  update deals set status = 'disputed' where id = d.id;

  perform write_audit(d.tenant_id, d.id, 'user:' || p_raised_by, 'deal.disputed',
                      jsonb_build_object('reason', p_reason));

  return dsp;
end;
$$;

-- ---------------------------------------------------------------------------
-- Outcome labelling follows the release, which is now `clearing`
-- ---------------------------------------------------------------------------
--
-- §24.3: these labels are what a fraud model of our own trains on later and
-- they cannot be backfilled. Pointing them at `released` after release starts
-- landing in `clearing` would have silently stopped recording clean outcomes —
-- the failure would not surface until someone tried to train on the gap.

create or replace function label_deal_outcome() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  auto boolean;
begin
  -- A disputed deal gets the more specific label from the dispute's own
  -- trigger, which fires after the resolution note is written.
  if exists (select 1 from disputes where deal_id = new.id) then
    return new;
  end if;

  if new.status = 'clearing' then
    select exists (
      select 1 from confirmations where deal_id = new.id and actor = 'auto'
    ) into auto;

    perform record_deal_outcome(
      new,
      case when auto then 'auto_released'::deal_outcome_label
           else 'released_clean'::deal_outcome_label end,
      case when auto then 'timer_fired' else 'both_confirmed' end
    );
  elsif new.status = 'refunded' then
    perform record_deal_outcome(new, 'refunded', 'client_refund');
  end if;

  return new;
end;
$$;

-- The WHEN clause lives on the trigger, not the function, so replacing the
-- function alone would leave this deaf to `clearing` — the labels would simply
-- stop being written, silently, and §24.3 says they cannot be backfilled.
drop trigger deals_label_outcome on deals;

create trigger deals_label_outcome
  after update of status on deals
  for each row
  when (old.status is distinct from new.status
        and new.status in ('clearing', 'refunded'))
  execute function label_deal_outcome();

-- ---------------------------------------------------------------------------
-- The §10.2 event vocabulary
-- ---------------------------------------------------------------------------
--
-- §29.2 keeps the object called a deal in our own code and moves the wire to
-- §10.2's `order.*` names, which is what a client integrating against the
-- handoff document will listen for.
--
-- **One event per transition.** The first draft of this emitted both the V1 and
-- the V2 name so nothing would break, which was wrong: `enqueue_webhooks` fans
-- out to every registered endpoint and there is no per-event subscription, so
-- "both names" means every client receives two POSTs for one state change.
-- Doubling delivery volume to avoid a rename is not compatibility, and
-- invariant 10 is about telling a client *what happened*, once.
--
-- The rename is therefore breaking, and it is affordable exactly now: nothing
-- is live, `RAILS_VERIFIED` is false, and AutoHire is the only integration.
-- After launch this would be a versioned endpoint instead.

create or replace function emit_deal_event() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status is not distinct from old.status then
    return new;
  end if;

  case new.status
    when 'payment_pending' then
      perform enqueue_webhooks(new.tenant_id, new.id, 'order.payment_pending', jsonb_build_object(
        'payment_method', new.payment_method
      ));
    when 'payment_failed' then
      perform enqueue_webhooks(new.tenant_id, new.id, 'payment.failed', '{}'::jsonb);
    when 'funded_held' then
      perform enqueue_webhooks(new.tenant_id, new.id, 'order.funded_held', jsonb_build_object(
        'amount', new.amount,
        'currency', new.currency,
        'presentment_amount', new.presentment_amount,
        'presentment_currency', new.presentment_currency,
        'payment_method', new.payment_method,
        'auto_release_at', new.auto_release_at
      ));
    when 'clearing' then
      -- V1 called this `deal.released`, and the name was accurate for what it
      -- described: money out of the hold, clearance clock started. §10.2 splits
      -- that into two observable moments and this is the first of them.
      perform enqueue_webhooks(new.tenant_id, new.id, 'order.clearing_started', jsonb_build_object(
        'fee_amount', new.fee_amount,
        'net', new.amount - new.fee_amount,
        'payout_due_at', new.payout_due_at
      ));
    when 'released' then
      perform enqueue_webhooks(new.tenant_id, new.id, 'order.released', jsonb_build_object(
        'payout_due_at', new.payout_due_at
      ));
    when 'payout_pending' then
      perform enqueue_webhooks(new.tenant_id, new.id, 'payout.pending', '{}'::jsonb);
    when 'refunded' then
      perform enqueue_webhooks(new.tenant_id, new.id, 'refund.succeeded', jsonb_build_object(
        'amount', new.presentment_amount,
        'currency', new.presentment_currency
      ));
    when 'disputed' then
      perform enqueue_webhooks(new.tenant_id, new.id, 'dispute.opened', '{}'::jsonb);
    when 'paid_out' then
      perform enqueue_webhooks(new.tenant_id, new.id, 'payout.paid', '{}'::jsonb);
    when 'canceled' then
      perform enqueue_webhooks(new.tenant_id, new.id, 'order.canceled', '{}'::jsonb);
    when 'expired' then
      perform enqueue_webhooks(new.tenant_id, new.id, 'order.expired', '{}'::jsonb);
    else
      -- confirmed_buyer / confirmed_seller are emitted from the confirmations
      -- table instead: the row records which side and whether the timer did it,
      -- and the deal's status alone cannot say. in_progress and
      -- revision_requested have no writer yet.
      null;
  end case;

  return new;
end;
$$;

-- §10.2 names the seller's confirmation `order.delivered` and the buyer's
-- `order.accepted`. Both are the confirmations table's business, since that is
-- the row that knows which side moved and whether the timer did it for them.
create or replace function emit_confirmation_event() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  t uuid;
  v_data jsonb;
begin
  select tenant_id into t from deals where id = new.deal_id;

  v_data := jsonb_build_object('side', new.side, 'actor', new.actor);

  perform enqueue_webhooks(
    t, new.deal_id,
    case when new.side = 'seller' then 'order.delivered' else 'order.accepted' end,
    v_data
  );

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Nothing but the service role may call the new ones
-- ---------------------------------------------------------------------------

revoke all on function mature_clearing_deals(int) from public, anon, authenticated;

-- The guard predicate is deliberately readable by anyone: it is a description
-- of the state machine, not a way into it. The dashboard uses it to grey out
-- an action that could not succeed.
grant execute on function deal_transition_allowed(deal_status, deal_status)
  to anon, authenticated, service_role;
