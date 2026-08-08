-- ---------------------------------------------------------------------------
-- PayPal is built — §9's third adapter
-- ---------------------------------------------------------------------------
--
-- `provider_capabilities.implemented` is a claim about this repository: that a
-- class exists behind the enum value and `loadProvider` returns it. That became
-- true for `paypal` with `_shared/paypal.ts`, so the row says so.
--
-- **`enabled` is deliberately left false, and the two are not the same
-- question.** An unbuilt adapter is a roadmap item; a built one that is off is
-- a commercial decision. PayPal is now the second kind: the code is here, and
-- the row's own note is what still stands in the way — no signed agreement, and
-- §16's checklist wants written provider confirmation for marketplace payouts
-- in each launch market before live money moves. `payout_routes_require_live_provider`
-- reads `enabled`, so the routes stay refused until somebody turns it on
-- deliberately, which is a row an operator changes rather than a migration.
--
-- The flags themselves are untouched. They were written from PayPal's
-- documentation when the row was declared, and the adapter was built to match
-- them rather than the other way round — `paypal.test.ts` asserts the class and
-- the row agree, so a flag that was wrong is now catchable.

update provider_capabilities
   set implemented = true,
       note = 'Adapter built — Orders v2 for collection, Payouts v1 for '
              || 'sending, webhook signature verified by API call. Carries '
              || 'Venmo. Not enabled: no signed agreement, and §16 wants '
              || 'written payout confirmation per market first.'
 where provider = 'paypal';

-- Cash App Pay and the China wallets keep `implemented = false`, and the notes
-- say what each is actually waiting on rather than leaving "not built" to imply
-- the same blocker twice.
--
-- Neither is a missing class in the way PayPal's was:
--
--   * **Cash App Pay is not a standalone API.** It is a payment method reached
--     through Square or offered by Stripe as a payment-method type. Building a
--     third adapter for it would mean choosing which, and if the answer is
--     Stripe then it is a method on an adapter we already have rather than an
--     adapter at all. That is a product decision, not an implementation.
--
--   * **`china_wallet_partner` names a partner nobody has chosen.** Antom,
--     Adyen and Airwallex are different APIs, and the row's existing note
--     already records the harder half: §5 forbids promising cross-border payout
--     until an approved local structure exists, which is a legal arrangement
--     rather than code.

update provider_capabilities
   set note = 'Not an API of its own — Cash App Pay is reached through Square '
              || 'or offered by Stripe as a payment-method type. Which of those '
              || 'it is decides whether this is an adapter or a method on one '
              || 'we already have. United States only.'
 where provider = 'cash_app_pay';

update provider_capabilities
   set note = 'Partner not chosen — Antom, Adyen and Airwallex are different '
              || 'APIs. §5: do not promise cross-border payout until an '
              || 'approved local structure exists, which is a legal '
              || 'arrangement and not an adapter. Refunds settle '
              || 'asynchronously up to 90 days out — §7.1.6.'
 where provider = 'china_wallet_partner';
