-- ---------------------------------------------------------------------------
-- Words for money PayHold records but never moves
-- ---------------------------------------------------------------------------
--
-- A client asked for cash on pickup: the buyer and the seller meet, banknotes
-- change hands, and no rail is involved at any point. PayHold still wants the
-- record — what the trip was worth, what was actually collected, when — because
-- a seller's history of what they have earned should not have a hole in it
-- shaped like every cash job they ever did.
--
-- Three enums had nowhere to put it, and every one of them would otherwise have
-- been lied to:
--
--   • `provider` names the rail that carried the money. There was no rail.
--     Recording `fake` would put a test deal in a live ledger; recording
--     `stripe` would claim a charge that does not exist and that reconciliation
--     would spend the rest of its life looking for.
--
--   • `payment_method` is how the buyer paid. Cash is not a card, and the
--     `wallet` migration's reasoning applies word for word: §6's fraud controls
--     read this column, and a method recorded as something it is not puts a
--     claim in the ledger nobody made.
--
--   • `deal_status` had no terminal state for "closed, and the money never came
--     through here". `paid_out` is the tempting one and it is false: it means
--     PayHold sent funds to the seller. Nothing was sent. The seller was handed
--     notes by a person standing in front of them, and a payout row against
--     that deal would eventually pay them a second time.
--
-- Adds only. Postgres refuses to use an enum value in the transaction that
-- declared it, so everything that reads these back is in 000007.

alter type provider       add value if not exists 'offline';
alter type payment_method add value if not exists 'cash'    after 'bank_transfer';
alter type deal_status    add value if not exists 'settled_offline' after 'paid_out';

comment on type provider is
  'The rail that carried the money. `offline` means none did — the buyer paid '
  'the seller directly, in person, and PayHold holds the record rather than the '
  'funds. No charge, no hold, no payout is ever attached to an offline deal.';

comment on type deal_status is
  'Deal lifecycle. `settled_offline` is terminal and means the seller was paid '
  'outside PayHold — distinct from `paid_out`, which asserts PayHold sent the '
  'money and would schedule a second payment for the same work.';
