-- ---------------------------------------------------------------------------
-- A split deal paid by mobile money (or any other method with no reusable
-- credential) now collects in full, up front, instead of being refused.
-- ---------------------------------------------------------------------------
--
-- `availableMethods` (`_shared/checkout.ts`) used to drop mobile money,
-- wallet and bank transfer from a split deal's method list entirely, because
-- `settle_deal_balance`'s second charge needs a saved payment method and
-- none of those three can ever produce one. That kept the second charge safe
-- by removing the choice that would strand it — at the cost of a buyer who
-- only has mobile money being unable to book a split deal at all.
--
-- The product decision is the other way round now: offer the method, and
-- charge the whole thing up front instead of a first installment. Nothing
-- is ever owed later, so there is no second charge to strand.
--
-- `presentment_amount` is what `fund_deal` checks the webhook's amount
-- against (root `CLAUDE.md`: "mismatch → disputed, never funded_held"), so
-- the column has to say the full amount *before* the provider is asked to
-- take it — charging the full amount and then finding the deal still
-- describes a first installment would land a correct charge next to a
-- mismatch and dispute it. `collapse_deal_split` is that write, under the
-- deal's own row lock, called from `startCharge` immediately before the
-- provider call whenever the buyer's chosen method cannot support the split
-- that was priced in at creation.
--
-- Deliberately one-way. A deal collapsed this way stays flat even if the
-- specific charge attempt then fails and the buyer retries with a card —
-- restoring the original split would need to remember it happened and reverse
-- it on a path that never observes the failure here, for a buyer who can
-- still complete the booking either way. Smaller, disclosed gap rather than
-- an uncollapse nothing has asked for.

create or replace function collapse_deal_split(p_deal_id uuid)
returns deals
language plpgsql
security definer
set search_path = public
as $$
declare
  d deals;
begin
  select * into d from deals where id = p_deal_id for update;

  if not found then
    raise exception 'not_found: deal % does not exist', p_deal_id
      using errcode = 'no_data_found';
  end if;

  -- Not a split deal, or already collapsed by an earlier call on this same
  -- checkout attempt (the buyer answering a rail's extra factor re-enters
  -- `startCharge`, which calls this again). Idempotent by construction.
  if d.split_percent is null then
    return d;
  end if;

  if d.status not in ('created', 'checkout_started', 'payment_pending', 'payment_failed') then
    raise exception 'policy_violation: this deal has already been funded; its pricing cannot change now'
      using errcode = 'check_violation';
  end if;

  update deals
     set presentment_amount = presentment_amount + coalesce(balance_amount, 0),
         balance_amount     = null,
         split_percent      = null
   where id = d.id
  returning * into d;

  perform write_audit(d.tenant_id, d.id, 'system', 'deal.split_collapsed', jsonb_build_object(
    'reason', 'buyer chose a payment method with no reusable credential'
  ));

  return d;
end;
$$;

-- Service role only, and the AI role never — the same grant list every other
-- money-adjacent function carries.
revoke all on function collapse_deal_split(uuid) from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'payhold_ai') then
    execute 'revoke all on function collapse_deal_split(uuid) from payhold_ai';
  end if;
end;
$$;
