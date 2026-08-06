# PayHold

Standalone payment-hold product. Independent backend + dashboard. AutoHire
(autohiretech.pages.dev) is tenant #1 — a client like any other, with no special
access. Rails: Flutterwave (launch) and Stripe (international cards).

Source of truth for requirements: `PayHold_Standalone_Spec_V1.docx` (Standalone
Edition, V1). This file is the working summary — if the two disagree, the spec
wins and this file gets fixed in the same commit.

## Language rule (non-negotiable)

Never write the word **escrow** in anything user-facing, public, or
marketing-adjacent — it is a regulated term. Use **"payment hold"** or
**"buyer protection"**. Internal code comments and variable names should follow
the same habit so nothing leaks by copy-paste.

## Layout

```
PayHold/
├── payhold-backend/     Supabase project mwnbjjlilqrwdmwutbxr — schema live,
│                        Edge Functions + cron still to build
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

## Deal lifecycle

```
created → funded_held → confirmed_buyer / confirmed_seller → released
                                                           → paid_out
        ↘ refunded        ↘ disputed
```

**Refunds are all-or-nothing in v1.** There is no partial-refund primitive, and
that is a design decision rather than an omission: it is why the dispute
assistant returns `escalate` instead of a split, and why `refund_deal` takes a
reason and no amount. Anything describing PayHold as doing "full/partial"
refunds is wrong and should be corrected to "full refunds". (Security deposits
*are* partially capturable — that is `capture_deposit`, a different thing.)

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
    a hold, and the approval is recorded against them.

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
(default 7), `auto_release_days` (default 3), `currencies`, `ai_enabled`
(default true), `ai_monthly_budget_usd`, `ai_dispute_assistant`,
`ai_risk_narrator`, `risk_rules_enabled` (default true),
`risk_review_threshold_usd` (default $1,000, converted to the payout currency
at compare time).

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
| `POST /v1/payouts/:id/approve-review` | Clear a risk hold. Person-only, audited against them |
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
  the full deal history; drafts a suggested resolution (refund / release, or
  "needs a person" — there is no split, since v1 has no partial refund) with
  the events it cited. An admin approves; the approval executes.
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
