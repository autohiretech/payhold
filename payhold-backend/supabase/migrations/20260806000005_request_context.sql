-- Where a payment came from — the raw material for fraud analysis (spec §6).
--
-- Every rule PayHold has today runs at *payout* time: a first payout to a new
-- seller, a jump past 3× their usual, a dispute lost recently. Those are good
-- rules and they catch a seller-side pattern. What they cannot see is the buyer
-- side — a stolen card or a taken-over wallet shows up when the money comes
-- *in*, hours or days before any payout is due, and nothing in this schema was
-- watching that moment.
--
-- This table is that observation, and only the observation. It records no
-- verdict and fires no rule: this migration is deliberately capture-only, so
-- the signals that will eventually read it are written against history that
-- already exists rather than against an empty table.
--
-- **Three sources, and the difference between them is the point.** A client can
-- tell us anything; a provider is reporting what it saw. `source` is stored on
-- every row so a rule can weigh them differently, and so an operator reading
-- the Fraud screen knows whether an address is evidence or a claim:
--
--   provider          Flutterwave or Stripe reported it on the charge. Tied to
--                     a verified transaction; the strongest of the three.
--   hosted_page       our own /pay/:id page saw the connection. True for buyers
--                     who use it, absent for clients with their own checkout.
--   client_attested   the client's server passed `buyer_ip`. Useful and
--                     unverifiable — a compromised integration can send
--                     anything, so it may inform a signal and never a block.
--
-- **Read this before writing a rule against `ip`.** In PayHold's launch markets
-- most buyers pay by mobile money from behind carrier-grade NAT, so thousands
-- of unrelated MTN and Airtel customers share a handful of addresses. A
-- velocity rule tuned the way you would tune it for European card traffic will
-- hold payouts for real sellers all day. IP is worth having for geo-mismatch
-- and for reuse across tenants; it is not worth having as a verdict.
--
-- **Retention: kept indefinitely, deliberately.** This is the first personal
-- data PayHold stores, and the alternative considered was ninety days and then
-- truncation to the /24. Indefinite retention was chosen so §12.4's own fraud
-- model has the history to train on, which cannot be backfilled. That decision
-- carries obligations under GDPR and Rwanda's data protection law — a stated
-- purpose, a subject-access path, and a deletion path — and the schema is
-- shaped so a retention pass stays a one-statement change: nothing joins on
-- `ip`, so nulling or truncating the column later breaks no foreign key and no
-- view.

create type request_context_source as enum (
  'provider',
  'hosted_page',
  'client_attested'
);

create table request_context (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  deal_id     uuid not null references deals(id) on delete cascade,
  source      request_context_source not null,
  -- What was happening: 'pay_started', 'charge_confirmed', 'confirmation'.
  -- Free text rather than an enum because a new capture point should be a line
  -- in an Edge Function, not a migration on a table this size.
  event       text not null,
  -- `inet` rather than text: it validates, it normalises v4 and v6, and it
  -- makes the network-prefix operators available to the rules that come later
  -- without reparsing a string per row.
  ip          inet,
  -- Provider-reported, where the provider gives one. Never inferred here — a
  -- geo lookup belongs to whoever has a maintained database, and a wrong
  -- country is worse than no country when it is about to flag someone.
  ip_country  country_code,
  user_agent  text,
  created_at  timestamptz not null default now()
);

create index request_context_tenant_idx on request_context(tenant_id, created_at desc);
create index request_context_deal_idx on request_context(deal_id, created_at);
-- The index the velocity and reuse rules will want. Partial, because a row
-- with no address is common — a client that sends nothing still records the
-- attempt — and indexing those nulls would be pure overhead.
create index request_context_ip_idx on request_context(ip, created_at desc)
  where ip is not null;

comment on table request_context is
  'Where a payment was made from. Observation only: no rule reads this yet, and '
  'no verdict is stored here. Personal data — see the retention note in '
  '20260806000005_request_context.sql.';

-- ---------------------------------------------------------------------------
-- Writing one
-- ---------------------------------------------------------------------------

-- A function rather than a bare insert, for the reason every other write here
-- is one: the tenant is derived from the deal instead of trusted from the
-- caller. An Edge Function that passed the wrong tenant would file a buyer's
-- address under somebody else's account.
create or replace function record_request_context(
  p_deal_id    uuid,
  p_source     request_context_source,
  p_event      text,
  p_ip         inet default null,
  p_ip_country country_code default null,
  p_user_agent text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  d deals;
begin
  select * into d from deals where id = p_deal_id;

  -- Silent rather than raising. This is telemetry beside a payment: a deal
  -- that has gone away must not turn a successful charge into a 500.
  if not found then
    return;
  end if;

  insert into request_context (
    tenant_id, deal_id, source, event, ip, ip_country, user_agent
  )
  values (
    d.tenant_id, d.id, p_source, p_event, p_ip, p_ip_country,
    -- A user agent is attacker-controlled and unbounded. Truncated rather than
    -- rejected: the first 300 characters identify a browser, and the rest is
    -- either padding or somebody testing what this column does.
    left(p_user_agent, 300)
  );
end;
$$;

revoke all on function record_request_context(uuid, request_context_source, text, inet, country_code, text)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table request_context enable row level security;

create policy request_context_read_own on request_context
  for select using (tenant_id in (select current_tenant_ids()));

-- Note what is absent: `payhold_ai` gets no grant here at all.
--
-- The case file the model is shown is PII-minimised on purpose — the deal's
-- `buyer_ref` is already left out of it for being frequently an email. An IP
-- address is the same class of thing, and a risk brief does not become more
-- useful for containing one. The narrator explains a seller's record; the
-- Fraud screen is where a person looks at addresses.
