-- `hold_payout` let a person resurrect a payout that had already failed
-- permanently — refused by everything else in the pipeline, but not by
-- this door.
--
-- Found live: deal `70a03b4f...` was refunded, which correctly failed its
-- payout (`status = 'failed', failure_reason = 'Deal was refunded'`) —
-- there is no clearing pool left to pay that seller from, ever. An operator
-- then placed a manual hold on it (`hold_payout` accepted a hold on a
-- `failed` payout with no check on *why* it failed), which moved it to
-- `held_for_review` and cleared nothing about the underlying deal.
-- `approve_payout_review` — correctly, by its own rules — then approved
-- the hold and rescheduled it: `status = 'scheduled'`, `failure_reason =
-- 'Deal was refunded'` sitting right next to it. The Payouts screen read
-- "Scheduled — Deal was refunded — RWF 1", describing a payout the system
-- is never actually going to send (dispatchPayout's own
-- PAYABLE_DEAL_STATUSES check would still skip it) but that nothing had
-- told the operator was dead.
--
-- The fix is at the door invariant 11 already draws around a person's
-- hold: a hold is the safe direction, reversible by the same audited
-- approval — but reversible only when there is still something live to
-- reverse it *to*. A refunded deal has nothing: release already happened,
-- the money already went back to the buyer, and holding-then-approving
-- this payout can only ever produce a status that lies about what is
-- about to happen. Refused here, at the point a person could otherwise
-- start that cycle, rather than trusted to dispatch to quietly no-op it
-- later.
create or replace function hold_payout(
  p_payout_id uuid,
  p_held_by   text,
  p_reason    text
) returns payouts
language plpgsql
security definer
set search_path = public
as $$
declare
  p    payouts;
  prev text;
  v_deal_status deal_status;
begin
  -- A hold nobody signed is a hold nobody can be asked about, and one with no
  -- stated reason cannot be reviewed by the person who has to clear it. Both
  -- are required here rather than defaulted, because a blank string in an audit
  -- row is worse than a refused request.
  if coalesce(btrim(p_held_by), '') = '' then
    raise exception 'policy_violation: a hold must name the person placing it'
      using errcode = 'check_violation';
  end if;

  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'policy_violation: a hold must say why'
      using errcode = 'check_violation';
  end if;

  -- The lock is the whole point: a payout being read here may be one the
  -- dispatcher is about to send, and deciding on a stale row would be a hold
  -- that lands after the money.
  select * into p from payouts where id = p_payout_id for update;

  if not found then
    raise exception 'not_found: payout % does not exist', p_payout_id
      using errcode = 'no_data_found';
  end if;

  if p.status = 'paid' then
    raise exception 'invalid_state: payout % has already been sent', p_payout_id
      using errcode = 'check_violation';
  end if;

  -- `processing` is with the provider already. Holding it here would record a
  -- stop that did not happen — recalling an in-flight transfer is a
  -- conversation with the provider, not a row in this table.
  if p.status = 'processing' then
    raise exception 'invalid_state: payout % is already with the provider', p_payout_id
      using errcode = 'check_violation';
  end if;

  if p.status = 'held_for_review' then
    raise exception 'invalid_state: payout % is already held', p_payout_id
      using errcode = 'check_violation';
  end if;

  -- The one case a hold cannot be a safe, reversible stop for: the deal
  -- behind this payout has been refunded, so release already happened in
  -- reverse and there is no clearing pool left to schedule anything from.
  -- A held-then-approved payout here would only ever produce a status that
  -- describes money that is never coming.
  select status into v_deal_status from deals where id = p.deal_id;

  if v_deal_status = 'refunded' then
    raise exception 'invalid_state: deal % was refunded — there is nothing left to hold this payout for', p.deal_id
      using errcode = 'check_violation';
  end if;

  -- Captured before the update, because `returning *` overwrites `p` with the
  -- held row and the audit trail wants to say what was stopped.
  prev := p.status::text;

  update payouts
     set status             = 'held_for_review',
         review_held_at     = now(),
         review_held_by     = btrim(p_held_by),
         review_hold_reason = btrim(p_reason),
         -- A previous approval is cleared deliberately. It was a decision about
         -- what the rules found then; leaving it would let `screen_payout` skip
         -- this payout for the rest of its life, and would show an approver's
         -- name beside a payout they have not approved.
         review_approved_by = null,
         review_approved_at = null
   where id = p.id
  returning * into p;

  perform write_audit(p.tenant_id, p.deal_id, p_held_by, 'payout.held_by_person',
    jsonb_build_object(
      'payout_id', p.id,
      'reason', btrim(p_reason),
      'previous_status', prev
    ));

  return p;
end;
$$;

-- Same signature — an edit, not a new function — so the existing grants
-- stay as they are. Reissued anyway, matching every other change to a
-- money-adjacent function this session, because the risk is real
-- regardless of whether this particular change needed it.
revoke all on function hold_payout(uuid, text, text) from public, anon, authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'payhold_ai') then
    execute 'revoke all on function hold_payout(uuid, text, text) from payhold_ai';
  end if;
end;
$$;
