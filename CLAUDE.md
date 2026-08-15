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
│                        engine, 28 Edge Functions and 4 cron jobs built ✅
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

**We built frontend-first, and that is over.** The dashboard used to run
against a mock backend in `payhold-dashboard/src/api/mock/` — the full v1
contract as a state machine in the browser, with a dev panel that funded deals
and advanced the clock. It is **deleted**. `HttpClient` (`src/api/http.ts`) is
the only implementation of `PayHoldClient`, every screen reads real rows, and a
build with no `VITE_SUPABASE_URL` throws at import rather than falling back to a
simulation: a misconfigured deploy that renders invented numbers is
indistinguishable from a working demo, and the demo was the thing worth losing.

What went with it is worth knowing, because none of it is coming back as a
client feature: funding a deal, advancing time, running cron, forcing a payout
failure and injecting drift are all things only a provider webhook or a
scheduled job may cause. Signing in went the same way — there is one auth
backend now, Supabase's.

**Money logic lives in SQL, not TypeScript.** The atomic-release guard is only
meaningful inside the transaction that writes the release, so `release_deal`,
`confirm_deal`, `refund_deal` and `settle_payout` are `security definer`
Postgres functions. Edge Functions own FX, fees, provider calls and auth, and
pass already-converted figures in. See `payhold-backend/CLAUDE.md`.

The invariants the mock's tests pinned are now pinned by
`payhold-backend/tests/` against real Postgres, and the end-to-end proof is
`payhold-backend/scripts/sandbox-walkthrough.md`, which is run by a person
against a provider's own dashboard.

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
- `StripeProvider` — built. Hosted Checkout Sessions so card data never touches
  our infrastructure, `capture_method: manual` for §22 deposits, Connect
  transfers for payouts, and `request_three_d_secure: 'any'` rather than
  Stripe's `automatic` default — letting Radar decide *is* the silent downgrade
  §6 forbids.
- `FakeProvider` — **demo mode with zero keys must work end-to-end.**
- `PayPalProvider` — **built**. Orders v2 for collection (`AUTHORIZE` for §22's
  deposits), Payouts v1 for sending, and it carries Venmo. Three shapes differ
  from Stripe and all three are in the file header: amounts are major-unit
  decimal strings, auth is an OAuth2 token that expires and is cached, and
  **webhook verification is a network call** rather than an HMAC we can compute
  — which is the rail `verifySignature`'s promise-returning shape was designed
  for. An unreachable PayPal means *unverified*, never verified; invariant 2 has
  no degraded mode. **Built is not enabled**: no signed agreement, and §16 wants
  written payout confirmation per market, so the capability row stays off and
  `payout_routes_require_live_provider` keeps its routes refused.
- **Cash App Pay rides Stripe, and is deliberately not an adapter.** It has no
  API of its own — Square or Stripe — and Square would mean a fourth set of
  credentials, a fourth webhook function and a fourth balance for `reconcile`
  to compare per rail, to buy collection only, since Cash App cannot receive a
  marketplace payout from us. Through Stripe it is a payment-method type on an
  adapter that already exists, in a market Stripe already covers. Enabling it
  is a Stripe dashboard setting plus a US/USD route, not a class, so its
  capability row stays `implemented = false` — the honest reading of that column
  is "is there a class behind this enum value", and there should not be.
- `china_wallet_partner` — **declared and unbuilt**, and not waiting on code the
  way PayPal was. `china_wallet_partner` names a partner nobody has
  chosen — Antom, Adyen and Airwallex are different APIs — behind §5's bar on
  promising cross-border payout until an approved local structure exists, which
  is a legal arrangement rather than an adapter. `loadProvider` throws for it
  rather than falling back to the fake.

**`wallet` is a payment method as of `20260808000004`**, and its absence was a
real gap rather than an oversight found late. §9 names five wallet rails and
`payment_method` had nowhere to put any of them, so every one would have arrived
as a `card` — false in a way that matters, since a wallet payment has no card
scheme, is not 3DS-eligible, and disputes through a different process. Stripe's
`toMethod` had been mapping `cashapp` to null rather than lie, which meant a deal
funded by Cash App Pay recorded no method at all. **Stripe Link stays `card`**:
it is card-backed and disputes as a card does, so it is a faster way to present
one rather than a different instrument.

**What each adapter can do is a row, not a branch.** `provider_capabilities`
carries §9's eight flags plus `implemented` and `enabled`, and those two are
separate because they fail differently: an unbuilt adapter is a roadmap item, a
disabled one is an outage. Switching one off disables exactly its own routes,
because `route_evaluation` reads the row.

**Which markets are open is also a row.** `payment_markets` is a per-country
overlay with a required `reason` — collect and payout close independently, a
tenant row replaces the platform's, and a country nobody has ruled on is open.
The generated registry stays generated and says what is *possible*; the matrix
says what is *on*. Spec §29.11.

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
at compare time), `payout_backup_enabled` (default true),
`payout_primary_attempts` (default 2) — §5.1's explicit routing-policy check
before a backup destination may be used — `payout_retry_max_attempts`
(default 5, floor 1), §13's budget before a refused payout stops being retried
by anything automatic, and `payout_mode` (`auto` by default, or `wallet` to
stop the cron sending cleared money nobody has asked for).

In-flight deals keep the settings they were created with. Settings changes apply
to new deals only.

## Public API v1

Auth: `X-Api-Key`, hashed at rest, rate-limited per key.

| Endpoint | Purpose |
|---|---|
| `POST /v1/checkout/sessions` | Issue a hosted payment link for a deal. Idempotent — one live session per deal |
| `GET /v1/checkout/sessions/:id` | Its status. `POST …/cancel` withdraws it |
| `GET /v1/checkout/public/:token` | What the buyer sees. **No credential** — the token is the credential |
| `POST /v1/checkout/public/:token/pay` | The buyer chooses a method and is handed to the provider |
| `POST /v1/deals` | Create deal → returns deal id + payment link |
| `GET /v1/deals` | This tenant's deals. `?buyer_ref=` finds the ones where that opaque handle bought — see below |
| `GET /v1/deals/:id` | Full status, timestamps, amounts |
| `GET /v1/deals/:id/amounts` | §7's breakdown — buyer-paid, fees, tax, reserve, refunded, receivable, seller-net. Derived, never stored |
| `GET /v1/deals/:id/refunds` | The refund records. A refund has a lifetime, not a moment |
| `POST /v1/deals/:id/pay` | Start the charge on the rail the buyer's method implies |
| `POST /v1/deals/:id/confirm` | `side=buyer\|seller` + end-user token; both → atomic release |
| `POST /v1/deals/:id/refund` | Client-initiated, full or partial, policy-checked |
| `POST /v1/deals/:id/deposit` `/capture` `/release` | Card pre-auth deposit lifecycle |
| `GET /v1/payment-options` | What a buyer in a market can pay with — methods, wallets, card schemes, currencies |
| `POST /v1/sellers` | Register payout destination → tokenized beneficiary. Takes the client's own `external_user_id`, unique per tenant, so their system can find this seller again |
| `GET /v1/sellers` | This tenant's sellers, or `?external_user_id=` to find the one registered against the client's own handle. No match is an empty list, not a 404 — that is the question a get-or-create asks |
| `GET /v1/sellers/:id/capabilities` | Can this seller be paid, and if not, every reason. Two lists, kept apart |
| `POST /v1/sellers/:id/verify` | Record the attestation. **Refuses an API key** — it is a person's decision |
| `POST /v1/sellers/:id/active` | Whether this seller is currently one of the tenant's. Status only, no payout effect — takes an API key |
| `GET /v1/sellers/:id/destinations` | §5.1's preferred destination and verified backup |
| `POST /v1/sellers/:id/destinations` | Move where a seller is paid, or give them a backup. The new row is unverified and inside §5.1's security hold — payouts pause until it is checked, and no parameter skips that |
| `POST /v1/sellers/:id/destinations/:id/end-hold` | §5.1's step-up: somebody confirmed the change with the seller, so the hold ends early. **Refuses an API key** — a client that could end its own holds has deleted the defence rather than satisfied it. Does not verify the destination |
| `POST /v1/sellers/:id/destinations/:id/promote` | Move back to a destination already checked, without the second hold a re-registration would serve. Refused for an unverified destination and for one still inside its hold, so it reaches nothing new |
| `GET /v1/sellers/:id/balance` | This seller's wallet — ledger buckets, plus what a withdrawal would move and every reason something is stuck |
| `GET /v1/sellers/wallets` | Every seller's wallet in one query |
| `POST /v1/sellers/:id/withdraw` | Ask for the cleared money. Stamps and dispatches; screens, routes and books exactly as the cron does |
| `GET /v1/balance` | held / pending clearance / available / paid out |
| `GET /v1/ledger` | the entries those buckets are made of. Append-only; there is no writer |
| `GET /v1/audit-log` | who did what, including everything that moved no money |
| `GET /v1/settings` `PATCH /v1/settings` | §8's per-tenant settings. Refuses an API key on the write — a client that could set its own service fee has turned our commission into a field it fills in |
| `GET /v1/api-keys` `POST` `DELETE` | the credential a client's server holds. Person-only, and the plaintext is returned exactly once |
| `POST /v1/webhooks-endpoints` | Client registers their endpoint for signed notifications |
| `GET /v1/webhook-deliveries` | Every attempt, with status and signature — the answer to "did you tell us?" |
| `GET /v1/payout-routes` | §5.1's routing table — which rails reach where, and which are on |
| `POST /v1/payouts/:id/hold` | Stop one payout. Takes a reason. Person-only, audited against them |
| `POST /v1/payouts/:id/approve-review` | Clear a hold, a rule's or a person's. Person-only, audited against them |
| `GET /v1/risk-signals` | What the deterministic rules noticed |
| `POST /v1/disputes` `GET /v1/disputes/:id` | §8's Resolution Center — open one, and read it with its offers, evidence and timeline |
| `POST /v1/disputes/:id/offers` `/offers/:id/respond` `/withdraw` | Request an update, extension, cancellation or refund. The other party has 48 hours |
| `POST /v1/disputes/:id/evidence` | Photos, documents, check-ins. A description and a reference — never the file |
| `GET /v1/disputes/:id/export` | §8's communication export, for a chargeback response or a regulator |
| `POST /v1/disputes/:id/resolve` | Decide it. **Refuses an API key**, and refuses anyone who acted for a party |
| `POST /ai-dispute` `/ai-risk-narrator` `/ai-support` | Draft, brief, answer. Advisory; each writes a suggestion and nothing else |
| `POST /ai-decisions` | A person approves or rejects a draft. The only path from model output to money |
| `GET /v1/launch` `POST /v1/launch/:code/sign-off` | §16's checklist, and what stands between us and live money. PayHold staff only; refuses an API key |
| `/admin/tenants` `/admin/reconciliation-alerts` `/admin/reconciliation-runs` | The master-admin console: every account, every drift case, every pass. Run one now, sign one off, freeze or unfreeze an account. **PayHold staff only** — the one function whose reads are not tenant-scoped, which is why it is a function of its own |
| `/flutterwave-webhook/:tenant` `/stripe-webhook/:tenant` | Inbound provider webhooks. Signature checked against *that tenant's* own secret, then the transaction re-fetched |

**Dashboard access is separate from all of that.** A company signs up, and its
people sign in with an email and password held by Supabase Auth — not an API
key, which is a server credential and belongs on a server. `POST /account/signup`
creates the company and its first `owner`; `GET /account/me` is what turns a
session into a tenant and a role. Signing in itself never touches our code: the
dashboard exchanges the password with Supabase Auth directly.

The dashboard is behind that gate in full. The hosted buyer and seller pages
(`/pay/:token`, `/status/:id`) are not, and must never be — someone opening a
payment link from an email has no PayHold account.

**Those two pages may be framed by an allowlisted tenant origin**, so a client
can host checkout in its own booking page instead of navigating the buyer away.
The allowlist is `frame-ancestors` in `payhold-dashboard/public/_headers` and
never `*`. A framed page reports its outcome to the parent by `postMessage`
(`src/lib/embed.ts`), and **that message is a UI hint and nothing more** — a
parent that created an order from it would have built a way to get goods
without paying. The booking still comes from the signed `order.funded_held`
webhook. AutoHire is currently the only origin on that list, which is the one
place it has something no other tenant has; it is a static file today and
becomes a per-tenant setting when a second tenant asks.

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
`dispute.opened`, `deal.paid_out` → `payout.paid`. §8 added
`dispute.offer_made` / `offer_accepted` / `offer_declined` / `offer_withdrawn` /
`offer_expired`, `dispute.evidence_added` and `dispute.resolved` — and
`offer_expired` is deliberately not `offer_declined`, because a client
reconciling its own records needs to tell an answer from a silence. The object stays a `deal` in
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

**Demo mode with zero keys works here too**, the same rule `FakeProvider` keeps
for the rails. With no `ANTHROPIC_API_KEY`, `askClaude` answers from
`_shared/ai-demo.ts` — a deterministic rule over the real case file, validated
by the same validator a model's answer goes through, written with
`model = 'demo-stand-in'` and `cost_usd = 0` so no row ever claims a model
produced it. It advises exactly as the model does, and a person still approves.
The one secret with no stand-in is `SUPABASE_JWT_SECRET`: a Postgres role cannot
be faked, and the only fallback would be the service role.

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

**A destination is not required to become a seller.** `POST /v1/sellers`
takes `country`, `payout_provider` and `destination` together or not at
all — a host is registered the moment a tenant knows who they are, and money
accrues in `held`/`available` against them from their first deal exactly as
it does for any other seller. Nothing about accruing money ever depended on a
destination existing; only the payout does, and `seller_capabilities` has
answered *"No payout destination has been registered"* for that case since
Phase 5 — it holds the payout at `needs_verification`, the same status an
unverified destination produces, and never reaches routing. A destination
added later, via `POST /v1/sellers/:id/destinations`, goes through the same
security hold every destination change does — a seller's very first
destination is not a special case, because a seller who has been quietly
accruing money is exactly the target an account takeover would want.

**A seller can also be a buyer, and PayHold makes no attempt to know that
itself.** There is no buyer identity anywhere in this system —
`deals.buyer_ref` is the client's own opaque handle, kept precisely so there
is nothing here to join a buyer to (§8's conflict-of-interest rule on the
Resolution Center depends on that absence). A tenant whose sellers can also
book as buyers already holds the one fact this needs: tag the deal's
`buyer_ref` with the seller's own `external_user_id` when they are renting
rather than hosting, and `GET /v1/deals?buyer_ref=` reads it back. Nothing
about money changes — the deal is funded, held and released exactly as any
other, in a wallet that stays entirely separate from that same person's
seller earnings. PayHold does not net one against the other; a host paying
for their own booking pays in full, the same as anyone else.

**`active` is a status the tenant reports, not a fact PayHold decides.**
Nothing here forces a seller to stay one forever — a host who stops hosting is
not deleted, and money already owed to them does not stop moving. `active`
(default `true`) is where a client says "this one stepped back," and
`POST /v1/sellers/:id/active` **accepts an API key**, unlike `/verify`: it is
the client restating a fact about its own business rather than an attestation.
It carries no weight anywhere on the payout path — `screen_payout` does not
read it, and a seller marked inactive mid-clearance still gets paid what they
already earned. If a tenant later wants inactivity to *hold* a payout, that is
a deliberate policy decision belonging next to the eligibility gate, not
something this column does on its own.

## Seller wallets, and pulling instead of waiting

**A seller's wallet is a read, not a table.** `seller_wallet_rows` sums the same
ledger entries `rail_balances` does, grouped by seller instead of by rail —
there is no stored seller balance for the reason there is no stored tenant
balance. The property that makes it trustworthy is that every seller's wallet
summed *is* the tenant's balance, bucket for bucket, less `fees_retained`. That
bucket is our commission and collected tax; it stopped being the seller's and
has no business on a screen they read.

`held` is gross and everything past it is net. Inside the hold nothing has been
struck — the fee is booked at release — so what sits there is what the buyer
paid, not what the seller will get. A client showing a wallet should label it
"in progress" rather than "yours"; `deal_amounts.seller_net` is the per-deal
figure that answers what a held deal is actually worth to them.

The wallet is in the currency the buyer was charged. `seller_withdrawable` is
the other side — the payout rows, in the seller's *own* payout currency, which
for a cross-border deal is a genuinely different number in a different currency.
Two questions, not one question answered twice. It counts `held_for_review`,
`needs_verification` and `blocked` separately for the reason
`seller_capabilities` returns every reason rather than the first.

**`payout_mode = 'wallet'` changes when, not whether.** Money still clears on
the same window and still lands in `available`; what stops is the cron sending
it unasked. `due_payouts` is where that binds, and it is in SQL rather than in
the cron because of the batch limit — filtering wallet-mode rows out *after*
`limit 25` would let one tenant's unasked-for backlog starve every other tenant
in the pass, silently, for as long as the backlog stood. The default is `auto`,
so a tenant that sets nothing behaves exactly as it did before.

**Asking is not deciding.** `request_withdrawal` stamps the seller's due payouts
and re-arms `next_attempt_at`; `dispatchPayout` then runs the same frozen-tenant
check, the same eligibility gate and the same routing decision it runs for the
cron. A withdrawal path that called a provider itself would be a second way to
pay a seller nobody verified, which is exactly what §12 forbids. It does not
reset `attempts` — `route_payout` reads that to decide whether the backup
destination may be used — and it does not touch `held_for_review`, because a
payout a rule or a person stopped is waiting on a named person (invariant 11).

**"Any card" means any card they already registered and had verified.** A
withdrawal may name a `destination_id`, and it must be one of the seller's own
`seller_destinations` rows, verified and out of its security hold — checked at
request time and re-checked in `route_payout` under the payout's lock, because
a verification can be withdrawn in between. A withdrawal that could name a
*fresh* destination is the shape an account takeover uses, and §5.1's change
protection exists to catch it.

**None of this gives a seller a login, and it must not.** Every function here is
called by the tenant's own server on the seller's behalf — the same shape as
`POST /v1/sellers/:id/verify`. AutoHire renders the wallet in AutoHire's app;
PayHold supplies the numbers. `withdraw` accepts an API key where `verify` does
not, and the line is that verifying is an attestation that has to be somebody's,
while asking for money that has already passed every check is the seller's own
routine act.

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

**A security hold ends by expiring or by somebody ending it**, and until
`20260809000002` only the first was possible. §5.1 asks for two things — a new
destination enters a short hold *and may require step-up verification before
use* — and the table implemented only the first, so a seller who rang in and had
the change confirmed still waited out a timer.
`POST /v1/sellers/:id/destinations/:id/end-hold` is the step-up written down: a
name, an audit row, and an API key refused, because "get in, move the
destination, withdraw" is the shape this protects against and a client ending
its own holds would be the second step granting itself the third. It ends the
hold and nothing else — the destination is still unverified afterwards, which is
a separate attestation and a separate stop.

**`add_seller_destination` always inserts, and moving back needed something
narrower.** A seller whose new destination turns out to be unroutable — a card
in a market Stripe cannot pay into, which is the case that found this — could
only get their old line back by re-registering it, which minted a second token
and served a second hold for a destination already tokenized, verified and held
once. `promote_seller_destination` (`20260809000003`) is the move back: it swaps
which row is primary and writes no new row. It is a **narrower** door than
ending a hold, not a wider one — refused for an unverified destination and for
one still inside its hold, so it can only pick between destinations a person has
already attested to. A takeover's freshly added row fails both guards.

That change also made one hold read as one. `seller_capabilities` and
`route_payout` read `seller_destinations.security_hold_until`; `screen_payout`
re-derived its own window from `sellers.destination_changed_at` and the current
`destination_hold_hours`, and nothing kept the three in step — so a seller could
be shown one reason while their payout was stopped by another. The stamp now
wins wherever it exists, with the old derivation kept as the fallback for a
primary seeded at registration, which carries no stamp and would otherwise lose
the protection entirely.

**Destinations live in `seller_destinations`** (§5.1: a preferred destination
and a verified backup, which one pair of columns cannot express).
`sellers.beneficiary_token` and `masked_destination` remain as the primary's
copy, kept in step by a trigger with exactly one writer. The payout path no
longer reads them — `dispatchPayout` takes the beneficiary token from the
destination the routing decision chose, because a seller now has more than one
and only the decision knows which was picked.

## Disputes: the Resolution Center (spec §8)

Either party may request an **update, extension, cancellation, partial refund or
full refund**. The other has 48 hours. Only one request may be open per order at
a time, evidence and structured reason codes sit alongside, and the whole thing
reads back as one ordered timeline.

**Silence lapses a request. It never accepts one.** §8 allows an unanswered
request to be auto-resolved by platform rule; the rule here is that the offer
expires and the dispute stays open. The other reading would make a clock the
thing that refunds a buyer or pays a seller, and invariant 9 and invariant 11
both forbid a machine deciding. The 48-hour window still closes without a
human — which is what §15 phase 4 asks — and nothing moves when it does.
`expired` is a separate status from `declined`, because declining is an act and
§24.3's labels cannot be backfilled.

**A dispute freezes the payout whole; the disputed amount bounds the
resolution.** §8 asks for the freeze to cover only the affected amount, and the
ledger could — but one payout row exists per deal, so paying the undisputed
share now leaves nothing to send the rest with if the dispute later goes the
seller's way. So the amount is enforced where it can be enforced honestly:
nothing may take more from the seller than was ever in dispute. Splitting a
payout is a second payout row with its own idempotency key and its own line in
reconciliation, and it is not built.

**An administrator who acted for a side cannot decide.** Not "who is a party" —
that cannot be asked, because PayHold stores no buyer PII and a seller has no
login, so there is no identity to join to. What is recorded is who did what, so
raising the dispute, making a request or answering one disqualifies you from
being named its decider. `both-parties` is the reserved name for the two sides
agreeing with each other, and it is the one actor allowed to have acted.

A resolution **requires a decider**, the same way clearing a payout hold and
verifying a seller do. A decision without a name is not a record.

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

**A refused payout is retried on a ladder, and then it stops** (§13). 1m, 5m,
30m, 2h and capped — the same shape the webhook dispatcher uses, because two
backoff curves in one system are two things to reason about during an incident
for no gain. The clock is `payouts.next_attempt_at`, and **null means no machine
may try this again**: when the budget (`payout_retry_max_attempts`) is spent the
payout goes to `blocked` and the clock is cleared, which is how "then move to
`payout_blocked` for operator action" is expressed without a second status
meaning "blocked, but really blocked". §5.1's no-route `blocked` keeps its clock
and is re-asked every pass, because that answer can change with nobody doing
anything; a rail that refused us five times is not that.

The automatic retry is also what makes the backup destination reachable without
a person: the third condition above — a payout that has failed
`payout_primary_attempts` times — is now something a cron pass arrives at on its
own. A person pressing retry gets **one** more attempt rather than a fresh
series, because the attempt counter is what the backup gate reads and zeroing it
would send the next attempt back to the primary that has been failing.

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

**Every pass writes a `reconciliation_runs` row per tenant per rail** (§13).
The alerts table says what is wrong now; it cannot say that we looked, and a
nightly control nobody can prove ran is not a control. A run carries its window,
what matched, what did not, what was skipped because a provider could not be
reached, and `missing` — verified inbound events in the window our ledger never
posted. A pass that dies leaves its run open, and the next one records it as
`failed` rather than tidying it away.

`resolve_reconciliation_run` is where a person signs a case off, and it is the
one place a freeze is lifted: named, audited, refused while any case on that
tenant is still open, and behind a separate argument, because writing down what
happened and declaring the money accounted for are two different claims.

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

V2 adds four paths: a partial refund at each of §7.1's four positions, a routing
failure that falls back to a verified backup destination, a payout to an
unverified seller that must be refused, and a country closed in data that
disappears from checkout with no redeploy.

The whole of it is written out in order in
`payhold-backend/scripts/sandbox-walkthrough.md`, and each part names the
`launch_checklist` item it signs off. It is not automated on purpose: half of it
is watching what happens on a provider's own dashboard, and a script that could
green-light itself is the thing the launch gate exists to prevent.

## The launch gate (spec §16, §17)

**PayHold cannot take live money yet, and that is enforced rather than
remembered.** §16's checklist — legal entities, provider contracts, seller and
buyer terms, a sanctions process, a chargeback process, an incident-response
plan, and **written provider confirmation for marketplace payouts in each of
Rwanda, the UAE, Mainland China and the United States** — is rows in
`launch_checklist`, and `POST /v1/provider-accounts` refuses `mode: "live"`
while any required item is outstanding. There is exactly one writer of
`tenant_provider_accounts`, so one check is the whole gate.

Most items are **attestations**: a person states that a thing was done, with
their name and a pointer to the evidence, exactly like `verify_seller`. No code
can check whether a lawyer incorporated a company. The rest are **engineering**
items whose acceptance is code, and those whose code is missing carry
`blocked_by` — which makes them unsignable by anybody, whatever their authority.
Clearing one is a row changed by the phase that does the work.

A sign-off is an **event**, and the state is the latest one. Withdrawing is a
new row saying so rather than an update, for the reason a ledger correction is
an opposite entry: "who said this was fine, and when did they stop saying it" is
exactly the question asked after something goes wrong.

`GET /v1/launch` reads the list and `POST /v1/launch/:code/sign-off` signs one.
Both are **PayHold staff only** — `platform_admins`, a separate axis from tenant
role — and refuse an API key outright. A tenant `owner` is the most senior
person inside one company; whether PayHold may take live money is not their
statement to make.

**`rails_verified` is derived from this**, per market on the payout branch of
`/v1/payment-options` and across all four elsewhere. A market with no
confirmation item is unverified, which is the right answer for every country
outside the four.

§17's non-goals are **not** rows here — they are prohibitions rather than tasks,
nothing about them gets signed, and each is refused by something structural: an
unbuilt adapter that cannot be enabled, the eligibility gate, a not-null
`tenant_id` on every credential and every ledger entry, and
`paid_needs_a_provider_reference`, which makes "no manual mark-as-paid control
**anywhere**" a constraint rather than a convention — a payout can only be
marked paid by quoting the rail's own reference for the transfer.
`payhold-backend/tests/launch-gate.test.ts` pins each one where it binds.

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
