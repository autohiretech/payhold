-- ---------------------------------------------------------------------------
-- The rail's cut comes off the hold, not off the seller's pool
-- ---------------------------------------------------------------------------
--
-- Reported from the dashboard: one funded, unreleased deal of NGN 61,000 and
-- the cards read
--
--     HELD  NGN 61K        CLEARING  −NGN 847.17
--
-- Both halves are wrong, by the same number, in opposite directions.
--
-- `fund_deal` books the rail's charge the moment the payment lands —
-- `write_ledger(d, 'provider_fee', -fee)` — and that is right: Flutterwave has
-- genuinely taken it, and deferring the entry to release would leave the
-- reconciliation pass expecting a balance the provider does not have for the
-- whole length of the hold.
--
-- What was wrong is where the balance functions then counted it. `clearing` is
-- documented as "what the seller is owed and could still be sent", and it
-- counted `provider_fee` unconditionally — so a deal nobody has released yet
-- showed the rail's fee as a negative debt to a seller who is owed nothing.
-- Meanwhile `held` — "buyer money in the vault against open deals" — claimed
-- the whole 61,000, including the 847.17 that had already left for the rail.
--
-- The two errors cancel, which is exactly why nothing caught this: reconcile
-- compares `held + pending_clearance + available + reserved + fees_retained`
-- against the provider, and that sum was correct throughout. Only the split
-- between the buckets was a fiction, and the split is what the operator reads.
--
-- So: while a deal has no `release` entry, the provider fee sits in `held`,
-- reducing it to what the vault actually holds. At release it moves into the
-- clearing pool, where the seller's net has always been
-- `presentment − provider_fee − platform fee − tax`. After release every
-- bucket is byte-for-byte what it was before this migration.
--
-- Deliberately NOT done: changing what `release` writes. Netting the fee off
-- the release entry would give the same cards, but `release` is written in
-- four places and read by the seller wallet, the partial-refund pool and the
-- deal-amounts view, and a ledger-semantics change to fix a presentation bug
-- is a poor trade. The ledger is untouched here.

create or replace function rail_balances(p_tenant uuid)
returns table (
  provider           provider,
  currency           currency_code,
  held               bigint,
  pending_clearance  bigint,
  available          bigint,
  reserved           bigint,
  fees_retained      bigint,
  tenant_funds       bigint,
  paid_out           bigint
)
language sql
stable
as $$
  -- Whether the deal has left the hold at all. Deal-level rather than
  -- per-rail: a cross-rail deal's release and its provider fee can sit on
  -- different rails, and "has this been released" is a fact about the deal.
  with released as (
    select distinct l.deal_id
      from ledger l
     where l.tenant_id = p_tenant
       and l.deal_id is not null
       and l.entry_type = 'release'
  ),
  per_deal as (
    select
      l.deal_id,
      l.provider,
      l.currency,
      -- The vault's own money. The rail's cut is subtracted while the deal is
      -- held, because by then the rail has already taken it; once released the
      -- hold is emptied by the `release` entry and the fee is accounted for in
      -- the clearing pool instead, so counting it here too would double it.
      coalesce(sum(l.amount) filter (
        where l.entry_type in ('hold', 'release', 'refund')), 0)
      + case when r.deal_id is null then
          coalesce(sum(l.amount) filter (where l.entry_type = 'provider_fee'), 0)
        else 0 end as held,
      -- What the seller is owed and could still be sent.
      coalesce(sum(
        case l.entry_type
          when 'release'         then -l.amount
          when 'fee'             then  l.amount
          when 'tax'             then  l.amount
          when 'reserve'         then  l.amount
          when 'reserve_release' then  l.amount
          when 'payout'          then  l.amount
          else 0
        end), 0)
      + case when r.deal_id is not null then
          coalesce(sum(l.amount) filter (where l.entry_type = 'provider_fee'), 0)
        else 0 end as clearing,
      coalesce(sum(
        case l.entry_type
          when 'reserve'         then -l.amount
          when 'reserve_release' then -l.amount
          else 0
        end), 0) as reserved,
      coalesce(sum(
        case l.entry_type
          when 'fee' then -l.amount
          when 'tax' then -l.amount
          else 0
        end), 0) as retained,
      coalesce(sum(l.amount) filter (
        where l.entry_type in ('cross_rail_offset', 'cross_rail_payout')), 0) as funds,
      coalesce(-sum(l.amount) filter (where l.entry_type = 'payout'), 0) as paid,
      max(d.payout_due_at) as payout_due_at
    from ledger l
    join deals d on d.id = l.deal_id
    left join released r on r.deal_id = l.deal_id
    where l.tenant_id = p_tenant
      and l.deal_id is not null
    group by l.deal_id, l.provider, l.currency, r.deal_id
  ),
  tenant_level as (
    select
      null::uuid as deal_id,
      l.provider,
      l.currency,
      0::bigint as held,
      0::bigint as clearing,
      0::bigint as reserved,
      0::bigint as retained,
      coalesce(sum(l.amount), 0) as funds,
      0::bigint as paid,
      null::timestamptz as payout_due_at
    from ledger l
    where l.tenant_id = p_tenant
      and l.deal_id is null
      and l.entry_type = 'external_transfer'
    group by l.provider, l.currency
  ),
  combined as (
    select * from per_deal
    union all
    select * from tenant_level
  )
  select
    p.provider,
    p.currency,
    sum(p.held)::bigint,
    coalesce(sum(p.clearing) filter (
      where p.payout_due_at is null or p.payout_due_at > now()), 0)::bigint,
    coalesce(sum(p.clearing) filter (
      where p.payout_due_at is not null and p.payout_due_at <= now()), 0)::bigint,
    sum(p.reserved)::bigint,
    sum(p.retained)::bigint,
    sum(p.funds)::bigint,
    sum(p.paid)::bigint
  from combined p
  group by p.provider, p.currency
  order by p.provider::text, p.currency;
$$;
