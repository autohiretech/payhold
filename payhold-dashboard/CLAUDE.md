# payhold-dashboard

React + Vite + Tailwind 4 on Cloudflare Pages. The product's face for client
companies, and a pure client of the PayHold public API — **no secrets, no
direct database access, ever**.

See `../CLAUDE.md` for the product rules that bind both repos (the escrow
wording ban, the money invariants, the API contract).

## Current state: a client of the real API

Every screen reads and writes `payhold-backend`'s Edge Functions. There is no
mock, no fixture data and no dev panel: `src/api/mock/` implemented the whole v1
contract as a state machine in localStorage, and it is deleted.

```
npm run dev        # http://localhost:5173 — needs .env.local, see below
npm test           # the route gate, and the rails table
npm run typecheck
npm run build
```

**`.env.local` is required.** `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`
both have to be set, and `@/config` throws at import when either is missing.
That used to be the switch that chose the mock, which meant a misconfigured
deploy and a working demo looked identical from the outside — every screen
rendered, every number was invented, and nothing said so.

The dashboard is behind a sign-in against real Supabase Auth. Create an account
and you get an empty company, which is what `POST /account/signup` produces; a
company with deals in it now means somebody made deals.

What the dev panel could do — fund a deal, advance the clock, run cron, force a
payout failure, inject drift — is not coming back. Each of those is something
only a provider webhook or a scheduled job may cause, and a dashboard that could
do any of it would be a dashboard that could move money without a rail agreeing.
To exercise a lifecycle now, use `payhold-backend/scripts/sandbox-walkthrough.md`
against provider test keys.

## Deploying

Cloudflare Pages, published by `.github/workflows/deploy-dashboard.yml` on a
push to `main` that touches this directory. Tests and typecheck run first and
the publish depends on them — which is the reason to use Actions rather than
Cloudflare's own Git integration, since that builds whatever is on main whether
or not it works.

One-time setup, none of which can be done from here:

1. **Create the Pages project.** Cloudflare dashboard → Workers & Pages →
   Create → Pages → *Direct Upload*, named `payhold-dashboard`. Direct upload,
   not Git — the workflow uploads the build, so connecting Git as well would
   give you two pipelines racing to publish.
2. **Create an API token** with the *Cloudflare Pages: Edit* permission.
3. **Add two GitHub secrets** under Settings → Secrets and variables → Actions:
   `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

Until those exist the workflow builds and tests and skips the publish, rather
than failing.

`.env.example` is the whole configuration surface, and all of it is public by
design. `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are set at build time
as repository *variables*, not secrets, since they end up in the bundle either
way. **Both are required and the build fails without them** — there is no
fallback to simulate against. The service-role key has no `VITE_` name it could
hide behind and must never appear here.

`public/_redirects` is what makes client-side routing work: without it a buyer
opening `/pay/:token` from an email gets Cloudflare's 404, because there is no
file at that path. `public/_headers` denies framing — a payment page inside
someone else's iframe is the setup for a clickjacked confirmation.

**What ships is the real thing.** `src/api/index.ts` constructs `HttpClient`
against the project named in the build environment, and the sign-in in front of
it is Supabase Auth. A deployed build with the variables unset does not start.

## Signing in

**The dashboard is behind a login.** One gate — `RequireAuth` wrapping the one
route that has dashboard chrome, so a screen added under it cannot forget to be
protected. The hosted buyer and seller pages (`/pay/:token`, `/status/:id`) are
deliberately outside it: someone opening a payment link from an email has no
PayHold account and must never be asked for one.

`src/auth/` is a second seam, shaped like the API one:

```
src/auth/
├── types.ts         AuthBackend, AuthAccount, MIN_PASSWORD_LENGTH, actorId
├── index.ts         exports `auth`
├── supabase.ts      Supabase Auth + the `account` Edge Function
└── AuthProvider.tsx context, `useAuth`, `RequireAuth`
```

**Signing in does not go through an Edge Function.** The dashboard posts to
Supabase Auth's `/auth/v1/token` and holds the JWT; every API call carries it and
`resolveCaller` verifies it server-side. Signup is the exception and goes to
`POST /account/signup`, because two things must happen together — the auth user
and the `tenant_users` row that makes them a *PayHold* user — and a browser can
only do one of them.

A session resolves to exactly **one tenant**, and `/account/me` is what turns it
into one. There is no "account with no company": a user that authenticates but
has no membership is signed straight back out.

`mock.ts` and `password.ts` used to sit in that directory — browser-simulated
accounts over the mock store, and a hand-rolled digest to make them look like
something. Both are deleted. A password in this repository now has exactly one
destination, which is the property worth having: real passwords go to Supabase
Auth and are bcrypt-hashed there, minimum twelve characters, enforced in
`functions/account/` and in `config.toml` as well as next to the field.

**Signing out clears the React Query cache**, before the next sign-in rather
than after. The cache is keyed by query name and not by tenant, so leaving it
would let the next person on this machine see the last one's deals in the moment
before the first refetch lands.

## The seam

```
src/api/
├── types.ts     the v1 domain types — copy verbatim into payhold-backend
├── client.ts    PayHoldClient interface — what every screen codes against
├── http.ts      HttpClient — its one implementation, against the Edge Functions
└── index.ts     exports `api`
```

Screens import `api` from `@/api` and nothing else. The interface stays, even
with one implementation behind it: it is the list of things the dashboard is
allowed to ask for, and §17's "no manual mark-as-paid control **anywhere**" is
partly enforced by `markPayoutPaid` not being on it.

**No method takes the name of the person doing it.** Verifying a seller,
clearing a payout hold, deciding a dispute, signing off a launch item and
approving an AI draft are all recorded against somebody, and that somebody comes
from the session on the server. Those parameters existed because the mock had no
session to read; they are gone rather than ignored, because an argument a caller
can set is an argument a caller can forge. `actorId(account)` in `@/auth` is
what a screen compares against a *recorded* actor — the backend writes
`user:<email>`, and §8's conflict-of-interest warning would never fire against a
display name.

Three places `http.ts` does not paper over a difference between the interface
and the API, deliberately:

- **`listDeals`'s `search` is filtered client-side**, because the endpoint
  offers no such parameter and a query string the backend ignores would be a
  filter that silently does nothing.
- **`listRefunds` and `listSellerDestinations` refuse a call with no id.** Those
  records hang off a deal or a seller; returning `[]` would read as an answer.
- **`getDeal` drops the `amounts` the endpoint embeds**, so a screen asking what
  was agreed and one asking what happened still go through different methods.

**`getPublicCheckout` and `payCheckout` go out with no bearer token**, and that
is the one thing in this file not to 'fix'. Whoever opens a payment link from an
email has no PayHold account, so the token in their URL *is* the authorisation.
They carry Supabase's anon key, which the gateway needs to route the request and
which grants nothing on its own.

**`counter_statement` is always null.** §8's respondent files their side as
evidence of kind `message` rather than into a field of its own, so the column
does not exist on the backend and `http.ts` says so plainly rather than leaving
a screen to conclude the other party never replied.

## Where the invariants live now

`src/api/mock/engine.test.ts` used to be the acceptance spec for the money
paths, with four suites beside it — webhooks, risk rules, reconciliation, payout
retry. All of it is deleted, and the claims moved rather than disappearing:

| What was pinned here | Where it is pinned now |
|---|---|
| release needs both confirmations, no double release, refund blocked after release | `payhold-backend/tests/lifecycle.test.ts` |
| balances derived purely from ledger entries, six buckets | `tests/money-breakdown.test.ts`, `tests/seller-wallet.test.ts` |
| a rule holds a payout and does nothing else; only a person clears it | `tests/manual-hold.test.ts`, `tests/payout-routing.test.ts` |
| drift is found by comparing against a provider balance; nothing unfreezes itself | `tests/reconciliation-runs.test.ts` |
| the backoff ladder, and null meaning no machine may retry | `tests/payout-retry.test.ts` |
| every state change queues one signed notification | `tests/webhooks-risk-reconciliation.test.ts` |
| the signature a client verifies, byte for byte | `_shared/crypto.test.ts` |

Two of those were only ever provable against real Postgres anyway — RLS and the
row locks — which is the argument for the move rather than a consolation for it.
What no automated suite covers is the end-to-end walk, and that is deliberate:
`payhold-backend/scripts/sandbox-walkthrough.md` is half watching a provider's
own dashboard, and a script that could green-light itself is what the launch
gate exists to prevent.

**What is still tested here is what only exists here.** `src/auth/gate.test.ts`
mounts the real route table and asserts the gate: no session lands on `/login`,
a session gets through, and `/pay/:token` is reachable by a stranger. It stubs
both seams — a session that is present or absent, and an API that answers
nothing — because reintroducing a mock backend to test a router would be
maintaining the thing this repository just stopped shipping. `rails.test.ts`
asserts no rail is marked verified.

## Intelligence (root spec §12)

The drafts come from `payhold-backend/functions/ai-dispute`,
`ai-risk-narrator`, `ai-support` and `ai-decisions`. There was a deterministic
stand-in here — `src/api/mock/ai.ts`, so demo mode with zero keys worked end to
end — and it is deleted with the rest. `types.ts` is what holds the two sides
together: the backend's validators mirror `DisputeSuggestionOutput` and
`RiskSummaryOutput` field for field, and a field added on one side only is a
screen that renders nothing.

With the model behind it for real, two things follow that the stand-in hid.
Drafting takes a second and can fail, so every AI call is a `useAiMutation` with
its own pending and error state rather than something that resolves instantly.
And `ai_enabled: false`, or a spent `ai_monthly_budget_usd`, is a state you now
reach by setting it on the Settings screen rather than by switching to a fixture
tenant — the §12.5 claim is that every money path behaves identically either
way, and that is checkable on any account.

The one rule everything is arranged around is invariant 9 — **it advises, a
person decides**:

- Drafting and chatting write to `ai_suggestions`, `ai_chat` and `audit_log`.
  They touch no deal, no ledger entry and no payout — enforced by a Postgres
  role rather than by convention: the drafting functions connect as
  `payhold_ai`, which holds execute on nothing that moves money, and
  `payhold-backend/tests/intelligence.test.ts` asserts the refusal for all nine
  money functions.
- `decideAiSuggestion` is the only path that can end in money moving, and only
  on `approved` — it then calls the *same* `resolveDispute` an admin would have
  called by hand, audited as their decision. Rejecting, approving an
  `escalate`, or approving any risk summary moves nothing.
- Approving is a `useMoneyMutation`; drafting and chat use `useAiMutation`,
  which invalidates only the three AI queries. A deal list that refreshed
  because someone asked a question would be a small lie about what happened.
- **There is a `partial_refund` recommendation as of Phase 3.** It carries a
  `refund_amount` in presentment minor units, validated against what the buyer
  paid — a split naming more than that is discarded, not shown (§24.5).
  `escalate` still exists and goes back to meaning what it says: the file does
  not settle the question, and no split resolves it either. Approving a split
  refunds that much and releases the rest, and the dispute is labelled
  `dispute_split` so §24.4 does not learn the buyer won outright.

The assistant is a **corner panel, not a page** (`components/assistant.tsx`):
⌘K or the launcher from anywhere, `?ask=1` to deep-link it open. It docks
bottom-right with no scrim on desktop — the screen behind stays usable, because
a question is something you have *while* looking at a payout, not instead of.
Small screens get the sheet-and-scrim treatment where there is no room to dock.

**It opens empty and stays empty until asked.** No seeded transcript: a panel
that opens already full of this account's business is noise at best, and at
worst it reads as something that happened while you were away.

Answers can carry records. Attachments hold an **id, not a snapshot**, so a
draft shown an hour ago renders today's truth — which is also why the Approve
button inside a transcript is the same button, the same call and the same audit
row as the one on the Resolution Center.

Commands (`/help` lists them) read the whole account: `/queue`, `/deal`,
`/evidence`, `/draft`, `/risk`, `/disputes`, `/deals`, `/payouts`, `/balance`,
`/audit`. **`/approve <id>` and `/reject <id>` execute**, and that is not a hole
in invariant 9: an exact command naming one record is the operator deciding in
their own session, parsed literally with no inference, recorded against them.
Anything the model would have to *interpret* — "approve that for me" — is
refused and answered with the card and its buttons instead. The parser is
`components/assistant.tsx`, and the line it draws is the thing to preserve when
touching it.

The Intelligence page is a **queue, not a dashboard**: one column, and nothing gets a card
unless you act on it. Two columns produced an L-shaped hole whenever the queue
was empty, which is most of the time. A suggestion never nests a tinted box
inside another box — `variant="standalone"` is the card on the Intelligence
page, `variant="inline"` is the inset panel inside a dispute or a payout row.
Provenance (prompt version, input hash) collapses behind a Details toggle: it
is what makes a decision reproducible and it is noise while you are making one.

Dispute evidence carries a **URL, not a file**. The client's site serves the
images; we store the reference, so a case can be reviewed with the photos in
front of you while the files stay theirs. There were fixture photos here, drawn
as inline SVG data URIs precisely so nobody could mistake one for a record of
something that happened; they went with the seed. Note the split that remains:
people see the images, **the assistant is given the descriptions**, which is
what spec §12.2 says it reads.

`deal_outcomes` is written by **triggers on the money path**, not by anything
AI, so the labels §24.4 will train on cover every resolution including the ones
no model saw — a training set of only AI-assisted cases would be biased from the
first row. A trigger for the reason `enqueue_webhooks` is one: a label every
future code path must remember is one that gets forgotten.

`risk_signals` (spec §12.3) are persisted at screening time — `screen_payout`
writes them whether or not the rules are switched on, because the history is
what a fraud model of our own trains on later and it cannot be backfilled. The
narrator is handed the stored rows as findings to explain rather than
re-deriving them.

`dispute-assistant@2` reads §8's evidence and the offers the parties have
already exchanged, and each description is handed over **wrapped as untrusted**,
the same way the opening statement is: it is written by a member of the public
and it is *about* the question being asked, which is what makes it the injection
surface. Invariant 9 is why a successful injection costs a wasted click rather
than money.

## The Fraud screen

`src/screens/Fraud.tsx` is where a person reads what the controls noticed. It is
ordered by how much a row deserves to be believed, top to bottom, and that
ordering is the design:

1. **Held for review** — the only rows with somebody waiting on the other end.
2. **What the rules noticed** — signals, recorded whether or not the rules are
   switched on, because the setting governs holding and not noticing.
3. **Where payments came from** — `request_context`, last on purpose. An IP
   table at the top of a fraud screen invites people to read addresses as
   accusations, and these addresses are the newest and weakest evidence on the
   page.

Every origin row carries its provenance as words rather than a colour —
"Provider saw it", "Our page saw it", "Client told us" — because the difference
between an observation and a claim is the whole point, and nobody should have to
learn a palette to notice that one of the three is something a client typed.

Two things the copy is doing deliberately. A repeated address is annotated
("seen on 3 payments") and **not** flagged: mobile money in Rwanda and Kenya
runs behind carrier-grade NAT, so a shared address is usually a carrier rather
than a person, and a screen that cried wolf on that would be wrong about most of
this account's honest traffic. And the footer names the three controls that
never appear here — 3D Secure, tokenisation, Radar — because a fraud screen that
lists only what it can show implies the other three do not exist.

**Nothing on this side writes an origin.** `PayHoldClient` has a read and no
writer, and the only writers anywhere are the `/pay` handler and the provider
webhook. A client that could invent an address would be a client that could
manufacture the evidence a rule is checked against.

**The AI on this screen is the risk narrator, and it is on the reading side of
the line.** "Brief me" on a held payout drafts a summary of the counterparties —
how long the seller has been registered, what they have been paid before,
whether a dispute has gone against them — through the same `draftRiskSummary`
the Payouts screen calls. It writes a suggestion and touches no money, which is
invariant 9 and also the reason it is safe to put on a fraud screen at all:
holding is arithmetic over our own tables, so a rule can be reproduced and
argued with, and that is exactly what a model cannot offer. The four controls in
the footer are still four — the narrator is not a fifth, and clearing the hold
stays on Payouts where the approval is recorded against a person.

**Held for review means `held_for_review`, not `frozen`.** They are different
stops with different remedies: one payout waiting on one person, versus the
whole account stopped by reconciliation. The account-wide freeze is a banner on
this screen rather than rows in the table, the same way Payouts shows it.

**Every name is a link.** A fraud screen exists to put a person in front of
somebody, so seller names go to `/sellers/:id` and each table carries the deal's
`buyer_ref` beside it. `buyer_ref` is the client's own identifier and the only
buyer-side handle PayHold has — we store no buyer PII — which is why the same
buyer appearing twice is something an operator can see and we cannot name.

## The Routing Center (spec §5.1)

`src/screens/Routing.tsx` answers three questions in the order somebody asks
them: what is stopped and why, where money can go at all, and where it would
land.

**It is read-only, and that is structural.** Enablement is a row an operator
changes deliberately; a dashboard that could switch its own corridors on would
have turned §5's country-launch checklist into a field it sets. Nothing here
moves money either — the button that ends a hold stays on Payouts, where the
approval is recorded against a person.

The stopped queue **reads the recorded decision** rather than re-deriving one.
`payout_decisions` exists because §5.1 wants the choice auditable after the
fact, and re-running `routeEvaluation` now would answer a different question —
"what would we do today" instead of "what did we do". `scheduled` is deliberately
not in `STUCK`: a scheduled payout is waiting for a date the deal already
states, and a queue full of rows nobody has to act on is a queue nobody reads.

One routing read per stopped payout, via `useQueries`. That is the shape the API
offers — a decision hangs off a payout and there is no bulk endpoint — and
scoping it to the stopped ones is what keeps a busy account from fetching a
decision for every payout it has ever made.

**`routeReasonText` moved to `src/lib/rails.ts`.** It is still the mirror of
SQL's `route_reason_text`, but both sides of the seam need it now: the engine
writes it onto `payout.failure_reason`, and this screen turns a *stored* reason
code back into the same sentence. It lived in `api/mock/routing.ts` first, and
moving it is why this screen still works now that the mock is gone — everything
left in that directory went with it. The rail is still interpolated
raw rather than through `PAYOUT_PROVIDER_LABEL`, because the string has to match
what Postgres produces character for character.

## The Resolution Center screen

`src/screens/Resolution.tsx` replaced `Disputes`, which showed a statement and
two buttons. The buttons were never the problem — what was missing is everything
you need before pressing one, which is §16's `operator_screens` in a sentence.
One card per dispute, three tabs (the case, the requests, the timeline), and the
route is still `/disputes`: the object is a dispute in our own code and only the
screen moved, the same split §29.2 drew for the event names.

**The open request sits above the tabs rather than inside one.** It is the only
thing on the card with a clock running on it, and at 48 hours it lapses with
nothing moved and the dispute still open.

Four things are load-bearing:

- **A lapsed request never reads as a declined one.** `DISPUTE_OFFER_STATUS_META`
  gives `expired` "nobody answered inside 48 hours" and `declined` somebody
  having said no. Declining is an act; §24.3's labels cannot be backfilled, so
  collapsing the two would lose the difference permanently.
- **`disputed_amount` is enforced in the form.** A partial dispute disables the
  full-refund option and carries the reason in its tooltip and under the row,
  rather than offering it for `resolveDispute` to refuse. A disabled control
  that says why is a smaller surprise than a failed call.
- **Recording a request costs you the decision, and the screen says so before
  you act.** §8's conflict-of-interest control is on who *acted* — there is no
  identity to join a deciding administrator to, since we store no buyer PII and
  a seller has no login. So an operator writing down a request a party made over
  the phone disqualifies themselves from ruling on it, and the decide panel
  replaces itself with that explanation once it applies.
- **The side and the actor are separate fields.** The side is whose request it
  is; the actor is who wrote it down, and only the second has a login.
  Conflating them would put an operator's name on a buyer's request as though
  the operator were the buyer.

**A request is made on this screen or it does not exist.** `dispute-assistant@2`
reads the offers, so what the assistant is given depends on what the parties
have actually exchanged — there is no fixture standing in for a conversation.

## Reconciliation passes on Admin

The alerts table says what is wrong *now* and structurally cannot say that we
looked. `RunsCard` is §13's other half: one row per account per rail, the window
it covered, and four counters — of which `skipped` (a rail with no external
figure) and `missing` (events the provider told us about that the ledger never
posted) are different questions and are shown apart.

`resolveReconciliationRun` is the sign-off, and it is the **recorded** way to
lift a freeze: a name, a note, and the unfreeze behind its own checkbox, because
writing down what happened and declaring the money accounted for are two claims.

**The per-tenant unfreeze on the accounts table is no longer the blunt
instrument it was.** It used to close an account's open cases with no name and
no note, which is what the run sign-off was built to replace. The endpoint now
refuses it while any case on that account is open — the same condition
`resolve_reconciliation_run` enforces — so what remains of it is the case it is
actually for: a freeze somebody placed by hand, which has no pass to sign off.

**"Run now" runs the real pass**, the same `reconcileAll` the nightly cron
calls. There is nothing seeded in this table: a row here means a pass happened.

## Seller wallets

The Sellers screen renders `listSellerWallets`, which is `seller_wallet_rows` in
SQL — the same arithmetic as `rail_balances`, grouped by seller rather than by
rail. The property that makes it trustworthy is that **every seller's wallet
summed is the tenant's balance**, bucket for bucket, less `fees_retained`;
`payhold-backend/tests/seller-wallet.test.ts` asserts it with a non-zero
`fees_retained` so it cannot pass by everything happening to be equal.

`fees_retained` is **absent from the wallet type**, not zeroed. It is our
commission and collected tax; a wallet is a screen a seller is shown.

`held` is gross and everything past it is net — nothing is struck inside the
hold, since the fee is booked at release. The screen labels that column **In
progress** rather than anything that reads like a drawable balance, and the
footnote says why. `DealAmounts.seller_net` is what a held deal is actually
worth to them.

The card is read-only, like the Routing Center and for the same reason: it says
where the money is, and every button that moves any of it stays on Payouts where
the decision is recorded against a person.

## The seller page

`src/screens/SellerDetail.tsx` is one counterparty and everything this account
knows about them: onboarding state, destinations and route, every deal, every
payout, every signal their name is on, and where their buyers paid from. It is a
record and not a verdict — nothing on it scores anybody.

**It now carries exactly one action, and it is not a payout decision.** Clearing
a hold still belongs on Payouts, because a hold is a question about one payment.
Attesting that a seller's identity, sanctions screen and ownership came back is
a fact about the seller, §12 requires a person to record it, and this is the page
that person is looking at. `verifySeller` takes the name from the session and
never from a form — a caller that can name its own verifier can forge one.

The onboarding card renders `getSellerCapabilities`, which returns **every**
reason rather than the first. The two lists stay visually apart because they are
apart in the API: `reasons` is work for the seller and each one holds a payout,
`route_reasons` is work for us and none of them do. `onboarding.test.ts` pins
that the first list is `sellerEligibility` unchanged — a capabilities read that
drifted from the gate would be a page telling a seller they are fine while their
payout sits held, which is the failure §10.1's endpoint exists to prevent.

The column worth keeping is **age at creation**, shown per deal rather than as
one "registered" date. That is the figure the new-seller rule fires on, and
`risk.ts` measures it at the deal's creation for a reason the page repeats: with
a seven-day clearance window every seller is a week old by the time their first
payout comes due, so measuring at payout time would make the rule unfireable.

## Outbound webhooks, and what a client verifies

Deliveries are the backend's — `webhook-dispatch` signs each one with the
endpoint's decrypted secret and records the outcome. There was a real
synchronous HMAC in `src/lib/hmac.ts` here, because the mock signed for real
rather than emitting a decorative string; it is deleted, and with it the second
copy of the header construction.

What that means for anyone touching the format: `PayHold-Signature:
t=<unix>,v1=<hmac-sha256>` over `<t>.<raw body>` is now pinned in exactly one
place, `payhold-backend/_shared/crypto.test.ts`. Treat it as a published
contract — clients verify against it, and there is no longer a second suite that
would fail if it moved.

The Settings screen shows deliveries with their signature and status, and offers
a retry. **Retrying re-arms the clock rather than sending from the browser**: the
row comes back `pending` and `webhook-dispatch` sends it within the minute, which
is what actually happened. Attempts are not reset, so a person's retry is one
more attempt rather than a fresh series of five against a server that has already
refused us five times.

**The signing secret is shown once, at creation, and never again.** It is
encrypted rather than hashed on the backend because it has to be *used* on every
delivery, and there is no endpoint that reads it back.

## Risk rules, and who may stop a payout

The rules are `screen_payout` in SQL and they run in the transaction that then
holds the payout. A rule can set `held_for_review` and nothing else — no ledger
write, no transfer, no change to the deal — and `approve_payout_review` is the
only way out, taking the approver from the session.

**A person can place that second kind of stop too** — `holdPayout`, the Hold
button on the Payouts screen. It is the narrow alternative to freezing an
account, which stops every honest seller to stop one. It takes a reason, because
the next person to look at the row has nothing else to go on, and
`review_held_by` is what distinguishes it from a rule's hold wherever a hold is
read: a name means somebody you can go and ask, null means arithmetic. It
refuses `paid` and `processing` — money already with the provider is recalled by
a phone call, not a button.

`frozen` and `held_for_review` are separate statuses and stay separate on the
screens: the first is the whole account stopped by reconciliation, the second is
one payout waiting on one person.

Seller age is measured **at the deal's creation**, not at payout time. With a
clearance window of a week or more, every seller is old by the time their first
payout comes due, so measuring at payout would make the new-seller rule
unfireable. `SellerDetail` shows it per deal for that reason.

## Payout routing (spec §5.1)

The engine is `20260807000009_payout_routing.sql`. This side reads two things
out of it — `GET /v1/payout-routes` for the table, and the recorded
`payout_decisions` row for one payout — and computes neither. There used to be a
mirror of the whole thing in `src/api/mock/routing.ts`; it is deleted, and the
one piece that had to survive is `routeReasonText` in `src/lib/rails.ts`.

**Which rail carries a payout is data.** A `tenant_id` of null is the platform
default; a tenant row for the same rail **replaces** it, or switching a rail off
for one company would leave the platform's enabled row still eligible. §12 wants
a corridor disabled without a redeploy, which is why the screen is read-only:
enablement is a row an operator changes.

**A route is never a fallback for another route.** §5.1 forbids silently
redirecting funds to another destination, and a destination is a token minted
for one rail — so the fallback is the seller's **backup destination**, gated on
a failed primary, `payout_primary_attempts`, `payout_backup_enabled`, and the
backup being verified and out of its security hold. Taking it emits
`payout.route_changed` once.

**Destinations are their own table.** `seller_destinations` is the record;
`Seller.beneficiary_token` and `masked_destination` are the primary's copy, kept
in step by a trigger with exactly one writer — which is also why creating a
seller here is one call and not two.

**Two new payout statuses, separated by who ends them.** `held_for_review` needs
a named approval; `needs_verification` (§12) needs an attestation and is
deliberately *not* approvable, which is what closes the hole where an operator
could wave a payout past a seller nobody had verified; `blocked` (§5.1's
no-route case, and a disputed deal) ends when a route exists or the dispute
resolves. Both new ones are in the cron's `DISPATCHABLE`, because neither waits
on a decision and re-asking overrules nobody.

`display_status` is §5.1's seven-state seller-facing vocabulary, derived on the
backend and read off `GET /v1/payouts/:id` — `clearing` and `available` come
from the *deal's* window rather than from the payout, because storing them would
be one fact with two writers. `frozen` and `held_for_review` both read as
`blocked` there, since to a seller they are the same thing and naming a review
queue at them invites them to fix what is not theirs to fix. `PAYOUT_STATUS_META`
is the other vocabulary, the operator's, and the Payouts screen uses that one.

`payhold-backend/tests/payout-routing.test.ts` is the acceptance suite, §5.2's
eight cases included.

## Hosted checkout sessions (spec §10.1)

**A session is a scoped, expiring credential for one payment on one deal** — so
a buyer can choose a payment method without holding an API key and without the
client's server proxying the choice. `getPublicCheckout` and `payCheckout` are
the only client methods that are **not** tenant-scoped, deliberately: whoever
opens a payment link has no session and no tenant, and the token is what
authorises the read.

**Nothing in it funds a deal.** Completing a session moves the deal to
`payment_pending` and stops. `funded_held` comes only from a provider webhook
that checked a signature *and* re-fetched the transaction, which is now the only
way a deal in this dashboard can become funded at all — the dev panel's
`simulateFunding` was the other, and deleting it removed the last thing in this
repository that could make money appear.

`checkout.completed` is not the funding event — it says the buyer is done with
our page, `order.funded_held` says money arrived. Expiry is derived from
`expires_at` rather than stored, for the same reason the payout's display status
is derived from the deal's window.

`PublicCheckout` is curated by hand rather than spread from the deal: whoever
opens it is unauthenticated, so `buyer_ref`, the fee breakdown and the seller's
payout details are absent because they were never added.

**The hosted page is `/pay/:token`, not `/pay/:id`** — Phase 10 moved it. The
old screen read the deal directly, and `getDeal` is tenant-scoped: it only ever
worked because the mock lived in the same browser as the person reading it,
which is exactly the class of bug the cut-over was going to expose. A stranger
opening a payment link has no credential, so the token has to *be* the
credential.

Two capabilities went with that move, both on purpose:

- **The method list comes from the server.** `PublicCheckout.methods` is read
  off the capability matrix by the backend; the screen does not call
  `collectionRails` for itself. The registry says what is possible and the
  matrix says what is on (§29.11), and only the backend can read the second.
- **The country picker is gone.** The old page let a buyer say they were
  elsewhere and re-priced in the browser. A session is one payment at one
  amount, so re-pricing without re-creating the deal would quote a figure
  nothing agreed to. A buyer in the wrong market needs a new link, which is a
  click on the deal.

The link itself is issued from `DealDetail` — `openCheckoutSession` is
idempotent, so the button hands back the live one rather than minting a second.

## The launch gate (spec §16, §17)

`20260807000015_launch_gate.sql` is the whole of it, and this side barely
touches it: `getLaunchChecklist` and `signOffLaunchItem` exist on the client
interface, and **there is no screen**. The endpoints refuse an API key and want a
`platform_admins` session, which the dashboard's own sign-in does not produce —
this is PayHold staff's list rather than a tenant's.

What a tenant sees of the gate is the refusal. **`connectProvider` refuses
`mode: 'live'` while a required item is outstanding**, and refuses it *before*
the credential fields are validated — refusing after we have sent a live secret
key to the provider would be refusing too late. The mock used to enforce that
itself so the dashboard could not look like it accepted something the real API
rejects; now there is only the real API, and the refusal arrives as an error on
the Rails screen with the outstanding items named in it.

The §17 half of that claim is one this side can still make on its own, and it is
worth keeping in mind when adding a method: not "is there a constraint" but "is
there a **method**". A screen cannot call what does not exist, so
`markPayoutPaid`, `settlePayout`, `writeLedger` and `adjustBalance` being absent
from `PayHoldClient` is the form "no manual mark-as-paid control **anywhere**"
takes at this seam. The backend's `paid_needs_a_provider_reference` is the other
half, and it binds the correction somebody runs by hand at 2am.

## The Resolution Center engine (spec §8)

The engine is `20260807000017_resolution_center.sql`, and the three decisions
worth knowing before changing anything on the screen are all enforced there:

- **Silence lapses a request; it never accepts one.** §8's 48 hours end with the
  offer `expired` and the dispute still open — a clock that refunded a buyer or
  paid a seller would be a machine deciding, which invariants 9 and 11 forbid.
  `expired` is a separate status from `declined` because declining is an act,
  and §24.3's labels cannot be backfilled.
- **`disputed_amount` bounds the resolution rather than splitting the payout.**
  One payout row exists per deal, so paying the undisputed share now would leave
  nothing to send the rest with if the dispute later went the seller's way.
  `resolveDispute` is refused for a full refund when only part was disputed, and
  for a split larger than that part.
- **Conflict of interest is enforced on who acted.** We store no buyer PII and a
  seller has no login, so there is no identity to join a deciding administrator
  to. What is recorded is who did what: whoever raised the dispute, made a
  request or answered one cannot be named as its decider. `both-parties` is the
  reserved name for an agreement between the two sides, and it is the one actor
  allowed to have acted.

Two shapes this side has to match. `respondDisputeOffer` and
`withdrawDisputeOffer` take **the dispute and the offer**, because the request is
a sub-resource — `/disputes/:id/offers/:offerId/respond` — and it is the dispute
that scopes the tenant check. And the screen compares against `actorId(account)`
rather than a display name, because the actor it is comparing to was recorded by
the backend as `user:<email>`.

`payhold-backend/tests/resolution-center.test.ts` is the acceptance suite.

## The capability matrix (spec §9, §12)

`20260807000011_capability_matrix.sql` is where this lives; there was a mirror of
it in the mock and there is not one now. Two tables, two different questions:

- **`provider_capabilities`** — §9's eight flags plus `implemented` and
  `enabled`. Separate because they fail differently: an unbuilt adapter is a
  roadmap item, a disabled one is an outage. `route_evaluation` reads the row,
  so switching one off blocks exactly its own rails and nobody else's.
- **`payment_markets`** — §12's country switch, an **overlay**. A country with
  no row behaves as `lib/countries.ts` says; a row is a deliberate departure
  with a required reason. `collect` and `payout` close independently, and a
  tenant row replaces the platform's in both directions.

**Two adapters are declared and unbuilt** — `cash_app_pay` and
`china_wallet_partner`; PayPal's class exists and its rail is off for want of a
signed agreement, which is what `implemented` and `enabled` being separate
columns is for. `Provider` names an **adapter**, `PayoutProvider` names
a **rail**, and one adapter carries several: Venmo rides PayPal's API and both
Chinese wallets ride one partner. `provider_unavailable` and `provider_disabled`
are separate reason codes for that reason — same sentence to the seller,
different next action for us.

The registry stays generated and says what is *possible*; the matrix says what
is *on*. Spec §29.11.

## Payment rails

`src/lib/rails.ts` is the routing table: which provider handles which payment
method, in which market, for collection and for payout. Everything rail-related
reads from it — the checkout method picker, the deal form's preview, the Rails
screen, seller registration.

**Payouts no longer route through it.** §5.1 moved that to `payout_routes` rows,
because §12 requires a corridor to be switchable without a deploy. This file
keeps its other job — refusing a destination at registration, before it is
stored — and `PAYOUT_PROVIDER_LABEL` lives here, where the "never inline a
provider name in a screen" convention says rail vocabulary belongs. Three copies
of that map used to sit in screens, which is exactly the failure the convention
exists to prevent: §5.1 added five rails at once.

**Every row is `verified: false`.** The table encodes the *plan* from the build
spec, not a checked capability list. What a client is told is
`rails_verified` on `/v1/payment-options`, derived from §16's checklist. Before any rail carries live money, confirm
it against the provider's own country/method documentation and the signed
account agreement, then flip the flag. A wrong row means a charge that cannot be
collected — or money collected that cannot be paid out. `rails.test.ts` asserts
nothing is marked verified, so flipping one forces a deliberate update.

Two rules are structural rather than configurable:

- **Collection and payout are separate capabilities.** A rail that can take
  money cannot always send it. Cards collect only — a refund goes back to the
  card, but a payout never does.
- **African payouts always ride Flutterwave.** Stripe collects internationally
  and cannot send funds to Rwanda or Kenya, so a deal can be *collected* on
  Stripe and *paid out* on Flutterwave. This is why `RailBalance` exists: "held"
  is never one pot, and reconciliation compares each provider's rows separately.

## Conventions

- **Refunds take an optional amount** (§7.1). `refundDeal(id, reason, amount?,
  lineItems?)` — omitted means everything still refundable. A partial refund
  does **not** change the deal's status (§29.8); `getDealAmounts(id).refunded`
  is where "partly refunded" is read from. The refund panel derives what is
  still refundable from `listRefunds` with the same sum the engine guards with,
  so the form cannot offer more than the call will take.
- **What was agreed and what happened are two different reads.** `Deal`'s own
  columns are the agreement, in the settlement currency; `getDealAmounts` is
  §7's nine figures derived from the ledger, in the presentment currency. Never
  add the two sets together — `DealDetail`'s breakdown shows one or the other
  and switches on `buyer_paid !== 0`, because a funded deal showing agreed
  figures would be describing money that has already moved differently.
- **Money is integer minor units everywhere.** Only `lib/format.ts` divides by
  100. Forms take major units and convert at the boundary.
- **Balances have six buckets** (spec §7): `held`, `pending_clearance`,
  `available`, `reserved`, `fees_retained`, `paid_out`. Only the last is money
  that left. Every one of them is derived on the backend and read, never
  computed here — `getDealAmounts` is the per-deal breakdown and it is a call,
  not a function.
- Rail vocabulary (`METHOD_LABEL`, `COUNTRY_LABEL`, `PROVIDER_LABEL`) lives in
  `lib/rails.ts`. Never inline a provider or method name in a screen.
- **Light theme only.** There is no dark mode and no theme toggle. Don't add
  `dark:` variants or a `.dark` class — they will not be styled.
- Colors come from the semantic tokens in `index.css` (`bg-surface`, `text-fg`,
  `bg-held-soft`…). No raw Tailwind palette colors in screens, and no `bg-fg` /
  near-black fills — the product is white-surfaced throughout.
- Token contrast is measured, not eyeballed. The ratios are recorded at the top
  of `index.css`; if you change a color value, re-check it. `--brand` in
  particular is pinned at L 0.46 because anything lighter fails `text-brand` on
  `brand-soft`, which is the active nav item and every selected chip.
- Form controls use `border-line-strong` (3:1 against white). `--line` is for
  decorative dividers only.
- **Payout status is two vocabularies.** `PAYOUT_STATUS_META` covers
  `Payout.status`, which keeps every distinction an operator needs;
  `PayoutRouting.display_status` is §5.1's seven seller-facing states, derived
  by the backend. Public pages get the second, the Payouts screen gets the
  first.
- Status vocabulary lives in `DEAL_STATUS_META` / `PAYOUT_STATUS_META` /
  `KYC_STATUS_META`. Labels and plain-language hints are defined once, never
  inline. `DEAL_STATUSES` is in **the Postgres enum's declaration order**, so
  `order by status` reads as the lifecycle; keep the two in step.
- **The lifecycle timeline is eight steps against §6's eighteen states**, and
  the compression is deliberate: most of the new states are *positions within* a
  step rather than steps of their own, and a row each would leave six permanently
  grey on every deal that went smoothly. `clearing` and `released` are the
  exception and do get separate rows — same money, same place, differing in the
  one thing a reader cares about, which is whether the payout may go. `REACHED`
  in `DealDetail.tsx` ranks only the states that are a *sequence*; `disputed`,
  `refunded`, `expired` and `canceled` take the rank they branched from and
  render as branches, because a dispute is not further along than a hold.
- `HOLDING_STATUSES` is money still in the hold; `PAST_HOLD_STATUSES` is
  `clearing | released | payout_pending | paid_out`. Reach for the second
  wherever V1 code said `['released', 'paid_out']` — that question now has four
  answers, and `clearing` is the one people forget.
- Money mutations use `useMoneyMutation` / `useMoneyAction`, which invalidate
  every query — a release touches the deal, ledger, balance, payouts and audit
  at once.
- **Nothing here computes money.** Fees, balances, breakdowns, routing decisions
  and display statuses are all reads. A screen that derived one would be a
  second answer to a question the ledger already answers, free to disagree with
  the figure reconciliation checks against a provider.
- Public pages (`src/screens/public/`) are seen by buyers and sellers. Plain
  language, no jargon, no status codes.
