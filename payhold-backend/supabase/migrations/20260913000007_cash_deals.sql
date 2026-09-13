-- ---------------------------------------------------------------------------
-- Cash deals: the record, and the number that arrives later
-- ---------------------------------------------------------------------------
--
-- Uses the vocabulary 000006 declared. Two columns and two functions.
--
-- **Why two amounts.** `amount` is what the deal was worth when it was agreed —
-- the estimate the buyer accepted. `collected_amount` is what the seller says
-- they were actually handed, which on a car rental is routinely a different
-- number: the trip came back a day late, or a day early, or short on fuel.
-- Overwriting `amount` at settlement would destroy the only record of what was
-- agreed, and the deals where the two differ are precisely the ones anyone
-- would later want to look at.
--
-- **What this deliberately does not do.** No payout row, no ledger movement, no
-- fee. PayHold did not receive this money and cannot send it; a fee on it would
-- be a charge for bookkeeping the client did themselves. The seller was handed
-- notes. All that is being kept here is the fact of it.

alter table deals add column if not exists collected_amount bigint
  check (collected_amount is null or collected_amount >= 0);
alter table deals add column if not exists collected_at timestamptz;

comment on column deals.collected_amount is
  'Offline deals only: what the seller reports actually collecting, in minor '
  'units. Zero is a legal answer and means the buyer never paid — which is a '
  'fact worth recording, not an error. Null until they say.';
comment on column deals.collected_at is
  'When the seller reported the collection. Null while a cash deal is open.';

-- ── Opening one ────────────────────────────────────────────────────────────
create or replace function open_cash_deal(
  p_tenant      uuid,
  p_seller      uuid,
  p_buyer_ref   text,
  p_description text,
  p_amount      bigint,
  p_currency    currency_code,
  -- Null is allowed and means "wherever the seller is". For a handover in
  -- person that is nearly always right — both people are standing in the same
  -- place — and it saves every client from sending a country it would have had
  -- to look up to answer.
  p_actor       text,
  -- Null is allowed and means "wherever the seller is". For a handover in
  -- person that is nearly always right — both people are standing in the same
  -- place — and it saves every client from sending a country it would have had
  -- to look up to answer.
  p_country     country_code default null,
  p_expected_complete_at timestamptz default null,
  p_metadata    jsonb default '{}'::jsonb
) returns deals
language plpgsql
security definer
set search_path = public
as $$
declare
  d deals;
  s sellers;
begin
  if p_actor is null or btrim(p_actor) = '' then
    raise exception 'policy_violation: opening a deal must record who opened it'
      using errcode = 'check_violation';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'policy_violation: amount must be a positive integer in minor units'
      using errcode = 'check_violation';
  end if;

  -- The seller has to be this tenant's. Same scoping every other deal path
  -- gets, and the reason a tenant cannot open a deal against someone else's
  -- seller by guessing a uuid.
  select * into s from sellers where id = p_seller and tenant_id = p_tenant;
  if not found then
    raise exception 'not_found: seller % does not exist', p_seller
      using errcode = 'no_data_found';
  end if;

  -- No FX. Presentment equals settlement because nobody is converting anything
  -- — the buyer is handing over notes in the currency the seller quoted, and a
  -- locked rate on a deal with no rail would be a number with no event behind
  -- it.
  insert into deals (
    tenant_id, buyer_ref, seller_id, description,
    amount, currency, presentment_currency, presentment_amount,
    buyer_country, provider, payment_method, status,
    expected_complete_at, metadata
  ) values (
    p_tenant, p_buyer_ref, p_seller, p_description,
    p_amount, p_currency, p_currency, p_amount,
    coalesce(p_country, s.country), 'offline', 'cash', 'created',
    p_expected_complete_at, coalesce(p_metadata, '{}'::jsonb)
  )
  returning * into d;

  perform write_audit(
    p_tenant, d.id, p_actor, 'deal.opened_offline',
    jsonb_build_object('amount', p_amount, 'currency', p_currency)
  );

  return d;
end;
$$;

-- ── Closing one ────────────────────────────────────────────────────────────
create or replace function settle_cash_deal(
  p_deal      uuid,
  p_tenant    uuid,
  p_collected bigint,
  p_actor     text
) returns deals
language plpgsql
security definer
set search_path = public
as $$
declare
  d deals;
begin
  if p_actor is null or btrim(p_actor) = '' then
    raise exception 'policy_violation: settling a deal must record who settled it'
      using errcode = 'check_violation';
  end if;
  if p_collected is null or p_collected < 0 then
    raise exception 'policy_violation: collected amount must be zero or a positive integer'
      using errcode = 'check_violation';
  end if;

  select * into d from deals where id = p_deal and tenant_id = p_tenant for update;
  if not found then
    raise exception 'not_found: deal % does not exist', p_deal
      using errcode = 'no_data_found';
  end if;

  -- Only a deal that was opened as cash. Settling a rail deal this way would
  -- close it without the money having gone anywhere, leaving a funded hold with
  -- nothing left to release it.
  if d.provider is distinct from 'offline' then
    raise exception 'invalid_state: deal % is on a rail — it settles through its provider, not by hand', p_deal
      using errcode = 'check_violation';
  end if;

  -- Idempotent: the same report twice is one collection, and a handoff screen
  -- that got tapped twice must not become two.
  if d.status = 'settled_offline' then
    return d;
  end if;

  if d.status <> 'created' then
    raise exception 'invalid_state: a cash deal in status % cannot be settled', d.status
      using errcode = 'check_violation';
  end if;

  -- **`released_at` is deliberately not set.** It means "the hold over this
  -- money was lifted", and `released_at_matches_status` says so: it belongs to
  -- clearing, released, payout_pending and paid_out, and to nothing else. No
  -- hold was ever taken here. `collected_at` is the only timestamp this deal
  -- has, and it is the true one — the moment the seller was handed notes.
  update deals
     set collected_amount = p_collected,
         collected_at     = now(),
         status           = 'settled_offline'
   where id = d.id
  returning * into d;

  perform write_audit(
    p_tenant, d.id, p_actor, 'deal.settled_offline',
    jsonb_build_object(
      'collected_amount', p_collected,
      -- The estimate travels with it. A settlement that reads "collected
      -- 180000" says nothing on its own; next to what was agreed it says
      -- whether this trip went to plan.
      'agreed_amount', d.amount,
      'currency', d.currency
    )
  );

  return d;
end;
$$;

-- ── The lifecycle has to know about it ─────────────────────────────────────
-- `deal_transition_allowed` is a CASE with an `else false`, and a trigger
-- enforces it on every status change — so a status nobody wrote a branch for is
-- a status nothing can ever reach. `settle_cash_deal` above would have been
-- refused by the database on its first call.
--
-- One way in and no way out: `created -> settled_offline` is the whole of a
-- cash deal's life. It cannot come from `funded_held` or anything past it —
-- those hold real money, and closing one this way would strand it — and it
-- leads nowhere, because the seller has already been paid and there is nothing
-- left for PayHold to do. Terminal, alongside `refunded`, `expired` and
-- `canceled`.
create or replace function deal_transition_allowed(
  p_from deal_status,
  p_to   deal_status
) returns boolean
language sql
immutable
as $$
  select case p_from
    when 'created'            then p_to in ('checkout_started', 'payment_pending', 'funded_held', 'disputed', 'expired', 'canceled', 'settled_offline')
    when 'checkout_started'   then p_to in ('created', 'payment_pending', 'funded_held', 'disputed', 'expired', 'canceled')
    when 'payment_pending'    then p_to in ('funded_held', 'payment_failed', 'disputed', 'expired', 'canceled')
    when 'payment_failed'     then p_to in ('checkout_started', 'payment_pending', 'funded_held', 'disputed', 'expired', 'canceled')
    when 'funded_held'        then p_to in ('in_progress', 'confirmed_buyer', 'confirmed_seller', 'clearing', 'refunded', 'disputed', 'canceled')
    when 'in_progress'        then p_to in ('revision_requested', 'confirmed_buyer', 'confirmed_seller', 'clearing', 'refunded', 'disputed')
    when 'revision_requested' then p_to in ('in_progress', 'confirmed_buyer', 'confirmed_seller', 'clearing', 'refunded', 'disputed')
    when 'confirmed_buyer'    then p_to in ('confirmed_seller', 'clearing', 'revision_requested', 'refunded', 'disputed')
    when 'confirmed_seller'   then p_to in ('confirmed_buyer', 'clearing', 'revision_requested', 'refunded', 'disputed')
    when 'clearing'           then p_to in ('released', 'disputed', 'refunded', 'partially_refunded')
    when 'released'           then p_to in ('payout_pending', 'paid_out', 'disputed', 'refunded', 'partially_refunded')
    when 'payout_pending'     then p_to in ('paid_out', 'released', 'partially_refunded')
    when 'paid_out'           then p_to in ('partially_refunded')
    when 'partially_refunded' then p_to in ('released', 'payout_pending', 'paid_out', 'refunded', 'disputed')
    when 'disputed'           then p_to in ('funded_held', 'refunded')
    -- Terminal.
    when 'refunded'           then false
    when 'expired'            then false
    when 'canceled'           then false
    when 'settled_offline'    then false
    else false
  end;
$$;
