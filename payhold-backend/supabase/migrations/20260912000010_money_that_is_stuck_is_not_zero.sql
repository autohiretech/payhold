-- Money that is stuck is not zero.
--
-- `seller_withdrawable` reported a seller's money in buckets, and two payout
-- statuses fell into none of them: `failed` and `frozen`. A host whose transfer
-- had been refused therefore had every figure on their earnings screen read
-- zero — available, requested, clearing, paid, all of it — while USD 282.37 sat
-- owed to them on a row nobody disputed. AutoHire rendered exactly what it was
-- given, which is the worst kind of wrong: a screen that is confidently blank.
--
-- The three stopped buckets that *did* exist made the same mistake more
-- quietly. `held_count`, `needs_verification_count` and `blocked_count` carry a
-- count and no amount, so a held payout showed "1 on hold" above a balance of
-- nothing. Knowing something is stuck without knowing how much is barely better
-- than not knowing at all.
--
-- So a single pair is added — `stuck_amount` and `stuck_count` — covering every
-- status that is neither payable, in flight, clearing, nor paid. One pair
-- rather than an amount per reason because the question a seller asks is "how
-- much of my money is not moving"; *why* each one stopped is what the existing
-- counts already answer, and they are unchanged.
--
-- **The list is exhaustive over the enum on purpose, and a test holds it
-- there.** The bug was not that `failed` was forgotten once; it was that a
-- status could be added and silently belong nowhere.
-- `tests/seller-wallet.test.ts` now asserts every value of `payout_status`
-- lands in some bucket, so the next one added fails a test rather than a
-- host's screen.
--
-- `drop function` first: the return type gains columns, and `create or replace`
-- cannot change a signature — it would add a sibling and leave every existing
-- caller resolving to the old one. The grants are reissued because a recreated
-- function is granted to PUBLIC by default, the trap `refund_deal` and
-- `resolve_dispute` both walked into.

drop function if exists seller_withdrawable(uuid);

create function seller_withdrawable(p_seller uuid)
returns table (
  currency            currency_code,
  -- Cleared, nothing holding it, and no request outstanding.
  available_amount    bigint,
  available_count     integer,
  -- Asked for and on its way, or with the provider already.
  requested_amount    bigint,
  requested_count     integer,
  -- Still inside the clearance window. Theirs, not yet payable.
  clearing_amount     bigint,
  clearing_count      integer,
  -- Stopped, and by what. Each ends differently, so each is counted apart.
  held_count          integer,
  needs_verification_count integer,
  blocked_count       integer,
  -- How much of it is stopped, whatever the reason. The counts above say why;
  -- this says how much, which is the question actually being asked.
  stuck_amount        bigint,
  stuck_count         integer,
  paid_amount         bigint,
  paid_count          integer
)
language sql
stable
as $$
  select
    p.currency,
    coalesce(sum(p.amount) filter (
      where p.status = 'scheduled'
        and p.withdrawal_requested_at is null
        and d.status = 'released'), 0)::bigint,
    count(*) filter (
      where p.status = 'scheduled'
        and p.withdrawal_requested_at is null
        and d.status = 'released')::integer,
    -- Asked for and waiting to go, or with the provider however it got there.
    -- `processing` used to require a withdrawal request too, which left a
    -- payout the scheduled pass had sent belonging to no bucket at all — the
    -- same hole `failed` fell through, found by the exhaustiveness test below
    -- rather than by a second host reporting a blank screen.
    coalesce(sum(p.amount) filter (
      where (p.status = 'scheduled' and p.withdrawal_requested_at is not null)
         or p.status = 'processing'), 0)::bigint,
    count(*) filter (
      where (p.status = 'scheduled' and p.withdrawal_requested_at is not null)
         or p.status = 'processing')::integer,
    coalesce(sum(p.amount) filter (where d.status = 'clearing'), 0)::bigint,
    count(*) filter (where d.status = 'clearing')::integer,
    count(*) filter (where p.status = 'held_for_review')::integer,
    count(*) filter (where p.status = 'needs_verification')::integer,
    count(*) filter (where p.status = 'blocked')::integer,
    -- Every stopped status. `frozen` is here beside `failed`: a tenant-wide
    -- reconciliation freeze is not the seller's doing and is even less
    -- explicable to them as a blank screen.
    coalesce(sum(p.amount) filter (
      where p.status in (
        'held_for_review', 'needs_verification', 'blocked', 'failed', 'frozen'
      )), 0)::bigint,
    count(*) filter (
      where p.status in (
        'held_for_review', 'needs_verification', 'blocked', 'failed', 'frozen'
      ))::integer,
    coalesce(sum(p.amount) filter (where p.status = 'paid'), 0)::bigint,
    count(*) filter (where p.status = 'paid')::integer
  from payouts p
  join deals d on d.id = p.deal_id
  where p.seller_id = p_seller
  group by p.currency
  order by p.currency;
$$;

revoke all on function seller_withdrawable(uuid) from public, anon, authenticated;
revoke all on function seller_withdrawable(uuid) from payhold_ai;
grant execute on function seller_withdrawable(uuid) to service_role;
