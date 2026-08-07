# PayHold V2 — execution plan

Bringing the built system up to the Manus AI handoff specification
("PayHold Marketplace Payments Platform", 17 sections).

**Status:** phases 0–5 done (2026-08-07). Phases execute one at a time, on request.

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

## Phase 8 — Resolution Center

Document §8. `disputes` currently carries a reason and nothing else — the
backend `CLAUDE.md` already flags this as the next thing that improves a draft.

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

---

## Phase 9 — Reconciliation runs and failure handling

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

---

## Phase 10 — Dashboard

The mock is the acceptance spec, so it keeps parity phase by phase rather than
catching up here. This phase is the screens themselves:

- `DealDetail` — the full lifecycle and the §7 price breakdown.
- New **Routing Center** screen — destinations, eligibility, routing decisions
  with their reason codes.
- Seller KYC state on `SellerDetail` and `Sellers`.
- **Resolution Center** replacing the current `Disputes` screen.
- Checkout sessions and reconciliation runs on `Admin` / `Audit`.

---

## Phase 11 — Launch gate

- The document's §16 checklist and §17 non-goals, audited: no cryptocurrency,
  no anonymous payouts, no personal-account Venmo or Cash App, **no manual
  "mark as paid" control anywhere**, no unverified destinations, no pooled funds.
- The existing testing gate in `CLAUDE.md` — full sandbox walkthrough, forged
  webhook returns 401, cross-tenant session returns nothing — plus the new
  paths: partial refund, routing failure, backup destination, dispute window.
- Test mode first. Live keys stay disabled until §16 is signed off.

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
