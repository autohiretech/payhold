-- The rail says where the money is, and now we write it down.
--
-- `pending` is a decision, not an explanation, and it can stay true for a very
-- long time. On 2026-09-12 a live payout of USD 282.37 was accepted by PayPal
-- (batch RM2Z57VLX2BJ8) and then sat. The dispatcher did everything right: it
-- asked `transferStatus` every five minutes instead of re-sending, PayPal
-- answered something non-terminal every time, and `dispatchPayout` returned
-- `processing` — which writes no column and no audit row. Twenty-six hours of
-- correct behaviour left `cron_job_runs` reading "considered 1, processing 1"
-- three hundred times over, the payout row byte-identical to the day before,
-- and the host's earnings screen saying "$282.37 not moving yet" with nothing
-- underneath it. The seller could not tell a rail holding their money from a
-- cron that had died.
--
-- So the answer is recorded. `rail_status` is the rail's own sentence in the
-- rail's own vocabulary — `batch PENDING, item UNCLAIMED`, `NEW — Insufficient
-- funds in wallet` — and `rail_status_at` is when it last said it, which is
-- also the proof that something is still asking.
--
-- **Recorded, shown, and never acted on.** Every routing and booking decision
-- stays with the three statuses `transferStatus` returns. A branch keyed on
-- this text would be a branch keyed on prose a provider may reword between
-- releases, and providers do.
--
-- It is deliberately not `failure_reason`. That field means "an attempt was
-- refused" and is written by `fail_payout` alongside the retry ladder; a
-- transfer sitting healthily at the rail has failed nothing, and overloading
-- the column would make "why did this stop" and "where is this now" the same
-- sentence.

alter table payouts
  add column if not exists rail_status    text,
  add column if not exists rail_status_at timestamptz;

comment on column payouts.rail_status is
  'The rail''s own words for where this transfer is, from the last '
  'transferStatus poll. Displayed, never branched on.';

comment on column payouts.rail_status_at is
  'When the rail last answered. Also what proves a poll is still running.';

-- ---------------------------------------------------------------------------
-- Writing it down without touching anything that decides
-- ---------------------------------------------------------------------------
--
-- A poll is not an attempt. This function moves no status, spends no retry
-- budget, re-arms no clock and books no money — the whole point is that it can
-- be called on every pass, including the passes where nothing happened, which
-- are exactly the passes a silent payout needs explained.
--
-- `paid` rows are left alone: their story ended, and a late poll must not
-- decorate a settled payout with a status read afterwards.

create or replace function note_payout_rail_status(
  p_payout_id uuid,
  p_status    text
)
returns void
language sql
as $$
  update payouts
     set rail_status = nullif(btrim(p_status), ''),
         rail_status_at = now()
   where id = p_payout_id
     and status <> 'paid';
$$;

comment on function note_payout_rail_status(uuid, text) is
  'Record what the rail last said about a transfer. Writes nothing that any '
  'decision reads — no status, no attempts, no next_attempt_at.';

revoke all on function note_payout_rail_status(uuid, text) from public, anon, authenticated;
revoke all on function note_payout_rail_status(uuid, text) from payhold_ai;
grant execute on function note_payout_rail_status(uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- And handing it to the person waiting for the money
-- ---------------------------------------------------------------------------
--
-- `seller_withdrawable` is what AutoHire renders on a host's earnings page, so
-- this is where the sentence has to arrive. Three columns:
--
--   rail_status     what the rail last said about money that has not landed
--   rail_status_at  when it said it
--   stuck_since     how long the oldest stopped payout has been stopped
--
-- The status is taken from the most recently polled payout in this currency
-- that is not `paid`, because that is the one a seller is asking about. It is
-- one sentence rather than one per payout for the same reason `stuck_amount`
-- is one figure: the question is "where is my money", and a seller with two
-- stuck payouts on the same rail is being told the same thing twice.
--
-- `stuck_since` is the earliest `scheduled_for` among the stopped rows — when
-- the money *should* have gone — rather than when it last failed. A seller
-- counting days is counting from the day they expected it.
--
-- `drop function` first: the return type gains columns, and `create or replace`
-- cannot change a signature. Grants reissued, because a recreated function is
-- granted to PUBLIC by default.

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
  paid_count          integer,
  -- Where the rail says the money is, when it last said so, and since when it
  -- should have been somewhere else.
  rail_status         text,
  rail_status_at      timestamptz,
  stuck_since         timestamptz
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
    count(*) filter (where p.status = 'paid')::integer,
    (array_agg(p.rail_status order by p.rail_status_at desc nulls last)
       filter (where p.status <> 'paid' and p.rail_status is not null))[1],
    max(p.rail_status_at) filter (where p.status <> 'paid'),
    min(p.scheduled_for) filter (
      where p.status in (
        'held_for_review', 'needs_verification', 'blocked', 'failed', 'frozen'
      ))
  from payouts p
  join deals d on d.id = p.deal_id
  where p.seller_id = p_seller
  group by p.currency
  order by p.currency;
$$;

revoke all on function seller_withdrawable(uuid) from public, anon, authenticated;
revoke all on function seller_withdrawable(uuid) from payhold_ai;
grant execute on function seller_withdrawable(uuid) to service_role;
