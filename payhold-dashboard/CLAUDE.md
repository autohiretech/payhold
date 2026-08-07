# payhold-dashboard

React + Vite + Tailwind 4 on Cloudflare Pages. The product's face for client
companies, and a pure client of the PayHold public API — **no secrets, no
direct database access, ever**.

See `../CLAUDE.md` for the product rules that bind both repos (the escrow
wording ban, the money invariants, the API contract).

## Current state: mock backend

There is no backend yet. `src/api/mock/` implements the entire v1 contract as a
real state machine in the browser, persisted to localStorage.

```
npm run dev        # http://localhost:5173 — sign in first, see below
npm test           # engine invariant tests
npm run typecheck
npm run build
```

The dashboard is behind a sign-in. Against the mock, use one of the fixture
logins printed on the sign-in screen (`owner@autohire.example` /
`payhold-demo-2026`), or create an account — which gets you an empty company,
the way a real signup does. See **Signing in** below.

The floating **Simulate** button (dev only) is the control panel: fund a deal,
advance the clock, run cron, force a payout failure, inject ledger drift, switch
tenant, reset fixtures. Everything a provider webhook or cron job would do.

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
design. Pointing a build at the real backend means setting `VITE_SUPABASE_URL`
and `VITE_SUPABASE_ANON_KEY` at build time — as repository *variables*, not
secrets, since they end up in the bundle either way. The service-role key has
no `VITE_` name it could hide behind and must never appear here.

`public/_redirects` is what makes client-side routing work: without it a buyer
opening `/pay/:id` from an email gets Cloudflare's 404, because there is no
file at that path. `public/_headers` denies framing — a payment page inside
someone else's iframe is the setup for a clickjacked confirmation.

**What ships today is the mock.** `src/api/index.ts` hardwires `MockClient`, so
a deployed build is a browser-side simulation with fixture deals in
localStorage: it moves no money and talks to no backend. That is fine for a
demo and wrong for anything else, and the fix is `HttpClient` plus the one line
that file was written for. The sign-in in front of it is simulated for the same
reason and by the same switch — see **Signing in**.

## Signing in

**The dashboard is behind a login.** One gate — `RequireAuth` wrapping the one
route that has dashboard chrome, so a screen added under it cannot forget to be
protected. The hosted buyer and seller pages (`/pay/:id`, `/status/:id`) are
deliberately outside it: someone opening a payment link from an email has no
PayHold account and must never be asked for one.

`src/auth/` is a second seam, shaped like the API one:

```
src/auth/
├── types.ts         AuthBackend, AuthAccount, MIN_PASSWORD_LENGTH
├── index.ts         exports `auth`; ONE line picks mock vs real
├── mock.ts          browser-simulated accounts, over the mock store
├── supabase.ts      real Supabase Auth + the `account` Edge Function
├── password.ts      digests for the mock ONLY — see the header comment
└── AuthProvider.tsx context, `useAuth`, `RequireAuth`
```

Both seams read the same environment. `VITE_SUPABASE_URL` +
`VITE_SUPABASE_ANON_KEY` set → real sessions; unset → the simulation. They must
move together with `HttpClient`: a real session in front of a browser-side
ledger is a lie about which one you are looking at.

A session resolves to exactly **one tenant**, and signing in is what sets it —
`current_tenant_id` in the mock, `tenant_users` in Postgres. There is no
"account with no company": a user that authenticates but has no membership is
signed straight back out, which is what `/account/me` enforces server-side.

Two things the mock is careful not to fake:

- **Signing up creates an empty company** — no deals, no sellers, no connected
  rails, exactly what `POST /account/signup` produces. Handing a new account
  the fixtures would teach the wrong lesson about tenant isolation.
- **Only `account.created` is audited.** The real backend cannot audit a
  sign-in; GoTrue handles it and never tells us.

`src/auth/password.ts` is a salted, iterated SHA-256 over the same synchronous
primitive `lib/hmac.ts` already carries. It is a **simulation**, not a security
control — real passwords go to Supabase Auth and are bcrypt-hashed there, and
nothing in `src/` runs in that configuration. The alternative was a fixture file
with a plaintext password in it and a login screen nobody believes.

The demo build prints its fixture logins on the sign-in screen (`DEMO_LOGINS`
in `src/api/mock/seed.ts`). That build is a browser simulation with no backend
behind it; hiding the password to a localStorage fixture would be theatre with
a support cost. They mean nothing against a real deployment.

`src/auth/mock.test.ts` is the acceptance spec for the `account` Edge Function,
the same way `engine.test.ts` is for the money paths.

## The seam

```
src/api/
├── types.ts     the v1 domain types — copy verbatim into payhold-backend
├── client.ts    PayHoldClient interface — what every screen codes against
├── index.ts     exports `api`; ONE line changes when the backend lands
├── http-ai.ts   the first slice of HttpClient — Intelligence, for real
└── mock/        store (localStorage + simulated clock), seed, engine, ai,
                 webhooks, risk, accounts, client
```

Screens import `api` from `@/api` and nothing else. When `HttpClient` exists,
`src/api/index.ts` picks it based on an env flag and no screen changes.

**The backend is arriving in slices, and the first one is here.**
`AiHttpClient` is a decorator: it takes the mock and overrides the eight
Intelligence methods with calls to the real Edge Functions, leaving every other
screen on the simulation. `VITE_PAYHOLD_AI_LIVE=1`, alongside the Supabase pair,
turns it on.

That flag is deliberately *not* the Supabase pair. Real sessions and a real
ledger move together; real drafts over mock deals do not work at all, because
the model would be asked about a dispute that exists in this browser and in no
database. Switching it on is a claim that the backend holds your tenant's data,
and the dashboard cannot check that for you — so the default stays off and the
demo build stays honest.

Which half you are looking at is worth being able to tell at a glance: a real
draft cites `audit_log` uuids and takes a second to arrive; the mock's is
instant and cites `aud_00xx`.

`SimulationApi` (the `sim` property) exists only on the mock. Guard any use of
it with `isSimulated(api)` so it compiles away against the real client.

## Engine tests are the backend's spec

`src/api/mock/engine.test.ts` encodes the invariants: release needs both
confirmations, no double release, refund blocked after release, timer fires only
on non-disputed deals, payouts blocked while frozen, deposits capped at the
pre-auth, balances derived purely from ledger entries. **Reproduce every one of
these against the real Edge Functions.** If a rule changes, change it here first.

Three more suites sit beside it, and they are the spec for the parts of the
backend written most recently:

- `webhooks.test.ts` — every state change queues a notification, a repeated
  confirmation does not queue two, retries back off and then stop, and a client
  holding the secret can verify the signature. The backend's counterpart is
  `payhold-backend/tests/webhooks-risk-reconciliation.test.ts`.

  **Event names are spec §10.2's and were renamed in Phase 1** —
  `order.funded_held`, `order.delivered` / `order.accepted`,
  `order.clearing_started`, `order.released`, `refund.succeeded`,
  `dispute.opened`, `payout.paid`. One event per transition: there is no
  per-event subscription, so shipping the old name alongside the new would
  double every client's delivery volume rather than ease a migration.
- The clearance suite in `engine.test.ts` — `clearing` is where the second
  confirmation lands and where the release entry is written; `released` is the
  far side of the window; a dispute opened during clearing freezes both the
  promotion and the payout. Backend counterpart:
  `payhold-backend/tests/lifecycle.test.ts`.
- `risk.test.ts` — a rule can hold a payout and do nothing else; only a person
  clears the hold; cron and retry cannot.
- `reconciliation.test.ts` — drift is *found* by comparing against a provider
  balance, not handed to the dashboard. One alert per rail, refreshed. Drift
  freezes; nothing unfreezes itself.

  **`providerReportedBalance` is now derived independently**, from entries that
  genuinely crossed the provider boundary (`hold`, `provider_fee`, `refund`,
  `payout`). It used to be our own expected figure plus injected drift, which
  made the comparison self-fulfilling — and is why the mock could not have
  noticed that the platform fee made every released deal drift. `release`,
  `fee`, `tax`, `reserve` and `reserve_release` appear nowhere in it, which is
  exactly the property the six-bucket maths has to satisfy for the two to agree.

## Intelligence (root spec §12)

`src/api/mock/ai.ts` is to the assistant what `FakeProvider` is to the rails: a
deterministic stand-in so demo mode with zero keys works end to end. Same
inputs, same draft, no network.

**The real one now exists** — `payhold-backend/functions/ai-dispute`,
`ai-risk-narrator`, `ai-support`, `ai-decisions` — and it assembles the same
inputs and returns the same shapes, which is why no screen changed when it
landed. `types.ts` is what holds the two together: the backend's validators
mirror `DisputeSuggestionOutput` and `RiskSummaryOutput` field for field, and a
field added on one side only is a screen that renders nothing.

The one rule everything is arranged around is invariant 9 — **it advises, a
person decides**:

- Drafting and chatting write to `ai_suggestions`, `ai_chat` and `audit_log`.
  They touch no deal, no ledger entry and no payout, and `ai.test.ts` asserts
  that by diffing a snapshot of all money state across every AI call.
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
row as the one on the Disputes screen.

Commands (`/help` lists them) read the whole account: `/queue`, `/deal`,
`/evidence`, `/draft`, `/risk`, `/disputes`, `/deals`, `/payouts`, `/balance`,
`/audit`. **`/approve <id>` and `/reject <id>` execute**, and that is not a hole
in invariant 9: an exact command naming one record is the operator deciding in
their own session, parsed literally with no inference, recorded against them.
Anything the model would have to *interpret* — "approve that for me" — is
refused and answered with the card and its buttons instead. `ai.test.ts` holds
both halves of that line.

The Intelligence page is a **queue, not a dashboard**: one column, and nothing gets a card
unless you act on it. Two columns produced an L-shaped hole whenever the queue
was empty, which is most of the time. A suggestion never nests a tinted box
inside another box — `variant="standalone"` is the card on the Intelligence
page, `variant="inline"` is the inset panel inside a dispute or a payout row.
Provenance (prompt version, input hash) collapses behind a Details toggle: it
is what makes a decision reproducible and it is noise while you are making one.

Two things the fixtures encode deliberately:

- Seeded drafts are produced by running `composeDisputeDraft` over the
  fixtures, never by hand-copying its wording — a fixture that drifts from the
  code it illustrates is worse than no fixture.
- The three seeded disputes produce all three recommendations. The bumper case
  turns on the buyer having confirmed *before* the seller opened the dispute —
  if you touch the seeded timestamps, check `ai.test.ts` still passes, because
  reordering those two events reverses the answer.
- **Rwanda Equipment Co has `ai_enabled: false`.** Switch tenant in the dev
  panel to see the degraded state: no drafts, no chat, and every money path
  behaving identically. That is the §12.5 claim, made checkable.

Dispute evidence carries a **URL, not a file**. The client's site serves the
images; we store the reference, so a case can be reviewed with the photos in
front of you while the files stay theirs. `evidence-photos.ts` draws the
fixtures as inline SVG data URIs — no assets to ship, no network, and
schematic on purpose, since a convincing fake photograph invites someone to
treat a fixture as a record of something that happened. Note the split: people
see the images, **the assistant is given the descriptions**, which is what
spec §12.2 says it reads.

`deal_outcomes` is written from the money path in `engine.ts`, not from the AI
code, so the labels come from every resolution including the ones no model saw
— a training set of only AI-assisted cases would be biased from the first row.
The backend does the same thing by triggers on `deals` and `disputes` rather
than by lines inside the money functions, for the reason `enqueue_webhooks` is
a trigger: a label every future code path must remember is one that gets
forgotten.

`risk_signals` (spec §12.3) is **not** mocked: the narrator recomputes signals
per request and they are captured in the suggestion's `output` and
`input_hash`. The backend persists them at screening time instead —
`screen_payout` writes them whether or not the rules are switched on — and
hands the stored rows to the narrator as findings to explain rather than to
re-derive.

Two differences to expect when the live flag is on. `input_hash` is a full
sha-256 there against this file's FNV-1a, because a hash that has to survive an
audit is not the place for a short one. And a real dispute draft is thinner than
the mock's: the backend's `disputes` table has a reason and no evidence rows
yet, so the model weighs the opening statement, the timeline and the seller's
record. That gap is listed in the backend's *Not built yet*.

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

`request-context.test.ts` asserts the mock exposes no method that *writes* an
origin. In the real system the only writers are the `/pay` handler and the
provider webhook; a mock that let a screen invent an address would be teaching a
capability the backend deliberately withheld.

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

## The seller page

`src/screens/SellerDetail.tsx` is one counterparty and everything this account
knows about them: destination and route, every deal, every payout, every signal
their name is on, and where their buyers paid from. It is a record and not a
verdict — nothing on it scores anybody, and it carries no action, because
clearing a hold belongs on Payouts where the approval is recorded.

The column worth keeping is **age at creation**, shown per deal rather than as
one "registered" date. That is the figure the new-seller rule fires on, and
`risk.ts` measures it at the deal's creation for a reason the page repeats: with
a seven-day clearance window every seller is a week old by the time their first
payout comes due, so measuring at payout time would make the rule unfireable.

## Seeded risk fixtures

The seed screens its due payouts through the real rules on the way out
(`screenSeededPayouts`), rather than shipping a hand-written hold. A fixture
hold would be wrong in two directions at once: a demo showing a rule the code
would not have fired, and wording that drifts from `risk.ts` the first time
somebody edits an explanation. `seed-risk.test.ts` pins both halves — the hold
is a real one, and re-deriving the findings reproduces the stored explanations.

`sel_0007` exists for this: registered a day before taking a booking, now due a
first payout, which is the new-seller rule's whole subject. Nothing is wrong
with them, and that is the point — the rule makes them wait for a person and may
do nothing else. Two departures from the dispatcher's `screenPayout`: the seed
queues no webhook delivery (`webhook_deliveries` starts empty by design), and it
stamps the hold at the payout's due date rather than at seed time.

## Outbound webhooks and risk rules

`src/lib/hmac.ts` is a real synchronous HMAC-SHA256, not a stand-in. A mock
that emitted a decorative signature would make invariant 7 untestable — a
client could not check it and neither could we — so the mock signs for real and
`webhooks.test.ts` verifies a delivery the way a client's server would. It is
synchronous because the engine is: an `await` inside `releaseDeal` would be a
lie about the backend's shape, where that step is one transaction.

The header format (`t=<unix seconds>,v1=<hex>` over `<t>.<body>`) is pinned
from both sides — here and in the backend's `crypto.test.ts` — because a client
who develops against the mock must not break when they point at the real API.

**Signing secrets live on the mock's `webhook_endpoints` rows** and never cross
the client interface; `listWebhookEndpoints` strips them, as the real API will.
This is the one place the mock deliberately holds a secret, for the same reason
`FakeProvider` does: it is standing in for the backend, not for a browser.

`src/api/mock/risk.ts` holds the deterministic rules. They can set a payout to
`held_for_review` and nothing else — `risk.test.ts` asserts that by checking no
ledger entry appears. `frozen` and `held_for_review` are separate statuses on
purpose: the first is the whole account stopped by reconciliation, the second is
one payout waiting on one person.

**A person can place that second kind too** — `holdPayout`, the Hold button on
the Payouts screen. It is the narrow alternative to freezing an account, which
was previously the only way to stop one seller and stops every other seller with
them. It takes a reason, because the next person to look at the row has nothing
else to go on, and `review_held_by` is what distinguishes it from a rule's hold
wherever a hold is read: a name means somebody you can go and ask, null means
the arithmetic in `risk.ts`. It refuses `paid` and `processing` — money already
with the provider is recalled by a phone call, not a button. The backend's
counterpart is `hold_payout` in `20260806000006_manual_hold.sql`, and
`tests/manual-hold.test.ts` mirrors this suite case for case.

Seller age is measured **at the deal's creation**, not at payout time. With a
seven-day clearance window, every seller is a week old by the time their first
payout comes due, so measuring at payout would make that rule unfireable.

## Payout routing (spec §5.1)

`src/api/mock/routing.ts` is the mirror of
`payhold-backend/supabase/migrations/20260807000009_payout_routing.sql` —
`routeEvaluation`, `routePayout`, `routeReasonText`, `payoutDisplayStatus`, same
order and same reason codes. A change to either is a change to both.

**Which rail carries a payout is data.** `db.payout_routes` is §5's launch
matrix as rows, and `platformPayoutRoutes()` is the seed. A `tenant_id` of null
is the platform default; a tenant row for the same rail **replaces** it, or
switching a rail off for one company would leave the platform's enabled row
still eligible. The dev panel and §5.2's eighth case both turn on that: disable
a corridor and the next payout blocks, with no code changed.

**A route is never a fallback for another route.** §5.1 forbids silently
redirecting funds to another destination, and a destination is a token minted
for one rail — so the fallback is the seller's **backup destination**, gated on
a failed primary, `payout_primary_attempts`, `payout_backup_enabled`, and the
backup being verified and out of its security hold. Taking it emits
`payout.route_changed` once.

**Destinations are their own table.** `seller_destinations` is the record;
`Seller.beneficiary_token` and `masked_destination` are the primary's copy,
which the backend keeps in step with a trigger. `seedPrimaryDestination` is that
trigger's mirror and every path that creates a seller must call it — a seller
without a destination is unpayable for a reason nobody chose.

**Two new payout statuses, separated by who ends them.** `held_for_review` needs
a named approval; `needs_verification` (§12) needs an attestation and is
deliberately *not* approvable, which is what closes the hole where an operator
could wave a payout past a seller nobody had verified; `blocked` (§5.1's
no-route case, and a disputed deal) ends when a route exists or the dispute
resolves. Both new ones are in the cron's `DISPATCHABLE`, because neither waits
on a decision and re-asking overrules nobody.

`payoutDisplayStatus` derives §5.1's seven-state seller-facing vocabulary.
`clearing` and `available` come from the *deal's* window, not from the payout —
storing them would be one fact with two writers. `frozen` and `held_for_review`
both read as `blocked`, because to a seller they are the same thing and naming
a review queue at them invites them to fix what is not theirs to fix.

`routing.test.ts` mirrors `payhold-backend/tests/payout-routing.test.ts` case
for case, §5.2's eight included.

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
spec, not a checked capability list. Before any rail carries live money, confirm
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
  does **not** change the deal's status (§29.8); `computeDealAmounts(...).refunded`
  is where "partly refunded" is read from.
- **Money is integer minor units everywhere.** Only `lib/format.ts` divides by
  100. Forms take major units and convert at the boundary.
- **Balances have six buckets** (spec §7): `held`, `pending_clearance`,
  `available`, `reserved`, `fees_retained`, `paid_out`. Only the last is money
  that left. `computeDealAmounts` is the per-deal breakdown, and
  `POOL_DEDUCTIONS` in `engine.ts` must stay identical to the backend's
  `POOL_ENTRY_TYPES` and to `rail_balances`' `clearing` expression.
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
  `payoutDisplayStatus` derives §5.1's seven seller-facing states. Public pages
  get the second, the Payouts screen gets the first.
- Status vocabulary lives in `DEAL_STATUS_META` / `PAYOUT_STATUS_META`. Labels
  and plain-language hints are defined once, never inline. `DEAL_STATUSES` is in
  **the Postgres enum's declaration order**, so `order by status` reads as the
  lifecycle; keep the two in step.
- `HOLDING_STATUSES` is money still in the hold; `PAST_HOLD_STATUSES` is
  `clearing | released | payout_pending | paid_out`. Reach for the second
  wherever V1 code said `['released', 'paid_out']` — that question now has four
  answers, and `clearing` is the one people forget.
- Money mutations use `useMoneyMutation` / `useMoneyAction`, which invalidate
  every query — a release touches the deal, ledger, balance, payouts and audit
  at once.
- Public pages (`src/screens/public/`) are seen by buyers and sellers. Plain
  language, no jargon, no status codes.
