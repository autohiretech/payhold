-- A local rail pays in local money, and the table could not say so.
--
-- `payout_routes` carries `countries` and `currencies` as two independent
-- arrays, and every reader — `route_evaluation`, `loadPayoutCoverage` — asks
-- `countries @> country and currencies @> currency`. That is a cross product.
-- `flutterwave_momo` carries nine countries and eight currencies, so the table
-- states, among other things, that Flutterwave will pay a **Kenyan M-Pesa
-- wallet in Rwandan francs**. It will not. Nor Ugandan shillings to a Ghanaian
-- bank, nor XOF to a Zambian one — 63 of that row's 72 implied corridors are
-- fiction.
--
-- This has been latent since `20260807000009` because nothing ever asked. A
-- client reads `?payout_country=KE`, the endpoint defaults the currency to the
-- country's own, and KE/KES is one of the nine pairs that are real. The moment
-- a client can ask for a *different* currency — which is exactly what a payout
-- currency chooser is — the other 63 become answerable, and each one is a
-- destination a seller can register, PayHold will route, and the rail will
-- refuse with the buyer's money already collected and held.
--
-- The distinction the table was missing is not per-corridor currency lists,
-- which would be 88 rows for PayPal alone. It is one fact per rail: **does
-- this rail pay across borders, or only in the country's own money?**
--
--   * `flutterwave_momo` / `flutterwave_bank` — local. A mobile money wallet
--     and a domestic bank account are denominated in the country's currency;
--     there is no version of either that receives a foreign one.
--   * `stripe_connect` / `paypal` — cross-border, which is the entire reason
--     they are on this list. PayPal's row carries 88 countries and 17
--     currencies precisely because a PayPal account in Kenya really can be
--     paid in USD, and that is the corridor `20260910000003` was enabled for.
--
-- Default `false` — cross-border — is deliberately the *permissive* value, so
-- this migration changes the meaning of no existing row except the two it
-- names. A new rail added without thinking about it behaves exactly as every
-- rail behaved before today rather than silently narrowing.
--
-- **What this does not do yet is change `route_evaluation`.** Reading the flag
-- there would make registration refuse KE/RWF, which is the right end state
-- and is not a change to make in the same breath as adding a column: it would
-- newly refuse corridors that are accepted today, including any seller already
-- registered on one. That is a decision with a migration of its own. Until
-- then this flag has exactly one reader — `payableCurrencies`, which is what
-- decides whether a currency is ever *offered* — so the surface a client can
-- reach is honest even while the engine behind it is still permissive.
alter table payout_routes
  add column if not exists local_currency_only boolean not null default false;

comment on column payout_routes.local_currency_only is
  'True when this rail can only pay a seller in their own country''s currency '
  '— a mobile money wallet or a domestic bank account. False for a rail that '
  'genuinely pays across borders (Stripe Connect, PayPal). Guards the cross '
  'product implied by countries × currencies: without it the table claims '
  'every pairing of the two arrays, which for the Flutterwave rails is mostly '
  'fiction.';

update payout_routes
   set local_currency_only = true
 where payout_provider in ('flutterwave_momo', 'flutterwave_bank');
