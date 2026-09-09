-- `cancel_deal` — the writer `canceled` never had.
--
-- The lifecycle has allowed `created`, `checkout_started`, `payment_pending`
-- and `payment_failed` to move to `canceled` since 20260807000002, the
-- `deals_notify` trigger has queued `order.canceled` for it, and the guard
-- makes it terminal. Nothing ever wrote it. A client that opened a deal and
-- then closed its checkout had no way to say so, and every abandoned checkout
-- became a permanent `created` or `checkout_started` row — AutoHire's tenant
-- carried dozens, one per time a renter opened the payment sheet and went
-- away. They were not wrong, exactly; they were unfinished forever, and a
-- Deals screen where "Not paid yet" means "nobody ever will" is a screen
-- nobody can read.
--
-- Cancelling is only ever a statement about a deal that holds no money, and
-- the function refuses anything else under the row lock:
--
--   * `created`, `checkout_started`, `payment_failed` — nothing has been
--     collected and no charge is in flight. Cancel.
--   * `payment_pending` — the guard allows it and this function does **not**.
--     A charge has been started at a rail: a MoMo push the buyer may still
--     approve, a card the provider may still capture. `canceled` is terminal,
--     so a settlement arriving afterwards would be refused by the transition
--     guard and the money would sit at the provider with no deal willing to
--     admit it had arrived — the exact shape `settle-pending` exists to
--     prevent. Wait for `payment_failed` or `funded_held`; the first cancels,
--     the second refunds.
--   * `funded_held` and later — money exists. That is a refund (`refund_deal`),
--     which books the ledger entry a cancel has no business writing.
--
-- Any open checkout session for the deal is withdrawn in the same
-- transaction. A live payment link pointing at a canceled deal would let the
-- buyer reach a provider for a deal that will refuse the money — the one
-- case above, manufactured on purpose.
--
-- The row is **not** deleted. No deal is ever deleted here except by the
-- owner's sandbox reset: "who created this, when, and who canceled it" is a
-- question asked after something goes wrong, and `canceled` with an audit
-- row answers it where an absent row cannot. A client that wants the
-- booking gone from its own screens deletes its own booking row; PayHold
-- keeps the fact.
--
-- Idempotent on an already-canceled deal: returns it, writes nothing. A
-- second press of the same × must not put a second name in the audit log.

create or replace function cancel_deal(
  p_deal   uuid,
  p_tenant uuid,
  p_actor  text,
  p_reason text default null
) returns deals
language plpgsql
security definer
set search_path = public
as $$
declare
  d deals;
begin
  if p_actor is null or btrim(p_actor) = '' then
    raise exception 'policy_violation: cancelling a deal must record who canceled it'
      using errcode = 'check_violation';
  end if;

  select * into d from deals where id = p_deal and tenant_id = p_tenant for update;

  if not found then
    raise exception 'not_found: deal % does not exist', p_deal
      using errcode = 'no_data_found';
  end if;

  if d.status = 'canceled' then
    return d;
  end if;

  if d.status = 'payment_pending' then
    raise exception 'invalid_state: a payment is in flight for this deal — wait for it to fail or settle; a settled payment is refunded, not canceled'
      using errcode = 'check_violation';
  end if;

  if d.status not in ('created', 'checkout_started', 'payment_failed') then
    raise exception 'invalid_state: a deal in status % holds money and cannot be canceled — refund it instead', d.status
      using errcode = 'check_violation';
  end if;

  -- Withdraw the link before the status moves, so nothing between the two
  -- statements can complete a session against a deal about to refuse it.
  update checkout_sessions set status = 'canceled'
   where deal_id = d.id and status = 'open';

  update deals set status = 'canceled'
   where id = d.id
  returning * into d;

  perform write_audit(
    p_tenant, d.id, p_actor, 'deal.canceled',
    jsonb_build_object(
      'from_status', d.status,
      'reason', p_reason
    )
  );

  return d;
end;
$$;

revoke all on function cancel_deal(uuid, uuid, text, text) from public, anon, authenticated;
