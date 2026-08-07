-- ---------------------------------------------------------------------------
-- V2 §5.1: the vocabulary the routing engine needs
-- ---------------------------------------------------------------------------
--
-- Enum values only. Postgres will not let a migration use a value that
-- `alter type ... add value` introduced in the same transaction, and Supabase
-- runs each file as one — so this is the third two-file split in V2, for the
-- same reason as the lifecycle and the six buckets. `20260807000009` is where
-- these get used.
--
-- ## Two new payout statuses, not seven
--
-- §5.1's status list is `clearing | available | processing | paid | failed |
-- blocked | needs_verification`. Only two of those are new *facts*.
--
-- `clearing` and `available` describe where the **deal** is in its clearance
-- window, and a payout row exists in `scheduled` across both of them. Storing
-- them on the payout would give one fact two writers that have to be kept in
-- step, and the deal's own status is already the one that decides when a payout
-- may dispatch — `payout-dispatch` matures deals first and scans second. So
-- they are **derived for display** by `payout_display_status()` in the next
-- migration, and the enum gains only what it cannot work out.
--
-- ## Why `blocked` and `needs_verification` are not `held_for_review`
--
-- The difference is who can end them, and it is the reason they are worth
-- separating rather than being two more flavours of a hold.
--
--   `held_for_review`     a discretionary rule, or a person, stopped this.
--                         `approve_payout_review` is the only way out and it
--                         records a name. A machine may never clear it.
--   `needs_verification`  the *seller* has something outstanding — identity,
--                         sanctions, an unverified destination, a security
--                         hold. Nobody should be able to approve past it: the
--                         way out is `verify_seller`, which is an attestation
--                         with somebody behind it. Once the fact changes, the
--                         next dispatch pass simply finds nothing to hold on.
--   `blocked`             §5.1's no-route case. There is nowhere eligible to
--                         send this money. Approving it would achieve nothing,
--                         because approval is not what is missing; a route is.
--                         It clears the same way — the next pass re-asks.
--
-- That is a **strengthening** of the §12 gate, not a loosening. Until now the
-- eligibility checks produced `held_for_review`, which put "we have never
-- verified this seller" in the same queue as "this payout is unusually large" —
-- and an operator with the approve button could clear the first one, which is
-- exactly what §12's sentence says must not be possible.
--
-- Both new states are machine-recoverable, and that is deliberate: a rule is
-- not *sending* anything when it re-screens and finds the reason gone. It is
-- the same shape as `frozen` clearing when reconciliation is resolved.
-- Invariant 11 is intact — the routing engine and the eligibility gate stop
-- payouts and can do nothing else.

alter type payout_status add value if not exists 'blocked';
alter type payout_status add value if not exists 'needs_verification';

-- ---------------------------------------------------------------------------
-- Destinations §5.1 names that we cannot reach yet
-- ---------------------------------------------------------------------------
--
-- §5.1's preferred-method list is "bank account, mobile wallet, PayPal, Venmo,
-- Cash App Pay or another method enabled for that seller's country and
-- currency", and §5.2's second acceptance case is a U.S. seller being told
-- clearly why Venmo is unavailable outside the U.S.
--
-- A rail we cannot name cannot be refused with a reason — the seller would get
-- "unknown destination type" instead of an answer. So the values ship here and
-- their routes ship **disabled**, which is the decision already recorded for
-- Stripe and restated in spec §29.3: declared, so the refusal is specific;
-- disabled, so no unapproved rail can carry money. Phase 6 does the same on the
-- collection side.

alter type payout_provider add value if not exists 'paypal';
alter type payout_provider add value if not exists 'venmo';
alter type payout_provider add value if not exists 'cash_app_pay';
alter type payout_provider add value if not exists 'alipay';
alter type payout_provider add value if not exists 'wechat_pay';

-- ---------------------------------------------------------------------------
-- New types, which have no such restriction
-- ---------------------------------------------------------------------------
--
-- `create type` may be used in the transaction that creates it. These sit here
-- anyway so the whole routing vocabulary is one file to read.

-- §5.1's "selected method", recorded on every decision. `payout_provider`
-- names the rail (`flutterwave_momo`); this names the shape of the destination,
-- which is what a seller recognises and what an eligibility message is about.
create type payout_method as enum (
  'mobile_money',
  'bank_account',
  'wallet'
);

-- §5.1's filter is literally `route.riskStatus === "approved"`, so only that
-- value passes. The other two exist to say *why* a route is out of service
-- without deleting the row — which would take its history in `payout_decisions`
-- with it, and §5.1 wants a payout decision auditable after the fact.
--
--   approved   usable
--   review     not usable; somebody is looking at this corridor
--   suspended  not usable; the provider or we took it out of service
create type route_risk_status as enum (
  'approved',
  'review',
  'suspended'
);
