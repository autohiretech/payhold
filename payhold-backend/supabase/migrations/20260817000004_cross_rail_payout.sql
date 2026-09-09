-- Book a payout where the money actually moved.
--
-- The bug, in one sentence: `settle_payout` books the `payout` entry through
-- `write_ledger`, which stamps the **deal's** rail and presentment currency —
-- so a deal collected on Stripe in USD and paid out on Flutterwave in RWF told
-- the ledger that USD left Stripe. It did not. The USD is still in the tenant's
-- Stripe balance and it was RWF that left Flutterwave, so the nightly pass
-- found drift on both rails at once and froze the tenant's payouts. On the
-- first cross-border deal, every time. Same-rail deals were always fine, which
-- is why nothing caught it: every fixture is same-rail.
--
-- The model is a seventh bucket, `tenant_funds` — the tenant's own money on a
-- rail, owed to no seller — and three entry types (`20260817000003`):
--
--   cross_rail_offset   collecting rail, presentment currency, +leaving.
--                       Nothing physical: it reclassifies a pool that has been
--                       drained of its obligation into money that is simply
--                       the tenant's, still sitting at the collecting rail.
--   cross_rail_payout   payout rail, payout currency, −payouts.amount.
--                       Physical: this is the money that left.
--   external_transfer   any rail, signed, and **no deal**. The tenant's own
--                       top-up or sweep between their provider accounts.
--
-- Under bring-your-own-keys PayHold never moves money between a tenant's own
-- accounts — they top Flutterwave up from their Stripe payouts by hand — so
-- that last one is how a real balance stays explicable. It is recorded by a
-- person through `POST /v1/balance/external-transfers`, with a reference,
-- because a reconciling entry nobody can trace is how a drift gets papered
-- over rather than explained. The alternative considered and rejected was
-- reconciling Flutterwave on a delta basis, which would have silenced real
-- drift as well as this.
--
-- Worked through, for a USD deal (buyer B, our fee F, rail's fee P, leaving L)
-- paid out as A RWF:
--
--   Stripe   held 0, clearing 0, fees_retained F, tenant_funds +L
--            expected = F + L = B − P     ← unchanged, and it is still there
--   Flutter  tenant_funds −A (+T from top-ups)
--            expected = T − A             ← exactly what left
--
-- `deal_amounts.paid_out` still reads L in the presentment currency, because
-- the `payout` entry itself does not move. Only the offsetting pair is new.

-- ---------------------------------------------------------------------------
-- The seventh bucket
-- ---------------------------------------------------------------------------
--
-- `tenant_balances` is `language sql` and calls `rail_balances`, which is a
-- real dependency — hence the same drop-in-order dance `20260807000004` does.

drop function if exists tenant_balances(uuid);
drop function if exists rail_balances(uuid) cascade;

create or replace function rail_balances(p_tenant uuid)
returns table (
  provider           provider,
  currency           currency_code,
  held               bigint,
  pending_clearance  bigint,
  available          bigint,
  reserved           bigint,
  fees_retained      bigint,
  tenant_funds       bigint,
  paid_out           bigint
)
language sql
stable
as $$
  with per_deal as (
    select
      l.deal_id,
      -- **Grouped by the entry's own rail, not by the deal's first entry.**
      -- That `array_agg(...)[1]` was right while a deal's entries could only
      -- ever share one rail, and it is what made a cross-rail payout land on
      -- the rail that did not pay it. Every pre-existing entry still groups
      -- exactly as it did, because for a same-rail deal these are the same
      -- thing.
      l.provider,
      l.currency,
      coalesce(sum(l.amount) filter (
        where l.entry_type in ('hold', 'release', 'refund')), 0) as held,
      -- What the seller is owed and could still be sent. The three new types
      -- are deliberately absent — they are not the seller's pool, which is the
      -- whole reason `tenant_funds` is its own bucket — so they fall to the
      -- `else` and `POOL_ENTRY_TYPES` in `_shared/figures.ts` needs no change.
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
      coalesce(sum(
        case l.entry_type
          when 'fee' then -l.amount
          when 'tax' then -l.amount
          else 0
        end), 0) as retained,
      -- Ours, on this rail, owed to nobody. Signed, so a top-up adds and a
      -- transfer out subtracts.
      coalesce(sum(l.amount) filter (
        where l.entry_type in ('cross_rail_offset', 'cross_rail_payout')), 0) as funds,
      coalesce(-sum(l.amount) filter (where l.entry_type = 'payout'), 0) as paid,
      max(d.payout_due_at) as payout_due_at
    from ledger l
    join deals d on d.id = l.deal_id
    where l.tenant_id = p_tenant
      and l.deal_id is not null
    group by l.deal_id, l.provider, l.currency
  ),
  -- The tenant's own movements between their provider accounts. No deal, so
  -- the join above cannot see them, and no bucket but `tenant_funds`.
  tenant_level as (
    select
      null::uuid as deal_id,
      l.provider,
      l.currency,
      0::bigint as held,
      0::bigint as clearing,
      0::bigint as reserved,
      0::bigint as retained,
      coalesce(sum(l.amount), 0) as funds,
      0::bigint as paid,
      null::timestamptz as payout_due_at
    from ledger l
    where l.tenant_id = p_tenant
      and l.deal_id is null
      and l.entry_type = 'external_transfer'
    group by l.provider, l.currency
  ),
  combined as (
    select * from per_deal
    union all
    select * from tenant_level
  )
  select
    p.provider,
    p.currency,
    sum(p.held)::bigint,
    -- `filter` yields NULL when no row matches, and a balance of NULL is not a
    -- balance. Every bucket coalesces to zero so they always add up.
    coalesce(sum(p.clearing) filter (
      where p.payout_due_at is null or p.payout_due_at > now()), 0)::bigint,
    coalesce(sum(p.clearing) filter (
      where p.payout_due_at is not null and p.payout_due_at <= now()), 0)::bigint,
    sum(p.reserved)::bigint,
    sum(p.retained)::bigint,
    sum(p.funds)::bigint,
    sum(p.paid)::bigint
  from combined p
  group by p.provider, p.currency
  order by p.provider::text, p.currency;
$$;

create or replace function tenant_balances(p_tenant uuid)
returns table (
  currency           currency_code,
  held               bigint,
  pending_clearance  bigint,
  available          bigint,
  reserved           bigint,
  fees_retained      bigint,
  tenant_funds       bigint,
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
    sum(r.reserved)::bigint,
    sum(r.fees_retained)::bigint,
    sum(r.tenant_funds)::bigint,
    sum(r.paid_out)::bigint
  from rail_balances(p_tenant) r
  group by r.currency
  order by r.currency;
$$;

-- ---------------------------------------------------------------------------
-- The one writer allowed to stamp a rail other than the deal's
-- ---------------------------------------------------------------------------
--
-- `write_ledger` takes its rail and currency off the deal, which is right for
-- every entry that describes the money the buyer paid. A cross-rail payout is
-- the one thing that does not, so it gets its own writer rather than an extra
-- pair of nullable parameters on the shared one — a caller that could override
-- the rail by accident is a caller that will.

create or replace function write_rail_ledger(
  p_deal        deals,
  p_type        ledger_entry_type,
  p_amount      bigint,
  p_provider    provider,
  p_currency    currency_code,
  p_provider_ref text default null
) returns void
language sql
as $$
  insert into ledger (tenant_id, deal_id, entry_type, amount, currency, provider, provider_ref)
  values (
    p_deal.tenant_id, p_deal.id, p_type, p_amount, p_currency, p_provider,
    coalesce(p_provider_ref, p_deal.provider_ref)
  );
$$;

-- ---------------------------------------------------------------------------
-- The tenant's own money moving between their own accounts
-- ---------------------------------------------------------------------------

create or replace function record_external_transfer(
  p_tenant    uuid,
  p_provider  provider,
  p_currency  currency_code,
  p_amount    bigint,
  p_reference text,
  p_actor     text
) returns ledger
language plpgsql
security definer
set search_path = public
as $$
declare
  entry ledger;
begin
  if p_actor is null or btrim(p_actor) = '' then
    raise exception 'policy_violation: a transfer must record who reported it'
      using errcode = 'check_violation';
  end if;

  -- The same argument `paid_needs_a_provider_reference` makes: this is a claim
  -- that money moved somewhere we cannot see, and a claim with nothing to
  -- check it against is how a drift gets papered over instead of explained.
  if p_reference is null or btrim(p_reference) = '' then
    raise exception 'policy_violation: a transfer must quote a reference'
      using errcode = 'check_violation';
  end if;

  if p_amount = 0 then
    raise exception 'policy_violation: a transfer of zero moves nothing'
      using errcode = 'check_violation';
  end if;

  insert into ledger (tenant_id, deal_id, entry_type, amount, currency, provider, provider_ref)
  values (p_tenant, null, 'external_transfer', p_amount, p_currency, p_provider, btrim(p_reference))
  returning * into entry;

  perform write_audit(p_tenant, null, p_actor, 'ledger.external_transfer',
    jsonb_build_object(
      'provider', p_provider,
      'currency', p_currency,
      'amount', p_amount,
      'reference', btrim(p_reference)
    ));

  return entry;
end;
$$;

-- ---------------------------------------------------------------------------
-- settle_payout, booking on the rail that actually sent the money
-- ---------------------------------------------------------------------------
--
-- Gaining a parameter, so `drop` and recreate: `create or replace` cannot
-- change a signature and would leave the three-argument original as a sibling
-- that every existing caller kept hitting — the trap `fund_deal`'s header
-- names, and the one `tests/lifecycle.test.ts` pins with a `pg_proc` count.
--
-- `p_rail` has no default, deliberately. A default would make every existing
-- call site keep compiling while silently booking on the wrong rail, which is
-- precisely the bug being fixed. It is also cross-checked against the routing
-- decision rather than trusted: `dispatchPayout` is the only caller that knows
-- which rail was chosen, and a caller that could name any rail could book a
-- payout against a balance that never sent it.

drop function if exists settle_payout(uuid, bigint, text);

create function settle_payout(
  p_payout_id    uuid,
  p_leaving      bigint,
  p_provider_ref text,
  p_rail         provider
) returns payouts
language plpgsql
security definer
set search_path = public
as $$
declare
  p        payouts;
  d        deals;
  v_routed provider;
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

  -- §8: a dispute freezes release and payout. V1 did not need this check —
  -- a dispute could only be opened on a held deal, so no payout row existed
  -- yet. `clearing -> disputed` changes that: the payout is already scheduled
  -- when the chargeback arrives, and without this it would simply go.
  --
  -- Under the same lock as the booking, so a dispute opened mid-dispatch
  -- either lands before this check or waits behind it.
  if d.status = 'disputed' then
    raise exception 'policy_violation: deal % is disputed — its payout is frozen', d.id
      using errcode = 'check_violation';
  end if;

  -- The rail has to be the one the routing engine actually picked. Read under
  -- this lock rather than taken on trust, for the reason `route_payout`
  -- re-reads a verification it was already told about: the caller decided some
  -- time ago and the record is what an auditor reads afterwards.
  select pd.provider into v_routed
    from payout_decisions pd
   where pd.payout_id = p.id and pd.reason_code = 'routed'
   order by pd.created_at desc, pd.id desc
   limit 1;

  -- No decision at all is the fixture case — and a same-rail payout, which is
  -- every payout before this migration. Anything else must match.
  if v_routed is null then
    if p_rail is distinct from d.provider then
      raise exception
        'policy_violation: payout % has no routing decision, so it can only settle on %',
        p.id, d.provider
        using errcode = 'check_violation';
    end if;
  elsif p_rail is distinct from v_routed then
    raise exception
      'policy_violation: payout % was routed to % but is being settled on %',
      p.id, v_routed, p_rail
      using errcode = 'check_violation';
  end if;

  -- The balance guard the spec demands: a payout may never exceed the tenant's
  -- available balance, checked inside the same transaction that books it.
  -- Asked of the **collecting** rail, because `p_leaving` is what leaves that
  -- deal's clearing pool and the pool is denominated there.
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

  -- The seller's claim on this deal's pool is discharged. This entry has not
  -- moved and must not: `deal_amounts.paid_out` reads it, in the presentment
  -- currency, and §7's identity depends on it.
  perform write_ledger(d, 'payout', -p_leaving);

  -- Where the money physically went, when that is not where it came in.
  if p_rail is distinct from d.provider then
    -- Still at the collecting rail, and now nobody's but the tenant's.
    perform write_rail_ledger(
      d, 'cross_rail_offset', p_leaving, d.provider, d.presentment_currency, p_provider_ref
    );
    -- And gone from the paying one, in the currency the seller was actually
    -- sent — a genuinely different number, which is why `payouts.amount` is
    -- the figure here rather than a conversion of `p_leaving`.
    perform write_rail_ledger(
      d, 'cross_rail_payout', -p.amount, p_rail, p.currency, p_provider_ref
    );
  end if;

  if d.status = 'clearing' then
    update deals set status = 'released' where id = d.id;
    perform write_audit(d.tenant_id, d.id, 'system', 'deal.cleared', jsonb_build_object(
      'reason', 'payout settled', 'payout_due_at', d.payout_due_at
    ));
  end if;

  update deals set status = 'paid_out' where id = d.id;

  perform write_audit(p.tenant_id, p.deal_id, 'system', 'payout.paid', jsonb_build_object(
    'amount', p.amount,
    'currency', p.currency,
    'seller_id', p.seller_id,
    'rail', p_rail,
    'leaving', p_leaving,
    'leaving_currency', d.presentment_currency
  ));

  return p;
end;
$$;

-- A recreated function is granted to PUBLIC again, so both revokes are
-- reissued against the new signature — the trap every recreated money function
-- in this codebase has walked into once.
revoke all on function settle_payout(uuid, bigint, text, provider)
  from public, anon, authenticated;
revoke all on function settle_payout(uuid, bigint, text, provider) from payhold_ai;

revoke all on function write_rail_ledger(deals, ledger_entry_type, bigint, provider, currency_code, text)
  from public, anon, authenticated;
revoke all on function write_rail_ledger(deals, ledger_entry_type, bigint, provider, currency_code, text)
  from payhold_ai;

revoke all on function record_external_transfer(uuid, provider, currency_code, bigint, text, text)
  from public, anon, authenticated;
revoke all on function record_external_transfer(uuid, provider, currency_code, bigint, text, text)
  from payhold_ai;
