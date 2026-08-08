-- ---------------------------------------------------------------------------
-- Seller wallets, and paying out on request instead of on a clock
-- ---------------------------------------------------------------------------
--
-- Until now a seller was something a payout pointed at. There was no way to ask
-- "how much does PayHold hold for this person" — every read was per-deal
-- (`deal_amounts`) or per-tenant (`tenant_balances`), and nothing summed one
-- seller's deals together. A tenant wanting to show a driver their money had to
-- fetch every deal and add it up client-side, which is a balance derived
-- somewhere we cannot see and cannot reconcile.
--
-- This adds three things:
--
--   1. **The wallet is a read, not a table.** `seller_wallet_rows` sums the same
--      ledger entries `rail_balances` does, grouped by seller instead of by
--      rail. There is no stored seller balance for the same reason there is no
--      stored tenant balance: a total and the entries behind it are two numbers
--      that can disagree, and the one a person reads would be the wrong one.
--
--   2. **`payout_mode = 'wallet'`** — a tenant setting that stops the clearance
--      cron from sending money the instant it clears. The money still clears on
--      the same window and still lands in `available`; what changes is that it
--      waits there for somebody to ask for it.
--
--   3. **`request_withdrawal`** — the asking. It stamps the seller's due
--      payouts and hands them to the same
--      `screen_payout -> route_payout -> provider -> book` path the cron uses,
--      because a withdrawal that skipped the eligibility gate would be a way to
--      pay an unverified seller by pressing a different button.
--
-- **Sellers still have no login, and this does not give them one.** Every
-- function here is called by the tenant's own server with its API key, on the
-- seller's behalf — the same shape as `POST /v1/sellers/:id/verify`. AutoHire
-- renders the wallet in AutoHire's app; PayHold supplies the numbers.
--
-- One migration rather than two: nothing here reads a value from
-- `alter type ... add value`, so there is no cross-transaction enum hazard.

-- ---------------------------------------------------------------------------
-- A text setting
-- ---------------------------------------------------------------------------
--
-- `setting_num` has been the only reader since V1 because every setting so far
-- was a rate, a count or a number of days. `payout_mode` is a mode, and
-- encoding it as 0/1 would make the dashboard show an operator a number they
-- have to remember the meaning of.

create or replace function setting_text(p_tenant uuid, p_key text, p_default text)
returns text
language sql
stable
as $$
  select coalesce((select value #>> '{}' from settings
                   where tenant_id = p_tenant and key = p_key), p_default);
$$;

comment on function setting_text(uuid, text, text) is
  'Resolve a text setting with a default. The sibling of setting_num, for '
  'settings whose value is a mode rather than a quantity.';

-- ---------------------------------------------------------------------------
-- What a withdrawal request leaves on the payout
-- ---------------------------------------------------------------------------
--
-- `withdrawal_requested_at` is what makes wallet mode expressible without a
-- second payout status. The row is still `scheduled`; what it is waiting for is
-- different, and the cron's query is where that difference belongs — a status
-- meaning "scheduled, but nobody has asked" would have to be handled by
-- `screen_payout`, `route_payout` and every display path, all to say something
-- none of them act on.
--
-- It is deliberately **not** cleared when the payout is sent. "Was this money
-- pulled or did it go out on the clock" is exactly the question asked when a
-- seller disputes a transfer, and clearing the stamp would erase the answer.

alter table payouts
  add column if not exists withdrawal_requested_at timestamptz,
  -- §5.1 is emphatic that funds are never silently redirected, so the seller
  -- naming a destination is the *only* way one gets chosen other than their own
  -- primary. It is a foreign key rather than a token so an unverified
  -- destination cannot be smuggled in as a string: `request_withdrawal` checks
  -- the row, and `route_payout` re-checks it under the payout's lock.
  add column if not exists requested_destination_id uuid
    references seller_destinations(id) on delete set null;

comment on column payouts.withdrawal_requested_at is
  'When a seller (through their tenant) asked for this money. Null in wallet '
  'mode means it has cleared and is sitting in the wallet unasked-for. Never '
  'cleared once set — whether a transfer was pulled or automatic is part of '
  'its record.';

comment on column payouts.requested_destination_id is
  'The verified destination the seller chose for this withdrawal. Null means '
  'their primary. Checked at request time and re-checked in route_payout.';

-- Wallet-mode tenants scan on this. The partial index matches the cron's
-- predicate rather than the whole table: a payout nobody has asked for is the
-- common row in wallet mode and indexing it would be indexing the haystack.
create index if not exists payouts_withdrawal_requested_idx
  on payouts(withdrawal_requested_at)
  where withdrawal_requested_at is not null;

-- ---------------------------------------------------------------------------
-- The wallet
-- ---------------------------------------------------------------------------
--
-- Deliberately parallel to `rail_balances`, entry type for entry type, because
-- the two must add up: every seller's wallet summed is the tenant's balance
-- less the buckets that were never the sellers'. A second way of reading the
-- same ledger would be free to disagree with the first.
--
-- **`fees_retained` is absent, and its absence is the point.** That bucket is
-- money that stopped being the seller's and stayed in the vault — our
-- commission and collected tax. It belongs in the tenant's balance and has no
-- business in a screen a seller reads.
--
-- **`held` is gross and the others are net.** Inside the hold nothing has been
-- struck yet: the fee is booked at release, so what is sitting there is what
-- the buyer paid, not what the seller will get. Past release, the clearing pool
-- is already net of the fee, the provider's fee, tax and any reserve. A client
-- showing a seller their wallet should label the first "in progress" rather
-- than "yours", and `deal_amounts.seller_net` is the per-deal figure that
-- answers what a held deal is actually worth to them.
--
-- Currency is the ledger's — what the buyer was charged. For a cross-border
-- deal that is not the seller's payout currency; `seller_withdrawable` reports
-- that side, off the payout rows, and the two are different questions rather
-- than one question answered twice.

create or replace function seller_wallet_rows(
  p_tenant uuid default null,
  p_seller uuid default null
)
returns table (
  seller_id          uuid,
  seller_name        text,
  seller_country     country_code,
  currency           currency_code,
  held               bigint,
  pending_clearance  bigint,
  available          bigint,
  reserved           bigint,
  paid_out           bigint
)
language sql
stable
as $$
  with per_deal as (
    select
      d.seller_id,
      l.deal_id,
      -- The currency of the deal's first entry: the hold that started it.
      -- Later entries follow it by construction.
      (array_agg(l.currency order by l.created_at, l.id))[1] as currency,
      coalesce(sum(l.amount) filter (
        where l.entry_type in ('hold', 'release', 'refund')), 0) as held,
      -- The clearing pool — what this seller is owed and could still be sent.
      -- Identical to `rail_balances`, including the signs, which are what make
      -- the two views reconcile.
      coalesce(sum(
        case l.entry_type
          when 'release'         then -l.amount
          when 'fee'             then  l.amount
          when 'provider_fee'    then  l.amount
          when 'tax'             then  l.amount
          when 'reserve'         then  l.amount
          when 'reserve_release' then  l.amount
          when 'payout'          then  l.amount
          else 0
        end), 0) as clearing,
      coalesce(sum(
        case l.entry_type
          when 'reserve'         then -l.amount
          when 'reserve_release' then -l.amount
          else 0
        end), 0) as reserved,
      coalesce(-sum(l.amount) filter (where l.entry_type = 'payout'), 0) as paid,
      max(d.payout_due_at) as payout_due_at
    from ledger l
    join deals d on d.id = l.deal_id
    where l.deal_id is not null
      and (p_tenant is null or l.tenant_id = p_tenant)
      and (p_seller is null or d.seller_id = p_seller)
    group by d.seller_id, l.deal_id
  )
  select
    s.id,
    s.name,
    s.country,
    p.currency,
    sum(p.held)::bigint,
    -- `filter` yields NULL where nothing matches, and a balance of NULL is not
    -- a balance. Every bucket coalesces so the row always adds up.
    coalesce(sum(p.clearing) filter (
      where p.payout_due_at is null or p.payout_due_at > now()), 0)::bigint,
    coalesce(sum(p.clearing) filter (
      where p.payout_due_at is not null and p.payout_due_at <= now()), 0)::bigint,
    sum(p.reserved)::bigint,
    sum(p.paid)::bigint
  from per_deal p
  join sellers s on s.id = p.seller_id
  group by s.id, s.name, s.country, p.currency
  order by s.name, p.currency;
$$;

comment on function seller_wallet_rows(uuid, uuid) is
  'Every seller wallet, or one. Derived from the ledger exactly as '
  'rail_balances is, so the two reconcile. Both arguments null is the whole '
  'system and is not what an endpoint should call.';

-- One seller. The shape a tenant renders in their own app.
create or replace function seller_balance(p_seller uuid)
returns table (
  currency           currency_code,
  held               bigint,
  pending_clearance  bigint,
  available          bigint,
  reserved           bigint,
  paid_out           bigint
)
language sql
stable
as $$
  select w.currency, w.held, w.pending_clearance, w.available, w.reserved, w.paid_out
  from seller_wallet_rows(null, p_seller) w;
$$;

-- Every seller a tenant has, in one query. The list an operator reads and the
-- list a client app pages through: a per-seller round trip would be one query
-- per row of a screen that exists to show them together.
create or replace function tenant_seller_wallets(p_tenant uuid)
returns table (
  seller_id          uuid,
  seller_name        text,
  seller_country     country_code,
  currency           currency_code,
  held               bigint,
  pending_clearance  bigint,
  available          bigint,
  reserved           bigint,
  paid_out           bigint
)
language sql
stable
as $$
  select * from seller_wallet_rows(p_tenant, null);
$$;

-- ---------------------------------------------------------------------------
-- What can actually be sent, in the currency it would be sent in
-- ---------------------------------------------------------------------------
--
-- The wallet above is ledger money in the currency it was collected. This is
-- the payout rows: what a withdrawal would move, in the seller's own payout
-- currency, with the reasons anything is stuck.
--
-- The counts matter as much as the amount. A seller asking "why is my money not
-- here" is asking about exactly one of them, and a wallet that showed a single
-- number would answer none of it — which is the same argument
-- `seller_capabilities` makes for returning every reason rather than the first.

create or replace function seller_withdrawable(p_seller uuid)
returns table (
  currency            currency_code,
  -- Cleared, nothing holding it, and no request outstanding.
  available_amount    bigint,
  available_count     integer,
  -- Asked for and on its way, or with the provider already.
  requested_amount    bigint,
  requested_count     integer,
  -- Still inside the clearance window. Theirs, not yet payable.
  clearing_amount     bigint,
  clearing_count      integer,
  -- Stopped, and by what. Each ends differently, so each is counted apart.
  held_count          integer,
  needs_verification_count integer,
  blocked_count       integer,
  paid_amount         bigint,
  paid_count          integer
)
language sql
stable
as $$
  select
    p.currency,
    coalesce(sum(p.amount) filter (
      where p.status = 'scheduled'
        and p.withdrawal_requested_at is null
        and d.status = 'released'), 0)::bigint,
    count(*) filter (
      where p.status = 'scheduled'
        and p.withdrawal_requested_at is null
        and d.status = 'released')::integer,
    coalesce(sum(p.amount) filter (
      where p.status in ('scheduled', 'processing')
        and p.withdrawal_requested_at is not null), 0)::bigint,
    count(*) filter (
      where p.status in ('scheduled', 'processing')
        and p.withdrawal_requested_at is not null)::integer,
    coalesce(sum(p.amount) filter (where d.status = 'clearing'), 0)::bigint,
    count(*) filter (where d.status = 'clearing')::integer,
    count(*) filter (where p.status = 'held_for_review')::integer,
    count(*) filter (where p.status = 'needs_verification')::integer,
    count(*) filter (where p.status = 'blocked')::integer,
    coalesce(sum(p.amount) filter (where p.status = 'paid'), 0)::bigint,
    count(*) filter (where p.status = 'paid')::integer
  from payouts p
  join deals d on d.id = p.deal_id
  where p.seller_id = p_seller
  group by p.currency
  order by p.currency;
$$;

comment on function seller_withdrawable(uuid) is
  'What a withdrawal would move for this seller, in their payout currency, '
  'with a count against each reason something is not moving.';

-- ---------------------------------------------------------------------------
-- Asking for the money
-- ---------------------------------------------------------------------------
--
-- This function decides *nothing* about whether the money may go. It stamps
-- rows and re-arms the retry clock; `dispatchPayout` then runs the same
-- frozen-tenant check, the same `screen_payout` eligibility gate and the same
-- `route_payout` decision it runs for the cron. A withdrawal endpoint that
-- called the provider itself would be a second money path, and the eligibility
-- gate exists precisely because §12 forbids a second way to pay an unverified
-- seller.
--
-- Three decisions worth knowing.
--
-- **It re-arms `next_attempt_at` and does not reset `attempts`.** §13 gives a
-- null clock the meaning "no machine may try this again", and a seller asking
-- is not a machine — the same reasoning that lets `/payouts/:id/retry` re-arm
-- it. `attempts` is left alone for the reason `reset_payout_retry` leaves it
-- alone: `route_payout` reads it to decide whether the verified backup
-- destination may be used, and zeroing it would quietly send the next attempt
-- back to the primary that has been failing.
--
-- **A destination is chosen from the seller's own verified rows, never
-- supplied.** "Send it to any card" means any card they have already
-- registered and had verified — a withdrawal call that could name a fresh
-- destination would be a way to move money to an address nobody checked, which
-- is the account-takeover shape §5.1's security hold exists to catch.
--
-- **`held_for_review` is not woken up.** It is absent from the statuses this
-- touches for the same reason it is absent from `DISPATCHABLE`: a payout a rule
-- or a person stopped is waiting on a named person's approval, and a seller
-- asking again is not that (invariant 11).

create or replace function request_withdrawal(
  p_seller       uuid,
  p_actor        text,
  p_destination  uuid default null
)
returns setof payouts
language plpgsql
security definer
set search_path = public
as $$
declare
  s        sellers;
  dest     seller_destinations;
  v_count  integer;
begin
  if coalesce(trim(p_actor), '') = '' then
    raise exception 'policy_violation: a withdrawal request needs a name'
      using errcode = 'check_violation';
  end if;

  select * into s from sellers where id = p_seller;

  if not found then
    raise exception 'not_found: seller % does not exist', p_seller
      using errcode = 'no_data_found';
  end if;

  -- The destination is validated here so a bad one is refused before anything
  -- is stamped, rather than surfacing as a routing failure on every payout.
  if p_destination is not null then
    select * into dest
      from seller_destinations
     where id = p_destination and seller_id = p_seller;

    if not found then
      raise exception 'not_found: destination % does not belong to seller %',
        p_destination, p_seller
        using errcode = 'no_data_found';
    end if;

    if dest.verified_at is null then
      raise exception 'policy_violation: destination % has not been verified',
        p_destination
        using errcode = 'check_violation';
    end if;

    -- §5.1's change protection. A destination added minutes ago is exactly what
    -- a withdrawal request would be used to drain money to.
    if dest.security_hold_until is not null and dest.security_hold_until > now() then
      raise exception
        'policy_violation: destination % is in its security hold until %',
        p_destination, dest.security_hold_until
        using errcode = 'check_violation';
    end if;
  end if;

  -- Everything cleared and not already asked for. `for update` because two
  -- taps on a slow connection are the ordinary case, and the second must find
  -- the rows already stamped rather than stamp them again.
  with due as (
    select p.id
      from payouts p
      join deals d on d.id = p.deal_id
     where p.seller_id = p_seller
       and p.status in ('scheduled', 'blocked', 'needs_verification', 'failed', 'frozen')
       and d.status in ('released', 'payout_pending')
       and p.withdrawal_requested_at is null
     for update of p
  )
  update payouts p
     set withdrawal_requested_at  = now(),
         requested_destination_id = coalesce(p_destination, p.requested_destination_id),
         next_attempt_at          = now()
    from due
   where p.id = due.id;

  get diagnostics v_count = row_count;

  if v_count = 0 then
    raise exception 'invalid_state: seller % has nothing cleared to withdraw', p_seller
      using errcode = 'check_violation';
  end if;

  perform write_audit(s.tenant_id, null, p_actor, 'seller.withdrawal_requested',
    jsonb_build_object(
      'seller_id', p_seller,
      'payouts', v_count,
      'destination_id', p_destination
    ));

  return query
    select * from payouts
     where seller_id = p_seller and withdrawal_requested_at is not null
       and status <> 'paid'
     order by scheduled_for;
end;
$$;

comment on function request_withdrawal(uuid, text, uuid) is
  'Stamp a seller''s cleared payouts as asked-for and re-arm their retry '
  'clock. Moves no money: dispatchPayout still screens, routes and books.';

-- ---------------------------------------------------------------------------
-- Routing honours the chosen destination
-- ---------------------------------------------------------------------------
--
-- The one change to `route_payout`: where it read the primary destination, it
-- now reads the one the seller asked for, when they asked for one. Everything
-- downstream — the eligibility filter, the backup policy check, the decision
-- row — is untouched and still applies to whichever row this picks.
--
-- The verification and security-hold conditions are repeated here rather than
-- trusted from `request_withdrawal`. A destination can be un-verified between
-- the request and the pass that sends it, and this is the check that runs under
-- the payout's own lock.

create or replace function route_payout(p_payout uuid)
returns payout_decisions
language plpgsql
security definer
set search_path = public
as $$
declare
  p            payouts;
  d            deals;
  s            sellers;
  dest         seller_destinations;
  backup       seller_destinations;
  v_route_id   uuid;
  v_provider   provider;
  v_rail       payout_provider;
  v_method     payout_method;
  v_rank       integer;
  v_fee        bigint;
  checks       jsonb;
  fallback     boolean := false;
  allow_backup boolean;
  v_reason     text;
  v_fx_source  text;
  decision     payout_decisions;
  previous     payout_decisions;
begin
  select * into p from payouts where id = p_payout for update;

  if not found then
    raise exception 'not_found: payout % does not exist', p_payout
      using errcode = 'no_data_found';
  end if;

  -- A payout the provider already has is not re-routed. Choosing a different
  -- destination for money in flight is the silent redirection §5.1 forbids, and
  -- it could not take effect anyway.
  if p.status in ('paid', 'processing') then
    raise exception 'invalid_state: payout % is already with the provider', p_payout
      using errcode = 'check_violation';
  end if;

  select * into d from deals where id = p.deal_id;
  select * into s from sellers where id = p.seller_id;

  -- The seller's own choice, if this payout carries one and it still stands.
  -- Re-checked here rather than trusted from `request_withdrawal`: a
  -- verification can be withdrawn between the ask and the pass that sends it,
  -- and this is the read that happens under the payout's own lock.
  if p.requested_destination_id is not null then
    select * into dest
      from seller_destinations
     where id = p.requested_destination_id
       and seller_id = p.seller_id
       and verified_at is not null
       and (security_hold_until is null or security_hold_until <= now());
  end if;

  -- No choice, or one that no longer holds: their primary, exactly as before.
  -- Falling back to the primary rather than refusing is not the silent
  -- redirection §5.1 forbids — the primary is the destination the seller
  -- already nominated, and every eligibility check below still applies to it.
  if dest.id is null then
    select * into dest
      from seller_destinations
     where seller_id = p.seller_id and is_primary;
  end if;

  -- §5.1's routing-policy check, all of it, before the backup is even read.
  allow_backup :=
    p.status = 'failed'
    and p.attempts >= setting_num(p.tenant_id, 'payout_primary_attempts', 2)::integer
    and setting_num(p.tenant_id, 'payout_backup_enabled', 1) <> 0;

  -- The evaluation is recorded against the destination we would prefer to use,
  -- so `checks` answers "why not the seller's own choice" rather than "why not
  -- some rail nobody asked for".
  select coalesce(jsonb_agg(to_jsonb(e) order by e.eligible desc, e.rank), '[]'::jsonb)
    into checks
    from route_evaluation(
      p.tenant_id,
      coalesce(dest.country, s.country),
      p.currency,
      p.amount,
      coalesce(dest.payout_provider, s.payout_provider)
    ) e;

  if dest.id is not null and dest.verified_at is not null then
    select e.route_id, e.provider, e.payout_provider, e.method, e.rank, e.fee_estimate
      into v_route_id, v_provider, v_rail, v_method, v_rank, v_fee
      from route_evaluation(p.tenant_id, dest.country, p.currency, p.amount,
                            dest.payout_provider) e
     where e.eligible and e.preferred
     limit 1;
  end if;

  -- Only now, and only if the primary produced nothing.
  if v_route_id is null and allow_backup then
    select * into backup
      from seller_destinations
     where seller_id = p.seller_id
       and is_backup
       and verified_at is not null
       and (security_hold_until is null or security_hold_until <= now());

    if backup.id is not null then
      select e.route_id, e.provider, e.payout_provider, e.method, e.rank, e.fee_estimate
        into v_route_id, v_provider, v_rail, v_method, v_rank, v_fee
        from route_evaluation(p.tenant_id, backup.country, p.currency, p.amount,
                              backup.payout_provider) e
       where e.eligible and e.preferred
       limit 1;

      if v_route_id is not null then
        dest := backup;
        fallback := true;
      end if;
    end if;
  end if;

  -- §5.1's currency handling. A payout in the currency that was collected has
  -- no rate to show; one that was converted names where the rate came from.
  if d.presentment_currency is distinct from p.currency then
    v_fx_source := case
      when d.fx_rate is not null then 'deal_locked_rate'
      else 'payhold_indicative'
    end;
  end if;

  if v_route_id is null then
    -- The most specific true statement, in the order a seller can act on it.
    v_reason := case
      when dest.id is null then 'no_eligible_verified_destination'
      when dest.verified_at is null then 'destination_not_verified'
      else coalesce(
        (select e.reason_code
           from route_evaluation(p.tenant_id, dest.country, p.currency, p.amount,
                                 dest.payout_provider) e
          where e.preferred
          limit 1),
        'no_route_for_destination'
      )
    end;
  else
    v_reason := 'routed';
  end if;

  select * into previous
    from payout_decisions
   where payout_id = p.id
   order by created_at desc, id desc
   limit 1;

  if previous.id is not null
     and previous.reason_code = v_reason
     and previous.destination_id is not distinct from dest.id
     and previous.route_id is not distinct from v_route_id
  then
    decision := previous;
  else
    insert into payout_decisions (
      tenant_id, payout_id, route_id, destination_id, provider, payout_provider,
      method, currency, amount, ranking_score, fee_estimate, fx_source, fx_rate,
      is_fallback, reason_code, checks
    ) values (
      p.tenant_id, p.id, v_route_id, dest.id, v_provider, v_rail, v_method,
      p.currency, p.amount, v_rank, v_fee, v_fx_source,
      case when v_fx_source is null then null else d.fx_rate end,
      fallback, v_reason, checks
    )
    returning * into decision;
  end if;

  if v_route_id is null then
    -- §5.1's no-route behaviour: keep the amount, say why, ask for a
    -- destination. Nothing is discarded and nothing is rerouted.
    --
    -- `failed` is left alone. A provider that refused a transfer is a more
    -- specific fact than "no route", and it is what the retry backoff reads.
    if p.status not in ('failed', 'blocked') then
      update payouts
         set status = 'blocked',
             failure_reason = route_reason_text(
               v_reason,
               coalesce(dest.payout_provider, s.payout_provider),
               coalesce(dest.country, s.country),
               p.currency)
       where id = p.id;
    end if;

    perform write_audit(p.tenant_id, p.deal_id, 'system', 'payout.blocked',
      jsonb_build_object(
        'payout_id', p.id,
        'reason_code', v_reason,
        'checks', checks
      ));

    return decision;
  end if;

  update payouts
     set destination_id = dest.id,
         -- A route exists again, so whatever the routing engine last said no
         -- longer holds. Leaving the old sentence would have an operator
         -- reading a stale reason against a payout that is about to go.
         failure_reason = case when p.status = 'blocked' then null
                               else p.failure_reason end,
         status = case when p.status = 'blocked' then 'scheduled'::payout_status
                       else p.status end
   where id = p.id;

  -- §5.1: the seller must be notified when the backup is used, and the change
  -- logged. Once — a later pass re-picking the same backup is not a new change.
  if fallback and (previous.id is null or not previous.is_fallback) then
    perform write_audit(p.tenant_id, p.deal_id, 'system', 'payout.route_changed',
      jsonb_build_object(
        'payout_id', p.id,
        'destination_id', dest.id,
        'masked_destination', dest.masked_destination,
        'reason', 'The primary destination failed; the verified backup was used'
      ));

    perform enqueue_webhooks(p.tenant_id, p.deal_id, 'payout.route_changed',
      jsonb_build_object(
        'payout_id', p.id,
        'destination', dest.masked_destination,
        'payout_provider', dest.payout_provider
      ));
  end if;

  return decision;
end;
$$;

-- ---------------------------------------------------------------------------
-- Which payouts a pass may send — where wallet mode actually binds
-- ---------------------------------------------------------------------------
--
-- The cron used to build this predicate itself. It cannot any more, and the
-- reason is the batch limit rather than the predicate: filtering wallet-mode
-- rows out *after* `limit 25` would let one tenant sitting on twenty-five
-- unasked-for payouts starve every other tenant in the pass, indefinitely and
-- silently. The filter has to be inside the limit, so it has to be in SQL.
--
-- **The statuses are a parameter, not a list repeated here.** `DISPATCHABLE`
-- in `_shared/dispatch.ts` carries the reasoning about which states a machine
-- may send from — `held_for_review` absent, `blocked` and `needs_verification`
-- present — and a second copy in SQL would be free to drift from it. The caller
-- passes what it already owns.
--
-- Wallet mode is read per row rather than per pass because `payout_mode` is a
-- tenant setting and a batch spans tenants. A tenant left on the default
-- behaves exactly as it did before this migration: `'auto'` is the fallback,
-- so a tenant with no row set is not silently switched to pull-only.

create or replace function due_payouts(
  p_statuses  payout_status[],
  p_limit     integer default 25
)
returns setof payouts
language sql
stable
as $$
  select p.*
    from payouts p
   where p.status = any (p_statuses)
     and p.scheduled_for <= now()
     -- §13's backoff. Null means no machine may try this again, and comparing
     -- against it yields null rather than true — which is the exclusion.
     and p.next_attempt_at <= now()
     and (
       setting_text(p.tenant_id, 'payout_mode', 'auto') <> 'wallet'
       or p.withdrawal_requested_at is not null
     )
   order by p.scheduled_for
   limit p_limit;
$$;

comment on function due_payouts(payout_status[], integer) is
  'Payouts a scheduled pass may send, oldest first. In payout_mode = wallet a '
  'payout is due only once somebody has asked for it.';

-- ---------------------------------------------------------------------------
-- Grants — invariant 9 and invariant 1
-- ---------------------------------------------------------------------------
--
-- `request_withdrawal` moves toward money, so it is service-role only and
-- explicitly revoked from `payhold_ai`. A recreated function is granted to
-- PUBLIC by default, which is the trap `tests/intelligence.test.ts` matches on
-- the function *name* to catch — `route_payout` is recreated above and needs
-- its revoke reissued for exactly that reason.

revoke all on function request_withdrawal(uuid, text, uuid) from public, anon, authenticated;
revoke all on function request_withdrawal(uuid, text, uuid) from payhold_ai;

revoke all on function route_payout(uuid) from public, anon, authenticated;
revoke all on function route_payout(uuid) from payhold_ai;

-- A read, but of the payout queue, and only the cron has any business asking
-- "what would you send next". Service role reaches it by bypassing RLS.
revoke all on function due_payouts(payout_status[], integer) from public, anon, authenticated;
revoke all on function due_payouts(payout_status[], integer) from payhold_ai;

-- The wallet reads are reads. A dashboard session may run them against its own
-- tenant's rows, and the AI role may read them for the same reason it may read
-- a deal: summarising a seller is §12.2's job and none of these move anything.
grant execute on function setting_text(uuid, text, text) to authenticated, payhold_ai;
grant execute on function seller_wallet_rows(uuid, uuid) to authenticated, payhold_ai;
grant execute on function seller_balance(uuid) to authenticated, payhold_ai;
grant execute on function tenant_seller_wallets(uuid) to authenticated, payhold_ai;
grant execute on function seller_withdrawable(uuid) to authenticated, payhold_ai;
