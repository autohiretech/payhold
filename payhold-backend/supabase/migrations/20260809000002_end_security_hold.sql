-- ---------------------------------------------------------------------------
-- §5.1: ending a destination's security hold, and making one hold read as one
-- ---------------------------------------------------------------------------
--
-- `add_seller_destination` stamps `security_hold_until` on every new row and
-- takes no argument that skips it — deliberately, because "get in, move the
-- destination, withdraw" is the shape of an account takeover and the hold is
-- what puts a person between the second step and the third. What the table
-- never had is the other half of that sentence: §5.1 says a new destination
-- "may require re-authentication or step-up verification **before use**", and
-- somebody satisfying that requirement had nothing to write it down with. The
-- hold could only expire.
--
-- That is a gap rather than a policy. A seller who rang up, answered the
-- step-up questions and had their new bank account confirmed still waited out
-- a timer, and an operator watching them wait had no way to record that the
-- check had been done. `verify_seller` was not it — that attests to identity,
-- sanctions and ownership, and it already stamps `verified_at`; the hold is the
-- separate claim that *this change* was the seller's own.
--
-- So `end_destination_hold` is the writer, and it is shaped like every other
-- attestation in this system: it takes a name, it is refused without one, it
-- writes an audit row against that person, and it refuses an API key at the
-- endpoint. A client that could end its own security holds from its own server
-- would have removed §5.1's change protection entirely, which is the same
-- sentence `POST /v1/sellers/:id/verify` is refused an API key for.
--
-- It moves no money and cannot: a destination out of its hold is still
-- unverified until somebody verifies it, still subject to the eligibility gate,
-- and still routed by `route_payout` under the payout's own lock. It ends one
-- of the reasons a payout is stopped, which is the same limited direction
-- invariant 11 allows a person to act in.
--
-- ## The inconsistency this had to fix to work at all
--
-- One hold was being read three ways. `seller_capabilities` and `route_payout`
-- read `seller_destinations.security_hold_until`; `screen_payout` re-derived a
-- window from `sellers.destination_changed_at` and the current
-- `destination_hold_hours`. Nothing kept them in step, and they answered
-- differently in both directions:
--
--   * lowering `destination_hold_hours` released the gate here while the
--     stamped expiry still blocked the route — a payout that screened clean and
--     then found no eligible destination
--   * ending the hold on the row would have done the same in reverse, which is
--     what made this function part of the change rather than a bystander
--
-- `screen_payout` now reads the stamp wherever there is one and falls back to
-- the old derivation where there is not. The fallback is not a transitional
-- kindness — `sellers_seed_primary_destination` writes no expiry, so a seller
-- whose primary was seeded at registration has only `destination_changed_at`
-- to go on and must keep the protection it gives them.
--
-- `create or replace` with an identical signature, so no `drop function` and no
-- sibling. The revoke is reissued below, because a recreated function is
-- granted to PUBLIC again — the trap `refund_deal` and `resolve_dispute` both
-- walked into in V2.

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
  v_primary       seller_destinations;
  in_hold         boolean;
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

  -- §5.1's change protection, read off the destination row wherever that row
  -- carries its own expiry and off the seller's timestamp where it does not.
  --
  -- The two used to be independent and were free to disagree.
  -- `add_seller_destination` stamps `security_hold_until` at insert from the
  -- setting as it stood then; this function re-derived a window from
  -- `sellers.destination_changed_at` and the setting as it stands now.
  -- `seller_capabilities` and `route_payout` both read the stamp, so the three
  -- readers of one fact could answer differently — and did: a seller was shown
  -- one reason on their own screen while the payout was stopped here by
  -- another, which is the failure returning every reason at once exists to
  -- prevent.
  --
  -- The stamp wins where it exists, because it is what every other reader
  -- already uses. The fallback is untouched and is what a primary seeded by
  -- `sellers_seed_primary_destination` still goes through — that trigger writes
  -- no expiry, so a seller whose destination moved before this migration keeps
  -- exactly the protection they had.
  hold_hours := setting_num(p.tenant_id, 'destination_hold_hours', 24)::integer;

  select * into v_primary
    from seller_destinations
   where seller_id = p.seller_id and is_primary;

  if v_primary.security_hold_until is not null then
    in_hold := v_primary.security_hold_until > now();
  else
    in_hold := s.destination_changed_at is not null
           and s.destination_changed_at > now() - make_interval(hours => hold_hours);
  end if;

  if in_hold then
    -- The same sentence `seller_capabilities` produces, so the gate and the
    -- screen a seller reads cannot describe one hold two ways.
    eligibility := coalesce(eligibility, '{}') || (
      case when v_primary.security_hold_until is not null then
        format('A new destination is in its security hold until %s',
               to_char(v_primary.security_hold_until, 'YYYY-MM-DD HH24:MI'))
      else
        format('The payout destination changed in the last %s hours', hold_hours)
      end)::text;
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

-- A recreated function is granted to PUBLIC by default, so the revoke that
-- `20260806000001` issued no longer covers this body. Reissued verbatim, plus
-- `payhold_ai` explicitly: the role postdates that migration, and invariant 9
-- is a grant list rather than a convention.
revoke all on function screen_payout(uuid) from public, anon, authenticated;
revoke all on function screen_payout(uuid) from payhold_ai;

-- ---------------------------------------------------------------------------
-- Ending one hold
-- ---------------------------------------------------------------------------
--
-- Idempotent, and deliberately silent when there is nothing to end: a hold that
-- already lapsed is not an error, and writing an audit row for a no-op would
-- put a person's name against a decision they did not get to make.
--
-- `security_hold_until` is set to `now()` rather than to null. Null means "this
-- destination never had a hold" to every reader, and this one did — an ended
-- hold and an expired one are the same fact going forward, and the row should
-- not claim the stronger thing. The original expiry goes in the audit row,
-- which is where "how much of it was skipped, and by whom" is answered.

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

  -- Tenant-scoped in the same statement as the lock, for the reason
  -- `add_seller_destination` locks the seller: this is the row a concurrent
  -- destination change is also writing.
  select * into d from seller_destinations
   where id = p_destination and tenant_id = p_tenant
     for update;

  if not found then
    raise exception 'not_found: destination % does not exist', p_destination
      using errcode = 'no_data_found';
  end if;

  if d.security_hold_until is null or d.security_hold_until <= now() then
    return d;
  end if;

  v_was := d.security_hold_until;

  update seller_destinations
     set security_hold_until = now()
   where id = d.id
  returning * into d;

  -- The mask, never the token. §19: the real destination exists nowhere on this
  -- side, and an audit log is where one would survive longest.
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
  'still outstanding afterwards.';

revoke all on function end_destination_hold(uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function end_destination_hold(uuid, uuid, text) from payhold_ai;
