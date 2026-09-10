-- The sentence on a held payout stops quoting database columns at a host.
--
-- `route_reason_text` is the third copy of a refusal our user read this
-- morning. Registration's copy was rewritten today; this one was not, so a
-- host refused at setup now gets "PayPal payouts are not available in Rwanda"
-- while a *held payout* on the same account still reads:
--
--     venmo cannot pay a destination in AE.
--
-- `venmo` is an enum value and `AE` is a column. Both reach a person: this
-- text is written to `payouts.failure_reason` and rendered on an Earnings
-- screen, and AutoHire forwards PayHold's wording to hosts unedited. "One
-- fact, one sentence" was false for as long as the two disagreed.
--
-- **Two things this deliberately does not do.**
--
-- It does not name the country. §29.11 keeps the country registry in
-- `countries.ts`, generated into both TypeScript copies by one script, and
-- `payhold-backend/CLAUDE.md` is explicit that copying it into SQL "would give
-- it a second home that drifts the first time somebody edits one and not the
-- other". A `country_code -> name` table here would be exactly that. So the
-- sentence drops the country instead of translating it — a host reading their
-- own Earnings page already knows which market they are in, and the country is
-- still on the row for anyone who needs it. That turns a constraint into
-- better copy rather than a compromise.
--
-- It does not touch `reason_code`. The codes are the stable contract that
-- `payout_decisions` records and clients switch on; only the prose moves.
--
-- The rail is a different matter and *is* translated. `payout_provider` is a
-- closed enum of eight values, not a registry — a label map for it cannot
-- drift from anything, because adding a value without a label is a compile
-- error in the `case` below rather than a stale row.

create or replace function rail_label(p_rail payout_provider) returns text
language sql
immutable
as $$
  select case p_rail
    when 'flutterwave_momo' then 'Mobile money'
    when 'flutterwave_bank' then 'Bank transfer'
    when 'stripe_connect'   then 'Stripe'
    when 'paypal'           then 'PayPal'
    when 'venmo'            then 'Venmo'
    when 'cash_app_pay'     then 'Cash App Pay'
    when 'alipay'           then 'Alipay'
    when 'wechat_pay'       then 'WeChat Pay'
  end;
$$;

comment on function rail_label(payout_provider) is
  'The name a person calls this rail. Mirrors RAIL_LABEL in '
  'sellers/rail-adapter.ts and PAYOUT_PROVIDER_LABEL in the dashboard, so one '
  'rail reads the same wherever it is named.';

create or replace function route_reason_text(
  p_code     text,
  p_rail     payout_provider,
  p_country  country_code,
  p_currency currency_code
) returns text
language sql
immutable
as $$
  select case p_code
    when 'routed' then
      format('Paid by %s.', rail_label(p_rail))
    when 'market_closed' then
      'Payouts to this market are paused at the moment.'
    when 'provider_unavailable' then
      format('%s payouts are not available yet.', rail_label(p_rail))
    when 'provider_disabled' then
      format('%s payouts are not available yet.', rail_label(p_rail))
    when 'route_suspended' then
      format('%s payouts are suspended.', rail_label(p_rail))
    when 'route_under_review' then
      format('%s payouts are under review and cannot be used right now.', rail_label(p_rail))
    when 'payouts_not_supported' then
      format('%s can collect payments but cannot send them.', rail_label(p_rail))
    when 'country_not_supported' then
      format('%s payouts are not available in this market.', rail_label(p_rail))
    -- The currency code stays, and stays deliberately: it is what the money
    -- arrives as, and a host who is owed RWF should see RWF. The rail id and
    -- the country code are ours; the currency is theirs.
    when 'currency_not_supported' then
      format('%s cannot pay out in %s.', rail_label(p_rail), p_currency)
    when 'below_route_minimum' then
      format('This amount is below the minimum %s will send.', rail_label(p_rail))
    when 'above_route_maximum' then
      format('This amount is above the maximum %s will send.', rail_label(p_rail))
    when 'destination_not_verified' then
      'The payout destination has not been verified.'
    when 'no_eligible_verified_destination' then
      'No verified payout destination has been registered.'
    else
      format('%s cannot be used for this payout.', rail_label(p_rail))
  end;
$$;

revoke all on function rail_label(payout_provider) from public, anon, authenticated;
grant execute on function rail_label(payout_provider) to service_role;
