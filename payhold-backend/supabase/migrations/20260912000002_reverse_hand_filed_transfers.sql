-- ---------------------------------------------------------------------------
-- Take the two hand-filed external transfers back out of the balance
-- ---------------------------------------------------------------------------
--
-- On 2026-09-12 a person filed two transfers between their own provider
-- accounts through the Overview card, five minutes apart:
--
--   f0a2d413…  flutterwave  GHS  50,000,000  ref "3932"
--   c741dc76…  paypal       GHS  50,000,000  ref "horugavye.official@gmail"
--
-- Neither describes money that moved. They were entered while looking at the
-- screen, and the second one cannot describe money at all: `INTERNATIONAL_
-- CURRENCIES` in `_shared/rails.ts` gives the PayPal rail USD and EUR, so a
-- GHS balance on PayPal is not a mistake about an amount, it is a balance that
-- cannot exist. `record_external_transfer` never asked — it validated the
-- actor, the reference and a non-zero amount, and nothing about the money.
--
-- **Why this is not cosmetic.** `rail_balances` reads `external_transfer` rows
-- with no deal into `tenant_funds` (20260817000004, :123-139), `tenant_balances`
-- sums that per currency, and `reconciliation.ts` adds it into `expected()`.
-- The nightly pass therefore asks each provider for a balance that includes
-- these two claims, finds GHS 1,000,000 that was never there, and
-- `record_reconciliation` sets `tenants.status = 'payouts_frozen'`. The pass has
-- never run on this tenant — `reconciliation_runs` is empty — so nothing has
-- gone wrong yet. That is the only reason this is a correction and not an
-- incident.
--
-- ## Reversing entries, not a delete
--
-- The ledger is the truth of this system: there is no stored balance column
-- anywhere, every figure is derived from these rows, and nothing in the
-- codebase rewrites one. A `delete` here would make the balance right and the
-- history a lie — the audit log would still show two transfers filed by a named
-- person against rows that no longer exist. So each row gets a mirror: same
-- tenant, same currency, same provider, `-amount`, and a `provider_ref` naming
-- the row it cancels.
--
-- Idempotent by that reference: re-running inserts nothing, because the
-- correction for a row is found by the ref that names it. It also cannot reach
-- anything else — the two ids are written out, so a legitimate transfer filed
-- later is untouched by a re-run, as are the NGN `hold` and `provider_fee`
-- entries from the deal that funded at 09:56 the same morning.
--
-- The door these came through is closed in the same change: the Overview card,
-- both API declarations and `POST /balance/external-transfers` are gone. The
-- entry type, `record_external_transfer` and its tests stay — `cross_rail_offset`
-- and `cross_rail_payout` are written by the system against facts it can check,
-- and they share this bucket.
--
-- Safe to re-run.

insert into ledger (tenant_id, deal_id, entry_type, amount, currency, provider, provider_ref)
select
  l.tenant_id,
  null,
  'external_transfer'::ledger_entry_type,
  -l.amount,
  l.currency,
  l.provider,
  'correction:' || l.id
from ledger l
where l.id in (
    'f0a2d413-cc7e-491e-b480-40a1ae8b8766',  -- flutterwave GHS, ref "3932"
    'c741dc76-0758-4da1-8eec-73e0c705a583'   -- paypal GHS, a balance that rail cannot hold
  )
  and not exists (
    select 1 from ledger c where c.provider_ref = 'correction:' || l.id
  );

-- The audit log is where "who did what" lives, and a correction that appears
-- only as two more ledger rows would read, later, as two more transfers. One
-- row per entry reversed, attributed to the migration rather than to a person,
-- because nobody decided this at a screen.
--
-- Deliberately flat SQL — no aggregate, no grouping. This migration cannot be
-- rehearsed anywhere (there is no local database here and a dry run against
-- production is a write), so the less it does per statement the less there is
-- to be wrong about it unseen. Idempotent per row on the entry id it names.

insert into audit_log (tenant_id, deal_id, actor, action, details)
select
  l.tenant_id,
  null,
  'system:migration',
  'ledger.external_transfer_reversed',
  jsonb_build_object(
    'entry_id', l.id,
    'provider', l.provider,
    'currency', l.currency,
    'amount', l.amount,
    'reason', 'Filed by hand through the Overview card and describing no movement of money. '
           || 'Left in expected() these would have frozen this account''s payouts at the '
           || 'first reconciliation pass.'
  )
from ledger l
where l.id in (
    'f0a2d413-cc7e-491e-b480-40a1ae8b8766',
    'c741dc76-0758-4da1-8eec-73e0c705a583'
  )
  and exists (
    select 1 from ledger c where c.provider_ref = 'correction:' || l.id
  )
  and not exists (
    select 1 from audit_log a
     where a.action = 'ledger.external_transfer_reversed'
       and a.details ->> 'entry_id' = l.id::text
  );
