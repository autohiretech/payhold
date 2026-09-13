-- A payout remembers what it was converted at.
--
-- `redenominate_payout` writes the whole story into `audit_log` and none of it
-- onto the row: `from_amount`, `from_currency`, `rate` and `rate_source` exist
-- exactly once, in a table no seller-facing endpoint reads. So the payout
-- itself says "USD 282.37" and nothing anywhere says what that came from.
--
-- Which is how a screen ends up inventing one. Building an exchange rate for a
-- host by dividing their wallet balance by their payout — RWF 405,347 over USD
-- 282.37 — yields 1,435.52, and it is wrong: the wallet figure has the
-- provider's fee already taken out of it and the payout was converted from
-- RWF 424,620, which does not. The real conversion was 424,620 → 282.37 at
-- Flutterwave's own quote, 1 USD = 1,503.77 RWF. Two plausible numbers, 5%
-- apart, and the wrong one looks exactly as reasonable as the right one on a
-- screen.
--
-- The fix is to stop deriving it. What was converted, from what, at what rate,
-- quoted by whom — four columns, written where the conversion happens, read
-- by anything that wants to show it. A figure a host can check against their
-- provider's own statement has to be the figure the provider actually gave.

alter table payouts
  add column if not exists fx_from_amount   bigint,
  add column if not exists fx_from_currency currency_code,
  add column if not exists fx_rate          numeric(20, 10),
  add column if not exists fx_rate_source   text;

comment on column payouts.fx_from_amount is
  'What this payout was before it was converted, in fx_from_currency. Null '
  'when no conversion happened.';

comment on column payouts.fx_rate is
  'Destination units per source unit, exactly as redenominate_payout was '
  'given it. Recorded so a rate is never re-derived from figures computed on '
  'different bases.';

comment on column payouts.fx_rate_source is
  'Who quoted it — a rail, or the indicative table. rates.ts draws that '
  'distinction and a payout restated against a number nobody quoted is what '
  'it exists to refuse.';

-- ---------------------------------------------------------------------------
-- Written where the conversion happens
-- ---------------------------------------------------------------------------
--
-- Same signature and same guards; the only change is that the four values it
-- already validates and already writes to the audit log are now also kept on
-- the row. `create or replace` accordingly, with the revokes reissued because
-- a recreated function is granted to PUBLIC by default.

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
  p        payouts;
  v_from   currency_code;
  v_amount bigint;
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
     set amount           = p_amount,
         currency         = p_currency,
         -- The conversion, kept where the money is rather than only in the
         -- audit log. A second re-denomination overwrites it on purpose: this
         -- says what the current amount came from, and the chain of every
         -- restatement is what `audit_log` is for.
         fx_from_amount   = v_amount,
         fx_from_currency = v_from,
         fx_rate          = p_rate,
         fx_rate_source   = btrim(p_rate_source)
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

-- ---------------------------------------------------------------------------
-- And the conversions that already happened
-- ---------------------------------------------------------------------------
--
-- Backfilled from `audit_log`, which is where these four values have been
-- written all along — our own record of our own conversion, not a
-- reconstruction. Only rows still carrying the currency the audit says they
-- were converted *to* are touched, so a payout re-denominated again since is
-- left to the function above rather than overwritten with an older leg.

update payouts p
   set fx_from_amount   = (a.details ->> 'from_amount')::bigint,
       fx_from_currency = (a.details ->> 'from_currency')::currency_code,
       fx_rate          = (a.details ->> 'rate')::numeric,
       fx_rate_source   = a.details ->> 'rate_source'
  from (
    select distinct on (details ->> 'payout_id') details
      from audit_log
     where action = 'payout.redenominated'
     order by details ->> 'payout_id', created_at desc
  ) a
 where p.id = (a.details ->> 'payout_id')::uuid
   and p.fx_rate is null
   and p.currency = (a.details ->> 'to_currency')::currency_code;
