-- ---------------------------------------------------------------------------
-- Installment billing: pay-to-book + pay-on-return, with overage
-- ---------------------------------------------------------------------------
--
-- A deal today is funded in exactly one charge, for the whole agreed amount.
-- This adds two independent, optional behaviours a client (AutoHire) can turn
-- on per deal by sending numbers at creation — nothing here hard-codes
-- "hourly" or "daily" as a PayHold concept, because the spec gives AutoHire
-- ownership of rental pricing and PayHold's job is to stay agnostic to deal
-- type:
--
--   `split_percent`   charge this percentage now, the rest when the rental
--                      is confirmed returned. Null means "all of it now" —
--                      today's behaviour, completely unaffected.
--   `overage_rate` +
--   `overage_unit_seconds`
--                      a per-unit price and how long a unit is (3600 for
--                      hourly, 86400 for daily, or anything else). Charged
--                      only if the deal is confirmed returned after
--                      `expected_complete_at`, which already exists on this
--                      table as the client's own "when this should be done."
--                      Null means overage is never charged.
--
-- ## `presentment_amount` changes meaning for a split deal
--
-- It becomes the FIRST INSTALLMENT's amount, not the whole booking —
-- `balance_amount` is the rest, derived once at creation (frozen the same
-- way `fee_amount` is, so a rate change mid-rental cannot reprice a deal that
-- already exists). This is deliberate: `fund_deal` needs **zero changes**. It
-- already just funds whatever `presentment_amount` says; a split deal simply
-- says a smaller number at first. `startCharge` needs no changes either, for
-- the same reason.
--
-- ## Where the second charge is booked
--
-- `settle_deal_balance` is called once, when the rental is confirmed
-- returned and either a balance or an overage is owed — see
-- `_shared/settle-balance.ts` for the actual off-session charge, a provider
-- call rather than anything in SQL. It adds `balance_amount + overage` to
-- `presentment_amount` and the fee on the overage portion to `fee_amount`,
-- so `release_deal` releases the true total against the true fee without
-- knowing an installment ever happened.
--
-- **A daily deal (no `split_percent`, `overage_rate` set) owes this function
-- too**, and `balance_amount is null` must not be read as "nothing to do
-- here" — it means "no split," which is a different fact than "nothing
-- owed." The guard checks `overage_rate` as well for exactly this reason;
-- every `coalesce(d.balance_amount, 0)` in the body is the same distinction
-- carried through the arithmetic.
--
-- ## The host can reduce or waive a late charge before it is charged
--
-- `deals.metadata.overage_override` (set via the seller's own `POST
-- /deals/:id/confirm`, never a separate endpoint) caps what `overageFor`
-- would otherwise charge — `_shared/figures.ts`'s `balanceFigures` clamps
-- with it before computing the overage's fee or converting to presentment
-- currency, so a reduced charge produces a correspondingly reduced fee
-- rather than fee-on-money-never-collected. It is persisted on the deal
-- rather than passed through the one confirm call that sets it, because the
-- confirmation that actually completes the pair — and triggers the charge —
-- may be the *other* side's, arriving later.
--
-- `release_deal` itself gets exactly one new guard, in `20260815000005`: it
-- now refuses outright when `balance_amount` is still positive, rather than
-- releasing whatever `presentment_amount` currently says. Nothing here
-- guaranteed `settle_deal_balance` runs before the deal's second
-- confirmation completes the pair — that ordering lives in
-- `collectBalanceThenConfirm`, which is TypeScript, not a lock. The new
-- migration is the same invariant made structural instead of trusted.
--
-- `deal.fee_amount` was already computed at creation off the FULL settlement
-- amount (`feeFor(body.amount, settings)` in `deals/index.ts`), which already
-- covers the base price whether it arrives in one charge or two. Only the
-- overage is new revenue with no fee counted against it yet, which is why
-- `settle_deal_balance` takes an overage fee to add rather than recomputing
-- the whole thing.
--
-- ## A real gap, disclosed rather than papered over
--
-- `deals.provider_ref` stays the FIRST charge's reference — the refund path
-- (`deals/index.ts`'s `refund`, `refund_deal`) reads it and is completely
-- unchanged by this migration. The balance charge's own reference is kept
-- separately in `balance_provider_ref`, for the record. **A full refund
-- issued after the balance has been charged only unwinds the first
-- installment** — refunding the balance charge too would need a second
-- `provider.refund` call this pass does not make. Matches the scope
-- discipline already taken with the charge-failure retry loop: a smaller,
-- disclosed gap rather than a second refund-fan-out built and not asked for.

alter table deals
  add column split_percent        integer check (split_percent between 1 and 99),
  add column overage_rate         bigint check (overage_rate > 0),
  add column overage_unit_seconds integer check (overage_unit_seconds > 0),
  -- Null: no split, nothing ever owed after the first charge (today's
  -- behaviour). Zero: was owed, now collected — the idempotency marker
  -- `settle_deal_balance` reads. Positive: still owed.
  add column balance_amount       bigint check (balance_amount >= 0),
  add column balance_provider_ref text;

comment on column deals.split_percent is
  'Percent charged at booking; the rest is charged when the rental is '
  'confirmed returned. Null means the whole amount is charged now.';
comment on column deals.balance_amount is
  'What is still owed after the first charge, frozen at creation the same '
  'way fee_amount is. Null = no split. Zero = collected. Positive = owed.';

create or replace function settle_deal_balance(
  p_deal_id       uuid,
  p_overage       bigint,
  p_overage_fee   bigint,
  p_provider_ref  text
) returns deals
language plpgsql
security definer
set search_path = public
as $$
declare
  d          deals;
  v_balance  bigint;
  v_funded   bigint;
begin
  select * into d from deals where id = p_deal_id for update;

  if not found then
    raise exception 'not_found: deal % does not exist', p_deal_id
      using errcode = 'no_data_found';
  end if;

  -- A deal with no split (`balance_amount is null`) can still owe overage —
  -- a daily rental sets `overage_rate` with no `split_percent` at all. Only a
  -- deal that opted into neither has nothing this function could ever book.
  if d.balance_amount is null and d.overage_rate is null then
    raise exception 'invalid_state: this deal has no balance to collect'
      using errcode = 'check_violation';
  end if;

  -- Idempotent, and also the ordinary "nothing owed this pass" case for a
  -- deal returned on time: a retry after a crash between the provider charge
  -- succeeding and this write reaching the database must not book it twice,
  -- and a daily deal with no split and no lateness has genuinely nothing to
  -- collect. `coalesce` is what lets the same test serve a deal that never
  -- had a balance at all (null) and one already settled (zero).
  if coalesce(d.balance_amount, 0) = 0 and p_overage = 0 then
    return d;
  end if;

  if p_overage < 0 or p_overage_fee < 0 then
    raise exception 'policy_violation: overage and its fee cannot be negative'
      using errcode = 'check_violation';
  end if;

  if p_provider_ref is null or btrim(p_provider_ref) = '' then
    raise exception 'policy_violation: a balance charge must quote the provider''s own reference'
      using errcode = 'check_violation';
  end if;

  -- Captured before the update overwrites `d` (and its balance_amount along
  -- with it) via `returning *` — the ledger write below needs the amount
  -- that was actually just collected, not the zero the row reads afterward.
  -- `coalesce` here is the same "no split, overage only" case as above.
  v_balance := coalesce(d.balance_amount, 0);
  v_funded  := v_balance + p_overage;

  update deals
     set presentment_amount   = presentment_amount + v_funded,
         fee_amount           = fee_amount + p_overage_fee,
         balance_amount       = 0,
         balance_provider_ref = p_provider_ref
   where id = d.id
  returning * into d;

  perform write_ledger(d, 'hold', v_funded);

  perform write_audit(d.tenant_id, d.id, 'system', 'deal.balance_charged', jsonb_build_object(
    'balance', v_balance,
    'overage', p_overage,
    'provider_ref', p_provider_ref
  ));

  return d;
end;
$$;

-- Service role only, and the AI role never — the same grant list every other
-- money-adjacent function carries.
revoke all on function settle_deal_balance(uuid, bigint, bigint, text)
  from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'payhold_ai') then
    execute 'revoke all on function settle_deal_balance(uuid, bigint, bigint, text) from payhold_ai';
  end if;
end;
$$;
