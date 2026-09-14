-- A blocked payout's reason, as a code a client can switch on, not just a
-- sentence a person reads.
--
-- `payouts.failure_reason` has always been free text, written for an
-- operator — `route_reason_text()`'s sentences and `shortfallReason()`'s rail
-- figures both assume the reader is looking at PayHold's own Payouts screen.
-- AutoHire's Earnings page already knew better than to show that text to a
-- host (`holdSentence()`'s docblock: a host was once shown "PayPal: User
-- business error. (Batch with given sender_batch_id already exists)" in red on
-- their own earnings page), so it writes its own sentence per `payoutStatus`
-- instead. That works for `held_for_review` / `needs_verification` / `failed`
-- / `frozen`, which are each one fact. It does not work for `blocked`, which
-- is at least four different facts wearing one status: no eligible verified
-- destination, an unverified one, one still in its security hold, a
-- destination that failed to route — and, since `hold_payout_unfunded`, a
-- rail that has not yet settled enough to be withdrawable. A host reads the
-- same "we are sorting out the route" sentence for all of them, and the last
-- one is not about a route at all: nothing is being rerouted, the money just
-- has not cleared at the provider yet, which is closer to "wait" than to
-- "something is wrong".
--
-- So `blocked` (and the `fail_payout` exhaustion case, which also lands on
-- `blocked`) gets a `reason_code` beside its `failure_reason`: the same
-- vocabulary `route_payout` and `hold_payout_unfunded` already compute, just
-- no longer discarded once it has produced a sentence. A client can now tell
-- "still clearing at the provider" apart from "no route to your destination"
-- without parsing English.
--
-- All three functions below are reproduced from their current live
-- definitions (read back with `pg_get_functiondef` rather than reconstructed
-- from earlier migrations, several of which this project's history has since
-- superseded — `route_payout` in particular gained `requested_destination_id`,
-- dropped the old primary/backup fallback, and added
-- `destination_in_security_hold` since it was last written out in a
-- migration file). Only the `reason_code` reads and writes are new.

alter table payouts add column if not exists reason_code text;

comment on column payouts.reason_code is
  'Why a blocked (or exhausted) payout is stopped, as a stable code rather '
  'than the free-text failure_reason: rail_balance_short, '
  'no_eligible_verified_destination, destination_not_verified, '
  'destination_in_security_hold, a route_evaluation reason code, or '
  'retries_exhausted. Null for every other status, and for a blocked payout '
  'written before this column existed.';

-- ---------------------------------------------------------------------------
-- The funding preflight: the one case this was written for
-- ---------------------------------------------------------------------------

create or replace function hold_payout_unfunded(
  p_payout_id uuid,
  p_reason    text
) returns payouts
language plpgsql
security definer
set search_path = public
as $$
declare
  p       payouts;
  v_first boolean;
begin
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'invalid_request: a rail funding hold must say what the rail reported'
      using errcode = 'check_violation';
  end if;

  select * into p from payouts where id = p_payout_id for update;

  if not found then
    raise exception 'not_found: payout % does not exist', p_payout_id
      using errcode = 'no_data_found';
  end if;

  -- Money already with the rail is not ours to stop. Recalling an in-flight
  -- transfer is a conversation with the provider, and a hold that pretended
  -- otherwise would be a lie an operator acts on — `hold_payout` refuses the
  -- same two statuses for the same reason.
  if p.status in ('paid', 'processing') then
    raise exception 'invalid_state: payout % is already % and cannot be held for funding',
      p_payout_id, p.status
      using errcode = 'check_violation';
  end if;

  v_first := p.status <> 'blocked' or coalesce(p.failure_reason, '') <> p_reason;

  update payouts
     set status         = 'blocked',
         failure_reason = p_reason,
         reason_code    = 'rail_balance_short'
   where id = p.id
  returning * into p;

  if v_first then
    perform write_audit(p.tenant_id, p.deal_id, 'system', 'payout.blocked',
      jsonb_build_object(
        'payout_id', p.id,
        'reason_code', 'rail_balance_short',
        'reason', p_reason
      ));
  end if;

  return p;
end;
$$;

revoke all on function hold_payout_unfunded(uuid, text) from public, anon, authenticated;
revoke all on function hold_payout_unfunded(uuid, text) from payhold_ai;
grant execute on function hold_payout_unfunded(uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- The routing engine's own blocked case, and clearing it on the way out
-- ---------------------------------------------------------------------------
--
-- Reproduced verbatim from the live definition, plus `reason_code` in the two
-- places `failure_reason` was already being written and cleared.

create or replace function route_payout(p_payout uuid)
returns payout_decisions
language plpgsql
security definer
set search_path = public
as $$
declare
  p            payouts;
  d            deals;
  s            sellers;
  dest         seller_destinations;
  v_route_id   uuid;
  v_provider   provider;
  v_rail       payout_provider;
  v_method     payout_method;
  v_rank       integer;
  v_fee        bigint;
  checks       jsonb;
  v_reason     text;
  v_fx_source  text;
  decision     payout_decisions;
  previous     payout_decisions;
begin
  select * into p from payouts where id = p_payout for update;

  if not found then
    raise exception 'not_found: payout % does not exist', p_payout
      using errcode = 'no_data_found';
  end if;

  -- A payout the provider already has is not re-routed. Choosing a different
  -- destination for money in flight is the silent redirection §5.1 forbids, and
  -- it could not take effect anyway.
  if p.status in ('paid', 'processing') then
    raise exception 'invalid_state: payout % is already with the provider', p_payout
      using errcode = 'check_violation';
  end if;

  select * into d from deals where id = p.deal_id;
  select * into s from sellers where id = p.seller_id;

  -- The seller's own choice, if this payout carries one and it still stands.
  -- Re-checked here rather than trusted from `request_withdrawal`: a
  -- verification can be withdrawn between the ask and the pass that sends it,
  -- and this is the read that happens under the payout's own lock.
  if p.requested_destination_id is not null then
    select * into dest
      from seller_destinations
     where id = p.requested_destination_id
       and seller_id = p.seller_id
       and archived_at is null
       and verified_at is not null
       and (security_hold_until is null or security_hold_until <= now());
  end if;

  -- No choice, or one that no longer holds: their primary, exactly as before.
  -- Falling back to the primary rather than refusing is not the silent
  -- redirection §5.1 forbids — the primary is the destination the seller
  -- already nominated, and every eligibility check below still applies to it.
  if dest.id is null then
    select * into dest
      from seller_destinations
     where seller_id = p.seller_id and is_primary and archived_at is null;
  end if;

  -- The evaluation is recorded against the destination we would prefer to use,
  -- so `checks` answers "why not the seller's own choice" rather than "why not
  -- some rail nobody asked for".
  select coalesce(jsonb_agg(to_jsonb(e) order by e.eligible desc, e.rank), '[]'::jsonb)
    into checks
    from route_evaluation(
      p.tenant_id,
      coalesce(dest.country, s.country),
      p.currency,
      p.amount,
      coalesce(dest.payout_provider, s.payout_provider)
    ) e;

  -- §5.1's change protection, read here as well as in `screen_payout`: a
  -- destination still inside its hold is not one money may be routed to,
  -- however it came to be verified.
  if dest.id is not null and dest.verified_at is not null
     and (dest.security_hold_until is null or dest.security_hold_until <= now()) then
    select e.route_id, e.provider, e.payout_provider, e.method, e.rank, e.fee_estimate
      into v_route_id, v_provider, v_rail, v_method, v_rank, v_fee
      from route_evaluation(p.tenant_id, dest.country, p.currency, p.amount,
                            dest.payout_provider) e
     where e.eligible and e.preferred
     limit 1;
  end if;

  -- §5.1's currency handling. A payout in the currency that was collected has
  -- no rate to show; one that was converted names where the rate came from.
  if d.presentment_currency is distinct from p.currency then
    v_fx_source := case
      when d.fx_rate is not null then 'deal_locked_rate'
      else 'payhold_indicative'
    end;
  end if;

  if v_route_id is null then
    -- The most specific true statement, in the order a seller can act on it.
    v_reason := case
      when dest.id is null then 'no_eligible_verified_destination'
      when dest.verified_at is null then 'destination_not_verified'
      when dest.security_hold_until is not null and dest.security_hold_until > now()
        then 'destination_in_security_hold'
      else coalesce(
        (select e.reason_code
           from route_evaluation(p.tenant_id, dest.country, p.currency, p.amount,
                                 dest.payout_provider) e
          where e.preferred
          limit 1),
        'no_route_for_destination'
      )
    end;
  else
    v_reason := 'routed';
  end if;

  select * into previous
    from payout_decisions
   where payout_id = p.id
   order by created_at desc, id desc
   limit 1;

  if previous.id is not null
     and previous.reason_code = v_reason
     and previous.destination_id is not distinct from dest.id
     and previous.route_id is not distinct from v_route_id
  then
    decision := previous;
  else
    insert into payout_decisions (
      tenant_id, payout_id, route_id, destination_id, provider, payout_provider,
      method, currency, amount, ranking_score, fee_estimate, fx_source, fx_rate,
      is_fallback, reason_code, checks
    ) values (
      p.tenant_id, p.id, v_route_id, dest.id, v_provider, v_rail, v_method,
      p.currency, p.amount, v_rank, v_fee, v_fx_source,
      case when v_fx_source is null then null else d.fx_rate end,
      false, v_reason, checks
    )
    returning * into decision;
  end if;

  if v_route_id is null then
    -- §5.1's no-route behaviour: keep the amount, say why, ask for a
    -- destination. Nothing is discarded and nothing is rerouted.
    --
    -- `failed` is left alone. A provider that refused a transfer is a more
    -- specific fact than "no route", and it is what the retry backoff reads.
    if p.status not in ('failed', 'blocked') then
      update payouts
         set status = 'blocked',
             failure_reason = route_reason_text(
               v_reason,
               coalesce(dest.payout_provider, s.payout_provider),
               coalesce(dest.country, s.country),
               p.currency),
             reason_code = v_reason
       where id = p.id;
    end if;

    perform write_audit(p.tenant_id, p.deal_id, 'system', 'payout.blocked',
      jsonb_build_object(
        'payout_id', p.id,
        'reason_code', v_reason,
        'checks', checks
      ));

    return decision;
  end if;

  update payouts
     set destination_id = dest.id,
         -- A route exists again, so whatever the routing engine last said no
         -- longer holds. Leaving the old sentence would have an operator
         -- reading a stale reason against a payout that is about to go, and
         -- leaving the old code would have a client reading a stale one too.
         failure_reason = case when p.status = 'blocked' then null
                               else p.failure_reason end,
         reason_code = case when p.status = 'blocked' then null
                             else p.reason_code end,
         status = case when p.status = 'blocked' then 'scheduled'::payout_status
                       else p.status end
   where id = p.id;

  return decision;
end;
$$;

revoke all on function route_payout(uuid) from public, anon, authenticated;
revoke all on function route_payout(uuid) from payhold_ai;
grant execute on function route_payout(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Retry exhaustion: the third way a payout ends up `blocked`
-- ---------------------------------------------------------------------------
--
-- Unrelated to routing or funding — a provider was asked and refused, five
-- times, on a reason of its own (`p_reason`, the provider's own words,
-- unchanged and still not for a host to read). Tagging it distinguishes "we
-- gave up asking" from the two cases above, both of which mean nobody has
-- been asked to send anything yet. Reproduced verbatim from the live
-- definition apart from the one new line.

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
         reason_code = case when v_spent then 'retries_exhausted' else null end,
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

revoke all on function fail_payout(uuid, text) from public, anon, authenticated;
revoke all on function fail_payout(uuid, text) from payhold_ai;
grant execute on function fail_payout(uuid, text) to service_role;
