-- ---------------------------------------------------------------------------
-- V2 §9 and §12: the capability matrix
-- ---------------------------------------------------------------------------
--
-- Two questions move out of code and into rows here, and they are different
-- questions:
--
--   `provider_capabilities`  what each adapter can do, and whether it is built
--                            and switched on. §9: "each adapter declares its
--                            capabilities rather than letting the UI guess."
--   `payment_markets`        whether a country is open, to collect from and to
--                            pay into. §12 requires a country to be disabled
--                            **without a redeploy**, which a generated file
--                            cannot offer.
--
-- ## What did *not* move, and why
--
-- The country registry stays generated. `countries.ts` records which currency a
-- market uses, which wallets exist there, whether Stripe can pay into it — all
-- of it transcribed from provider documentation by `gen-countries.py`, in two
-- repos, from one source. Copying 55 markets' worth of that into SQL would give
-- it a second home that drifts the first time somebody edits one and not the
-- other, which is exactly the failure the generator exists to prevent.
--
-- So the split is: **the registry says what is possible, the matrix says what is
-- on.** Turning a country off is an insert here and nothing else; the registry
-- is regenerated when a provider's coverage actually changes. Spec §29.11.
--
-- ## `payout_routes.provider` stops being nullable
--
-- Phase 5 shipped the five unbuilt wallet rails with `provider = null` and a
-- `route_needs_an_adapter` check, which said "unbuilt" in the only vocabulary
-- available at the time. Now that §9's adapters have enum values, each of those
-- rails can name the adapter that would carry it, and "is it built" is one fact
-- in one place — `provider_capabilities.implemented`.
--
-- That is a strict improvement rather than a rearrangement: a check constraint
-- cannot look at another table, so the old one could only ever guard the null.
-- The trigger below guards the real condition, and it makes the §15 phase-3
-- acceptance case structural — switching an adapter off disables exactly its
-- own routes, because the routes read the adapter's row.

-- ---------------------------------------------------------------------------
-- What each adapter can do — §9
-- ---------------------------------------------------------------------------

create table provider_capabilities (
  provider                  provider primary key,
  /**
   * **Is there code behind this?** False means the adapter is declared so it
   * can be named and refused with a reason, and `loadProvider` throws for it.
   * Spec §29.3.
   */
  implemented               boolean not null default false,
  /**
   * Switched on. Separate from `implemented` because they fail differently: an
   * unbuilt adapter is a roadmap item, a disabled one is an outage or a
   * commercial decision, and an operator needs to tell those apart at 3am.
   */
  enabled                   boolean not null default false,
  -- §9's eight flags, verbatim. The mirror of `ProviderCapabilities` in
  -- `_shared/provider.ts`; a change to either is a change to both.
  supports_capture          boolean not null default false,
  supports_partial_refund   boolean not null default false,
  supports_marketplace_payout boolean not null default false,
  supports_seller_onboarding  boolean not null default false,
  supports_dispute          boolean not null default false,
  supports_local_currency   boolean not null default false,
  supports_mobile_money     boolean not null default false,
  supports_async_refund     boolean not null default false,
  /** Why it is off, or what is missing. Shown to an operator, not to a buyer. */
  note                      text,
  updated_at                timestamptz not null default now(),

  -- Nothing unbuilt is ever on. The structural half of "declared but disabled".
  constraint enabled_needs_an_implementation check (implemented or not enabled)
);

alter table provider_capabilities enable row level security;

-- Platform-wide facts about our adapters, not tenant data. Every signed-in user
-- may read them: a tenant whose payout was refused needs to see that the rail
-- is off rather than guess.
create policy provider_capabilities_read on provider_capabilities
  for select to authenticated using (true);

grant select on provider_capabilities to authenticated;

insert into provider_capabilities (
  provider, implemented, enabled,
  supports_capture, supports_partial_refund, supports_marketplace_payout,
  supports_seller_onboarding, supports_dispute, supports_local_currency,
  supports_mobile_money, supports_async_refund, note
) values
  -- The launch rail. Cards, MTN MoMo and Airtel Money in; Transfers API out.
  ('flutterwave', true, true,
   true, true, true, false, false, true, true, true,
   'Cards, mobile money and bank transfer across the African markets. The only rail that can pay a Rwandan seller.'),

  -- International card acquiring, and Connect for payouts where Stripe reaches.
  ('stripe', true, true,
   true, true, true, true, true, true, false, true,
   'PaymentIntents with manual capture for deposits, Radar on every card charge, Connect for marketplace payouts.'),

  -- §12: a full lifecycle with zero keys. It claims everything, because a
  -- capability it refused would make a demo path unreachable for a reason that
  -- is not true of any real rail.
  ('fake', true, true,
   true, true, true, true, true, true, true, false,
   'Demo mode. Fakes the counterparty and nothing else — every guard still applies.'),

  -- Declared and unbuilt — §29.3. The flags describe what the documentation
  -- says these APIs can do, so the day an adapter lands the row is already
  -- right; `implemented` is what says it has not.
  ('paypal', false, false,
   true, true, true, true, true, true, false, false,
   'Declared so a seller who picks PayPal or Venmo gets a specific answer. No adapter and no signed agreement.'),

  ('cash_app_pay', false, false,
   false, true, true, false, true, false, false, false,
   'United States only. Declared, not built.'),

  ('china_wallet_partner', false, false,
   false, true, true, false, false, true, false, true,
   'Alipay and WeChat Pay routes the selected Stripe account does not cover. §5: do not promise cross-border payout until an approved local structure exists. Refunds settle asynchronously, up to 90 days out — §7.1.6.');

-- ---------------------------------------------------------------------------
-- Which markets are open — §12
-- ---------------------------------------------------------------------------
--
-- An **overlay**, not a copy of the registry. A country with no row here
-- behaves as the registry says: collectable unless sanctioned, payable if a
-- route reaches it. A row is a deliberate departure from that, and carries the
-- reason, because "why can nobody in Kenya pay us" is a question somebody will
-- ask three months after whoever switched it off has forgotten.
--
-- Scoped like `payout_routes`: null tenant is the platform default, a tenant
-- row replaces it. So PayHold can close a market for everyone, and one company
-- can close one for itself, and neither has to know about the other.

create table payment_markets (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid references tenants(id) on delete cascade,
  country      country_code not null,
  /** Buyers here may pay. */
  collect      boolean not null default true,
  /** Sellers here may be paid. */
  payout       boolean not null default true,
  /** Required, and shown wherever the closure is. A switch with no note is a mystery. */
  reason       text not null,
  created_at   timestamptz not null default now()
);

create unique index payment_markets_scope_key
  on payment_markets (tenant_id, country) nulls not distinct;

create index payment_markets_tenant_idx on payment_markets(tenant_id);

alter table payment_markets enable row level security;

create policy payment_markets_read on payment_markets
  for select to authenticated
  using (
    tenant_id is null
    or tenant_id in (select current_tenant_ids())
    or is_platform_admin()
  );

grant select on payment_markets to authenticated;

/**
 * Is this market open, in this direction, for this tenant?
 *
 * `p_direction` is `collect` or `payout`. Absent rows mean open, which is what
 * makes this an overlay: the registry decides what is possible and this decides
 * what is switched on, and a market nobody has ruled on is not closed.
 */
create or replace function market_open(
  p_tenant    uuid,
  p_country   country_code,
  p_direction text
) returns boolean
language sql
stable
as $$
  select coalesce(
    (select case when p_direction = 'payout' then m.payout else m.collect end
       from payment_markets m
      where m.country = p_country
        and (m.tenant_id is null or m.tenant_id = p_tenant)
      -- The tenant's own row replaces the platform's, the same rule
      -- `route_evaluation` applies to routes.
      order by (m.tenant_id is not null) desc
      limit 1),
    true
  );
$$;

grant execute on function market_open(uuid, country_code, text)
  to authenticated, service_role;

/**
 * Every closure that applies to a tenant, platform and own together.
 *
 * The catalogue endpoint reads this rather than asking `market_open` once per
 * country: 55 round trips to answer "which markets are open" would be a query
 * per row of a page nobody paginates.
 */
create or replace function closed_markets(p_tenant uuid)
returns table (country country_code, collect boolean, payout boolean, reason text)
language sql
stable
as $$
  select distinct on (m.country) m.country, m.collect, m.payout, m.reason
    from payment_markets m
   where (m.tenant_id is null or m.tenant_id = p_tenant)
     and not (m.collect and m.payout)
   order by m.country, (m.tenant_id is not null) desc;
$$;

grant execute on function closed_markets(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Payout routes name their adapter, and cannot outlive it
-- ---------------------------------------------------------------------------

update payout_routes set provider = 'paypal'
 where payout_provider in ('paypal', 'venmo');

update payout_routes set provider = 'cash_app_pay'
 where payout_provider = 'cash_app_pay';

update payout_routes set provider = 'china_wallet_partner'
 where payout_provider in ('alipay', 'wechat_pay');

alter table payout_routes drop constraint route_needs_an_adapter;
alter table payout_routes alter column provider set not null;

comment on column payout_routes.provider is
  'The adapter that talks to this rail''s API. `payout_provider` names the rail '
  '— the shape of destination a token was minted for — and one adapter carries '
  'several: Venmo destinations are reached through PayPal''s API. Whether it is '
  'built is `provider_capabilities.implemented`, not a null here.';

/**
 * A route may only be enabled while its adapter is built and switched on.
 *
 * A check constraint cannot look at another table, which is why the Phase 5
 * version could only guard a null. This guards the real condition, and it is
 * what makes §15 phase 3's acceptance case structural: switching an adapter off
 * takes its own routes with it and touches nobody else's.
 */
create or replace function assert_route_has_live_provider() returns trigger
language plpgsql
as $$
begin
  if new.enabled and not exists (
    select 1 from provider_capabilities c
     where c.provider = new.provider and c.implemented and c.enabled
  ) then
    raise exception
      'policy_violation: % has no live adapter, so the % route cannot be enabled',
      new.provider, new.payout_provider
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger payout_routes_require_live_provider
  before insert or update on payout_routes
  for each row execute function assert_route_has_live_provider();

-- ---------------------------------------------------------------------------
-- The routing engine reads both
-- ---------------------------------------------------------------------------
--
-- Two new reason codes, and they are separated from `provider_disabled` on
-- purpose: "we have closed this market" and "this rail is out of service" are
-- different sentences, need different next actions, and are decided by
-- different people.

create or replace function route_reason_text(
  p_code     text,
  p_rail     payout_provider,
  p_country  country_code,
  p_currency currency_code
) returns text
language sql
immutable
as $$
  select case p_code
    when 'routed' then
      format('Paid by %s.', p_rail)
    when 'market_closed' then
      format('PayHold is not sending payouts to %s at the moment.', p_country)
    when 'provider_unavailable' then
      format('%s is not available for payouts yet.', p_rail)
    when 'provider_disabled' then
      format('%s is not available for payouts yet.', p_rail)
    when 'route_suspended' then
      format('%s payouts are suspended.', p_rail)
    when 'route_under_review' then
      format('%s payouts are under review and cannot be used right now.', p_rail)
    when 'payouts_not_supported' then
      format('%s can collect payments but cannot send them.', p_rail)
    when 'country_not_supported' then
      format('%s cannot pay a destination in %s.', p_rail, p_country)
    when 'currency_not_supported' then
      format('%s cannot pay out in %s.', p_rail, p_currency)
    when 'below_route_minimum' then
      format('This amount is below the minimum %s will send.', p_rail)
    when 'above_route_maximum' then
      format('This amount is above the maximum %s will send.', p_rail)
    when 'destination_not_verified' then
      'The payout destination has not been verified.'
    when 'no_eligible_verified_destination' then
      'No verified payout destination has been registered.'
    else
      format('PayHold has no payout route for %s in %s.', p_rail, p_country)
  end;
$$;

-- Every column reference stays qualified: `returns table` puts `provider`,
-- `method` and `rank` in scope as parameter names, and each is also a
-- `payout_routes` column.
create or replace function route_evaluation(
  p_tenant   uuid,
  p_country  country_code,
  p_currency currency_code,
  p_amount   bigint,
  p_rail     payout_provider default null
) returns table (
  route_id        uuid,
  provider        provider,
  payout_provider payout_provider,
  method          payout_method,
  rank            integer,
  fee_estimate    bigint,
  preferred       boolean,
  eligible        boolean,
  reason_code     text
)
language sql
stable
as $$
  with resolved as (
    select distinct on (r.payout_provider) r.*
      from payout_routes r
     where r.tenant_id is null or r.tenant_id = p_tenant
     order by r.payout_provider, (r.tenant_id is not null) desc
  ),
  judged as (
    select
      r.id                                            as route_id,
      r.provider                                      as provider,
      r.payout_provider                               as payout_provider,
      r.method                                        as method,
      r.rank                                          as rank,
      r.fee_fixed + (p_amount * r.fee_bps) / 10000    as fee_estimate,
      (p_rail is not null and r.payout_provider = p_rail) as preferred,
      case
        -- §12's country switch comes first: a closed market is closed whatever
        -- the rails say, and it is the only one of these an operator here can
        -- reverse in a minute.
        when not market_open(p_tenant, p_country, 'payout') then 'market_closed'
        -- The adapter, then the route. "The rail is unbuilt or out of service"
        -- and "we switched this corridor off" are different sentences.
        when not exists (
          select 1 from provider_capabilities c
           where c.provider = r.provider and c.implemented and c.enabled
        )                                          then 'provider_unavailable'
        when not r.enabled                         then 'provider_disabled'
        when r.risk_status = 'suspended'           then 'route_suspended'
        when r.risk_status <> 'approved'           then 'route_under_review'
        when not r.supports_payouts                then 'payouts_not_supported'
        when not (p_country = any (r.countries))   then 'country_not_supported'
        when not (p_currency = any (r.currencies)) then 'currency_not_supported'
        when p_amount < r.min_amount               then 'below_route_minimum'
        when r.max_amount is not null and p_amount > r.max_amount
                                                   then 'above_route_maximum'
        else 'eligible'
      end                                             as reason_code
    from resolved r
  )
  select
    j.route_id, j.provider, j.payout_provider, j.method, j.rank, j.fee_estimate,
    j.preferred, j.reason_code = 'eligible', j.reason_code
  from judged j
  -- §5.1's `bySellerPreferenceThenReliabilityThenCost`, with eligibility ahead
  -- of all of it, and a total order so the engine cannot be non-deterministic.
  order by
    (j.reason_code = 'eligible') desc,
    j.preferred desc,
    j.rank,
    j.fee_estimate,
    j.payout_provider::text
$$;

grant execute on function route_evaluation(uuid, country_code, currency_code, bigint, payout_provider)
  to authenticated, service_role;
