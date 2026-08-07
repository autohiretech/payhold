-- ---------------------------------------------------------------------------
-- V2 §12 and §5.1: seller onboarding, KYC, and payout destinations
-- ---------------------------------------------------------------------------
--
-- §12's sentence is the whole of this migration: **"A seller must not receive a
-- payout solely because a payment webhook says 'success'."** Until now nothing
-- in this system could have refused one on those grounds, because nothing
-- recorded whether a seller had been verified at all.
--
-- ## The gate is not a risk rule
--
-- `screen_payout` already held payouts, but everything in it sits behind
-- `risk_rules_enabled`, because those rules are discretionary — arithmetic a
-- tenant may reasonably decide not to act on. Eligibility is not: a tenant that
-- switches the rules off must not thereby start paying sellers it has never
-- verified. So the checks added here run **first and unconditionally**, and the
-- setting governs only the rules that follow.
--
-- Invariant 11 is untouched. These checks hold a payout and can do nothing
-- else; `approve_payout_review` remains the only way out and still takes a
-- person's name.
--
-- ## Destinations move to their own table
--
-- §5.1 needs a seller to have a preferred destination and a verified backup,
-- which one pair of columns on `sellers` cannot express. `seller_destinations`
-- is the record from here on. `sellers.beneficiary_token` and
-- `masked_destination` stay for now as the primary's copy, kept in step by a
-- trigger with exactly one writer, because fifty call sites read them and
-- moving all of those belongs with the routing engine that will actually use
-- the table (Phase 5). They are documented as derived, and go when it lands.

-- ---------------------------------------------------------------------------
-- Who a seller is
-- ---------------------------------------------------------------------------

-- §12's state list, verbatim.
create type kyc_status as enum (
  'pending',
  'verified',
  'restricted',
  'rejected',
  'review_required'
);

alter table sellers
  add column kyc_status          kyc_status not null default 'pending',
  -- §11's `sellers.external user ID`: the client's own handle for this person.
  -- PayHold does not mint identities for sellers any more than it does for
  -- buyers.
  add column external_user_id    text,
  -- §12: sanctions screening. A timestamp rather than a boolean, because the
  -- question is not "were they ever screened" but "recently enough".
  add column sanctions_checked_at timestamptz,
  -- §12: beneficial-owner collection where applicable. Structure is the
  -- client's; we carry it for the record and read none of it.
  add column beneficial_owners   jsonb,
  -- §5.1's change protection. Stamped whenever the primary destination moves.
  add column destination_changed_at timestamptz;

-- Every seller that existed before this migration is grandfathered as verified.
--
-- That is a decision, not a default: this system has never taken live money, so
-- there is no unverified seller in it to catch. Leaving them `pending` would
-- hold every payout in every fixture and demo for a fact that is not true of
-- them. Sellers created from here on start `pending`, which is what makes the
-- §15 phase-5 acceptance test mean something.
update sellers set kyc_status = 'verified' where kyc_status = 'pending';

create index sellers_kyc_idx on sellers(tenant_id, kyc_status);

-- ---------------------------------------------------------------------------
-- Where a seller gets paid — §5.1
-- ---------------------------------------------------------------------------

create table seller_destinations (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants(id) on delete cascade,
  seller_id           uuid not null references sellers(id) on delete cascade,
  label               text,
  country             country_code not null,
  payout_currency     currency_code not null,
  payout_provider     payout_provider not null,
  -- Provider-side token. PayHold never stores the real destination — §19.
  beneficiary_token   text not null,
  masked_destination  text not null,
  /**
   * §5.1's routing priority. The seller's preferred destination is tried first;
   * the backup is used only after a failed primary payout and an explicit
   * policy check, which is Phase 5's routing engine.
   */
  is_primary          boolean not null default false,
  is_backup           boolean not null default false,
  /** §5.1 verification: ownership confirmed. Null means it has not been. */
  verified_at         timestamptz,
  /**
   * §5.1 change protection: "a newly added payout destination enters a short
   * security hold". Not enforced by refusing to store it — enforced by
   * `screen_payout`, so the money waits for a person rather than vanishing.
   */
  security_hold_until timestamptz,
  created_at          timestamptz not null default now(),

  -- Primary and backup are roles, not both at once.
  constraint destination_is_one_role check (not (is_primary and is_backup))
);

create index seller_destinations_seller_idx on seller_destinations(seller_id);
create index seller_destinations_tenant_idx on seller_destinations(tenant_id);

-- One primary and one backup per seller. §5.1 says "a" preferred destination
-- and "a" secondary, and two of either is a routing decision nobody made.
create unique index seller_destinations_one_primary
  on seller_destinations(seller_id) where is_primary;
create unique index seller_destinations_one_backup
  on seller_destinations(seller_id) where is_backup;

alter table seller_destinations enable row level security;

create policy seller_destinations_read on seller_destinations
  for select to authenticated
  using (tenant_id in (select current_tenant_ids()) or is_platform_admin());

grant select on seller_destinations to authenticated;

-- Backfill: every existing seller's one destination becomes their primary, and
-- is verified for the same reason their KYC is.
insert into seller_destinations (
  tenant_id, seller_id, label, country, payout_currency, payout_provider,
  beneficiary_token, masked_destination, is_primary, verified_at, created_at
)
select
  s.tenant_id, s.id, 'Primary', s.country, s.payout_currency, s.payout_provider,
  s.beneficiary_token, s.masked_destination, true, s.created_at, s.created_at
from sellers s;

-- ---------------------------------------------------------------------------
-- The compatibility copy, with one writer
-- ---------------------------------------------------------------------------
--
-- `sellers.beneficiary_token` and `masked_destination` are now **derived** from
-- the primary destination. A trigger is the only thing that writes them, so the
-- two cannot disagree — which is the property that matters while both exist.
--
-- `destination_changed_at` is stamped here rather than by the endpoint, for the
-- same reason `enqueue_webhooks` is a trigger: a security hold that every
-- future code path has to remember to arm is one that will eventually be armed
-- by none of them.

create or replace function sync_primary_destination() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prev text;
begin
  if not new.is_primary then
    return new;
  end if;

  select beneficiary_token into v_prev from sellers where id = new.seller_id;

  update sellers
     set beneficiary_token  = new.beneficiary_token,
         masked_destination = new.masked_destination,
         payout_currency    = new.payout_currency,
         payout_provider    = new.payout_provider,
         -- Only when it actually moved. Re-saving the same destination is not
         -- a change, and stamping it would hold a payout for nothing.
         destination_changed_at = case
           when v_prev is distinct from new.beneficiary_token then now()
           else destination_changed_at
         end
   where id = new.seller_id;

  return new;
end;
$$;

create trigger seller_destinations_sync_primary
  after insert or update on seller_destinations
  for each row execute function sync_primary_destination();

-- ---------------------------------------------------------------------------
-- Can this seller be paid, and if not, why — §10.1
-- ---------------------------------------------------------------------------
--
-- The same questions `screen_payout` asks, asked ahead of time so a client can
-- show a seller what is missing instead of discovering it when a payout stops.
-- Read-only and side-effect free, which is why it is safe to expose.

create or replace function seller_capabilities(p_seller uuid)
returns table (
  can_receive_payouts boolean,
  kyc_status          kyc_status,
  reasons             text[]
)
language plpgsql
stable
as $$
declare
  s        sellers;
  v_reason text[] := '{}';
  v_dest   seller_destinations;
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
  end if;

  return query select
    array_length(v_reason, 1) is null,
    s.kyc_status,
    v_reason;
end;
$$;

grant execute on function seller_capabilities(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The payout worker re-checks — §12
-- ---------------------------------------------------------------------------
--
-- Everything up to `cfg_enabled` is the eligibility gate and runs whatever the
-- tenant has set. Everything after it is V1's discretionary rules, unchanged.

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
begin
  select * into p from payouts where id = p_payout_id for update;

  if not found then
    raise exception 'not_found: payout % does not exist', p_payout_id
      using errcode = 'no_data_found';
  end if;

  -- Already looked at by a person: their decision stands. Re-running the rules
  -- would let a rule overrule the human who overruled it.
  if p.review_approved_at is not null then
    return false;
  end if;

  select * into d from deals where id = p.deal_id;
  select * into s from sellers where id = p.seller_id;

  -- -------------------------------------------------------------------------
  -- Eligibility — §12. Not behind `risk_rules_enabled`, deliberately.
  -- -------------------------------------------------------------------------

  select reasons into eligibility from seller_capabilities(p.seller_id);

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

  -- §8: a dispute freezes payout. `settle_payout` refuses one under the lock;
  -- holding here means an operator sees it as a queue rather than as an error.
  if d.status = 'disputed' then
    eligibility := coalesce(eligibility, '{}') || 'The deal is disputed'::text;
  end if;

  if array_length(eligibility, 1) is not null then
    insert into risk_signals (tenant_id, deal_id, seller_id, signal, severity, value, explanation)
    values (
      p.tenant_id, p.deal_id, p.seller_id, 'not_eligible', 'review',
      jsonb_build_object('reasons', to_jsonb(eligibility), 'kyc_status', s.kyc_status),
      format('This seller cannot be paid yet: %s.', array_to_string(eligibility, '; '))
    );

    update payouts
       set status = 'held_for_review',
           review_held_at = now()
     where id = p.id;

    perform write_audit(p.tenant_id, p.deal_id, 'system', 'payout.held_for_review',
      jsonb_build_object('payout_id', p.id, 'eligibility', to_jsonb(eligibility)));

    return true;
  end if;

  -- -------------------------------------------------------------------------
  -- The discretionary rules — V1's, and still governed by the setting
  -- -------------------------------------------------------------------------

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

revoke all on function sync_primary_destination() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- A seller is created with their destination, or not at all
-- ---------------------------------------------------------------------------
--
-- `POST /v1/sellers` takes one destination and writes one row, and every test
-- fixture does the same. Without this, every seller created after this
-- migration would have no `seller_destinations` row and would be unpayable for
-- a reason nobody had chosen — the table would be the record in name only.
--
-- A trigger rather than a line in the endpoint, for the reason `enqueue_webhooks`
-- is one: the endpoint is not the only thing that inserts a seller, and a rule
-- every insert path must remember is a rule that gets forgotten by the next one.
--
-- It does not fire on update, so moving a destination is a `seller_destinations`
-- write and goes through the security hold. That asymmetry is the point.

create or replace function seed_primary_destination() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into seller_destinations (
    tenant_id, seller_id, label, country, payout_currency, payout_provider,
    beneficiary_token, masked_destination, is_primary
  )
  values (
    new.tenant_id, new.id, 'Primary', new.country, new.payout_currency,
    new.payout_provider, new.beneficiary_token, new.masked_destination, true
  );

  return new;
end;
$$;

create trigger sellers_seed_primary_destination
  after insert on sellers
  for each row execute function seed_primary_destination();

revoke all on function seed_primary_destination() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Marking a seller verified — §12
-- ---------------------------------------------------------------------------
--
-- The identity check, the sanctions screen and the ownership check are all
-- somebody else's work: a KYC provider's, a sanctions list's, a micro-deposit's.
-- This is where the answer is recorded, and it takes the name of whoever is
-- attesting to it for the same reason `approve_payout_review` does — a
-- verification with no one behind it is a row, not a decision.
--
-- It is one function rather than three columns to update, because the three
-- travel together: a seller verified without a sanctions date, or with an
-- unverified destination, is still unpayable and the caller would have to know
-- that to get it right.

create or replace function verify_seller(
  p_seller   uuid,
  p_actor    text,
  p_verified boolean default true
) returns sellers
language plpgsql
security definer
set search_path = public
as $$
declare
  s sellers;
begin
  if p_actor is null or btrim(p_actor) = '' then
    raise exception 'policy_violation: a verification must record who made it'
      using errcode = 'check_violation';
  end if;

  update sellers
     set kyc_status = case when p_verified then 'verified'::kyc_status
                           else 'review_required'::kyc_status end,
         sanctions_checked_at = case when p_verified then now() else sanctions_checked_at end
   where id = p_seller
  returning * into s;

  if not found then
    raise exception 'not_found: seller % does not exist', p_seller
      using errcode = 'no_data_found';
  end if;

  if p_verified then
    update seller_destinations
       set verified_at = coalesce(verified_at, now())
     where seller_id = p_seller and is_primary;
  end if;

  perform write_audit(s.tenant_id, null, p_actor,
    case when p_verified then 'seller.verified' else 'seller.review_required' end,
    jsonb_build_object('seller_id', s.id, 'name', s.name));

  return s;
end;
$$;

revoke all on function verify_seller(uuid, text, boolean) from public, anon, authenticated;
