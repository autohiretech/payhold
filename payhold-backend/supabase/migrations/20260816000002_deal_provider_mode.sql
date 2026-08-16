-- PayPal refunds were 404ing at PayPal with "the specified resource does not
-- exist", against GET /v2/checkout/orders/{id} and
-- GET /v2/payments/captures/{id}.
--
-- Root cause: `load-provider.ts` resolves sandbox-vs-live for every provider
-- call from `tenant_provider_accounts.mode` — read fresh, at call time. That
-- is fine for Stripe and Flutterwave, where the key itself is sandbox or live
-- (`sk_test_…`/`sk_live_…`) and the host never changes. PayPal is the one
-- rail where sandbox and live are different *hosts*
-- (`api-m.sandbox.paypal.com` vs `api-m.paypal.com`), chosen purely by that
-- `mode` column.
--
-- `deals` never recorded which mode a deal actually charged under — only
-- `provider` (the rail name). So a tenant who charged a deal while connected
-- in `test`, then later reconnected PayPal in `live` (`tenant_provider_accounts`
-- is `unique (tenant_id, provider)` — one row, overwritten on reconnect), gets
-- every later refund of that old deal routed to the live host with an id that
-- only ever existed on the sandbox one. 404, every time, and it reads as
-- PayPal being broken rather than as a stale routing decision.
--
-- The fix locks the mode onto the deal the same way `fx_rate` is already
-- locked "at the moment the buyer paid" (see the column comment on
-- `deals.fx_rate`): once charged, `provider_mode` does not move, and refund /
-- deposit-capture read it back instead of re-deriving from whatever the
-- tenant's account happens to be connected as today.
alter table deals add column provider_mode provider_mode;

comment on column deals.provider_mode is
  'Locked at charge time, like fx_rate. The sandbox/live the deal actually '
  'charged under — NOT the tenant''s current tenant_provider_accounts.mode, '
  'which can drift after a reconnect. Null for deals that predate this '
  'column or that never reached a provider (fake rail, never charged).';

-- Best-effort backfill for existing deals: assume each was charged under
-- whatever mode its tenant's account is in right now. Exact for any tenant
-- that has never switched mode; for one that has, there is no record left to
-- do better than a guess — the whole reason this migration exists is that the
-- old mode is gone once an account is reconnected.
update deals d
set provider_mode = tpa.mode
from tenant_provider_accounts tpa
where tpa.tenant_id = d.tenant_id
  and tpa.provider = d.provider
  and d.provider_mode is null;

-- `complete_checkout_session` is the other place a charge's rail gets written
-- onto the deal (the `/pay` route does a plain `update`, and can just add the
-- column there). It is gaining a parameter, which `create or replace` cannot
-- do — Postgres would keep the six-argument original as a sibling and every
-- existing six-argument call would keep hitting it, silently never setting
-- `provider_mode`. Drop the old signature first, the same trap `fund_deal`'s
-- header already names.
drop function complete_checkout_session(uuid, payment_method, text, provider, text, text);

create function complete_checkout_session(
  p_session      uuid,
  p_method       payment_method,
  p_network      text,
  p_provider     provider,
  p_provider_ref text,
  p_payment_link text,
  p_provider_mode provider_mode default null
) returns checkout_sessions
language plpgsql
security definer
set search_path = public
as $$
declare
  session checkout_sessions;
  d       deals;
begin
  select * into session from checkout_sessions where id = p_session for update;

  if not found then
    raise exception 'not_found: checkout session % does not exist', p_session
      using errcode = 'no_data_found';
  end if;

  if checkout_session_state(session) <> 'open' then
    raise exception 'invalid_state: this checkout session is %',
      checkout_session_state(session)
      using errcode = 'check_violation';
  end if;

  select * into d from deals where id = session.deal_id for update;

  update checkout_sessions
     set status = 'completed',
         completed_at = now(),
         method = p_method,
         network = p_network,
         provider = p_provider,
         provider_ref = p_provider_ref,
         payment_link = p_payment_link
   where id = session.id
  returning * into session;

  -- The rail is recorded now so an operator sees where the payment went while
  -- it is still pending. The hold waits for the webhook, as it always has.
  update deals
     set provider = p_provider,
         payment_method = p_method,
         payment_network = p_network,
         status = 'payment_pending',
         provider_mode = coalesce(p_provider_mode, provider_mode)
   where id = d.id;

  -- §10.2. Distinct from `order.funded_held` on purpose: this says the buyer is
  -- done with our page, that one says money arrived, and a client that conflated
  -- them would ship goods against a card that has not settled.
  perform enqueue_webhooks(d.tenant_id, d.id, 'checkout.completed',
    jsonb_build_object(
      'session_id', session.id,
      'method', p_method,
      'network', p_network,
      'provider', p_provider
    ));

  return session;
end;
$$;

-- The recreated function is granted to PUBLIC by default, so both revokes
-- have to be reissued against the new seven-argument signature — the same
-- reissue every other recreated money function in this codebase needed.
revoke all on function complete_checkout_session(
  uuid, payment_method, text, provider, text, text, provider_mode
) from public, anon, authenticated;
revoke all on function complete_checkout_session(
  uuid, payment_method, text, provider, text, text, provider_mode
) from payhold_ai;
