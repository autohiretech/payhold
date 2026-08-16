-- Two bugs in `deal_amounts`, found together and both from the same class
-- of mistake this session already made once and is now making consistent.
--
-- 1. `platform_fee`'s fallback estimate had the exact bug `_shared/fx.ts`'s
--    `convert()` did, in a place that fix never reached. `20260816000003`
--    converted the estimate through `d.fx_rate` — correct in principle, but
--    `round(d.fee_amount * d.fx_rate)` treats the result as already being
--    in the presentment currency's minor units. `fx_rate` is major-to-major
--    (the same figure `convert()`'s own `.rate` returns), so that product
--    is a fraction of a **major** dollar, not a count of cents — it needed
--    the same toMajor/toMinor crossing `convert()` was fixed to do, and
--    being pure SQL, never went through that function at all.
--
--    Found on a fresh AutoHire deal (created *after* the fx.ts fix, so its
--    presentment_amount is already correct): RWF 257 fee estimate, rate
--    0.0007142857, buyer_paid $1.83 — showed no "PayHold fee" row at all,
--    because round(257 * 0.0007142857) = round(0.18) = 0. The correct
--    figure is 18 cents: 257 * 0.0007142857 = 0.18 *major* dollars, ×100
--    for USD's minor unit = 18.
--
-- 2. Fixing #1 surfaced a second bug immediately, in the very next test run.
--    `20260816000006` (same day) taught `refund_deal`'s default "everything
--    still refundable" to net out the provider's own fee — a $1.96 deal
--    with a $0.56 fee now refunds $1.40, not $1.96, because the fee never
--    comes back regardless. That means a deal's ledger `refund` entries no
--    longer sum to the full `buyer_paid` on what is, in every real sense,
--    a *complete* refund — they sum to `buyer_paid - provider_fee`.
--
--    `deal_amounts`'s own "is this deal fully refunded" check (added in
--    `20260816000004`/`000005` to stop showing a fee/seller_net estimate on
--    a deal that will never release) still compared `refunded >=
--    buyer_paid`, unaware the ceiling had moved. Every deal refunded in
--    full after `20260816000006` shipped would show a *positive* leftover
--    fee estimate — 970 (56 * 0.0007142857 ... ) style noise — instead of
--    the zero a fully-refunded deal is supposed to show.
--
--    Both places that asked "is this deal fully refunded" now ask against
--    the same ceiling `refund_deal` itself uses: `buyer_paid -
--    provider_fee`, not bare `buyer_paid`.
--
-- SQL cannot import fx.ts's ZERO_DECIMAL set, so it is repeated here — the
-- same duplication this codebase already accepts for the identical reason
-- in paypal.ts/flutterwave.ts/stripe.ts, each keeping its own copy rather
-- than sharing one that would be wrong for one of them.
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
    -- funded — until the deal has been refunded as far as it ever can be
    -- (buyer_paid less the provider's own fee, the same ceiling
    -- refund_deal itself refunds up to), at which point every cost this
    -- transaction happened to carry stops being the seller's to answer for.
    (case when x.refunded >= x.buyer_paid - x.provider_fee then 0
          else x.gross - x.platform_fee end)::bigint
      as seller_net
  from (
    select
      d.presentment_currency as currency,
      coalesce(sum(l.amount) filter (where l.entry_type = 'hold'), 0)::bigint as buyer_paid,
      -- The ledger's figure once it exists, the deal's estimate until then —
      -- crossed properly from settlement's major/minor convention to
      -- presentment's, and withheld entirely once the deal has been
      -- refunded as far as it can ever go.
      coalesce(
        nullif(-sum(l.amount) filter (where l.entry_type = 'fee'), 0),
        case
          when coalesce(-sum(l.amount) filter (where l.entry_type = 'refund'), 0)
               >= coalesce(sum(l.amount) filter (where l.entry_type = 'hold'), 0)
                  - coalesce(-sum(l.amount) filter (where l.entry_type = 'provider_fee'), 0)
          then 0
          else round(
            -- fee_amount, in settlement minor units, up to settlement major units.
            (case when d.currency in ('RWF', 'UGX', 'XAF', 'XOF', 'JPY', 'BIF')
                  then d.fee_amount::numeric
                  else d.fee_amount::numeric / 100 end)
            -- major-to-major, same figure convert()'s own .rate returns.
            * coalesce(d.fx_rate, 1)
            -- presentment major units back down to its own minor units.
            * (case when d.presentment_currency in ('RWF', 'UGX', 'XAF', 'XOF', 'JPY', 'BIF')
                    then 1 else 100 end)
          )::bigint
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
    group by d.id, d.currency, d.presentment_currency, d.fee_amount, d.fx_rate
  ) x;
$$;

-- No grant block, deliberately — same reasoning every deal_amounts
-- migration this session gives: identical signature, Postgres treats this
-- as an edit of the existing function rather than a new one, and the
-- existing EXECUTE grants to `anon` and `authenticated` (which the
-- dashboard reads through) stay untouched.
