-- Flutterwave will pay a bank account in dollars, so the bank rail carries USD.
--
-- `20260910000008` built `cross_border_currencies` and deliberately left it
-- empty on every rail, because what stood between a host and a dollar payout
-- was never a schema — it was an answer from the provider. `payoutRoute`'s
-- foreign-currency branch had said the careful version since it was written:
-- Flutterwave can *hold* a foreign currency, but paying a third-party
-- beneficiary in one is a different capability from settling it to your own
-- account, "a route to confirm, not a promise".
--
-- **The account holder checked with Flutterwave and it is confirmed**, and
-- asked for it on 2026-09-10. This is the row that records who said so and
-- when, the same shape as `20260910000005` for PayPal.
--
-- Two changes, and either alone does nothing:
--
--   * **USD joins `currencies`.** That array is what says the rail supports a
--     currency at all, and `route_evaluation` intersects it with `countries`.
--     Without this the corridor does not exist for routing.
--   * **USD joins `cross_border_currencies`.** That is what `payableCurrencies`
--     reads to let a `local_currency_only` rail offer a currency that is not
--     the market's own. Without it USD would be carried and never offered.
--
-- **The wallet rail is untouched and must stay untouched.** There is no dollar
-- mobile money wallet to pay into; that is what the instrument is, not a gate
-- waiting on a provider. `flutterwave_momo` keeps an empty array permanently.
--
-- **What this does not widen.** No local currency becomes payable across a
-- border — a local-only rail is still reduced to the country's own currency
-- plus this array and nothing else, so a Kenyan bank account is still not
-- offered Rwandan francs. And no new market opens: USD reaches exactly the
-- countries `flutterwave_bank` already carries.
--
-- **The narrowing this may still need, stated rather than assumed.**
-- Flutterwave's bank coverage and their *USD* bank coverage are not guaranteed
-- to be the same list, and the confirmation given was general rather than
-- per-market. If a transfer is refused in a specific country, the fix is to
-- take that country out of this rail's USD reach rather than to pull USD
-- entirely — which today means splitting a `flutterwave_bank_usd` row for the
-- confirmed markets. Left as one row because a split nobody has evidence for
-- is a second row to keep in step for no gain.

update payout_routes
   set currencies = (
         select array_agg(distinct c order by c)
           from unnest(currencies || array['USD']::currency_code[]) as c
       ),
       cross_border_currencies = array['USD']::currency_code[],
       -- Appended, never replaced. The existing note carries corridor
       -- caveats somebody researched — the gated markets, Tanzania's
       -- business-registration rule — and a rewrite that dropped them to
       -- announce dollars would lose the more expensive half.
       note = note || ' Also pays in USD: the dollar corridor was confirmed '
              || 'with Flutterwave by the account holder on 2026-09-10, which '
              || 'is what cross_border_currencies records. A wallet cannot do '
              || 'this and never will — there is no dollar mobile money '
              || 'wallet to pay into.'
 where tenant_id is null
   and payout_provider = 'flutterwave_bank';
