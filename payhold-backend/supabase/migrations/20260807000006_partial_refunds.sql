-- ---------------------------------------------------------------------------
-- V2 §7.1: full, partial and line-item refunds
-- ---------------------------------------------------------------------------
--
-- This overrides V1's recorded decision that refunds are all-or-nothing
-- (spec §29.6). Three things change: refunds become their own record rather
-- than a bare ledger entry, they take an amount, and where in the lifecycle
-- they land decides what the ledger does.
--
-- ## What `partially_refunded` is not
--
-- §6 lists it as a state and this migration **does not write it** — see §29.8.
-- A partial refund is an amount, not a lifecycle position. A deal refunded by a
-- third before release still has to be delivered, confirmed, cleared and paid
-- out for the other two thirds; a deal whose status said `partially_refunded`
-- would be outside `HOLDING_STATUSES`, unreachable by `confirm_deal`, invisible
-- to `mature_clearing_deals`, and undispatchable. Collapsing "how far along is
-- this deal" and "how much has gone back" into one column makes the second
-- readable at the cost of the first.
--
-- How much has been refunded is derived — from `refunds`, and from
-- `deal_amounts.refunded`. Only a **full** refund is a lifecycle event, and it
-- has always had a state of its own.
--
-- ## §7.1's four cases, and which are reachable here
--
--   1. Before capture — nothing arrived, so there is nothing to send back. The
--      deposit pre-auth has its own path (`release_deposit`, §22).
--   2. After capture, before release — the money is in the hold. One `refund`
--      entry; the rest stays held and the deal carries on.
--   3. After release, before payout — §7.1.3's "reverse the seller payable".
--      A `release` entry of the opposite sign puts the amount back into the
--      hold, and a `refund` takes it out to the buyer. Booking only the refund
--      would drive `held` negative, because `held` is `hold + release + refund`
--      and the release has already cancelled the hold.
--   4. After payout — the money is with the seller and is not ours to send.
--      `receivable` books what they owe us and the refund is left `pending`
--      for a person. §7.1.4 also says "use reserves where available"; in this
--      model there are never any, because a reserve ends at `payout_due_at` and
--      a payout cannot happen before it. Rather than write a branch that can
--      never run, this says so.

-- ---------------------------------------------------------------------------
-- The record — §11's `refunds`
-- ---------------------------------------------------------------------------

-- §7.1.6: Alipay and WeChat Pay refund asynchronously, and Stripe documents
-- Alipay refunds up to 90 days out with status arriving by webhook. A refund is
-- therefore a thing with a lifetime, not an instant.
create type refund_status as enum ('pending', 'succeeded', 'failed');

create table refunds (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  deal_id       uuid not null references deals(id) on delete restrict,
  -- Presentment currency: a refund goes back the way the money came.
  amount        bigint not null check (amount > 0),
  currency      currency_code not null,
  reason        text not null,
  /**
   * §7.1.5's line-item refunds. Free-form on purpose — v1 deals have no line
   * items of our own to reference, so this is the client's own breakdown of
   * what they are giving back, carried for the audit record rather than
   * interpreted.
   */
  line_items    jsonb,
  status        refund_status not null default 'succeeded',
  -- Who asked. §7.1.5 requires an actor on every refund.
  actor         text not null,
  provider_ref  text,
  created_at    timestamptz not null default now(),
  settled_at    timestamptz
);

create index refunds_tenant_idx on refunds(tenant_id, created_at desc);
create index refunds_deal_idx on refunds(deal_id);

alter table refunds enable row level security;

create policy refunds_read on refunds
  for select to authenticated
  using (tenant_id in (select current_tenant_ids()) or is_platform_admin());

-- ---------------------------------------------------------------------------
-- `refunded` no longer implies that no release happened
-- ---------------------------------------------------------------------------
--
-- V1 could only refund a held deal, so `refunded` meant the money never left
-- the hold and `released_at` was necessarily null. §7.1.3 refunds *after*
-- release, which produces a refunded deal that genuinely has a release time —
-- and the timestamp is the truth about it, so the constraint gives way rather
-- than the column.

alter table deals drop constraint released_at_matches_status;

alter table deals add constraint released_at_matches_status check (
  status in ('partially_refunded', 'disputed', 'refunded')
  or ((status in ('clearing', 'released', 'payout_pending', 'paid_out'))
      = (released_at is not null))
);

-- ---------------------------------------------------------------------------
-- The clearing pool, in one place
-- ---------------------------------------------------------------------------
--
-- The same expression `rail_balances` uses, for one deal. It exists because
-- three copies of this deduction list already have to agree — here,
-- `_shared/figures.ts`, and the dashboard mock — and a refund that shrinks a
-- payout needs to read the pool before and after.

create or replace function deal_clearing_pool(p_deal uuid)
returns bigint
language sql
stable
as $$
  select coalesce(sum(
    case entry_type
      when 'release'         then -amount
      when 'fee'             then  amount
      when 'provider_fee'    then  amount
      when 'tax'             then  amount
      when 'reserve'         then  amount
      when 'reserve_release' then  amount
      when 'payout'          then  amount
      else 0
    end), 0)::bigint
  from ledger where deal_id = p_deal;
$$;

-- What is still in the hold for this deal: `hold + release + refund`, the same
-- expression `rail_balances` calls `held`.
--
-- Note what `release_deal` does **not** do with this. Deriving the amount to
-- release from the ledger would be the purer choice, but it makes releasing
-- depend on a `hold` entry existing, and `fund_deal` is the only thing that
-- writes one. The two are equal in production by construction; they are not
-- equal in a fixture that sets a status directly. Release therefore works from
-- `presentment_amount` less what has been refunded, which is the same number
-- wherever the ledger is complete and a clearer statement of the intent.
create or replace function deal_held_amount(p_deal uuid)
returns bigint
language sql
stable
as $$
  select coalesce(sum(amount) filter (
    where entry_type in ('hold', 'release', 'refund')), 0)::bigint
  from ledger where deal_id = p_deal;
$$;

-- ---------------------------------------------------------------------------
-- Release lets out what is actually held
-- ---------------------------------------------------------------------------
--
-- V1 released `presentment_amount`, which was the same number as the hold
-- because nothing could reduce it. A partial refund before release can now, and
-- releasing the original figure would let out money that is no longer there —
-- the clearing pool would carry the refunded amount as well, and the
-- reconciliation pass would report it as drift.
--
-- Only that one line changes; the lock, the both-confirmations re-check, the
-- reserve and the payout row are all as `20260807000004` left them.

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
  v_held          bigint;
  v_refunded      bigint;
  v_pool          bigint;
  v_reserve       bigint := 0;
  v_reserve_days  integer := 0;
  v_prior_payouts integer;
begin
  select * into d from deals where id = p_deal_id for update;

  if not found then
    raise exception 'not_found: deal % does not exist', p_deal_id
      using errcode = 'no_data_found';
  end if;

  if d.status in ('clearing', 'released', 'payout_pending', 'paid_out') then
    return d;
  end if;

  if d.status = 'refunded' then
    raise exception 'invalid_state: deal % was refunded and cannot be released', p_deal_id
      using errcode = 'check_violation';
  end if;

  select
    exists (select 1 from confirmations where deal_id = d.id and side = 'buyer'),
    exists (select 1 from confirmations where deal_id = d.id and side = 'seller')
  into v_has_buyer, v_has_seller;

  if not (v_has_buyer and v_has_seller) then
    raise exception 'invalid_state: release requires both confirmations'
      using errcode = 'check_violation';
  end if;

  -- What the buyer paid, less anything already sent back. A failed refund never
  -- left, so it does not reduce what there is to release.
  select coalesce(sum(amount), 0)
    into v_refunded
    from refunds where deal_id = d.id and status <> 'failed';

  v_held := d.presentment_amount - v_refunded;

  if v_held <= 0 then
    raise exception 'invalid_state: deal % has nothing held to release', p_deal_id
      using errcode = 'check_violation';
  end if;

  v_clearance := coalesce(
    d.clearing_days,
    setting_num(d.tenant_id, 'clearance_days', 14)::integer
  );

  if setting_num(d.tenant_id, 'reserve_rate', 0) > 0 then
    select count(*)::integer into v_prior_payouts
      from payouts
     where seller_id = d.seller_id and status = 'paid';

    if v_prior_payouts < setting_num(d.tenant_id, 'reserve_after_payouts', 3)::integer then
      v_pool := v_held - p_fee_presentment - d.provider_fee_amount - d.tax_amount;
      v_reserve := greatest(0, floor(v_pool * setting_num(d.tenant_id, 'reserve_rate', 0))::bigint);
      v_reserve_days := setting_num(d.tenant_id, 'reserve_days', 30)::integer;
    end if;
  end if;

  update deals
     set status         = 'clearing',
         released_at    = v_released_at,
         payout_due_at  = v_released_at
                          + make_interval(days => v_clearance + v_reserve_days),
         reserve_amount = v_reserve,
         reserve_until  = case when v_reserve > 0
                            then v_released_at
                                 + make_interval(days => v_clearance + v_reserve_days)
                          end
   where id = d.id
  returning * into d;

  perform write_ledger(d, 'release', -v_held);
  perform write_ledger(d, 'fee', -p_fee_presentment);

  if d.tax_amount > 0 then
    perform write_ledger(d, 'tax', -d.tax_amount);
  end if;

  if v_reserve > 0 then
    perform write_ledger(d, 'reserve', -v_reserve);
  end if;

  if d.deposit_amount is not null and not deposit_settled(d.id) then
    perform write_ledger(d, 'deposit_release', -d.deposit_amount);
  end if;

  insert into payouts (tenant_id, deal_id, seller_id, amount, currency, status, scheduled_for)
  values (d.tenant_id, d.id, d.seller_id, p_payout_amount, p_payout_currency,
          'scheduled', d.payout_due_at)
  on conflict (deal_id) do nothing;

  perform write_audit(d.tenant_id, d.id, 'system', 'deal.released', jsonb_build_object(
    'fee_amount', d.fee_amount,
    'released', v_held,
    'net', p_payout_amount,
    'paid_in', p_payout_currency,
    'clearing_days', v_clearance,
    'reserve_amount', v_reserve,
    'payout_due_at', d.payout_due_at
  ));

  return d;
end;
$$;

revoke all on function deal_held_amount(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- refund_deal
-- ---------------------------------------------------------------------------
--
-- The old three-argument form is dropped rather than replaced: `create or
-- replace` cannot change a signature, it adds a sibling, and a three-argument
-- call would then be ambiguous — or worse, resolve to the one that cannot take
-- an amount. Phase 2 found exactly that trap in `fund_deal`.
--
-- The first three parameters keep their order and meaning, so `resolve_dispute`
-- and every existing caller still say what they said and still mean a full
-- refund.

drop function if exists refund_deal(uuid, text, text);

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
    if v_payout.id is not null and v_pool_before > 0 then
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

    -- Nothing is owed any more, so nothing should be scheduled.
    update payouts set status = 'failed', failure_reason = 'Deal was refunded'
     where deal_id = d.id and status in ('scheduled', 'frozen', 'held_for_review');
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

-- ---------------------------------------------------------------------------
-- The breakdown gains what the seller owes us
-- ---------------------------------------------------------------------------

drop function if exists deal_amounts(uuid);

create or replace function deal_amounts(p_deal uuid)
returns table (
  currency       currency_code,
  buyer_paid     bigint,
  platform_fee   bigint,
  provider_fee   bigint,
  tax            bigint,
  reserve        bigint,
  refunded       bigint,
  receivable     bigint,
  paid_out       bigint,
  seller_net     bigint
)
language sql
stable
as $$
  select
    d.presentment_currency,
    coalesce(sum(l.amount) filter (where l.entry_type = 'hold'), 0)::bigint,
    coalesce(-sum(l.amount) filter (where l.entry_type = 'fee'), 0)::bigint,
    coalesce(-sum(l.amount) filter (where l.entry_type = 'provider_fee'), 0)::bigint,
    coalesce(-sum(l.amount) filter (where l.entry_type = 'tax'), 0)::bigint,
    coalesce(-sum(
      case l.entry_type
        when 'reserve'         then l.amount
        when 'reserve_release' then l.amount
        else 0
      end), 0)::bigint,
    coalesce(-sum(l.amount) filter (where l.entry_type = 'refund'), 0)::bigint,
    -- §7.1.4. Owed to us by the seller, and with nobody yet. It is in no
    -- balance bucket for that reason: the buckets say what a provider holds.
    coalesce(sum(l.amount) filter (where l.entry_type = 'receivable'), 0)::bigint,
    coalesce(-sum(l.amount) filter (where l.entry_type = 'payout'), 0)::bigint,
    coalesce(sum(
      case l.entry_type
        when 'release'         then -l.amount
        when 'fee'             then  l.amount
        when 'provider_fee'    then  l.amount
        when 'tax'             then  l.amount
        when 'reserve'         then  l.amount
        when 'reserve_release' then  l.amount
        when 'payout'          then  l.amount
        else 0
      end), 0)::bigint
  from deals d
  left join ledger l on l.deal_id = d.id
  where d.id = p_deal
  group by d.id, d.presentment_currency;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
--
-- **A new signature is granted to PUBLIC by default.** Dropping and recreating
-- a money function silently widens who can call it unless this block runs, and
-- that includes `payhold_ai` — invariant 9 is a grant list, not a convention.
-- `tests/intelligence.test.ts` matches on the function *name*, so it fails if
-- this is forgotten.

revoke all on function refund_deal(uuid, text, text, bigint, jsonb)
  from public, anon, authenticated;
revoke all on function refund_deal(uuid, text, text, bigint, jsonb) from payhold_ai;
revoke all on function deal_clearing_pool(uuid) from public, anon, authenticated;

grant select on refunds to authenticated;

-- ---------------------------------------------------------------------------
-- The dispute assistant can finally draft a split — §24.2, §29.6
-- ---------------------------------------------------------------------------
--
-- V1's `escalate` was not a judgement about what models are good at. It was the
-- only honest answer available: the engine had no way to carry out "give the
-- buyer a third back", so a draft describing one would have been a suggestion
-- nobody could approve. §7.1 removes that constraint, so the recommendation
-- becomes real.
--
-- **Invariant 9 is unchanged and this is where to check that.** The model
-- proposes an amount; it still holds no execute on `refund_deal`,
-- `resolve_dispute` or anything else that moves money. The bridge is here, in a
-- locked function that refuses to run without a named approver, and the
-- approval is what writes to the ledger.

drop function if exists resolve_dispute(uuid, text, text, bigint, currency_code, bigint);

create or replace function resolve_dispute(
  p_dispute_id       uuid,
  p_resolution       text,
  p_note             text,
  p_payout_amount    bigint,
  p_payout_currency  currency_code,
  p_fee_presentment  bigint,
  -- Only for `partial_refund`: what goes back to the buyer, presentment.
  p_refund_amount    bigint default null
) returns disputes
language plpgsql
security definer
set search_path = public
as $$
declare
  dsp     disputes;
  d       deals;
  v_scale numeric;
  v_payout bigint;
begin
  select * into dsp from disputes where id = p_dispute_id for update;

  if not found then
    raise exception 'not_found: dispute % does not exist', p_dispute_id
      using errcode = 'no_data_found';
  end if;

  if dsp.status <> 'open' then
    raise exception 'invalid_state: this dispute is already resolved'
      using errcode = 'check_violation';
  end if;

  select * into d from deals where id = dsp.deal_id for update;

  if p_resolution = 'release' then
    -- Back out of `disputed` so the release guard sees a normal held deal.
    update deals set status = 'funded_held' where id = d.id;

    insert into confirmations (deal_id, side, actor)
    values (d.id, 'buyer', 'auto'), (d.id, 'seller', 'auto')
    on conflict (deal_id, side) do nothing;

    perform release_deal(d.id, p_payout_amount, p_payout_currency, p_fee_presentment);
    dsp.status := 'resolved_released';

  elsif p_resolution = 'refund' then
    update deals set status = 'funded_held' where id = d.id;
    perform refund_deal(d.id, 'Dispute resolved in buyer''s favour: ' || p_note,
                        'payhold-staff');
    dsp.status := 'resolved_refunded';

  elsif p_resolution = 'partial_refund' then
    if p_refund_amount is null or p_refund_amount <= 0 then
      raise exception 'policy_violation: a partial refund must name an amount'
        using errcode = 'check_violation';
    end if;
    if p_refund_amount >= d.presentment_amount then
      raise exception 'policy_violation: a partial refund cannot be the whole payment — resolve it as a refund'
        using errcode = 'check_violation';
    end if;

    update deals set status = 'funded_held' where id = d.id;

    -- The buyer's share first, so the release that follows lets out only what
    -- is left. `release_deal` reads that for itself.
    perform refund_deal(d.id, 'Dispute resolved in part: ' || p_note,
                        'payhold-staff', p_refund_amount);

    -- What the seller receives shrinks in the same proportion. Scaled rather
    -- than converted, for the reason `refund_deal` scales a scheduled payout:
    -- the payout is in the seller's currency and the refund is in the buyer's,
    -- and inventing a rate here would disagree with `amountLeaving` at
    -- dispatch.
    v_scale := (d.presentment_amount - p_refund_amount)::numeric / d.presentment_amount;
    v_payout := greatest(1, floor(p_payout_amount * v_scale)::bigint);

    insert into confirmations (deal_id, side, actor)
    values (d.id, 'buyer', 'auto'), (d.id, 'seller', 'auto')
    on conflict (deal_id, side) do nothing;

    perform release_deal(d.id, v_payout, p_payout_currency,
                         floor(p_fee_presentment * v_scale)::bigint);
    dsp.status := 'resolved_split';

  else
    raise exception 'policy_violation: resolution must be release, refund or partial_refund'
      using errcode = 'check_violation';
  end if;

  update disputes
     set status = dsp.status,
         resolved_at = now(),
         resolution_note = p_note
   where id = dsp.id
  returning * into dsp;

  perform write_audit(d.tenant_id, d.id, 'payhold-staff', 'dispute.resolved',
                      jsonb_build_object(
                        'resolution', p_resolution,
                        'refund_amount', p_refund_amount,
                        'note', p_note
                      ));

  return dsp;
end;
$$;

-- `decide_ai_suggestion` keeps its signature; only what it does with the
-- recommendation changes. The amount comes off the suggestion the approver was
-- looking at, never off the request — the same reason the approver's name comes
-- from the session.
create or replace function decide_ai_suggestion(
  p_suggestion_id   uuid,
  p_decision        ai_decision,
  p_decided_by      text,
  p_payout_amount   bigint default null,
  p_payout_currency currency_code default null,
  p_fee_presentment bigint default null
) returns ai_suggestions
language plpgsql
security definer
set search_path = public
as $$
declare
  s    ai_suggestions;
  dsp  disputes;
  rec  text;
begin
  if p_decided_by is null or btrim(p_decided_by) = '' then
    raise exception 'policy_violation: a decision must record who made it'
      using errcode = 'check_violation';
  end if;

  select * into s from ai_suggestions where id = p_suggestion_id for update;

  if not found then
    raise exception 'not_found: suggestion % does not exist', p_suggestion_id
      using errcode = 'no_data_found';
  end if;

  if s.decision is not null then
    raise exception 'invalid_state: that suggestion has already been decided'
      using errcode = 'check_violation';
  end if;

  update ai_suggestions
     set decision    = p_decision,
         decided_by  = p_decided_by,
         decided_at  = now()
   where id = s.id
  returning * into s;

  perform write_audit(
    s.tenant_id, s.deal_id, p_decided_by, 'ai.suggestion_' || p_decision,
    jsonb_build_object(
      'suggestion_id', s.id,
      'kind', s.kind,
      'model', s.model,
      'prompt_version', s.prompt_version,
      'input_hash', s.input_hash
    )
  );

  if p_decision <> 'approved' or s.kind <> 'dispute_resolution' then
    return s;
  end if;

  rec := s.output ->> 'recommendation';

  -- `escalate` still exists and still means what it says: the evidence divides
  -- in a way no split resolves, and a person should look. What changed is that
  -- it is no longer the only answer available when the truth is "some of it".
  if rec is null or rec = 'escalate' then
    return s;
  end if;

  select * into dsp
    from disputes
   where deal_id = s.deal_id and status = 'open'
   for update;

  -- The draft was open while somebody resolved the dispute by hand. Recording
  -- the approval and stopping is right: re-resolving would be a second
  -- decision nobody made.
  if not found then
    raise exception 'invalid_state: that dispute was resolved while the draft was open'
      using errcode = 'check_violation';
  end if;

  perform resolve_dispute(
    dsp.id,
    rec,
    coalesce(s.output ->> 'headline', 'Approved from an AI draft')
      || ' Drafted by ' || s.model || ' (' || s.id || '), approved by '
      || p_decided_by || '.',
    p_payout_amount,
    p_payout_currency,
    p_fee_presentment,
    -- Validated on the way in (`ai-validate.ts`) and again by `resolve_dispute`,
    -- which refuses a null or whole-payment amount.
    (s.output ->> 'refund_amount')::bigint
  );

  return s;
end;
$$;

-- Both were dropped or replaced, and a new signature is granted to PUBLIC by
-- default. Invariant 9 is a grant list.
revoke all on function resolve_dispute(uuid, text, text, bigint, currency_code, bigint, bigint)
  from public, anon, authenticated;
revoke all on function resolve_dispute(uuid, text, text, bigint, currency_code, bigint, bigint)
  from payhold_ai;
revoke all on function decide_ai_suggestion(uuid, ai_decision, text, bigint, currency_code, bigint)
  from public, anon, authenticated;
revoke all on function decide_ai_suggestion(uuid, ai_decision, text, bigint, currency_code, bigint)
  from payhold_ai;

-- The outcome label follows. `label_dispute_outcome` carried a two-way `case`
-- and a comment saying v1 has no partial refund; both are now wrong.
create or replace function label_dispute_outcome() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  d deals;
begin
  select * into d from deals where id = new.deal_id;
  if not found then
    return new;
  end if;

  perform record_deal_outcome(
    d,
    case new.status
      when 'resolved_released' then 'dispute_released'::deal_outcome_label
      when 'resolved_split'    then 'dispute_split'::deal_outcome_label
      else 'dispute_refunded'::deal_outcome_label
    end,
    'dispute_' || new.raised_by || '_raised',
    new.resolution_note,
    -- What was actually contested. For a split that is the part that went
    -- back, not the whole deal — §24.4 trains on this figure.
    -- Cast: `sum()` is numeric and `d.amount` is bigint, so the `case` would
    -- otherwise resolve to numeric and miss the function signature entirely.
    (case when new.status = 'resolved_split'
       then (select coalesce(sum(amount), 0) from refunds
              where deal_id = d.id and status <> 'failed')
       else d.amount
     end)::bigint
  );

  return new;
end;
$$;
