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
npx supabase functions deploy deals payment-options sellers balance \
                              webhook-endpoints flutterwave-webhook \
                              provider-accounts webhook-dispatch reconcile
```

`deno` must be on `PATH` (`~/.deno/bin` on this machine).

## The v1 endpoints

| Function | Serves |
|---|---|
| `deals` | create, list, get, `/pay`, `/confirm`, `/refund`, `/deposit`, `/capture`, `/release-deposit` |
| `payment-options` | what a buyer in a market can pay with; the catalogue a client renders its checkout from |
| `sellers` | register a tokenized payout destination, list |
| `balance` | four buckets per currency, or `?by=rail` |
| `webhook-endpoints` | register (secret shown once), list, `?deliveries=1`, disable |
| `flutterwave-webhook` | inbound, at `/flutterwave-webhook/:tenant` |
| `provider-accounts` | bring-your-own-keys |
| `webhook-dispatch`, `reconcile` | cron only, `CRON_SECRET` |

`resolveCaller` takes either an `X-Api-Key` or a dashboard JWT, key first. Every
handler filters on the tenant it resolves, and a row belonging to someone else
is a 404 — a 403 would confirm it exists.

**The funding path is four steps and none of them are optional.** `POST /deals`
creates it, `POST /deals/:id/pay` starts the charge on the rail the buyer's
method implies (this is where a provisional Flutterwave deal becomes a Stripe
deal), the provider redirects the buyer, and their webhook is what moves the
deal to `funded_held` — after `flutterwave-webhook` checks the `verif-hash`
*and* re-fetches the transaction. Starting a charge is not evidence one
succeeded, so nothing about the deal's state changes at step two.

The amount comparison lives in `fund_deal`, not in TypeScript, because
"mismatch → disputed, never funded_held" is only a guarantee when the
comparison and the state write share a transaction. A mismatch still books the
hold for what actually arrived: the money genuinely reached the provider, and
omitting the entry would hand the reconciliation pass a drift nobody could
explain.

## One registry, two repos

`_shared/countries.ts` is generated — by `payhold-dashboard/scripts/gen-countries.py`,
which writes **both** copies. Do not edit either by hand; edit the generator and
re-run it. The backend copy widens `Country` and `Currency` to `string`,
matching `types.ts`, and validates membership at the edge.

`_shared/rails.ts` is the routing built on top of it, and is the deliberate
mirror of `payhold-dashboard/src/lib/rails.ts` — same rule as `types.ts`, a
change to either is a change to both in the same commit.

Two test runners, deliberately: the migrations are exercised from Node (PGlite
is a Node module), the Edge Functions from Deno (they use `Deno.env`, `jsr:`
imports and the Deno Web Crypto surface). Vitest is scoped to `tests/` so it
never tries to run a `Deno.test` file.

## Secrets this project needs

| Secret | Why |
|---|---|
| `CREDENTIALS_KEY` | base64 of 32 random bytes. Encrypts every tenant's provider credentials **and** their webhook signing secrets. **Losing it means every tenant must re-enter their keys and re-register their endpoints.** |
| `DASHBOARD_ORIGIN` | comma-separated origins allowed to call the API from a browser |
| `PUBLIC_URL` | where buyers are sent to pay |
| `CRON_SECRET` | sent by pg_cron as `x-cron-secret`. The scheduled jobs are not tenant-scoped, so no API key may trigger them. Unset means they refuse every caller. |

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

## Outbound webhooks are queued by triggers, not by the money functions

`enqueue_webhooks` is called from triggers on `deals`, `confirmations`,
`disputes`, `payouts` and `ledger` — see migration `20260806000001`. The money
functions do not mention notifications at all.

The tradeoff, stated plainly: reading `release_deal` no longer tells you that a
client gets told. In exchange, the notification cannot be forgotten by a new
code path — including a manual correction someone runs by hand at 2am — and
adding one line to nine functions does not mean restating nine function bodies
in every future migration. Enqueue is still inside the same transaction as the
state change, which is the property that actually matters.

Delivery is deliberately *not* in that transaction. `webhook-dispatch` claims a
batch with `for update skip locked`, signs each with the endpoint's decrypted
secret, POSTs it, and records the outcome. A client's server being down can
never fail a release.

**Signing secrets are encrypted, not hashed** (`sealWebhookSecret` /
`openWebhookSecret`). An API key is only ever compared, so hashing it is
strictly safer; a signing secret has to be *used* on every delivery.
`crypto.test.ts` pins the exact header bytes against a digest computed
independently, and the dashboard mock pins the same construction from the other
side — a client who develops against the mock must not break on the real API.

## Risk rules live in SQL

`screen_payout` implements them, for the same reason the release guard does: it
must run in the transaction that then holds the payout. It can set
`held_for_review` and nothing else — no ledger write, no transfer, no state
change to the deal. `approve_payout_review` is the only way out, and it takes
the approver's name because the audit row is about a person's decision.

The payout dispatch cron must call `screen_payout` before it calls the
provider. That job is not written yet; when it is, that ordering is the point.

## Scheduling the cron jobs

There is no migration for this. `pg_cron` does not exist in PGlite, so a
migration creating schedules would fail the local harness on every run — and
scheduling is a deploy-environment concern rather than a schema one.

Against the linked project:

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule('payhold-webhooks', '* * * * *', $$
  select net.http_post(
    url := 'https://mwnbjjlilqrwdmwutbxr.supabase.co/functions/v1/webhook-dispatch',
    headers := jsonb_build_object('x-cron-secret', current_setting('payhold.cron_secret'))
  );
$$);

select cron.schedule('payhold-reconcile', '0 * * * *', $$
  select net.http_post(
    url := 'https://mwnbjjlilqrwdmwutbxr.supabase.co/functions/v1/reconcile',
    headers := jsonb_build_object('x-cron-secret', current_setting('payhold.cron_secret'))
  );
$$);
```

Set the secret once with `alter database postgres set payhold.cron_secret = '…'`,
matching the `CRON_SECRET` function secret. Keep it out of the migration files.

## Not built yet

- **Cron jobs: auto-release and clearance → payout dispatch.** The two that
  actually move money on a timer, and the largest remaining gap. The payout one
  must call `screen_payout` before it calls the provider. Reminders too.
- **End-user tokens.** Spec §4 has `confirm` taking one, so a buyer can confirm
  without the client's API key. Today `/pay` and `/confirm` are called by the
  client's server on the buyer's behalf.
- **`StripeProvider`** — `loadProvider` throws for it rather than falling back
  to the fake, because a deal routed to Stripe that silently collected nothing
  would be worse than a loud failure.
- **Stripe's inbound webhook.** `flutterwave-webhook` is the pattern to follow.
- `FlutterwaveProvider`'s live calls are unexercised until real keys are
  connected — every test to date runs against `FakeProvider` or PGlite.
- Seed: AutoHire as tenant #1.
- The dashboard still runs on its mock; `HttpClient` is one file plus one line
  in `src/api/index.ts`.

The acceptance spec for all of it is
`payhold-dashboard/src/api/mock/engine.test.ts` — reproduce every one of those
invariants here.
