-- A typed PayPal address is not evidence, so nothing may auto-verify one.
--
-- `seller_auto_verify` is a tenant saying "I onboard my own sellers, take my
-- word for their payout accounts". That word is worth something on every rail
-- where the token came from the rail: a Stripe `acct_…` exists because Stripe
-- created it, a Flutterwave beneficiary exists because Flutterwave tokenized a
-- number it recognised. The tenant is attesting to a fact the provider already
-- confirmed.
--
-- **PayPal's token is a string somebody typed.** `PayPalProvider.tokenize`
-- records an email address; nothing has asked PayPal whether an account is
-- behind it, whether that account is confirmed, or whether it can receive
-- money at all. And PayPal does not refuse a payout to an address like that —
-- it accepts the batch, reports `SUCCESS`, holds the item `UNCLAIMED` for
-- thirty days, and returns the money. On 2026-09-13 three payouts totalling
-- USD 2,231.07 were in exactly that state against two typed addresses, both of
-- which looked perfectly correct, and the first anyone knew of it was
-- `RECEIVER_UNREGISTERED` on an item-level status nobody was reading yet.
--
-- Auto-verifying that row is the platform attesting to a fact nobody
-- established. So on the `paypal` rail, and only there, the tenant's word does
-- not carry the destination.
--
-- **What still verifies a PayPal destination**, both of them a real answer
-- rather than a default:
--
--   * `POST /v1/sellers/:id/paypal/complete` — the seller signed in, PayPal
--     returned `verified_account`, and `verify_seller_destination` is called
--     on it. PayPal's own answer about PayPal's own account, which is better
--     evidence than anything this system could assemble.
--   * a person, in the dashboard or relayed by a platform that owns
--     verification. Someone looked and said yes, and the audit row has their
--     name on it.
--
-- Neither is touched here. What is removed is the third way in, where a row
-- became verified because a setting was on.
--
-- **Nothing is un-verified retroactively**, on `20260911000004`'s reasoning:
-- withdrawing a verification is a decision and a migration is nobody. Rows
-- already verified this way keep their `verified_at`, and an operator who
-- wants them looked at again can un-verify one by hand.
--
-- Both functions below are `20260911000004`'s, with one condition added to the
-- line that computes `trusted`. Same signatures, so `create or replace`; the
-- revokes and the grant are reissued with them.

-- ---------------------------------------------------------------------------
-- A seller registered with a PayPal destination
-- ---------------------------------------------------------------------------
--
-- The seed trigger writes the destination a seller was created with. Its
-- `trusted` also decides `security_hold_until`, and on this rail that now runs
-- like anyone else's: §5.1's window is the only thing between a typed address
-- and a transfer while the account is unverified.

create or replace function seed_primary_destination() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  trusted boolean;
begin
  if new.beneficiary_token is null then
    return new;
  end if;

  trusted := seller_auto_verify(new.tenant_id)
             and not platform_owns_verification(new.tenant_id)
             -- Only PayPal can vouch for a PayPal address. See this migration's
             -- header; the connect flow is what fills this in.
             and new.payout_provider is distinct from 'paypal';

  insert into seller_destinations (
    tenant_id, seller_id, label, country, payout_currency, payout_provider,
    beneficiary_token, masked_destination, is_primary,
    verified_at, security_hold_until
  )
  values (
    new.tenant_id, new.id, 'Primary', new.country, new.payout_currency,
    new.payout_provider, new.beneficiary_token, new.masked_destination, true,
    case when trusted then now() end,
    case when trusted then now() end
  );

  return new;
end;
$$;

revoke all on function seed_primary_destination() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- A destination added or replaced later
-- ---------------------------------------------------------------------------
--
-- The same rule on the path a host actually uses. `completePayPalConnect`
-- calls this too — it adds the destination and then verifies it — so the
-- connected case is unaffected: it is verified a statement later, by PayPal's
-- answer, with the audit row that says so.

create or replace function add_seller_destination(
  p_seller   uuid,
  p_tenant   uuid,
  p_country  country_code,
  p_currency currency_code,
  p_provider payout_provider,
  p_token    text,
  p_masked   text,
  p_label    text default null,
  -- Kept for the functions deployed before `20260911000003`, which still send
  -- it. `'primary'` (or nothing) is the only thing it can mean now.
  p_role     text default 'primary',
  p_actor    text default null
) returns seller_destinations
language plpgsql
security definer
set search_path = public
as $$
declare
  s          sellers;
  d          seller_destinations;
  hold_hours integer;
  trusted    boolean;
  v_archived uuid[];
begin
  if p_role is not null and p_role <> 'primary' then
    raise exception 'backup_destination_removed: A seller has one payout destination; adding one replaces the current one.'
      using errcode = 'check_violation';
  end if;

  if p_token is null or btrim(p_token) = '' or p_masked is null or btrim(p_masked) = '' then
    raise exception 'policy_violation: a destination needs a token and a mask'
      using errcode = 'check_violation';
  end if;

  -- Locked, and tenant-scoped in the same statement. Two concurrent changes
  -- would otherwise both archive the same row and the second insert would lose
  -- to `seller_destinations_one_live` with a message about an index.
  select * into s from sellers
   where id = p_seller and tenant_id = p_tenant
     for update;

  if not found then
    raise exception 'not_found: seller % does not exist', p_seller
      using errcode = 'no_data_found';
  end if;

  -- Archive first. `seller_destinations_one_primary` and `_one_live` both refuse
  -- the overlap, so the order is forced. `replaced_by` is filled in after the
  -- insert: the new row's id does not exist yet, and the foreign key is checked
  -- per statement. Writing `is_primary = false` is what the sync trigger reads
  -- as "not mine", so the seller's columns are untouched until the insert.
  with archived as (
    update seller_destinations
       set archived_at = now(),
           is_primary  = false,
           is_backup   = false
     where seller_id = p_seller
       and archived_at is null
    returning id
  )
  select coalesce(array_agg(id order by id), '{}') into v_archived from archived;

  -- A tenant that attests to its own onboarding gets a verified row out of
  -- hold — unless its platform owns verification (§29.18), in which case the
  -- platform relays the decision and the hold runs like anyone's, or the rail
  -- is PayPal, where the token is an address nobody has checked and the
  -- tenant's word is about something it cannot know. See this migration's
  -- header.
  trusted    := seller_auto_verify(p_tenant)
                and not platform_owns_verification(p_tenant)
                and p_provider is distinct from 'paypal';
  hold_hours := case when trusted then 0
                     else setting_num(p_tenant, 'destination_hold_hours', 24)::integer end;

  insert into seller_destinations (
    tenant_id, seller_id, label, country, payout_currency, payout_provider,
    beneficiary_token, masked_destination, is_primary, is_backup,
    verified_at, security_hold_until
  )
  values (
    p_tenant, p_seller, p_label, p_country, p_currency, p_provider,
    p_token, p_masked, true, false,
    case when trusted then now() end,
    now() + make_interval(hours => hold_hours)
  )
  returning * into d;

  -- Not `returning * into d`: that would overwrite the row this returns. The
  -- archived rows are not primary, so the sync trigger ignores this write.
  update seller_destinations
     set replaced_by = d.id
   where id = any(v_archived);

  -- The mask, never the token (§19).
  perform write_audit(
    p_tenant, null, coalesce(nullif(btrim(p_actor), ''), 'api'),
    'seller.destination_added',
    jsonb_build_object(
      'seller_id', p_seller,
      'destination_id', d.id,
      'destination', d.masked_destination,
      'provider', d.payout_provider,
      'role', 'primary',
      'security_hold_until', d.security_hold_until,
      'auto_verified', trusted,
      'archived_destination_ids', to_jsonb(v_archived)
    )
  );

  return d;
end;
$$;

revoke all on function add_seller_destination(
  uuid, uuid, country_code, currency_code, payout_provider, text, text, text, text, text
) from public, anon, authenticated;
revoke all on function add_seller_destination(
  uuid, uuid, country_code, currency_code, payout_provider, text, text, text, text, text
) from payhold_ai;
grant execute on function add_seller_destination(
  uuid, uuid, country_code, currency_code, payout_provider, text, text, text, text, text
) to service_role;
