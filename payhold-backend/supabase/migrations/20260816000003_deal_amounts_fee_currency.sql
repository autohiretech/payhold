-- `deal_amounts.platform_fee` came back in the wrong currency for any
-- cross-border deal still in progress — held, or refunded before release.
--
-- Found on AutoHire's tenant: a $0.07 PayPal deal (RWF-priced, USD-presentment,
-- fx_rate 0.0007142857) refunded before release showed "PayHold fee: −USD
-- 9.80" and "Seller receives: −USD 9.80" — off by four orders of magnitude
-- and the wrong sign of sane.
--
-- `20260810000002` made `platform_fee` fall back to `deals.fee_amount` while
-- no `fee` ledger entry exists yet (that entry is only written at release),
-- so an in-progress trip still shows an estimated commission instead of a
-- misleading zero. Its header explicitly names the trap `deal_amounts`
-- exists to avoid — "`Deal.fee_amount` is settlement currency and
-- `DealAmounts.platform_fee` is presentment, and adding the two sets
-- together is the mistake this note exists to prevent" — and then walked
-- into exactly that trap: `d.fee_amount` is booked in **settlement**
-- currency (RWF here, 980 = RWF 9.80) at deal creation, but every reader of
-- `deal_amounts.platform_fee` — the dashboard included — treats the column
-- as **presentment** currency (USD here) by contract. Nothing converted it.
--
-- Domestic deals never showed the bug: when `presentment_currency = currency`
-- the two figures are numerically identical, so the mislabeling was invisible
-- everywhere except a cross-border deal.
--
-- The fix converts through the same `fx_rate` the deal itself locked at
-- funding — "units of presentment per unit of settlement" per its own column
-- comment — the identical rate `presentment_amount` was derived from, so the
-- fallback estimate moves in step with the real converted numbers around it.
-- Same-currency deals take the `coalesce(d.fx_rate, 1)` branch too, where a
-- null rate multiplies by 1 and changes nothing.
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
    x.currency,
    x.buyer_paid,
    x.platform_fee,
    x.provider_fee,
    x.tax,
    x.reserve,
    x.refunded,
    x.receivable,
    x.paid_out,
    -- What this trip earns the seller, answerable from the moment it is funded.
    (x.gross - x.platform_fee)::bigint
  from (
    select
      d.presentment_currency as currency,
      coalesce(sum(l.amount) filter (where l.entry_type = 'hold'), 0)::bigint as buyer_paid,
      -- The ledger's figure once it exists, the deal's estimate until then —
      -- converted to presentment currency, because that estimate was booked
      -- in settlement currency and every other figure here is presentment.
      coalesce(
        nullif(-sum(l.amount) filter (where l.entry_type = 'fee'), 0),
        round(d.fee_amount * coalesce(d.fx_rate, 1))::bigint,
        0
      )::bigint as platform_fee,
      coalesce(-sum(l.amount) filter (where l.entry_type = 'provider_fee'), 0)::bigint as provider_fee,
      coalesce(-sum(l.amount) filter (where l.entry_type = 'tax'), 0)::bigint as tax,
      coalesce(-sum(
        case l.entry_type
          when 'reserve'         then l.amount
          when 'reserve_release' then l.amount
          else 0
        end), 0)::bigint as reserve,
      coalesce(-sum(l.amount) filter (where l.entry_type = 'refund'), 0)::bigint as refunded,
      -- §7.1.4. Owed to us by the seller, and with nobody yet. It is in no
      -- balance bucket for that reason: the buckets say what a provider holds.
      coalesce(sum(l.amount) filter (where l.entry_type = 'receivable'), 0)::bigint as receivable,
      coalesce(-sum(l.amount) filter (where l.entry_type = 'payout'), 0)::bigint as paid_out,
      -- Everything the seller's side of the deal is worth before commission.
      -- `fee` is deliberately absent: it is subtracted once, above, from
      -- whichever source actually has it.
      coalesce(sum(
        case l.entry_type
          when 'hold'            then l.amount
          when 'refund'          then l.amount
          when 'provider_fee'    then l.amount
          when 'tax'             then l.amount
          when 'reserve'         then l.amount
          when 'reserve_release' then l.amount
          else 0
        end), 0)::bigint as gross
    from deals d
    left join ledger l on l.deal_id = d.id
    where d.id = p_deal
    group by d.id, d.presentment_currency, d.fee_amount, d.fx_rate
  ) x;
$$;

-- No grant block, deliberately — same reasoning `20260810000002` gives:
-- identical signature, Postgres treats this as an edit of the existing
-- function rather than a new one, and the existing EXECUTE grants to `anon`
-- and `authenticated` (which the dashboard reads through) stay untouched.
-- Reissuing revokes here would quietly narrow who can read a breakdown today.
