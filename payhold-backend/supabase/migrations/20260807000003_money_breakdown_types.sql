-- ---------------------------------------------------------------------------
-- V2 §7: the money breakdown, part one — the entry types
-- ---------------------------------------------------------------------------
--
-- Enum values only, for the reason `20260807000001` gives: Postgres will not
-- let a transaction use an enum value it added itself, and Supabase runs each
-- migration file in one. `20260807000004` is the first thing allowed to name
-- these.
--
-- §7 requires the ledger to keep buyer-paid, seller gross, platform fee,
-- provider fee, tax, reserve, refund and payout as **separate values**. Four of
-- those eight already had entry types. These are the rest.
--
-- Each new type answers one question the old ledger could not:
--
--   provider_fee     what the rail took. Unlike our own fee this genuinely
--                    leaves the balance, and not booking it is why a provider
--                    that charges 3% would look like unexplained drift.
--   tax              collected from the buyer and owed onward. Physically
--                    present until remitted; never the seller's.
--   reserve          §6.1's new-seller hold. Carved out of the clearing pool so
--                    it cannot be paid out, without leaving the vault.
--   reserve_release  the carve-out returned. The only credit among the four.

alter type ledger_entry_type add value if not exists 'provider_fee' after 'fee';
alter type ledger_entry_type add value if not exists 'tax'          after 'provider_fee';
alter type ledger_entry_type add value if not exists 'reserve'      after 'tax';
alter type ledger_entry_type add value if not exists 'reserve_release' after 'reserve';
