-- cancel_deal: record the status the deal actually came from.
--
-- 20260909000002 wrote the audit row after `update deals … returning * into d`,
-- so `d.status` was already 'canceled' by the time `write_audit` read it. Every
-- deal.canceled row in audit_log says from_status = 'canceled' — the one value
-- that field cannot mean. Nothing else about the function changes; the status
-- is captured into a local before the row is rewritten. Found by a sibling
-- session while writing expire_stale_deals to the same shape.

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
  d      deals;
  v_from deal_status;
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

  v_from := d.status;

  update checkout_sessions set status = 'canceled'
   where deal_id = d.id and status = 'open';

  update deals set status = 'canceled'
   where id = d.id
  returning * into d;

  perform write_audit(
    p_tenant, d.id, p_actor, 'deal.canceled',
    jsonb_build_object(
      'from_status', v_from,
      'reason', p_reason
    )
  );

  return d;
end;
$$;

revoke all on function cancel_deal(uuid, uuid, text, text) from public, anon, authenticated;
