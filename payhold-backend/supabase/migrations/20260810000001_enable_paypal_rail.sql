-- PayPal becomes a rail a buyer can actually reach.
--
-- It has been `implemented = true, enabled = false` since the adapter landed,
-- which was correct then: the adapter existed but nothing routed to it, because
-- `rails.ts` emitted no `wallet` rail at all. `collectionRails` therefore never
-- returned wallet, `startCharge` refused it for every buyer on earth, and
-- `PayPalProvider.charge` was unreachable code with tests.
--
-- The rails table now carries a wallet rail on PayPal for every unrestricted
-- country, so this flag is the remaining thing standing between a buyer and the
-- adapter. Flipping it without the rail would have done nothing; flipping it
-- after is what switches the method on.
--
-- Collection only, deliberately. PayPal Payouts is a separate agreement with
-- its own corridors, and `payout_route` models none of them — a seller offered
-- a PayPal destination today would be offered somewhere nothing can send.

update provider_capabilities
   set enabled = true,
       note = 'Collection only. Buyers approve in their own PayPal account; '
              'payouts remain Flutterwave''s and Stripe''s.'
 where provider = 'paypal'
   and implemented;
