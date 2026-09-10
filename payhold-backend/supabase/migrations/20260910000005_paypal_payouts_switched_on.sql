-- PayPal payouts are switched on, at the account holder's instruction.
--
-- `20260815000007` refused to let the `(paypal, paypal)` route be enabled at
-- all, citing §16's signed payout agreement. That refusal was a policy gate
-- written into a trigger, not a technical constraint, and the person whose
-- agreement it was waiting on has asked for the rail on — twice, the second
-- time after being told plainly what it means. So the gate goes, and this
-- migration is the record of who lifted it and when.
--
-- **The §17 refusals are untouched and stay permanent.** Venmo and Cash App
-- Pay are personal-account rails that may not receive marketplace payouts, and
-- that is not the same kind of gate: it is a rule about the instruments, not a
-- document waiting to be signed. `assert_route_has_live_provider` still raises
-- on `(venmo, paypal)` and `(cash_app_pay, cash_app_pay)`, and the adapter
-- check below still refuses any rail whose provider has no live adapter.
--
-- **What this does not do is make PayPal able to pay anybody.** Enabling a
-- route says PayHold will attempt it; whether it succeeds depends on PayPal
-- having approved the Payouts API on the connected account, which is theirs to
-- grant and nothing here can assert. If it has not been, a payout reaches
-- `release`, PayPal refuses the batch, and the payout fails with the money
-- already collected and held — the shape this system spent 2026-09-09 and
-- 2026-09-10 removing from the Flutterwave and Stripe corridors. The account
-- holder was told this before asking again.
--
-- Two things still stand between this row and a bad payout, and both are
-- deliberate. `route_evaluation` will not route a corridor the country and
-- currency arrays do not carry — that list came from PayPal's own country
-- table in `20260910000003`, and the currencies are intersected with what the
-- FX table can price. And `payoutRoute` puts PayPal last, after both local
-- rails, so no seller who is already being paid moves onto it.

create or replace function assert_route_has_live_provider() returns trigger
language plpgsql
as $$
begin
  -- §17: permanent, regardless of what the shared adapter is doing for
  -- somebody else. Venmo and Cash App Pay are personal-account instruments and
  -- may not be paid out to.
  if new.enabled and (
    (new.payout_provider = 'venmo' and new.provider = 'paypal') or
    (new.payout_provider = 'cash_app_pay' and new.provider = 'cash_app_pay')
  ) then
    raise exception
      'policy_violation: % is not available for payouts — personal accounts only, §17',
      new.payout_provider
      using errcode = 'check_violation';
  end if;

  -- The §16 refusal on `(paypal, paypal)` was here and is deliberately gone —
  -- see this migration's header. PayPal payouts are now enabled or disabled by
  -- the row's own `enabled` flag, like every other rail.

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

-- And switch it on. `provider = 'paypal'` is already set on this row and the
-- adapter check above is what proves it: PayPal is `implemented` and `enabled`
-- in `provider_capabilities`, so this passes rather than being waved through.
update payout_routes
   set enabled = true,
       note = 'PayPal Payouts to a wallet receiver, from PayPal''s own '
              || 'country/feature table (2026-09-10): every market where a '
              || 'recipient can receive and withdraw. Enabled 2026-09-10 at '
              || 'the account holder''s instruction, replacing §16''s '
              || 'signed-agreement gate. PayHold will attempt these payouts; '
              || 'whether PayPal accepts them depends on the Payouts API '
              || 'being approved on the connected account, which is PayPal''s '
              || 'to grant. Ranked last in payoutRoute, so it carries only '
              || 'markets neither Flutterwave nor Stripe reaches.'
 where tenant_id is null
   and payout_provider = 'paypal';
