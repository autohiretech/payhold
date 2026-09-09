-- Burkina Faso comes back out of the payout table.
--
-- 20260909000003 added it on the strength of Flutterwave's own Burkina Faso
-- transfer guide, and the guide is real. The live rail is not: `/banks/BF`
-- errors, so there are no bank codes to render or to mint a beneficiary with,
-- and the momo transfer table names no Burkinabe network, so `momoBankCode`
-- refuses every wallet a host could type. Checked against production on
-- 2026-09-10 — every neighbour on the same call answered (CI 30 banks, SN 25,
-- RW 34, ET 21) and BF alone returned nothing.
--
-- So the corridor was advertised as payable and had no destination of either
-- kind behind it: a host in Ouagadougou was told they would be paid and given
-- nothing to be paid into. Documented and deliverable are different claims,
-- and the routing table is the one that has to mean deliverable.
--
-- XOF stays on the row — Côte d'Ivoire and Senegal are paid in it, and both
-- have bank lists and wallets.

update payout_routes
   set countries = array(
         select unnest(countries) except select unnest(array['BF']::country_code[])
       )
 where tenant_id is null and payout_provider = 'flutterwave_bank';
