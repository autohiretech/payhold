-- `expire_stale_deals` — the writer `expired` never had.
--
-- `cancel_deal` (20260909000002) gave `canceled` a writer, and it closed the
-- abandoned-checkout hole for every buyer who *says* they are leaving: the
-- client calls it when its payment sheet is closed. But most abandonment is
-- silent. A buyer closes the tab, presses back, or puts the phone in a pocket
-- and the battery goes; nothing is dispatched, nobody says anything, and the
-- deal stays `checkout_started` forever exactly as it did before cancel
-- existed. AutoHire shipped its × and still watched a fresh "At checkout" row
-- appear from a checkout that was simply walked away from.
--
-- So this is the other half, and it is deliberately a sweep rather than
-- another endpoint: the defining feature of silent abandonment is that no
-- request is coming. Only the passage of time can notice it.
--
-- **`expired`, not `canceled`.** Both are terminal and hold no money, so it
-- would work either way, and collapsing them would be a mistake. "Nobody ever
-- came back" and "someone deliberately withdrew this" are different facts
-- about a payment funnel: the first is a conversion problem to measure, the
-- second is a customer decision. A tenant reading their Deals screen should
-- be able to tell them apart, and once they are the same word nothing can
-- ever separate them again.
--
-- Which statuses, and why these three: they are the same class `cancel_deal`
-- accepts, for the same reasons.
--
--   * `created`, `checkout_started` — a deal that was opened and never paid.
--   * `payment_failed` — a charge that was attempted and refused. The buyer
--     may retry (the guard allows `payment_failed` back to
--     `checkout_started`), so this is not expired for being failed; it is
--     expired for being failed and then abandoned for an hour, which is the
--     same orphan wearing a different status.
--   * `payment_pending` — **never**, and this is the one that matters. A
--     charge is live at a rail: a MoMo push the buyer may still approve on
--     their phone. `expired` is terminal, so a settlement landing afterwards
--     would be refused by the transition guard and the money would sit at the
--     provider with no deal willing to admit it arrived. That is precisely
--     what `settle-pending` — the cron this very function runs inside —
--     exists to resolve. Expiring those rows would mean one step of a pass
--     destroying the work of another.
--   * `funded_held` and later — money exists. Refund, never expiry.
--
-- **Age is `greatest(created_at, updated_at)`.** `deals_set_updated_at`
-- touches the row on every write, so this measures silence rather than age: a
-- deal created ninety minutes ago whose buyer picked a method two minutes ago
-- is not abandoned, and a cutoff read off `created_at` alone would delete a
-- checkout out from under someone still using it.
--
-- **An open, unexpired checkout session defers to its own TTL.** A live
-- payment link is a promise already made to a buyer — it may be sitting in a
-- WhatsApp message, unopened. The session carries its own `expires_at`, and
-- honouring it means the deal outlives `p_max_age` for exactly as long as the
-- link it issued is still good, then expires on a later pass. Two clocks, and
-- the longer one wins, because the shorter one would break a promise.
--
-- Sessions are canceled BEFORE the status moves, the same ordering
-- `cancel_deal` uses: a live link pointing at a deal that will refuse the
-- money is the one failure this must not manufacture on its way to tidying
-- up.
--
-- Rows are never deleted, same as cancel: "what happened to this deal" is
-- asked after something goes wrong, and `expired` plus an audit row answers
-- it where an absent row cannot.
--
-- Idempotent, and safe to run concurrently with itself and with
-- `settle-pending`'s own settlement step: `for update skip locked` means a
-- row another pass is already holding is left for that pass rather than
-- waited on, so a slow rail cannot stall the sweep.
--
-- Returns what it expired, so the caller can report a number instead of
-- guessing.

create or replace function expire_stale_deals(
  p_max_age interval default '60 minutes',
  p_limit   int default 500
) returns table (deal_id uuid, tenant_id uuid, from_status deal_status)
language plpgsql
security definer
set search_path = public
as $$
declare
  d deals;
  prior deal_status;
begin
  if p_limit is null or p_limit <= 0 then
    raise exception 'policy_violation: p_limit must be a positive number of deals'
      using errcode = 'check_violation';
  end if;

  if p_max_age is null or p_max_age <= interval '0' then
    raise exception 'policy_violation: p_max_age must be a positive interval — a zero cutoff would expire deals as fast as they are created'
      using errcode = 'check_violation';
  end if;

  for d in
    select *
      from deals dl
     where dl.status in ('created', 'checkout_started', 'payment_failed')
       and greatest(dl.created_at, dl.updated_at) < now() - p_max_age
       -- Defer to a live link's own TTL. `not exists` rather than a join so a
       -- deal with several historic sessions is considered once.
       and not exists (
         select 1
           from checkout_sessions cs
          where cs.deal_id = dl.id
            and cs.status = 'open'
            and cs.expires_at > now()
       )
     order by greatest(dl.created_at, dl.updated_at)
     limit p_limit
     for update skip locked
  loop
    -- Captured before the update. `returning * into d` overwrites the record,
    -- so reading `d.status` afterwards would report the status it moved TO —
    -- every audit row claiming the deal came from `expired`, which is the one
    -- thing the field cannot mean.
    prior := d.status;

    update checkout_sessions set status = 'canceled'
     where checkout_sessions.deal_id = d.id and status = 'open';

    update deals set status = 'expired'
     where id = d.id
    returning * into d;

    -- The `deals_notify` after-trigger already enqueues `order.expired` on
    -- this transition (20260807000002). Enqueuing here would deliver it
    -- twice.
    perform write_audit(
      d.tenant_id, d.id, 'system:cron', 'deal.expired',
      jsonb_build_object(
        'from_status', prior,
        'max_age', p_max_age::text
      )
    );

    deal_id := d.id;
    tenant_id := d.tenant_id;
    from_status := prior;
    return next;
  end loop;
end;
$$;

revoke all on function expire_stale_deals(interval, int) from public, anon, authenticated;

comment on function expire_stale_deals(interval, int) is
  'Sweeps abandoned checkouts to `expired`. Run from settle-pending''s cron. '
  'Never touches payment_pending (a charge is live at a rail) or anything '
  'funded. Defers to an open checkout session''s own expires_at.';
