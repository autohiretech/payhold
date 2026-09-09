-- Widen `payout_routes` to the corridors the registry already claims and the
-- FX table can already price — the registry had run ahead of the table.
--
-- `countries.ts` is the generated registry of where money *can* go;
-- `payout_routes` is where it may go today, and 20260807000009's header says
-- adding a country is an insert, not a release. What nobody wrote down is that
-- two things read the two different lists. `payoutRoute()` in `rails.ts` —
-- the registry — is what destination registration consults, and what
-- `GET /v1/payment-options?payout_country=` answers with. `route_payout` — this
-- table — is what actually sends the money. On 2026-09-09 the registry said
-- Stripe pays out to 44 countries and Flutterwave to 25; this table had Stripe
-- at 11 and Flutterwave at 12 (bank) and 9 (momo). So a seller in any of ~46
-- countries could register a destination the code accepted, be told by the
-- client they were set up, and have every payout land `blocked: no route`.
-- The same shape as the Rwandan `stripe_connect` primary this repository
-- refused earlier the same day, forty-six corridors wide, in the other
-- direction.
--
-- This closes the gap for every corridor whose payout currency `fx.ts`'s
-- `PER_USD` can already convert, and deliberately not the rest:
--
--   * Stripe: +20. The eurozone members the registry lists (AT BE CY EE FI GR
--     HR LT LU LV MT PT SI SK) paid in EUR; CH and LI in CHF; JP, SG, BR and
--     MX in their own currencies. All five new currencies are in `PER_USD`.
--   * Stripe, left out: BG CZ DK GI HK HU MY NO NZ PL RO SE TH. Their
--     currencies are not in `PER_USD`, so a seller there could register, be
--     routed, and fail at conversion — a corridor that is broken in a new
--     place is not wider coverage. They wait on `_shared/rates.ts`, which
--     waits on the static-IP proxy.
--   * Flutterwave bank: +13 — BF BJ CF CG GA GQ GW ML MW NE SL TD TG — in
--     XOF, XAF, MWK and SLE, all priced.
--   * Flutterwave momo: unchanged. BF and MW are `momo: true` in the registry,
--     but `_shared/momo.ts` carries no `account_bank` codes for either, and
--     `destinationCredentials` refuses a wallet it cannot name a code for. A
--     momo route for a country whose wallets cannot be registered would be
--     the registry running ahead again, one layer down.
--
-- What this is not: verification. `rails_verified` stays false for every one
-- of these, exactly as it is for the rows already here — the codes are
-- transcribed from provider documentation and no corridor outside Rwanda has
-- been watched through a live transfer. A research pass against Stripe's and
-- Flutterwave's published coverage was started the same day and did not
-- finish; it should be run before any of these carries live money, and the
-- launch gate already makes that a precondition rather than a hope.
--
-- Unions, not replacements, so re-running adds nothing twice and a tenant
-- override row (non-null `tenant_id`) is untouched — the platform defaults are
-- the only rows widened.

update payout_routes
   set countries  = array(select distinct unnest(countries  || array['AT','BE','BR','CH','CY','EE','FI','GR','HR','JP','LI','LT','LU','LV','MT','MX','PT','SG','SI','SK']::country_code[])),
       currencies = array(select distinct unnest(currencies || array['CHF','JPY','BRL','MXN','SGD']::currency_code[]))
 where tenant_id is null and payout_provider = 'stripe_connect';

update payout_routes
   set countries  = array(select distinct unnest(countries  || array['BF','BJ','CF','CG','GA','GQ','GW','ML','MW','NE','SL','TD','TG']::country_code[])),
       currencies = array(select distinct unnest(currencies || array['MWK','SLE']::currency_code[]))
 where tenant_id is null and payout_provider = 'flutterwave_bank';
