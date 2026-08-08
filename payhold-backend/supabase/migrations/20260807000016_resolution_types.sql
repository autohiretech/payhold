-- ---------------------------------------------------------------------------
-- V2 §8: the vocabulary the Resolution Center needs
-- ---------------------------------------------------------------------------
--
-- Enum values only, for the fifth time in V2 and for the same reason: Postgres
-- will not let a migration use a value `alter type ... add value` introduced in
-- the same transaction, and Supabase runs each file as one. `20260807000017` is
-- where these get used.
--
-- ## `resolved_expired` is a resolution nobody chose
--
-- §8 gives an unanswered request 48 hours and then lets the platform rule
-- decide. What the platform rule does here is **lapse the offer and leave the
-- dispute open** — see the next migration's header for why silence must not
-- move money — so the dispute itself keeps its existing three outcomes.
--
-- What needed a name is the *offer* reaching the end of its window without an
-- answer. `expired` is not `declined`: declining is an act by the other party
-- and says they considered it, and §24.3 will train on the difference between
-- a request somebody turned down and one nobody read.

-- §8's five request kinds, in the order the section lists them. `update` and
-- `extension` change what was agreed; the other three end the deal. Only the
-- last three can move money, which is the line `respond_dispute_offer` draws.
create type dispute_offer_kind as enum (
  'update',
  'extension',
  'cancellation',
  'partial_refund',
  'full_refund'
);

-- `withdrawn` is the offering party taking it back before an answer, and it
-- exists so that doing so is not spelled `declined` — which would put words in
-- the other party's mouth in the timeline §8 asks for.
create type dispute_offer_status as enum (
  'open',
  'accepted',
  'declined',
  'withdrawn',
  'expired'
);

-- §8's "structured reason codes". Free text stays alongside in `disputes.reason`
-- — a code is what a query groups by and what §24.4 eventually trains on, and a
-- sentence is what a person actually needs to read.
--
-- `other` exists and is the default because the alternative is worse: a required
-- code with no honest option is a code everybody fills in wrongly, and that is a
-- column that lies rather than one that is empty.
create type dispute_reason_code as enum (
  'not_delivered',
  'not_as_described',
  'damaged',
  'late_delivery',
  'quality',
  'incomplete',
  'unauthorized_charge',
  'duplicate_charge',
  'cancellation_requested',
  'other'
);

-- §8 names rental inspection photos and GPS/check-in evidence specifically, so
-- they are their own kinds rather than `document` with a note. What an operator
-- filters by is the kind; what the assistant reads is the description.
--
-- **No bytes live in Postgres.** `dispute_evidence` carries a description and a
-- storage reference, the same shape as every other place PayHold refuses to
-- hold the thing itself (a beneficiary token rather than an account number).
create type dispute_evidence_kind as enum (
  'photo',
  'inspection_photo',
  'document',
  'message',
  'checkin',
  'other'
);
