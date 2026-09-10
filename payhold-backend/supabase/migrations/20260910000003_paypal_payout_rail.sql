-- ---------------------------------------------------------------------------
-- PayPal's payout corridor becomes real in the table, and stays switched off.
-- ---------------------------------------------------------------------------
--
-- Three facts about this rail have drifted apart, and this migration lines the
-- table up with all three without opening anything.
--
-- **The adapter exists.** `_shared/paypal.ts` has implemented `release()`
-- (POST /v1/payments/payouts, `sender_batch_id` as the idempotency anchor,
-- `pending` on batch acceptance because their batch is accepted first and
-- processed after) and `tokenize()` (a payer id or an account email, recording
-- which) since `20260808000003`, which is also where `implemented` was set.
-- The seed note from `20260807000011` still read "No adapter and no signed
-- agreement", which has been half wrong for a month. Restated below.
--
-- **The corridor list was a placeholder.** The seeded row carried the same
-- eleven countries and six currencies as `stripe_connect`, which was never a
-- claim about PayPal — it was the Stripe row copied so the declared rail had
-- something in it. PayPal's own Payouts country/feature table is the actual
-- coverage, read 2026-09-10:
--
--   https://developer.paypal.com/docs/payouts/standard/reference/country-feature/
--   https://developer.paypal.com/api/rest/reference/currency-codes/
--
-- That table tiers each listed market as "Send, receive and withdraw", "…in
-- local currency", "Fully localized", or "Receive and withdraw". **All four
-- grant a recipient receive-and-withdraw**, which is the whole of what a payout
-- needs, so all four are carried here. India and Mexico are the fourth tier:
-- an account there cannot *initiate* a payout, and the sender on this rail is
-- always PayHold's tenant rather than the seller, so the restriction does not
-- bind the direction this row describes. The same 88 markets are
-- `paypalPayout` in the generated registry (`gen-countries.py`), from the same
-- page on the same day — one reading, two places, neither inferred from the
-- other and neither inferred from Stripe's or Flutterwave's coverage.
--
-- Bermuda, the Cayman Islands, the Faroe Islands, Greenland and Réunion are on
-- PayPal's table and not in this registry, so they are absent here too.
--
-- The currencies are PayPal's own supported list intersected with what
-- `_shared/fx.ts`'s `PER_USD` can price, exactly as `20260909000006` did for
-- the non-euro EEA: a corridor the routing engine can pick and the FX table
-- cannot price fails at conversion with the buyer's money already collected.
-- Dropped for want of a rate: HKD, ILS, MYR, NZD, PHP, THB, TWD. Dropped
-- outright: RUB — Russia is `restricted` in the registry. BRL and CNY are on
-- PayPal's list as "in-country accounts only", which is what a payout to a
-- recipient in Brazil or China is.
--
-- **It stays disabled, and not on trust.** `enabled` is false on this row and
-- this migration does not touch it. Two structural things also refuse it:
-- `assert_route_has_live_provider` (`20260815000007`) raises on any attempt to
-- enable the `(paypal, paypal)` pair, because §16 wants written payout
-- confirmation per market before that corridor opens; and the same trigger
-- keeps the permanent §17 refusal on `(venmo, paypal)` and
-- `(cash_app_pay, cash_app_pay)`, which this migration deliberately leaves
-- exactly as it found them. Correct and inert: the row now describes the real
-- corridor, and turning it on is still one deliberate act by somebody with a
-- signed agreement in front of them.
--
-- **`provider_capabilities.paypal.enabled` is deliberately not touched
-- either, and it is `true`.** `20260813000002` switched it on so PayPal could
-- *collect* — that flag is what `loadProvider` reads, and the wallet rail a
-- buyer pays on depends on it. Setting it false here to make the payout half
-- inert would switch off collection for every tenant, which is not what is
-- being asked and would be an outage rather than a safeguard. The payout half
-- is gated by the route trigger above instead, which is precisely the split
-- `20260815000007`'s header argues for: one `enabled` flag cannot do
-- collection and payout gatekeeping for one adapter, so the payout gate lives
-- where payouts are decided.

-- The row's own claim about this repository. Already true since
-- `20260808000003`; restated so the note beside it stops contradicting it.
update provider_capabilities
   set implemented = true,
       note = 'Adapter built — Orders v2 for collection, Payouts v1 for '
              || 'sending (one item per batch, sender_batch_id as the '
              || 'idempotency anchor), webhook signatures verified by API '
              || 'call. Collection is on. The payout rail is not: '
              || 'payout_routes.paypal is disabled and '
              || 'assert_route_has_live_provider refuses to let it be enabled '
              || 'until a payout agreement is signed and §16 has written '
              || 'provider confirmation per market. Carries Venmo, which §17 '
              || 'refuses permanently.'
 where provider = 'paypal';

-- The corridor, from PayPal's own table rather than Stripe's row.
update payout_routes
   set countries = array[
         -- Fully localized
         'AU','AT','BE','BR','CA','CN','DK','FR','DE','HK','IL','IT',
         'JP','NL','NO','PL','PT','SG','ES','SE','CH','TR','GB','US',
         -- Send, receive and withdraw in local currency
         'CY','CZ','EC','FI','GR','HU','LI','LU','MY','MT','NZ','PH','SM','SI',
         -- Send, receive and withdraw
         'AD','AR','BS','BH','BW','BG','CL','CO','CR','HR','DO','SV',
         'EE','GE','GI','GT','HN','IS','ID','IE','JM','JO','KZ','KE',
         'KW','LV','LS','LT','MU','MD','MC','MA','MZ','NI','OM','PA',
         'PE','QA','RO','SA','SN','RS','SK','ZA','AE','UY','VE','VN',
         -- Receive and withdraw — the recipient side is all this row needs
         'IN','MX'
       ]::country_code[],
       currencies = array[
         'AUD','BRL','CAD','CHF','CNY','CZK','DKK','EUR','GBP',
         'HUF','JPY','MXN','NOK','PLN','SEK','SGD','USD'
       ]::currency_code[],
       note = 'PayPal Payouts to a wallet receiver, from PayPal''s own '
              || 'country/feature table (2026-09-10): every market where a '
              || 'recipient can receive and withdraw, including India and '
              || 'Mexico, which are receive-only on the sending side. '
              || 'Currencies are PayPal''s supported list intersected with '
              || 'what the FX table can price. Disabled: §16 wants a signed '
              || 'payout agreement and written provider confirmation per '
              || 'market, and assert_route_has_live_provider refuses to let '
              || 'this row be enabled until then.'
 where tenant_id is null
   and payout_provider = 'paypal';

-- Venmo and Cash App Pay are not touched by any of the above, deliberately.
-- Venmo shares this adapter and is United States only by PayPal's own rule,
-- and §17 rules out personal accounts permanently; Cash App Pay has no adapter
-- at all. Both rows keep their countries, their currencies and their `enabled
-- = false`, and the trigger keeps raising on either.
