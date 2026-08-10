-- ---------------------------------------------------------------------------
-- `open_checkout_session` could not see `gen_random_bytes`
-- ---------------------------------------------------------------------------
--
-- Reported by AutoHire: `POST /v1/checkout/sessions` answers
-- `policy_violation: Could not open a checkout session` for every deal — fresh,
-- `created`, verified seller, well-formed body. `GET /checkout/sessions` works
-- and returns an empty list, so the route is deployed and nothing is being
-- written.
--
-- That message is the **unmapped** branch of `rpcError`: the Postgres error did
-- not start with `not_found`, `invalid_state`, `policy_violation` or
-- `insufficient_balance`, so the real one was swallowed and the client got a
-- generic 400. The cause is one line.
--
-- `gen_random_bytes` is **pgcrypto**, not core — and it is the only pgcrypto
-- function anywhere in this schema, used in exactly one place: the token this
-- function mints. Every other money function survives on core builtins, which
-- is why nothing else broke. `gen_random_uuid()` looks like a counter-example
-- and is not: it moved into core in Postgres 13 and resolves from `pg_catalog`
-- wherever the search path points.
--
-- `20260805000001` does say `create extension if not exists pgcrypto`, and that
-- statement is the trap rather than the fix. A Supabase project ships with
-- pgcrypto **already installed in the `extensions` schema**, so `if not exists`
-- matched, did nothing, and left it there. This function is declared
-- `set search_path = public` — correct, and what every function here does, so
-- that a caller cannot shadow a table name — and `extensions` is not on that
-- path. The function therefore cannot resolve `gen_random_bytes` at runtime.
--
-- It passes `npm run test:sql` because PGlite installs pgcrypto into `public`,
-- where the pinned search path does find it. A green local suite was never
-- going to catch this; only the real project has the extension somewhere else.
--
-- The fix is to name the schema the extension actually lives in. `public` stays
-- first, so nothing about shadowing changes — `extensions` only adds a place to
-- look after `public` has been tried, and the only thing found there is the
-- extension surface.
--
-- **Everything else in the function is byte-for-byte the original.** This is a
-- one-line change to the `set search_path` clause, restated in full because
-- `create or replace` cannot patch a body.

create or replace function open_checkout_session(
  p_deal       uuid,
  p_hours      integer default 24,
  p_return_url text default null
) returns checkout_sessions
language plpgsql
security definer
-- The change. `extensions` is where a Supabase project keeps pgcrypto, and
-- `gen_random_bytes` below is the only thing this function needs from it.
set search_path = public, extensions
as $$
declare
  d       deals;
  session checkout_sessions;
begin
  select * into d from deals where id = p_deal for update;

  if not found then
    raise exception 'not_found: deal % does not exist', p_deal
      using errcode = 'no_data_found';
  end if;

  -- `payment_failed` is here so a declined card gets a fresh link without the
  -- client creating a second deal for the same booking. `payment_pending` is
  -- not: a buyer mid-payment on one rail must not be handed a second link, or
  -- two charges race for one hold.
  if d.status not in ('created', 'checkout_started', 'payment_failed') then
    raise exception 'invalid_state: deal % is %, so a checkout cannot be opened',
      p_deal, d.status
      using errcode = 'check_violation';
  end if;

  -- Idempotent by design — see `checkout_sessions_one_open`. A client retrying
  -- gets the link they already have rather than a second live one.
  select * into session
    from checkout_sessions
   where deal_id = p_deal and status = 'open' and expires_at > now();

  if found then
    return session;
  end if;

  -- An open-but-expired session is closed on the way past. This is the one
  -- place a write is worth doing, because otherwise the partial unique index
  -- would refuse the replacement.
  update checkout_sessions
     set status = 'canceled'
   where deal_id = p_deal and status = 'open';

  insert into checkout_sessions (tenant_id, deal_id, token, return_url, expires_at)
  values (
    d.tenant_id,
    d.id,
    -- 256 bits, base64url. `gen_random_bytes` rather than a uuid: a uuid is 122
    -- bits of randomness wearing a recognisable shape, and this is the only
    -- thing standing between a stranger and somebody's payment page.
    translate(encode(gen_random_bytes(32), 'base64'), '+/=', '-_'),
    p_return_url,
    now() + make_interval(hours => greatest(p_hours, 1))
  )
  returning * into session;

  update deals set status = 'checkout_started'
   where id = d.id and status in ('created', 'payment_failed');

  perform write_audit(d.tenant_id, d.id, 'system', 'checkout.session_opened',
    jsonb_build_object('session_id', session.id, 'expires_at', session.expires_at));

  return session;
end;
$$;

-- A recreated function is granted to PUBLIC by default, so both revokes are
-- reissued — the trap `refund_deal` and `resolve_dispute` walked into in V2.
revoke all on function open_checkout_session(uuid, integer, text)
  from public, anon, authenticated;
revoke all on function open_checkout_session(uuid, integer, text) from payhold_ai;
