-- ---------------------------------------------------------------------------
-- V2 §7: the money breakdown, part two
-- ---------------------------------------------------------------------------
--
-- Three things happen here, and the first is a bug fix rather than a feature.
--
-- ## The platform fee was making the reconciliation pass lie
--
-- `rail_balances` derived the clearing pool as `−release + fee + payout`, and
-- `reconcile` asks the provider whether it is holding `held + pending + available`.
-- The fee is a debit in that pool, so a released, not-yet-paid deal expected the
-- provider to be holding the amount *minus our commission*.
--
-- It is not. Nothing sweeps PayHold's fee out of the tenant's provider balance
-- — under bring-your-own-keys there is no such transfer, and the fee is revenue
-- reclassified rather than funds moved. So a 100,000 deal with a 10,000 fee
-- expected 90,000 and the provider reported 100,000: drift of exactly the fee,
-- on every released deal, and **drift freezes that tenant's payouts
-- automatically**. The sandbox walkthrough in the testing gate would have hit
-- this on its first deal.
--
-- The fix is a bucket. `fees_retained` is money that has stopped being the
-- seller's but has not left the vault, and `reconcile` counts it as still
-- present. `tax` joins it for the same reason: collected from the buyer, owed
-- onward, physically here until remitted.
--
-- `provider_fee` is the opposite case and is why the distinction is worth
-- drawing at all: the rail genuinely took that money, so it reduces what we
-- expect the provider to hold and belongs in no retained bucket.
--
-- ## Reserve — §6.1
--
-- A new seller's payout waits longer. The extra days are on `payout_due_at`
-- already, so the reserve bucket is not what stops the transfer; what it does
-- is make the amount **unpayable and visible as such** — carved out of the
-- clearing pool into `reserved`, where `available` cannot see it and
-- `amountLeaving` will not send it.
--
-- The carve-out is returned by `release_due_reserves()` at exactly the moment
-- the payout comes due, so the single payout row this deal is allowed (see
-- `payouts_deal_key`) goes out whole. A reserve that outlived the payout would
-- need a second transfer per deal, and that unique index exists to make a
-- second transfer impossible.
--
-- ## Currency
--
-- Every column added here is in the **presentment** currency — what the buyer
-- was actually charged. `amount` and `fee_amount` are settlement, and mixing
-- the two in one breakdown is how a total stops adding up. Tax and discounts
-- are quoted to a buyer, so presentment is also the currency they are decided
-- in; no conversion is needed and `release_deal`'s signature does not change.

-- ---------------------------------------------------------------------------
-- What the buyer was charged, itemised — §7
-- ---------------------------------------------------------------------------

alter table deals
  -- Collected from the buyer and owed onward. Never the seller's.
  add column tax_amount          bigint not null default 0 check (tax_amount >= 0),
  -- Reduces what the buyer pays. Recorded so the breakdown adds up rather than
  -- appearing as a smaller price with no explanation.
  add column discount_amount     bigint not null default 0 check (discount_amount >= 0),
  -- What the rail charged us. Provisional until the provider reports it at
  -- funding; zero on rails that do not itemise.
  add column provider_fee_amount bigint not null default 0 check (provider_fee_amount >= 0),
  -- §6.1's new-seller hold, and when it ends. Set at release, both or neither.
  add column reserve_amount      bigint not null default 0 check (reserve_amount >= 0),
  add column reserve_until       timestamptz,
  add constraint reserve_is_all_or_nothing
    check ((reserve_amount > 0) = (reserve_until is not null));

comment on column deals.tax_amount is
  'Presentment currency, like every amount column added in V2 §7. `amount` and '
  '`fee_amount` are settlement — do not add the two together.';

-- ---------------------------------------------------------------------------
-- Balances — six buckets now, still derived and never stored
-- ---------------------------------------------------------------------------

-- Both gain columns, and Postgres will not let `create or replace` change a
-- function's return type. Dropped rather than renamed so no caller keeps the
-- old four-bucket shape by accident. Nothing depends on them structurally —
-- the money functions call them from plpgsql bodies, which Postgres does not
-- track as a dependency.
drop function if exists tenant_balances(uuid);
drop function if exists rail_balances(uuid) cascade;

create or replace function rail_balances(p_tenant uuid)
returns table (
  provider           provider,
  currency           currency_code,
  held               bigint,
  pending_clearance  bigint,
  available          bigint,
  reserved           bigint,
  fees_retained      bigint,
  paid_out           bigint
)
language sql
stable
as $$
  with per_deal as (
    select
      l.deal_id,
      -- The rail and currency of the deal's first entry: the hold that
      -- started it. Later entries follow the same rail by construction.
      (array_agg(l.provider order by l.created_at, l.id))[1] as provider,
      (array_agg(l.currency order by l.created_at, l.id))[1] as currency,
      coalesce(sum(l.amount) filter (
        where l.entry_type in ('hold', 'release', 'refund')), 0) as held,
      -- What the seller is owed and could still be sent. Every deduction that
      -- is not theirs comes out here; `reserve` comes out too and goes into its
      -- own bucket rather than disappearing.
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
        end), 0) as clearing,
      -- Carved out of the pool above and not payable. `reserve` is stored
      -- negative and `reserve_release` positive, so the two net to zero the
      -- moment the hold ends.
      coalesce(sum(
        case l.entry_type
          when 'reserve'         then -l.amount
          when 'reserve_release' then -l.amount
          else 0
        end), 0) as reserved,
      -- Stopped being the seller's, still in the vault. This is the bucket
      -- whose absence made every released deal look like drift.
      coalesce(sum(
        case l.entry_type
          when 'fee' then -l.amount
          when 'tax' then -l.amount
          else 0
        end), 0) as retained,
      coalesce(-sum(l.amount) filter (where l.entry_type = 'payout'), 0) as paid,
      max(d.payout_due_at) as payout_due_at
    from ledger l
    join deals d on d.id = l.deal_id
    where l.tenant_id = p_tenant
      and l.deal_id is not null
    group by l.deal_id
  )
  select
    p.provider,
    p.currency,
    sum(p.held)::bigint,
    -- `filter` yields NULL when no row matches, and a balance of NULL is not a
    -- balance. Every bucket coalesces to zero so they always add up.
    coalesce(sum(p.clearing) filter (
      where p.payout_due_at is null or p.payout_due_at > now()), 0)::bigint,
    coalesce(sum(p.clearing) filter (
      where p.payout_due_at is not null and p.payout_due_at <= now()), 0)::bigint,
    sum(p.reserved)::bigint,
    sum(p.retained)::bigint,
    sum(p.paid)::bigint
  from per_deal p
  group by p.provider, p.currency
  -- Cast to text so rails sort alphabetically rather than by the order the
  -- enum happens to declare them, matching what the dashboard shows.
  order by p.provider::text, p.currency;
$$;

-- The same buckets summed across rails. Note this is NOT the reconciliation
-- view: reconciliation compares each provider's rows separately, because
-- "held" is never one pot.
create or replace function tenant_balances(p_tenant uuid)
returns table (
  currency           currency_code,
  held               bigint,
  pending_clearance  bigint,
  available          bigint,
  reserved           bigint,
  fees_retained      bigint,
  paid_out           bigint
)
language sql
stable
as $$
  select
    r.currency,
    sum(r.held)::bigint,
    sum(r.pending_clearance)::bigint,
    sum(r.available)::bigint,
    sum(r.reserved)::bigint,
    sum(r.fees_retained)::bigint,
    sum(r.paid_out)::bigint
  from rail_balances(p_tenant) r
  group by r.currency
  order by r.currency;
$$;

-- ---------------------------------------------------------------------------
-- The §7 breakdown — one deal, every value separately
-- ---------------------------------------------------------------------------
--
-- Derived from the ledger rather than read off columns, for the reason the
-- balance is: a stored total and a set of entries are two numbers that can
-- disagree, and the one a person reads would be the wrong one.
--
-- All in the presentment currency. `buyer_paid` is what actually arrived, so
-- on an unfunded deal every figure is zero — the pre-payment estimate a client
-- shows before checkout comes from the deal's own columns, not from here.

create or replace function deal_amounts(p_deal uuid)
returns table (
  currency       currency_code,
  buyer_paid     bigint,
  platform_fee   bigint,
  provider_fee   bigint,
  tax            bigint,
  reserve        bigint,
  refunded       bigint,
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
    coalesce(-sum(l.amount) filter (where l.entry_type = 'payout'), 0)::bigint,
    -- What is still owed and sendable: the clearing pool, reserve excluded.
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
-- Funding books what the rail took
-- ---------------------------------------------------------------------------
--
-- The provider fee arrives with the transaction we re-fetch to verify the
-- payment (§21.2), so it is known at exactly the moment the hold is booked.
-- Defaulted to zero: a rail that does not itemise its fee, and `FakeProvider`,
-- both behave as before.

-- The nine-argument form is dropped rather than replaced, because a defaulted
-- tenth parameter creates an **overload** instead of a new version. Two
-- `fund_deal`s is not a theoretical hazard: an earlier draft of this phase
-- added one by accident, the webhook went on calling the old one, and every
-- test still passed — because the tests exercising the new statuses were
-- calling the function nothing in production uses.
drop function if exists fund_deal(
  uuid, provider, text, payment_method, text, bigint, currency_code, numeric, numeric);

create or replace function fund_deal(
  p_deal_id            uuid,
  p_provider           provider,
  p_provider_ref       text,
  p_method             payment_method,
  p_network            text,
  p_verified_amount    bigint,
  p_verified_currency  currency_code,
  p_fx_rate            numeric default null,
  p_auto_release_days  numeric default 3,
  -- §7. What the rail charged, in the verified currency.
  p_provider_fee       bigint default 0
) returns deals
language plpgsql
security definer
set search_path = public
as $$
declare
  d                  deals;
  mismatch           boolean;
  expected_amount    bigint;
  expected_currency  currency_code;
begin
  select * into d from deals where id = p_deal_id for update;

  if not found then
    raise exception 'not_found: deal % does not exist', p_deal_id
      using errcode = 'no_data_found';
  end if;

  -- Idempotency (invariant 4). A redelivered webhook carrying the reference we
  -- already recorded is a no-op, not an error: providers retry by design, and
  -- an error would make them retry harder.
  if d.provider_ref is not distinct from p_provider_ref
     and d.status not in ('created', 'checkout_started', 'payment_pending', 'payment_failed')
  then
    return d;
  end if;

  -- V1 accepted `created` and nothing else. §6 puts three states in front of
  -- funding — `/pay` records `payment_pending` before it redirects, a checkout
  -- session records `checkout_started`, and a declined card comes back round
  -- through `payment_failed`. Refusing those would refuse every real payment.
  if d.status not in ('created', 'checkout_started', 'payment_pending', 'payment_failed') then
    raise exception 'invalid_state: deal % is %, cannot be funded', p_deal_id, d.status
      using errcode = 'check_violation';
  end if;

  if p_provider_fee < 0 then
    raise exception 'policy_violation: a provider fee cannot be negative'
      using errcode = 'check_violation';
  end if;

  -- Captured before the update overwrites them with what actually arrived, so
  -- the audit row can say what we were expecting.
  expected_amount := d.presentment_amount;
  expected_currency := d.presentment_currency;

  mismatch := p_verified_amount is distinct from expected_amount
           or p_verified_currency is distinct from expected_currency;

  -- The money is recorded either way. It genuinely arrived at the provider, so
  -- omitting the ledger entry would put us permanently out of step with their
  -- balance and hand the reconciliation cron a mismatch it cannot explain.
  -- What differs is the state: a deal whose payment does not match cannot
  -- become funded_held, so it goes to a human instead.
  update deals
     set status = case when mismatch then 'disputed'::deal_status
                       else 'funded_held'::deal_status end,
         provider = p_provider,
         provider_ref = p_provider_ref,
         payment_method = p_method,
         payment_network = p_network,
         -- Book what actually arrived. Overwriting the expectation with the
         -- truth is what keeps the ledger and the provider in agreement.
         presentment_amount = p_verified_amount,
         presentment_currency = p_verified_currency,
         provider_fee_amount = p_provider_fee,
         fx_rate = case when p_verified_currency is distinct from d.currency
                        then p_fx_rate else null end,
         auto_release_at = case when mismatch then null else
           coalesce(d.expected_complete_at, now()) + (p_auto_release_days || ' days')::interval
         end
   where id = d.id
  returning * into d;

  perform write_ledger(d, 'hold', d.presentment_amount);

  -- Booked at funding rather than at release, because that is when the rail
  -- took it. Deferring it would leave the balance out by the fee for the whole
  -- length of the hold, which is exactly what the reconciliation pass reports.
  if p_provider_fee > 0 then
    perform write_ledger(d, 'provider_fee', -p_provider_fee);
  end if;

  if d.deposit_amount is not null then
    perform write_ledger(d, 'deposit_hold', d.deposit_amount);
  end if;

  perform write_audit(d.tenant_id, d.id, 'system', 'webhook.verified', jsonb_build_object(
    'provider', p_provider,
    'provider_ref', p_provider_ref,
    'provider_fee', p_provider_fee
  ));

  if mismatch then
    perform write_audit(d.tenant_id, d.id, 'system', 'deal.amount_mismatch',
      jsonb_build_object(
        'expected_amount', expected_amount,
        'expected_currency', expected_currency,
        'received_amount', p_verified_amount,
        'received_currency', p_verified_currency
      ));
  else
    perform write_audit(d.tenant_id, d.id, 'system', 'deal.funded_held',
      jsonb_build_object('amount', d.amount, 'currency', d.currency));
  end if;

  return d;
end;
$$;

-- ---------------------------------------------------------------------------
-- Release books the tax and the reserve
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
  v_pool          bigint;
  v_reserve       bigint := 0;
  v_reserve_days  integer := 0;
  v_prior_payouts integer;
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

  -- §6.1's new-seller reserve. Off unless `reserve_rate` is set, so a tenant
  -- that has not configured one behaves exactly as it did before V2.
  --
  -- "New" is counted in payouts actually *paid*, not in deals or days: a seller
  -- the platform has already sent money to successfully is the thing the
  -- reserve is waiting to observe.
  if setting_num(d.tenant_id, 'reserve_rate', 0) > 0 then
    select count(*)::integer into v_prior_payouts
      from payouts
     where seller_id = d.seller_id and status = 'paid';

    if v_prior_payouts < setting_num(d.tenant_id, 'reserve_after_payouts', 3)::integer then
      -- The pool this reserve is a fraction of, in presentment terms: what the
      -- buyer paid, less everything already deducted from it.
      v_pool := d.presentment_amount - p_fee_presentment
                - d.provider_fee_amount - d.tax_amount;
      v_reserve := floor(v_pool * setting_num(d.tenant_id, 'reserve_rate', 0))::bigint;
      v_reserve_days := setting_num(d.tenant_id, 'reserve_days', 30)::integer;
    end if;
  end if;

  -- A reserve is extra days on top of the clearance window (§6.1), and it ends
  -- exactly when the payout comes due. `payouts_deal_key` allows one payout per
  -- deal, so a reserve outliving it would have nothing to be sent by.
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

  -- Money out of the hold, fee taken, deposit returned if it was never settled.
  perform write_ledger(d, 'release', -d.presentment_amount);
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
    'reserve_amount', v_reserve,
    'reserve_days', v_reserve_days,
    'payout_due_at', d.payout_due_at
  ));

  return d;
end;
$$;

-- ---------------------------------------------------------------------------
-- Returning the carve-out
-- ---------------------------------------------------------------------------
--
-- Time is the only input, so this is a set-based pass like
-- `mature_clearing_deals`. It moves nothing between the vault and anywhere
-- else: the money never left. It moves it between two of our own buckets, from
-- one the payout cannot see into one it can.
--
-- Must run **before** the clearing sweep in the same pass. Both are keyed on
-- the same instant, and a deal that matured while its reserve was still carved
-- out would offer the dispatcher a pool short by the reserve.

create or replace function release_due_reserves(p_limit int default 500)
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
    where reserve_amount > 0
      and reserve_until is not null
      and reserve_until <= now()
      and status in ('clearing', 'released')
      -- Not yet returned. The ledger is the record, not a flag column: a flag
      -- and a set of entries are two things that can disagree.
      and not exists (
        select 1 from ledger
        where deal_id = deals.id and entry_type = 'reserve_release'
      )
    order by reserve_until
    limit p_limit
    for update skip locked
  loop
    perform write_ledger(d, 'reserve_release', d.reserve_amount);

    perform write_audit(d.tenant_id, d.id, 'system', 'deal.reserve_released',
      jsonb_build_object('amount', d.reserve_amount, 'reserve_until', d.reserve_until));

    return next d;
  end loop;
end;
$$;

create index deals_reserve_due_idx on deals(reserve_until)
  where reserve_amount > 0;

revoke all on function release_due_reserves(int) from public, anon, authenticated;
revoke all on function fund_deal(
  uuid, provider, text, payment_method, text, bigint, currency_code, numeric, numeric, bigint)
  from public, anon, authenticated;
