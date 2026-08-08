-- ---------------------------------------------------------------------------
-- `wallet` joins the payment methods
-- ---------------------------------------------------------------------------
--
-- §9 names five wallet rails — PayPal, Venmo, Cash App Pay, Alipay, WeChat Pay
-- — and `payment_method` had nowhere to put any of them. Every one was going to
-- arrive as a `card`, which is false in a way that matters: a wallet payment
-- has no card scheme, is not 3DS-eligible, and disputes through a different
-- process. Recording it as a card would put a claim in the ledger nobody made,
-- and §6's fraud controls read that column.
--
-- It surfaced building the PayPal adapter, where `charge` had to refuse the
-- only method that actually describes a PayPal payment, and again in Stripe's
-- `toMethod`, which mapped `cashapp` to null rather than lie. Null was the
-- honest answer available at the time and it is still a gap: a deal funded by
-- Cash App Pay recorded no method at all.
--
-- One migration, and it only *adds* the value. Postgres refuses to use an enum
-- value in the transaction that declared it, which is why the lifecycle and the
-- six buckets each needed two files — nothing here reads `wallet` back, so one
-- is correct and a second would be ceremony.
--
-- **`link` is deliberately not moved.** Stripe Link is card-backed: it carries a
-- scheme, it is 3DS-eligible, and it disputes as a card does. It is a faster way
-- to present a card rather than a different instrument, and `toMethod` goes on
-- reporting it as one.

alter type payment_method add value if not exists 'wallet' after 'card';

comment on type payment_method is
  'How the buyer paid. `wallet` covers §9''s wallet rails — PayPal, Venmo, '
  'Cash App Pay, Alipay, WeChat Pay — which have no card scheme and are not '
  '3DS-eligible. Stripe Link stays `card`: it is card-backed, and a faster way '
  'to present one rather than a different instrument.';

-- Cash App Pay's row can now say what it is rather than only what it is not.
-- It stays `implemented = false` because it is not an adapter of its own and
-- the honest reading of that column is "is there a class behind this enum
-- value" — there is not, and there should not be.
update provider_capabilities
   set note = 'Not an adapter of its own, and deliberately not becoming one: '
              || 'Cash App Pay is a payment-method type on Stripe Checkout, so '
              || 'it rides StripeProvider in the market Stripe already covers. '
              || 'Enabling it is a Stripe dashboard setting plus a US/USD '
              || 'route, not a class. Collection only — Cash App cannot receive '
              || 'a marketplace payout from us.'
 where provider = 'cash_app_pay';
