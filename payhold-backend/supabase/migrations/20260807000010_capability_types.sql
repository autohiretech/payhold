-- ---------------------------------------------------------------------------
-- V2 §9: the adapters the first release names
-- ---------------------------------------------------------------------------
--
-- Enum values only — the fourth two-file split in V2, and for the same reason
-- as the other three: Postgres will not let a migration use a value that
-- `alter type ... add value` introduced in the same transaction, and Supabase
-- runs each file as one. `20260807000011` is where these get used.
--
-- §9 lists five adapters for the first release: `stripe`, `flutterwave`,
-- `paypal`, `cash_app_pay` where approved, and `china_wallet_partner` for any
-- Alipay/WeChat route the selected Stripe account does not cover. Three of
-- those have no enum value, which means today the system cannot *name* them —
-- and a rail it cannot name is one it cannot refuse with a reason, or record a
-- capability against, or show an operator as switched off.
--
-- They ship declared and unimplemented (§29.3). `loadProvider` throws for them
-- loudly rather than falling back to the fake, which is the choice already made
-- for Stripe and made for the same reason: a deal routed to an adapter that
-- silently collected nothing would be worse than a visible failure.
--
-- Venmo is deliberately absent from this list even though `payout_provider` has
-- it. `payout_provider` names a **rail** — the shape of the destination a token
-- was minted for — and `provider` names the **adapter** that talks to an API.
-- Venmo destinations are reached through PayPal's, so `venmo` is a rail on the
-- `paypal` adapter. Conflating the two is what the two enums exist to avoid.

alter type provider add value if not exists 'paypal';
alter type provider add value if not exists 'cash_app_pay';
alter type provider add value if not exists 'china_wallet_partner';
