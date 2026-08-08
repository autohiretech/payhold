-- Payout retry with capped exponential backoff — spec §13, V2 plan phase 9.
--
-- "Payout failures retry with capped exponential backoff, then move to
-- `payout_blocked` for operator action." Until now the first half did not
-- happen at all: `failed` is absent from `DISPATCHABLE`, so a payout the
-- provider refused sat there until a person pressed retry. Phase 5 built the
-- backup-destination selection *for* a retry and noted that the retry itself
-- was phase 9's. This is it.
--
-- ## The shape is `webhook_deliveries`', deliberately
--
-- 1m, 5m, 30m, 2h, capped — the same ladder `record_webhook_attempt` uses, for
-- the same reason: the first retry catches a blip, the last one catches an
-- outage, and a fifth immediate attempt catches nothing a fourth did not. Two
-- different backoff curves in one system would be two things to reason about at
-- 3am for no gain.
--
-- ## `next_attempt_at` is the whole mechanism, and null is the interesting value
--
-- `null` means **no machine may try this again** — only a person. That is how
-- "then move to blocked for operator action" is expressed without inventing a
-- status that means "blocked, but really blocked": exhaustion sets the status
-- to `blocked` (which `payout_display_status` already shows and
-- `emit_payout_event` already announces) *and* clears the clock, so the cron's
-- `next_attempt_at <= now()` filter — which excludes nulls by construction —
-- stops picking it up.
--
-- The distinction that leaves behind is real and intended: `blocked` with a
-- clock is §5.1's no-route case, re-asked every pass because the answer can
-- change without anyone doing anything; `blocked` with no clock is a rail that
-- refused us five times, where re-asking is how you send the same failure to
-- the same seller all night.
--
-- ## Why the counter is not reset
--
-- `route_payout` reads `attempts >= payout_primary_attempts` to decide whether
-- the seller's verified backup destination may be used. Zeroing the counter on
-- an operator retry would silently send the next attempt back to the primary
-- that has been failing — so a person's retry is *one* more attempt, not a
-- fresh series, and `reset_payout_retry` only restores the clock the machine
-- reads. If that attempt fails, it is exhausted again immediately, which is the
-- honest outcome: nothing about the destination changed.

-- ---------------------------------------------------------------------------
-- The clock
-- ---------------------------------------------------------------------------

alter table payouts
  add column if not exists next_attempt_at timestamptz default now();

comment on column payouts.next_attempt_at is
  'When a machine may next attempt this payout. Null means never — the retry '
  'budget is spent and only a person can send it again. Existing rows default '
  'to now(), i.e. immediately eligible, which is what they already were.';

-- The old index covered `scheduled` and `frozen` only, from before `blocked`
-- and `needs_verification` joined `DISPATCHABLE`; `failed` joins them here. The
-- dispatch scan filters on both timestamps, so both are in the index.
drop index if exists payouts_dispatch_idx;
create index payouts_dispatch_idx on payouts(next_attempt_at, scheduled_for)
  where status in ('scheduled', 'frozen', 'blocked', 'needs_verification', 'failed');

-- ---------------------------------------------------------------------------
-- Failing one attempt
-- ---------------------------------------------------------------------------

create or replace function fail_payout(p_payout_id uuid, p_reason text)
returns payouts
language plpgsql
security definer
set search_path = public
as $$
declare
  p          payouts;
  v_attempts integer;
  v_max      integer;
  v_backoff  interval;
  v_spent    boolean;
begin
  select * into p from payouts where id = p_payout_id for update;

  if not found or p.status = 'paid' then
    raise exception 'invalid_state: payout % is missing or already paid', p_payout_id
      using errcode = 'check_violation';
  end if;

  v_attempts := p.attempts + 1;
  -- At least one attempt, whatever a tenant sets: a budget of zero would block
  -- every payout on its first transient provider error.
  v_max := greatest(1, setting_num(p.tenant_id, 'payout_retry_max_attempts', 5)::integer);
  v_spent := v_attempts >= v_max;

  v_backoff := case v_attempts
    when 1 then interval '1 minute'
    when 2 then interval '5 minutes'
    when 3 then interval '30 minutes'
    else        interval '2 hours'
  end;

  update payouts
     set status = case when v_spent then 'blocked'::payout_status
                       else 'failed'::payout_status end,
         failure_reason = case
           when v_spent then format('%s (no further automatic attempts after %s tries)',
                                    p_reason, v_attempts)
           else p_reason
         end,
         attempts = v_attempts,
         next_attempt_at = case when v_spent then null else now() + v_backoff end
   where id = p.id
  returning * into p;

  -- §5.1: a failed payout does not lose funds. The money is back to available
  -- and the payout is retryable; the deal must not sit in `payout_pending`
  -- claiming a transfer is in flight when none is.
  update deals set status = 'released'
   where id = p.deal_id and status = 'payout_pending';

  perform write_audit(p.tenant_id, p.deal_id, 'system', 'payout.failed', jsonb_build_object(
    'reason', p_reason,
    'attempts', p.attempts,
    'next_attempt_at', p.next_attempt_at
  ));

  -- Said separately because it is a different fact, and the one an operator is
  -- paged on: this seller is not getting paid until somebody does something.
  -- The `payout.blocked` webhook rides the status change on its own trigger.
  if v_spent then
    perform write_audit(p.tenant_id, p.deal_id, 'system', 'payout.retries_exhausted',
      jsonb_build_object(
        'payout_id', p.id,
        'attempts', p.attempts,
        'reason', p_reason
      ));
  end if;

  return p;
end;
$$;

-- ---------------------------------------------------------------------------
-- A deal that is over stops the clock
-- ---------------------------------------------------------------------------
--
-- `refund_deal` cancels a scheduled payout by writing `status = 'failed'`
-- directly. That was inert while `failed` was undispatchable; it is not any
-- more, and without this the cron would pick up the payout for a fully refunded
-- deal every pass forever and re-attempt a transfer nobody is owed.
--
-- A trigger rather than a line in `refund_deal`, for the reason
-- `deals_assert_transition` and `enqueue_webhooks` are triggers: a rule every
-- future writer has to remember is a rule that eventually gets skipped,
-- including by a correction somebody runs by hand at 2am. Any writer that
-- leaves a payout on a finished deal gets this for free.
--
-- `disputed` is deliberately absent. A dispute ends, and the payout it froze
-- must be sendable again when it does — that is what `blocked` means there.

create or replace function payouts_stop_retrying_finished_deals()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.next_attempt_at is not null
     and new.status <> 'paid'
     and (select d.status from deals d where d.id = new.deal_id)
         in ('refunded', 'canceled', 'expired')
  then
    new.next_attempt_at := null;
  end if;

  return new;
end;
$$;

drop trigger if exists payouts_stop_retrying on payouts;
create trigger payouts_stop_retrying
  before insert or update on payouts
  for each row execute function payouts_stop_retrying_finished_deals();

-- ---------------------------------------------------------------------------
-- A person putting the clock back
-- ---------------------------------------------------------------------------
--
-- Called by `POST /v1/payouts/:id/retry` before it dispatches, so an exhausted
-- payout a person re-attempts is visible to the cron again rather than being
-- sent once by hand and disappearing from the queue. The counter is untouched —
-- see the header.

create or replace function reset_payout_retry(p_payout_id uuid, p_actor text)
returns payouts
language plpgsql
security definer
set search_path = public
as $$
declare
  p payouts;
begin
  if coalesce(trim(p_actor), '') = '' then
    raise exception 'policy_violation: re-attempting a payout needs a name'
      using errcode = 'check_violation';
  end if;

  update payouts
     set next_attempt_at = now()
   where id = p_payout_id and status <> 'paid'
  returning * into p;

  if not found then
    raise exception 'invalid_state: payout % is missing or already paid', p_payout_id
      using errcode = 'check_violation';
  end if;

  perform write_audit(p.tenant_id, p.deal_id, p_actor, 'payout.retry_requested',
    jsonb_build_object('payout_id', p.id, 'attempts', p.attempts));

  return p;
end;
$$;

-- ---------------------------------------------------------------------------
-- An async rail settling a retried payout
-- ---------------------------------------------------------------------------
--
-- `mark_payout_processing` accepted `scheduled`, `frozen` and `processing`.
-- With automatic retry, the second attempt on an async rail arrives here from
-- `failed` — the status the first attempt left behind, since `route_payout`
-- only rewrites `blocked` — and would have raised `cannot be marked
-- processing`. The bug predates this migration; nothing reached it before,
-- because the only retry was a person pressing a button on a synchronous rail.

create or replace function mark_payout_processing(
  p_payout_id    uuid,
  p_provider_ref text
) returns payouts
language plpgsql
security definer
set search_path = public
as $$
declare
  p payouts;
begin
  update payouts
     set status = 'processing',
         provider_ref = p_provider_ref,
         attempts = attempts + 1
   where id = p_payout_id
     and status in ('scheduled', 'frozen', 'processing', 'failed')
  returning * into p;

  if not found then
    raise exception 'invalid_state: payout % cannot be marked processing', p_payout_id
      using errcode = 'check_violation';
  end if;

  -- The transfer is with the provider. Only `released` moves — a re-poll of an
  -- already-processing payout must not walk the deal backwards.
  update deals set status = 'payout_pending'
   where id = p.deal_id and status = 'released';

  perform write_audit(p.tenant_id, p.deal_id, 'system', 'payout.processing',
    jsonb_build_object('payout_id', p.id, 'provider_ref', p_provider_ref));

  return p;
end;
$$;

revoke all on function reset_payout_retry(uuid, text) from public, anon, authenticated;
revoke all on function reset_payout_retry(uuid, text) from payhold_ai;
