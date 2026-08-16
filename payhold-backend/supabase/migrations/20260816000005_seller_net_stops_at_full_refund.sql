-- The last migration zeroed `platform_fee` on a fully refunded deal.
-- `seller_net` still went negative right next to it.
--
-- Found on the same tenant, a second deal: refunded in full before release,
-- provider_fee genuinely charged $0.56 that the rail kept (real money, "this
-- one really left" — that figure is correct and stays as-is). With
-- platform_fee now correctly at zero, `seller_net = gross - platform_fee`
-- reduced to plain `gross` — and `gross` still carries the provider fee, so
-- "Seller receives" read −USD 0.56.
--
-- A seller was never owed anything on a deal that never released, and is not
-- now in debt for a processing fee they never had a claim on either — that
-- fee is a cost the tenant's own provider account absorbed on a booking that
-- fell through, not a bill against this seller. Same guard as last time,
-- moved to where it actually has to bind: `refunded >= buyer_paid` forces
-- `seller_net` itself to zero, in the outer select where `x.refunded` and
-- `x.buyer_paid` are already in scope, rather than trusting every cost
-- `gross` happens to carry to net out to zero on its own.
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
    -- What this trip earns the seller, answerable from the moment it is
    -- funded — until a full refund means there is no trip left to earn
    -- anything, at which point every cost this specific transaction
    -- happened to carry (a rail fee that never came back, tax collected
    -- and refunded anyway) stops being the seller's to answer for.
    (case when x.refunded >= x.buyer_paid then 0 else x.gross - x.platform_fee end)::bigint
      as seller_net
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

-- No grant block, deliberately — same reasoning the last three deal_amounts
-- migrations give: identical signature, Postgres treats this as an edit of
-- the existing function rather than a new one, and the existing EXECUTE
-- grants to `anon` and `authenticated` (which the dashboard reads through)
-- stay untouched. Reissuing revokes here would quietly narrow who can read
-- a breakdown today.
