-- ---------------------------------------------------------------------------
-- Venmo and Cash App Pay payouts stay off for their own reason, not their
-- adapter's.
-- ---------------------------------------------------------------------------
--
-- `assert_route_has_live_provider` (migration `20260807000011`) only checked
-- that `payout_routes.provider`'s adapter was `implemented and enabled`. That
-- was the whole rule for `china_wallet_partner` and for Cash App Pay, which
-- carry no adapter of their own — but Venmo's route names `provider = 'paypal'`
-- (root `CLAUDE.md`: "one adapter carries several"), and `20260813000002`
-- switched PayPal's capability row on so it could **collect**. The trigger
-- cannot tell "PayPal may collect now" from "PayPal may pay Venmo now" because
-- it only asks whether the adapter behind the route is live — so enabling
-- collection silently reopened a door root `CLAUDE.md` and `PAYHOLD_V2_PLAN.md`
-- both call permanent: "§17 also rules out personal Venmo accounts, so this
-- stays off even once an adapter exists." `tests/launch-gate.test.ts` caught
-- it directly — the `update ... set enabled = true where payout_provider =
-- 'venmo'` it expects to fail started succeeding.
--
-- The fix names the real blocked paths rather than the `payout_provider`
-- label outright: `tests/payout-routing.test.ts`'s §5.2 case 2 deliberately
-- reassigns the 'venmo' row to `provider = 'stripe'` for one tenant, as a
-- hypothetical that exercises the routing engine's general "any adapter can
-- stand behind any route" mechanic — the comment there says so directly
-- ("nothing sends here — the test asks the engine, not a provider"). That is
-- not a personal Venmo transfer at all; it is the enum value reused as a
-- label, so the check is scoped to specific (`payout_provider`, `provider`)
-- pairs rather than a payout_provider alone.
--
-- A third pair joins Venmo and Cash App Pay for a related but separate
-- reason: root `CLAUDE.md`'s PayPal section describes PayPal's own payout row
-- as staying refused — "capability row stays off and
-- `payout_routes_require_live_provider` keeps its routes refused" — because
-- §16 wants a signed payout agreement per market before that corridor may
-- open, same as every other rail. `20260813000002` made that sentence false
-- for the same reason it broke Venmo: it is the identical `enabled` flag
-- doing collection *and* payout gatekeeping for one adapter, and nothing
-- here yet reads a per-market sign-off before letting the payout half
-- follow. Until that exists, PayPal's own payout route is blocked the same
-- way — not because §17 forbids it forever like the other two, but because
-- nothing has earned it yet, and a structural block is safer than trusting
-- an operator to remember not to flip a row that now passes every existing
-- check.

create or replace function assert_route_has_live_provider() returns trigger
language plpgsql
as $$
begin
  -- §17: permanent, regardless of what the shared adapter is doing for
  -- somebody else.
  if new.enabled and (
    (new.payout_provider = 'venmo' and new.provider = 'paypal') or
    (new.payout_provider = 'cash_app_pay' and new.provider = 'cash_app_pay')
  ) then
    raise exception
      'policy_violation: % is not available for payouts — personal accounts only, §17',
      new.payout_provider
      using errcode = 'check_violation';
  end if;

  -- §16: PayPal's own payout corridor waits on a signed per-market agreement,
  -- same as every other rail — not forever, just not yet, and not decided by
  -- an `enabled` flag that collection already needed to flip for itself.
  if new.enabled and new.payout_provider = 'paypal' and new.provider = 'paypal' then
    raise exception
      'policy_violation: paypal payouts need a signed agreement before this route can be enabled — §16'
      using errcode = 'check_violation';
  end if;

  if new.enabled and not exists (
    select 1 from provider_capabilities c
     where c.provider = new.provider and c.implemented and c.enabled
  ) then
    raise exception
      'policy_violation: % has no live adapter, so the % route cannot be enabled',
      new.provider, new.payout_provider
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;
