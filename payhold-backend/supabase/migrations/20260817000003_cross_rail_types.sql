-- Entry types for money that crosses rails. Values only — nothing here uses
-- one, because Postgres refuses to use an enum value added in the transaction
-- that added it and Supabase runs each migration file in one. The behaviour is
-- `20260817000004`, exactly the split the lifecycle and the six buckets use.
--
-- The problem these exist for: a deal collected on Stripe in USD and paid out
-- on Flutterwave in RWF. `settle_payout` books the `payout` entry through
-- `write_ledger`, which stamps the **deal's** rail and presentment currency —
-- so the ledger said USD left Stripe. It did not: the USD is still sitting in
-- the tenant's Stripe balance, and it was RWF that left Flutterwave. The
-- nightly `reconcile` pass then finds drift on both rails at once and
-- `record_reconciliation` freezes the tenant's payouts automatically — on the
-- first cross-border deal, every time.
--
-- Under bring-your-own-keys PayHold never moves money between a tenant's own
-- provider accounts; they top Flutterwave up from their Stripe payouts by
-- hand. So the ledger has to be able to say three things it could not say
-- before, and `external_transfer` is the one that carries no deal at all.

alter type ledger_entry_type add value if not exists 'cross_rail_offset' after 'payout';
alter type ledger_entry_type add value if not exists 'cross_rail_payout' after 'cross_rail_offset';
alter type ledger_entry_type add value if not exists 'external_transfer' after 'receivable';
