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
npx supabase functions deploy account deals checkout payment-options sellers \
                              balance ledger audit-log payout-routes settings \
                              api-keys admin \
                              payouts risk-signals disputes launch webhook-endpoints \
                              flutterwave-webhook stripe-webhook provider-accounts \
                              webhook-dispatch reconcile auto-release \
                              settle-pending \
                              payout-dispatch ai-dispute ai-risk-narrator \
                              ai-support ai-decisions
```

`deno` must be on `PATH` (`~/.deno/bin` on this machine).

**Both Deno scripts pass `--config supabase/functions/deno.json`, and must.**
Deno looks for its config from the *working directory*, not from the files named
on the command line, and these run from the project root — where there is no
`deno.json`, only `package.json`. Without the flag Deno never sees
`nodeModulesDir: "auto"`, never installs `npm:@supabase/supabase-js@2`, and
fails on the first `_shared` file that imports it.

This passed locally for a long time while failing every CI run, and the reason is
worth knowing: `supabase/functions/node_modules` is gitignored, so a dev machine
that had once resolved those imports kept a directory a fresh checkout never has.
A green local run is not evidence here — check against a clean copy.

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
| `deals` | create (with §14's `completion_policy`), list, get, `/pay`, `/confirm`, `/refund`, `/deposit`, `/capture`, `/release-deposit` |
| `checkout` | §10.1's sessions. `/sessions` for the client's server; `/public/:token` for the buyer, with no credential |
| `payment-options` | what a buyer in a market can pay with; the catalogue a client renders its checkout from |
| `sellers` | register (destination optional), list (`?external_user_id=` finds the client's own handle), `/wallets`, `/:id/capabilities`, `/:id/balance`, `/:id/withdraw`, `/:id/verify` (person-only), `/:id/active` (status only, no payout effect), `/:id/destinations` and `/:id/destinations/:id/end-hold` (person-only), `/:id/connect/onboard` and `/:id/connect/status` (Stripe Connect onboarding — see below) |
| `balance` | four buckets per currency, or `?by=rail` |
| `ledger` | the entries behind those buckets, filterable by deal. No writer, on any method |
| `audit-log` | who did what, including every act that moved no money |
| `payout-routes` | §5.1's table: the platform's rows plus this tenant's overrides. Read-only |
| `settings` | §8's per-tenant settings, `GET` and `PATCH`. Refuses an API key on the write |
| `api-keys` | issue, list and revoke the credential a client's server holds. Session only, and the plaintext is returned exactly once |
| `admin` | the master-admin console: tenants, drift cases, §13's runs, run-now, sign-off, freeze and unfreeze. `platformAdminFromJwt`, and the only function whose reads are not tenant-scoped |
| `webhook-endpoints` | register (secret shown once), list, `?deliveries=1`, disable |
| `flutterwave-webhook` | inbound, at `/flutterwave-webhook/:tenant` |
| `stripe-webhook` | inbound, at `/stripe-webhook/:tenant`. The same five steps, with a real HMAC instead of a shared secret |
| `provider-accounts` | bring-your-own-keys. **The one door live credentials come through**, and where §16's gate is asked |
| `launch` | §16's checklist and its sign-offs. PayHold staff only, and it refuses an API key |
| `payouts` | list, get with signals **and the routing decision and display status**, `/hold`, `/approve-review`, `/retry` |
| `risk-signals` | what the deterministic rules noticed, filterable; `?context=1` for where payments came from |
| `disputes` | §8's Resolution Center. Open, list, get with offers/evidence/timeline, `/offers`, `/offers/:id/respond`, `/offers/:id/withdraw`, `/evidence`, `/export`, and `/resolve` (person-only) |
| `webhook-dispatch`, `reconcile`, `auto-release`, `payout-dispatch` | cron only, `CRON_SECRET` |
| `settle-pending` | cron only. Asks each rail about charges that started and never landed, and funds the ones that did — the backstop under both inbound webhooks |
| `ai-dispute`, `ai-risk-narrator`, `ai-support` | draft a resolution, brief a payout, answer a question. These run as `payhold_ai` and never hold the service role |
| `ai-decisions` | approve or reject a draft; `?usage=1`, `?outcomes=1`. The one AI-adjacent function that *does* hold the service role, because approving is what moves money |

`resolveCaller` takes either an `X-Api-Key` or a dashboard JWT, key first. Every
handler filters on the tenant it resolves, and a row belonging to someone else
is a 404 — a 403 would confirm it exists.

`launch` and `admin` are the exceptions and use `platformAdminFromJwt` instead. A third
caller kind rather than a variation on the other two: a tenant `owner` is the
most senior person *inside one company*, and whether PayHold may take live money
is not their statement to make. `platform_admins` is the separate axis the RLS
layer already draws for exactly this, and a caller who is not on it gets the same
404 as a caller who is nobody.

## The six functions the cut-over needed

The dashboard used to serve settings, API keys, the ledger, the audit log, the
routing table and the whole admin console from its own mock. Deleting the mock
meant building them, and four of the six are a select with a tenant filter.
The two that are not are worth reading before changing.

### `settings`, and why a flag is stored as a number

`_shared/settings.ts` now carries one spec — every key, its kind, its bounds and
its default — and both views derive from it: `readSettings` for the endpoint,
`loadSettings` for the money paths that need eight of them. There used to be two
lists, and the second went stale exactly as you would expect: `clearance_days`
sat at V1's 7 in TypeScript while every SQL reader had moved to §6.1's 14. A
default nothing reads is a default nobody can catch being wrong.

**A boolean setting is written as `1` or `0`, never as a JSON `true`.**
`setting_num` resolves a value with `(value #>> '{}')::numeric`, so a literal
`false` in that column does not fall back to the default — it raises on the
cast, inside whichever money function asked. `encode` in that file is the only
writer and is where this is enforced; `decode` still reads either form, because
refusing to render a legacy row would make the settings screen unopenable over a
value nothing else reads.

The endpoint refuses an API key on the write path. A client that could set its
own `service_fee_rate` has turned our commission into a field it fills in.

### `admin`, and the second way a freeze is lifted

Every route reads across tenants, which is why they are one function rather than
a few more handlers next to scoped ones — a cross-tenant query in a file whose
neighbours all filter on `caller.tenant_id` is the shape a leak takes.

`reconcileAll` moved to `_shared/reconciliation.ts` so the nightly cron and the
Admin screen's "run now" share one definition of what our books agreeing means.
`reconcile/index.ts` is now the schedule's authentication and nothing else.

**`POST /admin/tenants/:id/unfreeze` is refused while any reconciliation case on
that account is open** — the same condition `resolve_reconciliation_run`
enforces before it lifts one, checked here rather than assumed. Freezing is
arithmetic and automatic; lifting one is a judgement about whether the
difference has been explained, and the only reason this route exists beside the
run sign-off is that a freeze placed by hand has no run to sign off.

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

There is no dashboard-side acceptance spec for this any more —
`src/auth/mock.test.ts` described a simulated sign-in and went with it. The
sandbox walkthrough covers the way in end to end: sign up, land in an empty
company, sign out, sign back in, and prove that a call with no bearer token is
401 and one carrying another company's session returns that company's nothing.
RLS is only provable against the real project, so that is where the check
belongs.

**The funding path is four steps and none of them are optional.** `POST /deals`
creates it, `POST /deals/:id/pay` starts the charge on the rail the buyer's
method implies (this is where a provisional Flutterwave deal becomes a Stripe
deal), the provider redirects the buyer, and their webhook is what moves the
deal to `funded_held` — after `flutterwave-webhook` checks the `verif-hash`
*and* re-fetches the transaction. Starting a charge is not evidence one
succeeded, so step two moves the deal to `payment_pending` and no further —
§6 gives the attempt a state of its own precisely so it cannot look like money.

The status write happens *after* the provider call returns, not before: a charge
that threw never started, and `/pay` refuses `payment_pending`, so a deal left
in that state by a rail that rejected it would be unretryable. `payment_failed`
is accepted back, which is how a declined card is retried without the client
creating a second deal for the same booking.

**The webhook is the doorbell, not the evidence.** What makes a payment true is
the re-fetch — `provider.verify`, over our own authenticated connection — and
that call does not need to be prompted from outside. `_shared/settle.ts` makes
it on its own, and it has two callers: `POST /checkout/public/:token/confirm`,
which the buyer's page polls while it waits, and the `settle-pending` sweep, for
the buyer who closed the tab. Both run the identical verify and the identical
`fund_deal`, so §15 phase 2 holds exactly as before — no request body can make
either say the money arrived.

This is not belt-and-braces. When the only writer was an inbound POST, an
unregistered webhook URL meant a debited buyer, a deal frozen at
`payment_pending`, no `order.funded_held` ever queued, and a seller who never
learned they had sold anything — with the money sitting at the rail the whole
time. That is a delivery failure presenting as a lost sale, and asking is the
fix for it.

The amount comparison lives in `fund_deal`, not in TypeScript, because
"mismatch → disputed, never funded_held" is only a guarantee when the
comparison and the state write share a transaction. A mismatch still books the
hold for what actually arrived: the money genuinely reached the provider, and
omitting the entry would hand the reconciliation pass a drift nobody could
explain.

## Hosted checkout sessions — §10.1, migration `20260807000012`

One migration, not two: nothing here uses a value from `alter type ... add
value`, and a type created inside a transaction is usable inside it.

**A session is a scoped, expiring credential for one payment on one deal.** It
exists so a buyer can choose a payment method without holding an API key and
without the client's server proxying the choice — and without anyone inventing a
general end-user auth scheme to get there. It is also the first writer
`checkout_started` has ever had.

**Nothing here can fund a deal**, which is §15 phase 2's acceptance criterion and
the whole risk of the phase. Completing a session moves the deal to
`payment_pending` and stops; `funded_held` still comes only from a provider
webhook that checked a signature *and* re-fetched the transaction.
`tests/checkout-sessions.test.ts` asserts that against the function *bodies* —
comments stripped, since the migration explains at length why it does not fund a
deal and matching that prose would pass for the wrong reason.

Four decisions worth knowing:

- **`checkout.completed` is not the funding event.** It says the buyer is done
  with our page; `order.funded_held` says money arrived. One event with a flag
  would let a client ship goods against a card that has not settled.
- **The token is plaintext**, unlike an API key, and the column comment carries
  the argument: a key is only ever *compared* so we never need it back, while a
  payment link must stay re-derivable because re-sending one is ordinary
  support. 256 bits from `gen_random_bytes`, an expiry, and authority over
  exactly one payment — no broader than the deal id that already opens the
  hosted page.
- **Expiry is derived, never stored.** Same reasoning as §5.1's `clearing` and
  `available`: a stored value needs a writer, and the writer would be a sweep
  that had not run yet. `checkout_session_state()` is what every reader goes
  through, so a link is refused from the instant it expires.
- **One live session per deal**, by partial unique index. Two open sessions
  would be two live links against one hold. `open_checkout_session` returns the
  existing one rather than minting a second, which also makes a client retrying
  the call idempotent.

`checkout_started -> created` joined the transition guard — the only backwards
edge in the machine. It means a link was withdrawn, and it is legal precisely
because nothing happened: no provider call, no money, nothing observed outside
this system.

`_shared/checkout.ts` holds `startCharge`, shared by `/deals/:id/pay` and the
hosted route for the reason `_shared/dispatch.ts` is shared by the cron and the
approve endpoint. It re-checks the method against the live capability matrix,
because the hosted call arrives from a browser and a buyer who edited the form
must not reach a rail we switched off.

### `select (fn(...)).*` calls the function once per output column

Found by these tests, and it invalidates more than it breaks. A
composite-returning function expanded that way is evaluated once for *each*
column in the result — so a fifteen-column function is fifteen calls wearing the
shape of one. The checkout tests failed on it immediately (a "cannot be used
twice" case failing on the first call); `tests/payout-routing.test.ts` had the
same shape and passed only because `route_payout` de-duplicates its decision
rows, which means it was never testing what it appeared to.

Use `select * from fn(...)`. Both suites do now.

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
| `ANTHROPIC_API_KEY` | the Intelligence layer's model key. **Unset is demo mode, not off** — `askClaude` answers from `_shared/ai-demo.ts`'s stand-in, so §12 works end to end with zero keys. |
| `AI_JWT_SECRET` | the project's own JWT secret (from the dashboard), used to mint the short-lived `payhold_ai` token in `_shared/ai-db.ts`. **The one secret §12 cannot do without**, and for the reason it has no fallback: falling back would mean running the AI layer with the service role. **Not named `SUPABASE_JWT_SECRET`** — the CLI refuses to set any secret with that prefix, since it is reserved for the values Supabase auto-injects (`SUPABASE_URL`, `SUPABASE_ANON_KEY`, …). |

Set with `npx supabase secrets set NAME=value`. Generate the master key with
`openssl rand -base64 32`. Nothing falls back to a default — a missing
`CREDENTIALS_KEY` throws rather than silently encrypting with something
guessable, and a missing `ANTHROPIC_API_KEY` or `AI_JWT_SECRET` refuses
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

**`aiUsage` reports `configured`, `demo` and `enabled` separately**, for the
reason `provider_capabilities` splits `implemented` and `enabled`: they fail
differently and have different remedies. `configured` is whether this deployment
can reach the `payhold_ai` role at all; `demo` is whether a model is behind the
answers; `ai_enabled` is the tenant's switch; `enabled` is the switch and
`configured` together. One flag meant an unconfigured deployment reported the
same state as a company that had switched the feature off, and the dashboard told
the reader to turn it on in Settings — where the switch was already on and could
not have helped.

### Demo mode is a stand-in model, not a switched-off layer

`_shared/ai-demo.ts` is `FakeProvider`'s counterpart for §12, and the product
rule is the same one: **demo mode with zero keys must work end to end.** With no
`ANTHROPIC_API_KEY`, `askClaude` returns a deterministic answer built from the
real case file the endpoint already assembled, rather than refusing.

Four properties are what make that safe, and all four are load-bearing:

- **The stand-in goes through the same validator.** `askClaude` calls
  `validate(call.demo())`, so a demo citation that does not resolve is dropped
  by `resolvable` exactly as a hallucinated one is, and a demo split past §7.1's
  ceiling is refused exactly as the model's would be.
- **`model` is `demo-stand-in` and `cost_usd` is 0.** No `ai_suggestions` row
  ever implies a model produced it. That column is what keeps §24.4's eventual
  training set filterable — canned rows mixed indistinguishably into a corpus
  that cannot be rebuilt is the one irreversible thing this could have done.
- **`demo` is a required field on `ClaudeCall`,** not an optional one. A new AI
  endpoint that forgot it would bring the refusal back on that one path only.
- **Invariant 9 is untouched.** The stand-in advises, a named person approves,
  and `decide_ai_suggestion` is still the only bridge across. `ai-demo.ts` has
  no database handle.

The dispute stand-in leans to whichever side filed evidence when exactly one
did, splits at `disputed_amount` when only part was disputed — because
`resolve_dispute` refuses a full refund in that case, and a draft nobody can
approve demonstrates nothing — and otherwise `escalate`s, which is the honest
output of a rule that cannot weigh anything. Confidence is 0, and every answer
names itself a stand-in in its own text.

**`AI_JWT_SECRET` has no equivalent and must never get one.** There is no
stand-in for a Postgres role: the only fallback available is the service role,
which is exactly what invariant 9's grant list exists to deny this path. So
`assertAiAvailable` still refuses without it, and says which secret is missing.
It carries the project's real JWT secret under a name the Supabase CLI will
actually let you set — `SUPABASE_JWT_SECRET` is refused outright, reserved for
the values Supabase auto-injects into every function.

`decide_ai_suggestion` is the single bridge across. It locks the suggestion
`for update`, requires a `decided_by`, and only reaches `resolve_dispute` for an
approved `dispute_resolution` of `release`, `refund` or — as of Phase 3 —
`partial_refund`, whose amount it reads off the suggestion the approver was
looking at rather than off the request. A rejection, an approved `escalate`, and
every risk summary write their row and stop.

**Every money function that gained a parameter in V2 was dropped and recreated,
and a recreated function is granted to PUBLIC by default.** `refund_deal` and
`resolve_dispute` both needed an explicit `revoke ... from payhold_ai` that the
old signature's revoke no longer covered. `tests/intelligence.test.ts` matches on
the function *name*, which is what makes that catchable. The endpoint in
front of it (`ai-decisions`) is a separate deployment holding the service role,
and it takes the approver from the session rather than the request body — a
client that can name its own approver can forge an approval.

Two smaller decisions worth knowing:

- **`deal_outcomes` is written by triggers on the money path**, not by anything
  AI. The labels §24.4 will train on have to cover resolutions no model saw, or
  the eventual fraud model learns from a biased sample. Same reasoning as
  `enqueue_webhooks`: a label that every future code path must remember is a
  label that will be forgotten.

  The trap to know about: `deals_label_outcome` carries its condition in the
  trigger's `when` clause, not in the function. When release started landing in
  `clearing` instead of `released`, replacing the function alone would have left
  the trigger deaf — the labels would simply have stopped being written, with no
  error, and §24.3 says they cannot be backfilled. The trigger is dropped and
  recreated in `20260807000002` for that reason.
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
identity. `FlutterwaveProvider` is not "the African one", it is what the routing
table returns for that corridor.

`verifySignature` returns `boolean | Promise<boolean>`, and callers await it.
Flutterwave's is a shared secret compared verbatim and answers synchronously;
Stripe's is an HMAC, and Web Crypto has no synchronous digest. That shape costs
a synchronous rail nothing and is the only one a real signature scheme fits.

`FakeProvider` is not a test double bolted on for convenience: §12 requires a
full lifecycle with zero keys, so it is the rail a fresh tenant runs on until
they bring their own. It fakes the counterparty and **nothing else** — a fake
charge is still webhooked in, still matched on amount and currency, still
confirmed twice before it releases. Its `verifySignature` still rejects an
unsigned webhook, because the forged-webhook test must 401 on every rail.

## StripeProvider, and the two things it does differently

`_shared/stripe.ts`. The complement to Flutterwave rather than a replacement:
Stripe charges a card issued almost anywhere and **cannot pay a Rwandan
seller**, which is why a deal is routinely collected here and paid out there,
and why `rail_balances` has never been one pot.

Three shape facts the code depends on, all documented in the file header:

- **Amounts pass through untouched.** Stripe takes the smallest currency unit,
  which is exactly what `Money` is — so there is no `toMajor` here, and its
  absence is deliberate rather than an omission somebody should fix.
  `flutterwave.ts`'s `ZERO_DECIMAL` is where that fact is written down, because
  Flutterwave quotes major units and needs the conversion.
- **Requests are form-encoded**, with bracket notation for nested objects.
  `form()` is the whole of that, and `stripe.test.ts` caught it stringifying an
  object inside an array — which would have sent Stripe
  `line_items[0]=[object Object]`, a line item with no price, collecting nothing.
- **Idempotency is a header**, replayed for 24 hours. That is what makes
  `dispatchPayout`'s provider-before-booking order safe on this rail too.

`request_three_d_secure: 'any'`, never `automatic`. Stripe's default lets Radar
decide, and a downgrade nobody asked for is precisely what §6's "never silently
downgraded" forbids.

`tokenize` looks like a lookup because it is one: Stripe's payout destination is
the seller's connected account id, and the bank details behind it are given to
Stripe during Connect onboarding and never to us. A raw account number arriving
there is a client misunderstanding worth naming rather than storing.

**`createConnectAccount` / `createAccountLink` / `connectAccountStatus`
(`sellers/index.ts`'s `/connect/onboard` and `/connect/status`, migration
`20260816000011`) are what mint the `acct_…` `tokenize` above only confirms.**
Outside Flutterwave's corridors nobody has one until Stripe's own hosted
onboarding produces it, so a client cannot reach `POST /sellers/:id/destinations`
for this rail at all on a seller's first save — there is nothing to type in. The
in-progress account id lives on `sellers.stripe_connect_pending_account_id`
between "created" and "promoted to a `seller_destinations` row"; nothing on the
payout path reads that column, and it is cleared the moment it is. `/connect/status`
does the promotion itself once Stripe reports `payouts_enabled`, going through
the *exact* `tokenize` → `add_seller_destination` path `addDestination` uses —
so a Connect-onboarded destination lands unverified and inside its usual
security hold like any other one, and still needs a separate
`POST /sellers/:id/verify`: Stripe's own KYC proves the account is real and
payable, not §12's identity attestation. Polling from the client's return page
is the primary completion path (the same "the return is not the evidence,
re-check what's true" shape `settle-pending` and checkout's own poll use); an
`account.updated` webhook handler is the natural next step and is not built.

`verify` takes a Checkout Session id **or** a PaymentIntent id, because both are
references this adapter hands out — `charge` returns the session and their
webhook talks about the intent. A caller that had to know which is which would
be branching on Stripe's internals. It reads `amount_received` rather than
`amount`: on a manual-capture intent they differ until capture, and booking the
second would credit a §22 deposit as though it were a payment.

## PayPalProvider — migration `20260808000003`

`_shared/paypal.ts`. §9's third adapter, and the reason `verifySignature` was
allowed to return a promise in the first place.

Four shapes differ from Stripe, all in the file header and all load-bearing:

- **Amounts are major-unit decimal strings.** `"100.00"`, not `10000`. `Money`
  is minor units everywhere in PayHold, so every figure crosses
  `toValue`/`fromValue` here. Stripe's adapter has no conversion *deliberately*
  — its API is already minor units — and the asymmetry is what to keep straight
  reading the two together. `ZERO_DECIMAL` is **PayPal's list, not ours**: HUF
  and TWD are decimal currencies their API refuses fractions in.
- **Auth is OAuth2.** The token is cached on the instance and shaded by sixty
  seconds, because an adapter is constructed per request and a fetch per call
  would double every round trip. A failed exchange never quotes their body back
  — their text can contain the client id.
- **Webhook verification is a network call.** No HMAC exists to compute; the
  supported check hands the headers and body back to PayPal. So the raw body is
  parsed here, uniquely, and only to re-serialise it into their request —
  nothing is trusted from it before the answer returns. `cert_url` is checked
  against their own host first, because an unchecked one is an attacker naming
  where a key comes from. **Any failure returns false.**
- **A capture id is not an order id.** `verify` accepts either, so no caller
  branches on PayPal's internals. Refunds go against the *capture*.

`tokenize` is `async` with no `await` in it, on purpose: it throws, and a method
typed as returning a promise that throws synchronously sails straight past a
caller's `.catch()`. `paypal.test.ts` caught that.

**`implemented` moved and `enabled` did not**, which is the whole reason the two
columns are separate. The class exists; the signed agreement does not, and §16
wants written payout confirmation per market before live money moves.
`payout_routes_require_live_provider` reads `enabled`, so turning the rail on
stays a row an operator changes deliberately.

The other two stay unbuilt and their notes now say what each is actually waiting
on — Cash App Pay is a method reached through Square or Stripe rather than an
API of its own, and `china_wallet_partner` names a partner nobody has chosen
behind a legal bar rather than a coding one.

## The capability matrix

Migrations `20260807000010` (the adapter enum values) and `20260807000011`.
Same two-file split as the lifecycle and the six buckets, same reason.

Two tables, two different questions:

- **`provider_capabilities`** — §9's eight flags, plus `implemented` and
  `enabled`. Those two are separate because they fail differently: an unbuilt
  adapter is a roadmap item, a disabled one is an outage or a commercial
  decision, and an operator has to tell them apart at 3am. A check constraint
  makes it impossible to enable something unbuilt. `route_evaluation` reads the
  row, so switching an adapter off disables exactly its own routes — §15
  phase 3's second sentence, made structural.
- **`payment_markets`** — §12's country switch, an **overlay** and not a mirror.
  A country with no row behaves as the registry says; a row is a deliberate
  departure carrying a required `reason`, because "why can nobody in Kenya pay
  us" gets asked three months after whoever switched it off has forgotten.
  `market_open()` answers one country, `closed_markets()` answers all of them —
  the catalogue endpoint needs the second, and 55 round trips would be a query
  per row of a page nobody paginates.

**The registry did not move, and §29.11 is why.** `countries.ts` is ~200 rows of
transcribed provider documentation emitted into both repos by one generator.
Copying it into SQL would give it a second home that drifts the first time
somebody edits one and not the other — the exact failure the generator prevents.
The registry says what is *possible*; the matrix says what is *on*.

**`payout_routes.provider` is `not null` as of Phase 6.** Phase 5 used a null to
mean "unbuilt" because §9's adapters had no enum values yet, and a check
constraint cannot look at another table. Now each rail names its adapter —
`paypal` carries Venmo, `china_wallet_partner` carries both Chinese wallets —
and `payout_routes_require_live_provider` refuses to enable a route whose
adapter is not live. `payout_provider` names a **rail**, `provider` names an
**adapter**, and keeping two enums is what stops those being conflated.

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

### Three rails connect, and PayPal proves its mode differently

`REQUIRED_FIELDS` names each rail's fields, and `GET /v1/provider-accounts`
returns that list as `available` so the dashboard renders a form without
hardcoding provider knowledge. PayPal was in that list before it could be
connected, which made the form reachable and the submit a 500.

**Rule 2 above is checked twice, by two different means.** Flutterwave and
Stripe mark the mode inside the key — `_TEST-`, `sk_test_` — so a string test
catches a live key submitted as test *before* anything is sent anywhere. PayPal
has no such string: the credential is an OAuth2 client id and secret that look
identical in both modes, and sandbox and live are different **hosts**. So its
mode check is the token exchange in `validatePayPalCredentials`, which cannot
succeed against the wrong host. Reading `credentials.secret_key` for that rail
is what used to throw — there is no such field — so the check now yields `null`
for "not answerable by inspection" rather than `false`, which would have meant
"this is a live key".

`validatePayPalCredentials` probes with `authenticate()` rather than
`balances()`, and that is the one place it departs from the other two. Their
`/balance` call is the cheapest thing that proves a secret key; PayPal's
equivalent reads `/v1/reporting/balances`, which needs a reporting permission an
app can lack while still taking and sending money perfectly well. Failing a
connection on it would turn away a working account, so the balance read is
attempted for its currency list and its failure is not fatal.

**Connecting PayPal does not make PayPal work**, and the split is the point:
`provider_capabilities.enabled` is still false, so `loadProvider` throws
`paypal is switched off` for a stored, validated account. Turning it on is a row
an operator changes deliberately, gated on a signed agreement and §16's written
payout confirmation per market — a legal fact no code can check.

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
independently. It used to be pinned from the dashboard's side too, by a mock
that signed for real; that mock is deleted, so this test is now the only thing
between a client's verification code and a silent change to the header format.
Treat it as a published contract rather than a unit test.

## The lifecycle, and where `clearing` came from

Spec §6, migrations `20260807000001` (the enum values) and `20260807000002`
(everything else). **Two migrations, not one, and they must stay that way**:
Postgres refuses to use an enum value added in the same transaction, and
Supabase runs each file in one.

The change worth understanding is that **`clearing` is a rename of what
`released` used to mean.** V1 wrote the release entry, said `released`, and used
`payout_due_at` to hold the money through the window. V2 names both halves:
`clearing` inside it, `released` past it, `payout_pending` while the transfer is
with the provider. `release_deal` still does everything it did, at the same
moment, under the same lock — it just lands in a differently-named state.

`mature_clearing_deals()` is what promotes `clearing → released` when
`payout_due_at` passes. It moves no money and writes no ledger entry; the money
moved at release. `payout-dispatch` calls it **first**, before scanning for due
payouts, because a payout becomes dispatchable at the same instant its deal
stops clearing — scanning first would dispatch against a deal still claiming to
be inside its safety window.

`settle_payout` promotes a still-clearing deal itself rather than refusing it: a
settled transfer proves the window is over. That is the recovery path (a forced
retry, a provider settling early), and it writes a `deal.cleared` audit row
saying a payout rather than the clock caused it. The alternative was making
`clearing -> paid_out` a legal edge, which would have let a retry pay inside the
window and leave no trace that it had skipped one.

**The transition guard** is `deal_transition_allowed`, enforced by
`deals_assert_transition`, a before-trigger. A trigger for the same reason
`enqueue_webhooks` is one: a rule every future code path must remember to call
is a rule that eventually gets skipped, including by a correction someone runs
by hand at 2am. It guards **shape, not policy** — `release_deal` still owns the
both-confirmations check and `refund_deal` still owns whether a refund is
allowed this late, so a permissive edge here weakens nothing.

Two edges look wrong and are not. `released -> paid_out` skips `payout_pending`
because a synchronous rail settles inside the dispatch call and never reaches
`mark_payout_processing`; requiring the intermediate state would make a card
payout illegal. And `payment_failed -> funded_held` exists because an async rail
can report a failure and then settle — refusing it would leave money at the
provider with no deal willing to admit it arrived.

**`clearing -> disputed` opened a hole that had to be closed in the same
change.** V1 could only dispute a held deal, so no payout row existed yet; now a
chargeback can arrive when the payout is already scheduled. `settle_payout`
refuses a disputed deal under the row lock and `dispatchPayout` skips it early,
so the cron reports a skip rather than an error and we never ask a provider to
send money we are about to refuse to book. `released_at_matches_status` had to
exempt `disputed` for the same reason — a deal disputed during clearing has a
`released_at`.

`deal_transition_allowed` is granted to `anon` and `authenticated` deliberately:
it describes the state machine rather than being a way into it, and the
dashboard uses it to grey out an action that could not succeed.

## The six buckets, and the drift that was not drift

Migrations `20260807000003` (entry types) and `20260807000004` (everything
else). Same two-file split as the lifecycle, same reason.

`rail_balances` gained `reserved` and `fees_retained`, and `reconcile`'s
`expected()` counts both. That is a **bug fix**, not a feature. The platform fee
is a debit in the clearing pool; nothing sweeps it out of the tenant's provider
balance, because under bring-your-own-keys there is no such transfer. So a
100,000 deal with a 10,000 fee expected 90,000 while the provider reported
100,000 — drift of exactly the fee, on every released deal, and
`record_reconciliation` freezes payouts on any drift. The sandbox walkthrough
would have hit it on its first deal.

The three-way distinction is the thing to hold on to:

| | leaves the vault? | in `expected`? |
|---|---|---|
| `fee`, `tax` | no — reclassified, still ours to hold | yes, as `fees_retained` |
| `reserve` | no — carved out of the pool | yes, as `reserved` |
| `provider_fee` | **yes** — the rail took it | no |

`amountLeaving` in `_shared/figures.ts` has a matching list, `POOL_ENTRY_TYPES`,
and **the two must agree** — there was a third copy in the dashboard mock, and
deleting it removed a way for them to disagree rather than a safeguard. A
deduction in `rail_balances` and missing from `amountLeaving` sends a seller
money the pool says is spoken for — a tax we owe onward, or a reserve still
carved out.

`deal_amounts(deal)` is §7's breakdown: eight values, presentment currency,
derived and never stored. It returns a row of zeroes for an unfunded deal rather
than no row, so a client rendering a breakdown does not have to distinguish
"nothing happened yet" from "no such thing".

**`release_due_reserves()` runs before `mature_clearing_deals()`** in the same
dispatch pass. Both are keyed on the same instant, and a deal that matured while
its reserve was still carved out would offer the dispatcher a pool short by it.

### `create or replace` cannot change a signature

It adds a sibling. An earlier draft of V2 wrote a six-argument `fund_deal`
intending to replace the nine-argument one; Postgres kept both, the webhook went
on calling the original, and **every test still passed** — because the tests for
the new behaviour were calling the function nothing in production uses.

`tests/lifecycle.test.ts` now asserts `count(*) from pg_proc where proname =
'fund_deal'` is 1. Any money function that gains a parameter needs an explicit
`drop function` with the **old** argument list, and is worth the same guard.

## Partial refunds — §7.1

Migrations `20260807000005` (enum values) and `20260807000006`. A refund is now
a row in `refunds`, not a bare ledger entry, because §7.1.6 has Alipay and
WeChat Pay settling asynchronously up to 90 days out — a refund has a lifetime,
and a `failed` one must stop counting against what is still refundable.

**Where the refund lands decides what the ledger does**, and the third case is
the one to understand:

| Lifecycle position | Entries |
|---|---|
| before capture | none — refused |
| before release | `refund` |
| after release, before payout | **`release` (positive)** then `refund` |
| after payout | `receivable`, and the refund stays `pending` |

The positive `release` is not a trick. `held` is `hold + release + refund`, and
by then the negative release has already cancelled the hold — booking only the
refund would drive `held` to minus the refunded amount and hand reconciliation a
drift that is not one. Putting it back and taking it out again is what §7.1.3
means by "reverse the seller payable".

`release_deal` releases `presentment_amount` **less what has been refunded**.
Deriving it from `hold` entries would be purer, but it makes releasing depend on
a ledger entry only `fund_deal` writes, and a dozen fixtures set a status
directly. The two are the same number wherever the ledger is complete.

**A partial refund does not touch the deal's status** (§29.8). `partially_refunded`
is declared and never written. The reasoning is in the migration header, and the
short version is that a deal refunded by a third still has to be paid out for
the other two thirds.

Two things a partial refund does adjust: the scheduled payout shrinks in
proportion to the pool (scaled, not converted — the payout is in the seller's
currency and the refund in the buyer's), and a full refund fails any payout
still scheduled.

## The Resolution Center — §8, migrations `20260807000016` and `20260807000017`

Same two-file split as everything else in V2, same reason: Postgres refuses to
use an enum value added in the same transaction.

`disputes` used to carry a reason and nothing else. It now carries a structured
`reason_code`, a `disputed_amount`, who filed it and who decided it, with
`dispute_offers` and `dispute_evidence` beside it.

**Three decisions are load-bearing. Read them before changing anything here.**

### Silence lapses a request. It never accepts one.

§8 lets an unanswered request be "auto-resolved by platform rule", and the rule
is that at 48 hours `expire_dispute_offers()` marks the offer `expired` and the
dispute **stays open**. Nothing moves.

The other reading — silence accepts — would make a clock the thing that refunds
a buyer or pays a seller. That is a machine deciding, and invariant 9 and
invariant 11 both say it may not. §15 phase 4 asks that the window resolve
without a human, and it does: the window closes. `resolution-center.test.ts`
asserts the deal, the dispute and `deal_amounts` are all untouched afterwards.

`expired` is a distinct status from `declined` on purpose. Declining is an act —
somebody read it and said no — and §24.3's labels cannot be backfilled, so
collapsing the two would lose the difference permanently. An expired offer also
has a null `responded_by_actor`, because nobody answered it.

The pass runs from the **`auto-release` cron**, first, rather than from a job of
its own: both are "a clock ran out", and this one moves no money and touches no
deal. Its failure is logged and swallowed — a deal whose release window came due
must not wait on an unanswered offer somewhere else.

### `disputed_amount` bounds the resolution. It does not split the payout.

§8 says a partial dispute freezes only the disputed amount "when the ledger can
safely separate it". The ledger can, since Phase 3. **The payout cannot**, and
that is the binding constraint: `payouts_deal_key` allows exactly one payout row
per deal, so paying the undisputed two thirds now consumes it and a dispute later
resolved in the seller's favour would have nothing left to send the rest with.

So the amount is enforced where it can be enforced honestly. `resolve_dispute`
refuses a `refund` when only part was disputed, and refuses a `partial_refund`
larger than that part. The payout freeze stays whole while a dispute is open.
Splitting a payout is a second payout row, its own idempotency key and its own
line in reconciliation — a change that deserves its own phase rather than a
clause here.

### Conflict of interest is enforced on who *acted*.

§8 wants an administrator who is a party unable to decide. The obvious
implementation cannot be written, and structurally so: PayHold stores no buyer
PII — `buyer_ref` is the client's own opaque identifier — and a seller has no
login. There is no identity to join to.

What is recorded is who did what. So `resolve_dispute` refuses a `p_decided_by`
that appears as `disputes.raised_by_actor`, or as any `offered_by_actor` or
`responded_by_actor` on the dispute. `both-parties` is the one reserved name
allowed to have acted: it is what `respond_dispute_offer` writes when the two
sides agreed with each other, and refusing it would make agreement unexecutable.

`p_decided_by` is **required**. A decision without a decider is not a record —
the same reason `approve_payout_review` and `verify_seller` take a name. That is
a signature change, so `resolve_dispute` was dropped and recreated, and **the
`revoke ... from payhold_ai` had to be reissued**: a recreated function is
granted to PUBLIC. `tests/intelligence.test.ts` matches on the name and is what
catches it being forgotten.

`decide_ai_suggestion` now passes the approver through as the decider, which
means an administrator who argued one side cannot launder the decision through
an AI draft either.

### Smaller things

- **One open request per order**, enforced by `dispute_offers_one_open_per_deal`
  and re-stated as a sentence in both `open_dispute` and `make_dispute_offer` so
  a caller gets prose rather than a constraint name. `resolve_dispute` withdraws
  any request still outstanding — otherwise the next dispute on that order is
  blocked forever by an offer about a dispute that is over.
- **The other party answers.** `respond_dispute_offer` refuses the offering
  side: accepting your own request is not agreement, it is a way around the 48
  hours.
- **Accepting an `update` or an `extension` leaves the dispute open.** Agreeing
  to send a photo or to finish on Friday is not agreeing about the money, and
  closing the dispute would unfreeze the payout on a side conversation.
- **`dispute_timeline` and the export are derived**, never stored. Every row
  already exists somewhere else and a second copy would be free to disagree.
- **No bytes in Postgres.** `dispute_evidence` holds a description, a kind, a
  `captured_at` and a storage reference — the same refusal that keeps card and
  account numbers out. `captured_at` is separate from `created_at` because an
  inspection photo taken at handover is worth more than one taken after the
  complaint, and only that column can tell them apart.
- **§16's `dispute_window` blocker is cleared by `20260807000017` itself**,
  which is the contract `20260807000015` states. It clears the blocker and does
  not sign the item off: the table existing is a fact, and whether the behaviour
  is right is a person's judgement.

## Risk rules live in SQL

`screen_payout` implements them, for the same reason the release guard does: it
must run in the transaction that then holds the payout. It can set
`held_for_review` and nothing else — no ledger write, no transfer, no state
change to the deal. `approve_payout_review` is the only way out, and it takes
the approver's name because the audit row is about a person's decision.

`hold_payout` is the same stop placed by a person instead (migration
`20260806000006`), and it exists because the only other way to stop one seller
was freezing the tenant, which stops every honest seller with them. It reuses
`held_for_review` rather than adding a status — what it produces is the same
thing, one payout waiting on one person, cleared through the same audited door.
`review_held_by` is what tells the two apart on the way back out: null means a
rule did it, a name means somebody did and can be asked why. Both the name and
the reason are required, and it refuses a payout that is `paid` or `processing`
— recalling an in-flight transfer is a conversation with the provider, and a
hold that pretended otherwise would be a lie an operator acts on. Placing one
clears any earlier approval, or `screen_payout` would skip that payout forever.

This does not weaken invariant 11. That invariant limits *rules* to stopping,
because a rule is arithmetic nobody agreed to at the time; a person stopping a
payout fails in the same direction with a name attached.

## Seller onboarding — §12, migration `20260807000007`

`screen_payout` now has two halves, and the split is the point.

**The eligibility gate** runs first and is not behind `risk_rules_enabled`.
Unverified identity, missing or stale sanctions screening, an unverified
destination, a destination that moved inside `destination_hold_hours` — any of
those holds the payout whatever the tenant has set. The rules below it are
discretionary and stay behind the setting. A tenant that switched the rules off
must not thereby start paying sellers it has never verified.

Invariant 11 survives intact: the gate holds and does nothing else, and
`review_held_by` is still null, because arithmetic did it rather than a person.

**Phase 5 changed what it sets and when it may be skipped** — see the routing
section below. The gate now produces `needs_verification` rather than
`held_for_review`, and an earlier approval no longer short-circuits it.

**Three triggers make the invariants structural** rather than something an
endpoint has to remember:

- `sellers_seed_primary_destination` — inserting a seller creates their primary
  `seller_destinations` row. Without it, every seller created after this
  migration would be unpayable for a reason nobody chose, and the endpoint would
  be the only insert path that got it right.
- `seller_destinations_sync_primary` — the primary row is the record;
  `sellers.beneficiary_token` and `masked_destination` are a copy with exactly
  one writer, so they cannot disagree. They go when Phase 5 reads the table.
- the same trigger stamps `destination_changed_at`, and **only when the token
  actually moved** — re-saving an unchanged destination would otherwise hold a
  payout for nothing.

**`external_user_id` got a writer in `20260808000005`, and the gap it left is
worth knowing.** The column has existed since this migration and nothing ever
wrote it — `POST /v1/sellers` neither accepted it nor inserted it — so a tenant
had no way to ask "which seller is this user of mine", which is the only way a
client can find a seller again given that PayHold mints no seller identity.
`sellers_external_user_key` makes it unique per tenant where present, partial
because null is not a handle and a seller registered by hand from the dashboard
supplies none. The endpoint checks for the handle **before** it tokenizes, so a
retried registration does not mint a beneficiary token nobody will use, and it
**refuses** rather than returning the existing seller: this request carries a
destination, and quietly ignoring it would let a re-registration read as an
accepted destination change — which is `seller_destinations` and §5.1's security
hold, the path a takeover would want to skip.

**`GET /v1/sellers?external_user_id=` is the other half of that refusal.** A
client cannot get-or-create against an endpoint that refuses a handle it already
knows unless it can ask first, and until this filter existed the only way to
look one up was pulling the tenant's whole seller list and matching in the
client. The handle is trimmed on the way in exactly as `create` trims it before
storing, or a handle carrying a stray space would register fine and then never
be found. A **blank** one is refused rather than ignored — answering
`?external_user_id=` with every seller the tenant has would be a filter that
silently did nothing, and the caller would read the first row as their user's.
No match is an empty list and not a 404: "this user is not registered yet" is
the answer the caller wanted, not a failure.

`verify_seller(seller, actor, verified)` is one function rather than three
column updates because the three travel together: a seller marked verified with
no sanctions date, or with an unverified destination, is still unpayable, and a
caller would have to know that to get it right. It takes a name for the same
reason `approve_payout_review` does.

`seller_capabilities(seller)` is the read-only counterpart — the same questions,
asked ahead of time, returning **every** reason rather than the first.

**`add_seller_destination` (migration `20260809000001`) is the writer §5.1
assumed and the table did not have.** `seller_destinations` had exactly two
writers — the seeding trigger and `verify_seller` stamping a verification — so
every reader could cope with a seller who had several destinations and nothing
could give them one. A seller whose MoMo line was cut off had no way through the
API to say so. `POST /v1/sellers/:id/destinations` is this function's only
caller.

It is SQL because moving the primary is a *swap*: `seller_destinations_one_primary`
refuses the overlap, so the demote and the insert have to be one transaction,
and the window between two statements is a seller with no primary destination at
all — which every reader correctly reads as unpayable. The provider call stays
in the Edge Function; Postgres does not make HTTP requests, and a transaction
held open across a provider round trip is a lock held across someone else's
outage.

The new row is written **unverified and inside its security hold**, and no
argument turns either off. Each condition independently stops a payout,
`screen_payout` holds anything already scheduled off `destination_changed_at`,
and together they are §5.1's change protection: "get in, move the destination,
withdraw" is the shape of an account takeover, and this is what puts a person
between the second step and the third. The outgoing destination is demoted and
never deleted — a paid payout still has to say where it went, and a seller
moving back to an account PayHold has already verified should not serve a second
hold for it.

## Ending a hold, and three readers of one fact — migration `20260809000002`

`end_destination_hold` is the other half of §5.1's sentence. The section asks
for a hold **and** for step-up verification "before use"; the table had the
first and no way to record the second, so the hold could only expire. A seller
who rang in, answered the questions and had the change confirmed still waited
out a timer, and the operator watching had nothing to write it down with.

Shaped like every other attestation here: it takes a name, refuses a blank one,
audits against that person, and `POST /v1/sellers/:id/destinations/:id/end-hold`
**refuses an API key**. That refusal is sharper than `/verify`'s — the hold is
what stands between a takeover's second step and its third, so a client ending
its own holds would have deleted the defence rather than passed it.

Three smaller decisions:

- **`security_hold_until` is set to `now()`, never null.** Null means "this
  destination never had a hold" to every reader, and this one did. An ended hold
  and an expired one are the same fact going forward; the row should not claim
  the stronger thing. The original expiry and the hours skipped go in the audit
  row, which is where "how much, and by whom" is answered.
- **Idempotent and silent on a lapsed hold.** A hold that already ended is not
  an error, and a second call must not put a second person's name against a
  decision the first one made — so there is no audit row for a no-op.
- **It does not verify the destination.** Both conditions stop a payout on their
  own and §5.1 wants both. Ending one quietly satisfying the other is precisely
  the shape being defended against.

**The reason `screen_payout` is in this migration is that one hold was read
three ways.** `seller_capabilities` and `route_payout` read
`seller_destinations.security_hold_until`; `screen_payout` re-derived a window
from `sellers.destination_changed_at` and `destination_hold_hours` as it stands
*now*. Nothing kept them in step, and they disagreed in both directions —
lowering the setting released the gate while the stamped expiry still blocked
the route, and ending a hold on the row would have done the reverse. A seller
was shown one reason on their own screen while the payout was stopped here by
another, which is the failure returning every reason at once exists to prevent.

The stamp now wins wherever it exists, and both readers emit the identical
sentence.

## Moving back — migration `20260809000003`

`add_seller_destination` always **inserts**, which is right for a destination
nobody has seen and wrong for one already tokenized, verified and held once. So
a seller whose new destination turned out to be unroutable — a card in a market
Stripe cannot pay into, which is the case that found this — could only reach
their old line by re-registering it: a second token, a second hold, and the
verified row sitting right beside it unreachable by any endpoint. The header of
`20260809000001` already said that should not happen.

`promote_seller_destination` swaps which row is primary and writes no new row.
Two things keep it from being a way around the hold, and both are re-read under
the seller's lock rather than trusted from the endpoint:

- **it refuses an unverified destination** — you cannot promote past a check
- **it refuses one still inside its hold** — nor past the clock

So it is a **narrower** door than `end_destination_hold` next door, which a
person can open on a destination nobody has checked. Promotion opens nothing; it
picks between destinations already checked, and a takeover's freshly added row
fails both guards.

**It stamps `security_hold_until = coalesce(security_hold_until, now())` on the
way through, and `20260809000002` is what makes that expressible.**
`sync_primary_destination` sets `sellers.destination_changed_at = now()` whenever
the primary's token moves — correctly, it did move — and `screen_payout` reads
that as a hold. Without the stamp a promotion would arm a fresh 24 hours against
the destination that just passed the test for needing none. A row seeded by
`sellers_seed_primary_destination` carries no stamp at all, which is exactly the
row this is for. **The fallback is not a transitional kindness**:
`sellers_seed_primary_destination` writes no expiry, so a seller whose primary
was seeded at registration has only `destination_changed_at` to go on and must
keep exactly the protection it gives them. `create or replace` with an identical
signature, so no `drop function` — but the revoke is reissued, because a
recreated function is granted to PUBLIC again.

## Payout routing — §5.1, migrations `20260807000008` and `20260807000009`

Same two-file split as the lifecycle and the six buckets, same reason: Postgres
refuses to use an enum value added in the same transaction.

`payout_routes` replaces `_shared/rails.ts`'s `payoutProviderFor` **on the
payout path**. rails.ts stays where it is and keeps its other job — refusing a
corridor at seller registration, before a destination is stored — but which rail
carries a scheduled payout is now a row, because §12 requires a country or a
provider to be disabled without a redeploy and a `case` statement cannot be.

`route_evaluation(tenant, country, currency, amount, rail)` is §5.1's filter
chain in the order its pseudocode writes it, returning **every** route with its
verdict rather than only the survivors. The losers are the eligibility record
`payout_decisions.checks` stores, and they are what answers a seller asking why
the rail *they* picked will not work.

Two traps in that function. Every column reference is qualified, and has to be:
`returns table` puts `provider`, `method` and `rank` in scope as parameter names
and each is also a `payout_routes` column. And the `order by` ends with
`payout_provider::text` so the ordering is total — a tie broken by whatever
Postgres returned first would make the engine non-deterministic in exactly the
way §5.1 forbids.

`route_payout(payout)` chooses, records and — when there is nothing to choose —
blocks. One function rather than a chooser and a recorder, because §5.1 wants
the decision auditable and a recorder the caller may forget is not an audit. It
refuses a `paid` or `processing` payout outright: re-routing money in flight is
the silent redirection the section forbids.

**Ordering in `dispatch.ts` is a dependency, not a preference.** Screening runs
before routing because `screen_payout` is what blocks a disputed deal's payout,
and `route_payout` un-blocks any payout it can route. Routing first would let a
disputed one back into the queue. `settle_payout` still refuses it under the row
lock — the ordering is what keeps the *status* honest in between.

### `screen_payout` grew a third answer, and lost a short-circuit

| Reason | Status | Ends when |
|---|---|---|
| the deal is disputed | `blocked` | the dispute resolves |
| §12 eligibility | `needs_verification` | `verify_seller` records an attestation |
| a discretionary rule | `held_for_review` | a named person approves |

`approve_payout_review` still accepts only `held_for_review`, which is the point:
until Phase 5 the eligibility checks produced that status too, so an operator
could approve past "we have never verified this seller" — exactly what §12's
sentence says must not be possible.

**The approval short-circuit moved below the gate.** `screen_payout` returned
early on `review_approved_at`, which was right while everything under that line
was a rule — a rule must not overrule the person who overruled it. Phase 4 put
the unconditional gate *above* it and the gate inherited the short-circuit, so a
seller whose verification was revoked after an approval would have been paid.

**The `not_eligible` signal is written on entry and on a change of reasons.**
`needs_verification` is in `DISPATCHABLE`, so it is re-screened every pass; an
unconditional insert would write one row per pass for as long as a seller took
to send a document, and §24.3 says these labels cannot be backfilled. The same
de-duplication guards `payout_decisions`.

### `seller_capabilities` returns two lists, and that is the whole signature change

`reasons` is what the seller must do; `route_reasons` is what we cannot reach.
`screen_payout` reads only the first. If a routing failure appeared there, an
unroutable payout would become `needs_verification`, the routing engine would
never see it — no decision row, no checks, no reason code — and a verified
seller would be told to verify themselves again.

Changing the return type meant `drop function`, not `create or replace`, and the
grant had to be reissued. The same trap as a money function gaining a parameter.

## Sending a payout

`_shared/dispatch.ts` is the single implementation, shared by the
`payout-dispatch` cron and `payouts/:id/approve-review`, so that approving
cannot become a route which skips a check the cron makes. Its order is the
safety argument: **frozen tenant → `screen_payout` → `route_payout` → provider
→ book.**

Provider before booking is deliberate. A transfer that succeeded but was not
booked is re-sent next pass on the same `idempotency_key`, the provider returns
the same transfer, and it books then. Booking first would report a seller paid
who was not.

The rail and the beneficiary token both come from the routing decision now, not
from `payoutProviderFor(seller.country, …)` and `sellers.beneficiary_token`. A
seller has more than one destination and only the decision knows which was
picked.

`held_for_review` is absent from `DISPATCHABLE` and must stay absent — cron may
never be the thing that lets a held payout through. `blocked` and
`needs_verification` **are** in it, and the difference is that neither is
waiting on a decision: one waits for a route to exist, the other for somebody to
attest to a fact, so a pass that re-asks and finds the reason gone overrules
nobody. The same shape as `frozen` clearing once reconciliation is resolved.
The approve endpoint also
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

### Retry and the clock — §13, migration `20260807000014`

`failed` joined `DISPATCHABLE`, so a refused transfer is now re-sent by the
cron. Until this landed nothing automatic retried a payout at all: Phase 5 built
the backup-destination *selection* for a retry and left the retry itself to a
person pressing a button.

**`payouts.next_attempt_at` is the whole mechanism, and null is the interesting
value.** It means no machine may try this payout again. The cron filters
`next_attempt_at <= now()`, which excludes nulls by construction; the approve
and retry endpoints go through the same `dispatchPayout` and are unaffected,
because a person is not a machine and that is exactly the distinction the column
encodes.

The ladder is 1m / 5m / 30m / 2h capped, the same one `record_webhook_attempt`
uses. When `payout_retry_max_attempts` (default 5, floor 1) is spent,
`fail_payout` writes `blocked` **and clears the clock**, which is how §13's
"then move to `payout_blocked` for operator action" is said without a second
status meaning "blocked, but really blocked". §5.1's no-route `blocked` keeps
its clock and is re-asked every pass, because that answer changes without anyone
doing anything; a rail that refused us five times does not.

Three consequences worth knowing:

- **The attempt counter is never reset**, including by `reset_payout_retry`,
  which is what `/payouts/:id/retry` calls before it dispatches. `route_payout`
  reads `attempts >= payout_primary_attempts` to decide whether the seller's
  verified backup destination may be used, so zeroing it would quietly send the
  next attempt back to the primary that has been failing. A person's retry is
  one more attempt, not a fresh series.
- **`mark_payout_processing` had to accept `failed`.** The second attempt on an
  async rail arrives from that status, since `route_payout` only rewrites
  `blocked`. The bug predates phase 9 and nothing reached it, because the only
  retry was a person on a synchronous rail.
- **A finished deal stops the clock, by trigger.** `refund_deal` cancels a
  scheduled payout by writing `status = 'failed'` directly — inert while
  `failed` was undispatchable, and a transfer nobody is owed once it is not.
  `payouts_stop_retrying` clears `next_attempt_at` on any payout written while
  its deal is `refunded`, `canceled` or `expired`, for the reason
  `deals_assert_transition` is a trigger. `disputed` is deliberately absent: a
  dispute ends, and the payout it froze has to be sendable when it does.
  `dispatchPayout` also skips a deal outside `PAYABLE_DEAL_STATUSES` before
  calling any provider — `settle_payout` would refuse to book it anyway, since a
  refunded deal has no available balance, but that refusal comes after the money
  has gone.

## Seller wallets and pull-based payouts — migration `20260808000002`

One migration, not two: nothing here reads a value from `alter type ... add
value`, so there is no cross-transaction enum hazard.

**The wallet reconciles, and that is the acceptance test.**
`seller_wallet_rows` is deliberately parallel to `rail_balances`, entry type for
entry type and sign for sign, because every seller's wallet summed has to equal
the tenant's own balance less `fees_retained`. A wallet computed a second way is
free to disagree with `tenant_balances`, and the number a seller reads would be
the one nobody reconciles against a provider.
`tests/seller-wallet.test.ts` asserts the sum with a non-zero `fees_retained`,
so it cannot pass by everything happening to be equal.

Three things worth knowing before changing any of it.

### `due_payouts` is in SQL because of the limit, not the predicate

The cron used to build its own scan. It cannot any more: in `payout_mode =
'wallet'` a cleared payout is not due until somebody asks, and filtering those
rows out *after* `limit 25` would let one tenant sitting on twenty-five
unasked-for payouts fill the pass and starve every other tenant — silently, and
for as long as the backlog stood. The filter has to be inside the limit.

**The statuses are a parameter.** `DISPATCHABLE` stays in
`_shared/dispatch.ts`, where the reasoning about `held_for_review` being absent
lives, and the cron passes what it already owns. A second copy of that list in
SQL would be free to drift from the argument for it.

### `request_withdrawal` moves nothing

It stamps `withdrawal_requested_at`, records a chosen destination and re-arms
`next_attempt_at`. Everything after that is `dispatchPayout` — the same
frozen-tenant check, the same `screen_payout`, the same `route_payout`. A
withdrawal endpoint that called a provider itself would be a second money path,
and §12's whole point is that there must not be a second way to pay a seller
nobody verified.

`attempts` is untouched, for the reason `reset_payout_retry` leaves it untouched:
`route_payout` reads it to decide whether the verified backup destination may be
used, so zeroing it would quietly send the next attempt back to the primary that
has been failing. `held_for_review` is absent from the statuses it stamps, for
the reason it is absent from `DISPATCHABLE`.

`withdrawal_requested_at` is **never cleared**, including when the payout is
sent. "Was this pulled or did it go out on the clock" is exactly what is asked
when a seller disputes a transfer.

### `route_payout` was recreated, so its revoke had to be reissued

The only change to it is the destination lookup: the seller's requested
destination, if the payout carries one and it still stands, else their primary
exactly as before. Every eligibility check, the backup policy, the decision row,
`route_reason_text` and the `payout.route_changed` webhook are untouched.

The verification and security-hold conditions are **re-checked there** rather
than trusted from `request_withdrawal`, because a verification can be withdrawn
between the ask and the pass that sends it, and `route_payout` is the read that
happens under the payout's own lock.

A recreated function is granted to PUBLIC by default — the same trap `refund_deal`
and `resolve_dispute` walked into in V2. `tests/seller-wallet.test.ts` asserts
`payhold_ai` cannot execute it, and pins `count(*) from pg_proc` at 1.

## A seller without a destination — migration `20260814000001`

`POST /v1/sellers` required `country`, `payout_provider` and `destination` in
the same request since the table existed. Nothing about accruing money ever
needed one: `held` and `available` are ledger sums keyed on `deal_id` and
`seller_id`, and `seller_capabilities` has answered *"No payout destination
has been registered"* since `20260807000007` — it was dead code, reachable
only by a seller that could not exist, because `sellers.country`,
`payout_currency`, `payout_provider`, `beneficiary_token` and
`masked_destination` were all `not null` and `seed_primary_destination`
always ran off them.

This migration drops those five `not null` constraints and teaches
`seed_primary_destination` to skip the insert when `beneficiary_token is
null`, which is the only thing standing between "money can accrue before a
destination exists" being true in the schema and true in practice. Nothing
downstream needed to change: `seller_capabilities`'s missing-destination
branch, `screen_payout`'s eligibility gate reading it into
`needs_verification`, and `route_payout`'s `dest.id is null` branch were all
already written for this seller — the gate holds before `dispatchPayout` ever
reaches routing, so the null-country edge case in `route_evaluation` is never
exercised on the normal path. `tests/seller-onboarding.test.ts`'s
`route_payout` test calls it directly anyway, because it is reachable in
principle and a silent "eligible" for lack of a country to refuse would be
the wrong kind of quiet.

**One real gap turned up finding this: `sync_primary_destination` never
copied `country`.** It has copied `beneficiary_token`, `masked_destination`,
`payout_currency` and `payout_provider` onto `sellers` since `20260807000007`,
documented as keeping "the primary's copy" in step — `country` was simply
missing from the `update`. That was invisible while `sellers.country` was
`not null` and set once at registration: a seller's country moving mid-life
was already a latent disagreement between the two tables, just never one that
reached `null`. A seller registered with no destination and given one later
would have stayed on the "no country" path permanently otherwise — every
reader that falls back to `sellers.country` (`deals/index.ts`'s
`buyer_country` default, the AI case files, the dashboard's seller page)
would have kept asking a column this trigger was never going to fill. This
migration adds `country = new.country` to the same `update`, and reissues the
revoke a recreated function always needs.

**A destination added after registration is not exempt from the security
hold.** `add_seller_destination` stamps one on every insert regardless of
whether a primary already existed to replace, and this migration does not
special-case "this is the seller's first ever destination" to skip it. A
seller who has been quietly accruing money before anyone knew how to pay them
is exactly the target an account takeover would want, not less of one for
having no prior destination to compare against — so their first destination
waits out `destination_hold_hours` the same as anybody's fifth.

`addDestination` in `functions/sellers/index.ts` refuses one call shape this
opens up: a destination with no `country` in the request and no
`sellers.country` to default to. That is the seller's very first destination,
and somebody has to say which market they are in exactly once — a clear
`policy_violation` rather than `countryInfo(undefined)`'s generic "unknown
country code". `POST /v1/deals` carries the identical guard on
`buyer_country`, for the same reason: `seller.country` no longer defaults to
something.

## A seller's `active` flag — migration `20260815000001`

A destination-less seller made a second gap visible: PayHold had no column
for "this person used to sell here and does not any more." AutoHire's own
example is what asked for it — a host who switches back to renting is not
deleted, and money already owed to them keeps moving, but AutoHire knows
something about them PayHold was never told.

`sellers.active` (default `true`) is that fact, and `set_seller_active` is
shaped like `verify_seller` with one deliberate difference: it takes no
`p_actor` non-blank check, and `POST /v1/sellers/:id/active` accepts an API
key where `/verify` refuses one. The two attest to different kinds of thing —
`/verify` is a person certifying identity, sanctions and ownership checks came
back; `/active` is a tenant restating a fact about its own business that its
own server already knows firsthand, the same reasoning `request_withdrawal`
accepts an API key for.

**It is read by nothing on the payout path, on purpose.** `screen_payout`
does not select it, `seller_capabilities` does not report it as a reason, and
`tests/seller-onboarding.test.ts` pins a verified, funded, *inactive* seller
still clearing a scheduled payout. A seller who steps back mid-clearance-window
is still owed whatever they already earned, and invariant 11 already draws the
line on what may stop a payout — a status flag a client toggles about its own
roster is not that. Wiring inactivity into the eligibility gate is a real
option for later, but it is a deliberate policy decision that belongs next to
`screen_payout`'s other conditions, not a side effect of this column shipping.

## Installment billing — pay-to-book + pay-on-return, migrations `20260815000004` and `20260815000005`

A deal has always been funded in one charge. This adds two independent,
optional behaviours a client turns on per deal by sending numbers at
creation, deliberately generic rather than a literal "hourly vs daily"
concept — the spec gives a client ownership of its own pricing, and
PayHold's job is to stay agnostic to deal type:

- **`split_percent`** — charge this percentage now, the rest when the
  rental is confirmed returned. Null means "all of it now," today's
  behaviour, unaffected.
- **`overage_rate` + `overage_unit_seconds`** — a per-unit price and how
  long a unit is (3600 for hourly, 86400 for daily, or anything else),
  charged only if the deal is confirmed returned after
  `expected_complete_at`. Null means overage is never charged.

**`presentment_amount` means the first installment for a split deal, not
the whole booking.** `balance_amount` is the rest, derived once at creation
and frozen the same way `fee_amount` is — a rate change mid-rental must not
reprice a deal that already exists. This is what lets `fund_deal` and
`startCharge` need zero changes: a split deal simply asks for a smaller
number first.

**A flat, non-split deal can still owe overage on its own** — a daily
rental sets `overage_rate` with no `split_percent` at all, so
`balance_amount` stays null its whole life while overage is still real
money if the return is late. This shipped broken the first time: the
original guard read `balance_amount is null` as "nothing to do here," which
is true for a plain deal but not for a daily one, so overage was silently
never collected for anything but a split deal. Fixed by checking
`overage_rate` too, everywhere `balance_amount` alone used to be the
signal — `collectBalanceThenConfirm`'s gate, and `settle_deal_balance`'s own
refusal and no-op checks, both now read `coalesce(balance_amount, 0)`
rather than the column bare. `tests/migrations.test.ts` pins a flat deal
booking only its overage, and a flat deal returned on time booking nothing
and raising no error.

`settle_deal_balance` books the second charge, once, under the deal's row
lock: refuses a deal with nothing owed at all — no split *and* no overage
terms — is a no-op when there is genuinely nothing to collect this pass
(covers both the idempotent retry of an already-settled split deal and an
on-time flat deal, via the `coalesce`), refuses a negative overage or fee,
and refuses a blank provider reference. It adds `balance_amount + overage`
to `presentment_amount` and the overage's own fee to `fee_amount` — the
base fee was already computed off the full settlement amount at creation,
so only the overage's fee is new. Overage itself is computed in TypeScript
(`_shared/figures.ts`'s `overageFor` and `balanceFigures`), the same
division of labour as every other FX and fee figure:
`ceil(secondsLate / overage_unit_seconds) * overage_rate`, zero if on time
or if either column is unset. `collectBalance` (`_shared/settle-balance.ts`)
checks the computed charge amount before asking for a saved payment method
at all — so a MoMo-funded flat deal that came back on time is never
wrongly refused over a capability it never needed.

**The seller can reduce or waive the overage before it is charged** — the
one point of human judgement in an otherwise fully automatic charge.
`deals.metadata.overage_override`, set only via the seller's own
`POST /deals/:id/confirm` (never a separate endpoint, and refused from the
buyer's side), caps what `overageFor` would otherwise charge:
`_shared/figures.ts`'s `clampOverage` is a small pure function —
`Math.min(raw, Math.max(0, override))` — applied before the fee and the FX
conversion, so a reduced charge produces a correspondingly reduced fee
rather than fee-on-money-never-collected. It is persisted on the deal
rather than passed through only the one call that sets it, because the
confirmation that actually completes the pair — and triggers the charge —
may be the *other* side's, arriving later. `setOverageOverride` refuses a
deal with no overage terms to adjust, the same instinct as every other
"refuse a no-op dressed up as an action" check in this codebase.

**Card-on-file is additive to the provider interface, not a replacement of
it.** `chargeSaved` is a new, optional method alongside `preauth`/`capture` —
deposits are untouched. Stripe creates a `Customer` at the first charge
(`setup_future_usage: 'off_session'`) and later charges it with
`off_session: true, confirm: true` and no `request_three_d_secure`, since
there is nobody present to complete a challenge. Flutterwave's equivalent
reads a card token off the verified transaction and posts to
`/tokenized-charges` — flagged in the adapter as unconfirmed against
Flutterwave's own current documentation, the same caveat every unexercised
live-call path in this file carries. **MoMo has no reusable credential and
never will**; a MoMo-funded split deal cannot collect its balance
automatically, and `collectBalance` (`_shared/settle-balance.ts`) refuses it
by name rather than silently doing nothing.

**The charge has to land before release, not after.** `collectBalanceThenConfirm`
is the shared helper both `POST /deals/:id/confirm` and the `auto-release`
cron call in place of a bare `confirm_deal`, whenever this confirmation
would complete the pair and a balance is still owed: it calls
`provider.chargeSaved`, books the result via `settle_deal_balance`, and only
then calls `confirm_deal` — which releases normally, now against the
topped-up total. If the charge fails (no saved method, or an off-session
decline), the confirmation is refused with an audit row and an
`order.balance_charge_failed` webhook rather than silently dropped; there is
no automatic retry ladder for this charge, on purpose — a smaller, safer
scope than duplicating the payout retry machinery for a charge a tenant can
just prompt the renter to retry out of band.

**That ordering lived entirely in TypeScript until `20260815000005`, and
that was a gap worth closing rather than trusting.** Nothing stopped a
future caller of `confirm_deal` — a correction run by hand, a code path this
migration cannot see — from completing the pair without ever collecting the
balance, which `release_deal` would have released anyway, reading whatever
`presentment_amount` said. `release_deal` now carries one new guard, checked
under the same lock as its refusal of a refunded deal a few lines above: it
refuses outright while `balance_amount` is still positive. Every other
release guard in this codebase lives under the row lock for the same reason
— a TypeScript caller always doing the right thing is a convention, not a
guarantee.

Reconstructing `release_deal`'s body for that migration is what caught two
things worth naming as a lesson rather than just fixing: writing a `create
or replace` from memory instead of reading the live definition first
silently dropped the `deposit_release` ledger write (deposits are supposed
to be untouched by this feature entirely) and invented a `damage_claim_id`
predicate left over from the fully-reverted damage-claims feature, which
does not exist in this schema. `tests/migrations.test.ts`'s full `release`
suite catching both on the first run is the argument for running the whole
suite after touching a shared function, not just the new test written for
the change.

**A split deal's checkout prices a method without a reusable credential at
the full amount, rather than excluding it — migration `20260815000006`.**
`_shared/rails.ts`'s `METHOD_SUPPORTS_REUSE` is still a static fact about each
`PaymentMethod` — `card` is the only one that can ever produce a reusable
credential; mobile money is a one-time approval push with nothing left over,
and neither wallet (PayPal et al. — `chargeSaved` is unbuilt for it) nor bank
transfer produces one either. `availableMethods` (`_shared/checkout.ts`) used
to filter such a method out of a split deal's list entirely, because the
second installment collects automatically the instant both sides confirm and
a method guaranteed to strand it seemed worse than not offering it. The
product call is the other way now: offer it, and charge the whole thing up
front instead of a first installment, so there is nothing left owing for the
missing credential to strand.

`availableMethods` now returns an `amount` per method — `deal.presentment_amount`
for card, the full price (`presentment_amount + balance_amount`) for anything
`METHOD_SUPPORTS_REUSE` says cannot be charged again. Choosing the latter does
not just change what gets displayed: `startCharge` calls `collapse_deal_split`
(new, `security definer`, service-role only) immediately before the provider
call, which rewrites `presentment_amount` to the full price and nulls
`balance_amount`/`split_percent` under the deal's row lock. That write has to
happen *before* the charge, not after — `fund_deal` disputes a webhook whose
amount does not match `presentment_amount`, so a full charge landing next to a
deal still describing a first installment would be exactly that mismatch. The
function is idempotent (a no-op once `split_percent` is already null), which
is what makes it safe for `startCharge`'s second call on the same deal when a
rail asks the buyer for an extra factor. **Deliberately one-way**: a deal that
collapsed this way stays flat even if that specific charge attempt then fails
and the buyer retries with a card — restoring the original split is a gap
disclosed in the migration header, not a case this handles.

**`overage_rate` alone still does not trigger any of this.** A deal with only
overage terms (no split) might never actually owe anything extra — the
charge is conditional on a late return, not certain the way a split's second
half is — so a method that cannot support it remains an ordinary,
identically-priced choice.

Both callers of `availableMethods` — the hosted checkout page and
`startCharge`'s own re-check against a client-supplied method — share this one
pricing logic, so a buyer editing the request directly gets the same amount a
buyer clicking the option would have. `_shared/rails.test.ts` still pins the
four method flags so a silent flip to `true` cannot pass unnoticed; they now
feed a price rather than a filter.

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

## Reconciliation runs — §13, migration `20260807000013`

The nightly comparison and the automatic freeze already existed. What did not
was a record of the *pass*: `reconciliation_alerts` answers "is something wrong
now" and cannot answer "did last night's pass check Stripe", and a nightly
control nobody can prove ran is not a control.

`reconciliation_runs` is one row **per tenant per rail**, opened by
`start_reconciliation_run` before the provider is asked anything and closed by
`finish_reconciliation_run`. Per rail rather than per pass for the reason
balances reconcile per rail: you cannot ask two providers about one number, and
a run summing Flutterwave and Stripe would be that mistake a level up.

**A pass that dies leaves its run open, and the next one records it as
`failed`.** That cleanup lives in `start_reconciliation_run` rather than in the
Edge Function, because the function that crashed is precisely the one that
cannot tidy up after itself. The partial unique index allows one `running` row
per rail, so an abandoned run also cannot be silently accompanied by a second.

The four counters, and what each is actually claiming:

| | Means |
|---|---|
| `matched` / `mismatched` | currency comparisons on this rail that agreed or did not. Every mismatch opens or refreshes an alert, and `reconciliation_alerts.run_id` is the pass that first raised it |
| `skipped` | no external figure — an unreachable API, or a demo tenant on `FakeProvider`. A skipped rail is not a clean rail, which is why `incomplete` exists as a resolution |
| `missing` | verified inbound events in the window with no `processed_at`: what the provider told us and the ledger never posted |

**`missing` is deliberately not a transaction-export diff**, which is what §13's
sentence literally describes. No adapter has a transaction-listing call —
`PaymentProvider` exposes `balances()` and nothing else that enumerates — so an
export comparison today would return zero for every real rail while looking
authoritative. Counting the inbox is a smaller claim that is true, and widening
it later is an adapter method plus a column. `signature_ok` bounds it: a
forgery we correctly refused is not money we owe ourselves.

The window runs from the last **completed** run's `period_end`, so an event
cannot fall between two passes and be counted by neither.

### `resolve_reconciliation_run` is the one place a freeze is lifted

Freezing is arithmetic and automatic; unfreezing is a judgement about whether
the difference has been *explained*. So it takes a name, closes the alerts that
run raised, refuses while any case on the tenant is still open, and puts the
unfreeze behind a separate argument — writing down what happened and declaring
the money accounted for are two different claims, and an operator must be able
to make the first without making the second. Nothing here runs on a timer, so
"nothing unfreezes automatically" is intact.

### Two traps this migration walked into

- **`record_reconciliation` gained a parameter, so it was dropped and
  recreated.** `create or replace` would have added a sibling and made every
  existing five-argument call ambiguous. `tests/reconciliation-runs.test.ts`
  pins `count(*) from pg_proc` at 1, the same guard `fund_deal` carries.
- **`found` reflects the last statement, not the last `select into`.** The
  counter `update` was written between the alert lookup and its `if found`, and
  silently turned "no open alert" into "there is one" — so a first mismatch
  updated a null row and never inserted the case at all. Every open-alert test
  in the existing suite still passed, because they all ran without a run id.
  The function tests `a.id is not null` from that point down.

§13's "any mismatch produces a case rather than silently altering balances" was
already true and is now structural: `tests/reconciliation-runs.test.ts` asserts
that none of the five functions names `write_ledger`, `insert into ledger` or
`settle_payout`, matched against their bodies with comments stripped — the same
technique the checkout tests use, and for the same reason, since these headers
explain the property at length.

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

Set the secret once in **Vault**, matching the `CRON_SECRET` function secret,
and keep the value out of the script and out of git:

```sql
select vault.create_secret('…', 'payhold_cron_secret',
  'Shared secret the scheduled jobs send as x-cron-secret.');
```

**Vault rather than a GUC, because a GUC is not available here.** The obvious
form — `alter database postgres set payhold.cron_secret = '…'` — fails on
Supabase with `permission denied to set parameter`: the database is owned by
`supabase_admin`, and the `postgres` role we connect as is not a superuser, so
it may set the parameter at neither database nor role level. Vault is the
platform's own mechanism and encrypts the value at rest, which
`pg_db_role_setting` would not have. The jobs read it with a subquery against
`vault.decrypted_secrets`, so rotating it is `vault.update_secret` and no
rescheduling.

The times are staggered, and the order is the point: **reconcile :00 →
auto-release :10 → payout-dispatch :20.** Reconciliation goes first because
drift freezes payouts, and a dispatch that ran before it would send money out of
a balance we already know we cannot explain. Webhook delivery runs every minute,
independent of all of it — the retry backoff assumes a pass at least that often.

One trap when checking on them: `net.http_post` returns a request id
immediately, so a `cron.job_run_details` row saying "succeeded" means the
request was *queued*, not that the function returned 200. The status codes are
in `net._http_response`.

## The launch gate — §16 and §17, migration `20260807000015`

One migration, not two: nothing here uses a value from `alter type ... add
value`, and a type created inside a transaction is usable inside it.

**Live credentials are refused while a required item is outstanding.**
`assertLiveAllowed` is called from `functions/provider-accounts/` and nowhere
else, and that is defensible for one reason: there is exactly one writer of
`tenant_provider_accounts`, and a rail with no stored account falls back to
`FakeProvider`. `tests/launch-gate.test.ts` asserts the writer stays singular —
if a second one appears, that test is what says the gate has a hole. The check
runs **before** the credentials are validated, because refusing after we have
sent a live secret key to the provider would have already used it.

Three decisions worth knowing:

- **The sign-off is an event and the state is derived.** `launch_sign_offs` is
  append-only with the same trigger shape as `ledger` and `audit_log`, and
  `launch_status()` reads the latest row per item. Withdrawing is a new row
  saying so, for the reason a ledger correction is an opposite entry — "who said
  this was fine, and when did they stop saying it" is the question asked after
  something goes wrong, and an update erases half the answer.
- **A blocked item cannot be signed, by anybody.** `blocked_by` names unbuilt
  work and the function refuses whatever the caller's authority, because no
  amount of seniority makes an unwritten dispute window resolve a dispute.
  Withdrawing is always allowed: "I no longer stand behind this" must never be
  the harder direction.

  **The blockers that could be checked are checked, at seed time.**
  `to_regclass('public.dispute_offers')` and friends, rather than a hand-written
  claim about which phases have landed — phases 8 and 9 landed *while this
  migration was being written*. Existence is a proxy for the work being done,
  which is why a person still signs the item with evidence; what existence rules
  out is signing one that cannot possibly work.
- **No `tenant_id`.** §16's items are about the platform — our legal entity, our
  contracts, our incident-response plan — so a tenant connecting live keys is
  gated on *our* readiness, because it is our system their buyers' money would
  move through. Their own onboarding is `sellers`/§12; their own market switches
  are `payment_markets`.

`market_launch_verified(country)` is what `rails_verified` now means on
`/payment-options`, asked per country on the payout branch and across all four
markets elsewhere. It used to be a constant `false` in `_shared/rails.ts` with a
comment promising somebody would change it one day. That constant is still there
and still tested, because `payoutRoute()` is pure and stamps it on the route
object it returns; the endpoint overwrites it from the checklist, which is the
one place the two meet.

### §17 found one hole, and it was a nullable parameter

`settle_payout(p_payout_id, p_leaving, p_provider_ref)` accepted a null
reference. Every caller passed one, and `update payouts set status = 'paid'` run
by hand was a mark-as-paid control with no provider on the other end of it: the
seller recorded as paid, `payouts_deal_key` refusing a second payout for that
deal, and `reconcile` reporting drift for money that never left.

`paid_needs_a_provider_reference` is a **constraint**, not a guard inside the
function, because §17's word is *anywhere* — a guard binds the callers we know
about, and this binds the correction somebody runs at 2am. It does not claim the
reference is real; only the rail can say that, and re-fetching is what
`reconcile` is for. It claims that whoever marked this paid had to quote one.

Two fixtures had to gain a reference, and both were describing payouts that
could not have existed. One of them (`migrations.test.ts`, the `paid_at`
constraint) would otherwise have passed for the wrong reason — two constraints
violated by one row, and Postgres does not promise which it reports.

## Not built yet

- **Four lifecycle states with no writer.** `checkout_started` got one in
  Phase 7 and `partially_refunded` is deliberately permanent (§29.8);
  `in_progress`, `revision_requested`, `expired` and `canceled` each want an
  endpoint
  (§10.1 lists `POST /v1/orders/{id}/cancel` among them). The enum values and
  the transition guard already know all six, so those are endpoints rather than
  migrations. **`auto-release` and `deals_auto_release_idx` filter on
  `funded_held | confirmed_buyer | confirmed_seller`** — whoever gives
  `in_progress` or `revision_requested` a writer must widen both, or the timer
  will silently skip deals sitting in them.
- **The reminders cron.** The one scheduled job still missing. It needs a
  channel to remind people *on* — there is no email path here, and a tenant
  webhook is a notification to the client's server rather than to a buyer who
  has gone quiet — so it is a decision before it is a function.
- **End-user tokens for `confirm`.** Spec §4 has it taking one so a buyer can
  confirm without the client's API key. Phase 7 solved the same problem for
  *paying* — a checkout session is exactly that credential, scoped to one
  payment — and confirming wants the same shape rather than a general auth
  scheme. `/confirm` is still called by the client's server on the buyer's
  behalf.
- `FlutterwaveProvider`'s and `StripeProvider`'s live calls are unexercised
  until real keys are connected — every test to date runs against
  `FakeProvider`, an intercepted `fetch`, or PGlite. `stripe.test.ts` pins the
  request shapes and the signature check without touching the network, which is
  as far as CI should go.
- **§9's other two adapters.** `cash_app_pay` and `china_wallet_partner` have
  enum values, capability rows and payout routes, and no classes. `loadProvider`
  throws for them by name rather than falling back to the fake, because a deal
  routed to an adapter that silently collected nothing would be worse than a
  loud failure. **PayPal has a class as of `20260808000003`** and is connectable
  — see below — but its capability row stays `enabled = false`, so
  `loadProvider` throws for it too, by the *second* of those two branches. That
  is the distinction `implemented`/`enabled` was split to draw.
- Seed: AutoHire as tenant #1.
- **Invitations.** `POST /account/signup` creates a company and its owner;
  there is no path for a second person to join one that exists. `tenant_users`
  already carries `staff` and `viewer`, so this is an endpoint and an email,
  not a schema change.
- **Password reset.** GoTrue does it, and it needs the same SMTP sender email
  confirmation is waiting on.
- ~~The dashboard still runs on its mock.~~ **It does not, as of the cut-over.**
  `src/api/http.ts` implements the whole of `PayHoldClient` against these
  functions, `src/api/mock/` is deleted, and a build without
  `VITE_SUPABASE_URL` throws instead of simulating. The consequence for this
  repository is that **the acceptance specs moved here**: `tests/` against
  PGlite is what pins the invariants, and `scripts/sandbox-walkthrough.md` is
  what proves them end to end.
- ~~Four reads Phase 10's screens expect and this side does not serve.~~
  **All four are served now**, which is what unblocks `HttpClient`:

  | Client method | Endpoint |
  |---|---|
  | `getDealAmounts` | embedded as `amounts` on `GET /v1/deals/:id` |
  | `listRefunds` | `GET /v1/deals/:id/refunds` |
  | `listSellerDestinations` | `GET /v1/sellers/:id/destinations` |
  | `listCheckoutSessions` | `GET /v1/checkout/sessions[?deal_id=]` |

  Each is a select over something already built. Three things they do that are
  worth not undoing:

  **The session list strips the token on anything not live.** A token *is* the
  credential — `/checkout/public/:token` takes no other — so a dead one in a
  list would be a plaintext credential outliving the session it belonged to.
  Liveness comes from `state()`, this file's mirror of SQL's
  `checkout_session_state`, rather than from the function itself: that function
  takes a **row**, so reaching it per session would be a round trip each on a
  page whose purpose is showing them together.

  **The destinations list never selects `beneficiary_token`.** A screen needs
  the mask; the token is what money moves against, and a list endpoint is
  exactly where one would leak.

  **Both seller and deal reads scope through the existing 404 first**
  (`ownSeller`, `getDeal`), so a sub-resource cannot confirm that another
  account's row exists — invariant 8, which a new sub-route is the easiest
  place to forget.
- **A counter-statement column.** §8's respondent files their case as evidence
  of kind `message` rather than into a field of its own. Worth knowing when
  reading a draft that says the seller never replied — it may mean they replied
  as evidence.

- **Shadow mode.** The working agreement says a new prompt ships with its
  suggestions logged and not shown, compared against the humans' actual
  decisions, then enabled per tenant. `ai_suggestions` records everything
  needed for that comparison; what is missing is the flag that hides a draft
  from the queue while it accumulates.
- **Live model calls are unexercised**, the same way Flutterwave's are. Every
  test runs against the validators, the corpus and PGlite; nothing in CI calls
  Claude, and nothing should.

The acceptance spec for all of it used to be
`payhold-dashboard/src/api/mock/engine.test.ts`. That file is gone with the mock
it tested, and `tests/` here is what took the claim over — every invariant it
pinned in a browser is pinned against real Postgres now. What no automated
suite covers is `scripts/sandbox-walkthrough.md`, and that is deliberate: half
of it is watching what happens on a provider's own dashboard, and a script that
could green-light itself is the thing the launch gate exists to prevent.
