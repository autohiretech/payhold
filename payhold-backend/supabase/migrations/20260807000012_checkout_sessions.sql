-- ---------------------------------------------------------------------------
-- V2 §10.1: hosted checkout sessions
-- ---------------------------------------------------------------------------
--
-- One migration rather than the two-file split the last four phases needed:
-- nothing here uses a value added by `alter type ... add value`.
-- `checkout_session_status` is a brand new type, and a type created inside a
-- transaction is usable inside it.
--
-- ## What a session is for
--
-- Today `POST /v1/deals/:id/pay` does the whole thing in one call, with the
-- **client's API key**: their server picks the method on the buyer's behalf,
-- we call the provider, and we hand back a payment link. That works, and it
-- means the buyer's choice of wallet has to travel through the client's server
-- because the buyer holds no credential of their own.
--
-- A session is that credential, scoped to one payment on one deal and expiring.
-- The buyer opens a hosted page with it, chooses a method there, and is handed
-- to the provider — without the client proxying the choice, and without anyone
-- inventing a general end-user auth scheme to do it.
--
-- It is also what finally gives **`checkout_started`** a writer. The state has
-- been declared and unreachable since Phase 1, which named this phase as the
-- one that would fill it.
--
-- ## What a session is emphatically NOT
--
-- §15 phase 2's acceptance test: *"test payments cannot be marked successful
-- without verified provider events."* That already holds, and the whole risk of
-- this phase is that a session object becomes the way around it.
--
-- So: **no function here can reach `funded_held`, and none writes a ledger
-- entry.** Completing a session means the buyer finished the hosted flow and
-- was handed to the provider — the deal reaches `payment_pending` and stops,
-- exactly as `/pay` already leaves it. `funded_held` still comes only from a
-- provider webhook that verified its signature *and* re-fetched the
-- transaction. `tests/checkout-sessions.test.ts` asserts both halves.
--
-- That is also what `checkout.completed` means on the wire, and why it does not
-- overlap `order.funded_held`: one says the buyer is done with our page, the
-- other says money arrived. A client showing "waiting for the buyer" wants the
-- first; a client shipping goods wants the second.

create type checkout_session_status as enum (
  /** Live, and the buyer may pay with it. */
  'open',
  /** The buyer chose a method and was handed to the provider. */
  'completed',
  /** Withdrawn by the client before the buyer used it. */
  'canceled'
);

-- Note what is absent: `expired`. It is **derived** from `expires_at`, for the
-- same reason §5.1's `clearing` and `available` are derived from the deal's
-- window — a stored value would need a writer, and the writer would be a cron
-- pass that had not run yet. Deriving it means an expired session is refused
-- from the instant it expires rather than from the next sweep, and the check
-- sits at the point of use where it protects something.

create table checkout_sessions (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  deal_id      uuid not null references deals(id) on delete cascade,
  /**
   * The bearer token in the hosted page's URL.
   *
   * **Stored in plaintext, deliberately, unlike an API key.** The reasoning
   * that makes hashing right for a key does not transfer: a key is a long-lived
   * server credential that is only ever *compared*, so we never need it back. A
   * checkout token has to stay re-derivable, because "re-send the payment link"
   * is an ordinary support action and a client who lost the URL would otherwise
   * have to cancel and re-issue.
   *
   * What limits the damage instead is scope and time. It authorises exactly one
   * action — pay this one deal — it expires, and it is no broader than the
   * deal id that already opens today's `/pay/:id` page. 256 bits from
   * `gen_random_bytes`, so it is not guessable the way a uuid path segment
   * arguably is.
   */
  token        text not null unique,
  status       checkout_session_status not null default 'open',
  /**
   * Where the buyer is returned. Held on the session rather than passed at pay
   * time so a tampered return_url cannot be injected by whoever opens the link.
   */
  return_url   text,
  /** What the buyer chose. Null until they choose. */
  method       payment_method,
  network      text,
  /** The rail that actually took it — the provisional one may not survive. */
  provider     provider,
  /** The provider's charge reference, and where to send the buyer. */
  provider_ref text,
  payment_link text,
  expires_at   timestamptz not null,
  completed_at timestamptz,
  created_at   timestamptz not null default now(),

  constraint completed_at_matches_status
    check ((status = 'completed') = (completed_at is not null))
);

-- **One live session per deal.** Two open sessions would be two live payment
-- links against one hold, and a buyer following the older one would start a
-- second charge for the same booking. `open_checkout_session` returns the
-- existing open session rather than minting a second, which also makes a client
-- retrying the call idempotent instead of leaving a stranded link behind.
create unique index checkout_sessions_one_open
  on checkout_sessions(deal_id) where status = 'open';

create index checkout_sessions_tenant_idx on checkout_sessions(tenant_id, created_at desc);
create index checkout_sessions_deal_idx on checkout_sessions(deal_id);

alter table checkout_sessions enable row level security;

create policy checkout_sessions_read on checkout_sessions
  for select to authenticated
  using (tenant_id in (select current_tenant_ids()) or is_platform_admin());

grant select on checkout_sessions to authenticated;

-- ---------------------------------------------------------------------------
-- The derived state
-- ---------------------------------------------------------------------------

/**
 * `open | completed | canceled | expired`, with expiry worked out rather than
 * stored. Every reader goes through this; nothing compares `status` directly.
 */
create or replace function checkout_session_state(s checkout_sessions)
returns text
language sql
stable
as $$
  select case
    when s.status = 'open' and s.expires_at <= now() then 'expired'
    else s.status::text
  end;
$$;

grant execute on function checkout_session_state(checkout_sessions)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Opening one
-- ---------------------------------------------------------------------------
--
-- The deal moves to `checkout_started`, which says a buyer has somewhere to pay
-- and has not paid. `payment_pending` means a charge is actually with a rail,
-- and the two being separate states is §6's doing — a session that had to skip
-- straight to `payment_pending` would make "the buyer opened the link" and "the
-- buyer's card is being charged" the same fact.

create or replace function open_checkout_session(
  p_deal       uuid,
  p_hours      integer default 24,
  p_return_url text default null
) returns checkout_sessions
language plpgsql
security definer
set search_path = public
as $$
declare
  d       deals;
  session checkout_sessions;
begin
  select * into d from deals where id = p_deal for update;

  if not found then
    raise exception 'not_found: deal % does not exist', p_deal
      using errcode = 'no_data_found';
  end if;

  -- `payment_failed` is here so a declined card gets a fresh link without the
  -- client creating a second deal for the same booking. `payment_pending` is
  -- not: a buyer mid-payment on one rail must not be handed a second link, or
  -- two charges race for one hold.
  if d.status not in ('created', 'checkout_started', 'payment_failed') then
    raise exception 'invalid_state: deal % is %, so a checkout cannot be opened',
      p_deal, d.status
      using errcode = 'check_violation';
  end if;

  -- Idempotent by design — see `checkout_sessions_one_open`. A client retrying
  -- gets the link they already have rather than a second live one.
  select * into session
    from checkout_sessions
   where deal_id = p_deal and status = 'open' and expires_at > now();

  if found then
    return session;
  end if;

  -- An open-but-expired session is closed on the way past. This is the one
  -- place a write is worth doing, because otherwise the partial unique index
  -- would refuse the replacement.
  update checkout_sessions
     set status = 'canceled'
   where deal_id = p_deal and status = 'open';

  insert into checkout_sessions (tenant_id, deal_id, token, return_url, expires_at)
  values (
    d.tenant_id,
    d.id,
    -- 256 bits, base64url. `gen_random_bytes` rather than a uuid: a uuid is 122
    -- bits of randomness wearing a recognisable shape, and this is the only
    -- thing standing between a stranger and somebody's payment page.
    translate(encode(gen_random_bytes(32), 'base64'), '+/=', '-_'),
    p_return_url,
    now() + make_interval(hours => greatest(p_hours, 1))
  )
  returning * into session;

  update deals set status = 'checkout_started'
   where id = d.id and status in ('created', 'payment_failed');

  perform write_audit(d.tenant_id, d.id, 'system', 'checkout.opened',
    jsonb_build_object('session_id', session.id, 'expires_at', session.expires_at));

  return session;
end;
$$;

-- ---------------------------------------------------------------------------
-- Completing one
-- ---------------------------------------------------------------------------
--
-- **This is the function §15 phase 2 is about.** Read the state changes: the
-- session becomes `completed` and the deal becomes `payment_pending`. There is
-- no ledger write, no `funded_held`, and no argument that could produce one.
--
-- The Edge Function calls the provider *first* and this second, for the reason
-- `/pay` does the same: a charge that threw never started, and a deal left in
-- `payment_pending` by a rail that refused it would be unretryable.

create or replace function complete_checkout_session(
  p_session      uuid,
  p_method       payment_method,
  p_network      text,
  p_provider     provider,
  p_provider_ref text,
  p_payment_link text
) returns checkout_sessions
language plpgsql
security definer
set search_path = public
as $$
declare
  session checkout_sessions;
  d       deals;
begin
  select * into session from checkout_sessions where id = p_session for update;

  if not found then
    raise exception 'not_found: checkout session % does not exist', p_session
      using errcode = 'no_data_found';
  end if;

  if checkout_session_state(session) <> 'open' then
    raise exception 'invalid_state: this checkout session is %',
      checkout_session_state(session)
      using errcode = 'check_violation';
  end if;

  select * into d from deals where id = session.deal_id for update;

  update checkout_sessions
     set status = 'completed',
         completed_at = now(),
         method = p_method,
         network = p_network,
         provider = p_provider,
         provider_ref = p_provider_ref,
         payment_link = p_payment_link
   where id = session.id
  returning * into session;

  -- The rail is recorded now so an operator sees where the payment went while
  -- it is still pending. The hold waits for the webhook, as it always has.
  update deals
     set provider = p_provider,
         payment_method = p_method,
         payment_network = p_network,
         status = 'payment_pending'
   where id = d.id;

  perform write_audit(d.tenant_id, d.id, 'buyer', 'checkout.completed',
    jsonb_build_object(
      'session_id', session.id,
      'provider', p_provider,
      'method', p_method,
      'network', p_network
    ));

  -- §10.2. Distinct from `order.funded_held` on purpose: this says the buyer is
  -- done with our page, that one says money arrived, and a client that conflated
  -- them would ship goods against a card that has not settled.
  perform enqueue_webhooks(d.tenant_id, d.id, 'checkout.completed',
    jsonb_build_object(
      'session_id', session.id,
      'method', p_method,
      'network', p_network,
      'provider', p_provider
    ));

  return session;
end;
$$;

-- ---------------------------------------------------------------------------
-- Withdrawing one
-- ---------------------------------------------------------------------------
--
-- The deal goes back to `created` only if nothing else has happened to it. A
-- deal that has moved on — funded, disputed, canceled — keeps its own status,
-- because a withdrawn payment link is not a statement about any of that.

create or replace function cancel_checkout_session(p_session uuid, p_actor text)
returns checkout_sessions
language plpgsql
security definer
set search_path = public
as $$
declare
  session checkout_sessions;
begin
  select * into session from checkout_sessions where id = p_session for update;

  if not found then
    raise exception 'not_found: checkout session % does not exist', p_session
      using errcode = 'no_data_found';
  end if;

  if session.status = 'completed' then
    raise exception 'invalid_state: this checkout session has already been used'
      using errcode = 'check_violation';
  end if;

  update checkout_sessions set status = 'canceled'
   where id = session.id
  returning * into session;

  update deals set status = 'created'
   where id = session.deal_id and status = 'checkout_started';

  perform write_audit(session.tenant_id, session.deal_id, p_actor, 'checkout.canceled',
    jsonb_build_object('session_id', session.id));

  return session;
end;
$$;

-- ---------------------------------------------------------------------------
-- One new edge in the transition guard
-- ---------------------------------------------------------------------------
--
-- `checkout_started -> created`: the payment link was withdrawn.
--
-- It is the only backwards edge in the machine and it earns its place. Nothing
-- has happened to the deal — no provider was called, no money moved, no state
-- anybody outside this system observed — so `checkout_started` with no live
-- session is simply untrue, and leaving a deal sitting in it would mean the
-- status claimed a buyer had somewhere to pay when they did not.
--
-- The guard governs shape, not policy (see `20260807000002`), and the shape of
-- "a link was issued and then withdrawn" is a round trip. `cancel_checkout_session`
-- still owns whether it is allowed, and it refuses a session already used.

create or replace function deal_transition_allowed(
  p_from deal_status,
  p_to   deal_status
) returns boolean
language sql
immutable
as $$
  select case p_from
    when 'created'            then p_to in ('checkout_started', 'payment_pending', 'funded_held', 'disputed', 'expired', 'canceled')
    -- `-> created` is Phase 7's: a withdrawn payment link, nothing else.
    when 'checkout_started'   then p_to in ('created', 'payment_pending', 'funded_held', 'disputed', 'expired', 'canceled')
    when 'payment_pending'    then p_to in ('funded_held', 'payment_failed', 'disputed', 'expired', 'canceled')
    -- `payment_failed -> funded_held` is not a contradiction: an async rail can
    -- report a failure and then settle, and `fund_deal` accepts the state for
    -- exactly that reason. Refusing it here would leave money at the provider
    -- with no deal willing to admit it arrived.
    when 'payment_failed'     then p_to in ('checkout_started', 'payment_pending', 'funded_held', 'disputed', 'expired', 'canceled')
    when 'funded_held'        then p_to in ('in_progress', 'confirmed_buyer', 'confirmed_seller', 'clearing', 'refunded', 'disputed', 'canceled')
    when 'in_progress'        then p_to in ('revision_requested', 'confirmed_buyer', 'confirmed_seller', 'clearing', 'refunded', 'disputed')
    when 'revision_requested' then p_to in ('in_progress', 'confirmed_buyer', 'confirmed_seller', 'clearing', 'refunded', 'disputed')
    when 'confirmed_buyer'    then p_to in ('confirmed_seller', 'clearing', 'revision_requested', 'refunded', 'disputed')
    when 'confirmed_seller'   then p_to in ('confirmed_buyer', 'clearing', 'revision_requested', 'refunded', 'disputed')
    when 'clearing'           then p_to in ('released', 'disputed', 'refunded', 'partially_refunded')
    -- `released -> paid_out` skips `payout_pending` deliberately: a synchronous
    -- rail settles inside the dispatch call, so `mark_payout_processing` is
    -- never reached. Requiring the intermediate state would make a card payout
    -- illegal. `payout_pending -> released` is the other direction of the same
    -- fact — a failed transfer returns the money to available, retryable.
    when 'released'           then p_to in ('payout_pending', 'paid_out', 'disputed', 'refunded', 'partially_refunded')
    when 'payout_pending'     then p_to in ('paid_out', 'released', 'partially_refunded')
    when 'paid_out'           then p_to in ('partially_refunded')
    when 'partially_refunded' then p_to in ('released', 'payout_pending', 'paid_out', 'refunded', 'disputed')
    -- `resolve_dispute` backs a deal out to `funded_held` so the release guard
    -- sees an ordinary held deal. That is the only way out to release.
    when 'disputed'           then p_to in ('funded_held', 'refunded')
    -- Terminal.
    when 'refunded'           then false
    when 'expired'            then false
    when 'canceled'           then false
    else false
  end;
$$;

grant execute on function deal_transition_allowed(deal_status, deal_status)
  to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Service role only
-- ---------------------------------------------------------------------------

revoke all on function open_checkout_session(uuid, integer, text)
  from public, anon, authenticated;
revoke all on function complete_checkout_session(uuid, payment_method, text, provider, text, text)
  from public, anon, authenticated;
revoke all on function cancel_checkout_session(uuid, text)
  from public, anon, authenticated;

-- Invariant 9, as a grant. None of these moves money, and that is exactly why
-- they belong on the list: the argument for letting the AI role near them would
-- be "it is only a checkout", and the list is what stops that argument being
-- had one function at a time.
revoke all on function open_checkout_session(uuid, integer, text) from payhold_ai;
revoke all on function complete_checkout_session(uuid, payment_method, text, provider, text, text) from payhold_ai;
revoke all on function cancel_checkout_session(uuid, text) from payhold_ai;

-- The token column is readable by the owning tenant — they need it to render or
-- re-send a payment link — and by nobody else. RLS already scopes the row; this
-- is the note that the plaintext storage above is a deliberate, bounded choice
-- rather than an oversight.
comment on column checkout_sessions.token is
  'Bearer token for the hosted checkout page. Plaintext by design: it must stay '
  're-derivable so a payment link can be re-sent. Bounded by a 256-bit space, an '
  'expiry, and a scope of exactly one payment on one deal.';
