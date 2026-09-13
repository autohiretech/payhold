-- A payout may not promise more than the pool it is paid from.
--
-- Two functions computed "what the seller gets" and they did not agree.
-- `rail_balances` and `release_deal`'s own `v_pool` say it is what was held
-- less the platform fee, the provider's fee, tax and any reserve — all in the
-- presentment currency. `releaseFigures` in TypeScript said it was
-- `deal.amount - deal.fee_amount`, settlement money with only the platform fee
-- taken out, and that is the number that went into `payouts.amount`.
--
-- On a live Kigali deal charged RWF 471,800 the two came out at RWF 405,347
-- and RWF 424,620. The seller's wallet showed the first and their payout was
-- created for the second. Had it settled, `settle_payout` would have booked
-- the pool leaving our vault (405,347) while the rail sent the seller 424,620
-- — RWF 19,273 per payout out of the platform's own provider balance, invisible
-- in every screen either side, and showing up only as reconciliation drift
-- against the real Flutterwave balance, which freezes payouts for a reason
-- nobody could name.
--
-- The caller's arithmetic is corrected in `_shared/figures.ts`, where the pool
-- is now computed on the presentment side with every deduction the ledger
-- makes. This is the half that makes it structural: `v_pool` moves out of the
-- reserve branch it was hiding in, loses the reserve, and clamps the inserted
-- payout wherever the two figures are in the same currency and can therefore
-- be compared at all.
--
-- Same signature, so `create or replace`. The whole body is restated because
-- that is what this file must remain readable as: the current definition of
-- release_deal, not a diff against an older one.

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

  -- The seller's share, in the currency the buyer was charged. Computed
  -- unconditionally now: it used to exist only inside the reserve branch, and
  -- the payout figure that got inserted below was a different arithmetic
  -- altogether, arriving from TypeScript on the settlement side.
  v_pool := v_held - p_fee_presentment - d.provider_fee_amount - d.tax_amount;

  if setting_num(d.tenant_id, 'reserve_rate', 0) > 0 then
    select count(*)::integer into v_prior_payouts
      from payouts
     where seller_id = d.seller_id and status = 'paid';

    if v_prior_payouts < setting_num(d.tenant_id, 'reserve_after_payouts', 3)::integer then
      v_reserve := greatest(0, floor(v_pool * setting_num(d.tenant_id, 'reserve_rate', 0))::bigint);
      v_reserve_days := setting_num(d.tenant_id, 'reserve_days', 30)::integer;
    end if;
  end if;

  -- What is actually left for the seller once the reserve is carved out.
  v_pool := v_pool - v_reserve;

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

  -- A payout can never promise more than the pool it is paid from.
  --
  -- `p_payout_amount` is computed in TypeScript, which owns FX; `v_pool` is
  -- computed here, from the ledger's own deductions. When both are in the same
  -- currency they are the same question asked twice, and on 2026-09-12 they
  -- disagreed by RWF 19,273 on a live deal: the caller's figure had the
  -- platform fee taken out and the provider's fee left in. The seller was
  -- promised money the pool did not contain, and `settle_payout` would have
  -- booked the pool while the rail sent the larger figure — the difference
  -- coming quietly out of our own provider balance, once per payout.
  --
  -- The caller's arithmetic is fixed, and this makes it unable to matter. Only
  -- the same-currency case can be compared at all, which is the case that can
  -- be wrong in a way arithmetic here could catch; a converted figure is
  -- governed by `amountLeaving` at the other end of the journey.
  insert into payouts (tenant_id, deal_id, seller_id, amount, currency, status, scheduled_for)
  values (d.tenant_id, d.id, d.seller_id,
          case when p_payout_currency = d.presentment_currency
               then least(p_payout_amount, v_pool)
               else p_payout_amount end,
          p_payout_currency,
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
