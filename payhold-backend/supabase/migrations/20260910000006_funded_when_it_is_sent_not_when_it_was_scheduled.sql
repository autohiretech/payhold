-- The balance guard, asked again in the moment before the money leaves.
--
-- `settle_payout` has refused a payout larger than the rail's available
-- balance since `20260805000002`, under the payout's own row lock, and that
-- remains the authority. What it cannot do is refuse it *in time*:
-- `dispatchPayout` calls the provider first and books second, deliberately —
-- a transfer that succeeded but was not booked is re-sent next pass on the
-- same idempotency key, where booking first would report a seller paid who
-- was not.
--
-- So there is a window. `amountLeaving` reads the deal's clearing pool, then
-- the dispatcher looks up the seller, the tenant and the provider credentials
-- — several round trips — and only then sends. A **partial refund landing
-- inside that window** shrinks the pool after the figure was taken: the
-- transfer goes for the old amount, `settle_payout` then refuses to book it,
-- and the payout retries against an idempotency key that returns the
-- over-sent transfer. Stuck, with money already gone. A full refund does not
-- reach this — it fails the scheduled payout outright, and
-- `PAYABLE_DEAL_STATUSES` is checked early — which is exactly why the partial
-- case is the one left: §29.8 keeps the deal's status unchanged, so nothing
-- upstream notices.
--
-- This function is that same guard, callable on its own, so the dispatcher can
-- ask immediately before the provider call instead of only discovering the
-- answer afterwards. Three things it deliberately is not:
--
-- **It is not a second definition of the rule.** The comparison is
-- `rail_balances`, character for character what `settle_payout` asks. A
-- guard that computed availability its own way would be free to disagree with
-- the one that actually books, and the disagreement would surface as a payout
-- this passes and that refuses — the worst of both.
--
-- **It does not compute the amount.** `p_leaving` still comes from
-- `amountLeaving`, the same figure that will be booked. SQL owning the
-- validation and TypeScript owning the derivation is the division of labour
-- this whole engine is built on; duplicating the pool arithmetic here would
-- give `POOL_ENTRY_TYPES` a second home to drift from.
--
-- **It does not close the window, it narrows it.** The lock is released when
-- this returns, because the alternative is holding a row lock across
-- somebody else's HTTP call — a provider outage would then hold locks on
-- every in-flight payout. What was a window spanning several round trips is
-- now the gap between two adjacent statements. Genuinely closing it means
-- making a partial refund and an in-flight dispatch mutually exclusive, which
-- is a change to `refund_deal`'s contract and deserves its own migration
-- rather than a clause in this one.
create or replace function assert_payout_funded(
  p_payout_id uuid,
  p_leaving   bigint
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  p payouts;
  d deals;
begin
  -- The lock is what makes this a re-read rather than a second opinion: a
  -- refund adjusting this payout either completed before we looked or waits
  -- until after, and cannot land halfway through the comparison.
  select * into p from payouts where id = p_payout_id for update;

  if not found then
    raise exception 'not_found: payout % does not exist', p_payout_id
      using errcode = 'no_data_found';
  end if;

  select * into d from deals where id = p.deal_id;

  if not found then
    raise exception 'not_found: payout % has no deal', p_payout_id
      using errcode = 'no_data_found';
  end if;

  if p_leaving > (
    select coalesce(available, 0) from rail_balances(p.tenant_id)
    where provider = d.provider and currency = d.presentment_currency
  ) then
    raise exception 'insufficient_balance: payout of % exceeds available balance on % %',
      p_leaving, d.provider, d.presentment_currency
      using errcode = 'check_violation';
  end if;
end;
$$;

comment on function assert_payout_funded(uuid, bigint) is
  'Re-ask settle_payout''s balance guard under the payout''s row lock, so a '
  'pool drained after the figure was taken stops the transfer instead of '
  'stranding one that has already gone. Moves no money and writes nothing.';

-- Service role only, like every other money function, and explicitly not the
-- AI role: invariant 9's grant list is what makes "the model cannot reach a
-- money path" a refusal Postgres issues rather than a convention.
revoke all on function assert_payout_funded(uuid, bigint)
  from public, anon, authenticated;
revoke all on function assert_payout_funded(uuid, bigint) from payhold_ai;
