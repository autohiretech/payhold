# payhold-backend

Supabase: Postgres + Auth + Edge Functions + cron. **All money logic and every
provider secret live here.** Nothing else in the world can move funds.

See `../CLAUDE.md` for the rules that bind both repos (the language rule, the
money invariants, the API contract).

Linked project: `mwnbjjlilqrwdmwutbxr` (PayHold, us-west-1, Postgres 17).

```
npm test                     # everything below
npm run test:sql             # schema invariants against PGlite — no Docker needed
npm run test:functions       # Deno tests for crypto and the providers
npm run typecheck            # deno check across the functions
npx supabase db push         # apply migrations to the linked project
npx supabase functions deploy provider-accounts
```

Two test runners, deliberately: the migrations are exercised from Node (PGlite
is a Node module), the Edge Functions from Deno (they use `Deno.env`, `jsr:`
imports and the Deno Web Crypto surface). Vitest is scoped to `tests/` so it
never tries to run a `Deno.test` file.

## Secrets this project needs

| Secret | Why |
|---|---|
| `CREDENTIALS_KEY` | base64 of 32 random bytes. Encrypts every tenant's provider credentials. **Losing it means every tenant must re-enter their keys.** |
| `DASHBOARD_ORIGIN` | comma-separated origins allowed to call the API from a browser |
| `PUBLIC_URL` | where buyers are sent to pay |

Set with `npx supabase secrets set NAME=value`. Generate the master key with
`openssl rand -base64 32`. Nothing falls back to a default — a missing
`CREDENTIALS_KEY` throws rather than silently encrypting with something
guessable.

## The database is the money engine

Money logic lives in SQL functions (`migrations/…_money.sql`), not in
TypeScript. This is deliberate. The invariants the spec demands are
transactional ones: `SELECT ... FOR UPDATE` around the both-confirmations check
only means something inside the transaction that then writes the release. An
Edge Function that reads, decides, and writes over three round trips has a race
between every pair.

The division of labour:

| SQL owns | TypeScript owns |
|---|---|
| atomicity, row locks, guards | FX rates, fee policy |
| the ledger and audit writes | provider API calls |
| the balance derivation | signature verification |
| idempotency constraints | request auth and shaping |

So converted figures are **passed in already computed** — `release_deal` takes
the payout amount and the presentment-currency fee rather than deriving them.
There is exactly one FX table in the system and it is not in the database.

Every money function is `security definer` and revoked from `anon` and
`authenticated`. They are reachable only by the service role, i.e. only from an
Edge Function.

The AI layer (root spec §12) sits outside this boundary on purpose: it reads
with a scoped read role and never holds the service role, so no model output can
reach `release_deal`, `confirm_deal`, `refund_deal` or `settle_payout`. What it
writes is `ai_suggestions`; a human approval is what calls the money function.

## RLS: read your tenant, write nothing

Dashboard sessions get `select` on their own tenant's rows and no write policy
at all. The **absence** of insert/update/delete policies is the security
control, not an oversight — every write goes through an Edge Function using the
service role, which bypasses RLS.

Two things RLS cannot do on its own, handled with column grants:

- `api_keys.key_hash`, `webhook_endpoints.secret_encrypted` — revoked at the
  column level, so even the owning tenant cannot read them back.
- `tenant_provider_accounts` — no select policy at all. The table is invisible
  to sessions; only the service role can decrypt inside a function.

`ledger` and `audit_log` are append-only, enforced by a trigger that rejects
update and delete. A correction is a new, opposite entry.

## Testing without Docker

There is no Docker on the dev machine, so `supabase start` does not run.
`tests/harness.ts` boots **PGlite** (Postgres 17 in WASM) and applies the real
migrations to it. A migration that passes there is one that parses, and a
`FOR UPDATE` guard that holds there holds in Supabase.

What PGlite is *not* is Supabase. The harness shims `auth.users`, `auth.uid()`
and the `anon`/`authenticated`/`service_role` roles. So RLS policies are parsed
and planned locally but **their end-to-end behaviour is only proven against the
real project** — that check belongs in the sandbox walkthrough, not here.

`auth.uid()` reads a session GUC in the shim rather than a JWT claim, which is
what lets a test say "now I am this user" without minting tokens.

## Enums sort by declaration order

`order by entry_type` on an enum column sorts by the order the type declares
its values, not alphabetically. Anything comparing against the dashboard's
ordering must `order by …::text`. This has already caused two wrong test
expectations; assume it will cause more.

## Providers

`functions/_shared/provider.ts` is the one interface all rails sit behind.
**No caller may branch on `provider.name`** — route by capability, not
identity. `FlutterwaveProvider` is not "the African one", it is what
`payoutRail()` returns for that corridor.

`FakeProvider` is not a test double bolted on for convenience: §12 requires a
full lifecycle with zero keys, so it is the rail a fresh tenant runs on until
they bring their own. It fakes the counterparty and **nothing else** — a fake
charge is still webhooked in, still matched on amount and currency, still
confirmed twice before it releases. Its `verifySignature` still rejects an
unsigned webhook, because the forged-webhook test must 401 on every rail.

## Bring-your-own-keys

Each tenant connects their **own** Flutterwave/Stripe account. Buyer money
lands in that company's balance, not a PayHold-owned one — PayHold orchestrates
the hold and never custodies the funds. This was a deliberate choice over
pooled keys: pooling would put every tenant's buyer money in PayHold's own
balance, which is the regulated custody activity the language rule already
steers around.

`functions/provider-accounts/` is the whole path. Three rules it enforces:

1. **Validated before stored.** The credentials are used to call the provider
   (`/balances`) before anything is written. Storing unvalidated keys moves the
   failure to the first real charge, in front of a buyer.
2. **Test/live mismatch refused.** A live secret key submitted as "test" is
   rejected — that combination would move real money during the sandbox
   walkthrough.
3. **Disconnect blocked while money is in flight.** Without credentials no
   payout could be sent and no refund issued, so the deals would be stranded.

Credentials go in and never come out. There is no endpoint returning them in
any form; the only reader is `loadProvider`, which hands back a
`PaymentProvider` interface rather than a key. A tenant with no row falls back
to `FakeProvider`, which is how demo mode stays true.

## Not built yet

- Edge Functions for the v1 endpoints (§4) — `provider-accounts` is the only
  one deployed so far
- Inbound provider webhooks — signature + re-verify
- `StripeProvider` (`FlutterwaveProvider` is written; its live calls are
  unexercised until real keys are connected)
- Cron jobs: auto-release, clearance → payout, reminders, reconciliation
- Seed: AutoHire as tenant #1

The acceptance spec for all of it is
`payhold-dashboard/src/api/mock/engine.test.ts` — reproduce every one of those
invariants here.
