-- ---------------------------------------------------------------------------
-- release_deal refuses a split deal with money still owed
-- ---------------------------------------------------------------------------
--
-- `20260815000004`'s own header claimed `release_deal` needed zero changes,
-- and that was true of the happy path — `collectBalanceThenConfirm` in
-- `_shared/settle-balance.ts` always calls `settle_deal_balance` before
-- `confirm_deal` when a balance is owed. But that ordering lives entirely in
-- TypeScript. Nothing stopped a future caller of `confirm_deal` (or a
-- correction run by hand at 2am) from completing the pair without ever
-- collecting the balance — `release_deal` would happily release whatever
-- `presentment_amount` currently says, which for an uncollected split deal
-- is only the first installment.
--
-- Every other release guard in this codebase lives under the row lock
-- because that is the only place it can be trusted; a TypeScript caller
-- always doing the right thing is a convention, not a guarantee. This adds
-- the one line that makes it one: `release_deal` now refuses outright when
-- `balance_amount` is still positive, the same shape as its refusal of a
-- refunded deal a few lines above.

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

  -- The one new guard. Checked under the same lock as everything else here,
  -- so a caller that skipped `settle_deal_balance` — by mistake, or by a
  -- future code path this migration cannot see — is refused rather than
  -- releasing a deal for less than it is actually owed.
  if d.balance_amount is not null and d.balance_amount > 0 then
    raise exception 'invalid_state: deal % still owes its balance and cannot be released until it is collected', p_deal_id
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
