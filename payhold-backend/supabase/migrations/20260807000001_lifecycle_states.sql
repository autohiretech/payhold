-- ---------------------------------------------------------------------------
-- V2 §6: the order lifecycle, part one — the states themselves
-- ---------------------------------------------------------------------------
--
-- This migration adds enum values and does NOTHING else, deliberately.
-- Postgres will not let a transaction use an enum value it added itself, and
-- Supabase runs each migration file in one transaction. So the values land
-- here and `20260807000002_lifecycle.sql` is the first thing allowed to name
-- them. Merging the two would fail on the first `update ... set status =
-- 'clearing'` with "unsafe use of new value of enum type".
--
-- Ten values, not the spec's twelve. Two of §6's states already exist here
-- under other names and adding synonyms would give one event two spellings:
--
--   §6 `delivered`     → `confirmed_seller`   the seller says the work is done
--   §6 `buyer_review`  → `confirmed_seller`   the same window, seen from the
--                                             other side: seller in, buyer not
--
-- Spec §29.1 carries the ruling. The wire vocabulary still says `order.delivered`
-- (§10.2) because event names are free; a second *state* is not.
--
-- Six of the ten have no writer yet. They are added now because an enum value
-- is the expensive kind of migration and Phase 3 (`partially_refunded`) and
-- Phase 7 (`checkout_started`) should not each need another one. The transition
-- guard in the next migration knows all ten, so an unreachable state stays
-- unreachable rather than becoming a hole.

alter type deal_status add value if not exists 'checkout_started'   after 'created';
alter type deal_status add value if not exists 'payment_pending'    after 'checkout_started';
alter type deal_status add value if not exists 'payment_failed'     after 'payment_pending';
alter type deal_status add value if not exists 'expired'            after 'payment_failed';
alter type deal_status add value if not exists 'canceled'           after 'expired';
alter type deal_status add value if not exists 'in_progress'        after 'funded_held';
alter type deal_status add value if not exists 'revision_requested' after 'in_progress';

-- `clearing` sits between the second confirmation and `released`. Money has
-- left the hold; the safety window has not passed. See the next migration for
-- why that is a rename of what `released` used to mean rather than a new step.
alter type deal_status add value if not exists 'clearing'           after 'confirmed_seller';
alter type deal_status add value if not exists 'payout_pending'     after 'released';
alter type deal_status add value if not exists 'partially_refunded' after 'refunded';

-- A note for anyone ordering by this column: enums sort by declaration order,
-- not alphabetically, and `add value ... after` inserts into that order. The
-- positions above are chosen so `order by status` reads as the lifecycle. Any
-- comparison against the dashboard's own ordering must still cast to text.
