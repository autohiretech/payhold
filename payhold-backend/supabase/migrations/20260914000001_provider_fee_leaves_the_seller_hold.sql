-- ---------------------------------------------------------------------------
-- The rail's cut comes off the seller's hold too, not only the tenant's
-- ---------------------------------------------------------------------------
--
-- `20260912000003` fixed `rail_balances`: while a deal is still held, the
-- provider's fee is subtracted from `held` (the rail has already taken it) and
-- kept out of `clearing` (nothing is owed to a seller nobody has released to).
-- Its header describes the symptom — HELD NGN 61K beside CLEARING −NGN 847.17,
-- both wrong by the same number in opposite directions.
--
-- `seller_wallet_rows` was written as that function's deliberate mirror,
-- "identical to `rail_balances`, including the signs, which are what make the
-- two views reconcile" — and it was not touched on the 12th. So the Sellers
-- screen went on showing exactly the symptom the Overview stopped showing:
-- reading the live project on 2026-09-14, the same NGN deal is `held 59,664.57`
-- on the Overview and `In progress NGN 61K · Clearing −NGN 847.17` on Sellers.
-- Two screens, two answers to one number, one of them a negative debt to a
-- seller who is owed nothing.
--
-- The invariant `tests/seller-wallet.test.ts` pins — every wallet summed IS the
-- tenant balance, bucket for bucket — was still passing, because no fixture in
-- that file books a provider fee. It does now.
--
-- This applies the identical rule. `released` is the set of deals with a
-- `release` entry; for a deal not in it the fee reduces `held`, for a deal in it
-- the fee lands in `clearing` where the release already accounted for it.
-- Nothing else moves: the currency choice, the payout_due_at split into
-- pending/available, reserved and paid_out are byte-for-byte the previous body.
--
-- Same signature, so `create or replace` is a true replace and every existing
-- grant carries forward; `seller_balance` and `tenant_seller_wallets` both
-- delegate here, so one fix is all three readers.

create or replace function seller_wallet_rows(
  p_tenant uuid default null,
  p_seller uuid default null
)
returns table (
  seller_id          uuid,
  seller_name        text,
  seller_country     country_code,
  currency           currency_code,
  held               bigint,
  pending_clearance  bigint,
  available          bigint,
  reserved           bigint,
  paid_out           bigint
)
language sql
stable
as $$
  with released as (
    select distinct l.deal_id
      from ledger l
     where l.deal_id is not null
       and l.entry_type = 'release'
       and (p_tenant is null or l.tenant_id = p_tenant)
  ),
  per_deal as (
    select
      d.seller_id,
      l.deal_id,
      -- The currency of the deal's first entry: the hold that started it.
      -- Later entries follow it by construction.
      (array_agg(l.currency order by l.created_at, l.id))[1] as currency,
      -- Gross, less the rail's cut while the deal is still held — the rail has
      -- already taken it. Once released the hold is emptied by the `release`
      -- entry and the fee is accounted for in the clearing pool instead.
      coalesce(sum(l.amount) filter (
        where l.entry_type in ('hold', 'release', 'refund')), 0)
      + case when r.deal_id is null then
          coalesce(sum(l.amount) filter (where l.entry_type = 'provider_fee'), 0)
        else 0 end as held,
      -- The clearing pool — what this seller is owed and could still be sent.
      -- Identical to `rail_balances`, including the signs.
      coalesce(sum(
        case l.entry_type
          when 'release'         then -l.amount
          when 'fee'             then  l.amount
          when 'tax'             then  l.amount
          when 'reserve'         then  l.amount
          when 'reserve_release' then  l.amount
          when 'payout'          then  l.amount
          else 0
        end), 0)
      + case when r.deal_id is not null then
          coalesce(sum(l.amount) filter (where l.entry_type = 'provider_fee'), 0)
        else 0 end as clearing,
      coalesce(sum(
        case l.entry_type
          when 'reserve'         then -l.amount
          when 'reserve_release' then -l.amount
          else 0
        end), 0) as reserved,
      coalesce(-sum(l.amount) filter (where l.entry_type = 'payout'), 0) as paid,
      max(d.payout_due_at) as payout_due_at
    from ledger l
    join deals d on d.id = l.deal_id
    left join released r on r.deal_id = l.deal_id
    where l.deal_id is not null
      and (p_tenant is null or l.tenant_id = p_tenant)
      and (p_seller is null or d.seller_id = p_seller)
    group by d.seller_id, l.deal_id, r.deal_id
  )
  select
    s.id,
    s.name,
    s.country,
    p.currency,
    sum(p.held)::bigint,
    -- `filter` yields NULL where nothing matches, and a balance of NULL is not
    -- a balance. Every bucket coalesces so the row always adds up.
    coalesce(sum(p.clearing) filter (
      where p.payout_due_at is null or p.payout_due_at > now()), 0)::bigint,
    coalesce(sum(p.clearing) filter (
      where p.payout_due_at is not null and p.payout_due_at <= now()), 0)::bigint,
    sum(p.reserved)::bigint,
    sum(p.paid)::bigint
  from per_deal p
  join sellers s on s.id = p.seller_id
  group by s.id, s.name, s.country, p.currency
  order by s.name, p.currency;
$$;
