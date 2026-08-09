-- §11's `sellers.external user ID` gets a writer, and a uniqueness rule.
--
-- The column has existed since `20260807000007` and nothing has ever written
-- it: `POST /v1/sellers` did not accept it and did not insert it. So a tenant
-- registering its own users as sellers — which is every tenant, since PayHold
-- mints no seller identity — had no way to ask "which seller is this person of
-- mine", and the answer had to be kept on their side or matched on a name.
--
-- One index, because the column already exists. What is added here is the
-- constraint the mapping is worthless without: **one seller per handle, per
-- tenant.** Without it a client retrying a registration that timed out gets a
-- second seller for the same person, with a second beneficiary token, and
-- nothing afterwards can say which of the two is the real one — a payout goes
-- to whichever row the client happened to store.
--
-- Partial, because null is not a handle. A tenant registering sellers by hand
-- from the dashboard supplies nothing here, and any number of those rows must
-- stay legal.
--
-- Scoped to the tenant for the reason everything is: two clients numbering
-- their own users from 1 is the expected case, not a collision.
create unique index sellers_external_user_key
  on sellers(tenant_id, external_user_id)
  where external_user_id is not null;

comment on column sellers.external_user_id is
  'The client''s own identifier for this seller — AutoHire''s host id, another '
  'tenant''s user id. Supplied at registration and never interpreted here. '
  'Unique per tenant where present, so a retried registration cannot mint a '
  'second seller for one person.';
