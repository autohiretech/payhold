-- `dispute_decision_relay` — a tenant decides its own disputes and tells PayHold
-- the outcome, over its own API key. PayHold still holds the money and still
-- moves it.
--
-- The refusal this opens a door beside is the right one and stays. §8's final
-- decision is an administrator's judgement, and `POST /v1/disputes/:id/resolve`
-- has refused an API key since it was written: a client able to resolve its own
-- disputes from its own server has turned the Resolution Center into a
-- formality. What that leaves with nowhere to go is a platform whose own admins
-- genuinely hear both sides — AutoHire's admin screen, where the renter and the
-- host are real accounts with real histories — and then have to sign in to a
-- second dashboard and decide again. The second decision is not a check. It is a
-- transcription, the argument `20260910000011` made about seller verification.
--
-- So this is the same shape as that relay, with one deliberate difference.
--
-- **Off by default, and it must stay that way.** `seller_verification_relay`
-- went on by default in `20260911000001` because a relayed verification can only
-- ever *stop* a payout being blocked on paperwork — every gate downstream still
-- reads the columns it always read. A relayed dispute decision moves money the
-- instant it lands: a release, a refund or a split, with no gate after it. An
-- account that never opened Settings has made no statement at all, and moving a
-- buyer's money on a statement nobody made is not a default this file will set.
-- The owner turns it on, from Settings, and the settings row is the audit of
-- who did.
--
-- ## What PayHold can and cannot vouch for
--
-- On this path PayHold authenticates a **credential**, not a person. The request
-- names the human who decided (`decided_by`, e.g.
-- "autohire-admin:jane@example.com"), and that name is the platform's claim —
-- nothing here can check it. So it is stored as exactly that:
--
--   disputes.decided_by        the credential, `api_key:<label>` — the one party
--                              PayHold actually authenticated
--   disputes.reported_decider  the name the platform reported
--   disputes.decider_source    `platform_reported`, beside `person` (a signed-in
--                              user here, or an AI draft's approver) and
--                              `both_parties` (the two sides agreed)
--
-- `decided_by` holding the credential rather than the name is the fail-safe
-- choice: every reader written before this column existed — the timeline, the
-- export, the `dispute.resolved` webhook, the dashboard — shows the credential,
-- and none of them can present an unverified name as a PayHold decider by not
-- knowing to look. The audit row's actor is the credential for the same reason
-- `verify_seller`'s relayed row is: an audit row must never answer "who did this"
-- with a person who was not the caller.
--
-- ## Conflict of interest, relayed
--
-- §8's control is on who *acted* (`20260807000017`'s header), and it keeps
-- working on the reported name: a platform admin who raised this dispute, made a
-- request on it or answered one cannot be reported as its decider.
--
-- The credential needs a narrower rule, and the trade-off is stated rather than
-- buried. A platform opens disputes and makes requests with the **same key** it
-- relays decisions with — AutoHire's server raises a renter's complaint as
-- `api_key:AutoHire live`, and relays its admin's ruling as the same credential.
-- Refusing the credential for having acted would make relaying impossible for
-- every dispute a platform ever raised, which is all of them. So the credential
-- is allowed to have acted **when a distinct human decider is reported**, and
-- refused otherwise. That is acceptable for one reason: the tenant opted in. Its
-- owner stated, person-only and once for the account, that its own platform
-- decides — and the conflict check that still applies is the one about the
-- person that statement is about.
--
-- ## Retries do not move money twice
--
-- A platform's server retries. On the relayed path, a dispute already resolved
-- the way the request asks is returned unchanged — no ledger entry, no audit
-- row, no webhook — and one resolved any other way is refused as
-- `dispute_already_resolved` rather than `invalid_state`, so the platform can
-- tell "you already told us that" from "somebody decided differently". A split is
-- the same outcome only at the same amount, which is what
-- `resolution_refund_amount` is recorded for. The dashboard path is untouched:
-- a person resolving a resolved dispute still gets `invalid_state`.
--
-- ## Two smaller things in the same file
--
-- * **`decide_ai_suggestion` refuses an API key.** `ai-decisions` only ever
--   called `requireRole`, which lets every API key straight through, and nothing
--   in SQL asked what kind of caller had arrived — so an approved AI draft was an
--   unintended API-key route to `resolve_dispute`. It is closed whether or not
--   the relay is on: the relay is the only API-key route to a resolution, and it
--   is the one that records a reported decider and re-checks the setting.
-- * **`dispute.opened` carries the dispute.** It was emitted with `data: {}`, so
--   a client had to call back to learn which dispute, raised by whom, about how
--   much. It now carries `dispute_id`, `raised_by`, `reason`, `reason_code` and
--   `disputed_amount` (null for the whole payment). Additive: every key the
--   envelope had is still there. `open_dispute` inserts the dispute before it
--   moves the deal, so the row is visible to the deal's trigger; a deal disputed
--   by `fund_deal`'s amount mismatch has no dispute row, and those keys are null.

-- ---------------------------------------------------------------------------
-- The setting
-- ---------------------------------------------------------------------------

create or replace function dispute_decision_relay(p_tenant uuid) returns boolean
language sql
stable
as $$
  select setting_num(p_tenant, 'dispute_decision_relay', 0) <> 0;
$$;

comment on function dispute_decision_relay(uuid) is
  'Whether this tenant''s owner has attested that their own platform decides '
  'disputes and will report each outcome over the API. Off by default '
  '(20260911000002) — a relayed decision moves money. Read only by '
  '`resolve_dispute`, under the dispute''s row lock.';

grant execute on function dispute_decision_relay(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- What a decision records
-- ---------------------------------------------------------------------------

alter table disputes
  -- The platform's claim about who decided. Only ever set on a relayed decision.
  add column if not exists reported_decider text,

  -- Which kind of decider `decided_by` is. Null only on a row resolved before
  -- this column existed and still open ones — backfilled below.
  add column if not exists decider_source text,

  -- What a `partial_refund` resolution returned to the buyer, presentment minor
  -- units. Recorded so a retried split can be told apart from a different one.
  add column if not exists resolution_refund_amount bigint;

alter table disputes
  add constraint disputes_decider_source_known
    check (decider_source in ('person', 'both_parties', 'platform_reported')),
  add constraint disputes_reported_decider_shape
    check (
      (decider_source = 'platform_reported'
        and reported_decider is not null and btrim(reported_decider) <> '')
      or (decider_source is distinct from 'platform_reported'
        and reported_decider is null)
    ),
  add constraint disputes_resolution_refund_amount_positive
    check (resolution_refund_amount > 0);

-- Every existing decision was made by a signed-in person here or by the two
-- sides agreeing — no API key could reach `resolve_dispute` before this file.
-- No trigger fires on this: `disputes_notify_resolved_t` wants `old.status =
-- 'open'`, and the other two are `update of status`.
update disputes
   set decider_source = case when decided_by = 'both-parties' then 'both_parties'
                             else 'person' end
 where decided_by is not null
   and decider_source is null;

-- ---------------------------------------------------------------------------
-- Resolving
-- ---------------------------------------------------------------------------
--
-- A signature change, so dropped and recreated, and a recreated function is
-- granted to PUBLIC again — the revokes at the bottom are reissued for that
-- reason. Everything that moves money is `20260807000017`'s body line for line;
-- the two new arguments decide who is recorded and whether the call is allowed.

drop function if exists resolve_dispute(uuid, text, text, bigint, currency_code, bigint, bigint, text);

create function resolve_dispute(
  p_dispute_id       uuid,
  p_resolution       text,
  p_note             text,
  p_payout_amount    bigint,
  p_payout_currency  currency_code,
  p_fee_presentment  bigint,
  -- Only for `partial_refund`: what goes back to the buyer, presentment.
  p_refund_amount    bigint default null,
  -- Who is recorded as deciding. A signed-in person's actor, `both-parties`,
  -- or — on the relayed path — the credential that relayed it.
  p_decided_by       text default null,
  -- The platform's claim about the human who decided. Required on the relayed
  -- path, refused on every other.
  p_reported_decider text default null,
  -- The caller is a tenant's own server. Refused unless that tenant's
  -- `dispute_decision_relay` is on.
  p_via_api_key      boolean default false
) returns disputes
language plpgsql
security definer
set search_path = public
as $$
declare
  dsp            disputes;
  d              deals;
  v_scale        numeric;
  v_payout       bigint;
  v_conflict     boolean;
  v_relayed      boolean;
  v_reported     text;
  v_named        text;
  v_source       text;
  v_stored       text;
  v_from_deal    deals.status%type;
  v_from_dispute disputes.status%type;
  v_refund_actor text;
begin
  if p_decided_by is null or btrim(p_decided_by) = '' then
    raise exception 'policy_violation: a resolution must record who decided it'
      using errcode = 'check_violation';
  end if;

  -- An `api_key:` decider is a relayed decision whatever the flag says. The flag
  -- is what an honest caller passes; the prefix is what catches a caller written
  -- without it, which is the reason a policy lives in SQL at all.
  v_relayed := coalesce(p_via_api_key, false) or p_decided_by like 'api_key:%';
  v_reported := nullif(btrim(p_reported_decider), '');

  if not v_relayed and p_reported_decider is not null then
    raise exception 'policy_violation: only a decision relayed over an API key carries a reported decider — a person here decides in their own name'
      using errcode = 'check_violation';
  end if;

  if v_relayed then
    if v_reported is null then
      raise exception 'invalid_request: decided_by is required — name the person on your platform who decided this dispute'
        using errcode = 'check_violation';
    end if;
    if length(v_reported) > 200 then
      raise exception 'invalid_request: decided_by must be 200 characters or fewer'
        using errcode = 'check_violation';
    end if;
    -- `both-parties` is the one name the conflict check lets through, and a
    -- credential is not a person. Reporting either would be reporting nobody.
    if v_reported = 'both-parties' or v_reported like 'api_key:%' then
      raise exception 'invalid_request: decided_by must name the person who decided, not %', v_reported
        using errcode = 'check_violation';
    end if;
  end if;

  select * into dsp from disputes where id = p_dispute_id for update;

  if not found then
    raise exception 'not_found: dispute % does not exist', p_dispute_id
      using errcode = 'no_data_found';
  end if;

  -- Asked under the dispute's lock, because the tenant whose attestation governs
  -- this call is the dispute's and the request names only the dispute. The
  -- check in `functions/disputes` produces the sentence; this is the rule.
  if v_relayed and not dispute_decision_relay(dsp.tenant_id) then
    raise exception 'dispute_relay_off: this account has not turned on "My platform decides disputes and tells PayHold the outcome" in PayHold Settings, so only a signed-in person there may decide dispute %', dsp.id
      using errcode = 'check_violation';
  end if;

  if dsp.status <> 'open' then
    -- See the header: a retry of the same outcome is not a second decision.
    if v_relayed then
      v_stored := case dsp.status
                    when 'resolved_released' then 'release'
                    when 'resolved_refunded' then 'refund'
                    when 'resolved_split'    then 'partial_refund'
                  end;

      if v_stored = p_resolution
         and (p_resolution <> 'partial_refund'
              or dsp.resolution_refund_amount is not distinct from p_refund_amount) then
        return dsp;
      end if;

      raise exception 'dispute_already_resolved: this dispute was already resolved as % and cannot be resolved again as %',
        coalesce(v_stored, dsp.status::text), p_resolution
        using errcode = 'check_violation';
    end if;

    raise exception 'invalid_state: this dispute is already resolved'
      using errcode = 'check_violation';
  end if;

  -- Captured before anything below rewrites a record. `update … returning * into`
  -- overwrites the whole variable, and an audit row reading the status afterwards
  -- records the one value from_status cannot mean — `20260909000007`'s bug.
  v_from_dispute := dsp.status;

  -- §8's conflict-of-interest control, on the person the decision is about: the
  -- reported name on the relayed path, the signed-in actor otherwise.
  -- `both-parties` is the one name allowed to have acted — it is what
  -- `respond_dispute_offer` writes when the two sides agreed with each other,
  -- and the relayed path refused it above.
  v_named := coalesce(v_reported, p_decided_by);

  if v_named <> 'both-parties' then
    select coalesce(dsp.raised_by_actor = v_named, false)
        or exists (select 1 from dispute_offers o
                    where o.dispute_id = dsp.id
                      and (o.offered_by_actor = v_named
                           or o.responded_by_actor = v_named))
      into v_conflict;

    if v_conflict then
      raise exception 'policy_violation: % acted for a party in this dispute and cannot decide it', v_named
        using errcode = 'check_violation';
    end if;
  end if;

  -- The credential itself. A platform raises and answers disputes with the same
  -- key it relays decisions with, so the key having acted is allowed **only while
  -- a distinct human decider is reported** — see the header for why that is
  -- acceptable: the tenant opted in to its platform deciding. The checks above
  -- make a distinct name mandatory today; this stays so that loosening them
  -- cannot quietly let a credential rule on a dispute it argued.
  if v_relayed and (v_reported is null or v_reported = p_decided_by) then
    select coalesce(dsp.raised_by_actor = p_decided_by, false)
        or exists (select 1 from dispute_offers o
                    where o.dispute_id = dsp.id
                      and (o.offered_by_actor = p_decided_by
                           or o.responded_by_actor = p_decided_by))
      into v_conflict;

    if v_conflict then
      raise exception 'policy_violation: % acted for a party in this dispute and cannot decide it without naming a person who did not', p_decided_by
        using errcode = 'check_violation';
    end if;
  end if;

  select * into d from deals where id = dsp.deal_id for update;
  v_from_deal := d.status;

  -- The refund row and its audit name whoever actually asked for it. On the
  -- dashboard path that is unchanged; on the relayed path it is the credential,
  -- not a PayHold staff member who was never involved.
  v_refund_actor := case when v_relayed then p_decided_by else 'payhold-staff' end;

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
                        v_refund_actor);
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
                        v_refund_actor, p_refund_amount);

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

  v_source := case when v_relayed then 'platform_reported'
                   when p_decided_by = 'both-parties' then 'both_parties'
                   else 'person' end;

  update disputes
     set status = dsp.status,
         resolved_at = now(),
         resolution_note = p_note,
         decided_by = p_decided_by,
         reported_decider = v_reported,
         decider_source = v_source,
         resolution_refund_amount = case when p_resolution = 'partial_refund'
                                         then p_refund_amount end
   where id = dsp.id
  returning * into dsp;

  -- Any request still outstanding is moot now, and leaving it open would block
  -- the next dispute on this order through `dispute_offers_one_open_per_deal`.
  update dispute_offers
     set status = 'withdrawn', responded_at = now(),
         responded_by_actor = p_decided_by
   where dispute_id = dsp.id and status = 'open';

  -- The actor is `p_decided_by`: a person here, `both-parties`, or the
  -- credential. The reported name rides in the details, labelled as reported.
  perform write_audit(d.tenant_id, d.id, p_decided_by, 'dispute.resolved',
                      jsonb_build_object(
                        'resolution', p_resolution,
                        'refund_amount', p_refund_amount,
                        'note', p_note,
                        'dispute_id', dsp.id,
                        'from_status', v_from_deal,
                        'dispute_from_status', v_from_dispute,
                        'decider_source', v_source,
                        'reported_decider', v_reported
                      ));

  return dsp;
end;
$$;

comment on function resolve_dispute(uuid, text, text, bigint, currency_code, bigint, bigint, text, text, boolean) is
  '§8''s final decision. `p_via_api_key` (or an `api_key:` decider) marks a '
  'decision relayed by a tenant''s own server: refused unless that tenant''s '
  '`dispute_decision_relay` is on, recorded against the credential with the '
  'platform''s named decider as `reported_decider`, and idempotent for a retry of '
  'the same outcome.';

-- ---------------------------------------------------------------------------
-- An AI draft is approved by a person, never by a key
-- ---------------------------------------------------------------------------
--
-- Same body as `20260807000017`, with the refusal first. A signature change, so
-- dropped and recreated, and the revoke reissued below.

drop function if exists decide_ai_suggestion(uuid, ai_decision, text, bigint, currency_code, bigint);

create function decide_ai_suggestion(
  p_suggestion_id   uuid,
  p_decision        ai_decision,
  p_decided_by      text,
  p_payout_amount   bigint default null,
  p_payout_currency currency_code default null,
  p_fee_presentment bigint default null,
  -- The caller is a tenant's server. Always refused — see this file's header.
  p_via_api_key     boolean default false
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
  -- Invariant 9's bridge takes a person. Checked on the flag and on the actor's
  -- shape, so a caller that forgot to pass the flag is still caught.
  if coalesce(p_via_api_key, false) or coalesce(p_decided_by like 'api_key:%', false) then
    raise exception 'forbidden: an AI draft is approved or rejected by a signed-in person, never by an API key'
      using errcode = 'insufficient_privilege';
  end if;

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
-- The readers that show a decider
-- ---------------------------------------------------------------------------

-- Same columns, so `create or replace` keeps the grant. Only the `resolved` row
-- changes: its details say which kind of decider the actor is and, when a
-- platform reported one, whom it named — so a screen can say "reported by" rather
-- than render a claim as a PayHold user.
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
         jsonb_build_object('status', d.status,
                            'decider_source', d.decider_source,
                            'reported_decider', d.reported_decider)
    from dsp d where d.resolved_at is not null

  order by 1;
$$;

-- `dispute.resolved` gains the two keys, additively. `decided_by` keeps its
-- meaning — whom PayHold recorded — which on the relayed path is the credential.
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
                         'decided_by', new.decided_by,
                         'decider_source', new.decider_source,
                         'reported_decider', new.reported_decider));
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- `dispute.opened` says which dispute
-- ---------------------------------------------------------------------------
--
-- `20260807000002`'s body, with the `disputed` branch filled in and nothing else
-- touched. The trigger itself is unchanged and keeps pointing here.

create or replace function emit_deal_event() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  dsp disputes;
begin
  if new.status is not distinct from old.status then
    return new;
  end if;

  case new.status
    when 'payment_pending' then
      perform enqueue_webhooks(new.tenant_id, new.id, 'order.payment_pending', jsonb_build_object(
        'payment_method', new.payment_method
      ));
    when 'payment_failed' then
      perform enqueue_webhooks(new.tenant_id, new.id, 'payment.failed', '{}'::jsonb);
    when 'funded_held' then
      perform enqueue_webhooks(new.tenant_id, new.id, 'order.funded_held', jsonb_build_object(
        'amount', new.amount,
        'currency', new.currency,
        'presentment_amount', new.presentment_amount,
        'presentment_currency', new.presentment_currency,
        'payment_method', new.payment_method,
        'auto_release_at', new.auto_release_at
      ));
    when 'clearing' then
      -- V1 called this `deal.released`, and the name was accurate for what it
      -- described: money out of the hold, clearance clock started. §10.2 splits
      -- that into two observable moments and this is the first of them.
      perform enqueue_webhooks(new.tenant_id, new.id, 'order.clearing_started', jsonb_build_object(
        'fee_amount', new.fee_amount,
        'net', new.amount - new.fee_amount,
        'payout_due_at', new.payout_due_at
      ));
    when 'released' then
      perform enqueue_webhooks(new.tenant_id, new.id, 'order.released', jsonb_build_object(
        'payout_due_at', new.payout_due_at
      ));
    when 'payout_pending' then
      perform enqueue_webhooks(new.tenant_id, new.id, 'payout.pending', '{}'::jsonb);
    when 'refunded' then
      perform enqueue_webhooks(new.tenant_id, new.id, 'refund.succeeded', jsonb_build_object(
        'amount', new.presentment_amount,
        'currency', new.presentment_currency
      ));
    when 'disputed' then
      -- `open_dispute` inserts the dispute before it moves the deal, so the
      -- open row is visible here. One open dispute per deal is an index, so
      -- there is no choosing; a deal disputed without one (`fund_deal`'s amount
      -- mismatch) sends the same keys, null.
      select * into dsp
        from disputes
       where deal_id = new.id and status = 'open'
       order by opened_at desc
       limit 1;

      perform enqueue_webhooks(new.tenant_id, new.id, 'dispute.opened', jsonb_build_object(
        'dispute_id', dsp.id,
        'raised_by', dsp.raised_by,
        'reason', dsp.reason,
        'reason_code', dsp.reason_code,
        -- Null means the whole payment, as it does on the dispute.
        'disputed_amount', dsp.disputed_amount
      ));
    when 'paid_out' then
      perform enqueue_webhooks(new.tenant_id, new.id, 'payout.paid', '{}'::jsonb);
    when 'canceled' then
      perform enqueue_webhooks(new.tenant_id, new.id, 'order.canceled', '{}'::jsonb);
    when 'expired' then
      perform enqueue_webhooks(new.tenant_id, new.id, 'order.expired', '{}'::jsonb);
    else
      -- confirmed_buyer / confirmed_seller are emitted from the confirmations
      -- table instead: the row records which side and whether the timer did it,
      -- and the deal's status alone cannot say. in_progress and
      -- revision_requested have no writer yet.
      null;
  end case;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants — reissued because both functions were recreated
-- ---------------------------------------------------------------------------

revoke all on function resolve_dispute(uuid, text, text, bigint, currency_code, bigint, bigint, text, text, boolean)
  from public, anon, authenticated;
revoke all on function resolve_dispute(uuid, text, text, bigint, currency_code, bigint, bigint, text, text, boolean)
  from payhold_ai;

revoke all on function decide_ai_suggestion(uuid, ai_decision, text, bigint, currency_code, bigint, boolean)
  from public, anon, authenticated;
revoke all on function decide_ai_suggestion(uuid, ai_decision, text, bigint, currency_code, bigint, boolean)
  from payhold_ai;
