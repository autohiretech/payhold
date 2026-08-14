-- ---------------------------------------------------------------------------
-- A seller can exist before a payout destination does
-- ---------------------------------------------------------------------------
--
-- `POST /v1/sellers` has required a destination since the table existed: a
-- host had no way to become a payable party in this system without also
-- supplying a bank account or mobile money number in the same request. That
-- was ergonomics, not §5.1 — the spec's own acceptance test 4 already reads
-- "a seller with **no verified** destination is blocked from payout", which
-- says nothing about a destination being required to exist at all. A client
-- whose onboarding collects "who is this person" before "how do they want to
-- be paid" — the ordinary shape of signing someone up — had no way to say so.
--
-- Money was never the blocker. `held` and `available` are ledger sums keyed on
-- `deal_id` and `seller_id`; nothing about accruing them reads a destination.
-- The only place a missing one was ever going to matter is the payout, and
-- that path already asks the right question: `seller_capabilities` has
-- checked `seller_destinations` for a primary row since `20260807000007` and
-- already answers 'No payout destination has been registered' when there is
-- none — a branch that has been dead code until now, because
-- `seed_primary_destination` always ran off columns `POST /v1/sellers`
-- required to be non-null. `screen_payout`'s eligibility gate reads that
-- reason through `seller_capabilities` and holds the payout at
-- `needs_verification`, precisely the status whose whole point is "ends when
-- somebody attests to the missing fact" — adding and verifying a destination
-- is exactly that attestion. Nothing downstream of the eligibility gate
-- (`route_payout`, the backup-destination policy) runs before that gate
-- clears, so a destination-less seller never reaches routing at all.
--
-- So the only two things that were actually holding this shut:
--
--   1. the five `not null` constraints below, which made "create a seller
--      with no destination" impossible at the schema level regardless of
--      what the endpoint asked for
--   2. `seed_primary_destination`, which assumed every insert carried one and
--      would have written a `seller_destinations` row full of nulls
--
-- Both are fixed here. Nothing else in the money engine changes: the six
-- buckets, the eligibility gate, and the routing engine were already written
-- to expect this seller.

alter table sellers
  alter column country            drop not null,
  alter column payout_currency    drop not null,
  alter column payout_provider    drop not null,
  alter column beneficiary_token  drop not null,
  alter column masked_destination drop not null;

-- `seed_primary_destination` skips the insert when the seller carries no
-- destination. Firing it anyway would write a `seller_destinations` row with
-- five null columns masquerading as a real (if unverified) destination —
-- `seller_capabilities` would find that row, not find it missing, and never
-- reach the "no payout destination has been registered" branch this
-- migration exists to make reachable.
--
-- `create or replace` with an identical signature: same trigger, same
-- ownership, no `drop function` needed.
create or replace function seed_primary_destination() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.beneficiary_token is null then
    return new;
  end if;

  insert into seller_destinations (
    tenant_id, seller_id, label, country, payout_currency, payout_provider,
    beneficiary_token, masked_destination, is_primary
  )
  values (
    new.tenant_id, new.id, 'Primary', new.country, new.payout_currency,
    new.payout_provider, new.beneficiary_token, new.masked_destination, true
  );

  return new;
end;
$$;

revoke all on function seed_primary_destination() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The primary's copy was missing a column, and a null seller.country made it
-- visible
-- ---------------------------------------------------------------------------
--
-- `sync_primary_destination` has copied `beneficiary_token`, `masked_destination`,
-- `payout_currency` and `payout_provider` onto `sellers` since `20260807000007`,
-- documented as keeping "the primary's copy" in step. It never copied
-- `country`. That was invisible before this migration: `sellers.country` was
-- `not null`, set once at registration, and stayed put — a seller's country
-- moving mid-life was already a latent inconsistency between the two tables,
-- just never one that reached `null`.
--
-- A seller registered with no destination has no `country` at all, and
-- nothing was going to give them one: `add_seller_destination` writes the new
-- row's country onto `seller_destinations` and this trigger read it, but never
-- wrote it back to the column every other reader — `deals/index.ts`'s
-- `buyer_country` default, the AI case files, `SellerDetail` — still asks
-- `sellers` for. Adding a first destination would have left the seller
-- permanently on the "no country" path this migration otherwise closes.
--
-- `create or replace` with an identical signature, so no `drop function`. The
-- revoke is reissued because a recreated function is granted to PUBLIC again.

create or replace function sync_primary_destination() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prev text;
begin
  if not new.is_primary then
    return new;
  end if;

  select beneficiary_token into v_prev from sellers where id = new.seller_id;

  update sellers
     set beneficiary_token  = new.beneficiary_token,
         masked_destination = new.masked_destination,
         country             = new.country,
         payout_currency    = new.payout_currency,
         payout_provider    = new.payout_provider,
         -- Only when it actually moved. Re-saving the same destination is not
         -- a change, and stamping it would hold a payout for nothing.
         destination_changed_at = case
           when v_prev is distinct from new.beneficiary_token then now()
           else destination_changed_at
         end
   where id = new.seller_id;

  return new;
end;
$$;

revoke all on function sync_primary_destination() from public, anon, authenticated;
