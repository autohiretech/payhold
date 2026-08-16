-- Corrects a mistake `20260816000009` made minutes after it shipped.
--
-- That migration rebuilt `masked_destination` from `seller_destinations.label`
-- wherever a label was already stored, on the theory that a caller-supplied
-- label is more trustworthy than the provider's own guessed prefix. True for
-- a label `add_seller_destination` stored from `p_label` — false for the seed
-- row `sellers_seed_primary_destination` writes on every registration, which
-- hardcodes the literal string `'Primary'` into that same column (see
-- `20260807000007`, `20260814000001`) to mean "this is the primary slot," not
-- a description of the payout method. Every seller whose primary destination
-- had never been changed carried that sentinel, and the backfill dutifully
-- rebuilt their mask as `Primary •••• 0202` — replacing one wrong-but-at-least-
-- method-shaped word with one that names nothing. Caught minutes later,
-- verifying the fix live: "Kigali Car Rental Self Drive" (Bank transfer) and
-- "Jean-Paul Habimana" (Mobile money) both read "Primary •••• ####" on the
-- Sellers screen.
--
-- The original prefix — whatever Flutterwave's `tokenize()` guessed — is not
-- recoverable; the previous migration overwrote it in place. What is still
-- reliable is `payout_provider`, set once by the seller's own choice and never
-- guessed, so this rebuilds the mask from that instead of trusting `label` at
-- all for these rows. It is the dashboard's own `PAYOUT_PROVIDER_LABEL`
-- (`payhold-dashboard/src/lib/rails.ts`) copied here rather than imported —
-- there is no shared module across the SQL/TypeScript boundary for it, and a
-- one-time repair is exactly the kind of copy that is fine to leave uncentralised.
--
-- Scoped tightly to the damage: only rows the previous migration actually
-- touched, i.e. `label = 'Primary'` with a mask that already carries the
-- masked digits (the shape the previous migration's own where-clause
-- produced). A row `add_seller_destination` labelled for real is untouched.
update seller_destinations
   set masked_destination =
     coalesce(
       case payout_provider
         when 'flutterwave_momo' then 'Mobile money'
         when 'flutterwave_bank' then 'Bank transfer'
         when 'stripe_connect'   then 'Stripe Connect'
         when 'paypal'           then 'PayPal'
         when 'venmo'            then 'Venmo'
         when 'cash_app_pay'     then 'Cash App Pay'
         when 'alipay'           then 'Alipay'
         when 'wechat_pay'       then 'WeChat Pay'
       end,
       -- No provider on file (should not happen for a row with a mask at
       -- all) — leave the digits with no prefix rather than guess again.
       ''
     ) || (regexp_match(masked_destination, '(\s*••••\s*\S+)\s*$'))[1]
 where label = 'Primary'
   and masked_destination like 'Primary %'
   and masked_destination ~ '••••';
