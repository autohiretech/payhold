-- PayHold — the demo rail is retired.
--
-- §12's demo mode let a tenant with no provider account run a full deal
-- lifecycle against `FakeProvider`: every guard applied, but the counterparty
-- was invented. That is gone. `loadProvider` now refuses an unconnected rail
-- ("connect it in Rails before taking payments") rather than answering with a
-- simulation, because a path that reports money moved when nothing moved is
-- worse than one that refuses — the same reasoning §9's declared-but-unbuilt
-- adapters already followed.
--
-- The capability row is turned off rather than deleted, and the `fake` enum
-- value stays: three deals, the ledger and several settled payouts in the test
-- corpus carry `provider = 'fake'`, and dropping the value would orphan rows
-- that describe real history. What changes is that nothing offers it, nothing
-- routes to it, and no class implements it.

update provider_capabilities
   set implemented = false,
       enabled     = false,
       note        = 'Retired. Payments are never simulated; an unconnected rail is refused instead.'
 where provider = 'fake';
