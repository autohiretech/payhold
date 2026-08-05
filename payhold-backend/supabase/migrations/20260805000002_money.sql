-- Money functions.
--
-- Everything that moves money lives here rather than in TypeScript, because
-- the invariants the spec demands are transactional ones. `SELECT ... FOR
-- UPDATE` around the both-confirmations check (§6) is only meaningful inside
-- the transaction that then writes the release; an Edge Function that reads,
-- decides, and writes over three round trips has a race between every pair.
--
-- The division of labour: TypeScript owns FX rates, fee policy and provider
-- calls; SQL owns atomicity, guards, and the ledger. Converted figures are
-- passed in already computed, so there is exactly one FX table in the system
-- and it is not this one.
--
-- All of these are `security definer` and revoked from anon/authenticated:
-- they are reachable only by the service role, i.e. only from Edge Functions.

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------

-- Settings are key/value jsonb so §11.4 stays a dashboard edit. This resolves
-- one key with a default, so a tenant missing a row behaves like the spec's
-- documented default rather than failing.
create or replace function setting_num(p_tenant uuid, p_key text, p_default numeric)
returns numeric
language sql
stable
as $$
  select coalesce((select (value #>> '{}')::numeric from settings
                   where tenant_id = p_tenant and key = p_key), p_default);
$$;

-- ---------------------------------------------------------------------------
-- Balances — derived from the ledger, never stored
-- ---------------------------------------------------------------------------

-- Four buckets per rail and currency, computed entirely from ledger entries:
--
--   held            hold + release + refund   (nets to zero once settled)
--   clearing pool   −release − fee − payout   (what the seller is owed)
--   split of that   by each deal's payout_due_at: due → available, else pending
--   paid_out        the payout entries, unsigned
--
-- Security deposits are excluded. They are the buyer's money held against
-- damage, not part of the tenant's balance.
--
-- Attribution is to the rail recorded on the ENTRIES, not on the deal: a
-- deal's provider changes when the buyer picks their method, and the ledger is
-- the record of where the money actually went.
create or replace function rail_balances(p_tenant uuid)
returns table (
  provider           provider,
  currency           currency_code,
  held               bigint,
  pending_clearance  bigint,
  available          bigint,
  paid_out           bigint
)
language sql
stable
as $$
  with per_deal as (
    select
      l.deal_id,
      -- The rail and currency of the deal's first entry: the hold that
      -- started it. Later entries follow the same rail by construction.
      (array_agg(l.provider order by l.created_at, l.id))[1] as provider,
      (array_agg(l.currency order by l.created_at, l.id))[1] as currency,
      coalesce(sum(l.amount) filter (
        where l.entry_type in ('hold', 'release', 'refund')), 0) as held,
      coalesce(sum(
        case l.entry_type
          when 'release' then -l.amount
          when 'fee'     then  l.amount
          when 'payout'  then  l.amount
          else 0
        end), 0) as clearing,
      coalesce(-sum(l.amount) filter (where l.entry_type = 'payout'), 0) as paid,
      max(d.payout_due_at) as payout_due_at
    from ledger l
    join deals d on d.id = l.deal_id
    where l.tenant_id = p_tenant
      and l.deal_id is not null
    group by l.deal_id
  )
  select
    p.provider,
    p.currency,
    sum(p.held)::bigint,
    -- `filter` yields NULL when no row matches, and a balance of NULL is not a
    -- balance. Every bucket coalesces to zero so the four always add up.
    coalesce(sum(p.clearing) filter (
      where p.payout_due_at is null or p.payout_due_at > now()), 0)::bigint,
    coalesce(sum(p.clearing) filter (
      where p.payout_due_at is not null and p.payout_due_at <= now()), 0)::bigint,
    sum(p.paid)::bigint
  from per_deal p
  group by p.provider, p.currency
  -- Cast to text so rails sort alphabetically rather than by the order the
  -- enum happens to declare them, matching what the dashboard shows.
  order by p.provider::text, p.currency;
$$;

-- The same buckets summed across rails. Note this is NOT the reconciliation
-- view: reconciliation compares each provider's rows separately, because
-- "held" is never one pot.
create or replace function tenant_balances(p_tenant uuid)
returns table (
  currency           currency_code,
  held               bigint,
  pending_clearance  bigint,
  available          bigint,
  paid_out           bigint
)
language sql
stable
as $$
  select
    r.currency,
    sum(r.held)::bigint,
    sum(r.pending_clearance)::bigint,
    sum(r.available)::bigint,
    sum(r.paid_out)::bigint
  from rail_balances(p_tenant) r
  group by r.currency
  order by r.currency;
$$;

-- ---------------------------------------------------------------------------
-- Internal write helpers
-- ---------------------------------------------------------------------------

create or replace function write_audit(
  p_tenant   uuid,
  p_deal     uuid,
  p_actor    text,
  p_action   text,
  p_details  jsonb default '{}'::jsonb
) returns void
language sql
as $$
  insert into audit_log (tenant_id, deal_id, actor, action, details)
  values (p_tenant, p_deal, p_actor, p_action, p_details);
$$;

-- Every ledger write goes through here so an entry can never be booked against
-- a currency or rail that disagrees with the deal it belongs to.
create or replace function write_ledger(
  p_deal    deals,
  p_type    ledger_entry_type,
  p_amount  bigint
) returns void
language sql
as $$
  insert into ledger (tenant_id, deal_id, entry_type, amount, currency, provider, provider_ref)
  values (
    p_deal.tenant_id,
    p_deal.id,
    p_type,
    p_amount,
    -- The currency that actually landed in the provider balance.
    p_deal.presentment_currency,
    p_deal.provider,
    p_deal.provider_ref
  );
$$;

-- Has this deal's security deposit already been settled either way?
create or replace function deposit_settled(p_deal uuid)
returns boolean
language sql
stable
as $$
  select exists (
    select 1 from ledger
    where deal_id = p_deal
      and entry_type in ('deposit_capture', 'deposit_release')
  );
$$;

-- ---------------------------------------------------------------------------
-- Release — the atomic step
-- ---------------------------------------------------------------------------

-- Called only when both confirmations are believed present. It re-checks that
-- under a row lock, so two concurrent confirms racing to be second produce
-- exactly one release.
--
-- p_payout_amount / p_payout_currency are what the SELLER receives, already
-- converted by the caller. p_fee_presentment is the fee expressed in the
-- currency actually collected, likewise pre-converted.
create or replace function release_deal(
  p_deal_id          uuid,
  p_payout_amount    bigint,
  p_payout_currency  currency_code,
  p_fee_presentment  bigint
) returns deals
language plpgsql
security definer
set search_path = public
as $$
declare
  d               deals;
  v_clearance     integer;
  v_released_at   timestamptz := now();
  v_has_buyer     boolean;
  v_has_seller    boolean;
begin
  -- The lock. Everything below is safe only because of this line.
  select * into d from deals where id = p_deal_id for update;

  if not found then
    raise exception 'not_found: deal % does not exist', p_deal_id
      using errcode = 'no_data_found';
  end if;

  -- Idempotent: releasing twice is a no-op, not an error (§6).
  if d.status in ('released', 'paid_out') then
    return d;
  end if;

  if d.status = 'refunded' then
    raise exception 'invalid_state: deal % was refunded and cannot be released', p_deal_id
      using errcode = 'check_violation';
  end if;

  -- Re-verify under the lock. The caller's check was advisory; this one counts.
  select
    exists (select 1 from confirmations where deal_id = d.id and side = 'buyer'),
    exists (select 1 from confirmations where deal_id = d.id and side = 'seller')
  into v_has_buyer, v_has_seller;

  if not (v_has_buyer and v_has_seller) then
    raise exception 'invalid_state: release requires both confirmations'
      using errcode = 'check_violation';
  end if;

  v_clearance := setting_num(d.tenant_id, 'clearance_days', 7)::integer;

  update deals
     set status        = 'released',
         released_at   = v_released_at,
         payout_due_at = v_released_at + make_interval(days => v_clearance)
   where id = d.id
  returning * into d;

  -- Money out of the hold, fee taken, deposit returned if it was never settled.
  perform write_ledger(d, 'release', -d.presentment_amount);
  perform write_ledger(d, 'fee', -p_fee_presentment);

  if d.deposit_amount is not null and not deposit_settled(d.id) then
    perform write_ledger(d, 'deposit_release', -d.deposit_amount);
  end if;

  -- One payout per deal, enforced by payouts_deal_key. `on conflict do
  -- nothing` makes a retried release idempotent rather than a constraint error.
  insert into payouts (tenant_id, deal_id, seller_id, amount, currency, status, scheduled_for)
  values (d.tenant_id, d.id, d.seller_id, p_payout_amount, p_payout_currency,
          'scheduled', d.payout_due_at)
  on conflict (deal_id) do nothing;

  perform write_audit(d.tenant_id, d.id, 'system', 'deal.released', jsonb_build_object(
    'fee_amount', d.fee_amount,
    'net', p_payout_amount,
    'paid_in', p_payout_currency
  ));

  return d;
end;
$$;

-- ---------------------------------------------------------------------------
-- Confirm — records one side, releases when that completes the pair
-- ---------------------------------------------------------------------------

create or replace function confirm_deal(
  p_deal_id          uuid,
  p_side             confirm_side,
  p_actor            confirm_actor,
  p_payout_amount    bigint,
  p_payout_currency  currency_code,
  p_fee_presentment  bigint
) returns deals
language plpgsql
security definer
set search_path = public
as $$
declare
  d             deals;
  v_has_buyer   boolean;
  v_has_seller  boolean;
begin
  select * into d from deals where id = p_deal_id for update;

  if not found then
    raise exception 'not_found: deal % does not exist', p_deal_id
      using errcode = 'no_data_found';
  end if;

  if d.status = 'disputed' then
    raise exception 'invalid_state: deal is disputed — resolve the dispute before confirming'
      using errcode = 'check_violation';
  end if;

  if d.status not in ('funded_held', 'confirmed_buyer', 'confirmed_seller') then
    raise exception 'invalid_state: deal % is % and can no longer be confirmed', p_deal_id, d.status
      using errcode = 'check_violation';
  end if;

  -- Confirming twice from the same side is a no-op, not an error.
  insert into confirmations (deal_id, side, actor)
  values (d.id, p_side, p_actor)
  on conflict (deal_id, side) do nothing;

  if found then
    perform write_audit(
      d.tenant_id, d.id,
      case when p_actor = 'auto' then 'system' else 'user:' || p_side end,
      'deal.confirmed_' || p_side,
      jsonb_build_object('actor', p_actor)
    );
  end if;

  select
    exists (select 1 from confirmations where deal_id = d.id and side = 'buyer'),
    exists (select 1 from confirmations where deal_id = d.id and side = 'seller')
  into v_has_buyer, v_has_seller;

  if v_has_buyer and v_has_seller then
    return release_deal(p_deal_id, p_payout_amount, p_payout_currency, p_fee_presentment);
  end if;

  update deals
     set status = (case when v_has_buyer then 'confirmed_buyer' else 'confirmed_seller' end)::deal_status
   where id = d.id
  returning * into d;

  return d;
end;
$$;

-- ---------------------------------------------------------------------------
-- Refund
-- ---------------------------------------------------------------------------

create or replace function refund_deal(
  p_deal_id  uuid,
  p_reason   text,
  p_actor    text default 'dashboard'
) returns deals
language plpgsql
security definer
set search_path = public
as $$
declare
  d deals;
begin
  select * into d from deals where id = p_deal_id for update;

  if not found then
    raise exception 'not_found: deal % does not exist', p_deal_id
      using errcode = 'no_data_found';
  end if;

  if d.status in ('released', 'paid_out') then
    raise exception 'policy_violation: funds have already been released — refund is no longer possible'
      using errcode = 'check_violation';
  end if;

  -- Idempotent.
  if d.status = 'refunded' then
    return d;
  end if;

  if d.status = 'created' then
    raise exception 'invalid_state: nothing has been collected to refund'
      using errcode = 'check_violation';
  end if;

  update deals set status = 'refunded' where id = d.id returning * into d;

  perform write_ledger(d, 'refund', -d.presentment_amount);

  if d.deposit_amount is not null and not deposit_settled(d.id) then
    perform write_ledger(d, 'deposit_release', -d.deposit_amount);
  end if;

  perform write_audit(d.tenant_id, d.id, p_actor, 'deal.refunded',
                      jsonb_build_object('reason', p_reason));

  return d;
end;
$$;

-- ---------------------------------------------------------------------------
-- Payout dispatch
-- ---------------------------------------------------------------------------

-- Marks a payout paid and debits the vault. The provider transfer itself
-- happens in the Edge Function BEFORE this is called; this is the bookkeeping
-- half, kept transactional so a payout can never be booked twice.
--
-- p_leaving is what actually departs our balance, in the currency we hold —
-- the seller receives payouts.amount in theirs.
create or replace function settle_payout(
  p_payout_id    uuid,
  p_leaving      bigint,
  p_provider_ref text
) returns payouts
language plpgsql
security definer
set search_path = public
as $$
declare
  p  payouts;
  d  deals;
begin
  select * into p from payouts where id = p_payout_id for update;

  if not found then
    raise exception 'not_found: payout % does not exist', p_payout_id
      using errcode = 'no_data_found';
  end if;

  if p.status = 'paid' then
    return p;
  end if;

  select * into d from deals where id = p.deal_id for update;

  -- The balance guard the spec demands: a payout may never exceed the tenant's
  -- available balance, checked inside the same transaction that books it.
  if p_leaving > (
    select coalesce(available, 0) from rail_balances(p.tenant_id)
    where provider = d.provider and currency = d.presentment_currency
  ) then
    raise exception 'insufficient_balance: payout of % exceeds available balance on % %',
      p_leaving, d.provider, d.presentment_currency
      using errcode = 'check_violation';
  end if;

  update payouts
     set status = 'paid',
         paid_at = now(),
         failure_reason = null,
         attempts = attempts + 1,
         provider_ref = p_provider_ref
   where id = p.id
  returning * into p;

  perform write_ledger(d, 'payout', -p_leaving);

  update deals set status = 'paid_out' where id = d.id;

  perform write_audit(p.tenant_id, p.deal_id, 'system', 'payout.paid', jsonb_build_object(
    'amount', p.amount,
    'currency', p.currency,
    'seller_id', p.seller_id
  ));

  return p;
end;
$$;

create or replace function fail_payout(p_payout_id uuid, p_reason text)
returns payouts
language plpgsql
security definer
set search_path = public
as $$
declare
  p payouts;
begin
  update payouts
     set status = 'failed',
         failure_reason = p_reason,
         attempts = attempts + 1
   where id = p_payout_id and status <> 'paid'
  returning * into p;

  if not found then
    raise exception 'invalid_state: payout % is missing or already paid', p_payout_id
      using errcode = 'check_violation';
  end if;

  perform write_audit(p.tenant_id, p.deal_id, 'system', 'payout.failed', jsonb_build_object(
    'reason', p_reason,
    'attempts', p.attempts
  ));

  return p;
end;
$$;

create or replace function freeze_payout(p_payout_id uuid)
returns payouts
language plpgsql
security definer
set search_path = public
as $$
declare
  p payouts;
begin
  update payouts set status = 'frozen' where id = p_payout_id and status <> 'paid'
  returning * into p;

  if not found then
    raise exception 'invalid_state: payout % is missing or already paid', p_payout_id
      using errcode = 'check_violation';
  end if;

  perform write_audit(p.tenant_id, p.deal_id, 'system', 'payout.frozen', jsonb_build_object(
    'reason', 'Tenant payouts are frozen pending reconciliation'
  ));

  return p;
end;
$$;

-- ---------------------------------------------------------------------------
-- Deposits (card pre-auth)
-- ---------------------------------------------------------------------------

create or replace function capture_deposit(p_deal_id uuid, p_amount bigint)
returns deals
language plpgsql
security definer
set search_path = public
as $$
declare
  d deals;
begin
  select * into d from deals where id = p_deal_id for update;

  if not found then
    raise exception 'not_found: deal % does not exist', p_deal_id
      using errcode = 'no_data_found';
  end if;

  if d.deposit_amount is null then
    raise exception 'invalid_state: this deal has no security deposit'
      using errcode = 'check_violation';
  end if;

  if deposit_settled(d.id) then
    raise exception 'invalid_state: the deposit has already been settled'
      using errcode = 'check_violation';
  end if;

  if p_amount <= 0 or p_amount > d.deposit_amount then
    raise exception 'policy_violation: capture must be between 1 and the held deposit of %',
      d.deposit_amount
      using errcode = 'check_violation';
  end if;

  perform write_ledger(d, 'deposit_capture', p_amount);

  -- Anything not captured goes straight back to the buyer.
  if p_amount < d.deposit_amount then
    perform write_ledger(d, 'deposit_release', -(d.deposit_amount - p_amount));
  end if;

  perform write_audit(d.tenant_id, d.id, 'dashboard', 'deposit.captured',
                      jsonb_build_object('amount', p_amount));

  update deals set updated_at = now() where id = d.id returning * into d;
  return d;
end;
$$;

create or replace function release_deposit(p_deal_id uuid)
returns deals
language plpgsql
security definer
set search_path = public
as $$
declare
  d deals;
begin
  select * into d from deals where id = p_deal_id for update;

  if not found then
    raise exception 'not_found: deal % does not exist', p_deal_id
      using errcode = 'no_data_found';
  end if;

  if d.deposit_amount is null then
    raise exception 'invalid_state: this deal has no security deposit'
      using errcode = 'check_violation';
  end if;

  if deposit_settled(d.id) then
    raise exception 'invalid_state: the deposit has already been settled'
      using errcode = 'check_violation';
  end if;

  perform write_ledger(d, 'deposit_release', -d.deposit_amount);
  perform write_audit(d.tenant_id, d.id, 'dashboard', 'deposit.released',
                      jsonb_build_object('amount', d.deposit_amount));

  update deals set updated_at = now() where id = d.id returning * into d;
  return d;
end;
$$;

-- ---------------------------------------------------------------------------
-- Disputes
-- ---------------------------------------------------------------------------

create or replace function open_dispute(
  p_deal_id    uuid,
  p_raised_by  confirm_side,
  p_reason     text
) returns disputes
language plpgsql
security definer
set search_path = public
as $$
declare
  d    deals;
  dsp  disputes;
begin
  select * into d from deals where id = p_deal_id for update;

  if not found then
    raise exception 'not_found: deal % does not exist', p_deal_id
      using errcode = 'no_data_found';
  end if;

  if d.status not in ('funded_held', 'confirmed_buyer', 'confirmed_seller', 'disputed') then
    raise exception 'invalid_state: a deal in % cannot be disputed', d.status
      using errcode = 'check_violation';
  end if;

  insert into disputes (tenant_id, deal_id, raised_by, reason)
  values (d.tenant_id, d.id, p_raised_by, p_reason)
  returning * into dsp;

  update deals set status = 'disputed' where id = d.id;

  perform write_audit(d.tenant_id, d.id, 'user:' || p_raised_by, 'deal.disputed',
                      jsonb_build_object('reason', p_reason));

  return dsp;
end;
$$;

-- Staff resolution stands in for the parties: both sides are recorded as
-- confirmed by the system, then the normal release path runs. Resolving to
-- refund takes the normal refund path. Neither route bypasses the ledger.
create or replace function resolve_dispute(
  p_dispute_id       uuid,
  p_resolution       text,
  p_note             text,
  p_payout_amount    bigint,
  p_payout_currency  currency_code,
  p_fee_presentment  bigint
) returns disputes
language plpgsql
security definer
set search_path = public
as $$
declare
  dsp  disputes;
  d    deals;
begin
  select * into dsp from disputes where id = p_dispute_id for update;

  if not found then
    raise exception 'not_found: dispute % does not exist', p_dispute_id
      using errcode = 'no_data_found';
  end if;

  if dsp.status <> 'open' then
    raise exception 'invalid_state: this dispute is already resolved'
      using errcode = 'check_violation';
  end if;

  select * into d from deals where id = dsp.deal_id for update;

  if p_resolution = 'release' then
    -- Back out of `disputed` so the release guard sees a normal held deal.
    update deals set status = 'funded_held' where id = d.id;

    insert into confirmations (deal_id, side, actor)
    values (d.id, 'buyer', 'auto'), (d.id, 'seller', 'auto')
    on conflict (deal_id, side) do nothing;

    perform release_deal(d.id, p_payout_amount, p_payout_currency, p_fee_presentment);
    dsp.status := 'resolved_released';
  elsif p_resolution = 'refund' then
    update deals set status = 'funded_held' where id = d.id;
    perform refund_deal(d.id, 'Dispute resolved in buyer''s favour: ' || p_note, 'payhold-staff');
    dsp.status := 'resolved_refunded';
  else
    raise exception 'policy_violation: resolution must be release or refund'
      using errcode = 'check_violation';
  end if;

  update disputes
     set status = dsp.status,
         resolved_at = now(),
         resolution_note = p_note
   where id = dsp.id
  returning * into dsp;

  perform write_audit(d.tenant_id, d.id, 'payhold-staff', 'dispute.resolved',
                      jsonb_build_object('resolution', p_resolution, 'note', p_note));

  return dsp;
end;
$$;

-- ---------------------------------------------------------------------------
-- Nothing but the service role may call these
-- ---------------------------------------------------------------------------

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'release_deal(uuid, bigint, currency_code, bigint)',
    'confirm_deal(uuid, confirm_side, confirm_actor, bigint, currency_code, bigint)',
    'refund_deal(uuid, text, text)',
    'settle_payout(uuid, bigint, text)',
    'fail_payout(uuid, text)',
    'freeze_payout(uuid)',
    'capture_deposit(uuid, bigint)',
    'release_deposit(uuid)',
    'open_dispute(uuid, confirm_side, text)',
    'resolve_dispute(uuid, text, text, bigint, currency_code, bigint)',
    'write_audit(uuid, uuid, text, text, jsonb)',
    'write_ledger(deals, ledger_entry_type, bigint)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
  end loop;
end;
$$;
