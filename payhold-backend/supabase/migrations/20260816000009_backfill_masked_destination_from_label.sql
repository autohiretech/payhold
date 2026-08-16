-- `masked_destination` never used `label` to build itself, even on every
-- destination change since `20260809000001` started storing one. A seller
-- registered through Flutterwave's `MPS` rail — used for every Rwandan
-- destination, momo or bank, because it is the one rail that reaches Rwanda —
-- got `bank_name` back empty regardless of which they picked, and
-- `FlutterwaveProvider.tokenize()`'s own fallback, `'Mobile money'`, went into
-- storage whatever the seller actually chose. Found live: a seller's page
-- reading "Payout method: Bank transfer" beside "Destination: Mobile Money
-- •••• 0303" — each field honest about a different source, and the two
-- disagreeing with each other in front of an operator trying to pay someone.
--
-- `sellers/index.ts` is fixed (`_shared/seller-mask.ts`'s `withCallerLabel`)
-- so this stops happening for a destination stored or changed from today
-- onward. This backfills what is already sitting there: any row that already
-- carries a caller's `label` gets its `masked_destination` rebuilt from it,
-- keeping the provider's own masked digits — the part actually worth
-- trusting — and replacing only the guessed leading word.
--
-- Deliberately narrow. A row with no `label` (every seller's very first
-- destination, before today's fix to `CreateSellerInput`) has nothing here to
-- rebuild from and is left exactly as it was; it corrects itself the next
-- time that seller's destination changes, same as any other seller now would.
--
-- No `destination_changed_at` stamp: `sync_primary_destination` only stamps it
-- when `beneficiary_token` moves, and this touches `masked_destination` alone
-- — a seller's security hold does not restart over a label being repaired.
update seller_destinations
   set masked_destination = label || (regexp_match(masked_destination, '(\s*••••\s*\S+)\s*$'))[1]
 where label is not null
   and btrim(label) <> ''
   and masked_destination ~ '••••'
   and masked_destination is distinct from
       label || (regexp_match(masked_destination, '(\s*••••\s*\S+)\s*$'))[1];
