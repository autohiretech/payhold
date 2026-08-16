-- `deal_amounts.platform_fee`'s estimate kept running after the trip was
-- over — for good, not just paused.
--
-- Found on AutoHire's tenant: a $0.07 PayPal deal, refunded in full before
-- release, showed "PayHold fee: −USD 0.01" and "Seller receives: −USD 0.01"
-- — a negative one cent on a deal where nothing was ever collected and
-- nothing ever will be.
--
-- `20260810000002`'s fallback exists so a *held* deal shows a live commission
-- estimate while the trip is still out — "what a trip earns the seller,
-- answerable from the moment it is funded", per its own header. That estimate
-- was never conditioned on the deal still being able to reach release at
-- all: once a deal is refunded in full, there is no trip left in progress —
-- release will never happen, the seller will never see a payout, and PayHold
-- will never collect a commission on it. Continuing to show one is not an
-- estimate any more, it is a number describing something that stopped being
-- possible.
--
-- The fix is the same test the deal's own refund history already answers:
-- once `refunded >= buyer_paid`, everything that ever arrived has gone back,
-- and the fee estimate drops to zero along with it. A *partial* refund
-- leaves buyer_paid > refunded — the trip is still carrying on toward an
-- eventual release for the rest — so the estimate is unchanged there, same
-- as `20260810000002` intended.
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
      -- converted to presentment currency, and withheld entirely once a full
      -- refund means there is no trip left for it to describe.
      coalesce(
        nullif(-sum(l.amount) filter (where l.entry_type = 'fee'), 0),
        case
          when coalesce(-sum(l.amount) filter (where l.entry_type = 'refund'), 0)
               >= coalesce(sum(l.amount) filter (where l.entry_type = 'hold'), 0)
          then 0
          else round(d.fee_amount * coalesce(d.fx_rate, 1))::bigint
        end,
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

-- No grant block, deliberately — same reasoning the last two deal_amounts
-- migrations give: identical signature, Postgres treats this as an edit of
-- the existing function rather than a new one, and the existing EXECUTE
-- grants to `anon` and `authenticated` (which the dashboard reads through)
-- stay untouched. Reissuing revokes here would quietly narrow who can read
-- a breakdown today.
