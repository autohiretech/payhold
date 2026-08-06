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
npx supabase functions deploy account deals payment-options sellers balance \
                              payouts risk-signals webhook-endpoints \
                              flutterwave-webhook provider-accounts \
                              webhook-dispatch reconcile auto-release \
                              payout-dispatch ai-dispute ai-risk-narrator \
                              ai-support ai-decisions
```

`deno` must be on `PATH` (`~/.deno/bin` on this machine).

## Deploying

`.github/workflows/deploy-backend.yml`. **Supabase, not Cloudflare** — the
money engine is SQL running inside Postgres transactions with row locks, and
RLS is what keeps one tenant out of another's rows. Workers has neither.

Functions redeploy on a push to `main` that touches `supabase/functions/`, but
only after the SQL and Deno suites pass. They all deploy together so a change
in `_shared/` cannot land in one function and not another — which means a new
function is three edits, not one: the directory, the `[functions.*]` block in
`config.toml`, and the deploy list in the workflow. A function missing from
either list is a function the gateway rejects or CI never ships.

**Migrations do not run on push.** `db push` is forward-only and runs against
the database holding real money; on every merge, that is how a lock on `deals`
arrives during business hours. Run the workflow by hand with the `migrate`
input, having read `supabase migration list` in the job output first.

GitHub secrets: `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF`
(`mwnbjjlilqrwdmwutbxr`), and `SUPABASE_DB_PASSWORD` for migrations only.

The **function** secrets stay out of GitHub entirely — set once with
`npx supabase secrets set`. `CREDENTIALS_KEY` decrypts every tenant's provider
credentials and every webhook signing secret; it has no business in a CI
environment or a build log.

## The v1 endpoints

| Function | Serves |
|---|---|
| `account` | `/signup` creates a company and its first owner; `/me` turns a session into a tenant and a role |
| `deals` | create, list, get, `/pay`, `/confirm`, `/refund`, `/deposit`, `/capture`, `/release-deposit` |
| `payment-options` | what a buyer in a market can pay with; the catalogue a client renders its checkout from |
| `sellers` | register a tokenized payout destination, list |
| `balance` | four buckets per currency, or `?by=rail` |
| `webhook-endpoints` | register (secret shown once), list, `?deliveries=1`, disable |
| `flutterwave-webhook` | inbound, at `/flutterwave-webhook/:tenant` |
| `provider-accounts` | bring-your-own-keys |
| `payouts` | list, get with signals, `/approve-review`, `/retry` |
| `risk-signals` | what the deterministic rules noticed, filterable; `?context=1` for where payments came from |
| `webhook-dispatch`, `reconcile`, `auto-release`, `payout-dispatch` | cron only, `CRON_SECRET` |
| `ai-dispute`, `ai-risk-narrator`, `ai-support` | draft a resolution, brief a payout, answer a question. These run as `payhold_ai` and never hold the service role |
| `ai-decisions` | approve or reject a draft; `?usage=1`, `?outcomes=1`. The one AI-adjacent function that *does* hold the service role, because approving is what moves money |

`resolveCaller` takes either an `X-Api-Key` or a dashboard JWT, key first. Every
handler filters on the tenant it resolves, and a row belonging to someone else
is a 404 — a 403 would confirm it exists.

## Getting in

**Signing in does not go through an Edge Function.** The dashboard posts to
Supabase Auth's `/auth/v1/token` and holds the JWT; `resolveCaller` verifies it
on every subsequent call. A sign-in proxy of our own would route every password
in the system through code we maintain, for no check GoTrue does not do.

Signup is the exception, and `functions/account/` exists for exactly one reason:
two things must happen together and a browser can only do one of them. The auth
user is Supabase Auth's; the `tenant_users` row that makes them a *PayHold* user
is ours, and that table has no insert policy — deliberately. So the service role
does both here.

They are not one transaction and cannot be — different schemas behind different
APIs — so the auth user is deleted if the tenant link fails. A half-made signup
would hold the email address hostage against the retry.

Three things worth knowing before changing it:

- **The first person in is the `owner`.** Somebody has to be able to connect a
  payment rail and clear a payout a risk rule held, and there is nobody else.
- **Passwords are 12 characters minimum**, in the function and in
  `config.toml`'s `minimum_password_length`. A dashboard session reads every
  deal, payout and ledger entry a company has; GoTrue's floor of six is not a
  boundary worth putting in front of that.
- **Addresses are confirmed on creation**, because this project has no SMTP
  sender. Requiring confirmation without a way to send it would lock out every
  account it created. Turning on `auth.email.enable_confirmations` plus an
  `[auth.email.smtp]` block is the production follow-up, and until it happens
  a signed-up address is unproven.

There is no invitation path yet: a second person joining an existing company has
nowhere to be created from. Until there is, one company means one login.

The acceptance spec is `payhold-dashboard/src/auth/mock.test.ts` — same
arrangement as the money paths, where the mock's tests are the backend's.

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
| `ANTHROPIC_API_KEY` | the Intelligence layer's model key. Unset switches §12 off cleanly — the AI endpoints answer 422 and every money path is untouched. |
| `SUPABASE_JWT_SECRET` | the project's JWT secret, used to mint the short-lived `payhold_ai` token in `_shared/ai-db.ts`. Also required for §12, and for the same reason it has no fallback: falling back would mean running the AI layer with the service role. |

Set with `npx supabase secrets set NAME=value`. Generate the master key with
`openssl rand -base64 32`. Nothing falls back to a default — a missing
`CREDENTIALS_KEY` throws rather than silently encrypting with something
guessable, and a missing `ANTHROPIC_API_KEY` or `SUPABASE_JWT_SECRET` refuses
the AI call rather than reaching for a wider credential.

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

## Intelligence: invariant 9 as a grant list

`20260806000004_intelligence.sql` is where §12 stops being a promise. The three
drafting functions connect as **`payhold_ai`**, a Postgres role with `select` on
the case-file tables, `insert` on `ai_suggestions`, `ai_chat` and `audit_log`,
and execute on nothing that moves money. `_shared/ai-db.ts` mints a 60-second
HS256 token carrying `role: payhold_ai` and a `tenant_id` claim; the policies
read the tenant from the token, so a query that forgets its filter returns
nothing rather than everything.

That is the part worth defending in review. "The AI must not call `release_deal`"
as a convention survives until someone adds a line to a file whose header they
did not read; as a grant, Postgres refuses it. `tests/intelligence.test.ts`
asserts the refusal for all nine money functions, and that the role cannot read
an API key hash or a provider credential.

`decide_ai_suggestion` is the single bridge across. It locks the suggestion
`for update`, requires a `decided_by`, and only reaches `resolve_dispute` for an
approved `dispute_resolution` of `release` or `refund`. A rejection, an approved
`escalate`, and every risk summary write their row and stop. The endpoint in
front of it (`ai-decisions`) is a separate deployment holding the service role,
and it takes the approver from the session rather than the request body — a
client that can name its own approver can forge an approval.

Two smaller decisions worth knowing:

- **`deal_outcomes` is written by triggers on the money path**, not by anything
  AI. The labels §12.4 will train on have to cover resolutions no model saw, or
  the eventual fraud model learns from a biased sample. Same reasoning as
  `enqueue_webhooks`: a label that every future code path must remember is a
  label that will be forgotten.
- **The dispute statement is wrapped as an untrusted document.** It is written
  by a member of the public and it is *about* the question we are asking, which
  makes it the injection surface. `untrusted()` frames it as evidence rather
  than instructions — and invariant 9 is why a successful injection costs a
  wasted click rather than money.

The corpus in `_shared/ai-docs.ts` is the operations guide of §11. A passage
that lives somewhere else is a passage that describes last quarter's product.
`ai.test.ts` asserts no passage and no prompt uses the regulated word.

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

## Sending a payout

`_shared/dispatch.ts` is the single implementation, shared by the
`payout-dispatch` cron and `payouts/:id/approve-review`, so that approving
cannot become a route which skips a check the cron makes. Its order is the
safety argument: **frozen tenant → `screen_payout` → provider → book.**

Provider before booking is deliberate. A transfer that succeeded but was not
booked is re-sent next pass on the same `idempotency_key`, the provider returns
the same transfer, and it books then. Booking first would report a seller paid
who was not.

`held_for_review` is absent from `DISPATCHABLE` and must stay absent — cron may
never be the thing that lets a held payout through. The approve endpoint also
**refuses an API key**: invariant 11 wants a person, and a client that could
approve its own held payouts from its own server has turned the rules into a
formality.

**How much leaves is not a conversion of `payouts.amount`.** `amountLeaving`
reads the deal's clearing pool back off the ledger, because `rail_balances`
derives that pool as `−release + fee + payout` and any other figure leaves a
permanent residue in `available` — which the reconciliation pass reads as drift,
freezing the tenant over a rounding error. The two numbers agree only when no
conversion happened, so a same-currency test cannot catch this;
`tests/payout-dispatch.test.ts` carries the cross-border case.

Async rails settle later: `FlutterwaveProvider.release` returns `pending` for
anything not terminal, which becomes `processing` via `mark_payout_processing`
(migration `20260806000003`). A later pass re-sends on the same idempotency key
— a poll, not a second transfer — and books when the provider reports it
settled.

## The auto-release timer

`auto-release` has no release path of its own. It writes the missing
confirmations with `actor = 'auto'` and lets `confirm_deal` release, so the
timer goes through the same row lock and the same both-confirmations re-check as
a human confirmation and cannot drift from it. A side that really confirmed
keeps its `user` actor, so the audit trail still tells a buyer who agreed from
one who went quiet.

A frozen tenant is **not** skipped: releasing moves money between our own
buckets and sends nothing, and the freeze stops the payout in `dispatchPayout`.
A suspended tenant is skipped. Disputed deals are excluded by the query and
refused again by `confirm_deal` under the lock.

Two overlapping passes are safe: the second gets `can no longer be confirmed`
from the lock, which the function reads as "already released" rather than an
error.

## Scheduling the cron jobs

`scripts/schedule-cron.sql`, run by hand against the linked project. It is
**not** a migration and must not become one: `pg_cron` does not exist in PGlite,
so a migration creating schedules would fail the local harness on every run —
and which environment runs the jobs is a deploy concern rather than a schema
one. `cron.schedule` replaces a job of the same name, so the script is
re-runnable.

```
psql "$SUPABASE_DB_URL" -f scripts/schedule-cron.sql
```

Set the secret once with `alter database postgres set payhold.cron_secret = '…'`,
matching the `CRON_SECRET` function secret. Keep it out of the script and out of
git.

The times are staggered, and the order is the point: **reconcile :00 →
auto-release :10 → payout-dispatch :20.** Reconciliation goes first because
drift freezes payouts, and a dispatch that ran before it would send money out of
a balance we already know we cannot explain. Webhook delivery runs every minute,
independent of all of it — the retry backoff assumes a pass at least that often.

One trap when checking on them: `net.http_post` returns a request id
immediately, so a `cron.job_run_details` row saying "succeeded" means the
request was *queued*, not that the function returned 200. The status codes are
in `net._http_response`.

## Not built yet

- **The reminders cron.** The one scheduled job still missing. It needs a
  channel to remind people *on* — there is no email path here, and a tenant
  webhook is a notification to the client's server rather than to a buyer who
  has gone quiet — so it is a decision before it is a function.
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
- **Invitations.** `POST /account/signup` creates a company and its owner;
  there is no path for a second person to join one that exists. `tenant_users`
  already carries `staff` and `viewer`, so this is an endpoint and an email,
  not a schema change.
- **Password reset.** GoTrue does it, and it needs the same SMTP sender email
  confirmation is waiting on.
- The dashboard still runs on its mock, except for Intelligence: `AiHttpClient`
  (`src/api/http-ai.ts`) is the first slice of `HttpClient` and covers the eight
  AI methods behind `VITE_PAYHOLD_AI_LIVE`. The rest is still one file plus one
  line in `src/api/index.ts`. Its sign-in is already real code against
  `functions/account/` — `src/auth/supabase.ts` — behind the same env switch.
- **Dispute evidence.** `disputes` carries a reason and nothing else: no
  evidence table, no counter-statement column. The dashboard mock models both,
  and §12.2 says the assistant reads them, so `disputeCaseFile` is thinner than
  it should be. Adding those columns is the next thing that improves a draft,
  and it bumps `dispute-assistant@1`.
- **Shadow mode.** The working agreement says a new prompt ships with its
  suggestions logged and not shown, compared against the humans' actual
  decisions, then enabled per tenant. `ai_suggestions` records everything
  needed for that comparison; what is missing is the flag that hides a draft
  from the queue while it accumulates.
- **Live model calls are unexercised**, the same way Flutterwave's are. Every
  test runs against the validators, the corpus and PGlite; nothing in CI calls
  Claude, and nothing should.

The acceptance spec for all of it is
`payhold-dashboard/src/api/mock/engine.test.ts` — reproduce every one of those
invariants here.
