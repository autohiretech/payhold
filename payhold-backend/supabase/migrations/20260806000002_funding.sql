-- Funding: the transactional half of an inbound provider webhook.
--
-- The Edge Function does the parts that talk to the outside world — check the
-- signature, re-fetch the transaction from the provider, work out the FX rate.
-- This does the part that has to be atomic: decide whether what arrived matches
-- the deal, and write the hold.
--
-- Invariant 3 is the reason the comparison lives here rather than in
-- TypeScript. "Mismatch → disputed, never funded_held" is only a guarantee if
-- the comparison and the state write happen in one transaction; done over two
-- round trips, a concurrent retry can slip between them.

-- ---------------------------------------------------------------------------
-- fund_deal
-- ---------------------------------------------------------------------------

-- p_verified_* are what the PROVIDER says arrived, re-fetched from their API —
-- never what the webhook body claimed. p_presentment_amount is what the deal
-- expects to be charged, which for a converted deal the caller has already
-- computed at the locked rate.
create or replace function fund_deal(
  p_deal_id            uuid,
  p_provider           provider,
  p_provider_ref       text,
  p_method             payment_method,
  p_network            text,
  p_verified_amount    bigint,
  p_verified_currency  currency_code,
  p_fx_rate            numeric default null,
  p_auto_release_days  numeric default 3
) returns deals
language plpgsql
security definer
set search_path = public
as $$
declare
  d                  deals;
  mismatch           boolean;
  expected_amount    bigint;
  expected_currency  currency_code;
begin
  select * into d from deals where id = p_deal_id for update;

  if not found then
    raise exception 'not_found: deal % does not exist', p_deal_id
      using errcode = 'no_data_found';
  end if;

  -- Idempotency (invariant 4). A redelivered webhook carrying the reference we
  -- already recorded is a no-op, not an error: providers retry by design, and
  -- an error would make them retry harder.
  if d.provider_ref is not distinct from p_provider_ref and d.status <> 'created' then
    return d;
  end if;

  if d.status <> 'created' then
    raise exception 'invalid_state: deal % is %, cannot be funded', p_deal_id, d.status
      using errcode = 'check_violation';
  end if;

  -- Captured before the update overwrites them with what actually arrived, so
  -- the audit row can say what we were expecting.
  expected_amount := d.presentment_amount;
  expected_currency := d.presentment_currency;

  mismatch := p_verified_amount is distinct from expected_amount
           or p_verified_currency is distinct from expected_currency;

  -- The money is recorded either way. It genuinely arrived at the provider, so
  -- omitting the ledger entry would put us permanently out of step with their
  -- balance and hand the reconciliation cron a mismatch it cannot explain.
  -- What differs is the state: a deal whose payment does not match cannot
  -- become funded_held, so it goes to a human instead.
  update deals
     set status = case when mismatch then 'disputed'::deal_status
                       else 'funded_held'::deal_status end,
         provider = p_provider,
         provider_ref = p_provider_ref,
         payment_method = p_method,
         payment_network = p_network,
         -- Book what actually arrived. Overwriting the expectation with the
         -- truth is what keeps the ledger and the provider in agreement.
         presentment_amount = p_verified_amount,
         presentment_currency = p_verified_currency,
         fx_rate = case when p_verified_currency is distinct from d.currency
                        then p_fx_rate else null end,
         auto_release_at = case when mismatch then null else
           coalesce(d.expected_complete_at, now()) + (p_auto_release_days || ' days')::interval
         end
   where id = d.id
  returning * into d;

  perform write_ledger(d, 'hold', d.presentment_amount);

  if d.deposit_amount is not null then
    perform write_ledger(d, 'deposit_hold', d.deposit_amount);
  end if;

  perform write_audit(d.tenant_id, d.id, 'system', 'webhook.verified', jsonb_build_object(
    'provider', p_provider,
    'provider_ref', p_provider_ref
  ));

  if mismatch then
    perform write_audit(d.tenant_id, d.id, 'system', 'deal.amount_mismatch',
      jsonb_build_object(
        'expected_amount', expected_amount,
        'expected_currency', expected_currency,
        'received_amount', p_verified_amount,
        'received_currency', p_verified_currency
      ));
  else
    perform write_audit(d.tenant_id, d.id, 'system', 'deal.funded_held',
      jsonb_build_object('amount', d.amount, 'currency', d.currency));
  end if;

  return d;
end;
$$;

revoke all on function fund_deal(uuid, provider, text, payment_method, text, bigint, currency_code, numeric, numeric)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Deposits: recording the pre-auth reference
-- ---------------------------------------------------------------------------

-- A security deposit is a second provider transaction against the same deal —
-- its own pre-auth, its own reference. `deals.provider_ref` belongs to the
-- payment, so the deposit's lives in metadata rather than colliding with it.
create or replace function record_deposit_ref(
  p_deal_id      uuid,
  p_provider_ref text
) returns deals
language plpgsql
security definer
set search_path = public
as $$
declare
  d deals;
begin
  update deals
     set metadata = metadata || jsonb_build_object('deposit_provider_ref', p_provider_ref)
   where id = p_deal_id
  returning * into d;

  if not found then
    raise exception 'not_found: deal % does not exist', p_deal_id
      using errcode = 'no_data_found';
  end if;

  return d;
end;
$$;

revoke all on function record_deposit_ref(uuid, text) from public, anon, authenticated;
