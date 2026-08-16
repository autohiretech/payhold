-- A seller mid-Connect-onboarding has a Stripe Express account that is not
-- yet a payable destination: `tokenize` refuses it until `payouts_enabled`,
-- and `add_seller_destination` has nothing to call until then. This column is
-- where that in-progress account id lives between "created" and "promoted to
-- a seller_destinations row" — nothing on the payout path reads it, and it is
-- cleared the moment it is.
alter table sellers
  add column stripe_connect_pending_account_id text;

comment on column sellers.stripe_connect_pending_account_id is
  'An Express account created for Stripe Connect onboarding, not yet payouts_enabled. Cleared once it becomes a seller_destinations row.';
