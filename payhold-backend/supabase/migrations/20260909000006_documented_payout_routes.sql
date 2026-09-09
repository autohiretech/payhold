-- Bring `payout_routes` into line with what Stripe and Flutterwave document —
-- every page below read on 2026-09-09, the second pass of the day after
-- 20260909000003 (widen to the registry) and 20260909000004 (prune what the
-- first reading could not support).
--
-- The rule this table holds to: a row is a claim `route_payout` acts on, and a
-- wrong row is money collected that cannot be paid out. So a corridor is here
-- when the provider's own documentation supports it as this repository sends
-- it, and not when the provider says "submit a request", "registered in", or
-- names a currency code we do not price. The product owner wants payouts to
-- reach as many countries as possible; this is the widest the documentation
-- allows.
--
-- Flutterwave bank (`flutterwave_bank`):
--   * ET in ETB — added. A transfer guide exists with no gate and no extra
--     meta beyond the fields the adapter already sends.
--       https://developer.flutterwave.com/v3.0.0/docs/ethiopian-bank-account-transfers.md
--   * KE — removed. "Transfers to Kenyan bank accounts are not available by
--     default. To enable this feature, submit a request." A route row says
--     enabled; the account is not. Kenya stays reachable through M-Pesa on the
--     momo row below.
--       https://developer.flutterwave.com/v3.0.0/docs/kenya-1.md
--   * TZ — removed. "Payouts to Tanzania are only available to businesses
--     registered in Tanzania." No tenant here is, and the row cannot know.
--     Tanzania stays reachable through the momo row.
--       https://developer.flutterwave.com/v3.0.0/docs/tanzanian-bank-account-transfers.md
--   * EG — removed, with EGP. "Transfers to Egyptian bank accounts are not
--     available by default. To enable this feature, submit a request." EGP
--     mobile wallets carry the same sentence, so no other corridor uses it.
--       https://developer.flutterwave.com/v3.0.0/docs/egypt.md
--       https://developer.flutterwave.com/v3.0.0/docs/egypt-1.md
--   * KES and TZS leave this row's currency list because no remaining bank
--     country uses them; each rail row carries its own currencies, and the momo
--     row keeps both.
--   * ZA stays, with a caveat the row cannot express: the guide requires meta
--     (first_name, last_name, email, mobile_number, recipient_address) the
--     adapter does not send today. That is an adapter gap, tracked separately —
--     removing the corridor would hide it rather than fix it.
--       https://developer.flutterwave.com/v3.0.0/docs/south-africa-1.md
--
-- Flutterwave mobile money (`flutterwave_momo`):
--   * ET in ETB — added. The transfer table lists Ethiopia with the AMOLEMONEY
--     code. Collection there is not documented, and the registry says so; this
--     row is about sending.
--       https://developer.flutterwave.com/v3.0.0/docs/mobile-money.md
--   * KE stays. M-Pesa transfers are documented; the sender meta the guide
--     requires (sender, sender_country, mobile_number, first_name, last_name)
--     is being wired in the adapter alongside this migration.
--
-- Stripe Connect (`stripe_connect`):
--   * BG CZ DK HU NO PL RO SE — added, with BGN CZK DKK HUF NOK PLN RON SEK.
--     All eight are on stripe.com/global's supported list, all eight are in the
--     EEA, and 20260909000003 left them out only because `fx.ts` could not
--     price their currencies; it can now.
--       https://stripe.com/global
--   * HR and LI — re-added. 20260909000004 pruned them as "not on the Express
--     list", which was a wrong reading: Stripe's own platform-country endpoint
--     lists both, and the per-platform requirement endpoint returns a full
--     service agreement (tos=full) for both from a GB, IE or US platform. Both
--     are EEA. EUR and CHF are already on the row.
--       https://docs.stripe.com/_endpoint/get-platform-countries
--       https://docs.stripe.com/_endpoint/get-requirement-selections-for-platform-country?platformCountry=GB
--   * AE and AU — left as seeded. Both are outside the self-serve region and
--     the dashboard's provenance marks them; taking them out is a decision for
--     whoever knows the platform account's own country, which this repository
--     still does not record.
--   * The region rule, from Stripe's cross-border payouts page, is now in the
--     row's note verbatim so an operator reading the row sees the constraint:
--       https://docs.stripe.com/connect/cross-border-payouts
--
-- Net: Flutterwave bank 13 → 11 countries (+ET, −KE −TZ −EG), Flutterwave momo
-- 9 → 10 (+ET), Stripe Connect 25 → 35 (+10). `rails_verified` stays false for
-- every row — documented is not the same as watched through a live transfer.
--
-- Same idempotent shapes as 000003 and 000004: `array(select distinct unnest(a
-- || b))` for a union, `array(select unnest(a) except select unnest(b))` for a
-- removal, both restricted to the platform default rows (`tenant_id is null`) so
-- a tenant override is never touched and a re-run changes nothing.

update payout_routes
   set countries  = array(
         select unnest(array(select distinct unnest(countries || array['ET']::country_code[])))
         except select unnest(array['KE','TZ','EG']::country_code[])
       ),
       currencies = array(
         select unnest(array(select distinct unnest(currencies || array['ETB']::currency_code[])))
         except select unnest(array['KES','TZS','EGP']::currency_code[])
       ),
       note = 'Bank transfer via Flutterwave, in the corridors Flutterwave documents without a request or registration gate. Kenya and Egypt bank transfers are "not available by default — submit a request" and Tanzania is "only available to businesses registered in Tanzania", so those are not here; Kenya and Tanzania are reached by mobile money. South Africa needs recipient meta the adapter does not yet send.'
 where tenant_id is null and payout_provider = 'flutterwave_bank';

update payout_routes
   set countries  = array(select distinct unnest(countries  || array['ET']::country_code[])),
       currencies = array(select distinct unnest(currencies || array['ETB']::currency_code[])),
       note = 'Mobile money via Flutterwave Transfers, in the markets its transfer table names a wallet code for. The launch rail for §5''s Rwanda row. Kenya (M-Pesa) requires sender meta on every transfer.'
 where tenant_id is null and payout_provider = 'flutterwave_momo';

update payout_routes
   set countries  = array(select distinct unnest(countries  || array['BG','CZ','DK','HU','NO','PL','RO','SE','HR','LI']::country_code[])),
       currencies = array(select distinct unnest(currencies || array['BGN','CZK','DKK','HUF','NOK','PLN','RON','SEK']::currency_code[])),
       note = 'Stripe Connect payouts. No self-serve route to African destinations — Stripe documents them only via cross-border payouts on sales enablement or a US/GB platform on Global Payouts; the Flutterwave rails carry Africa here. Stripe''s rule: "Platforms based in the United States, United Kingdom, EEA, Canada, and Switzerland can transfer funds to connected accounts located in any of these same regions. Stripe doesn''t support self-serve cross-border payouts to countries outside the listed regions. Contact sales." The AE and AU rows predate this and sit outside that group.'
 where tenant_id is null and payout_provider = 'stripe_connect';
