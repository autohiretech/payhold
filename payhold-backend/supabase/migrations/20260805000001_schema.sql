-- PayHold core schema — spec §5.
--
-- Money is ALWAYS bigint minor units. Never numeric, never float: a payment
-- hold that rounds is a payment hold that loses money.
--
-- Country and currency are text with a format check rather than enums. The
-- authoritative list is generated (payhold-dashboard/src/lib/countries.ts,
-- ~200 rows) and changes when provider coverage changes; duplicating it here
-- as a Postgres enum would guarantee the two drift. Format is enforced;
-- membership is enforced at the API edge against the generated table.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Enums — these ARE spec-defined, small, and stable.
-- ---------------------------------------------------------------------------

create type deal_status as enum (
  'created',
  'funded_held',
  'confirmed_buyer',
  'confirmed_seller',
  'released',
  'paid_out',
  'refunded',
  'disputed'
);

create type provider as enum ('flutterwave', 'stripe', 'fake');

create type payment_method as enum ('card', 'mobile_money', 'bank_transfer');

create type payout_provider as enum (
  'flutterwave_momo',
  'flutterwave_bank',
  'stripe_connect'
);

create type payout_status as enum (
  'scheduled',
  'processing',
  'paid',
  'failed',
  'frozen'
);

create type ledger_entry_type as enum (
  'hold',
  'release',
  'refund',
  'fee',
  'payout',
  'deposit_hold',
  'deposit_capture',
  'deposit_release'
);

create type confirm_side as enum ('buyer', 'seller');

create type confirm_actor as enum ('user', 'auto');

create type dispute_status as enum ('open', 'resolved_released', 'resolved_refunded');

create type tenant_status as enum ('active', 'suspended', 'payouts_frozen');

create type tenant_role as enum ('owner', 'staff', 'viewer');

create type provider_mode as enum ('test', 'live');

-- Reusable domains so the format rule is written once.
create domain country_code as text check (value ~ '^[A-Z]{2}$');
create domain currency_code as text check (value ~ '^[A-Z]{3}$');

-- ---------------------------------------------------------------------------
-- Tenants and access
-- ---------------------------------------------------------------------------

create table tenants (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  slug        text not null unique,
  status      tenant_status not null default 'active',
  created_at  timestamptz not null default now()
);

-- Dashboard users. Auth identity lives in Supabase Auth; this maps it to a
-- tenant. A user may belong to more than one tenant.
create table tenant_users (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  auth_user_id  uuid not null references auth.users(id) on delete cascade,
  role          tenant_role not null default 'staff',
  created_at    timestamptz not null default now(),
  unique (tenant_id, auth_user_id)
);

create index tenant_users_auth_user_idx on tenant_users(auth_user_id);

-- PayHold staff. Deliberately NOT a tenant_users role: master-admin is a
-- different axis of authority, and conflating them is how a client's "owner"
-- ends up able to see other tenants.
create table platform_admins (
  auth_user_id  uuid primary key references auth.users(id) on delete cascade,
  created_at    timestamptz not null default now()
);

-- Hashed at rest — spec §6. The plaintext key is returned exactly once, at
-- creation, and is never recoverable. Lookup is by hash, never by scan.
create table api_keys (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  key_hash      text not null unique,
  -- First and last few characters, for the dashboard to display. Not enough
  -- to reconstruct the key.
  masked_key    text not null,
  label         text not null,
  created_at    timestamptz not null default now(),
  revoked_at    timestamptz,
  last_used_at  timestamptz
);

create index api_keys_tenant_idx on api_keys(tenant_id);

-- Provider credentials, encrypted at rest. The encryption happens in the Edge
-- Function with a key held in Supabase secrets; this column never sees
-- plaintext, so a database dump alone cannot move money.
create table tenant_provider_accounts (
  id                     uuid primary key default gen_random_uuid(),
  tenant_id              uuid not null references tenants(id) on delete cascade,
  provider               provider not null,
  encrypted_credentials  text not null,
  mode                   provider_mode not null default 'test',
  created_at             timestamptz not null default now(),
  unique (tenant_id, provider)
);

-- Per-tenant settings as key/value jsonb — spec §5. Adding a setting must not
-- require a migration, because §11.4 promises fee and timer changes are a
-- dashboard edit.
create table settings (
  tenant_id  uuid not null references tenants(id) on delete cascade,
  key        text not null,
  value      jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, key)
);

-- ---------------------------------------------------------------------------
-- Sellers
-- ---------------------------------------------------------------------------

create table sellers (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants(id) on delete cascade,
  name                text not null,
  -- Where the seller banks. Decides which rail can actually pay them, which
  -- is not the same question as which rail collected the money.
  country             country_code not null,
  payout_currency     currency_code not null,
  payout_provider     payout_provider not null,
  -- Provider-side token. PayHold never stores the real destination — §6.
  beneficiary_token   text not null,
  masked_destination  text not null,
  created_at          timestamptz not null default now()
);

create index sellers_tenant_idx on sellers(tenant_id);

-- ---------------------------------------------------------------------------
-- Deals
-- ---------------------------------------------------------------------------

create table deals (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references tenants(id) on delete cascade,
  -- The client's own identifier for the buyer. PayHold stores no buyer PII.
  buyer_ref             text not null,
  seller_id             uuid not null references sellers(id) on delete restrict,
  description           text not null,

  -- Settlement: what the seller quoted and will be paid.
  amount                bigint not null check (amount > 0),
  currency              currency_code not null,

  -- Presentment: what the buyer is actually charged. A card in Mumbai cannot
  -- be charged RWF, so an Indian buyer pays USD against a Rwandan host's RWF
  -- price. Equal to settlement when no conversion is needed.
  presentment_currency  currency_code not null,
  presentment_amount    bigint not null check (presentment_amount > 0),
  -- Units of presentment per unit of settlement, locked at the moment the
  -- buyer paid. Re-deriving it later would move the number under a deal that
  -- has already been paid.
  fx_rate               numeric(20, 10),

  deposit_amount        bigint check (deposit_amount > 0),
  buyer_country         country_code not null,

  -- Provisional at creation, fixed once the buyer picks a method and pays.
  provider              provider not null,
  payment_method        payment_method,
  payment_network       text,
  -- Idempotency anchor — spec §6. A duplicate webhook carrying a provider_ref
  -- we already hold cannot create a second hold.
  provider_ref          text,

  status                deal_status not null default 'created',
  expected_complete_at  timestamptz,
  auto_release_at       timestamptz,
  released_at           timestamptz,
  payout_due_at         timestamptz,
  fee_amount            bigint not null default 0 check (fee_amount >= 0),
  metadata              jsonb not null default '{}'::jsonb,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  -- FX must be internally consistent: either it is a same-currency deal with
  -- no rate, or a converted one that has locked a rate once funded.
  constraint fx_rate_only_when_converting
    check (fx_rate is null or presentment_currency <> currency),
  -- A released deal knows when. An unreleased one must not claim to.
  constraint released_at_matches_status
    check ((status in ('released', 'paid_out')) = (released_at is not null))
);

create index deals_tenant_idx on deals(tenant_id);
create index deals_seller_idx on deals(seller_id);
create index deals_status_idx on deals(tenant_id, status);
-- The auto-release cron scans on this; without it the job degrades as deals
-- accumulate.
create index deals_auto_release_idx on deals(auto_release_at)
  where status in ('funded_held', 'confirmed_buyer', 'confirmed_seller');

-- Idempotency: one provider reference can back exactly one deal. Partial so
-- the many unfunded deals (provider_ref null) do not collide.
create unique index deals_provider_ref_key on deals(provider, provider_ref)
  where provider_ref is not null;

-- One confirmation per side per deal — spec §5. This unique constraint is what
-- makes double-confirm a no-op at the storage layer rather than a race.
create table confirmations (
  id            uuid primary key default gen_random_uuid(),
  deal_id       uuid not null references deals(id) on delete cascade,
  side          confirm_side not null,
  actor         confirm_actor not null default 'user',
  confirmed_at  timestamptz not null default now(),
  unique (deal_id, side)
);

-- ---------------------------------------------------------------------------
-- Ledger — the single source of truth for balances
-- ---------------------------------------------------------------------------

-- Append-only. There is no update or delete path: a correction is a new,
-- opposite entry, so the history of what we believed remains readable.
create table ledger (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete restrict,
  deal_id       uuid references deals(id) on delete restrict,
  entry_type    ledger_entry_type not null,
  -- Signed. Positive credits the tenant, negative debits.
  amount        bigint not null,
  -- The currency that actually landed in the provider balance — what the buyer
  -- was charged, not what the seller is owed.
  currency      currency_code not null,
  provider      provider not null,
  provider_ref  text,
  created_at    timestamptz not null default now()
);

create index ledger_tenant_idx on ledger(tenant_id);
create index ledger_deal_idx on ledger(deal_id);

-- ---------------------------------------------------------------------------
-- Payouts
-- ---------------------------------------------------------------------------

create table payouts (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  deal_id         uuid not null references deals(id) on delete restrict,
  seller_id       uuid not null references sellers(id) on delete restrict,
  -- In the seller's payout currency, which need not be the currency collected.
  amount          bigint not null check (amount > 0),
  currency        currency_code not null,
  status          payout_status not null default 'scheduled',
  scheduled_for   timestamptz not null,
  paid_at         timestamptz,
  failure_reason  text,
  attempts        integer not null default 0 check (attempts >= 0),
  provider_ref    text,
  created_at      timestamptz not null default now(),

  constraint paid_at_matches_status
    check ((status = 'paid') = (paid_at is not null))
);

-- One payout per deal. Belt to the ledger's braces: a second release that
-- somehow escaped the FOR UPDATE guard still cannot produce a second transfer.
create unique index payouts_deal_key on payouts(deal_id);
create index payouts_tenant_idx on payouts(tenant_id);
create index payouts_dispatch_idx on payouts(scheduled_for)
  where status in ('scheduled', 'frozen');

-- ---------------------------------------------------------------------------
-- Disputes
-- ---------------------------------------------------------------------------

create table disputes (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete cascade,
  deal_id          uuid not null references deals(id) on delete cascade,
  raised_by        confirm_side not null,
  reason           text not null,
  status           dispute_status not null default 'open',
  opened_at        timestamptz not null default now(),
  resolved_at      timestamptz,
  resolution_note  text
);

create index disputes_tenant_idx on disputes(tenant_id);
create index disputes_deal_idx on disputes(deal_id);
-- At most one live dispute per deal.
create unique index disputes_one_open_per_deal on disputes(deal_id)
  where status = 'open';

-- ---------------------------------------------------------------------------
-- Outbound webhooks (clients register their endpoint)
-- ---------------------------------------------------------------------------

create table webhook_endpoints (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  url            text not null,
  -- The HMAC signing secret, hashed the same way API keys are. Clients see the
  -- plaintext once at creation; we only ever need to sign with it, and signing
  -- happens in an Edge Function that holds the encrypted original.
  secret_encrypted text not null,
  masked_secret  text not null,
  created_at     timestamptz not null default now(),
  disabled_at    timestamptz
);

create index webhook_endpoints_tenant_idx on webhook_endpoints(tenant_id);

-- Delivery attempts, so a client asking "did you notify us?" has an answer.
create table webhook_deliveries (
  id            uuid primary key default gen_random_uuid(),
  endpoint_id   uuid not null references webhook_endpoints(id) on delete cascade,
  tenant_id     uuid not null references tenants(id) on delete cascade,
  deal_id       uuid references deals(id) on delete set null,
  event         text not null,
  payload       jsonb not null,
  status_code   integer,
  error         text,
  attempts      integer not null default 0,
  delivered_at  timestamptz,
  created_at    timestamptz not null default now()
);

create index webhook_deliveries_endpoint_idx on webhook_deliveries(endpoint_id);

-- ---------------------------------------------------------------------------
-- Inbound provider webhooks — the idempotency log
-- ---------------------------------------------------------------------------

-- Every inbound webhook is recorded BEFORE it is acted on, including ones that
-- fail signature verification. §11.8 triage ("payment without deal") depends on
-- this table existing even for events we rejected.
create table provider_events (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid references tenants(id) on delete set null,
  provider      provider not null,
  -- The provider's own event id. Unique per provider: this is what makes a
  -- redelivered webhook a no-op.
  event_id      text not null,
  event_type    text,
  signature_ok  boolean not null,
  reverified    boolean not null default false,
  payload       jsonb not null,
  processed_at  timestamptz,
  error         text,
  created_at    timestamptz not null default now(),
  unique (provider, event_id)
);

create index provider_events_tenant_idx on provider_events(tenant_id);

-- ---------------------------------------------------------------------------
-- Audit log — every state transition and every provider call
-- ---------------------------------------------------------------------------

create table audit_log (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  deal_id     uuid references deals(id) on delete set null,
  -- Who acted: an API key label, a dashboard user, 'system' for cron.
  actor       text not null,
  action      text not null,
  details     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index audit_log_tenant_idx on audit_log(tenant_id, created_at desc);
create index audit_log_deal_idx on audit_log(deal_id);

-- ---------------------------------------------------------------------------
-- Reconciliation
-- ---------------------------------------------------------------------------

create table reconciliation_alerts (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id) on delete cascade,
  provider          provider not null,
  currency          currency_code not null,
  -- What our ledger says the provider should be holding.
  ledger_balance    bigint not null,
  -- What the provider actually reports.
  provider_balance  bigint not null,
  -- provider − ledger. Non-zero is the alert.
  drift             bigint not null,
  detected_at       timestamptz not null default now(),
  resolved_at       timestamptz,
  resolution_note   text
);

create index reconciliation_alerts_tenant_idx on reconciliation_alerts(tenant_id);

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------

create or replace function set_updated_at() returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger deals_set_updated_at
  before update on deals
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- The ledger is append-only, enforced rather than promised
-- ---------------------------------------------------------------------------

create or replace function reject_mutation() returns trigger
language plpgsql
as $$
begin
  raise exception 'ledger is append-only: % is not permitted', tg_op
    using errcode = 'restrict_violation';
end;
$$;

create trigger ledger_no_update
  before update or delete on ledger
  for each row execute function reject_mutation();

-- The audit trail is worth nothing if it can be edited after the fact.
create trigger audit_log_no_update
  before update or delete on audit_log
  for each row execute function reject_mutation();
