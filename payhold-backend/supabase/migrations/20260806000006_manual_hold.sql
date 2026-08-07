-- ---------------------------------------------------------------------------
-- A person stopping one payout
-- ---------------------------------------------------------------------------
--
-- Until now the only thing that could hold a payout was a rule, and the only
-- thing a person could do was clear one. That asymmetry left an operator who
-- spotted something the rules do not model — a phone call, a seller who has
-- gone quiet, a booking that reads wrong — with exactly one lever: freezing the
-- whole tenant, which stops every honest seller's money to stop one.
--
-- This is the precise version of that. It reuses `held_for_review` rather than
-- inventing a status, because the thing it produces is the same thing: one
-- payout waiting on one person, cleared by `approve_payout_review` through the
-- same audited path. What is added is `review_held_by` and a reason, which is
-- also what separates the two kinds of hold when someone reads them back — a
-- null holder means a rule did it.
--
-- It stays inside invariant 11 from the safe side. The invariant limits *rules*
-- to stopping, because a rule is arithmetic that nobody agreed to at the time;
-- a person stopping a payout is the same direction of failure with a name
-- attached, and the name is mandatory here for exactly that reason.

alter table payouts
  add column if not exists review_held_by     text,
  add column if not exists review_hold_reason text;

comment on column payouts.review_held_by is
  'Who placed the hold. Null when a deterministic rule did — see risk_signals.';
comment on column payouts.review_hold_reason is
  'Why, in the words of the person who held it. Null for a rule hold.';

-- ---------------------------------------------------------------------------

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

-- Service role only, like every other function that can change what money does.
revoke all on function hold_payout(uuid, text, text) from public, anon, authenticated;

-- The AI layer must not reach it. Holding is not a money move, but it is an
-- action with a person's name on it, and invariant 9 says model output writes
-- suggestions and nothing else. Guarded because `payhold_ai` is created in
-- 20260806000004 and this file must apply to a database built before it.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'payhold_ai') then
    execute 'revoke all on function hold_payout(uuid, text, text) from payhold_ai';
  end if;
end;
$$;
