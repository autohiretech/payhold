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

Two separate repos, deployed independently. The dashboard is a *client of the
public API* — it holds no secrets and has no direct database write access.

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

## Secrets and PII

Provider credentials encrypted at rest in `tenant_provider_accounts`. API keys
hashed at rest (compare by hash, never store plaintext). PayHold never stores
raw card numbers or full MoMo numbers — provider tokenization only. 3DS is
requested on all card charges.

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
`ai_risk_narrator`.

In-flight deals keep the settings they were created with. Settings changes apply
to new deals only.

## Public API v1

Auth: `X-Api-Key`, hashed at rest, rate-limited per key.

| Endpoint | Purpose |
|---|---|
| `POST /v1/deals` | Create deal → returns deal id + payment link |
| `GET /v1/deals/:id` | Full status, timestamps, amounts |
| `POST /v1/deals/:id/confirm` | `side=buyer\|seller` + end-user token; both → atomic release |
| `POST /v1/deals/:id/refund` | Client-initiated, pre-release, policy-checked |
| `POST /v1/deals/:id/deposit` `/capture` `/release` | Card pre-auth deposit lifecycle |
| `POST /v1/sellers` | Register payout destination → tokenized beneficiary |
| `GET /v1/balance` | held / pending clearance / available / paid out |
| `POST /v1/webhooks-endpoints` | Client registers their endpoint for signed notifications |
| `/webhooks/flutterwave/:tenant` `/webhooks/stripe/:tenant` | Inbound provider webhooks |

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
  split) with the events it cited. An admin approves; the approval executes.
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

Prompts see one tenant's data only. No raw card or full MoMo numbers in these
tables. The language rule binds model output too.

## Cron jobs

Auto-release timer · clearance → payout dispatch · reminders ·
ledger-vs-provider reconciliation (mismatch → **freeze that tenant's payouts**
until resolved).

## Testing gate before any live traffic

Full sandbox walkthrough, all of it: pay (test card + test MoMo) → held →
confirm ×2 → release → clearance → payout; refund path; timer path; and a
forged-webhook test that **must** return 401.

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
