-- ---------------------------------------------------------------------------
-- V2 §8: the Resolution Center
-- ---------------------------------------------------------------------------
--
-- `disputes` carried a reason and nothing else. §8 asks for a workflow: either
-- party requests an update, extension, cancellation, partial refund or full
-- refund; the other has 48 hours; evidence, structured reason codes, a timeline,
-- a conflict-of-interest control and a final decision record sit around it.
--
-- Three decisions in here are worth reading before changing anything.
--
-- ## 1. Silence lapses the request. It never accepts it.
--
-- §8 says an unresolved request "may be auto-resolved by platform rule", and the
-- platform rule this migration implements is: **at 48 hours the offer expires
-- and the dispute stays open.** The window closes without a human — which is
-- what §15 phase 4 asks for — and nothing moves.
--
-- The alternative reading, where silence accepts the offer, would make a clock
-- the thing that refunds a buyer or pays a seller. That is a machine deciding,
-- and invariant 9 and invariant 11 both say it may not: a rule may stop, a
-- person sends. An unanswered request is not agreement, and the honest response
-- to nobody having read it is to say so and leave the money where it is.
--
-- `expired` is therefore a distinct status from `declined`. Declining is an act
-- — somebody considered it and said no — and §24.3's labels cannot be
-- backfilled, so collapsing the two would lose the difference permanently.
--
-- ## 2. `disputed_amount` bounds the resolution. It does not split the payout.
--
-- §8: "A partial dispute freezes only the disputed amount when the ledger can
-- safely separate it." The ledger can, since Phase 3 — but the **payout** cannot,
-- and that is the binding constraint. `payouts_deal_key` allows exactly one
-- payout row per deal. Paying a seller the undisputed two thirds now would
-- consume that row, and a dispute later resolved in their favour would have
-- nothing left to send the last third with.
--
-- So the disputed amount is enforced where it can be enforced honestly: it is
-- recorded on the dispute, and `resolve_dispute` refuses to take more from the
-- seller than was ever actually in dispute. A request about a third cannot
-- quietly resolve as a full refund. The payout freeze stays whole while the
-- dispute is open, because half a payout is not something this schema can
-- represent, and pretending otherwise would strand money.
--
-- Splitting a payout is a real change — a second payout row, its own
-- idempotency key, its own line in reconciliation — and it belongs in a phase
-- that can carry it, not in a clause here.
--
-- ## 3. Conflict of interest is enforced on who *acted*, not on who someone is.
--
-- §8 wants an administrator who is a party to be unable to decide. The obvious
-- implementation — join the deciding user to the buyer or the seller — cannot
-- be written here, and deliberately so: PayHold stores no buyer PII (`buyer_ref`
-- is the client's own opaque identifier) and a seller has no login at all.
-- There is no identity to join to.
--
-- What the Resolution Center does record is **who did what**. So the control is
-- that whoever spoke for a side in this dispute cannot be the one who rules on
-- it: raise it, make an offer, or answer one, and `resolve_dispute` will not
-- accept your name as the decider. That catches the case the section is actually
-- about — the administrator who argued one side then signed off on it — and it
-- catches it with a fact we hold rather than one we would have to invent.

-- ---------------------------------------------------------------------------
-- What a dispute now records
-- ---------------------------------------------------------------------------

alter table disputes
  -- §8's structured reason code, alongside the sentence rather than instead of
  -- it. Defaulted so the existing rows and the three-argument `open_dispute`
  -- callers stay legal.
  add column if not exists reason_code dispute_reason_code not null default 'other',

  -- Presentment minor units. Null means the whole payment is in dispute, which
  -- is the common case and the safe default — a dispute that named no amount
  -- must not be read as one that disputed nothing.
  add column if not exists disputed_amount bigint check (disputed_amount > 0),

  -- Who physically filed it. `raised_by` is the *side*; this is the person, and
  -- it is half of the conflict-of-interest control.
  add column if not exists raised_by_actor text,

  -- §8's "final decision record".
  add column if not exists decided_by text;

-- ---------------------------------------------------------------------------
-- §8's five requests
-- ---------------------------------------------------------------------------

create table if not exists dispute_offers (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  dispute_id    uuid not null references disputes(id) on delete cascade,
  -- Denormalised so the one-open-request-per-order index below can exist, and
  -- so the timeline can be read without a join.
  deal_id       uuid not null references deals(id) on delete cascade,

  offered_by       confirm_side not null,
  offered_by_actor text not null,

  kind          dispute_offer_kind not null,
  -- Presentment minor units. Required for `partial_refund` and forbidden for
  -- everything else — a `full_refund` amount would be a second copy of a figure
  -- the deal already holds, free to disagree with it.
  amount        bigint check (amount > 0),
  -- Only for `extension`: the new date being asked for.
  extend_to     timestamptz,
  note          text,

  status        dispute_offer_status not null default 'open',
  -- §8's 48 hours. Stored rather than derived so that changing the window later
  -- does not retroactively expire requests made under the old one.
  expires_at    timestamptz not null,

  created_at    timestamptz not null default now(),
  responded_at  timestamptz,
  responded_by_actor text,

  constraint dispute_offers_amount_shape check (
    (kind = 'partial_refund' and amount is not null)
    or (kind <> 'partial_refund' and amount is null)
  ),
  constraint dispute_offers_extension_shape check (
    (kind = 'extension' and extend_to is not null)
    or (kind <> 'extension' and extend_to is null)
  ),
  -- A terminal status has an answer time; an open one does not.
  constraint dispute_offers_responded_shape check (
    (status = 'open' and responded_at is null)
    or (status <> 'open' and responded_at is not null)
  )
);

create index if not exists dispute_offers_tenant_idx on dispute_offers(tenant_id);
create index if not exists dispute_offers_dispute_idx on dispute_offers(dispute_id);
create index if not exists dispute_offers_deal_idx on dispute_offers(deal_id);

-- §8, and the reason `disputes_one_open_per_deal` already exists: a new request
-- cannot open while another for the same order is open. Enforced on `deal_id`
-- rather than `dispute_id` because the section is about the *order*.
create unique index if not exists dispute_offers_one_open_per_deal
  on dispute_offers(deal_id) where status = 'open';

-- The expiry pass scans this. Partial, because an answered offer is never
-- looked at again by the clock.
create index if not exists dispute_offers_expiry_idx
  on dispute_offers(expires_at) where status = 'open';

-- ---------------------------------------------------------------------------
-- §8's evidence
-- ---------------------------------------------------------------------------
--
-- No bytes. A description, a kind and a reference to wherever the file actually
-- lives — the same refusal to hold the thing itself that keeps card numbers and
-- account numbers out of this database. What the assistant reads is the
-- description, which is why it is required and the reference is not.

create table if not exists dispute_evidence (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  dispute_id    uuid not null references disputes(id) on delete cascade,
  deal_id       uuid not null references deals(id) on delete cascade,

  uploaded_by       confirm_side not null,
  uploaded_by_actor text not null,

  kind          dispute_evidence_kind not null,
  description   text not null check (btrim(description) <> ''),
  storage_ref   text,
  -- When the photo was taken, as distinct from when it was uploaded. §8 wants
  -- inspection photos to mean something, and one taken after the complaint is
  -- worth less than one taken at handover.
  captured_at   timestamptz,

  created_at    timestamptz not null default now()
);

create index if not exists dispute_evidence_tenant_idx on dispute_evidence(tenant_id);
create index if not exists dispute_evidence_dispute_idx on dispute_evidence(dispute_id);
create index if not exists dispute_evidence_deal_idx on dispute_evidence(deal_id);

-- ---------------------------------------------------------------------------
-- RLS: read your own tenant, write nothing
-- ---------------------------------------------------------------------------
--
-- The absence of insert/update/delete policies is the control, exactly as
-- everywhere else. Every write below goes through a security-definer function
-- reached only by the service role.

alter table dispute_offers   enable row level security;
alter table dispute_evidence enable row level security;
alter table dispute_offers   force row level security;
alter table dispute_evidence force row level security;

drop policy if exists dispute_offers_read on dispute_offers;
create policy dispute_offers_read on dispute_offers
  for select to authenticated
  using (tenant_id in (select current_tenant_ids()) or is_platform_admin());

drop policy if exists dispute_evidence_read on dispute_evidence;
create policy dispute_evidence_read on dispute_evidence
  for select to authenticated
  using (tenant_id in (select current_tenant_ids()) or is_platform_admin());

grant select on dispute_offers, dispute_evidence to authenticated;

-- ---------------------------------------------------------------------------
-- Opening a dispute — now with a code, an amount and a name
-- ---------------------------------------------------------------------------
--
-- Dropped rather than replaced: `create or replace` cannot change a signature,
-- it adds a sibling, and the V2 draft that learned this the hard way is
-- described at length in `20260807000004`. The new arguments are defaulted so
-- the three-argument form keeps working.

drop function if exists open_dispute(uuid, confirm_side, text);

create function open_dispute(
  p_deal_id     uuid,
  p_raised_by   confirm_side,
  p_reason      text,
  p_reason_code dispute_reason_code default 'other',
  p_actor       text default null,
  -- Presentment minor units. Null disputes the whole payment.
  p_amount      bigint default null
) returns disputes
language plpgsql
security definer
set search_path = public
as $$
declare
  d    deals;
  dsp  disputes;
  n    int;
begin
  select * into d from deals where id = p_deal_id for update;

  if not found then
    raise exception 'not_found: deal % does not exist', p_deal_id
      using errcode = 'no_data_found';
  end if;

  if d.status not in ('funded_held', 'in_progress', 'revision_requested',
                      'confirmed_buyer', 'confirmed_seller', 'clearing', 'disputed') then
    raise exception 'invalid_state: a deal in % cannot be disputed', d.status
      using errcode = 'check_violation';
  end if;

  if p_amount is not null and p_amount > d.presentment_amount then
    raise exception 'policy_violation: % is more than the buyer paid', p_amount
      using errcode = 'check_violation';
  end if;

  -- §8: a new dispute cannot open while another request for the same order is
  -- open. The unique index says this for disputes; an outstanding *offer* is
  -- the same sentence about the same order, and the section makes no
  -- distinction between the two.
  select count(*) into n
    from dispute_offers where deal_id = d.id and status = 'open';

  if n > 0 then
    raise exception 'invalid_state: a request on this order is still open'
      using errcode = 'check_violation';
  end if;

  insert into disputes (tenant_id, deal_id, raised_by, reason, reason_code,
                        disputed_amount, raised_by_actor)
  values (d.tenant_id, d.id, p_raised_by, p_reason, p_reason_code,
          p_amount, p_actor)
  returning * into dsp;

  update deals set status = 'disputed' where id = d.id;

  perform write_audit(d.tenant_id, d.id, coalesce(p_actor, 'user:' || p_raised_by),
                      'deal.disputed',
                      jsonb_build_object('reason', p_reason,
                                         'reason_code', p_reason_code,
                                         'disputed_amount', p_amount));

  return dsp;
end;
$$;

-- ---------------------------------------------------------------------------
-- Making a request
-- ---------------------------------------------------------------------------

create or replace function make_dispute_offer(
  p_dispute_id uuid,
  p_offered_by confirm_side,
  p_actor      text,
  p_kind       dispute_offer_kind,
  p_amount     bigint default null,
  p_extend_to  timestamptz default null,
  p_note       text default null
) returns dispute_offers
language plpgsql
security definer
set search_path = public
as $$
declare
  dsp  disputes;
  d    deals;
  o    dispute_offers;
begin
  if p_actor is null or btrim(p_actor) = '' then
    raise exception 'policy_violation: a request must record who made it'
      using errcode = 'check_violation';
  end if;

  select * into dsp from disputes where id = p_dispute_id for update;

  if not found then
    raise exception 'not_found: dispute % does not exist', p_dispute_id
      using errcode = 'no_data_found';
  end if;

  if dsp.status <> 'open' then
    raise exception 'invalid_state: this dispute is already resolved'
      using errcode = 'check_violation';
  end if;

  select * into d from deals where id = dsp.deal_id;

  -- A partial refund cannot ask for more than was ever in dispute, and cannot
  -- ask for the whole payment — that request has a name of its own, and
  -- `resolve_dispute` refuses a partial refund equal to the payment for the
  -- same reason.
  if p_kind = 'partial_refund' then
    if p_amount is null or p_amount <= 0 then
      raise exception 'policy_violation: a partial refund must name an amount'
        using errcode = 'check_violation';
    end if;
    if p_amount >= d.presentment_amount then
      raise exception 'policy_violation: that is the whole payment — request a full refund'
        using errcode = 'check_violation';
    end if;
    if dsp.disputed_amount is not null and p_amount > dsp.disputed_amount then
      raise exception 'policy_violation: % is more than the % in dispute',
        p_amount, dsp.disputed_amount using errcode = 'check_violation';
    end if;
  end if;

  -- The unique index is the real guard; this is here so the caller gets a
  -- sentence rather than a constraint name.
  if exists (select 1 from dispute_offers
              where deal_id = dsp.deal_id and status = 'open') then
    raise exception 'invalid_state: a request on this order is still open'
      using errcode = 'check_violation';
  end if;

  insert into dispute_offers (tenant_id, dispute_id, deal_id, offered_by,
                              offered_by_actor, kind, amount, extend_to, note,
                              expires_at)
  values (dsp.tenant_id, dsp.id, dsp.deal_id, p_offered_by, p_actor, p_kind,
          case when p_kind = 'partial_refund' then p_amount end,
          case when p_kind = 'extension' then p_extend_to end,
          p_note,
          now() + interval '48 hours')
  returning * into o;

  perform write_audit(dsp.tenant_id, dsp.deal_id, p_actor, 'dispute.offer_made',
                      jsonb_build_object('offer_id', o.id, 'kind', p_kind,
                                         'amount', o.amount,
                                         'expires_at', o.expires_at));

  return o;
end;
$$;

-- ---------------------------------------------------------------------------
-- Withdrawing one
-- ---------------------------------------------------------------------------

create or replace function withdraw_dispute_offer(
  p_offer_id uuid,
  p_actor    text
) returns dispute_offers
language plpgsql
security definer
set search_path = public
as $$
declare
  o dispute_offers;
begin
  select * into o from dispute_offers where id = p_offer_id for update;

  if not found then
    raise exception 'not_found: request % does not exist', p_offer_id
      using errcode = 'no_data_found';
  end if;

  if o.status <> 'open' then
    raise exception 'invalid_state: that request is already %', o.status
      using errcode = 'check_violation';
  end if;

  update dispute_offers
     set status = 'withdrawn', responded_at = now(), responded_by_actor = p_actor
   where id = o.id
  returning * into o;

  perform write_audit(o.tenant_id, o.deal_id, p_actor, 'dispute.offer_withdrawn',
                      jsonb_build_object('offer_id', o.id));

  return o;
end;
$$;

-- ---------------------------------------------------------------------------
-- Answering one
-- ---------------------------------------------------------------------------
--
-- Accepting is where a request can become money, and it takes the converted
-- figures for the same reason `release_deal` does: FX and fees are TypeScript's,
-- atomicity is SQL's. Accepting a refund kind calls `resolve_dispute` inside
-- this transaction rather than leaving the endpoint to make a second call that
-- could fail on its own.
--
-- The other party answers. A caller passing the offering side is refused —
-- accepting your own request is not agreement, it is a way around the 48 hours.

create or replace function respond_dispute_offer(
  p_offer_id        uuid,
  p_side            confirm_side,
  p_actor           text,
  p_accept          boolean,
  p_payout_amount   bigint default null,
  p_payout_currency currency_code default null,
  p_fee_presentment bigint default null
) returns dispute_offers
language plpgsql
security definer
set search_path = public
as $$
declare
  o    dispute_offers;
  dsp  disputes;
  d    deals;
begin
  if p_actor is null or btrim(p_actor) = '' then
    raise exception 'policy_violation: an answer must record who gave it'
      using errcode = 'check_violation';
  end if;

  select * into o from dispute_offers where id = p_offer_id for update;

  if not found then
    raise exception 'not_found: request % does not exist', p_offer_id
      using errcode = 'no_data_found';
  end if;

  if o.status <> 'open' then
    raise exception 'invalid_state: that request is already %', o.status
      using errcode = 'check_violation';
  end if;

  if now() >= o.expires_at then
    raise exception 'invalid_state: that request expired at %', o.expires_at
      using errcode = 'check_violation';
  end if;

  if p_side = o.offered_by then
    raise exception 'policy_violation: the other party answers a request'
      using errcode = 'check_violation';
  end if;

  select * into dsp from disputes where id = o.dispute_id for update;
  select * into d from deals where id = o.deal_id;

  if not p_accept then
    update dispute_offers
       set status = 'declined', responded_at = now(), responded_by_actor = p_actor
     where id = o.id
    returning * into o;

    perform write_audit(o.tenant_id, o.deal_id, p_actor, 'dispute.offer_declined',
                        jsonb_build_object('offer_id', o.id, 'kind', o.kind));
    return o;
  end if;

  update dispute_offers
     set status = 'accepted', responded_at = now(), responded_by_actor = p_actor
   where id = o.id
  returning * into o;

  perform write_audit(o.tenant_id, o.deal_id, p_actor, 'dispute.offer_accepted',
                      jsonb_build_object('offer_id', o.id, 'kind', o.kind,
                                         'amount', o.amount));

  -- `update` and `extension` change what was agreed and settle nothing. The
  -- dispute stays open on purpose: agreeing to send a photo or to finish on
  -- Friday is not agreeing about the money, and closing the dispute here would
  -- unfreeze the payout on the strength of a side conversation.
  if o.kind = 'extension' then
    update deals set expected_complete_at = o.extend_to where id = d.id;
    perform write_audit(o.tenant_id, o.deal_id, p_actor, 'deal.extended',
                        jsonb_build_object('expected_complete_at', o.extend_to));
    return o;

  elsif o.kind = 'update' then
    return o;
  end if;

  -- The three that end the deal. `p_actor` is a party, so it is deliberately
  -- *not* passed as the decider — the conflict-of-interest control in
  -- `resolve_dispute` would refuse it, and rightly. An agreement between the
  -- two sides is recorded as one.
  if o.kind = 'cancellation' or o.kind = 'full_refund' then
    perform resolve_dispute(dsp.id, 'refund',
      format('Agreed by both parties: %s accepted by %s.', o.kind, p_actor),
      coalesce(p_payout_amount, 0), coalesce(p_payout_currency, d.currency),
      coalesce(p_fee_presentment, 0), null, 'both-parties');

  elsif o.kind = 'partial_refund' then
    perform resolve_dispute(dsp.id, 'partial_refund',
      format('Agreed by both parties: partial refund accepted by %s.', p_actor),
      p_payout_amount, coalesce(p_payout_currency, d.currency),
      p_fee_presentment, o.amount, 'both-parties');
  end if;

  return o;
end;
$$;

-- ---------------------------------------------------------------------------
-- Evidence
-- ---------------------------------------------------------------------------

create or replace function add_dispute_evidence(
  p_dispute_id  uuid,
  p_uploaded_by confirm_side,
  p_actor       text,
  p_kind        dispute_evidence_kind,
  p_description text,
  p_storage_ref text default null,
  p_captured_at timestamptz default null
) returns dispute_evidence
language plpgsql
security definer
set search_path = public
as $$
declare
  dsp disputes;
  e   dispute_evidence;
begin
  if p_actor is null or btrim(p_actor) = '' then
    raise exception 'policy_violation: evidence must record who filed it'
      using errcode = 'check_violation';
  end if;

  select * into dsp from disputes where id = p_dispute_id;

  if not found then
    raise exception 'not_found: dispute % does not exist', p_dispute_id
      using errcode = 'no_data_found';
  end if;

  -- Evidence after the decision cannot have informed it, and a case file that
  -- grew after the fact is not the one anybody read.
  if dsp.status <> 'open' then
    raise exception 'invalid_state: this dispute is already resolved'
      using errcode = 'check_violation';
  end if;

  insert into dispute_evidence (tenant_id, dispute_id, deal_id, uploaded_by,
                                uploaded_by_actor, kind, description,
                                storage_ref, captured_at)
  values (dsp.tenant_id, dsp.id, dsp.deal_id, p_uploaded_by, p_actor, p_kind,
          p_description, p_storage_ref, p_captured_at)
  returning * into e;

  perform write_audit(dsp.tenant_id, dsp.deal_id, p_actor, 'dispute.evidence_added',
                      jsonb_build_object('evidence_id', e.id, 'kind', p_kind));

  return e;
end;
$$;

-- ---------------------------------------------------------------------------
-- The 48 hours running out
-- ---------------------------------------------------------------------------
--
-- Called by the `auto-release` cron pass. It moves no money and touches no deal
-- — see this file's header — so it is safe to run beside the release timer and
-- wrong to give the power to do anything else.

create or replace function expire_dispute_offers()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  o dispute_offers;
  n int := 0;
begin
  for o in
    select * from dispute_offers
     where status = 'open' and expires_at <= now()
     order by expires_at
     for update skip locked
  loop
    update dispute_offers
       set status = 'expired', responded_at = now()
     where id = o.id;

    perform write_audit(o.tenant_id, o.deal_id, 'system', 'dispute.offer_expired',
                        jsonb_build_object('offer_id', o.id, 'kind', o.kind,
                                           'expired_at', o.expires_at));
    n := n + 1;
  end loop;

  return n;
end;
$$;

-- ---------------------------------------------------------------------------
-- §8's timeline
-- ---------------------------------------------------------------------------
--
-- One ordered list of everything that happened, which is what a person reading
-- a case needs and what "communication export" means in practice. Derived, never
-- stored: every row below already exists somewhere else, and a second copy would
-- be free to disagree with the first.

create or replace function dispute_timeline(p_dispute_id uuid)
returns table (
  at        timestamptz,
  kind      text,
  actor     text,
  side      confirm_side,
  summary   text,
  details   jsonb
)
language sql
stable
security definer
set search_path = public
as $$
  with dsp as (
    select * from disputes where id = p_dispute_id
  )
  select d.opened_at,
         'dispute_opened',
         coalesce(d.raised_by_actor, 'user:' || d.raised_by),
         d.raised_by,
         d.reason,
         jsonb_build_object('reason_code', d.reason_code,
                            'disputed_amount', d.disputed_amount)
    from dsp d

  union all
  select o.created_at,
         'offer_' || o.kind::text,
         o.offered_by_actor,
         o.offered_by,
         coalesce(o.note, o.kind::text),
         jsonb_build_object('offer_id', o.id, 'amount', o.amount,
                            'extend_to', o.extend_to, 'expires_at', o.expires_at)
    from dispute_offers o, dsp d where o.dispute_id = d.id

  union all
  select o.responded_at,
         'offer_' || o.status::text,
         coalesce(o.responded_by_actor, 'system'),
         null::confirm_side,
         o.kind::text,
         jsonb_build_object('offer_id', o.id)
    from dispute_offers o, dsp d
   where o.dispute_id = d.id and o.responded_at is not null

  union all
  select e.created_at,
         'evidence_' || e.kind::text,
         e.uploaded_by_actor,
         e.uploaded_by,
         e.description,
         jsonb_build_object('evidence_id', e.id, 'captured_at', e.captured_at,
                            'storage_ref', e.storage_ref)
    from dispute_evidence e, dsp d where e.dispute_id = d.id

  union all
  select d.resolved_at,
         'resolved',
         coalesce(d.decided_by, 'payhold-staff'),
         null::confirm_side,
         coalesce(d.resolution_note, d.status::text),
         jsonb_build_object('status', d.status)
    from dsp d where d.resolved_at is not null

  order by 1;
$$;

-- ---------------------------------------------------------------------------
-- Resolving, with a name attached and a conflict-of-interest check
-- ---------------------------------------------------------------------------
--
-- Dropped and recreated, so: **the revoke below is not optional.** A recreated
-- function is granted to PUBLIC by default, which includes `payhold_ai`, and
-- invariant 9 is a grant list rather than a convention.
-- `tests/intelligence.test.ts` matches on the function name and fails if this
-- is forgotten — which is exactly how the same trap was caught in Phase 3.

drop function if exists resolve_dispute(uuid, text, text, bigint, currency_code, bigint, bigint);

create function resolve_dispute(
  p_dispute_id       uuid,
  p_resolution       text,
  p_note             text,
  p_payout_amount    bigint,
  p_payout_currency  currency_code,
  p_fee_presentment  bigint,
  -- Only for `partial_refund`: what goes back to the buyer, presentment.
  p_refund_amount    bigint default null,
  -- §8's final decision record. Required — a decision without a decider is not
  -- a record, which is the same reason `approve_payout_review` takes a name.
  p_decided_by       text default null
) returns disputes
language plpgsql
security definer
set search_path = public
as $$
declare
  dsp     disputes;
  d       deals;
  v_scale numeric;
  v_payout bigint;
  v_conflict boolean;
begin
  if p_decided_by is null or btrim(p_decided_by) = '' then
    raise exception 'policy_violation: a resolution must record who decided it'
      using errcode = 'check_violation';
  end if;

  select * into dsp from disputes where id = p_dispute_id for update;

  if not found then
    raise exception 'not_found: dispute % does not exist', p_dispute_id
      using errcode = 'no_data_found';
  end if;

  if dsp.status <> 'open' then
    raise exception 'invalid_state: this dispute is already resolved'
      using errcode = 'check_violation';
  end if;

  -- §8's conflict-of-interest control. `both-parties` is the one name that is
  -- allowed to have acted: it is what `respond_dispute_offer` writes when the
  -- two sides agreed with each other, and refusing that would make agreement
  -- unexecutable.
  if p_decided_by <> 'both-parties' then
    select coalesce(dsp.raised_by_actor = p_decided_by, false)
        or exists (select 1 from dispute_offers o
                    where o.dispute_id = dsp.id
                      and (o.offered_by_actor = p_decided_by
                           or o.responded_by_actor = p_decided_by))
      into v_conflict;

    if v_conflict then
      raise exception 'policy_violation: % acted for a party in this dispute and cannot decide it', p_decided_by
        using errcode = 'check_violation';
    end if;
  end if;

  select * into d from deals where id = dsp.deal_id for update;

  -- §8: the freeze is for the affected amount, so the resolution cannot take
  -- more from the seller than was ever actually in dispute. A complaint about a
  -- third does not become a full refund without somebody opening a dispute
  -- about the rest.
  if dsp.disputed_amount is not null and dsp.disputed_amount < d.presentment_amount then
    if p_resolution = 'refund' then
      raise exception 'policy_violation: only % of this payment is in dispute — resolve it as a partial refund', dsp.disputed_amount
        using errcode = 'check_violation';
    end if;
    if p_resolution = 'partial_refund' and coalesce(p_refund_amount, 0) > dsp.disputed_amount then
      raise exception 'policy_violation: % is more than the % in dispute',
        p_refund_amount, dsp.disputed_amount using errcode = 'check_violation';
    end if;
  end if;

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
    perform refund_deal(d.id, 'Dispute resolved in buyer''s favour: ' || p_note,
                        'payhold-staff');
    dsp.status := 'resolved_refunded';

  elsif p_resolution = 'partial_refund' then
    if p_refund_amount is null or p_refund_amount <= 0 then
      raise exception 'policy_violation: a partial refund must name an amount'
        using errcode = 'check_violation';
    end if;
    if p_refund_amount >= d.presentment_amount then
      raise exception 'policy_violation: a partial refund cannot be the whole payment — resolve it as a refund'
        using errcode = 'check_violation';
    end if;

    update deals set status = 'funded_held' where id = d.id;

    -- The buyer's share first, so the release that follows lets out only what
    -- is left. `release_deal` reads that for itself.
    perform refund_deal(d.id, 'Dispute resolved in part: ' || p_note,
                        'payhold-staff', p_refund_amount);

    -- What the seller receives shrinks in the same proportion. Scaled rather
    -- than converted, for the reason `refund_deal` scales a scheduled payout:
    -- the payout is in the seller's currency and the refund is in the buyer's,
    -- and inventing a rate here would disagree with `amountLeaving` at
    -- dispatch.
    v_scale := (d.presentment_amount - p_refund_amount)::numeric / d.presentment_amount;
    v_payout := greatest(1, floor(p_payout_amount * v_scale)::bigint);

    insert into confirmations (deal_id, side, actor)
    values (d.id, 'buyer', 'auto'), (d.id, 'seller', 'auto')
    on conflict (deal_id, side) do nothing;

    perform release_deal(d.id, v_payout, p_payout_currency,
                         floor(p_fee_presentment * v_scale)::bigint);
    dsp.status := 'resolved_split';

  else
    raise exception 'policy_violation: resolution must be release, refund or partial_refund'
      using errcode = 'check_violation';
  end if;

  update disputes
     set status = dsp.status,
         resolved_at = now(),
         resolution_note = p_note,
         decided_by = p_decided_by
   where id = dsp.id
  returning * into dsp;

  -- Any request still outstanding is moot now, and leaving it open would block
  -- the next dispute on this order through `dispute_offers_one_open_per_deal`.
  update dispute_offers
     set status = 'withdrawn', responded_at = now(),
         responded_by_actor = p_decided_by
   where dispute_id = dsp.id and status = 'open';

  perform write_audit(d.tenant_id, d.id, p_decided_by, 'dispute.resolved',
                      jsonb_build_object(
                        'resolution', p_resolution,
                        'refund_amount', p_refund_amount,
                        'note', p_note
                      ));

  return dsp;
end;
$$;

-- `decide_ai_suggestion` keeps its signature. What changes is that the approver
-- is now passed through as the decider — which means an administrator who
-- argued one side of this dispute cannot launder the decision through an AI
-- draft either. Invariant 9 is unaffected: the model still executes nothing.
create or replace function decide_ai_suggestion(
  p_suggestion_id   uuid,
  p_decision        ai_decision,
  p_decided_by      text,
  p_payout_amount   bigint default null,
  p_payout_currency currency_code default null,
  p_fee_presentment bigint default null
) returns ai_suggestions
language plpgsql
security definer
set search_path = public
as $$
declare
  s    ai_suggestions;
  dsp  disputes;
  rec  text;
begin
  if p_decided_by is null or btrim(p_decided_by) = '' then
    raise exception 'policy_violation: a decision must record who made it'
      using errcode = 'check_violation';
  end if;

  select * into s from ai_suggestions where id = p_suggestion_id for update;

  if not found then
    raise exception 'not_found: suggestion % does not exist', p_suggestion_id
      using errcode = 'no_data_found';
  end if;

  if s.decision is not null then
    raise exception 'invalid_state: that suggestion has already been decided'
      using errcode = 'check_violation';
  end if;

  update ai_suggestions
     set decision    = p_decision,
         decided_by  = p_decided_by,
         decided_at  = now()
   where id = s.id
  returning * into s;

  perform write_audit(
    s.tenant_id, s.deal_id, p_decided_by, 'ai.suggestion_' || p_decision,
    jsonb_build_object(
      'suggestion_id', s.id,
      'kind', s.kind,
      'model', s.model,
      'prompt_version', s.prompt_version,
      'input_hash', s.input_hash
    )
  );

  if p_decision <> 'approved' or s.kind <> 'dispute_resolution' then
    return s;
  end if;

  rec := s.output ->> 'recommendation';

  -- `escalate` still exists and still means what it says: the evidence divides
  -- in a way no split resolves, and a person should look.
  if rec is null or rec = 'escalate' then
    return s;
  end if;

  select * into dsp
    from disputes
   where deal_id = s.deal_id and status = 'open'
   for update;

  -- The draft was open while somebody resolved the dispute by hand. Recording
  -- the approval and stopping is right: re-resolving would be a second
  -- decision nobody made.
  if not found then
    raise exception 'invalid_state: that dispute was resolved while the draft was open'
      using errcode = 'check_violation';
  end if;

  perform resolve_dispute(
    dsp.id,
    rec,
    coalesce(s.output ->> 'headline', 'Approved from an AI draft')
      || ' Drafted by ' || s.model || ' (' || s.id || '), approved by '
      || p_decided_by || '.',
    p_payout_amount,
    p_payout_currency,
    p_fee_presentment,
    -- Validated on the way in (`ai-validate.ts`) and again by `resolve_dispute`,
    -- which refuses a null or whole-payment amount.
    (s.output ->> 'refund_amount')::bigint,
    p_decided_by
  );

  return s;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants — the part that is easy to forget and expensive to get wrong
-- ---------------------------------------------------------------------------

revoke all on function resolve_dispute(uuid, text, text, bigint, currency_code, bigint, bigint, text)
  from public, anon, authenticated;
revoke all on function resolve_dispute(uuid, text, text, bigint, currency_code, bigint, bigint, text)
  from payhold_ai;

revoke all on function open_dispute(uuid, confirm_side, text, dispute_reason_code, text, bigint)
  from public, anon, authenticated;
revoke all on function open_dispute(uuid, confirm_side, text, dispute_reason_code, text, bigint)
  from payhold_ai;

revoke all on function make_dispute_offer(uuid, confirm_side, text, dispute_offer_kind, bigint, timestamptz, text)
  from public, anon, authenticated, payhold_ai;
revoke all on function withdraw_dispute_offer(uuid, text)
  from public, anon, authenticated, payhold_ai;
revoke all on function respond_dispute_offer(uuid, confirm_side, text, boolean, bigint, currency_code, bigint)
  from public, anon, authenticated, payhold_ai;
revoke all on function add_dispute_evidence(uuid, confirm_side, text, dispute_evidence_kind, text, text, timestamptz)
  from public, anon, authenticated, payhold_ai;
revoke all on function expire_dispute_offers()
  from public, anon, authenticated, payhold_ai;

-- The assistant may *read* the case file it is being asked about — that is the
-- whole of §12.2 and the reason `dispute-assistant@2` exists. It gains select
-- and nothing else, under the same tenant-scoped policy as every other table it
-- can see: a query that forgets its filter returns nothing rather than
-- everything.
grant select on dispute_offers, dispute_evidence to payhold_ai;

drop policy if exists dispute_offers_ai_read on dispute_offers;
create policy dispute_offers_ai_read on dispute_offers
  for select to payhold_ai using (tenant_id = current_ai_tenant_id());

drop policy if exists dispute_evidence_ai_read on dispute_evidence;
create policy dispute_evidence_ai_read on dispute_evidence
  for select to payhold_ai using (tenant_id = current_ai_tenant_id());

-- The timeline is a read, and the dashboard is the thing that renders it.
grant execute on function dispute_timeline(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Notifications, from triggers rather than from the functions above
-- ---------------------------------------------------------------------------
--
-- Same argument as `enqueue_webhooks` everywhere else: a notification every
-- future code path has to remember is one that eventually gets forgotten,
-- including by a correction someone runs by hand at 2am. Enqueue stays in the
-- same transaction as the fact it describes.

create or replace function dispute_offers_notify()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    perform enqueue_webhooks(new.tenant_id, new.deal_id, 'dispute.offer_made',
      jsonb_build_object('offer_id', new.id, 'kind', new.kind,
                         'offered_by', new.offered_by, 'amount', new.amount,
                         'expires_at', new.expires_at));
    return new;
  end if;

  if new.status is distinct from old.status then
    perform enqueue_webhooks(new.tenant_id, new.deal_id,
      'dispute.offer_' || new.status::text,
      jsonb_build_object('offer_id', new.id, 'kind', new.kind));
  end if;

  return new;
end;
$$;

drop trigger if exists dispute_offers_notify_t on dispute_offers;
create trigger dispute_offers_notify_t
  after insert or update on dispute_offers
  for each row execute function dispute_offers_notify();

create or replace function dispute_evidence_notify()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform enqueue_webhooks(new.tenant_id, new.deal_id, 'dispute.evidence_added',
    jsonb_build_object('evidence_id', new.id, 'kind', new.kind,
                       'uploaded_by', new.uploaded_by));
  return new;
end;
$$;

drop trigger if exists dispute_evidence_notify_t on dispute_evidence;
create trigger dispute_evidence_notify_t
  after insert on dispute_evidence
  for each row execute function dispute_evidence_notify();

-- A resolved dispute is worth telling a client about in its own right. The deal
-- also changes status, which fires its own event — this one carries the
-- outcome, which the deal's status cannot: `funded_held` on the way to a
-- release looks identical whoever won.
create or replace function disputes_notify_resolved()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status <> 'open' and old.status = 'open' then
    perform enqueue_webhooks(new.tenant_id, new.deal_id, 'dispute.resolved',
      jsonb_build_object('dispute_id', new.id, 'status', new.status,
                         'decided_by', new.decided_by));
  end if;
  return new;
end;
$$;

drop trigger if exists disputes_notify_resolved_t on disputes;
create trigger disputes_notify_resolved_t
  after update on disputes
  for each row execute function disputes_notify_resolved();

-- ---------------------------------------------------------------------------
-- §16's gate: this phase's blocker is cleared by this phase
-- ---------------------------------------------------------------------------
--
-- `launch_checklist.blocked_by` is the unbuilt work standing in the way, and
-- `20260807000015` states the contract plainly: *the phase that builds the thing
-- clears this in its own migration, which is the only writer there will ever be.*
-- This is that write.
--
-- The seed's `to_regclass` guard covers the case where the Resolution Center had
-- already landed when the gate migration ran. It cannot cover this one — the
-- gate is numbered first, so it looked for `dispute_offers`, found nothing, and
-- recorded the blocker. Only this file can retire it.
--
-- It clears the blocker and **does not sign the item off**. Those are different
-- claims: the table now exists, so somebody may attest to §15 phase 4; whether
-- the behaviour is right is a person's judgement and the whole point of the
-- checklist. Note in particular that this phase bounds the resolution by the
-- disputed amount rather than splitting the payout — see this file's header —
-- so anybody signing `dispute_window` should read that first.

do $$
begin
  if to_regclass('public.launch_checklist') is not null then
    update launch_checklist
       set blocked_by = null
     where code = 'dispute_window'
       and blocked_by is not null;
  end if;
end;
$$;
