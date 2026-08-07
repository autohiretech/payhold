# PayHold

Standalone payment-hold product. Independent backend + dashboard. AutoHire
(autohiretech.pages.dev) is tenant #1 — a client like any other, with no special
access. Rails: Flutterwave (launch) and Stripe (international cards).

Launch markets: **Rwanda, UAE, Mainland China, United States.**

Source of truth for requirements: `PayHold_Spec_V2.md`. This file is the working
summary — if the two disagree, the spec wins and this file gets fixed in the same
commit. V2 superseded `PayHold_Standalone_Spec_V1.docx` on 2026-08-07; the old
file is deleted and recoverable from git at `f15f5e7`.

**V2 is being executed in phases**, tracked in `PAYHOLD_V2_PLAN.md`. Where this
file describes something V2 changes but the code has not caught up yet, it says
so and names the phase. A section with no such note describes what is built.

## Language rule (non-negotiable)

Never write the word **escrow** in anything user-facing, public, or
marketing-adjacent — it is a regulated term. Use **"payment hold"** or
**"buyer protection"**. Internal code comments and variable names should follow
the same habit so nothing leaks by copy-paste.

## Layout

```
PayHold/
├── payhold-backend/     Supabase project mwnbjjlilqrwdmwutbxr — schema, money
│                        engine, 19 Edge Functions and 4 cron jobs built ✅
└── payhold-dashboard/   React + Vite + Tailwind on Cloudflare Pages  ✅
```

One repository, two deploy targets, independent of each other:

| | Where | How |
|---|---|---|
| `payhold-dashboard` | Cloudflare Pages | `.github/workflows/deploy-dashboard.yml`, on push to main |
| `payhold-backend` | Supabase (`mwnbjjlilqrwdmwutbxr`) | `.github/workflows/deploy-backend.yml`; migrations by hand |

The backend does not go on Cloudflare and cannot: the money engine is SQL
running inside Postgres transactions, and Workers has no equivalent.

The dashboard is a *client of the public API* — it holds no secrets and has no
direct database write access.

**We built frontend-first.** The dashboard runs against a mock backend
(`payhold-dashboard/src/api/mock/`) that implements the full v1 contract as a
real state machine in the browser. It keeps running against the mock until the
Edge Functions exist; then `HttpClient` slots in behind the same
`PayHoldClient` interface and no screen changes.

**Money logic lives in SQL, not TypeScript.** The atomic-release guard is only
meaningful inside the transaction that writes the release, so `release_deal`,
`confirm_deal`, `refund_deal` and `settle_payout` are `security definer`
Postgres functions. Edge Functions own FX, fees, provider calls and auth, and
pass already-converted figures in. See `payhold-backend/CLAUDE.md`.

The mock's invariant tests (`src/api/mock/engine.test.ts`) are the backend's
acceptance spec — reproduce every one of them against the real Edge Functions.

## Money model

Funds sit in Flutterwave/Stripe balances (provider vaults). PayHold is the sole
keyholder. Money leaves a hold only when **both buyer and seller confirm**, or
the `auto_release_at` timer fires. Otherwise it refunds.

A tenant's balance is *derived*: `sum(ledger entries)`. It is never a stored
column. Payouts may never exceed it, checked inside the same transaction.

**Six buckets, not four** (spec §7). `held`, `pending_clearance`, `available`,
`reserved`, `fees_retained`, `paid_out` — and only the last describes money that
actually left. The reconciliation pass expects the provider to be holding the
other five summed.

`fees_retained` exists because of a bug it is worth not reintroducing. Our
commission is a debit in the clearing pool, but **nothing sweeps it out of the
tenant's provider balance** — under bring-your-own-keys there is no such
transfer, and the fee is revenue reclassified rather than funds moved. Without
its own bucket, a released deal expected the provider to be holding the amount
minus our fee while the provider reported the whole thing: drift equal to the
fee, on every released deal, and drift freezes that tenant's payouts
automatically. Collected `tax` sits there for the same reason.

The **provider's own** fee is the opposite case and is why the distinction is
drawn: the rail genuinely took it, so it reduces what we expect and belongs in
no retained bucket.

## Deal lifecycle

```
created → checkout_started → payment_pending → funded_held
                                  ↘ payment_failed    ↓
                                                 in_progress ⇄ revision_requested
                                                      ↓
                    confirmed_buyer / confirmed_seller
                                  ↓  (both)
                              clearing → released → payout_pending → paid_out
        ↘ expired  ↘ canceled       ↘ refunded / partially_refunded  ↘ disputed
```

Eighteen states, spec §6. Two of §6's names are absent because they already
exist here under another: **`delivered` and `buyer_review` are both
`confirmed_seller`** — the window where the seller has confirmed and the buyer
has not. Adding synonyms would give one event two spellings. §29.1 rules it.

**`clearing` is a rename of what `released` used to mean.** V1 wrote the release
ledger entry, said `released`, and used `payout_due_at` to hold the money for
the clearance window — so "released" already meant "out of the hold, not yet
payable". V2 splits that in two: `clearing` is inside the window, `released` is
past it and payable (§5.1's `available`). **Nothing about when money moves
changed.** The release entry, the fee, the deposit return and the payout row are
still written at the second confirmation, under the same row lock. Invariant 5
is untouched.

`released` looks transient — the same cron pass that matures a deal usually
dispatches it moments later. It is not decorative: a payout held by a risk rule,
frozen by drift, or with no eligible route leaves the deal sitting there for as
long as that takes, which is exactly the state an operator needs to see.

A **transition guard** (`deal_transition_allowed`, enforced by a before-trigger)
says which pairs are describable at all. It guards shape, not policy —
`release_deal` still decides whether both confirmations are present. Six states
have no writer: `checkout_started` (Phase 7), `in_progress`,
`revision_requested`, `expired` and `canceled` (an endpoint each), and
`partially_refunded` — which is deliberate and permanent, see §29.8 below. They
are declared because an enum value is the expensive migration and the guard
already knows them.

**The §7 values are separate and derived.** `deal_amounts(deal)` returns
buyer-paid, platform fee, provider fee, tax, reserve, refunded, receivable,
paid-out and seller-net, all in the presentment currency, computed off the
ledger and never stored. They sum to what the buyer paid; a test on each side
asserts it.

**Reserve** (§6.1) is a new seller's payout waiting longer. The extra days are
on `payout_due_at`; the reserve *bucket* is what makes the amount unpayable and
visible as such — carved out of the clearing pool where `available` cannot see
it. It is returned at exactly the moment the payout comes due, because
`payouts_deal_key` allows one payout per deal and a reserve outliving it would
have nothing to send it. Off unless `reserve_rate` is set.

**Refunds are full, partial or line-item** (spec §7.1, §29.6), and a refund is
its own record (`refunds`) rather than a bare ledger entry — §7.1.6 has Alipay
and WeChat Pay settling asynchronously up to 90 days out, so a refund has a
lifetime.

The guard that makes partials safe is cumulative: `sum(refunds) <= buyer_paid`,
checked under the same row lock that guards release. What is refundable is
derived, never a column.

§7.1 orders the four cases by where in the lifecycle the refund lands, and the
third is the one worth knowing:

| Where | What the ledger does |
|---|---|
| before capture | nothing arrived; refused |
| before release | one `refund` entry; the rest stays held and the deal carries on |
| after release, before payout | a **positive `release`** puts it back in the hold, then `refund` takes it out. Booking only the refund would drive `held` negative |
| after payout | `receivable` books what the seller owes; the refund stays `pending` for a person. No money moves — there is none there to move |

**A partial refund does not change the deal's status** (§29.8). `partially_refunded`
is declared and unwritten: a deal refunded by a third still has to be delivered,
cleared and paid out for the other two thirds, and a status saying otherwise
would put it outside `HOLDING_STATUSES` and make the payout path unreachable.
How much has gone back is `deal_amounts.refunded`.

(Security deposits were always partially capturable — `capture_deposit`, spec
§22, a different thing from a refund.)

## Invariants — every money path must satisfy all of these

1. **Service-role only.** All money writes happen in Edge Functions using the
   service role. Dashboard and API clients have zero direct write access.
2. **Verify then re-verify.** Every inbound provider webhook: check the
   signature (Flutterwave `verif-hash`, Stripe signature) *and* re-fetch the
   transaction from the provider API to confirm amount, currency, status —
   before touching any state.
3. **Amount/currency must match the deal.** Mismatch → `disputed`, never
   `funded_held`.
4. **Idempotent.** Unique `provider_ref`; duplicate webhooks are no-ops;
   release and refund are safe to call twice.
5. **Atomic release.** `SELECT ... FOR UPDATE` around the both-confirmations
   check. No double release, ever.
6. **Ledgered + audited.** Every state transition and every provider call
   writes a `ledger` entry (where money moves) and an `audit_log` row (always).
7. **Signed outbound.** Client webhooks are HMAC-signed so clients can verify
   PayHold really sent them.
8. **Tenant-scoped.** Every request is scoped to its API key's tenant.
   Responses must not reveal that other tenants exist.
9. **AI advises, never decides.** Model output is a suggestion. It runs on a
   read-only role and can only be executed by a human approval or a
   deterministic rule. No AI code path calls a money function.
10. **Notified.** Every state transition queues a signed webhook to each of the
    tenant's registered endpoints, in the same transaction as the transition. A
    client endpoint being down can never fail a release — delivery is a
    separate, retrying pass.
11. **Rules stop, people send.** The deterministic risk rules may hold a payout
    for review and may do nothing else. They cannot release, refund or send, so
    a wrong rule costs a seller a wait rather than money. Only a person clears
    a hold, and the approval is recorded against them. A person may *also* hold
    one — `hold_payout`, with a reason and their name — which is the same safe
    direction with somebody accountable for it, and it is the narrow
    alternative to freezing a whole account to stop one seller.

    The routing engine and the §12 eligibility gate sit under the same limit and
    add a distinction: what stops a payout is not always what a person should be
    able to start. `needs_verification` ends when somebody attests to the missing
    fact, `blocked` ends when a route exists or a dispute resolves, and neither
    is on the approve button. A machine re-asking and finding the reason gone is
    not sending anything, which is why both are re-screened every pass.

## Secrets and PII

Provider credentials encrypted at rest in `tenant_provider_accounts`. API keys
hashed at rest (compare by hash, never store plaintext). PayHold never stores
raw card numbers or full MoMo numbers — provider tokenization only. 3DS is
requested on all card charges.

Dashboard passwords are Supabase Auth's and are never stored, logged or read
back by anything in this repository. Minimum twelve characters, enforced in
`functions/account/` and in `config.toml` — a dashboard session reads every deal
and payout a company has.

## Provider interface

One interface, all rails behind it:

```ts
interface PaymentProvider {
  charge, release, refund, preauth, capture
}
```

- `FlutterwaveProvider` — full implementation. Cards + MTN MoMo + Airtel Money.
  Payouts via Transfers API to tokenized beneficiaries.
- `StripeProvider` — same interface, active only when keys exist. PaymentIntents
  with manual capture for deposits, Radar on.
- `FakeProvider` — **demo mode with zero keys must work end-to-end.**

Stripe cannot pay out to Rwandan recipients. **African payouts always ride
Flutterwave.** Adding Paystack/DPO later = one new class + one webhook function
+ a routing entry. Nothing else changes.

## Per-tenant settings

`service_fee_rate` (default 0.10), `buyer_fee` (optional), `clearance_days`
(**default 14** — spec §6.1, §29.7; was 7 in V1, with per-market values in §5),
`auto_release_days` (default 3), `currencies`, `ai_enabled`
(default true), `ai_monthly_budget_usd`, `ai_dispute_assistant`,
`ai_risk_narrator`, `risk_rules_enabled` (default true),
`risk_review_threshold_usd` (default $1,000, converted to the payout currency
at compare time), `payout_backup_enabled` (default true) and
`payout_primary_attempts` (default 2) — §5.1's explicit routing-policy check
before a backup destination may be used.

In-flight deals keep the settings they were created with. Settings changes apply
to new deals only.

## Public API v1

Auth: `X-Api-Key`, hashed at rest, rate-limited per key.

| Endpoint | Purpose |
|---|---|
| `POST /v1/deals` | Create deal → returns deal id + payment link |
| `GET /v1/deals/:id` | Full status, timestamps, amounts |
| `POST /v1/deals/:id/pay` | Start the charge on the rail the buyer's method implies |
| `POST /v1/deals/:id/confirm` | `side=buyer\|seller` + end-user token; both → atomic release |
| `POST /v1/deals/:id/refund` | Client-initiated, pre-release, policy-checked |
| `POST /v1/deals/:id/deposit` `/capture` `/release` | Card pre-auth deposit lifecycle |
| `GET /v1/payment-options` | What a buyer in a market can pay with — methods, wallets, card schemes, currencies |
| `POST /v1/sellers` | Register payout destination → tokenized beneficiary |
| `GET /v1/balance` | held / pending clearance / available / paid out |
| `POST /v1/webhooks-endpoints` | Client registers their endpoint for signed notifications |
| `GET /v1/webhook-deliveries` | Every attempt, with status and signature — the answer to "did you tell us?" |
| `GET /v1/payout-routes` | §5.1's routing table — which rails reach where, and which are on |
| `POST /v1/payouts/:id/hold` | Stop one payout. Takes a reason. Person-only, audited against them |
| `POST /v1/payouts/:id/approve-review` | Clear a hold, a rule's or a person's. Person-only, audited against them |
| `GET /v1/risk-signals` | What the deterministic rules noticed |
| `POST /ai-dispute` `/ai-risk-narrator` `/ai-support` | Draft, brief, answer. Advisory; each writes a suggestion and nothing else |
| `POST /ai-decisions` | A person approves or rejects a draft. The only path from model output to money |
| `/webhooks/flutterwave/:tenant` `/webhooks/stripe/:tenant` | Inbound provider webhooks |

**Dashboard access is separate from all of that.** A company signs up, and its
people sign in with an email and password held by Supabase Auth — not an API
key, which is a server credential and belongs on a server. `POST /account/signup`
creates the company and its first `owner`; `GET /account/me` is what turns a
session into a tenant and a role. Signing in itself never touches our code: the
dashboard exchanges the password with Supabase Auth directly.

The dashboard is behind that gate in full. The hosted buyer and seller pages
(`/pay/:id`, `/status/:id`) are not, and must never be — someone opening a
payment link from an email has no PayHold account.

**A client site must never hardcode a payment method.** Which wallets exist in
Uganda, whether Nigerian cards take Verve, which markets can be paid into and
which can only be collected from — all of it changes when provider coverage
changes, and a site with it baked in is wrong the day it does. AutoHire and
every other tenant ask `/v1/payment-options` and render the answer:

```
GET /v1/payment-options                       every market, every currency
GET /v1/payment-options?country=RW            methods, wallets, schemes there
GET /v1/payment-options?country=IN&currency=RWF&amount=14000000
                                              …plus "you will be charged $100"
GET /v1/payment-options?payout_country=RW     can a seller there be paid, and how
```

Every response carries `rails_verified`. It is **false** until each row has been
checked against provider documentation and a signed agreement, and a client
should treat an unverified route as "probably" rather than "yes".

**Event names are §10.2's, and they were renamed in Phase 1.** `deal.funded_held`
→ `order.funded_held`, `deal.confirmed` → `order.delivered` / `order.accepted`,
`deal.released` → `order.clearing_started` (plus a new `order.released` at the
end of the window), `deal.refunded` → `refund.succeeded`, `deal.disputed` →
`dispute.opened`, `deal.paid_out` → `payout.paid`. The object stays a `deal` in
our own code; only the wire moved (§29.2).

One event per transition. There is no per-event subscription — every registered
endpoint gets every event — so shipping the old and new name together would have
doubled every client's delivery volume rather than easing a migration. That
makes the rename breaking, and it is affordable exactly now, before live traffic.

Outbound deliveries carry `PayHold-Signature: t=<unix>,v1=<hmac-sha256>` over
`<t>.<raw body>`, plus a `PayHold-Event` header. Clients must verify the digest
**and** bound the age of `t`, or a captured delivery can be replayed at them.
Failed deliveries retry five times with backoff (1m, 5m, 30m, 2h) and then stop
and wait for a person.

CORS: dashboard origin only. The API itself is origin-free but key-authenticated.

## PayHold Intelligence (spec §12)

An AI layer from day one, renting a pre-trained model's reasoning (Claude via
the Anthropic API, `claude-opus-5`) pointed at PayHold's own data. **Invariant 9
is the whole design**: it advises, a human approves, the approval is what writes
to the ledger. It is non-critical by construction — if the API is down, every
money path still works.

Day one, no training data needed:

- **Dispute assistant** — reads both sides' statements, photo descriptions and
  the full deal history; drafts a suggested resolution (refund / release /
  partial refund with an amount, or "needs a person") with the events it cited.
  An admin approves; the approval executes. **The split is real as of Phase 3**:
  `partial_refund` carries a `refund_amount`, `resolve_dispute` refunds that
  much and releases the rest, and the dispute is labelled `dispute_split` so
  §24.4 does not learn that the buyer won outright. `escalate` goes back to
  meaning what it says — no split resolves this either. Invariant 9 is
  unaffected: the model proposes an amount, a named person's approval writes it,
  and `payhold_ai` still holds execute on nothing that moves money.
- **Risk narrator** — before a large payout or on a flag, summarises what's
  known about the counterparties ("new seller, 3 deals, one prior dispute,
  payout destination changed yesterday"). Advisory only, never an auto-block.
- **Support assistant** — answers tenant questions from our own docs.
  Retrieval only; no write tools bound.

Later (~6–12 months of real transactions), on data only we have: our own fraud
scoring model trained on `deal_outcomes`, and anomaly detection on ledger and
payout patterns. **Which is why logging starts now** — those labels can't be
backfilled:

```
ai_suggestions(id, tenant_id, deal_id, kind, model, prompt_version, input_hash,
  output jsonb, cost_usd, created_at, decided_by, decision, decided_at)
deal_outcomes(id, tenant_id, deal_id, outcome, reason_code, notes,
  amount_disputed, resolved_at, created_at)
risk_signals(id, tenant_id, deal_id, seller_id, signal, value jsonb, created_at)
```

**Built** — `payhold-backend/supabase/migrations/20260806000004_intelligence.sql`
and `functions/ai-*`. Invariant 9 is enforced by a Postgres role rather than by
convention: the drafting functions connect as `payhold_ai`, which holds no
execute on any money function, and `decide_ai_suggestion` — locked, requiring an
approver's name — is the single bridge across. `deal_outcomes` is written by
triggers on the money path so the labels cover resolutions no model saw.

Prompts see one tenant's data only. No raw card or full MoMo numbers in these
tables. The language rule binds model output too.

## Seller onboarding (spec §12)

A seller starts **`pending`** and cannot be paid until somebody attests that the
identity check, the sanctions screen and the ownership check came back. §12's
sentence is the whole of it: *a seller must not receive a payout solely because
a payment webhook says "success".*

**The eligibility gate is not a risk rule.** Everything in `screen_payout` used
to sit behind `risk_rules_enabled`, because those rules are discretionary —
arithmetic a tenant may reasonably decline to act on. Eligibility is not, so it
runs first and unconditionally: a tenant switching the rules off must not
thereby start paying sellers it has never verified. Invariant 11 is unchanged —
the gate holds a payout and can do nothing else.

It holds for: unverified identity, missing or stale sanctions screening, an
unverified payout destination, a destination that moved in the last
`destination_hold_hours` (§5.1's change protection), or an open dispute.

`GET /v1/sellers/:id/capabilities` asks the same questions ahead of time and
returns **every** reason, so a seller can fix what is missing during onboarding
rather than discovering it as a held payout three weeks later. It returns two
lists and they stay separate: `reasons` is what the seller has to go and do,
`route_reasons` is what PayHold cannot yet reach. Only the first holds a payout
— a routing failure in that list would make an unroutable payout
`needs_verification`, hide it from the routing engine, and tell a verified
seller to verify themselves again.
`POST /v1/sellers/:id/verify` records the attestation and **refuses an API
key** — a client that could verify its own sellers has turned KYC into a field
it sets.

**Destinations live in `seller_destinations`** (§5.1: a preferred destination
and a verified backup, which one pair of columns cannot express).
`sellers.beneficiary_token` and `masked_destination` remain as the primary's
copy, kept in step by a trigger with exactly one writer. The payout path no
longer reads them — `dispatchPayout` takes the beneficiary token from the
destination the routing decision chose, because a seller now has more than one
and only the decision knows which was picked.

## Fraud controls (spec §6)

Four layers, and only one of them is allowed to stop anything:

- **3DS** requested on every card charge, and never silently downgraded.
- **Tokenization** — no raw card or full MoMo number is ever stored.
- **Radar** on Stripe card charges (pending `StripeProvider`).
- **Deterministic risk rules**, checked before a payout leaves: a first payout
  to a seller who registered just before the booking, a jump past 3× anything
  they have been paid before, a dispute lost in the last 90 days, a deal funded
  and released within minutes. A rule can hold the payout for review and
  nothing else. Signals are recorded whether or not the rules are switched on —
  that history is what a fraud model of our own trains on later (§12.4) and it
  cannot be backfilled.

The rules are arithmetic over our own tables, which is exactly what lets them
act at all under invariant 9. The AI risk *narrator* is a separate thing: it
summarises, it never holds.

The narrator reads this screen and cannot act on it. A held payout offers "brief
me", which drafts the §12.2 summary of the counterparties and writes a
suggestion; it holds, clears, releases and sends nothing, and the approval stays
on the Payouts screen against a named person. A hold is arithmetic over our own
tables, which is what lets a rule stop anything under invariant 9 — a summary
you can check is the only thing a model may add to that.

**Where a payment came from** is recorded in `request_context` — an address, a
provenance (`provider` / `hosted_page` / `client_attested`) and the event it was
seen at. Observation only: no rule reads it, and capture cannot fail a payment.
The three sources are kept apart because a client can tell us anything and a
provider is reporting what it saw.

Two things bind anyone writing a rule against it. In the launch markets most
buyers pay by mobile money from behind carrier-grade NAT, so a shared address is
usually a carrier rather than a person — IP is worth having for geo-mismatch and
cross-tenant reuse, not as a verdict. And it is the first personal data PayHold
stores, kept indefinitely by decision so §12.4 has history to train on, which
carries a stated purpose and a deletion path as obligations rather than
options. The `Fraud` screen is where a person reads it; the AI role cannot. Every
name on that screen opens the counterparty behind it — a hold is a question
about a seller, and nobody should have to decide it from a string.

## Payout routing (spec §5.1, §5.2)

**Which rail carries a payout is data, not code.** `payout_routes` is the table:
a rail, the countries and currencies it reaches, whether it is on, a rank and a
fee. §12 requires a country or a provider to be disabled *without a redeploy*,
which `_shared/rails.ts` could not give — so `route_payout` reads rows.

A `tenant_id` of null is the platform default for that rail. A tenant row for
the same rail **replaces** it rather than sitting beside it; otherwise a tenant
switching a rail off would leave the platform's enabled row still eligible.

Every choice writes a `payout_decisions` row — the selected provider and method,
the eligibility checks, the ranking score, currency, fee estimate, FX source and
a reason code — because §5.1 requires a payout decision be auditable after the
fact, and a recorder the caller may forget to invoke is not an audit. A *changed*
outcome writes one; an unchanged one does not, or a blocked payout re-screened
every pass would bury the row that explains something.

**A route is never a fallback for another route** (§29.10). §5.1's central rule
is that funds are never silently redirected to another destination, and a
destination is a token minted by one provider for one rail — so "the
highest-ranked eligible fallback" cannot mean a different rail for the same
destination. It means the seller's **backup destination**, and all four
conditions are checked before the backup row is even read: the payout has
failed, it has failed `payout_primary_attempts` times, the tenant has
`payout_backup_enabled` on, and the backup is verified and out of its security
hold. Using it emits `payout.route_changed`, once.

**Five rails are declared and disabled** — PayPal, Venmo, Cash App Pay, Alipay,
WeChat Pay. They exist so a seller who picks one gets a specific sentence
instead of "unknown destination type", and their rows carry no `provider`, which
a check constraint turns into "cannot be enabled". §29.3, enforced by the
database rather than by review.

**Two new payout statuses, and the difference is who ends them.**
`held_for_review` ends when a named person approves. `needs_verification` (§12)
ends when somebody attests to the missing fact — `approve_payout_review` refuses
it, which is what closes the hole where an operator could wave through a seller
nobody had verified. `blocked` (§5.1's no-route case, and a disputed deal) ends
when a route exists or the dispute resolves. §5.1's `clearing` and `available`
are **derived** from the deal's own window rather than stored; see §29.9.

## Cron jobs

| Job | Function |
|---|---|
| Auto-release timer | `auto-release` ✅ |
| Clearance → payout dispatch | `payout-dispatch` ✅ — screens before it transfers |
| Reminders | still to build; needs a channel decided first |
| Outbound webhook delivery | `webhook-dispatch` ✅ |
| Ledger-vs-provider reconciliation | `reconcile` ✅ |

Written is not running. The schedules live in
`payhold-backend/scripts/schedule-cron.sql` and are applied by hand, once, per
environment — a deployed function nothing invokes is a job that silently never
runs. They are staggered deliberately: **reconcile → auto-release →
payout-dispatch**, because drift freezes payouts and a dispatch that went first
would send money out of a balance we already know we cannot explain.

Reconciliation compares **per rail**, not per currency — you cannot ask two
providers about one number. Any drift **freezes that tenant's payouts**
automatically. Nothing unfreezes automatically: the numbers agreeing again is
not the same as someone having understood why they did not.

Scheduled jobs authenticate on `CRON_SECRET`, not an API key. A deployment
without that secret set refuses to run them.

## Testing gate before any live traffic

Full sandbox walkthrough, all of it: pay (test card + test MoMo) → held →
confirm ×2 → release → clearance → payout; refund path; timer path; and a
forged-webhook test that **must** return 401.

The way in gets walked too, because it is now the front door: sign up → land in
an empty company → sign out → sign back in → a dashboard call with no bearer
token **must** return 401, and one carrying a session belonging to another
company must return that company's nothing rather than this one's rows. RLS is
only proven against the real project (PGlite shims `auth.uid()`), so this is
where that check lives.

## Working agreements

- Keep the operations guide (spec §11) accurate in the same commit as any
  behavior change.
- New prompts and model upgrades ship in shadow mode first (suggestions logged,
  not shown), compared against the humans' actual decisions, then enabled per
  tenant.
- New deal types need no code — the engine only needs amount, parties, dates.
  Machines, services, equipment all flow identically.
- AutoHire's internal payment functions (`flutterwave-collect`,
  `create-payment-intent`, `capture-payment`, `flutterwave-transfer`) are being
  retired. AutoHire keeps UI only; its `bookings` table carries a
  `payhold_deal_id`.
