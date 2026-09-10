-- Malawi becomes payable, by wallet only.
--
-- 20260909000004 excluded Malawi on the strength of its **bank** page, which
-- says verbatim "Transfers to Malawian bank accounts are not available by
-- default. To enable this feature, submit a request." That gate is real and it
-- still stands — but it is a fact about the bank destination, and it was
-- generalised into a fact about the country. A Malawian host has been
-- unpayable since, by any means.
--
-- The wallet is not gated. Both Flutterwave doc trees carry an MWK mobile
-- money payout naming `AIRTELMW` / "Airtel Malawi", with no availability
-- caveat, no merchant-location restriction and no extra `meta` fields:
--
--   https://developer.flutterwave.com/docs/mobile-money-1
--   https://developer.flutterwave.com/v3.0.0/docs/mobile-money
--
-- Read 2026-09-10. What made this hard to see is that Flutterwave's own
-- supported-networks table omits Malawi while the sample response beneath it
-- names the code — and that omission is where the registry's "documented as a
-- channel; networks not named" note came from. The note was stale, not the
-- coverage.
--
-- So this adds MW to the wallet row and to nothing else. `flutterwave_bank`
-- deliberately does not gain it: the bank gate is quoted above and is current.
-- The registry now says the same thing in two flags — `momoPayout` true,
-- `bankPayout` false — because one flag could not express a market payable by
-- one destination and not the other. Ethiopia needed the same split in the
-- other direction this morning, and Burkina Faso is what happens when neither
-- is true and the table says otherwise.
--
-- MWK is already in `PER_USD`, so the engine can price what it routes.
--
-- Not verified against a live transfer. `MOMO_UNVERIFIED` still covers every
-- code in `momo.ts`, this one included, and a sandbox payout remains blocked
-- on the fixed-IP proxy Flutterwave requires for transfers. Documented is the
-- bar every corridor here is held to; Burkina Faso is the reminder that it is
-- not the same bar as deliverable.

update payout_routes
   set countries  = array(select distinct unnest(countries  || array['MW']::country_code[])),
       currencies = array(select distinct unnest(currencies || array['MWK']::currency_code[]))
 where tenant_id is null and payout_provider = 'flutterwave_momo';
