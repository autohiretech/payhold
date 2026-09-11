-- `seller_verification_relay` — a tenant tells PayHold the result of its own
-- KYC, seller by seller, over its own API key.
--
-- The refusal this opens a door beside is the right one and stays. §12's
-- sentence is that a seller must not be paid solely because a webhook said
-- "success", and a client that can verify its own sellers has turned KYC into a
-- field it sets — so `POST /v1/sellers/:id/verify` has refused an API key
-- outright since it was written. What that leaves with nowhere to go is a
-- tenant that genuinely does the review: an account holder who reads a host's
-- documents inside their own product, decides, and then has to sign in to a
-- second dashboard and decide again. The second decision is not a check. It is
-- a transcription, and a control that is only ever transcribed is a control
-- nobody is really applying.
--
-- So this is the attestation made once, person-only, for the whole account:
-- "my own onboarding reviews each seller, and I will tell you the result seller
-- by seller — take my word for it over the API." It is set from Settings, whose
-- PATCH refuses an API key, and it is audited on the settings row that flipped
-- it. With it on, a per-seller call carrying that account's key is that tenant
-- relaying a decision a person there already made; with it off, it is a client
-- inventing an attestation nobody made, which is exactly what §12 forbids and
-- exactly what the unchanged refusal describes.
--
-- **It is not `seller_auto_verify` and must never be confused with it**, which
-- is why it is a second setting rather than a widening of the first.
-- `20260817000002`'s flag writes `verified` at INSERT — the moment a row
-- appears, before anybody has looked at anything. A client typically creates
-- the PayHold seller when a user first ticks "I want to host", so under that
-- flag every unreviewed signup is verified on arrival and a later per-seller
-- decision has nothing left to decide. That is the opposite of what an account
-- holder doing manual review is asking for. This flag touches the insert path
-- not at all: a seller still lands `pending`, still unpayable, and stays that
-- way until their tenant says otherwise about *them*.
--
-- The two are independent, and all four combinations are meant:
--
--   auto_verify  relay   what an account gets
--   ----------- ------- -----------------------------------------------------
--       off       off    Today. A seller lands `pending`; only a person here
--                        may verify them, one at a time, in PayHold.
--       off        on    The one this migration exists for. A seller lands
--                        `pending` and is verified when their own platform
--                        has reviewed them and says so.
--        on       off    The client's signup is the check, so sellers arrive
--                        verified and there is nothing per-seller to relay.
--        on        on    Sellers arrive verified *and* their platform may
--                        restate or withdraw that per seller — which is the
--                        combination a tenant wants if its review can also
--                        come back negative later.
--
-- Un-verifying takes the same door and not a wider one. Withdrawing is the safe
-- direction — it can only stop a payout, never start one — and a key that could
-- turn verification on and never off would be a strictly worse door than one
-- that does both: a tenant whose own re-screen comes back with a sanctions hit
-- could relay the good news and not the bad. That symmetry is an argument about
-- a relay, though, so it ends where the relay does. With the flag off this
-- account's verifications were made by named people here, and a server
-- credential silently overturning a named person's decision is not the safe
-- direction — it is an unnamed actor erasing a named one. Both directions are
-- refused there, in the same words as before.
--
-- **The relayed path stamps no destination**, and that is the one behaviour
-- that changes shape rather than only widening. Verifying a seller answers "is
-- this person who they say they are"; the primary destination's `verified_at`
-- rides along today because for somebody clicking Verify in PayHold's dashboard
-- the two were looked at in one review. A tenant relaying an identity decision
-- has not thereby looked at a payout account — and
-- `verify_seller_destination` next door refuses an API key on exactly that
-- ground, so letting this call stamp one would reach the narrower door's answer
-- through its neighbour. Those destinations are verified by a person, and the
-- payout stays held at `needs_verification` until one does.
--
-- Everything downstream is untouched, which is `20260817000002`'s design and
-- the reason this is safe at all. `screen_payout`, `seller_capabilities` and
-- `route_payout` read the same columns they always read: a seller verified this
-- way with an unverified destination, a live security hold, a stale sanctions
-- date or an open dispute is exactly as unpayable as before. A flag decides who
-- may write the column, never what reading it means.
--
-- The audit row is what keeps "who said this seller was verified" answerable,
-- and it must not answer with a person who was not there. `actor` is already
-- `api_key:<label>` on this path — the credential, not a name — and
-- `attested_by` says which attestation is behind the row: the tenant's relay,
-- or the person making it here and now.

create or replace function seller_verification_relay(p_tenant uuid) returns boolean
language sql
stable
as $$
  select setting_num(p_tenant, 'seller_verification_relay', 0) <> 0;
$$;

comment on function seller_verification_relay(uuid) is
  'Whether this tenant''s owner has attested that their own onboarding reviews '
  'each seller and will report the result over the API. Read only by '
  '`verify_seller`; nothing on the insert path or the payout path asks it.';

-- A signature change, so `create or replace` cannot do it, and a recreated
-- function is granted to PUBLIC again — both revokes below are reissued for
-- that reason and not out of habit.
drop function if exists verify_seller(uuid, text, boolean);

create function verify_seller(
  p_seller      uuid,
  p_actor       text,
  p_verified    boolean default true,
  p_via_api_key boolean default false
) returns sellers
language plpgsql
security definer
set search_path = public
as $$
declare
  s sellers;
begin
  if p_actor is null or btrim(p_actor) = '' then
    raise exception 'policy_violation: a verification must record who made it'
      using errcode = 'check_violation';
  end if;

  -- Locked and read before the flag is asked, because the tenant whose
  -- attestation governs this call is the seller's and the request names only
  -- the seller. The lock is the one `add_seller_destination` takes on the same
  -- row, so a destination change cannot interleave with a verification.
  select * into s from sellers where id = p_seller for update;

  if not found then
    raise exception 'not_found: seller % does not exist', p_seller
      using errcode = 'no_data_found';
  end if;

  -- Both directions, for the header's reason: the symmetry that makes
  -- withdrawing safe is an argument about a relay, and there is no relay here.
  -- Enforced in SQL and not only in the Edge Function because a policy kept in
  -- TypeScript is a policy the next caller can be written without.
  if p_via_api_key and not seller_verification_relay(s.tenant_id) then
    raise exception 'policy_violation: seller % belongs to an account that has not turned on verification relay, so only a person may verify them', p_seller
      using errcode = 'check_violation';
  end if;

  update sellers
     set kyc_status = case when p_verified then 'verified'::kyc_status
                           else 'review_required'::kyc_status end,
         sanctions_checked_at = case when p_verified then now() else sanctions_checked_at end
   where id = s.id
  returning * into s;

  -- See the header: the identity attestation carries the destination with it
  -- only where the person making it was looking at both.
  if p_verified and not p_via_api_key then
    update seller_destinations
       set verified_at = coalesce(verified_at, now())
     where seller_id = p_seller and is_primary;
  end if;

  perform write_audit(s.tenant_id, null, p_actor,
    case when p_verified then 'seller.verified' else 'seller.review_required' end,
    jsonb_build_object(
      'seller_id', s.id,
      'name', s.name,
      'attested_by', case when p_via_api_key then 'tenant_verification_relay'
                          else 'person' end));

  return s;
end;
$$;

comment on function verify_seller(uuid, text, boolean, boolean) is
  'Records §12''s attestation for one seller. `p_via_api_key` says the caller is '
  'a tenant''s own server relaying a decision its own review reached, which is '
  'refused unless that tenant''s `seller_verification_relay` is on. It stamps no '
  'destination on that path.';

grant execute on function seller_verification_relay(uuid) to authenticated, service_role;

revoke all on function verify_seller(uuid, text, boolean, boolean)
  from public, anon, authenticated;
revoke all on function verify_seller(uuid, text, boolean, boolean) from payhold_ai;
