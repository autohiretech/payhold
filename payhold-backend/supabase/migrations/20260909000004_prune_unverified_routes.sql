-- Prune 20260909000003's widening to the corridors the providers' own
-- documentation supports — read the same day, cited in the commit.
--
-- The widening was honest about what it was: "matches our registry", not
-- "verified against Stripe or Flutterwave", with the verification to follow.
-- It followed within the hour and a good part of the widening does not hold.
-- Leaving a corridor in this table that the provider does not document is a
-- claim `route_payout` will act on — it will route a payout there — and the
-- whole reason `rails_verified` exists is that nobody here asserts coverage
-- nobody checked. So: out, until the provider confirms it, per corridor.
--
-- Stripe Connect (`stripe_connect`):
--   * HR, LI, BR — not in Stripe's Express/Custom availability list. This
--     repository creates Express accounts (`_shared/stripe.ts`), so Standard-
--     only support is no support. Removed, with BRL (nothing else used it).
--   * JP, SG, MX — on the list, but Stripe's same-region rule applies: cross-
--     border transfers are self-serve only among the US, Canada, the UK, the
--     EEA and Switzerland; everywhere else the platform account must be in the
--     same country, or sales must enable it. The platform's own country is
--     recorded nowhere in this repository, so these three are a claim about a
--     fact nobody has written down. Removed, with JPY, SGD, MXN.
--   * The 14 eurozone additions and CH stay: EEA and Switzerland are inside the
--     self-serve group and on the Express list. AE and AU predate the widening
--     and are left as seeded, but the same region rule binds them — see the
--     note text below, which is corrected: Stripe does document African
--     payouts (Express/Custom availability for 18 African countries via
--     cross-border payouts), gated to "contact sales" or a US/GB platform on
--     Global Payouts. "Cannot reach" was stronger than the docs; "no self-serve
--     route" is what they say.
--
-- Flutterwave bank (`flutterwave_bank`):
--   * BJ CF CG GA GQ GW ML NE TD TG — no transfer guide exists for any of
--     them, and Flutterwave's currency table documents XOF for Côte d'Ivoire,
--     Senegal and Burkina Faso only, XAF for Cameroon only. "XOF means the CFA
--     zone" was this repository's inference, not the provider's statement.
--     Removed.
--   * MW — bank transfers documented as "not available by default … submit a
--     request". A route row says enabled; the account is not. Removed, with
--     MWK.
--   * SL — Flutterwave documents transfers in SLL. The widening added SLE
--     (the redenominated code the FX table prices). Sending SLE names a
--     currency the provider does not document. Removed, with SLE, until the
--     code question is settled with Flutterwave.
--   * BF stays: a bank-transfer guide exists.
--
-- Net of the day: Stripe +15 (eurozone 14, CH), Flutterwave bank +1 (BF).
-- Everything removed here can be re-added by the same one-line union the
-- moment a provider confirms it; the header of 20260909000003 explains the
-- shape. `rails_verified` remains false for every row regardless.

update payout_routes
   set countries  = array(select unnest(countries)  except select unnest(array['HR','LI','BR','JP','SG','MX']::country_code[])),
       currencies = array(select unnest(currencies) except select unnest(array['BRL','JPY','SGD','MXN']::currency_code[])),
       note = 'Stripe Connect payouts. No self-serve route to African destinations — Stripe documents them only via cross-border payouts on sales enablement or a US/GB platform on Global Payouts; the Flutterwave rails carry Africa here. Outside the US/CA/UK/EEA/CH group the platform account must be in the connected account''s own country.'
 where tenant_id is null and payout_provider = 'stripe_connect';

update payout_routes
   set countries  = array(select unnest(countries)  except select unnest(array['BJ','CF','CG','GA','GQ','GW','ML','NE','TD','TG','MW','SL']::country_code[])),
       currencies = array(select unnest(currencies) except select unnest(array['MWK','SLE']::currency_code[]))
 where tenant_id is null and payout_provider = 'flutterwave_bank';
