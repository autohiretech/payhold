# PayHold V2 — execution plan

Bringing the built system up to the Manus AI handoff specification
("PayHold Marketplace Payments Platform", 17 sections).

**Status:** phases 0–9 and 11 done; 10 partly done (2026-08-08). Phases execute one at a time, on request.

Phase 11 landing before 8, 9 and 10 finished is not an ordering mistake: the
gate it builds ships **shut**, and the work those phases still owed is on it as
blockers nobody can sign off. Clearing one is a row, changed by the phase that
does the work — Phase 8 cleared `dispute_window` that way, in its own migration.
Only `operator_screens` (Phase 10) and `email_confirmation` remain.

## Decisions taken before planning

| Question | Decision |
|---|---|
| Source of truth | The new document **replaces** `PayHold_Standalone_Spec_V1.docx`. Sections of the old spec with no equivalent in the new one (Intelligence §12, the deterministic risk rules, request context, the language rule) are **carried forward into the new spec** rather than deleted — they describe code that is already shipped and running. |
| Partial refunds | **Adopted.** Overrides the recorded v1 "all-or-nothing" decision. |
| Rail scope | Capability matrix made data-driven, `StripeProvider` built, PayPal / Venmo / Cash App Pay / Alipay / WeChat Pay / China partner **declared as capabilities but disabled** — no unapproved rail ships live. |
| Naming | Stays `deal`. The spec's `order` is recorded as a synonym; `/v1/deals` does not move. |

## Two things the new document does not change

**The language rule holds.** The document's own §1 says the system "must not be
described as legal escrow", and §17 lists pooled funds represented as customer
escrow as a non-goal. Its title uses the word; our code, UI and comments still
must not. The only places it may legitimately appear are the rule itself, the
tests that enforce it, and the prompt that forbids it to the model — `ai.test.ts`
and `anthropic.ts`. Any other hit is a bug.

**Release still needs both sides.** The document's lifecycle releases on buyer
acceptance alone. Invariant 5 — the `SELECT ... FOR UPDATE` around the
both-confirmations check — is what makes double-release impossible, and it is
load-bearing. The document's states map onto ours instead of replacing them:
its `delivered` is our seller confirmation, its `confirmed_buyer` is our buyer
confirmation, and `clearing` becomes a real state between the two and release.
This divergence gets written into the spec, not left implicit.

---

## Phase 0 — Spec reconciliation ✅ done 2026-08-07

No code. Everything downstream cites the result, so it goes first.

1. Extract the text of `PayHold_Standalone_Spec_V1.docx` and diff its sections
   against the new document. Identify what exists only in the old one.
2. Write `PayHold_Spec_V2.md` at the repo root: the new document's §1–§17
   verbatim in structure, plus carried-forward sections for Intelligence, the
   deterministic risk rules, `request_context`, and the language rule.
3. Record the three standing divergences in the spec itself: `deal` vs `order`,
   both-confirm release, unapproved rails declared-but-disabled.
4. Delete `PayHold_Standalone_Spec_V1.docx`.
5. Rewrite root `CLAUDE.md` to point at the V2 spec, and correct the paragraph
   that declares refunds all-or-nothing.

**Acceptance:** `CLAUDE.md` and the spec agree on every point they both cover.
No section of the old spec is lost without a line saying it was dropped and why.

---

## Phase 1 — Lifecycle expansion ✅ done 2026-08-07

Landed as planned, with four departures worth recording:

- **Ten enum values, not twelve.** §6's `delivered` and `buyer_review` both name
  the window `confirmed_seller` already covers. Synonyms would give one event
  two spellings; the wire keeps both names, the schema does not. Spec §29.1.
- **The event rename is breaking**, which the plan called free. There is no
  per-event subscription, so emitting the V1 and V2 names together doubles every
  client's delivery volume instead of easing a migration. One event per
  transition, renamed once, before live traffic. Spec §29.2 corrected.
- **`clearing -> disputed` opened a payout hole.** V1 could only dispute a held
  deal, so no payout row existed yet; a chargeback during the clearance window
  arrives when one is already scheduled and nothing was stopping it.
  `settle_payout` now refuses a disputed deal under the row lock and
  `dispatchPayout` skips it early. `released_at_matches_status` had to exempt
  `disputed` for the same reason. Both found by the new tests, not by review.
- **`payment_failed -> funded_held` had to be legal.** An async rail can report
  a failure and then settle; refusing it would leave money at the provider with
  no deal willing to admit it arrived.

Six states ship declared with no writer — `checkout_started` (Phase 7),
`partially_refunded` (permanently, see Phase 3 and §29.8), and `in_progress` /
`revision_requested` / `expired` / `canceled` (an endpoint each). `auto-release` and its index filter
on the three original holding states and must be widened by whoever gives the
first two a writer.

Tests: 179 SQL (was 154), 99 Deno, 248 dashboard (was 242).

<details><summary>Original plan for this phase</summary>

The document's §6 state machine, 17 states against our 8. Everything else in
the plan hangs off this, so it lands second.

- New migration adding to `deal_status`: `checkout_started`, `payment_pending`,
  `payment_failed`, `expired`, `canceled`, `in_progress`, `delivered`,
  `buyer_review`, `revision_requested`, `clearing`, `partially_refunded`,
  `payout_pending`.
- **Hazard:** Postgres will not let a migration use an enum value it added in
  the same transaction. This is two migrations — one that adds the values, one
  that uses them — and the PGlite harness must exercise both in order.
- `assert_deal_transition(from, to)` in SQL, called by every money function, so
  an illegal transition fails loudly rather than writing a state nobody expects.
- `completion_policy` on `deals` (`completion_event`, `auto_complete_after_hours`,
  `clearing_days`) per the document's §14 example — today these are tenant
  settings only, and the document wants them per order.
- Webhook event names move to the document's §10.2 vocabulary
  (`order.funded_held`, `order.delivered`, `order.accepted`,
  `order.clearing_started`, `order.released`, …) in `emit_deal_event`.

**Files:** new migrations, `_shared/types.ts`, `functions/deals/index.ts`,
mock `engine.ts` + `types.ts`, `DealDetail.tsx`, `Deals.tsx`.

**Acceptance:** every transition and alternative path in the document's §6 is
exercised in `src/api/mock/engine.test.ts` and mirrored in a new
`tests/lifecycle.test.ts`. Illegal transitions are rejected under lock.

</details>

---

## Phase 2 — Fees, tax, reserve, and the price breakdown ✅ done 2026-08-07

Delivered as planned, plus two defects found by doing it:

- **The platform fee was making reconciliation lie.** `expected` was `held +
  pending + available`, and the fee is a debit in the clearing pool — but
  nothing sweeps our commission out of the tenant's provider balance under
  bring-your-own-keys. Every released deal drifted by exactly the fee, and drift
  freezes payouts automatically. Fixed with the `fees_retained` bucket; the
  sandbox walkthrough would have hit this on its first deal.
- **Phase 1 left two `fund_deal`s.** `create or replace` cannot change a
  signature — it adds a sibling. The six-argument version written in Phase 1
  never replaced the real nine-argument one, the webhook kept calling the
  original, and the tests passed because they were exercising the unused
  function. Corrected in place, and pinned by a test asserting exactly one
  `fund_deal` exists.
- **The mock's reconciliation could not have caught either.**
  `providerReportedBalance` returned our own expected figure plus injected
  drift, so the comparison agreed with itself by construction. It is now derived
  from entries that genuinely crossed the provider boundary.

Reserve is implemented as §6.1's "additional days": the extra time is on
`payout_due_at`, and the reserve bucket makes the amount unpayable and visible
while it runs, ending exactly when the payout comes due. A reserve outliving the
payout would need a second transfer per deal, which `payouts_deal_key` exists to
prevent.

Tests: 192 SQL (was 180), 99 Deno, 253 dashboard (was 248).

<details><summary>Original plan for this phase</summary>

Document §7: the ledger must keep buyer-paid, seller gross, platform fee,
provider fee, tax, reserve, refund amount and payout amount as separate values.
We currently keep four of those eight.

- `ledger_entry_type` gains `provider_fee`, `tax`, `reserve`, `reserve_release`.
- A `deal_amounts` view deriving the full breakdown off the ledger — derived,
  never stored, same rule as tenant balances.
- `GET /v1/deals/:id` returns the breakdown; the hosted pay page shows it
  **before** payment, which §7 requires.
- `reserve` becomes its own bucket in `rail_balances`, not part of `available`.

**Acceptance:** the breakdown sums to buyer-paid for every deal in the mock
seed; a reserved amount is invisible to `available` and therefore unpayable.

</details>

---

## Phase 3 — Partial and line-item refunds ✅ done 2026-08-07

Delivered, including the AI half. Four things worth recording:

- **`partially_refunded` is declared and never written** — spec §29.8. It is an
  amount, not a lifecycle position: a deal refunded by a third still has to be
  delivered, cleared and paid out for the other two thirds, and a status saying
  otherwise puts it outside `HOLDING_STATUSES` and makes the payout path
  unreachable. This is a deliberate divergence from §6 and the one place Phase 3
  did not follow the document literally.
- **§7.1.3 needed a positive `release` entry.** `held` is `hold + release +
  refund`; after a release the hold is already cancelled, so booking only the
  refund drives it negative. Put it back, then take it out.
- **§7.1.4's "use reserves where available" is unreachable** and the code says
  so rather than carrying a dead branch: a reserve ends at `payout_due_at` and a
  payout cannot precede it, so a paid-out deal never has one.
- **`release_deal` had to stop releasing the original amount.** A pre-release
  partial refund means less is held; releasing `presentment_amount` would let
  out money that is not there.

Tests: 216 SQL (was 192), 99 Deno, 256 dashboard (was 253).

<details><summary>Original plan for this phase</summary>

The largest single change, and the one that overrides a recorded decision.

- `refund_deal(p_deal, p_reason)` becomes
  `refund_deal(p_deal, p_amount, p_reason, p_line_items jsonb)`. A null amount
  means full, so the existing call site keeps its meaning.
- The document's §7.1 ordering, implemented as four distinct paths:
  1. pre-capture → void the authorization;
  2. post-capture, pre-release → refund through the original provider;
  3. post-release, pre-payout → reverse the seller payable, then refund;
  4. post-payout → create a receivable from the seller, draw on reserve,
     escalate to support if insufficient.
- Cumulative guard: `sum(refunds) <= buyer_paid`, checked under the same row
  lock that guards release. This is the invariant that makes partials safe.
- `partially_refunded` state wired to the Phase 1 transition guard.
- Provider interface declares `supportsPartialRefund` and `supportsAsyncRefund`
  — §7.1.6 is explicit that Alipay and WeChat Pay refund asynchronously, up to
  90 days out, and that no method may be promised identical refund timing.
- **Intelligence follows:** the dispute assistant's output schema gains
  `partial_refund` with an amount, replacing the `escalate`-only compromise.
  `decide_ai_suggestion` gains the bridge for it — still locked, still requiring
  a named approver. Invariant 9 is untouched: the model drafts an amount, a
  person's approval is what writes it.

**Acceptance:** a refund at each of the four lifecycle points; a double refund
is a no-op; the cumulative guard holds under concurrent calls; `ai.test.ts`
still finds the regulated word in no prompt and no output.

</details>

---

## Phase 4 — Seller onboarding and KYC ✅ done 2026-08-07

Delivered, with two design calls worth recording:

- **The eligibility gate runs outside `risk_rules_enabled`.** The plan did not
  say where to put it, and putting it with the discretionary rules would have
  meant a tenant could switch off KYC enforcement by switching off the risk
  rules. Eligibility runs first and unconditionally; the setting governs only
  what follows.
- **Destinations moved to `seller_destinations`, but the seller row keeps a
  copy.** Fifty call sites read `sellers.beneficiary_token`, and moving them all
  belongs with the routing engine that will actually use the table. A trigger is
  the single writer of the copy, so the two cannot drift, and two more triggers
  make the invariants structural: a seller insert creates their primary
  destination, and a destination change stamps `destination_changed_at`.

Pre-V2 sellers are grandfathered as verified by the migration. That is a
decision, not a default: nothing here has ever taken live money, so there is no
unverified seller to catch, and leaving them `pending` would hold every payout
in every fixture for a fact untrue of them.

Tests: 232 SQL (was 216), 99 Deno, 257 dashboard (was 256).

<details><summary>Original plan for this phase</summary>

Document §12: a seller must not receive a payout solely because a payment
webhook said "success." Today `sellers` has no KYC state at all.

- `sellers` gains `kyc_status` (`pending | verified | restricted | rejected |
  review_required`), `external_user_id`, `sanctions_checked_at`,
  `beneficial_owners jsonb`.
- New `seller_destinations` table — many per seller, with `is_primary`,
  `is_backup`, `verified_at`, `security_hold_until`, tokenized destination.
  This is what makes §5.1's backup route possible; one column cannot.
- Change protection: a newly added destination sets `security_hold_until` and
  is refused until it expires and ownership is re-checked.
- `GET /v1/sellers/:id/capabilities`.
- `screen_payout` extends to re-check KYC, sanctions, negative balance, open
  disputes, reserve and provider capability — the document's §12 payout-worker
  list. It still may only **hold**; invariant 11 is unchanged.

**Acceptance:** the document's §15 phase 5 — unverified sellers cannot receive
payouts, and a fresh destination is held for review.

</details>

---

## Phase 5 — Payout Preferences and Routing Center ✅ done 2026-08-07

Delivered, with four things worth recording — two of them defects the phase
found rather than features it added.

- **The eligibility gate was approvable, and should never have been.** Phase 4
  put §12's checks above `screen_payout`'s discretionary rules but left them
  producing `held_for_review`, which meant "we have never verified this seller"
  sat in the same operator queue as "this payout is unusually large" and the
  same button cleared both. §12's sentence says that must not be possible. It
  now produces `needs_verification`, which `approve_payout_review` refuses; the
  way out is `verify_seller`, an attestation with a name on it.
- **An earlier approval skipped the gate entirely.** `screen_payout` returned
  early on `review_approved_at` — correct while everything below that line was
  a rule, and wrong the moment the unconditional gate landed above it. A seller
  whose verification was revoked after an approval would have been paid. The
  short-circuit now covers only the discretionary rules.
- **§5.1's seven display states are six stored and two derived**, spec §29.9.
  `clearing` and `available` are questions about the *deal's* window; storing
  them on the payout would give one fact two writers. `payout_display_status()`
  derives them.
- **A route is never a fallback for another route**, spec §29.10. §5.1's
  "highest-ranked eligible fallback" cannot mean a different rail for the same
  destination, because a destination is a token minted for one rail — that would
  be the silent redirection the same section forbids. The fallback is the
  seller's *backup destination*, gated on a failed primary, an explicit policy
  check and a notification.

Two smaller notes. `route_payout` writes a decision only when the outcome
*changes*, because `blocked` is re-screened every pass and an unconditional
insert would bury the row that explains something under identical copies of
itself; the same de-duplication now guards the `not_eligible` risk signal, which
§24.3 says cannot be backfilled. And the five declared-but-disabled rails ship
with `provider = null` plus a `route_needs_an_adapter` check, so "declared but
disabled" is enforced by the database rather than by whoever reviews the diff.

**Automatic retry with backoff is Phase 9's**, not this one's. Phase 5 provides
the backup *selection* when a retry happens; today that retry is a person
pressing the button.

Tests: 260 SQL (was 232), 99 Deno, 282 dashboard (was 257).

<details><summary>Original plan for this phase</summary>

Document §5.1 and §5.2. A subsystem that does not exist today.

- `payout_routes` table, per tenant: provider, method, countries, currencies,
  `supports_payouts`, `enabled`, rank. **Data, not code** — this is the
  mechanism for §12's "a country can be disabled without redeploying."
- `choose_payout_route(payout)` in SQL: deterministic, returns a route or
  `no_route` with a reason code, filtering exactly as §5.1's sketch does.
- `payout_decisions` table recording selected provider, method, eligibility
  checks, ranking score, currency, fees, FX source and reason code — §5.1
  requires the decision be auditable after the fact.
- Payout statuses extend to the document's seven display states: `clearing`,
  `available`, `processing`, `paid`, `failed`, `blocked`, `needs_verification`.
- No-route behaviour: hold the amount, notify the seller, request a destination.
  Never reroute silently — §5.1 is emphatic and so is invariant 11.
- Backup destination used only after a primary failure, an explicit policy
  check, and a logged notification.

**Acceptance:** all eight cases in §5.2, each its own test — including the
Venmo-outside-the-US ineligibility message and the disabled-provider case that
must work without a redeploy.

</details>

---

## Phase 6 — Capability matrix and StripeProvider

- `provider_capabilities` and `payment_routes` tables — the **collection** side
  of what Phase 5 built for payouts. The generated country registry stays
  generated; **enablement** moves out of `countries.ts` and into data, because
  §12 requires disabling a country without shipping code.
- `PaymentProvider` grows the document's §9 surface: `createCheckout`,
  `verifyPayment`, `createSellerAccount`, `updateSellerAccount`, `getPayout`,
  `reconcile` — and declares the §9 capability flags rather than letting any
  caller guess.
- **`StripeProvider` built**: PaymentIntents with manual capture for deposits,
  Radar on, Connect for marketplace payouts, 3DS never silently downgraded.
- `stripe-webhook` function, following `flutterwave-webhook` exactly.
- `paypal`, `cash_app_pay`, `china_wallet_partner` registered as capability rows
  with `enabled = false` and no implementation. `loadProvider` throws for them,
  loudly — the same choice already made for Stripe, for the same reason. Their
  **payout** rows already exist, from Phase 5.
- `/v1/payment-options` reads the matrix instead of the code.

**Acceptance:** disabling a country in data removes it from both checkout and
payout selection with no redeploy; a provider outage disables only its own
routes; §15 phase 3's "documents unsupported combinations" holds.

---

## Phase 7 — Checkout sessions

- `checkout_sessions` table; `POST /v1/checkout/sessions`,
  `GET /v1/checkout/sessions/{id}`. The hosted `/pay/:id` page becomes
  session-backed, and `checkout.completed` joins the event vocabulary.

**Acceptance:** §15 phase 2 — a test payment cannot be marked successful
without a verified provider event. This already holds; the session object must
not become a way around it.

---

## Phase 8 — Resolution Center ✅ done 2026-08-08

Delivered: `20260807000016_resolution_types.sql` and `20260807000017`, the
`disputes` Edge Function, `src/api/mock/resolution.ts`, and
`dispute-assistant@2`. Four things worth recording, and the third is a
**deliberate narrowing of a bullet below**.

- **Silence lapses a request; it never accepts one.** §8 allows an unanswered
  request to be "auto-resolved by platform rule", and the rule here is that at
  48 hours the offer expires and the dispute stays open. The other reading —
  silence accepts — would make a clock the thing that refunds a buyer or pays a
  seller, which is a machine deciding, and invariants 9 and 11 both forbid it.
  §15 phase 4 is satisfied by the *window* closing without a human, which it
  does; a test asserts that nothing moved when it did. `expired` is a separate
  status from `declined` for the §24.3 reason: declining is an act, and the
  difference cannot be backfilled.

- **Conflict of interest is enforced on who acted, not on who someone is.** The
  obvious implementation — join the deciding administrator to the buyer or the
  seller — cannot be written, and that is structural rather than an oversight:
  PayHold stores no buyer PII (`buyer_ref` is the client's own opaque string)
  and a seller has no login. There is no identity to join to. What the
  Resolution Center does record is who did what, so the rule is that whoever
  raised the dispute, made a request or answered one cannot be named as its
  decider. `both-parties` is the one reserved name that may have acted — it is
  what an agreement between the two sides is recorded as, and refusing it would
  make agreement unexecutable.

- **`disputed_amount` bounds the resolution; it does not split the payout.**
  The bullet below asks for release and payout to freeze for the disputed amount
  only. The ledger can separate it — Phase 3 saw to that — but
  `payouts_deal_key` allows exactly one payout row per deal, so paying the
  undisputed two thirds now consumes it, and a dispute later resolved in the
  seller's favour would have nothing left to send the last third with. So the
  amount is enforced where it can be enforced honestly: `resolve_dispute`
  refuses to take more from the seller than was ever in dispute, and a complaint
  about a third cannot quietly become a full refund. The payout freeze stays
  whole while a dispute is open. **Splitting a payout is a real change** — a
  second payout row, its own idempotency key, its own line in reconciliation —
  and it belongs in a phase that can carry it. Anyone signing §16's
  `dispute_window` should read this paragraph first.

- **The expiry pass runs from `auto-release`, not a cron of its own.** Both are
  the same shape — a clock ran out — and this one moves no money and touches no
  deal, so it is safe beside the release timer and wrong to give any more power
  than that. Its failure is logged and swallowed: a deal whose window came due
  should not wait on an unanswered offer somewhere else.

Two notes on landing it beside the other phases:

- The migrations were **renumbered from 13/14 to 16/17** after Phase 9's
  `reconciliation_runs` and `payout_retry` took the same version numbers. Two
  files sharing a version prefix is not merely untidy — `supabase_migrations`
  keys on it, so one of the pair would have been recorded and the other silently
  skipped against the live project.
- That renumbering put the Resolution Center *after* Phase 11's gate, which
  computes `blocked_by` from `to_regclass` at migration time and had therefore
  already recorded `dispute_window` as blocked. `20260807000017` clears it,
  which is exactly the contract `20260807000015` states: the phase that builds
  the thing clears its own blocker. It clears the blocker and does **not** sign
  the item off — whether the behaviour is right is a person's judgement.

Tests: 414 SQL (was 380), 34 new in `resolution-center.test.ts`; 395 dashboard
(was 363), 32 new in `resolution.test.ts`. 115 Deno, unchanged.

<details><summary>Original plan for this phase</summary>

- `dispute_offers`: kind (`update | extension | cancellation | partial_refund |
  full_refund`), amount, `expires_at` at 48 hours, status. Auto-resolution on
  expiry per the platform rule.
- `dispute_evidence`: uploads, photo descriptions, uploaded_by.
- Structured `reason_code` enum; timeline view; communication export.
- One open request per deal at a time — §8 is explicit that a new dispute cannot
  open while another request for the same order is open. We have the unique
  index for disputes; offers need the same.
- Conflict-of-interest control: an administrator who is a party cannot decide.
- A dispute freezes release and payout for **the disputed amount only**, now
  that Phase 3 lets the ledger separate it.
- Bumps the dispute assistant to `dispute-assistant@2` — it can finally read
  evidence, which is what §12.2 always said it did.

**Acceptance:** §15 phase 4 — funds cannot be released while a dispute or payout
block is active; the 48-hour window resolves without a human.

</details>

---

## Phase 9 — Reconciliation runs and failure handling ✅ done 2026-08-08

Delivered, with four things worth recording — two of them decisions about what a
column is allowed to claim, and one a defect the phase introduced and caught.

- **`missing` counts the inbox, not a transaction-export diff**, spec §29.14.
  §13 asks for provider *exports* compared against the ledger, and no adapter
  has a transaction-listing call — `PaymentProvider` exposes `balances()` and
  nothing that enumerates. Building one would mean `FakeProvider` answering from
  fixtures while every real rail reported zero discrepancies, which is a control
  that looks authoritative and checks nothing. So `missing` is verified inbound
  events with no `processed_at`: the arrears half of §13's own inbox design, and
  a smaller claim that is true. `skipped` exists for the same reason — a rail we
  could not reach is not a clean rail, so a run with any of them reports
  `incomplete` rather than `clean`.
- **A spent retry budget is `blocked` with no clock**, spec §29.15. There is no
  `payout_blocked` status and adding one would have been a second spelling of
  `blocked`; the problem is that `blocked` is *dispatchable*, because §5.1's
  no-route case must be re-asked every pass. `payouts.next_attempt_at` carries
  the backoff and **null means no machine may attempt this again** — the cron
  filters `<= now()`, the approve and retry endpoints go through the same shared
  `dispatchPayout`, and a person is not a machine.
- **Automatic retry made two dormant bugs reachable**, and both are fixed here.
  `mark_payout_processing` refused `failed`, so a second attempt on an async rail
  would have raised rather than polled — nothing had reached it because the only
  retry was a person on a synchronous rail. And `refund_deal` cancels a scheduled
  payout by writing `status = 'failed'` directly, which was inert while `failed`
  was undispatchable and is a transfer nobody is owed once it is not;
  `payouts_stop_retrying` clears the clock on any payout written while its deal
  is refunded, canceled or expired, by trigger, for the reason
  `deals_assert_transition` is a trigger.
- **`found` reflects the last statement, not the last `select into`.** The run
  counter `update` went in between `record_reconciliation`'s alert lookup and its
  `if found`, which silently turned "no open alert" into "there is one" — so a
  first mismatch updated a null row and never inserted the case. Every existing
  reconciliation test still passed, because they all call the function without a
  run id. It tests `a.id is not null` now.

Two smaller notes. `record_reconciliation` gained a parameter and so was dropped
and recreated by argument list, with its revokes reissued — the trap `fund_deal`
and `seller_capabilities` already carry, pinned by a `pg_proc` count. And
`resolve_reconciliation_run` is now the one place a payout freeze is lifted:
named, audited, refused while any case on the tenant is still open, and behind a
separate argument, because writing down what happened and declaring the money
accounted for are two different claims. Nothing about it runs on a timer, so
"nothing unfreezes automatically" is intact.

§15 phase 6's acceptance is covered in `tests/funding.test.ts`: a success after a
failure books one hold, a stale failure cannot unwind one (the transition guard
refuses the edge), a redelivery after release re-holds nothing, a second
*different* payment for a released deal is refused, and a webhook that never
arrives leaves an empty ledger and a deal still at `payment_pending`.

Tests: +43 SQL (22 reconciliation runs, 16 payout retry, 5 inbox ordering),
115 Deno unchanged, +23 dashboard (11 reconciliation runs, 12 payout retry).

<details><summary>Original plan for this phase</summary>

Document §13. We have the daily job and the freeze; we do not have the run
record the document's data model asks for.

- `reconciliation_runs`: provider, period, matched, missing, mismatched,
  resolution status — alongside the existing `reconciliation_alerts`.
- Mismatch produces a case and never silently alters a balance. Already true;
  this makes it structural.
- Payout retry with capped exponential backoff, then `payout_blocked` for an
  operator. Reuses the webhook-delivery backoff shape.

**Acceptance:** §15 phase 6 — duplicate, out-of-order and missing webhooks do
not double-post money. Existing inbox tests extend to cover ordering.

</details>

---

## Phase 10 — Dashboard ◐ partly done 2026-08-08

The mock is the acceptance spec, so it keeps parity phase by phase rather than
catching up here. This phase is the screens themselves:

- ✅ `DealDetail` — the full lifecycle and the §7 price breakdown.
- ✅ New **Routing Center** screen — destinations, eligibility, routing decisions
  with their reason codes.
- ✅ Seller KYC state on `SellerDetail` and `Sellers`.
- ⬜ **Resolution Center** replacing the current `Disputes` screen.
- ◐ Checkout sessions and reconciliation runs on `Admin` / `Audit`.

**The two that did not land are blocked on the same thing, and it is worth
recording rather than retrying.** This phase assumes mock parity — its own first
sentence says so — and Phases 8 and 9 landed **backend-only**. There is no
`dispute_offers`, no structured `reason_code` and no `reconciliation_runs` in
`src/api/mock/`, so a Resolution Center or a runs table here would either render
nothing or invent semantics the migrations already fixed. Mirroring
`20260807000013/14` into the mock is Phase 8's and Phase 9's dashboard half, not
this one's, and it has to happen before these two screens can be honest.

### What landed

The seam grew five reads and one write, because screens can only render what the
contract exposes and §7's breakdown, the refund records, the destinations and
the session list were all engine-internal: `getDealAmounts`, `listRefunds`,
`listCheckoutSessions`, `listSellerDestinations`, `getSellerCapabilities` and
`verifySeller`. Four of them are reads `payhold-backend` does not serve yet —
listed in its *Not built yet*, each a select over a table that already exists.

Four departures worth recording:

- **The hosted checkout moved to `/pay/:token`.** This was a correctness fix
  wearing a refactor's clothes: the old page called `getDeal`, which is
  tenant-scoped and needs an API key, and it only ever worked because the mock
  runs in the same browser as the dashboard. Two capabilities went with it — the
  method list now comes from the server's capability matrix rather than from
  `collectionRails`, and the buyer can no longer switch market, because a session
  is one payment at one amount and re-pricing in the browser would quote a figure
  nothing agreed to.
- **`SellerDetail` carries an action now**, against its own header comment, and
  the comment was corrected rather than the code. Clearing a payout hold stays on
  Payouts because a hold is a question about one payment; attesting to a seller's
  identity is a fact about the seller, §12 requires a person to record it, and
  there is nowhere else it could live.
- **`routeReasonText` moved from `api/mock/routing.ts` to `lib/rails.ts`.** Both
  sides of the seam need it — the engine writes it onto `failure_reason`, the
  Routing Center turns a *stored* code back into the same sentence — and a screen
  importing it from the mock would have worked until the mock went away.
- **Payouts stopped hardcoding its approver.** `const ME = 'grace@autohire.rw'`
  predated real auth; the approval and the new attestation both take the name
  from the session, since a caller that can name its own approver can name
  somebody who was not there.

Tests: 317 dashboard (was 307), the ten new ones in `onboarding.test.ts`.

---

## Phase 11 — Launch gate ✅ done 2026-08-08

Delivered, and it ships with the gate **shut** — which is the point rather than
an incomplete state. Four things worth recording.

- **The checklist is rows, and the gate is the only thing that reads them.**
  §16 is fourteen named items plus one written payout confirmation per launch
  market, and a checklist nobody is forced to consult is a document. This one is
  wired to the thing it is about: `POST /provider-accounts` refuses
  `mode: "live"` while any required item is outstanding, which is §16's "the
  production release begins in test mode" and §15 phase 8's "live keys remain
  disabled until approval", enforced rather than remembered. One check, because
  there is exactly one writer of `tenant_provider_accounts` — and a test asserts
  that stays true.
- **Running this phase out of order is safe because unbuilt work is
  unsignable.** Engineering items carry `blocked_by`, and a check constraint
  refuses to sign a blocked one whatever the caller's authority. Signing off
  every attestation today still leaves the gate shut on `operator_screens` and
  `email_confirmation`, which is the honest answer.

  **The three blockers that could be checked are checked, at seed time.** Phases
  8 and 9 landed *while this migration was being written*, and a hand-written
  "phase 8 is missing" would have shipped a lie the same afternoon; `to_regclass`
  and `to_regprocedure` make the seed correct whether it runs before or after
  the phase that clears it. Existence is a proxy for the work being done, which
  is why a person still signs it with evidence — what existence rules out is
  signing something that cannot possibly work.
- **§17's audit found one real hole, and it was the one held up by habit
  alone.** `settle_payout` takes a provider reference and every caller passed
  one, but the parameter was nullable — so `update payouts set status = 'paid'`
  run by hand was a mark-as-paid control with no provider on the other end of
  it: the seller recorded as paid, `payouts_deal_key` refusing a second payout,
  and reconciliation reporting drift for money that never left.
  `paid_needs_a_provider_reference` is a constraint rather than a guard inside
  the function, because §17 says *anywhere* and a guard binds only the callers
  we know about. Two existing fixtures had to gain a reference; both were
  describing payouts that could not have existed.

  The other six non-goals were already refused by something structural — an
  unbuilt adapter that cannot be enabled, the eligibility gate, `implemented`
  on the capability row, a not-null `tenant_id` on every credential and every
  ledger entry. `tests/launch-gate.test.ts` pins each one where it actually
  binds, rather than restating the prohibition.
- **`rails_verified` stopped being a constant.** It was `false` in TypeScript
  with a comment promising somebody would change it one day; it is now derived
  from the per-market confirmation items, asked per country on the payout
  branch and across all four elsewhere. A market with no confirmation item is
  unverified, which is the right answer for every country outside §16's four.

`scripts/sandbox-walkthrough.md` is §28's gate written out in order — the money
path, a forged webhook, the way in, the V2 paths, the scheduled jobs — with each
part naming the checklist item it signs off. It is deliberately not automated:
half of it is watching what happens on a provider's dashboard, and a script that
could green-light itself is the thing §16 exists to prevent.

Tests: 35 new SQL (`launch-gate.test.ts`), 24 new dashboard
(`api/mock/launch.test.ts`).

<details><summary>Original plan for this phase</summary>

- The document's §16 checklist and §17 non-goals, audited: no cryptocurrency,
  no anonymous payouts, no personal-account Venmo or Cash App, **no manual
  "mark as paid" control anywhere**, no unverified destinations, no pooled funds.
- The existing testing gate in `CLAUDE.md` — full sandbox walkthrough, forged
  webhook returns 401, cross-tenant session returns nothing — plus the new
  paths: partial refund, routing failure, backup destination, dispute window.
- Test mode first. Live keys stay disabled until §16 is signed off.

</details>

---

## Sequencing note

Phases 0–3 are a chain: the spec fixes the vocabulary, the lifecycle adds the
states, the breakdown adds the amounts, and partial refunds need all three.
Phases 4–5 are a second chain (KYC before routing). Phases 6–9 are largely
independent of each other and can reorder if something external — a merchant
account, a provider approval — arrives out of turn.

Phase 5 took the payout side of what Phase 6 planned for the capability matrix:
`payout_routes` is that table for sending, and the five unbuilt wallet rails are
already declared and disabled there. Phase 6 is now the **collection** side plus
`StripeProvider`, and `/v1/payment-options` reading data instead of code.

Nothing in phases 1–9 is safe to run against the live project without the
migration-by-hand discipline `payhold-backend/CLAUDE.md` already describes.
