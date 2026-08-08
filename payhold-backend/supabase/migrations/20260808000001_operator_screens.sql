-- ---------------------------------------------------------------------------
-- Phase 10 clears its own blocker on §16's `operator_screens`.
-- ---------------------------------------------------------------------------
--
-- `20260807000015_launch_gate.sql` states the contract this migration honours:
-- an engineering item whose code is not written carries a `blocked_by`, which
-- makes it unsignable by anybody whatever their authority, and **clearing one
-- is a row changed by the phase that does the work**. `20260807000017` did the
-- same thing for `dispute_window`.
--
-- The item names four things an operator has to be able to read before they
-- decide, and each now has a screen behind it:
--
--   the routing decision and its reason codes   Routing Center  (phase 10)
--   the seller's KYC state                      SellerDetail    (phase 10)
--   the dispute behind the payout               Resolution Center
--   the reconciliation run that froze the tenant  Admin → Passes
--
-- The last two are what landed with this migration; the first two shipped
-- earlier in the same phase, which is why the item stayed blocked until now
-- rather than being cleared twice.
--
-- **It clears the blocker and does not sign the item off**, which is the same
-- distinction `20260807000017` drew. That the screens exist is a fact a
-- migration can assert. Whether an operator can actually read a case from them
-- is a judgement, and the person making it should know two things this phase
-- decided deliberately:
--
--   - The Resolution Center lets an operator *record* a request a party made,
--     and doing so disqualifies them from deciding that dispute — §8's
--     conflict-of-interest control is enforced on who acted, so the screen
--     warns before the action rather than failing after it.
--   - `resolve_reconciliation_run` is on the Passes card and is the recorded
--     way to lift a freeze. The blunt per-tenant unfreeze is still on the
--     accounts table and still closes an account's cases with no name and no
--     note; the screen now describes it as the lesser path rather than the
--     only one. Anybody signing this item should decide whether that button
--     should survive at all.

do $$
begin
  if to_regclass('public.launch_checklist') is not null then
    update launch_checklist
       set blocked_by = null
     where code = 'operator_screens'
       and blocked_by is not null;
  end if;
end;
$$;
