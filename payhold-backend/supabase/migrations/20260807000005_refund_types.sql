-- ---------------------------------------------------------------------------
-- V2 §7.1: partial refunds, part one — the entry type
-- ---------------------------------------------------------------------------
--
-- Enum value only, for the reason `20260807000001` gives.
--
-- `receivable` is §7.1.4: a refund owed to a buyer after the seller has already
-- been paid. The money is not ours to send — it is with the seller — so this
-- books what they owe us rather than pretending funds moved. It belongs to no
-- balance bucket, because a receivable is an asset and the buckets describe
-- what a provider is holding.

alter type ledger_entry_type add value if not exists 'receivable' after 'payout';

-- A dispute can now end in a split, and §24.4 will train on these labels. A
-- split filed as `dispute_refunded` would teach a future model that the buyer
-- won outright, which is the one thing a split is not.
alter type dispute_status add value if not exists 'resolved_split' after 'resolved_refunded';
alter type deal_outcome_label add value if not exists 'dispute_split' after 'dispute_refunded';
