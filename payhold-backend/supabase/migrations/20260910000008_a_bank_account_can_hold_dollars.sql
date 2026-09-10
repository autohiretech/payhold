-- A bank account can hold dollars. A mobile money wallet cannot.
--
-- `20260910000007` gave `payout_routes` one flag — `local_currency_only` — and
-- set it on both Flutterwave rails, on the reasoning that a local rail pays in
-- local money. That is exactly true of a wallet and too strong for a bank.
-- An MTN Rwanda wallet is denominated in RWF and there is no USD wallet to
-- open; a Rwandan **bank** account can perfectly well be a foreign-currency
-- account, and hosts asking to be paid in dollars is an ordinary request
-- rather than a confusion. Collapsing those two into one flag answered the
-- wallet's question correctly and the bank's wrongly.
--
-- Un-flagging the bank rail is not the fix either, and this is the part worth
-- keeping straight. `countries` × `currencies` is a cross product, so a bank
-- row with the flag off offers a Rwandan bank account payment in Kenyan
-- shillings, Ghanaian cedis and Egyptian pounds — the same fiction
-- `20260910000007` was written to delete. The real shape is a third one:
--
--   **its own country's currency, plus recognised settlement currencies.**
--
-- `cross_border_currencies` is that second half. For a rail with
-- `local_currency_only`, the payable set for a country becomes the country's
-- own currency plus whatever this array names — and nothing else, so no local
-- currency ever leaks across a border. It is empty by default, which means
-- **this migration changes no behaviour at all**: both Flutterwave rails carry
-- exactly what they carried this morning, and the wallet rail should keep an
-- empty array permanently.
--
-- What it buys is that turning USD bank payouts on later is a row update
-- rather than a schema change — one `update` naming the currencies, once
-- somebody has an answer from the provider.
--
-- **And nobody has that answer yet, which is why this migration stops here.**
-- `flutterwave_bank`'s currency list contains no USD in the first place, and
-- `payoutRoute`'s own foreign-currency branch has said the careful thing since
-- it was written: Flutterwave can *hold* a foreign currency, but paying a
-- third-party beneficiary in one is a different capability from settling it to
-- your own account — "a route to confirm, not a promise". Adding USD to the
-- row and filling this array before that confirmation exists would let a host
-- pick dollars, register a beneficiary, and have the transfer refused with the
-- renter's money already collected and held. That is the precise failure this
-- system spent 2026-09-09 and 2026-09-10 removing from the Flutterwave and
-- Stripe corridors, and it is not worth reintroducing for a currency picker.
alter table payout_routes
  add column if not exists cross_border_currencies currency_code[] not null default '{}';

comment on column payout_routes.cross_border_currencies is
  'Settlement currencies this rail can pay into a beneficiary whose country '
  'uses a different one — read only when local_currency_only is set, where the '
  'payable set becomes the country''s own currency plus these. Empty means '
  'strictly local. A wallet rail keeps it empty permanently: a mobile money '
  'wallet is denominated in its country''s currency and there is no foreign '
  'one to open. A bank rail may gain USD/EUR here once the provider has '
  'confirmed it will send them to a third-party beneficiary in that market — '
  'the currency must also be present in `currencies`, which is what says the '
  'rail supports it at all.';

-- Left empty deliberately, including for `flutterwave_bank`. See the header:
-- the confirmation this needs is a conversation with Flutterwave, not a row.
