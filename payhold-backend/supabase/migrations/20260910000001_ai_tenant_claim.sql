-- `current_ai_tenant_id()` reads the claim PostgREST actually sets.
--
-- 20260806000004 read `request.jwt.claim.tenant_id` — the per-claim GUC
-- PostgREST stopped setting in v10, years before this project existed. On
-- v12 it is simply absent, so the function returned NULL, every
-- `with check (tenant_id = current_ai_tenant_id())` compared against NULL,
-- and **every AI write has been refused since the day it was written**:
-- `new row violates row-level security policy for table "ai_chat"`.
--
-- Nobody saw it because the grants were right and the tests only asserted
-- grants — `has_table_privilege` says the role may insert, and says nothing
-- about whether a policy will let the row through. The live failure was also
-- masked by a second fault in front of it: the AI client sent its self-signed
-- role token as the `apikey` header, which the gateway refuses outright once a
-- project moves to asymmetric JWT signing keys, so the request never reached
-- PostgREST to be refused here. Fixing that one uncovered this one.
--
-- Modern PostgREST sets a single JSON GUC, `request.jwt.claims`. The legacy
-- name is kept as a fallback so the function is correct on either, and reads
-- NULL rather than raising when neither is set — which is the safe direction:
-- a NULL tenant matches no row and writes nothing, exactly as now.

create or replace function current_ai_tenant_id()
returns uuid
language sql
stable
as $$
  select nullif(
    coalesce(
      nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'tenant_id',
      current_setting('request.jwt.claim.tenant_id', true)
    ),
    ''
  )::uuid;
$$;

grant execute on function current_ai_tenant_id() to payhold_ai;
