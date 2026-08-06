-- PayHold Intelligence — spec §12.
--
-- Three tables, one decision function, and a database role that cannot move
-- money. Everything here exists to make invariant 9 checkable rather than
-- merely stated: **the model advises, a person decides, and the person's
-- approval is what writes to the ledger.**
--
-- The shape of that guarantee, in this file:
--
--   * `ai_suggestions` is the only thing an AI code path may write. It has no
--     foreign key into the money tables' state and no trigger that touches
--     them. A row here changes nothing.
--   * `decide_ai_suggestion` is the single bridge from a suggestion to a money
--     function, it takes the approver's identity, and it locks the suggestion
--     before it acts so a double-click cannot resolve a dispute twice.
--   * `payhold_ai` is a role with `select` on the tenant tables and `insert`
--     on exactly two of them. Every money function is already revoked from
--     `public`; the explicit revokes below say so for this role too, so the
--     grant list reads as the whole story rather than half of it.
--
-- `deal_outcomes` is the odd one out and deliberately so. It is written from
-- the *money* path, not from anything AI, because the labels §12.4 will train
-- on have to come from every resolution including the ones no model saw. A
-- training set of only AI-assisted cases is biased from its first row, and an
-- outcome nobody recorded at the time cannot be reconstructed later — which is
-- the whole reason this table lands now rather than in six months.

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------

create type ai_suggestion_kind as enum ('dispute_resolution', 'risk_summary');

-- There is no `modified`. A person who wants different terms is making their
-- own decision, not editing the model's — they reject the draft and act by
-- hand, and the audit trail says exactly that.
create type ai_decision as enum ('approved', 'rejected');

create type ai_chat_role as enum ('user', 'assistant');

create type deal_outcome_label as enum (
  'released_clean',
  'auto_released',
  'refunded',
  'dispute_released',
  'dispute_refunded'
);

-- ---------------------------------------------------------------------------
-- Suggestions — what the model said, and what a person did about it
-- ---------------------------------------------------------------------------

create table ai_suggestions (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  deal_id        uuid not null references deals(id) on delete cascade,
  kind           ai_suggestion_kind not null,
  -- Pinned per row rather than read from config at display time: a decision is
  -- only reproducible if you know which model and which prompt produced it,
  -- and both change underneath a suggestion that is months old.
  model          text not null,
  prompt_version text not null,
  -- Hash of exactly what the model was shown. Two identical hashes on one deal
  -- mean the same case file, which is what makes a cached answer safe to serve
  -- and a disagreement between two drafts worth investigating.
  input_hash     text not null,
  output         jsonb not null,
  -- USD minor units. Small per call; the point of storing it is the monthly
  -- cap, which is a per-tenant setting rather than a global one.
  cost_usd       bigint not null default 0 check (cost_usd >= 0),
  created_at     timestamptz not null default now(),
  -- Null until a person decides. Nothing happens before that, and the three
  -- columns move together or not at all.
  decision       ai_decision,
  decided_by     text,
  decided_at     timestamptz,

  constraint ai_suggestions_decision_complete check (
    (decision is null and decided_by is null and decided_at is null) or
    (decision is not null and decided_by is not null and decided_at is not null)
  )
);

create index ai_suggestions_tenant_idx on ai_suggestions(tenant_id, created_at desc);
create index ai_suggestions_deal_idx on ai_suggestions(deal_id);
-- The budget query: this tenant's spend this calendar month.
create index ai_suggestions_spend_idx on ai_suggestions(tenant_id, created_at);
-- Serving a cached draft instead of paying for an identical one.
create index ai_suggestions_cache_idx
  on ai_suggestions(tenant_id, kind, input_hash, created_at desc);

comment on table ai_suggestions is
  'Model output awaiting a human decision. Writing a row here moves no money; '
  'decide_ai_suggestion is the only path from one of these to a money function.';

-- ---------------------------------------------------------------------------
-- Support assistant transcript
-- ---------------------------------------------------------------------------

create table ai_chat (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  role        ai_chat_role not null,
  text        text not null,
  -- Which documents the answer came from. An answer with none is a guess, and
  -- the assistant is built to say "I don't know" instead of producing one.
  sources     text[] not null default '{}',
  -- Record references, never snapshots: `{"kind":"deal","id":"…"}`. A card in
  -- yesterday's transcript then renders today's truth, so a draft approved
  -- after it was shown reads as approved.
  attachments jsonb not null default '[]',
  -- USD minor units, on the assistant turn. Chat is far cheaper per call than a
  -- draft, which is exactly why it needs counting: an unbounded loop of cheap
  -- questions would otherwise never reach the monthly cap.
  cost_usd    bigint not null default 0 check (cost_usd >= 0),
  created_at  timestamptz not null default now()
);

create index ai_chat_tenant_idx on ai_chat(tenant_id, created_at);

-- ---------------------------------------------------------------------------
-- Outcome labels — written from the money path, for the models of §12.4
-- ---------------------------------------------------------------------------

create table deal_outcomes (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  -- One row per deal, forever. The label describes how the deal ended, and a
  -- deal ends once.
  deal_id         uuid not null unique references deals(id) on delete cascade,
  outcome         deal_outcome_label not null,
  reason_code     text not null,
  notes           text,
  -- What was contested, where that differs from the deal amount.
  amount_disputed bigint,
  resolved_at     timestamptz not null default now(),
  created_at      timestamptz not null default now()
);

create index deal_outcomes_tenant_idx on deal_outcomes(tenant_id, resolved_at desc);

comment on table deal_outcomes is
  'The terminal label for every deal, written by triggers on the money path so '
  'the training set of spec 12.4 covers resolutions no model was involved in.';

-- ---------------------------------------------------------------------------
-- Labelling triggers
-- ---------------------------------------------------------------------------

-- Triggers rather than lines inside the money functions, for the same reason
-- `enqueue_webhooks` is a trigger: a label that has to be remembered by every
-- future code path — including a correction someone runs by hand at 2am — is a
-- label that will eventually be missed.
create or replace function record_deal_outcome(
  p_deal            deals,
  p_outcome         deal_outcome_label,
  p_reason          text,
  p_notes           text default null,
  p_amount_disputed bigint default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into deal_outcomes (
    tenant_id, deal_id, outcome, reason_code, notes, amount_disputed
  )
  values (
    p_deal.tenant_id, p_deal.id, p_outcome, p_reason, p_notes, p_amount_disputed
  )
  -- The first label wins. A deal that released and later paid out has one
  -- outcome, not two, and re-running a correction must not produce a second.
  on conflict (deal_id) do nothing;
end;
$$;

create or replace function label_deal_outcome() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  auto boolean;
begin
  -- A disputed deal gets the more specific label from the dispute's own
  -- trigger, which fires after the resolution note is written.
  if exists (select 1 from disputes where deal_id = new.id) then
    return new;
  end if;

  if new.status = 'released' then
    select exists (
      select 1 from confirmations where deal_id = new.id and actor = 'auto'
    ) into auto;

    perform record_deal_outcome(
      new,
      case when auto then 'auto_released'::deal_outcome_label
           else 'released_clean'::deal_outcome_label end,
      case when auto then 'timer_fired' else 'both_confirmed' end
    );
  elsif new.status = 'refunded' then
    perform record_deal_outcome(new, 'refunded', 'client_refund');
  end if;

  return new;
end;
$$;

create trigger deals_label_outcome
  after update of status on deals
  for each row
  when (old.status is distinct from new.status
        and new.status in ('released', 'refunded'))
  execute function label_deal_outcome();

create or replace function label_dispute_outcome() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  d deals;
begin
  select * into d from deals where id = new.deal_id;
  if not found then
    return new;
  end if;

  perform record_deal_outcome(
    d,
    case when new.status = 'resolved_released' then 'dispute_released'::deal_outcome_label
         else 'dispute_refunded'::deal_outcome_label end,
    'dispute_' || new.raised_by || '_raised',
    new.resolution_note,
    -- The whole deal was contested; v1 has no partial refund, so there is no
    -- smaller figure to record.
    d.amount
  );

  return new;
end;
$$;

create trigger disputes_label_outcome
  after update of status on disputes
  for each row
  when (old.status = 'open' and new.status <> 'open')
  execute function label_dispute_outcome();

-- ---------------------------------------------------------------------------
-- Spend
-- ---------------------------------------------------------------------------

-- Derived, never stored — the same rule the balance follows. A stored counter
-- and a table of costs are two numbers that can disagree, and the one the cap
-- reads would be the wrong one.
create or replace function ai_monthly_spend(p_tenant uuid)
returns bigint
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select sum(cost_usd) from ai_suggestions
      where tenant_id = p_tenant and created_at >= date_trunc('month', now())),
    0
  )::bigint
  + coalesce(
    (select sum(cost_usd) from ai_chat
      where tenant_id = p_tenant and created_at >= date_trunc('month', now())),
    0
  )::bigint;
$$;

-- ---------------------------------------------------------------------------
-- The human gate
-- ---------------------------------------------------------------------------

-- The only path from a suggestion to money moving, and it runs on the
-- approver's authority rather than the model's.
--
-- Three properties matter here and each is one line below:
--
--   1. `for update` on the suggestion, so two clicks on Approve resolve one
--      dispute once. This is the same guard `release_deal` uses and for the
--      same reason — the check and the write must share a transaction.
--   2. `p_decided_by` is required. The audit row is about a person's decision,
--      so a decision with nobody's name on it is not a decision we will take.
--   3. Only `approved` + a `dispute_resolution` of `release`/`refund` reaches
--      a money function. A rejection, an approved `escalate`, and any risk
--      summary write their row and stop — which is why the risk narrator is
--      advisory by construction and not by policy.
--
-- The converted figures come in already computed, as everywhere else: SQL owns
-- atomicity, TypeScript owns FX.
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

  -- `escalate` is the honest answer when the evidence divides, and there is
  -- nothing to execute: v1 has no partial refund, so a split cannot be
  -- expressed in terms the engine could carry out.
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
    p_fee_presentment
  );

  return s;
end;
$$;

-- ---------------------------------------------------------------------------
-- The read-only role — invariant 9 as a grant list
-- ---------------------------------------------------------------------------

-- `payhold_ai` is what the drafting functions connect as. It can read the
-- tenant tables the case file is assembled from and append to the two AI
-- tables; it holds no execute on anything that touches money.
--
-- This is a weaker claim than it looks unless you check the other half: the
-- money functions are `security definer` and revoked from `public`, so a role
-- created after them inherits nothing. The revokes below are therefore
-- redundant by construction and written anyway, because the next person
-- reading this file should not have to derive that.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'payhold_ai') then
    create role payhold_ai nologin noinherit;
  end if;
end;
$$;

grant usage on schema public to payhold_ai;

-- Read: the case file. Note what is *not* here — `api_keys`,
-- `tenant_provider_accounts`, `webhook_endpoints`. A prompt has no business
-- near a key hash or an encrypted credential, and the cheapest way to
-- guarantee that is for the role not to be able to select them.
grant select on tenants, deals, sellers, confirmations, disputes,
                risk_signals, audit_log, ledger, payouts, settings,
                deal_outcomes, ai_suggestions, ai_chat
  to payhold_ai;

-- Write: three tables, insert only. No update, so a draft cannot be edited
-- after the fact; no delete, so one cannot be made to disappear.
--
-- `audit_log` is on the list because "the model drafted this" is an event worth
-- recording, and it is safe to grant: the table is append-only by trigger, and
-- the role's policy below confines the insert to its own tenant. That is
-- tighter than granting execute on `write_audit`, which takes a tenant id as an
-- argument and would let this role write a row against any of them.
grant insert on ai_suggestions, ai_chat, audit_log to payhold_ai;

-- Both are read-only derivations the assistant needs in order to answer "how
-- much is held?" and to know when it has spent its budget.
grant execute on function ai_monthly_spend(uuid) to payhold_ai;
grant execute on function tenant_balances(uuid) to payhold_ai;

revoke all on function release_deal(uuid, bigint, currency_code, bigint) from payhold_ai;
revoke all on function refund_deal(uuid, text, text) from payhold_ai;
revoke all on function confirm_deal(uuid, confirm_side, confirm_actor, bigint, currency_code, bigint) from payhold_ai;
revoke all on function settle_payout(uuid, bigint, text) from payhold_ai;
revoke all on function capture_deposit(uuid, bigint) from payhold_ai;
revoke all on function release_deposit(uuid) from payhold_ai;
revoke all on function resolve_dispute(uuid, text, text, bigint, currency_code, bigint) from payhold_ai;
revoke all on function decide_ai_suggestion(uuid, ai_decision, text, bigint, currency_code, bigint) from payhold_ai;
revoke all on function approve_payout_review(uuid, text) from payhold_ai;

-- PostgREST switches into the request's role, which it can only do if
-- `authenticator` is a member. Guarded because `authenticator` is a Supabase
-- platform role and does not exist in the PGlite harness.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticator') then
    execute 'grant payhold_ai to authenticator';
  end if;
end;
$$;

-- Service role only, like every other function that can end in a ledger write.
revoke all on function decide_ai_suggestion(uuid, ai_decision, text, bigint, currency_code, bigint)
  from public, anon, authenticated;
revoke all on function record_deal_outcome(deals, deal_outcome_label, text, text, bigint)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- RLS — read your own tenant, write nothing
-- ---------------------------------------------------------------------------

alter table ai_suggestions enable row level security;
alter table ai_chat        enable row level security;
alter table deal_outcomes  enable row level security;

create policy ai_suggestions_read_own on ai_suggestions
  for select using (tenant_id in (select current_tenant_ids()));

create policy ai_chat_read_own on ai_chat
  for select using (tenant_id in (select current_tenant_ids()));

create policy deal_outcomes_read_own on deal_outcomes
  for select using (tenant_id in (select current_tenant_ids()));

-- The AI role reads only its own tenant too. It connects with a tenant claim
-- rather than a user session, so `current_tenant_ids()` is empty for it and a
-- separate policy is needed — without this, RLS would deny every row and the
-- assistant would answer every question with nothing.
create or replace function current_ai_tenant_id()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.tenant_id', true), '')::uuid;
$$;

grant execute on function current_ai_tenant_id() to payhold_ai;

create policy ai_suggestions_ai_role on ai_suggestions
  for select to payhold_ai using (tenant_id = current_ai_tenant_id());

create policy ai_suggestions_ai_insert on ai_suggestions
  for insert to payhold_ai with check (tenant_id = current_ai_tenant_id());

create policy ai_chat_ai_role on ai_chat
  for select to payhold_ai using (tenant_id = current_ai_tenant_id());

create policy ai_chat_ai_insert on ai_chat
  for insert to payhold_ai with check (tenant_id = current_ai_tenant_id());

create policy deal_outcomes_ai_role on deal_outcomes
  for select to payhold_ai using (tenant_id = current_ai_tenant_id());

-- The one write outside the two AI tables. Confined to this role's own tenant,
-- and `audit_log`'s append-only trigger still applies — a row written here can
-- never be edited or removed, by this role or any other.
create policy audit_log_ai_insert on audit_log
  for insert to payhold_ai with check (tenant_id = current_ai_tenant_id());
