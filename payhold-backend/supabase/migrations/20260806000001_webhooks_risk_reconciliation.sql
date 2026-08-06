-- Outbound signed webhooks, deterministic risk rules, and the reconciliation
-- pass — the three gaps between the schema and the product's feature list.
--
-- The acceptance spec for all of it is the dashboard mock:
--   payhold-dashboard/src/api/mock/webhooks.test.ts
--   payhold-dashboard/src/api/mock/risk.test.ts
--   payhold-dashboard/src/api/mock/reconciliation.test.ts
--
-- One structural decision worth stating up front. Webhook enqueue happens in
-- TRIGGERS on the tables the money functions already write, not by editing
-- those functions. Two reasons:
--
--   1. The alternative is restating nine `create or replace function` bodies to
--      add one line to each, and every future change to those functions then
--      has to remember the notification.
--   2. A trigger cannot be forgotten by a new code path. Any writer that moves
--      a deal to `released` emits `deal.released`, including a manual
--      correction run by a person at 2am.
--
-- It costs explicitness: reading `release_deal` no longer tells you a
-- notification goes out. That is what this comment and the trigger names are
-- for. Enqueue is still inside the same transaction as the state change, which
-- is the property that actually matters — a release that committed without
-- queueing its notification would leave a client's site permanently wrong.

-- ---------------------------------------------------------------------------
-- Payout review — a rule may stop a payout; only a person releases one
-- ---------------------------------------------------------------------------

alter type payout_status add value if not exists 'held_for_review';

alter table payouts
  add column if not exists review_held_at      timestamptz,
  add column if not exists review_approved_by  text,
  add column if not exists review_approved_at  timestamptz;

comment on column payouts.review_held_at is
  'When a deterministic risk rule stopped this payout. The rules that fired are in risk_signals.';
comment on column payouts.review_approved_by is
  'Who overrode the hold. Rules hold; people release.';

-- ---------------------------------------------------------------------------
-- Risk signals — spec §12.3
-- ---------------------------------------------------------------------------

create type risk_severity as enum ('info', 'review');

-- What the rules noticed, whether or not they stopped anything.
--
-- `info` rows exist because this is the labelled history a fraud model of our
-- own trains on later (§12.4), and it cannot be backfilled: a signal nobody
-- recorded at the time is gone. Recording is therefore NOT conditional on the
-- tenant having the rules switched on — that setting governs whether a payout
-- is held, not whether we look.
create table risk_signals (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  deal_id     uuid not null references deals(id) on delete cascade,
  seller_id   uuid references sellers(id) on delete set null,
  signal      text not null,
  severity    risk_severity not null default 'info',
  -- The numbers the rule fired on. This is what makes a hold checkable rather
  -- than something an operator has to take on trust.
  value       jsonb not null default '{}'::jsonb,
  explanation text not null,
  created_at  timestamptz not null default now()
);

create index risk_signals_tenant_idx on risk_signals(tenant_id, created_at desc);
create index risk_signals_deal_idx on risk_signals(deal_id);

-- ---------------------------------------------------------------------------
-- Webhook deliveries — the queue, not just the log
-- ---------------------------------------------------------------------------

create type webhook_delivery_status as enum ('pending', 'delivered', 'failed');

alter table webhook_deliveries
  add column if not exists status          webhook_delivery_status not null default 'pending',
  -- The exact bytes that were signed and sent. Signing an object and
  -- serialising it again on the way out can reorder keys, and then every
  -- delivery fails verification on the client's side while looking fine here.
  add column if not exists body            text,
  add column if not exists signature       text,
  add column if not exists next_attempt_at timestamptz default now();

create index webhook_deliveries_due_idx on webhook_deliveries(next_attempt_at)
  where status = 'pending';
create index webhook_deliveries_tenant_idx on webhook_deliveries(tenant_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Enqueue — one row per live endpoint, inside the caller's transaction
-- ---------------------------------------------------------------------------

-- The body is written here; the signature is not. Signing needs the endpoint's
-- decrypted secret, which lives in an Edge Function, and the timestamp has to
-- be the moment of SENDING rather than of queueing — a client that rejects
-- stale timestamps (which they should) would refuse every retry otherwise.
create or replace function enqueue_webhooks(
  p_tenant  uuid,
  p_deal    uuid,
  p_event   text,
  p_data    jsonb default '{}'::jsonb
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  e record;
  payload jsonb;
begin
  payload := jsonb_build_object(
    'event', p_event,
    'deal_id', p_deal,
    'occurred_at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'data', p_data
  );

  for e in
    select id from webhook_endpoints
    where tenant_id = p_tenant and disabled_at is null
  loop
    insert into webhook_deliveries (
      endpoint_id, tenant_id, deal_id, event, payload, body, status, next_attempt_at
    )
    values (e.id, p_tenant, p_deal, p_event, payload, payload::text, 'pending', now());
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Triggers that emit
-- ---------------------------------------------------------------------------

-- Deal status transitions. The event names match the audit actions rather than
-- inventing a second vocabulary: a client reading their logs beside ours should
-- see the same words.
create or replace function emit_deal_event() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status is not distinct from old.status then
    return new;
  end if;

  case new.status
    when 'funded_held' then
      perform enqueue_webhooks(new.tenant_id, new.id, 'deal.funded_held', jsonb_build_object(
        'amount', new.amount,
        'currency', new.currency,
        'presentment_amount', new.presentment_amount,
        'presentment_currency', new.presentment_currency,
        'payment_method', new.payment_method,
        'auto_release_at', new.auto_release_at
      ));
    when 'released' then
      perform enqueue_webhooks(new.tenant_id, new.id, 'deal.released', jsonb_build_object(
        'fee_amount', new.fee_amount,
        'net', new.amount - new.fee_amount,
        'payout_due_at', new.payout_due_at
      ));
    when 'refunded' then
      perform enqueue_webhooks(new.tenant_id, new.id, 'deal.refunded', jsonb_build_object(
        'amount', new.presentment_amount,
        'currency', new.presentment_currency
      ));
    when 'disputed' then
      perform enqueue_webhooks(new.tenant_id, new.id, 'deal.disputed', '{}'::jsonb);
    when 'paid_out' then
      perform enqueue_webhooks(new.tenant_id, new.id, 'deal.paid_out', '{}'::jsonb);
    else
      -- confirmed_buyer / confirmed_seller are emitted from the confirmations
      -- table instead: the row records which side and whether the timer did it,
      -- and the deal's status alone cannot say.
      null;
  end case;

  return new;
end;
$$;

create trigger deals_emit_webhook
  after update of status on deals
  for each row execute function emit_deal_event();

create or replace function emit_confirmation_event() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  t uuid;
begin
  select tenant_id into t from deals where id = new.deal_id;
  perform enqueue_webhooks(t, new.deal_id, 'deal.confirmed', jsonb_build_object(
    'side', new.side,
    'actor', new.actor
  ));
  return new;
end;
$$;

-- One row per side per deal is already enforced upstream, so this cannot emit
-- twice for a repeated confirmation.
create trigger confirmations_emit_webhook
  after insert on confirmations
  for each row execute function emit_confirmation_event();

create or replace function emit_dispute_event() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.status = 'open' and new.status <> 'open' then
    perform enqueue_webhooks(new.tenant_id, new.deal_id, 'deal.dispute_resolved',
      jsonb_build_object(
        'dispute_id', new.id,
        'resolution', case when new.status = 'resolved_released' then 'release' else 'refund' end,
        'note', new.resolution_note
      ));
  end if;
  return new;
end;
$$;

create trigger disputes_emit_webhook
  after update of status on disputes
  for each row execute function emit_dispute_event();

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
  end if;

  -- `paid` is not emitted here: the deal moves to paid_out in the same
  -- transaction and that trigger carries it. Two events for one settlement
  -- would make a client's idempotency key do work it should not have to.
  return new;
end;
$$;

create trigger payouts_emit_webhook
  after update of status on payouts
  for each row execute function emit_payout_event();

-- Deposits are ledger entries rather than deal states, so they emit from there.
create or replace function emit_deposit_event() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.entry_type = 'deposit_capture' then
    perform enqueue_webhooks(new.tenant_id, new.deal_id, 'deposit.captured',
      jsonb_build_object('amount', new.amount));
  elsif new.entry_type = 'deposit_release' then
    perform enqueue_webhooks(new.tenant_id, new.deal_id, 'deposit.released',
      jsonb_build_object('amount', -new.amount));
  end if;
  return new;
end;
$$;

create trigger ledger_emit_deposit_webhook
  after insert on ledger
  for each row
  when (new.entry_type in ('deposit_capture', 'deposit_release'))
  execute function emit_deposit_event();

-- ---------------------------------------------------------------------------
-- Delivery — claimed, sent and recorded by the webhook-dispatch function
-- ---------------------------------------------------------------------------

-- Claim a batch. `for update skip locked` is what lets two dispatcher
-- invocations overlap without either sending the same delivery twice.
create or replace function claim_webhook_deliveries(p_limit int default 50)
returns table (
  id           uuid,
  tenant_id    uuid,
  endpoint_id  uuid,
  url          text,
  event        text,
  body         text,
  attempts     integer
)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with claimed as (
    select d.id
    from webhook_deliveries d
    join webhook_endpoints e on e.id = d.endpoint_id
    where d.status = 'pending'
      and d.next_attempt_at <= now()
      and e.disabled_at is null
    order by d.next_attempt_at
    limit p_limit
    for update of d skip locked
  )
  update webhook_deliveries d
     set next_attempt_at = now() + interval '5 minutes'
    from claimed c, webhook_endpoints e
   where d.id = c.id and e.id = d.endpoint_id
  returning d.id, d.tenant_id, d.endpoint_id, e.url, d.event, d.body, d.attempts;
end;
$$;

-- Backoff after attempt 1, 2, 3, 4; five attempts and we stop and leave the
-- record for a person to see.
create or replace function record_webhook_attempt(
  p_delivery_id  uuid,
  p_ok           boolean,
  p_status_code  integer,
  p_error        text,
  p_signature    text
) returns webhook_deliveries
language plpgsql
security definer
set search_path = public
as $$
declare
  d webhook_deliveries;
  backoff interval;
begin
  select * into d from webhook_deliveries where id = p_delivery_id for update;

  if not found then
    raise exception 'not_found: delivery % does not exist', p_delivery_id
      using errcode = 'no_data_found';
  end if;

  if p_ok then
    update webhook_deliveries
       set status = 'delivered',
           status_code = p_status_code,
           error = null,
           signature = p_signature,
           attempts = attempts + 1,
           delivered_at = now(),
           next_attempt_at = null
     where id = d.id
    returning * into d;

    perform write_audit(d.tenant_id, d.deal_id, 'system', 'webhook.delivered',
      jsonb_build_object('event', d.event, 'attempts', d.attempts));
    return d;
  end if;

  backoff := case d.attempts + 1
    when 1 then interval '1 minute'
    when 2 then interval '5 minutes'
    when 3 then interval '30 minutes'
    else interval '2 hours'
  end;

  update webhook_deliveries
     set status = case when attempts + 1 >= 5 then 'failed'::webhook_delivery_status
                       else 'pending'::webhook_delivery_status end,
         status_code = p_status_code,
         error = p_error,
         signature = p_signature,
         attempts = attempts + 1,
         next_attempt_at = case when attempts + 1 >= 5 then null else now() + backoff end
   where id = d.id
  returning * into d;

  perform write_audit(d.tenant_id, d.deal_id, 'system',
    case when d.status = 'failed' then 'webhook.exhausted' else 'webhook.failed' end,
    jsonb_build_object('event', d.event, 'attempts', d.attempts, 'error', p_error));

  return d;
end;
$$;

-- ---------------------------------------------------------------------------
-- Risk rules — deterministic, and the only automation that may stop money
-- ---------------------------------------------------------------------------

-- The rules run against a payout that is about to leave, and can only STOP it.
-- They cannot send, release or refund, so the worst a wrong rule causes is a
-- seller waiting for a person — which is the direction to fail in.
--
-- Invariant 9 permits this precisely because it is deterministic: the same deal
-- and the same history always produce the same hold, so an operator can
-- reproduce a decision and argue with it. No model output reaches this path.
--
-- Returns true when the payout was held. The signals are written either way.
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
    and di.status = 'resolved_refunded'
    and di.resolved_at > now() - interval '90 days';

  if lost_disputes > 0 then
    insert into risk_signals (tenant_id, deal_id, seller_id, signal, severity, value, explanation)
    values (
      p.tenant_id, p.deal_id, p.seller_id, 'prior_dispute', 'review',
      jsonb_build_object('disputes', lost_disputes, 'lookback_days', 90),
      format('%s dispute(s) resolved in the buyer''s favour against this seller in the last 90 days.',
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

-- A person overriding a rule. The only way a held payout moves, and it is
-- recorded against them rather than against the system.
create or replace function approve_payout_review(
  p_payout_id  uuid,
  p_approved_by text
) returns payouts
language plpgsql
security definer
set search_path = public
as $$
declare
  p payouts;
begin
  update payouts
     set status = 'scheduled',
         review_approved_by = p_approved_by,
         review_approved_at = now()
   where id = p_payout_id and status = 'held_for_review'
  returning * into p;

  if not found then
    raise exception 'invalid_state: payout % is not held for review', p_payout_id
      using errcode = 'check_violation';
  end if;

  perform write_audit(p.tenant_id, p.deal_id, p_approved_by, 'payout.review_approved',
    jsonb_build_object(
      'payout_id', p.id,
      'overrode', (select coalesce(jsonb_agg(distinct signal), '[]'::jsonb)
                   from risk_signals
                   where deal_id = p.deal_id and severity = 'review')
    ));

  return p;
end;
$$;

-- ---------------------------------------------------------------------------
-- Reconciliation
-- ---------------------------------------------------------------------------

alter table reconciliation_alerts
  add column if not exists last_seen_at timestamptz not null default now();

-- One open alert per rail, refreshed rather than duplicated: a new row every
-- pass would bury the first report under a hundred copies of itself.
create unique index if not exists reconciliation_alerts_open_key
  on reconciliation_alerts(tenant_id, provider, currency)
  where resolved_at is null;

-- Record what the pass found for one rail.
--
-- The asymmetry is deliberate. Drift freezes payouts by itself, because money
-- we cannot account for must stop moving immediately. Nothing unfreezes by
-- itself: the drift going away is not the same as someone having understood
-- why it was there.
create or replace function record_reconciliation(
  p_tenant           uuid,
  p_provider         provider,
  p_currency         currency_code,
  p_ledger_balance   bigint,
  p_provider_balance bigint
) returns reconciliation_alerts
language plpgsql
security definer
set search_path = public
as $$
declare
  a      reconciliation_alerts;
  v_drift bigint := p_provider_balance - p_ledger_balance;
begin
  select * into a from reconciliation_alerts
  where tenant_id = p_tenant and provider = p_provider
    and currency = p_currency and resolved_at is null;

  if v_drift = 0 then
    if found then
      update reconciliation_alerts
         set resolved_at = now(),
             ledger_balance = p_ledger_balance,
             provider_balance = p_provider_balance,
             drift = 0,
             resolution_note = 'Balances agree on a later pass'
       where id = a.id
      returning * into a;

      perform write_audit(p_tenant, null, 'system', 'reconciliation.cleared',
        jsonb_build_object('provider', p_provider, 'currency', p_currency));
    end if;
    return a;
  end if;

  if found then
    update reconciliation_alerts
       set ledger_balance = p_ledger_balance,
           provider_balance = p_provider_balance,
           drift = v_drift,
           last_seen_at = now()
     where id = a.id
    returning * into a;
    return a;
  end if;

  insert into reconciliation_alerts (
    tenant_id, provider, currency, ledger_balance, provider_balance, drift
  )
  values (p_tenant, p_provider, p_currency, p_ledger_balance, p_provider_balance, v_drift)
  returning * into a;

  perform write_audit(p_tenant, null, 'system', 'reconciliation.mismatch', jsonb_build_object(
    'provider', p_provider,
    'currency', p_currency,
    'ledger_balance', p_ledger_balance,
    'provider_balance', p_provider_balance,
    'drift', v_drift,
    'action', 'payouts frozen'
  ));

  update tenants set status = 'payouts_frozen'
   where id = p_tenant and status = 'active';

  if found then
    perform write_audit(p_tenant, null, 'system', 'tenant.payouts_frozen',
      jsonb_build_object('reason', 'Reconciliation found a balance we cannot explain'));
  end if;

  return a;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants — service role only, like every other money function
-- ---------------------------------------------------------------------------

revoke all on function enqueue_webhooks(uuid, uuid, text, jsonb) from public, anon, authenticated;
revoke all on function claim_webhook_deliveries(int) from public, anon, authenticated;
revoke all on function record_webhook_attempt(uuid, boolean, integer, text, text) from public, anon, authenticated;
revoke all on function screen_payout(uuid) from public, anon, authenticated;
revoke all on function approve_payout_review(uuid, text) from public, anon, authenticated;
revoke all on function record_reconciliation(uuid, provider, currency_code, bigint, bigint) from public, anon, authenticated;

-- Dashboard sessions read their own signals and deliveries; they write neither.
-- As everywhere else, the ABSENCE of insert/update/delete policies is the
-- control, not an oversight.
alter table risk_signals enable row level security;

create policy risk_signals_read_own on risk_signals
  for select using (tenant_id in (select current_tenant_ids()));
