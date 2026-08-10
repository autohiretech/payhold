-- `seller_net` counted the fees and not the money.
--
-- The old sum reached for `release` as the seller's gross, which is only
-- written when a deal is released. Every deal before that moment — which is
-- every deal for the whole time a car is actually out — therefore summed its
-- fee entries and nothing else, and answered with a **negative number**. A host
-- with a trip in progress was shown "You earn -$0.41" against a booking whose
-- money was sitting safely held, and the figure got worse the more they were
-- owed, because the provider fee scales with the amount.
--
-- Confirmed against the live ledger: a `funded_held` deal holds exactly
-- `hold +374` and `provider_fee -41`, and the old expression returns -41.
--
-- The gross is `hold`. It is written at funding, it is not removed at release —
-- the ledger is append-only and `release` is a movement of money already
-- counted, not new money — so basing the sum on it gives the same answer at
-- every stage of a deal's life instead of only at the end:
--
--   held      hold 374, provider_fee -41                    -> 333
--   released  hold 374, release -374, provider_fee -41      -> 333
--   paid out  ... plus payout -333                          -> 333
--   refunded  hold 374, refund -374, provider_fee -41       -> -41
--
-- `release` and `payout` are dropped for that reason. Both move money the hold
-- already accounts for, and `payout` in particular made the number collapse
-- toward zero once a host was actually paid — the one moment they are most
-- likely to look at it. What a trip earned does not stop being earned because
-- the money has arrived.
--
-- `refund` is added, which the old expression omitted: money returned to the
-- buyer is money the seller does not earn, and a fully refunded deal was
-- reporting its full earnings.
--
-- **The platform fee is read from the deal until the ledger has it.** It is
-- computed and stored on the deal at creation — `fee_amount`, 227700 against a
-- 2277000 booking on the live data — but the `fee` ledger entry is only written
-- at release. So a held deal has no fee entry at all, and a `seller_net` built
-- from ledger rows alone overstates what a host earns by the whole commission
-- for exactly as long as the car is out. They would watch it drop by 10% at the
-- moment they were paid, which is the moment they are most likely to be
-- counting. `platform_fee` now falls back to the deal's own figure, and
-- `seller_net` subtracts the same number, so the two can never disagree.
--
-- Nothing else in the breakdown moves. `buyer_paid`, `provider_fee`, `tax`,
-- `reserve`, `refunded`, `receivable` and `paid_out` are unchanged, and they
-- were all correct.

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
      -- The ledger's figure once it exists, the deal's until then. Never both.
      coalesce(
        nullif(-sum(l.amount) filter (where l.entry_type = 'fee'), 0),
        d.fee_amount,
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
    group by d.id, d.presentment_currency, d.fee_amount
  ) x;
$$;

-- No grant block, deliberately. The sibling migrations carry one because they
-- change a signature, and a *new* signature is granted to PUBLIC by default —
-- invariant 9 is a grant list, not a convention. This replaces a function with
-- the identical signature, which Postgres treats as an edit and leaves the
-- existing privileges alone. Re-issuing revokes here would quietly narrow who
-- can read a breakdown today: `authenticated` and `anon` both hold EXECUTE on
-- the live database, and the dashboard reads through one of them.
