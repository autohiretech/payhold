-- ---------------------------------------------------------------------------
-- A seller has one payout destination. Adding one replaces it.
-- ---------------------------------------------------------------------------
--
-- Spec §29.17. `add_seller_destination` used to demote the current primary and
-- insert beside it, forever, so every save left one more row: a host who
-- re-entered their mobile money number four times showed five destinations,
-- four of them "Other", each still verifiable, still endable, and — through a
-- withdrawal naming it or `route_payout`'s backup branch — still somewhere
-- money could go. Nobody chose any of those four rows as a place to be paid.
-- They were left behind by the writer.
--
-- The ruling: **one live destination per seller.** §5.1's backup destination is
-- removed (superseding §5.1's "Backup method" row and §5.2 #5), and so is the
-- move back (`promote_seller_destination`). Changing where a seller is paid is
-- replace-and-archive:
--
--   * every live row for the seller is stamped `archived_at`, loses its role,
--     and records `replaced_by` — the row that replaced it
--   * the new row is inserted primary, **with exactly the verification,
--     security-hold and auto-verify behaviour it had before**. Replacing is
--     still the account-takeover shape §5.1's change protection exists for, so
--     nothing about the hold is relaxed by there being only one row
--
-- **Rows are archived, never deleted.** `payouts.destination_id`,
-- `payouts.requested_destination_id` and `payout_decisions.destination_id` all
-- reference this table `on delete set null`, and `dispatchPayout` throws when a
-- routed decision's destination row is gone — so a delete would erase where a
-- paid payout went *and* strand one still `processing`. An archived row keeps
-- answering both questions; it just cannot be chosen, verified, have its hold
-- ended, or be withdrawn to.
--
-- The one-live rule is an index, created after the backfill below. Two live
-- rows for one seller are refused by Postgres rather than by a writer
-- remembering to demote.
--
-- ## What is deliberately unchanged
--
--   * `sync_primary_destination` still copies the primary onto `sellers`. The
--     archive step only ever writes `is_primary = false`, and the trigger's first
--     line returns for a row that is not primary, so archiving cannot clear a
--     seller's columns — only the insert of the new primary moves them.
--   * `seller_capabilities`, `screen_payout` and `verify_seller` read
--     `where is_primary`. An archived row can never be primary (a check
--     constraint below), so they needed no change.
--   * `add_seller_destination` keeps its signature, `p_role` included, and
--     accepts `'primary'` or null. Removing the parameter would have made every
--     call from the functions still deployed between `db push` and
--     `functions deploy` fail to resolve — PostgREST matches a function by its
--     argument names — so the parameter stays and refuses what it can no longer
--     mean.

-- ---------------------------------------------------------------------------
-- The columns
-- ---------------------------------------------------------------------------

alter table seller_destinations
  add column if not exists archived_at timestamptz,
  add column if not exists replaced_by uuid
    references seller_destinations(id) on delete set null;

comment on column seller_destinations.archived_at is
  'Null while this is the seller''s live destination. Set when a later destination '
  'replaced it (or by 20260911000003''s backfill). An archived row is history: '
  'payouts still reference it, and nothing may route to, verify or end a hold on it.';

comment on column seller_destinations.replaced_by is
  'The destination that replaced this one. Null on a live row, and on rows the '
  '20260911000003 backfill archived — those were not replaced by anything new.';

-- ---------------------------------------------------------------------------
-- BACKFILL: keep the destination money goes to today
-- ---------------------------------------------------------------------------
--
-- Where money goes must not change for anyone, so the row kept is the one
-- routing already reads.
--
--   1. A seller with a primary keeps it, untouched: no column on it is written,
--      so the sync trigger has nothing to copy and `verified_at` and
--      `security_hold_until` stay exactly as they are. Every other live row —
--      "Other" rows and the backup alike — is archived.
--   2. A seller with live rows and **no** primary keeps the most recently
--      created one and it is **not promoted**. That seller exists: a destination
--      added with `p_role = 'backup'` to a seller registered without one is a
--      backup with no primary beside it. Routing reads only the primary, and the
--      eligibility gate holds such a seller's payout at `needs_verification`
--      ("No payout destination has been registered") before routing is reached,
--      so today nothing is paid there. Promoting the kept row would start paying
--      a destination that was not being paid — exactly the silent redirection
--      §5.1 forbids. It stays unpromoted until somebody adds a destination.
--
-- Archived here means `archived_at = now()`, both roles cleared and
-- `replaced_by = null`: nothing new replaced these rows, a ruling did.
--
-- One `seller.destination_archived` audit row per archived destination, as the
-- system, carrying the mask and never the token (§19).
--
-- Safe to run twice: the second pass finds at most one live row per seller and
-- archives nothing, so it writes nothing.
--
-- Known and accepted: a payout not yet sent whose `requested_destination_id`
-- names a row archived here will route to the seller's primary on its next
-- pass. That is `route_payout`'s existing rule for a requested destination that
-- no longer stands (the same thing happens when its verification is withdrawn),
-- and AutoHire's withdrawals have never named one.

do $$
declare
  r record;
begin
  for r in
    with live as (
      select d.id,
             d.is_backup,
             row_number() over w as n,
             first_value(d.id) over w as kept_id
        from seller_destinations d
       where d.archived_at is null
      window w as (
        partition by d.seller_id
        -- The primary first; failing that, the newest. `id` makes it total, so
        -- two rows created in one transaction cannot be kept by chance.
        order by d.is_primary desc, d.created_at desc, d.id desc
      )
    )
    update seller_destinations d
       set archived_at = now(),
           is_primary  = false,
           is_backup   = false,
           replaced_by = null
      from live
     where d.id = live.id
       and live.n > 1
    returning d.id, d.tenant_id, d.seller_id, d.masked_destination,
              live.is_backup as was_backup, live.kept_id
  loop
    perform write_audit(
      r.tenant_id, null, 'system', 'seller.destination_archived',
      jsonb_build_object(
        'seller_id', r.seller_id,
        'destination_id', r.id,
        'masked_destination', r.masked_destination,
        'was_backup', r.was_backup,
        'kept_destination_id', r.kept_id,
        'reason', 'one_destination_per_seller'
      )
    );
  end loop;
end;
$$;

-- The backup role is gone, including from a kept row in case 2 above. Clearing
-- it moves no money: that row is not primary, so routing never reads it, and
-- the backup branch it could once have been reached by is removed below. It is
-- not a primary row either, so the sync trigger returns before touching
-- `sellers`.
update seller_destinations set is_backup = false where is_backup;

-- ---------------------------------------------------------------------------
-- The shape, now that the data fits it
-- ---------------------------------------------------------------------------

drop index if exists seller_destinations_one_backup;

alter table seller_destinations
  drop constraint if exists seller_destinations_no_backup;
alter table seller_destinations
  add constraint seller_destinations_no_backup check (not is_backup);

-- An archived row is never primary. This is what lets every reader that asks
-- `where is_primary` stay exactly as it was.
alter table seller_destinations
  drop constraint if exists seller_destinations_archived_not_primary;
alter table seller_destinations
  add constraint seller_destinations_archived_not_primary
  check (archived_at is null or not is_primary);

-- After the backfill, in the same migration, or it would refuse the data the
-- backfill exists to fix.
create unique index if not exists seller_destinations_one_live
  on seller_destinations(seller_id) where archived_at is null;

-- ---------------------------------------------------------------------------
-- Adding a destination replaces the live one
-- ---------------------------------------------------------------------------
--
-- Same signature as `20260817000002`, so `create or replace`. The revokes and
-- the service-role grant are reissued from `20260817000002` and
-- `20260809000001` all the same.

create or replace function add_seller_destination(
  p_seller   uuid,
  p_tenant   uuid,
  p_country  country_code,
  p_currency currency_code,
  p_provider payout_provider,
  p_token    text,
  p_masked   text,
  p_label    text default null,
  -- Kept for the functions deployed before this migration, which still send
  -- it. `'primary'` (or nothing) is the only thing it can mean now.
  p_role     text default 'primary',
  p_actor    text default null
) returns seller_destinations
language plpgsql
security definer
set search_path = public
as $$
declare
  s          sellers;
  d          seller_destinations;
  hold_hours integer;
  trusted    boolean;
  v_archived uuid[];
begin
  if p_role is not null and p_role <> 'primary' then
    raise exception 'backup_destination_removed: A seller has one payout destination; adding one replaces the current one.'
      using errcode = 'check_violation';
  end if;

  if p_token is null or btrim(p_token) = '' or p_masked is null or btrim(p_masked) = '' then
    raise exception 'policy_violation: a destination needs a token and a mask'
      using errcode = 'check_violation';
  end if;

  -- Locked, and tenant-scoped in the same statement. Two concurrent changes
  -- would otherwise both archive the same row and the second insert would lose
  -- to `seller_destinations_one_live` with a message about an index.
  select * into s from sellers
   where id = p_seller and tenant_id = p_tenant
     for update;

  if not found then
    raise exception 'not_found: seller % does not exist', p_seller
      using errcode = 'no_data_found';
  end if;

  -- Archive first. `seller_destinations_one_primary` and `_one_live` both refuse
  -- the overlap, so the order is forced. `replaced_by` is filled in after the
  -- insert: the new row's id does not exist yet, and the foreign key is checked
  -- per statement. Writing `is_primary = false` is what the sync trigger reads
  -- as "not mine", so the seller's columns are untouched until the insert.
  with archived as (
    update seller_destinations
       set archived_at = now(),
           is_primary  = false,
           is_backup   = false
     where seller_id = p_seller
       and archived_at is null
    returning id
  )
  select coalesce(array_agg(id order by id), '{}') into v_archived from archived;

  -- Unchanged from `20260817000002`: a tenant that attests to its own
  -- onboarding gets a verified row out of hold; everyone else waits.
  trusted    := seller_auto_verify(p_tenant);
  hold_hours := case when trusted then 0
                     else setting_num(p_tenant, 'destination_hold_hours', 24)::integer end;

  insert into seller_destinations (
    tenant_id, seller_id, label, country, payout_currency, payout_provider,
    beneficiary_token, masked_destination, is_primary, is_backup,
    verified_at, security_hold_until
  )
  values (
    p_tenant, p_seller, p_label, p_country, p_currency, p_provider,
    p_token, p_masked, true, false,
    case when trusted then now() end,
    now() + make_interval(hours => hold_hours)
  )
  returning * into d;

  -- Not `returning * into d`: that would overwrite the row this returns. The
  -- archived rows are not primary, so the sync trigger ignores this write.
  update seller_destinations
     set replaced_by = d.id
   where id = any(v_archived);

  -- The mask, never the token (§19).
  perform write_audit(
    p_tenant, null, coalesce(nullif(btrim(p_actor), ''), 'api'),
    'seller.destination_added',
    jsonb_build_object(
      'seller_id', p_seller,
      'destination_id', d.id,
      'destination', d.masked_destination,
      'provider', d.payout_provider,
      'role', 'primary',
      'security_hold_until', d.security_hold_until,
      'auto_verified', trusted,
      'archived_destination_ids', to_jsonb(v_archived)
    )
  );

  return d;
end;
$$;

revoke all on function add_seller_destination(
  uuid, uuid, country_code, currency_code, payout_provider, text, text, text, text, text
) from public, anon, authenticated;
revoke all on function add_seller_destination(
  uuid, uuid, country_code, currency_code, payout_provider, text, text, text, text, text
) from payhold_ai;
grant execute on function add_seller_destination(
  uuid, uuid, country_code, currency_code, payout_provider, text, text, text, text, text
) to service_role;

comment on function add_seller_destination(
  uuid, uuid, country_code, currency_code, payout_provider, text, text, text, text, text
) is
  '§29.17: replace a seller''s payout destination. Every live row is archived '
  '(never deleted) and the new one becomes primary, unverified and inside its '
  'security hold unless the tenant auto-verifies. p_role accepts only primary.';

-- ---------------------------------------------------------------------------
-- Nothing moves back: `promote_seller_destination` goes
-- ---------------------------------------------------------------------------
--
-- It picked between live rows, and there is only one. Returning to a
-- destination used before is adding it again — a new row, a new hold — which is
-- what adding any destination is.

drop function if exists promote_seller_destination(uuid, uuid, text);

-- ---------------------------------------------------------------------------
-- An archived row cannot be verified
-- ---------------------------------------------------------------------------
--
-- `20260909000001`'s function with one refusal added, before the no-op check:
-- a verification on a row nothing can pay is a name against a decision about
-- nothing, in either direction. The live row is always the one to verify.

create or replace function verify_seller_destination(
  p_destination uuid,
  p_tenant      uuid,
  p_actor       text,
  p_verified    boolean default true
) returns seller_destinations
language plpgsql
security definer
set search_path = public
as $$
declare
  d seller_destinations;
begin
  if p_actor is null or btrim(p_actor) = '' then
    raise exception 'policy_violation: verifying a destination must record who verified it'
      using errcode = 'check_violation';
  end if;

  select * into d from seller_destinations
   where id = p_destination and tenant_id = p_tenant
     for update;

  if not found then
    raise exception 'not_found: destination % does not exist', p_destination
      using errcode = 'no_data_found';
  end if;

  if d.archived_at is not null then
    raise exception 'destination_archived: This payout destination was replaced, so it can no longer be verified. Verify the seller''s current destination instead.'
      using errcode = 'check_violation';
  end if;

  if (p_verified and d.verified_at is not null)
     or (not p_verified and d.verified_at is null) then
    return d;
  end if;

  update seller_destinations
     set verified_at = case when p_verified then now() else null end
   where id = d.id
  returning * into d;

  perform write_audit(
    p_tenant, null, p_actor,
    case when p_verified then 'seller.destination_verified'
         else 'seller.destination_verification_withdrawn' end,
    jsonb_build_object(
      'seller_id', d.seller_id,
      'destination_id', d.id,
      'destination', d.masked_destination,
      'is_primary', d.is_primary
    )
  );

  return d;
end;
$$;

revoke all on function verify_seller_destination(uuid, uuid, text, boolean)
  from public, anon, authenticated;
-- Not issued by `20260909000001`, and it should have been: this is a stop on
-- the payout path, and invariant 9 is a grant list.
revoke all on function verify_seller_destination(uuid, uuid, text, boolean) from payhold_ai;

-- ---------------------------------------------------------------------------
-- An archived row has no hold to end
-- ---------------------------------------------------------------------------
--
-- `20260809000002`'s function with the same refusal, also before the no-op
-- check — an archived row's hold stamp is history, and ending it would put a
-- person's name on a step-up for a change that has since been replaced.

create or replace function end_destination_hold(
  p_destination uuid,
  p_tenant      uuid,
  p_actor       text
) returns seller_destinations
language plpgsql
security definer
set search_path = public
as $$
declare
  d        seller_destinations;
  v_was    timestamptz;
begin
  if p_actor is null or btrim(p_actor) = '' then
    raise exception 'policy_violation: ending a security hold must record who ended it'
      using errcode = 'check_violation';
  end if;

  select * into d from seller_destinations
   where id = p_destination and tenant_id = p_tenant
     for update;

  if not found then
    raise exception 'not_found: destination % does not exist', p_destination
      using errcode = 'no_data_found';
  end if;

  if d.archived_at is not null then
    raise exception 'destination_archived: This payout destination was replaced, so there is no hold on it to end. The seller''s current destination is the one that can be released.'
      using errcode = 'check_violation';
  end if;

  if d.security_hold_until is null or d.security_hold_until <= now() then
    return d;
  end if;

  v_was := d.security_hold_until;

  update seller_destinations
     set security_hold_until = now()
   where id = d.id
  returning * into d;

  perform write_audit(
    p_tenant, null, p_actor, 'seller.destination_hold_ended',
    jsonb_build_object(
      'seller_id', d.seller_id,
      'destination_id', d.id,
      'destination', d.masked_destination,
      'held_until', v_was,
      'hours_remaining', round(extract(epoch from (v_was - now())) / 3600.0, 2)
    )
  );

  return d;
end;
$$;

comment on function end_destination_hold(uuid, uuid, text) is
  '§5.1 step-up: record that a destination change was confirmed with the '
  'seller, ending its security hold early. Takes a name, audits against it, '
  'and is refused an API key at the endpoint. Verification is separate and '
  'still outstanding afterwards. Refuses an archived destination.';

revoke all on function end_destination_hold(uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function end_destination_hold(uuid, uuid, text) from payhold_ai;

-- ---------------------------------------------------------------------------
-- A withdrawal may name only the live destination
-- ---------------------------------------------------------------------------
--
-- `20260808000002`'s function. The destination check narrows from "one of the
-- seller's verified rows" to "the seller's live primary", and a row that is not
-- it — archived, another seller's, not a destination at all — is one refusal
-- with its own code, which the endpoint answers with a 400. Leaving the
-- destination out is unchanged and is what AutoHire sends: the payout routes to
-- the primary. The verification and hold refusals on the live row are unchanged
-- too. Everything below the check is untouched.

create or replace function request_withdrawal(
  p_seller       uuid,
  p_actor        text,
  p_destination  uuid default null
)
returns setof payouts
language plpgsql
security definer
set search_path = public
as $$
declare
  s        sellers;
  dest     seller_destinations;
  v_count  integer;
begin
  if coalesce(trim(p_actor), '') = '' then
    raise exception 'policy_violation: a withdrawal request needs a name'
      using errcode = 'check_violation';
  end if;

  select * into s from sellers where id = p_seller;

  if not found then
    raise exception 'not_found: seller % does not exist', p_seller
      using errcode = 'no_data_found';
  end if;

  if p_destination is not null then
    select * into dest
      from seller_destinations
     where id = p_destination
       and seller_id = p_seller
       and archived_at is null
       and is_primary;

    if not found then
      raise exception 'destination_not_live: destination % is not this seller''s current payout destination. Leave destination_id out to withdraw to the current one.',
        p_destination
        using errcode = 'check_violation';
    end if;

    if dest.verified_at is null then
      raise exception 'policy_violation: destination % has not been verified',
        p_destination
        using errcode = 'check_violation';
    end if;

    if dest.security_hold_until is not null and dest.security_hold_until > now() then
      raise exception
        'policy_violation: destination % is in its security hold until %',
        p_destination, dest.security_hold_until
        using errcode = 'check_violation';
    end if;
  end if;

  with due as (
    select p.id
      from payouts p
      join deals d on d.id = p.deal_id
     where p.seller_id = p_seller
       and p.status in ('scheduled', 'blocked', 'needs_verification', 'failed', 'frozen')
       and d.status in ('released', 'payout_pending')
       and p.withdrawal_requested_at is null
     for update of p
  )
  update payouts p
     set withdrawal_requested_at  = now(),
         requested_destination_id = coalesce(p_destination, p.requested_destination_id),
         next_attempt_at          = now()
    from due
   where p.id = due.id;

  get diagnostics v_count = row_count;

  if v_count = 0 then
    raise exception 'invalid_state: seller % has nothing cleared to withdraw', p_seller
      using errcode = 'check_violation';
  end if;

  perform write_audit(s.tenant_id, null, p_actor, 'seller.withdrawal_requested',
    jsonb_build_object(
      'seller_id', p_seller,
      'payouts', v_count,
      'destination_id', p_destination
    ));

  return query
    select * from payouts
     where seller_id = p_seller and withdrawal_requested_at is not null
       and status <> 'paid'
     order by scheduled_for;
end;
$$;

comment on function request_withdrawal(uuid, text, uuid) is
  'Stamp a seller''s cleared payouts as asked-for and re-arm their retry '
  'clock. Moves no money: dispatchPayout still screens, routes and books. '
  'A named destination must be the seller''s live one.';

revoke all on function request_withdrawal(uuid, text, uuid) from public, anon, authenticated;
revoke all on function request_withdrawal(uuid, text, uuid) from payhold_ai;

-- ---------------------------------------------------------------------------
-- Routing reads the live destination and has no backup branch
-- ---------------------------------------------------------------------------
--
-- `20260808000002`'s function with two changes and nothing else:
--
--   * both destination reads carry `archived_at is null`, so an archived row is
--     never chosen — including one a payout requested before it was replaced,
--     which falls through to the primary exactly as a requested destination
--     whose verification was withdrawn always has
--   * the backup branch is gone: `allow_backup`, the `is_backup` read, the
--     `payout_primary_attempts` / `payout_backup_enabled` settings it read, and
--     the `payout.route_changed` audit and webhook that only it could cause.
--     `payout_decisions.is_fallback` stays as a column, for the decisions
--     already recorded, and every new decision writes `false`.
--
-- The eligibility evaluation, the no-route block, the de-duplicated decision
-- row, `route_reason_text` and the un-blocking update are character for
-- character what they were.

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

  if dest.id is not null and dest.verified_at is not null then
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

  return decision;
end;
$$;

revoke all on function route_payout(uuid) from public, anon, authenticated;
revoke all on function route_payout(uuid) from payhold_ai;
