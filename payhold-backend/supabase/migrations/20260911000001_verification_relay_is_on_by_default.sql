-- `seller_verification_relay` is on by default.
--
-- `20260910000011` introduced the setting off by default: an account holder
-- ticked "I review each seller myself and tell PayHold the result" in Settings,
-- and only then would `POST /v1/sellers/:id/verify` accept that account's API
-- key. The account holder has since asked for it to be on unless an account
-- turns it off, so a platform that reviews its own sellers does not also have to
-- remember to switch the relay on before its first verification arrives.
--
-- **What that trades away, stated rather than buried.** Off by default, the
-- per-seller attestation §12 wants was always somebody's: a person had said,
-- once, that the tenant's own review happens. On by default, a tenant that never
-- opens Settings has made no such statement, and its API key may verify its own
-- sellers anyway. That is a real loosening of `20260910000011`'s reasoning, and
-- it was chosen knowingly. It is acceptable here because this deployment's
-- tenant is AutoHire, whose own admins do perform the review — not because the
-- argument went away. A future multi-tenant deployment should revisit it.
--
-- **What it does not touch.** `seller_auto_verify` is unchanged and still off:
-- a seller still lands `pending` and unpayable until their platform verifies
-- them, so nobody is verified on arrival. Destination verification still refuses
-- an API key outright, and no setting opens it. `verify_seller` still re-checks
-- this flag under the seller's row lock.
--
-- **Existing choices stand.** `setting_num` returns a stored value in preference
-- to the default, so an account that saved the setting explicitly off keeps it
-- off. Only an account with no stored value moves.
--
-- Same signature, so `create or replace` keeps the function's existing grants.

create or replace function seller_verification_relay(p_tenant uuid) returns boolean
language sql
stable
as $$
  select setting_num(p_tenant, 'seller_verification_relay', 1) <> 0;
$$;

comment on function seller_verification_relay(uuid) is
  'Whether this tenant accepts per-seller verification over its API key. On by '
  'default (20260911000001); an account that stored it off keeps it off. Read '
  'only by `verify_seller`; nothing on the insert path or the payout path asks it.';
