-- A scheduled payout follows a seller who changes country or payout method.
--
-- `releaseFigures` reads `sellers.payout_currency` at release and
-- `release_deal` writes it onto the payout row, which is right: the seller is
-- owed their own currency, whatever the buyer paid in. What nothing did was
-- notice that the answer can change afterwards. A host who released in Rwanda
-- and then moved to a US PayPal account kept a payout denominated RWF, and
-- `route_evaluation` correctly answered `currency_not_supported` for every rail
-- — PayPal and Stripe both reach the United States and neither sends RWF. The
-- money was theirs, the destination was verified and out of its hold, and
-- nothing could carry it.
--
-- The fix is not a wider routing table. Enabling a corridor that does not exist
-- would turn a clear refusal into a transfer that fails at the rail with the
-- buyer's money already collected, which is the failure `MOMO_UNVERIFIED` and
-- `payout_routes_require_live_provider` both exist to prevent. What was missing
-- is the step that re-denominates the payout into the currency the seller is
-- now paid in, so routing is asked a question it can answer.
--
-- **The converted figure is passed in, never derived here.** There is exactly
-- one FX table in this system and it is not in the database; `_shared/rates.ts`
-- quotes the corridor from the tenant's own Flutterwave account and refuses
-- rather than reaching for the indicative table. So this function takes the
-- amount, the rate and the rate's source, and its job is the part only a
-- transaction can do: the row lock, the guards, and the audit row.
--
-- **It moves no money and writes no ledger entry.** Nothing has left anywhere.
-- `amountLeaving` reads the deal's clearing pool in the presentment currency
-- and is untouched by this; what changes is the figure `settle_payout` will
-- later book as the `cross_rail_payout` half of a cross-rail settlement, which
-- is exactly the case that pair was built for — "a genuinely different number
-- in a different currency".
--
-- **`paid` and `processing` are refused.** Re-denominating a transfer already
-- with the rail would rewrite the amount of money that has gone, and
-- `hold_payout` and `hold_payout_unfunded` refuse the same two statuses for the
-- same reason: recalling an in-flight transfer is a conversation with the
-- provider, not an update.
--
-- A payout already in the target currency is a **no-op that returns the row**
-- rather than an error, so `dispatchPayout` may ask on every pass without
-- having to know the answer first — the same shape `end_destination_hold` uses
-- for a hold that has already lapsed.

create or replace function redenominate_payout(
  p_payout_id   uuid,
  p_amount      bigint,
  p_currency    text,
  p_rate        numeric,
  p_rate_source text
) returns payouts
language plpgsql
security definer
set search_path = public
as $$
declare
  p         payouts;
  v_from    text;
  v_amount  bigint;
begin
  select * into p from payouts where id = p_payout_id for update;

  if not found then
    raise exception 'not_found: payout % does not exist', p_payout_id
      using errcode = 'no_data_found';
  end if;

  -- Already where it needs to be. Not an error: the caller asks on every pass.
  if p.currency = p_currency then
    return p;
  end if;

  if p.status in ('paid', 'processing') then
    raise exception 'invalid_state: payout % is already % and its amount cannot be restated',
      p_payout_id, p.status
      using errcode = 'check_violation';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'invalid_request: a re-denominated payout needs a positive amount'
      using errcode = 'check_violation';
  end if;

  if p_rate is null or p_rate <= 0 then
    raise exception 'invalid_request: a re-denominated payout needs the rate it was converted at'
      using errcode = 'check_violation';
  end if;

  -- The source is not decoration. `rates.ts` distinguishes a live quote from
  -- the indicative table, and a payout restated against a number nobody quoted
  -- is the thing that file exists to refuse. Recording which it was is what
  -- makes that checkable afterwards.
  if coalesce(btrim(p_rate_source), '') = '' then
    raise exception 'invalid_request: a re-denominated payout needs the source of its rate'
      using errcode = 'check_violation';
  end if;

  v_from   := p.currency;
  v_amount := p.amount;

  update payouts
     set amount   = p_amount,
         currency = p_currency
   where id = p.id
  returning * into p;

  perform write_audit(p.tenant_id, p.deal_id, 'system', 'payout.redenominated',
    jsonb_build_object(
      'payout_id', p.id,
      'from_amount', v_amount,
      'from_currency', v_from,
      'to_amount', p_amount,
      'to_currency', p_currency,
      'rate', p_rate,
      'rate_source', p_rate_source
    ));

  return p;
end;
$$;

revoke all on function redenominate_payout(uuid, bigint, text, numeric, text)
  from public, anon, authenticated;
revoke all on function redenominate_payout(uuid, bigint, text, numeric, text)
  from payhold_ai;
grant execute on function redenominate_payout(uuid, bigint, text, numeric, text)
  to service_role;
