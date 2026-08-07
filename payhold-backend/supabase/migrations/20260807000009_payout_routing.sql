-- ---------------------------------------------------------------------------
-- V2 §5.1 and §5.2: the Payout Routing Center
-- ---------------------------------------------------------------------------
--
-- Until now "which rail carries this payout" was a function of the seller's
-- country and currency, computed in TypeScript (`_shared/rails.ts`,
-- `payoutProviderFor`). §12 asks for something that file cannot give: a country
-- or a provider disabled **without a redeploy**, which is §5.2's eighth
-- acceptance case. So the answer moves into data, and the decision it produces
-- becomes a record rather than a return value.
--
-- Three things arrive together, and they are one idea:
--
--   `payout_routes`     what rails exist, where they reach, and whether they
--                       are switched on. Rows, not code.
--   `route_payout()`    the deterministic choice §5.1 sketches, filtering in
--                       the same order its pseudocode does.
--   `payout_decisions`  every choice, with the checks behind it. §5.1: "store
--                       the selected provider, selected method, eligibility
--                       checks, ranking score, currency, fees, exchange-rate
--                       source and reason code."
--
-- ## The rule that shapes all of it
--
-- §5.1: **"it must never silently redirect funds to another destination."**
--
-- That is why a route is not a fallback for another route. A destination is a
-- token minted by one provider for one rail — a MoMo token means nothing to a
-- bank transfer — so "the highest-ranked eligible fallback" cannot mean a
-- different rail for the same destination. It means the seller's *backup
-- destination*, and §5.1 gates that behind a failed primary payout, an explicit
-- policy check and a notification. `route_payout` will not read the backup
-- until all of those hold.
--
-- ## Invariant 11 is unchanged
--
-- The routing engine may set a payout to `blocked` and may do nothing else. It
-- writes no ledger entry, calls no provider and changes no deal. A blocked
-- payout is money still sitting in `available` with a reason attached, which is
-- exactly §5.1's no-route behaviour: keep the amount, notify the seller, ask
-- for an eligible destination.

-- ---------------------------------------------------------------------------
-- Where this payout actually went
-- ---------------------------------------------------------------------------
--
-- §5.1's detail view "identifies the provider and destination used for each
-- payout", which the payout row could not answer: it named a seller, and a
-- seller now has more than one destination.

alter table payouts
  add column destination_id uuid references seller_destinations(id) on delete set null;

-- ---------------------------------------------------------------------------
-- The routes — data, not code
-- ---------------------------------------------------------------------------

create table payout_routes (
  id               uuid primary key default gen_random_uuid(),
  /**
   * Null is the platform default row for that rail. A tenant row **replaces**
   * the platform's rather than sitting beside it — see `route_evaluation`.
   * Without that, a tenant switching a rail off would leave the platform's
   * enabled row still eligible, and "disabled" would mean nothing.
   */
  tenant_id        uuid references tenants(id) on delete cascade,
  /** The rail, matching `seller_destinations.payout_provider`. */
  payout_provider  payout_provider not null,
  /**
   * Which adapter carries it. **Null means the rail is declared and not
   * built** — PayPal, Venmo, Cash App Pay, Alipay, WeChat Pay — and the check
   * below makes such a row impossible to enable. Spec §29.3: declared, so a
   * seller gets a specific refusal instead of "unknown destination type";
   * disabled, so no unapproved rail can carry money.
   */
  provider         provider,
  /** §5.1's "selected method", in the shape a seller recognises. */
  method           payout_method not null,
  countries        country_code[] not null,
  currencies       currency_code[] not null,
  /** A rail that collects is not always a rail that sends. Cards never send. */
  supports_payouts boolean not null default true,
  enabled          boolean not null default true,
  risk_status      route_risk_status not null default 'approved',
  /** Lower wins. §5.1's "reliability" in the ranking, made explicit. */
  rank             integer not null default 100,
  /** §5.1's `supportsAmount`. A null maximum means no ceiling. */
  min_amount       bigint not null default 0 check (min_amount >= 0),
  max_amount       bigint check (max_amount is null or max_amount > min_amount),
  /** §5.1's "cost" in the ranking, and the fee estimate on the decision row. */
  fee_fixed        bigint not null default 0 check (fee_fixed >= 0),
  fee_bps          integer not null default 0 check (fee_bps >= 0),
  note             text,
  created_at       timestamptz not null default now(),

  -- A rail with no adapter cannot be switched on. This is the structural half
  -- of "declared but disabled": someone flipping `enabled` on the PayPal row is
  -- refused by the database rather than by whoever reviews the pull request.
  constraint route_needs_an_adapter check (provider is not null or not enabled)
);

-- One row per rail per tenant, and one platform default per rail. `nulls not
-- distinct` is what makes the second half true — without it, "the platform
-- default" could quietly become several.
create unique index payout_routes_scope_key
  on payout_routes (tenant_id, payout_provider) nulls not distinct;

create index payout_routes_tenant_idx on payout_routes(tenant_id);

alter table payout_routes enable row level security;

-- The platform defaults are readable by everyone: a tenant needs to see the
-- corridor that refused their seller in order to do anything about it.
create policy payout_routes_read on payout_routes
  for select to authenticated
  using (
    tenant_id is null
    or tenant_id in (select current_tenant_ids())
    or is_platform_admin()
  );

grant select on payout_routes to authenticated;

-- ---------------------------------------------------------------------------
-- The decisions — §5.1's "deterministic and auditable"
-- ---------------------------------------------------------------------------

create table payout_decisions (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete cascade,
  payout_id        uuid not null references payouts(id) on delete cascade,
  /** Null on a no-route decision — there was nothing to select. */
  route_id         uuid references payout_routes(id) on delete set null,
  destination_id   uuid references seller_destinations(id) on delete set null,
  provider         provider,
  payout_provider  payout_provider,
  method           payout_method,
  currency         currency_code,
  amount           bigint,
  /** The winning route's rank. Recorded so a later reordering is explicable. */
  ranking_score    integer,
  fee_estimate     bigint,
  /**
   * §5.1's currency handling. Null when no conversion happened, which is the
   * case §5.1 prefers — "pay in the original currency where possible".
   */
  fx_source        text,
  fx_rate          numeric(20, 10),
  /** True only on a backup destination, which §5.1 requires be logged. */
  is_fallback      boolean not null default false,
  /**
   * `routed` when one was chosen; otherwise why not, from the same vocabulary
   * `route_evaluation` produces.
   */
  reason_code      text not null,
  /** Every route considered and its verdict — the audit §5.1 asks for. */
  checks           jsonb not null default '[]'::jsonb,
  created_at       timestamptz not null default now()
);

create index payout_decisions_payout_idx on payout_decisions(payout_id, created_at desc);
create index payout_decisions_tenant_idx on payout_decisions(tenant_id);

alter table payout_decisions enable row level security;

create policy payout_decisions_read on payout_decisions
  for select to authenticated
  using (tenant_id in (select current_tenant_ids()) or is_platform_admin());

grant select on payout_decisions to authenticated;

-- ---------------------------------------------------------------------------
-- The filter chain — §5.1's pseudocode, in the order it is written
-- ---------------------------------------------------------------------------
--
-- Returns **every** route with its verdict rather than only the survivors. Two
-- reasons: the losing rows are the eligibility record `payout_decisions.checks`
-- stores, and a seller asking "why can I not use Venmo" needs the answer for
-- the rail they picked, not the name of one they did not.
--
-- `p_rail` is the destination's own rail. It sorts to the front and does not
-- filter, so the evaluation stays readable as a whole; `route_payout` is what
-- insists the winner match it.
--
-- Every column reference in the body is qualified, and has to be:
-- `RETURNS TABLE` puts `provider`, `method` and `rank` in scope as parameter
-- names, and each of them is also a `payout_routes` column.

create or replace function route_evaluation(
  p_tenant   uuid,
  p_country  country_code,
  p_currency currency_code,
  p_amount   bigint,
  p_rail     payout_provider default null
) returns table (
  route_id        uuid,
  provider        provider,
  payout_provider payout_provider,
  method          payout_method,
  rank            integer,
  fee_estimate    bigint,
  preferred       boolean,
  eligible        boolean,
  reason_code     text
)
language sql
stable
as $$
  with resolved as (
    select distinct on (r.payout_provider) r.*
      from payout_routes r
     where r.tenant_id is null or r.tenant_id = p_tenant
     order by r.payout_provider, (r.tenant_id is not null) desc
  ),
  judged as (
    select
      r.id                                            as route_id,
      r.provider                                      as provider,
      r.payout_provider                               as payout_provider,
      r.method                                        as method,
      r.rank                                          as rank,
      r.fee_fixed + (p_amount * r.fee_bps) / 10000    as fee_estimate,
      (p_rail is not null and r.payout_provider = p_rail) as preferred,
      case
        -- A rail with no adapter reports as disabled rather than as a separate
        -- kind of missing: to the seller they are the same fact, and the note
        -- on the route row carries the detail.
        when r.provider is null or not r.enabled   then 'provider_disabled'
        when r.risk_status = 'suspended'           then 'route_suspended'
        when r.risk_status <> 'approved'           then 'route_under_review'
        when not r.supports_payouts                then 'payouts_not_supported'
        when not (p_country = any (r.countries))   then 'country_not_supported'
        when not (p_currency = any (r.currencies)) then 'currency_not_supported'
        when p_amount < r.min_amount               then 'below_route_minimum'
        when r.max_amount is not null and p_amount > r.max_amount
                                                   then 'above_route_maximum'
        else 'eligible'
      end                                             as reason_code
    from resolved r
  )
  select
    j.route_id, j.provider, j.payout_provider, j.method, j.rank, j.fee_estimate,
    j.preferred, j.reason_code = 'eligible', j.reason_code
  from judged j
  -- §5.1's `bySellerPreferenceThenReliabilityThenCost`, with eligibility ahead
  -- of all of it. The last key is there so the order is total: a tie broken by
  -- whatever Postgres happened to return first would make the engine
  -- non-deterministic in exactly the way §5.1 forbids.
  order by
    (j.reason_code = 'eligible') desc,
    j.preferred desc,
    j.rank,
    j.fee_estimate,
    j.payout_provider::text
$$;

grant execute on function route_evaluation(uuid, country_code, currency_code, bigint, payout_provider)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Reason codes in words
-- ---------------------------------------------------------------------------
--
-- §5.1: "the highest-ranked eligible fallback, **with the reason shown**", and
-- "with the reason and the next action". A code is for the audit row; a person
-- reading a stopped payout needs a sentence, and one sentence written here
-- beats the same sentence written three slightly different ways on three
-- screens.

create or replace function route_reason_text(
  p_code     text,
  p_rail     payout_provider,
  p_country  country_code,
  p_currency currency_code
) returns text
language sql
immutable
as $$
  select case p_code
    when 'routed' then
      format('Paid by %s.', p_rail)
    when 'provider_disabled' then
      format('%s is not available for payouts yet.', p_rail)
    when 'route_suspended' then
      format('%s payouts are suspended.', p_rail)
    when 'route_under_review' then
      format('%s payouts are under review and cannot be used right now.', p_rail)
    when 'payouts_not_supported' then
      format('%s can collect payments but cannot send them.', p_rail)
    when 'country_not_supported' then
      format('%s cannot pay a destination in %s.', p_rail, p_country)
    when 'currency_not_supported' then
      format('%s cannot pay out in %s.', p_rail, p_currency)
    when 'below_route_minimum' then
      format('This amount is below the minimum %s will send.', p_rail)
    when 'above_route_maximum' then
      format('This amount is above the maximum %s will send.', p_rail)
    when 'destination_not_verified' then
      'The payout destination has not been verified.'
    when 'no_eligible_verified_destination' then
      'No verified payout destination has been registered.'
    else
      format('PayHold has no payout route for %s in %s.', p_rail, p_country)
  end;
$$;

grant execute on function route_reason_text(text, payout_provider, country_code, currency_code)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Choosing, recording, and — when there is nothing to choose — blocking
-- ---------------------------------------------------------------------------
--
-- One function rather than a chooser and a recorder, because §5.1 wants the
-- decision auditable and a recorder the caller may forget to invoke is not an
-- audit. Every *changed* outcome writes a `payout_decisions` row, including the
-- no-route ones, which are the rows an operator most needs.
--
-- "Changed" matters: a blocked payout is re-evaluated on every dispatch pass,
-- so an unconditional insert would write one identical row per pass for as long
-- as a seller took to register a destination, and bury the decision that
-- actually explains something.
--
-- ### The backup destination
--
-- §5.1 permits it "only after a failed primary payout and an explicit
-- routing-policy check", and requires the seller be notified and the change
-- logged. All four conditions are here and none of them is a default:
--
--   1. the payout has actually failed,
--   2. it has failed at least `payout_primary_attempts` times,
--   3. the tenant has `payout_backup_enabled` on,
--   4. the backup is verified and out of its security hold.

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
  backup       seller_destinations;
  v_route_id   uuid;
  v_provider   provider;
  v_rail       payout_provider;
  v_method     payout_method;
  v_rank       integer;
  v_fee        bigint;
  checks       jsonb;
  fallback     boolean := false;
  allow_backup boolean;
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

  select * into dest
    from seller_destinations
   where seller_id = p.seller_id and is_primary;

  -- §5.1's routing-policy check, all of it, before the backup is even read.
  allow_backup :=
    p.status = 'failed'
    and p.attempts >= setting_num(p.tenant_id, 'payout_primary_attempts', 2)::integer
    and setting_num(p.tenant_id, 'payout_backup_enabled', 1) <> 0;

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

  if dest.id is not null and dest.verified_at is not null then
    select e.route_id, e.provider, e.payout_provider, e.method, e.rank, e.fee_estimate
      into v_route_id, v_provider, v_rail, v_method, v_rank, v_fee
      from route_evaluation(p.tenant_id, dest.country, p.currency, p.amount,
                            dest.payout_provider) e
     where e.eligible and e.preferred
     limit 1;
  end if;

  -- Only now, and only if the primary produced nothing.
  if v_route_id is null and allow_backup then
    select * into backup
      from seller_destinations
     where seller_id = p.seller_id
       and is_backup
       and verified_at is not null
       and (security_hold_until is null or security_hold_until <= now());

    if backup.id is not null then
      select e.route_id, e.provider, e.payout_provider, e.method, e.rank, e.fee_estimate
        into v_route_id, v_provider, v_rail, v_method, v_rank, v_fee
        from route_evaluation(p.tenant_id, backup.country, p.currency, p.amount,
                              backup.payout_provider) e
       where e.eligible and e.preferred
       limit 1;

      if v_route_id is not null then
        dest := backup;
        fallback := true;
      end if;
    end if;
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
      fallback, v_reason, checks
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
               p.currency)
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
         -- reading a stale reason against a payout that is about to go.
         failure_reason = case when p.status = 'blocked' then null
                               else p.failure_reason end,
         status = case when p.status = 'blocked' then 'scheduled'::payout_status
                       else p.status end
   where id = p.id;

  -- §5.1: the seller must be notified when the backup is used, and the change
  -- logged. Once — a later pass re-picking the same backup is not a new change.
  if fallback and (previous.id is null or not previous.is_fallback) then
    perform write_audit(p.tenant_id, p.deal_id, 'system', 'payout.route_changed',
      jsonb_build_object(
        'payout_id', p.id,
        'destination_id', dest.id,
        'masked_destination', dest.masked_destination,
        'reason', 'The primary destination failed; the verified backup was used'
      ));

    perform enqueue_webhooks(p.tenant_id, p.deal_id, 'payout.route_changed',
      jsonb_build_object(
        'payout_id', p.id,
        'destination', dest.masked_destination,
        'payout_provider', dest.payout_provider
      ));
  end if;

  return decision;
end;
$$;

-- ---------------------------------------------------------------------------
-- §5.1's status vocabulary, derived
-- ---------------------------------------------------------------------------
--
-- "Display `clearing`, `available`, `processing`, `paid`, `failed`, `blocked`
-- or `needs_verification`, with the reason and the next action."
--
-- Two of those seven are not payout facts. A payout row exists in `scheduled`
-- from the moment of release, and whether that reads as `clearing` or
-- `available` is a question about the **deal's** window — which
-- `payout-dispatch` already treats as authoritative, maturing deals before it
-- scans for payouts. Storing them on the payout as well would be one fact with
-- two writers, and the two would eventually disagree.
--
-- `held_for_review` and `frozen` both surface as `blocked`. To a seller they
-- are the same thing — stopped, and not their move — and naming a review queue
-- at them invites them to fix something that is not theirs to fix. The
-- operator's view reads `payouts.status`, which keeps every distinction.

create or replace function payout_display_status(p_payout uuid)
returns text
language sql
stable
as $$
  select case
    when p.status = 'paid'               then 'paid'
    when p.status = 'processing'         then 'processing'
    when p.status = 'failed'             then 'failed'
    when p.status = 'needs_verification' then 'needs_verification'
    when p.status in ('blocked', 'frozen', 'held_for_review') then 'blocked'
    when d.status = 'clearing'           then 'clearing'
    else 'available'
  end
  from payouts p join deals d on d.id = p.deal_id
  where p.id = p_payout;
$$;

grant execute on function payout_display_status(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- What a seller is told, ahead of time — §5.2 case 2
-- ---------------------------------------------------------------------------
--
-- `seller_capabilities` answered "is this person verified". §5.2's second case
-- is a seller who *is* verified being told clearly that Venmo does not work
-- outside the United States — a routing fact, not a KYC one, and one they can
-- only act on before a payout exists.
--
-- **The two lists stay separate, and that is the whole reason for the new
-- signature.** `screen_payout` reads `reasons` and would hold a payout on
-- anything in it; if a routing failure appeared there, an unroutable payout
-- would become `needs_verification` and the routing engine would never see it
-- — no `payout_decisions` row, no `checks`, no reason code, and a seller told
-- to verify something that is already verified. `route_reasons` is for showing.
--
-- (Changing the return type meant a `drop function`, not a `create or
-- replace`, and the grant had to be reissued. Same trap as a money function
-- gaining a parameter — see payhold-backend/CLAUDE.md.)

drop function if exists seller_capabilities(uuid);

create function seller_capabilities(p_seller uuid)
returns table (
  can_receive_payouts boolean,
  kyc_status          kyc_status,
  reasons             text[],
  route_reasons       text[]
)
language plpgsql
stable
as $$
declare
  s        sellers;
  v_reason text[] := '{}';
  v_route_reason text[] := '{}';
  v_dest   seller_destinations;
  v_code   text;
  v_found  boolean;
begin
  select * into s from sellers where id = p_seller;

  if not found then
    return;
  end if;

  if s.kyc_status <> 'verified' then
    v_reason := v_reason || format('Identity is %s, not verified', s.kyc_status)::text;
  end if;

  if s.sanctions_checked_at is null then
    v_reason := v_reason || 'Sanctions screening has not been run'::text;
  elsif s.sanctions_checked_at
        < now() - make_interval(days => setting_num(s.tenant_id, 'sanctions_max_age_days', 365)::integer)
  then
    v_reason := v_reason || 'Sanctions screening is out of date'::text;
  end if;

  select * into v_dest
    from seller_destinations
   where seller_id = s.id and is_primary;

  if not found then
    v_reason := v_reason || 'No payout destination has been registered'::text;
  else
    if v_dest.verified_at is null then
      v_reason := v_reason || 'The payout destination has not been verified'::text;
    end if;
    if v_dest.security_hold_until is not null and v_dest.security_hold_until > now() then
      v_reason := v_reason
        || format('A new destination is in its security hold until %s',
                  to_char(v_dest.security_hold_until, 'YYYY-MM-DD HH24:MI'))::text;
    end if;

    -- No amount, because this function is asked about a seller rather than
    -- about one payout, and a per-route minimum is a question about a payout.
    select e.reason_code, e.eligible into v_code, v_found
      from route_evaluation(s.tenant_id, v_dest.country, v_dest.payout_currency, 0,
                            v_dest.payout_provider) e
     where e.preferred
     limit 1;

    if v_code is null then
      v_route_reason := v_route_reason || route_reason_text(
        'no_route_for_destination', v_dest.payout_provider, v_dest.country,
        v_dest.payout_currency);
    elsif not v_found then
      v_route_reason := v_route_reason || route_reason_text(
        v_code, v_dest.payout_provider, v_dest.country, v_dest.payout_currency);
    end if;
  end if;

  return query select
    array_length(v_reason, 1) is null and array_length(v_route_reason, 1) is null,
    s.kyc_status,
    v_reason,
    v_route_reason;
end;
$$;

grant execute on function seller_capabilities(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The eligibility gate stops saying `held_for_review`
-- ---------------------------------------------------------------------------
--
-- Three changes, and the first is a hole Phase 4 left open.
--
-- **The approval short-circuit now covers only the discretionary rules.**
-- `screen_payout` returned early on `review_approved_at`, which was right while
-- everything below that line was a rule — a rule must not overrule the person
-- who overruled it. Phase 4 then added the §12 eligibility gate *above* it, and
-- an approval therefore skipped that too. A seller whose verification was
-- revoked after an approval would have been paid. Eligibility is unconditional
-- by construction, and that has to include unconditional on an earlier
-- approval.
--
-- **Eligibility now sets `needs_verification` rather than `held_for_review`.**
-- `approve_payout_review` only accepts `held_for_review`, so an operator can no
-- longer approve past "we have never verified this seller" — which is precisely
-- what §12's sentence says must not be possible. The way out is `verify_seller`,
-- an attestation with a name on it, after which the next pass finds nothing to
-- hold on and puts the payout back to `scheduled`.
--
-- **The signal is written on entry and on a change of reasons**, not on every
-- pass. `needs_verification` is re-screened by the cron, so an unconditional
-- insert would write one `not_eligible` row per pass per payout for as long as
-- a seller took to send a document — and §24.3 says these labels cannot be
-- backfilled, which makes drowning them in duplicates the expensive mistake.

create or replace function screen_payout(p_payout_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  p               payouts;
  d               deals;
  s               sellers;
  cfg_enabled     boolean;
  threshold_usd   bigint;
  prior_paid      int;
  previous_max    bigint;
  lost_disputes   int;
  seller_age_days numeric;
  release_minutes numeric;
  is_large        boolean;
  blocking        text[] := '{}';
  eligibility     text[];
  hold_hours      integer;
  last_reasons    jsonb;
begin
  select * into p from payouts where id = p_payout_id for update;

  if not found then
    raise exception 'not_found: payout % does not exist', p_payout_id
      using errcode = 'no_data_found';
  end if;

  select * into d from deals where id = p.deal_id;
  select * into s from sellers where id = p.seller_id;

  -- -------------------------------------------------------------------------
  -- A dispute outranks everything, and is nobody's to clear from here
  -- -------------------------------------------------------------------------
  --
  -- §8 freezes release and payout, and `settle_payout` refuses a disputed deal
  -- under the row lock — that is the guarantee. This is the same fact said in
  -- the status, so an operator reads a queue rather than an error.
  --
  -- It is `blocked` rather than `needs_verification` because there is nothing
  -- for the seller to verify: the payout moves when the dispute resolves and
  -- not before. That is what `blocked` means throughout — stopped by a fact
  -- that is neither the seller's to fix nor an operator's to approve.
  if d.status = 'disputed' then
    if p.status <> 'blocked' then
      update payouts
         set status = 'blocked',
             failure_reason = 'The deal is disputed'
       where id = p.id;

      perform write_audit(p.tenant_id, p.deal_id, 'system', 'payout.blocked',
        jsonb_build_object('payout_id', p.id, 'reason_code', 'deal_disputed'));
    end if;

    return true;
  end if;

  -- -------------------------------------------------------------------------
  -- Eligibility — §12. Not behind `risk_rules_enabled`, and not behind an
  -- earlier approval either.
  -- -------------------------------------------------------------------------

  select c.reasons into eligibility from seller_capabilities(p.seller_id) c;

  -- §5.1's change protection. Measured from when the destination moved rather
  -- than from when the row was written, so re-saving an unchanged destination
  -- costs a seller nothing.
  hold_hours := setting_num(p.tenant_id, 'destination_hold_hours', 24)::integer;

  if s.destination_changed_at is not null
     and s.destination_changed_at > now() - make_interval(hours => hold_hours)
  then
    eligibility := coalesce(eligibility, '{}') ||
      format('The payout destination changed in the last %s hours', hold_hours)::text;
  end if;

  if array_length(eligibility, 1) is not null then
    select value -> 'reasons' into last_reasons
      from risk_signals
     where deal_id = p.deal_id
       and seller_id = p.seller_id
       and signal = 'not_eligible'
     order by created_at desc
     limit 1;

    if last_reasons is distinct from to_jsonb(eligibility) then
      insert into risk_signals (tenant_id, deal_id, seller_id, signal, severity, value, explanation)
      values (
        p.tenant_id, p.deal_id, p.seller_id, 'not_eligible', 'review',
        jsonb_build_object('reasons', to_jsonb(eligibility), 'kyc_status', s.kyc_status),
        format('This seller cannot be paid yet: %s.', array_to_string(eligibility, '; '))
      );
    end if;

    if p.status <> 'needs_verification' then
      update payouts
         set status = 'needs_verification',
             review_held_at = now()
       where id = p.id;

      perform write_audit(p.tenant_id, p.deal_id, 'system', 'payout.needs_verification',
        jsonb_build_object('payout_id', p.id, 'eligibility', to_jsonb(eligibility)));
    end if;

    return true;
  end if;

  -- Nothing outstanding any more. Somebody attested to the missing fact, so the
  -- payout goes back in the queue rather than waiting for a pass that would
  -- never come — `mark_payout_processing` refuses a state it does not know.
  if p.status = 'needs_verification' then
    update payouts set status = 'scheduled', review_held_at = null where id = p.id;

    perform write_audit(p.tenant_id, p.deal_id, 'system', 'payout.eligible',
      jsonb_build_object('payout_id', p.id));
  end if;

  -- -------------------------------------------------------------------------
  -- The discretionary rules — V1's, still governed by the setting, and still
  -- outranked by a person who has already looked.
  -- -------------------------------------------------------------------------

  if p.review_approved_at is not null then
    return false;
  end if;

  cfg_enabled := setting_num(p.tenant_id, 'risk_rules_enabled', 1) <> 0;
  threshold_usd := setting_num(p.tenant_id, 'risk_review_threshold_usd', 100000)::bigint;

  -- The threshold is in USD and the payout is in whatever the seller banks in.
  -- Comparing without conversion would make one number mean twenty different
  -- limits, so a currency we cannot convert declines to judge size at all
  -- rather than guessing — the other rules still apply.
  is_large := exists (
    select 1 where p.currency = 'USD' and p.amount >= threshold_usd
  );

  select count(*), coalesce(max(amount), 0)
    into prior_paid, previous_max
  from payouts
  where seller_id = p.seller_id and id <> p.id and status = 'paid';

  -- A first payout to a destination we have never sent to.
  if prior_paid = 0 and s.id is not null then
    -- Age is measured at the moment the deal was struck, not now: the clearance
    -- window is days long, so every seller is "old" by the time their first
    -- payout comes due. What matters is that they registered shortly before
    -- taking this booking.
    seller_age_days := extract(epoch from (d.created_at - s.created_at)) / 86400;

    insert into risk_signals (tenant_id, deal_id, seller_id, signal, severity, value, explanation)
    values (
      p.tenant_id, p.deal_id, p.seller_id, 'new_seller',
      case when seller_age_days <= 7 or is_large then 'review' else 'info' end::risk_severity,
      jsonb_build_object(
        'seller_age_days_at_deal', round(seller_age_days, 1),
        'prior_payouts', 0,
        'destination', s.masked_destination
      ),
      format('First payout to %s (%s), who registered %s days before this deal was created.',
             s.name, s.masked_destination, round(abs(seller_age_days)))
    );

    if seller_age_days <= 7 or is_large then
      blocking := blocking || 'new_seller'::text;
    end if;
  end if;

  -- A jump well beyond anything this seller has been paid before.
  if is_large and previous_max > 0 and p.amount >= previous_max * 3 then
    insert into risk_signals (tenant_id, deal_id, seller_id, signal, severity, value, explanation)
    values (
      p.tenant_id, p.deal_id, p.seller_id, 'large_payout', 'review',
      jsonb_build_object('amount', p.amount, 'currency', p.currency, 'previous_max', previous_max),
      format('This payout is %sx the largest this seller has been paid before.',
             round(p.amount::numeric / previous_max, 1))
    );
    blocking := blocking || 'large_payout'::text;
  end if;

  -- A loss against this seller inside the lookback window.
  select count(*) into lost_disputes
  from disputes di
  join deals dd on dd.id = di.deal_id
  where dd.seller_id = p.seller_id
    and di.status in ('resolved_refunded', 'resolved_split')
    and di.resolved_at > now() - interval '90 days';

  if lost_disputes > 0 then
    insert into risk_signals (tenant_id, deal_id, seller_id, signal, severity, value, explanation)
    values (
      p.tenant_id, p.deal_id, p.seller_id, 'prior_dispute', 'review',
      jsonb_build_object('disputes', lost_disputes, 'lookback_days', 90),
      format('%s dispute(s) resolved against this seller in the last 90 days.',
             lost_disputes)
    );
    blocking := blocking || 'prior_dispute'::text;
  end if;

  -- Funded and released almost immediately.
  if d.released_at is not null then
    select extract(epoch from (d.released_at - min(l.created_at))) / 60
      into release_minutes
    from ledger l where l.deal_id = d.id and l.entry_type = 'hold';

    if release_minutes is not null and release_minutes between 0 and 15 then
      insert into risk_signals (tenant_id, deal_id, seller_id, signal, severity, value, explanation)
      values (
        p.tenant_id, p.deal_id, p.seller_id, 'fast_release',
        case when is_large then 'review' else 'info' end::risk_severity,
        jsonb_build_object('minutes', round(release_minutes)),
        format('Funded and released within %s minutes.', round(release_minutes))
      );
      if is_large then
        blocking := blocking || 'fast_release'::text;
      end if;
    end if;
  end if;

  -- Recording happens whether or not the rules are switched on. The setting
  -- governs holding, not noticing.
  if not cfg_enabled or array_length(blocking, 1) is null then
    return false;
  end if;

  update payouts
     set status = 'held_for_review',
         review_held_at = now()
   where id = p.id;

  perform write_audit(p.tenant_id, p.deal_id, 'system', 'payout.held_for_review',
    jsonb_build_object('payout_id', p.id, 'signals', to_jsonb(blocking)));

  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- Telling the client
-- ---------------------------------------------------------------------------
--
-- §5.1's no-route behaviour says "notify the seller". PayHold has no channel to
-- a seller — that is the tenant's relationship — so the notification is the
-- tenant's webhook, the same route every other payout event takes.

create or replace function emit_payout_event() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status is not distinct from old.status then
    return new;
  end if;

  if new.status = 'failed' then
    perform enqueue_webhooks(new.tenant_id, new.deal_id, 'payout.failed', jsonb_build_object(
      'payout_id', new.id,
      'reason', new.failure_reason,
      'attempts', new.attempts
    ));
  elsif new.status = 'held_for_review' then
    perform enqueue_webhooks(new.tenant_id, new.deal_id, 'payout.held_for_review',
      jsonb_build_object(
        'payout_id', new.id,
        'amount', new.amount,
        'currency', new.currency
      ));
  elsif new.status = 'blocked' then
    perform enqueue_webhooks(new.tenant_id, new.deal_id, 'payout.blocked',
      jsonb_build_object(
        'payout_id', new.id,
        'amount', new.amount,
        'currency', new.currency,
        'reason', new.failure_reason
      ));
  elsif new.status = 'needs_verification' then
    perform enqueue_webhooks(new.tenant_id, new.deal_id, 'payout.needs_verification',
      jsonb_build_object(
        'payout_id', new.id,
        'amount', new.amount,
        'currency', new.currency
      ));
  end if;

  -- `paid` is not emitted here: the deal moves to paid_out in the same
  -- transaction and that trigger carries it. Two events for one settlement
  -- would make a client's idempotency key do work it should not have to.
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- The launch matrix — §5, as rows
-- ---------------------------------------------------------------------------
--
-- These are the platform defaults. A tenant overrides one by inserting their
-- own row for the same rail, which replaces rather than joins it.
--
-- The country lists are deliberately narrower than `countries.ts` knows about.
-- That file is the generated registry of where money *can* go in principle;
-- this table is where it may go **today**, which §5 calls "a country-and-
-- currency matrix, not a hard-coded list" and adds to "only through a formal
-- country-launch checklist". Adding a country is an insert, not a release.

insert into payout_routes (
  payout_provider, provider, method, countries, currencies,
  supports_payouts, enabled, rank, note
) values
  -- Rwanda leads because it is the launch market and mobile money is what
  -- sellers there actually use. That is the rank, not an accident of insertion
  -- order — §5.1 wants the ranking explicit.
  ('flutterwave_momo', 'flutterwave', 'mobile_money',
   array['RW','KE','UG','TZ','GH','ZM','CI','SN','CM']::country_code[],
   array['RWF','KES','UGX','TZS','GHS','ZMW','XOF','XAF']::currency_code[],
   true, true, 10,
   'MTN and Airtel wallets via Flutterwave Transfers. The launch rail for §5''s Rwanda row.'),

  ('flutterwave_bank', 'flutterwave', 'bank_account',
   array['RW','KE','UG','TZ','GH','NG','ZA','ZM','CI','SN','CM','EG']::country_code[],
   array['RWF','KES','UGX','TZS','GHS','NGN','ZAR','ZMW','XOF','XAF','EGP']::currency_code[],
   true, true, 20,
   'Bank transfer via Flutterwave. Slower than a wallet, and the only African route for an amount a wallet will not hold.'),

  -- §5's UAE and United States rows. Stripe cannot pay a Rwandan recipient,
  -- which is why the two rails above exist and why this one''s country list
  -- stops where it does.
  ('stripe_connect', 'stripe', 'bank_account',
   array['US','AE','GB','DE','FR','NL','IE','ES','IT','CA','AU']::country_code[],
   array['USD','AED','EUR','GBP','CAD','AUD']::currency_code[],
   true, true, 30,
   'Stripe Connect payouts. Cannot reach African destinations — see the Flutterwave rails.'),

  -- Declared and disabled, spec §29.3. `provider` is null, so
  -- `route_needs_an_adapter` refuses to let any of these be switched on until
  -- something is built behind them.
  ('paypal', null, 'wallet',
   array['US','AE','GB','DE','FR','NL','IE','ES','IT','CA','AU']::country_code[],
   array['USD','AED','EUR','GBP','CAD','AUD']::currency_code[],
   true, false, 40,
   'Declared so a seller gets a specific answer. No adapter and no signed agreement — §29.3.'),

  ('venmo', null, 'wallet',
   array['US']::country_code[],
   array['USD']::currency_code[],
   true, false, 50,
   'United States only, by Venmo''s own rules. §17 also rules out personal Venmo accounts, so this stays off even once an adapter exists.'),

  ('cash_app_pay', null, 'wallet',
   array['US']::country_code[],
   array['USD']::currency_code[],
   true, false, 60,
   'United States only. Declared, not built — §29.3.'),

  -- §5's Mainland China row: "Do not promise cross-border payout until
  -- approved." These rows exist so a Chinese seller is told that, rather than
  -- told nothing.
  ('alipay', null, 'wallet',
   array['CN']::country_code[],
   array['CNY']::currency_code[],
   true, false, 70,
   'Requires an approved local structure and payout partner. §5 forbids promising this route until it exists.'),

  ('wechat_pay', null, 'wallet',
   array['CN']::country_code[],
   array['CNY']::currency_code[],
   true, false, 80,
   'Requires an approved local structure and payout partner. §5 forbids promising this route until it exists.');

-- ---------------------------------------------------------------------------
-- Service role only
-- ---------------------------------------------------------------------------

revoke all on function route_payout(uuid) from public, anon, authenticated;

-- Routing a payout is a step on the path money leaves by, so it goes on the
-- same list as every other one — invariant 9, enforced as a grant rather than
-- as a convention.
revoke all on function route_payout(uuid) from payhold_ai;
