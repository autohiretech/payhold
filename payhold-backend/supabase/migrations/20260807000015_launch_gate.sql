-- ---------------------------------------------------------------------------
-- V2 §16 and §17: the launch gate
-- ---------------------------------------------------------------------------
--
-- §16 is a list of things that must be true before PayHold takes live money,
-- and almost none of them are code: legal entities, provider contracts, seller
-- and buyer terms, a sanctions process, a chargeback response process, written
-- provider confirmation for marketplace payouts in each of the four launch
-- markets. §15's phase 8 adds a penetration test and a compliance sign-off, and
-- §28 adds the sandbox walkthrough.
--
-- A checklist nobody is forced to consult is a document. This one is wired to
-- the thing it is about: **live provider credentials cannot be connected while
-- a required item is outstanding** (`functions/provider-accounts/`), which is
-- §16's "the production release begins in test mode" and §15 phase 8's "live
-- keys remain disabled until approval", enforced rather than remembered.
--
-- ## Two kinds of item, and only one of them is a signature
--
-- Most items are **attestations**: a person states that a thing was done, with
-- their name and a pointer to the evidence, exactly like `verify_seller`. Code
-- cannot check whether a lawyer incorporated a company.
--
-- The rest are **engineering** items whose acceptance is code, and some of that
-- code is not written yet. Those ship with `blocked_by` naming the work that is
-- missing, and a blocked item **cannot be signed off at all** — a check
-- constraint, not a convention. That is what makes it safe for this phase to
-- land out of order: the gate is closed, and no attestation can open it while
-- the work behind it is missing.
--
-- **A blocker that can be checked is checked**, at seed time, rather than
-- asserted by whoever wrote this file. `to_regclass` below is not decoration:
-- phases 8 and 9 landed while this migration was being written, and a
-- hand-written "phase 8 is missing" would have shipped a lie the same afternoon.
-- Existence is only a proxy for the work being done, which is the point of it
-- being a *proxy* — a person still has to sign the item with evidence that it
-- behaves. What existence rules out is signing one that cannot possibly work.
--
-- The two remaining blockers are outside the database (a dashboard screen, an
-- SMTP sender), so they are stated rather than checked, and clearing one is an
-- edit to this table by the phase that does the work.
--
-- ## The sign-off is an event, and the state is derived
--
-- `launch_sign_offs` is append-only, like `ledger` and `audit_log`, and the
-- current state of an item is the latest row for it. Withdrawing a sign-off is
-- a new row saying so rather than an update, for the reason a correction to the
-- ledger is an opposite entry: "who said this was fine, and when did they stop
-- saying it" is precisely the question asked after something goes wrong, and an
-- update erases the first half of the answer.
--
-- ## Scope: this is PayHold's checklist, not a tenant's
--
-- §16's items are about the platform — our legal entity, our provider
-- contracts, our incident-response plan — so there is no `tenant_id` here and
-- the rows are the same for everyone. A tenant connecting live keys is gated on
-- *our* readiness because it is our system their buyers' money would be moving
-- through. Their own onboarding is `sellers`/§12; their own market switches are
-- `payment_markets`.
--
-- §17's non-goals are deliberately **not** rows here. They are prohibitions
-- rather than tasks, nothing about them gets signed, and every one of them is
-- already refused by something structural — a missing endpoint, a check
-- constraint, a grant. `tests/launch-gate.test.ts` is where each is pinned.

-- ---------------------------------------------------------------------------
-- §17: no manual "mark as paid" control, anywhere
-- ---------------------------------------------------------------------------
--
-- The audit of §17 found six of its seven non-goals already refused by
-- something structural — a missing endpoint, a check constraint, a grant, an
-- unbuilt adapter that cannot be enabled. This is the seventh, and it was the
-- one held up only by habit.
--
-- `settle_payout` takes a provider reference and every caller passes one, but
-- nothing required it: the parameter is nullable, and `update payouts set
-- status = 'paid'` run by hand against the service role was a mark-as-paid
-- control with no provider on the other end of it. A seller would be recorded
-- as paid, `payouts_deal_key` would refuse a second payout for that deal, and
-- the reconciliation pass would report drift for money that never left.
--
-- A constraint rather than a guard inside the function, because §17 says
-- *anywhere*: a guard binds the callers we know about, and this binds the
-- correction somebody runs at 2am as well.
--
-- What it does not claim: that the reference is real. Only the rail can say
-- that, and re-fetching is what `reconcile` is for. It claims that whoever
-- marked this paid had to quote one.

alter table payouts
  add constraint paid_needs_a_provider_reference
  check (status <> 'paid' or provider_ref is not null);

-- ---------------------------------------------------------------------------
-- The items
-- ---------------------------------------------------------------------------

create type launch_item_kind as enum (
  /** Company, contracts, terms, notices — signed by a lawyer or a director. */
  'legal',
  /** A provider has confirmed in writing what we may do on their rail. */
  'provider',
  /** A process exists and somebody owns it: support, chargebacks, incidents. */
  'operational',
  /** Something in this repository has to be true, and a test can say so. */
  'engineering'
);

create table launch_checklist (
  /** Stable, referenced by the endpoint and by tests. Not a uuid. */
  code        text primary key,
  title       text not null,
  /** What signing this actually claims. Shown next to the button. */
  detail      text not null,
  kind        launch_item_kind not null,
  /** Set on §16's four market confirmations; null on everything else. */
  market      country_code,
  /**
   * Does the gate wait for it? A `false` item is on the list because §16 or
   * §26 names it, and is not worth holding a launch for on its own.
   */
  required    boolean not null default true,
  /**
   * The unbuilt work standing in the way, or null. A blocked item cannot be
   * signed off; the phase that builds the thing clears this in its own
   * migration, which is the only writer there will ever be.
   */
  blocked_by  text,
  sort_order  integer not null default 100,
  created_at  timestamptz not null default now()
);

alter table launch_checklist enable row level security;

-- PayHold's own compliance posture, not tenant data. A tenant is told the gate
-- is closed and how many items are outstanding — by the refusal message on the
-- connect call — and does not get to read our legal to-do list.
create policy launch_checklist_read on launch_checklist
  for select to authenticated using (is_platform_admin());

grant select on launch_checklist to authenticated;

-- ---------------------------------------------------------------------------
-- The sign-offs
-- ---------------------------------------------------------------------------

create table launch_sign_offs (
  id          uuid primary key default gen_random_uuid(),
  code        text not null references launch_checklist(code) on delete cascade,
  /** True signs, false withdraws. Both are rows; neither is an edit. */
  signed      boolean not null,
  /** A person. `verify_seller` takes one for the same reason. */
  actor       text not null,
  /**
   * Where the proof is: a contract reference, a ticket, a walkthrough run. An
   * attestation with no pointer is somebody's memory of a Tuesday.
   */
  evidence    text not null,
  created_at  timestamptz not null default now(),

  constraint sign_off_needs_an_actor check (length(trim(actor)) > 0),
  constraint sign_off_needs_evidence check (length(trim(evidence)) > 0)
);

create index launch_sign_offs_code_idx on launch_sign_offs(code, created_at desc);

alter table launch_sign_offs enable row level security;

create policy launch_sign_offs_read on launch_sign_offs
  for select to authenticated using (is_platform_admin());

grant select on launch_sign_offs to authenticated;

create or replace function reject_sign_off_mutation() returns trigger
language plpgsql
as $$
begin
  raise exception
    'launch sign-offs are append-only: % is not permitted. Withdraw by signing off with signed = false.',
    tg_op
    using errcode = 'restrict_violation';
end;
$$;

create trigger launch_sign_offs_no_update
  before update or delete on launch_sign_offs
  for each row execute function reject_sign_off_mutation();

-- ---------------------------------------------------------------------------
-- Reading the gate
-- ---------------------------------------------------------------------------

/**
 * Every item with its current state.
 *
 * The state is the latest sign-off row, which is why this is a function and not
 * a column: a stored `signed` flag would need a writer, and the writer would be
 * the thing that already wrote the event.
 */
create or replace function launch_status()
returns table (
  code       text,
  title      text,
  detail     text,
  kind       launch_item_kind,
  market     country_code,
  required   boolean,
  blocked_by text,
  signed     boolean,
  signed_by  text,
  signed_at  timestamptz,
  evidence   text
)
language sql
stable
as $$
  select
    i.code, i.title, i.detail, i.kind, i.market, i.required, i.blocked_by,
    coalesce(s.signed, false), s.actor, s.created_at, s.evidence
  from launch_checklist i
  left join lateral (
    select o.signed, o.actor, o.created_at, o.evidence
      from launch_sign_offs o
     where o.code = i.code
     order by o.created_at desc, o.id desc
     limit 1
  ) s on true
  order by i.sort_order, i.code;
$$;

grant execute on function launch_status() to authenticated, service_role;

/**
 * What is still standing between us and live money.
 *
 * Required items only. The refusal a tenant sees when they try to connect live
 * credentials counts these; the endpoint lists them for whoever can read them.
 */
create or replace function launch_blockers()
returns table (code text, title text, blocked_by text)
language sql
stable
as $$
  select s.code, s.title, s.blocked_by
    from launch_status() s
   where s.required and not s.signed;
$$;

grant execute on function launch_blockers() to authenticated, service_role;

/** Is PayHold allowed to take live money at all? */
create or replace function launch_gate_open()
returns boolean
language sql
stable
as $$
  select not exists (select 1 from launch_blockers());
$$;

grant execute on function launch_gate_open() to authenticated, service_role;

/**
 * Has a provider confirmed, in writing, that we may run marketplace payouts in
 * this market?
 *
 * This is what `rails_verified` on `/v1/payment-options` means. It used to be a
 * constant `false` in TypeScript with a comment promising somebody would change
 * it one day; a market with no confirmation item is unverified, which is the
 * same answer for every country outside the four §16 names.
 */
create or replace function market_launch_verified(p_country country_code)
returns boolean
language sql
stable
as $$
  select coalesce(
    (select s.signed from launch_status() s
      where s.kind = 'provider' and s.market = p_country limit 1),
    false
  );
$$;

grant execute on function market_launch_verified(country_code)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Signing one
-- ---------------------------------------------------------------------------

/**
 * Record that a launch item is done, or withdraw that.
 *
 * Shaped like `verify_seller`: one function rather than an insert a caller
 * could get wrong, a named actor because the row is about a person's statement,
 * and a refusal rather than a silent success when the claim cannot be true.
 *
 * A blocked item is refused **whatever the caller's authority**. The point of
 * `blocked_by` is that no amount of seniority makes an unwritten dispute window
 * resolve a dispute.
 */
create or replace function sign_off_launch_item(
  p_code     text,
  p_actor    text,
  p_evidence text,
  p_signed   boolean default true
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item launch_checklist;
begin
  select * into v_item from launch_checklist where code = p_code;

  if not found then
    raise exception 'not_found: no launch checklist item called %', p_code
      using errcode = 'no_data_found';
  end if;

  -- Withdrawing is always allowed. Blocked or not, "I no longer stand behind
  -- this" must never be the harder direction.
  if p_signed and v_item.blocked_by is not null then
    raise exception
      'policy_violation: % cannot be signed off while it is blocked by %',
      p_code, v_item.blocked_by
      using errcode = 'check_violation';
  end if;

  insert into launch_sign_offs (code, signed, actor, evidence)
  values (p_code, p_signed, p_actor, p_evidence);
end;
$$;

revoke all on function sign_off_launch_item(text, text, text, boolean) from public;
-- Explicit rather than inherited. §24.1: the AI role executes nothing that can
-- reach money, and an attestation that opens the gate on live credentials is
-- one step from all of it. A revoke by name is what `tests/intelligence.test.ts`
-- can check; relying on `public` would survive until somebody grants for a
-- reason that looked unrelated.
revoke all on function sign_off_launch_item(text, text, text, boolean) from payhold_ai;
grant execute on function sign_off_launch_item(text, text, text, boolean)
  to service_role;

-- ---------------------------------------------------------------------------
-- §16's list, as rows
-- ---------------------------------------------------------------------------
--
-- The wording of each `title` tracks §16's own sentence, so the list can be
-- diffed against the spec by eye. `detail` is what the person signing is
-- actually claiming, which is the part that stops a checklist becoming a row of
-- ticks somebody clicked through.

insert into launch_checklist (code, title, detail, kind, market, required, blocked_by, sort_order) values

  -- --- Legal and commercial: §16's first sentence ---------------------------
  ('legal_entities', 'Legal entities',
   'The operating company exists in each jurisdiction where PayHold contracts with a tenant or a provider, and its registration numbers are on file.',
   'legal', null, true, null, 10),

  ('provider_contracts', 'Provider contracts',
   'Signed agreements with Flutterwave and Stripe covering marketplace payments, held by the company rather than by an individual.',
   'legal', null, true, null, 20),

  ('merchant_accounts', 'Merchant accounts',
   'Live merchant accounts exist on every rail we intend to enable, and the test/live key pairs are distinct and separately stored.',
   'legal', null, true, null, 30),

  ('seller_terms', 'Seller terms',
   'Terms sellers accept before a payout destination is registered, covering the clearance window, reserves, refunds and how a dispute is decided.',
   'legal', null, true, null, 40),

  ('buyer_terms', 'Buyer terms',
   'Terms a buyer sees before paying, describing the hold, when money is released, and how to open a dispute. The language rule (§18) binds this text.',
   'legal', null, true, null, 50),

  ('privacy_notices', 'Privacy notices',
   'A published notice naming what we store, why, and for how long — including `request_context` addresses, which §23 keeps indefinitely by decision.',
   'legal', null, true, null, 60),

  ('refund_policy', 'Refund and cancellation rules',
   'The published rules a tenant''s buyers rely on, consistent with §7.1''s four lifecycle positions and with the asynchronous refund timing §7.1.6 warns about.',
   'legal', null, true, null, 70),

  ('tax_treatment', 'Tax treatment',
   'How collected tax is accounted for and remitted in each launch market. §7 books it as `fees_retained`, which is a ledger position and not an answer to this.',
   'legal', null, true, null, 80),

  -- --- Operational: the processes that need an owner ------------------------
  ('kyc_aml_procedures', 'KYC/AML procedures',
   'The written procedure behind `verify_seller` — what is checked, by whom, what is kept, and how often it is refreshed. §12 requires the attestation to mean something.',
   'operational', null, true, null, 90),

  ('sanctions_process', 'Sanctions process',
   'Who runs the screen, against which list, how a hit is escalated, and how `sanctions_checked_at` is kept from going stale.',
   'operational', null, true, null, 100),

  ('support_escalation', 'Support escalation path',
   'A named route from a stuck buyer or seller to a person who can act, including out of hours. §7.1.4''s post-payout refund escalates to exactly this.',
   'operational', null, true, null, 110),

  ('chargeback_process', 'Chargeback response process',
   'Who answers a chargeback, within what deadline, with what evidence. A chargeback during clearing lands on a deal with a payout already scheduled.',
   'operational', null, true, null, 120),

  ('data_retention', 'Data-retention policy',
   'What is deleted when. §23 keeps request context indefinitely so §24.4 has history to train on, and calls the stated purpose and the deletion path obligations rather than options.',
   'operational', null, true, null, 130),

  ('incident_response', 'Incident-response plan',
   'The runbook for a leaked key, a provider outage and a reconciliation freeze, naming who is called. §27''s triage is the technical half of it.',
   'operational', null, true, null, 140),

  ('penetration_test', 'Penetration test',
   'An external test against the deployed project, with findings closed or accepted in writing. §15 phase 8.',
   'operational', null, true, null, 150),

  ('secrets_review', 'Secrets review',
   'Every secret in §11''s table is set, held only where it belongs, and rotatable. `CREDENTIALS_KEY` is not in GitHub, in a build log, or on a laptop.',
   'operational', null, true, null, 160),

  ('compliance_sign_off', 'Compliance sign-off',
   'A named person has read this whole list and the §17 non-goals and agrees PayHold may take live money. Signed last, on purpose.',
   'operational', null, true, null, 170),

  ('cron_scheduled', 'Scheduled jobs are running',
   '`scripts/schedule-cron.sql` has been applied to this environment and `net._http_response` shows the four jobs returning 200. A deployed function nothing invokes is a job that silently never runs.',
   'operational', null, true, null, 180),

  -- --- §16's written provider confirmation, one per launch market -----------
  --
  -- The four markets §16 names. Each is separate because they are separate
  -- conversations with separate outcomes, and because `rails_verified` on
  -- `/v1/payment-options` answers per market — a client in Kigali should not be
  -- told a corridor is confirmed because a different one was.
  ('payout_confirmation_rw', 'Written payout confirmation — Rwanda',
   'Flutterwave has confirmed in writing that we may run marketplace payouts to Rwandan recipients under this account. Stripe cannot, which is why the corridor rides Flutterwave.',
   'provider', 'RW', true, null, 200),

  ('payout_confirmation_ae', 'Written payout confirmation — United Arab Emirates',
   'A provider has confirmed in writing that we may run marketplace payouts to recipients in the UAE.',
   'provider', 'AE', true, null, 210),

  ('payout_confirmation_cn', 'Written payout confirmation — Mainland China',
   'An approved local structure exists for Mainland China payouts. §5 forbids promising the corridor before one does, which is why both wallet rails ship disabled.',
   'provider', 'CN', true, null, 220),

  ('payout_confirmation_us', 'Written payout confirmation — United States',
   'Stripe has confirmed in writing that we may run Connect marketplace payouts to United States recipients under this account.',
   'provider', 'US', true, null, 230),

  -- --- §28's testing gate ---------------------------------------------------
  --
  -- Attestations, not tests: the suites in this repository run against PGlite,
  -- an intercepted `fetch` and `FakeProvider`. None of that is the real project,
  -- and RLS in particular is only proven there.
  ('walkthrough_money_path', 'Sandbox walkthrough — the money path',
   'Against the real project: pay with a test card and test mobile money, held, confirm twice, release, clearance, payout. Plus the refund path and the timer path.',
   'operational', null, true, null, 300),

  ('walkthrough_forged_webhook', 'Sandbox walkthrough — a forged webhook returns 401',
   'An inbound webhook with a wrong signature is refused on every rail, including `FakeProvider`, and nothing about the deal moves.',
   'operational', null, true, null, 310),

  ('walkthrough_tenancy', 'Sandbox walkthrough — the way in',
   'Sign up, land in an empty company, sign out, sign back in. A call with no bearer token returns 401; one carrying another company''s session returns that company''s nothing. RLS is only proven here.',
   'operational', null, true, null, 320),

  ('walkthrough_v2_paths', 'Sandbox walkthrough — the V2 paths',
   'A partial refund at each of §7.1''s four positions; a routing failure that falls back to a verified backup destination; a payout to an unverified seller that is refused; a country closed in data that disappears from checkout with no redeploy.',
   'operational', null, true, null, 330),

  -- --- Engineering items whose acceptance is code ---------------------------
  --
  -- These are why the gate is closed on the day it lands. The first three ask
  -- the catalogue whether the thing exists rather than claiming to know, so
  -- this migration is correct whether it runs before or after the phase that
  -- builds them.
  ('dispute_window', 'A dispute resolves inside its window without a person',
   '§8''s 48-hour offer window expires into the platform rule, and a dispute freezes release and payout for the disputed amount only. §15 phase 4''s acceptance.',
   'engineering', null, true,
   case when to_regclass('public.dispute_offers') is null
        then 'phase-8 (Resolution Center): `dispute_offers` does not exist' end, 400),

  ('reconciliation_runs', 'Every reconciliation pass leaves a run record',
   '§13''s run record — provider, period, matched, missing, mismatched, resolution — alongside the alert. A mismatch produces a case and never silently alters a balance.',
   'engineering', null, true,
   case when to_regclass('public.reconciliation_runs') is null
        then 'phase-9 (Reconciliation runs): `reconciliation_runs` does not exist' end, 410),

  ('payout_retry', 'A failed payout retries with backoff, then waits for a person',
   '§13: capped exponential backoff, then blocked for an operator. A retry that is only ever a person pressing a button is safe, and is not what §13 describes.',
   'engineering', null, true,
   case when to_regprocedure('public.reset_payout_retry(uuid, text)') is null
        then 'phase-9 (failure handling): automatic retry with backoff is not built' end, 420),

  ('operator_screens', 'An operator can read what they are being asked to decide',
   'A held payout shows its routing decision and reason codes, the seller''s KYC state, the dispute behind it and the reconciliation run that froze the tenant. Invariant 11 puts a person on the button; they need the case in front of them.',
   'engineering', null, true, 'phase-10 (Dashboard): the Routing Center, Resolution Center and reconciliation screens are not built', 430),

  ('email_confirmation', 'A signed-up address is proven',
   '`auth.email.enable_confirmations` is on with a real SMTP sender. Today addresses are confirmed on creation because there is no way to send anything, so a dashboard login''s address is unproven — and that session reads every deal a company has.',
   'engineering', null, true, 'no SMTP sender: `config.toml` has no `[auth.email.smtp]` block', 440),

  -- On the list because §26 names it, and not worth holding a launch for: the
  -- money path does not depend on it. `auto_release_at` is what actually
  -- protects a seller whose buyer has gone quiet.
  ('reminders_cron', 'Reminders',
   '§26''s fifth job. It needs a channel to remind people on before it can be a function, and the auto-release timer already covers the money.',
   'engineering', null, false, 'no notification channel decided', 450);
