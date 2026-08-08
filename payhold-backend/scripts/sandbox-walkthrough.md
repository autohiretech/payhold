# The sandbox walkthrough — spec §28

The testing gate before any live traffic. Every suite in this repository runs
against PGlite, an intercepted `fetch` or `FakeProvider`; **none of that is the
deployed project**, and RLS in particular is only proven here. This is the run
that answers for the real one.

It is not automated and should not be: half of it is watching what happens on a
provider's dashboard, and a script that could green-light itself would be the
thing §16 exists to prevent. What it is instead is ordered, and each part signs
off a `launch_checklist` item by name:

| Part | Signs off |
|---|---|
| 1. The money path | `walkthrough_money_path` |
| 2. A forged webhook | `walkthrough_forged_webhook` |
| 3. The way in | `walkthrough_tenancy` |
| 4. The V2 paths | `walkthrough_v2_paths` |
| 5. The scheduled jobs | `cron_scheduled` |

Signing an item is `POST /launch/{code}/sign-off` with the evidence — a link to
the run, a screenshot, a transaction id. See "Recording the result" at the end.

**Everything below is in test mode**, and the system will not let it be
otherwise: `POST /provider-accounts` refuses `mode: "live"` while any required
item is outstanding, and on the day this document is first run every item is.

---

## 0. Before you start

```sh
export PH=https://mwnbjjlilqrwdmwutbxr.supabase.co/functions/v1
export ANON=…                # the project's anon key, for the Authorization header
```

Every call below carries `Authorization: Bearer $ANON` (Supabase's gateway) plus
either `X-Api-Key` (a client's server) or a user's session JWT (the dashboard).
Those are different credentials and the distinction is half of what this
walkthrough is testing.

Confirm the deployment first:

```sh
curl -s "$PH/payment-options?country=RW" -H "Authorization: Bearer $ANON" -H "X-Api-Key: $KEY"
```

`rails_verified` must be **false**. It is derived from §16's per-market
confirmation items, so it stays false until somebody signs the market off — if
it is true here, either the confirmations are genuinely in hand or somebody has
signed something they should not have.

---

## 1. The money path

Spec §28's first sentence: pay → held → confirm ×2 → release → clearance →
payout, plus the refund path and the timer path.

### 1.1 A company, and a key

```sh
curl -sX POST "$PH/account/signup" -H "Authorization: Bearer $ANON" \
  -d '{"company":"Walkthrough Co","email":"you@example.com","password":"…12+ chars…"}'
```

Sign in through Supabase Auth directly — the dashboard does, and so should this.
Then create an API key from the dashboard; the plaintext is shown once.

### 1.2 Connect the rails, in test mode

`POST /provider-accounts` with `mode: "test"` for Flutterwave and Stripe. Two
things must happen and both are the point:

- A **live** secret key submitted as `mode: "test"` is refused, and vice versa.
- `mode: "live"` is refused outright, naming the outstanding checklist items.
  Try it once. That refusal is §16 working.

Skipping this step is also a valid run: with no connected account the tenant
falls back to `FakeProvider`, which fakes the counterparty and nothing else.
Do the walkthrough on the fake **and** on Flutterwave test keys — they are
different code paths from `charge` onwards.

### 1.3 A seller, verified by a person

```sh
curl -sX POST "$PH/sellers" -H "X-Api-Key: $KEY" -d '{
  "name":"Kigali Rentals","country":"RW","payout_provider":"flutterwave_momo",
  "destination":"+2507…"
}'
```

Then `GET /sellers/{id}/capabilities`. It must list reasons — a seller nobody
has verified cannot be paid, and this is where they find that out rather than
three weeks later as a held payout. Note that `reasons` and `route_reasons` are
separate lists and only the first holds a payout.

```sh
curl -sX POST "$PH/sellers/$SELLER/verify" -H "Authorization: Bearer $JWT" \
  -d '{"verified":true,"notes":"ID + sanctions screen, ticket KYC-1"}'
```

**This must refuse an `X-Api-Key`.** A client that can verify its own sellers has
turned KYC into a field it sets. Try it with the key first and watch it fail.

### 1.4 A deal, and a hosted checkout session

`POST /deals`, then `POST /checkout/sessions` for the deal. Open the public link
(`GET /checkout/public/{token}` — no credential, the token *is* the credential)
and pay:

- a **test card** through Stripe's hosted Checkout, and
- **test mobile money** through Flutterwave (MTN and Airtel are separate runs;
  the wallet list comes from `/payment-options`, not from anything hardcoded).

Completing the session moves the deal to `payment_pending` and **stops**. If a
deal reaches `funded_held` from anything other than the provider's webhook,
stop the walkthrough — that is §15 phase 2's acceptance criterion and the whole
risk of hosted checkout.

Watch the deal reach `funded_held` only after the webhook lands. `GET /deals/{id}`
carries the §7 breakdown; check it sums to what the buyer paid.

### 1.5 Confirm twice

`POST /deals/{id}/confirm` with `side=buyer`, then `side=seller` (or the other
order). After the **second** one, and not before:

- the deal is `clearing`, not `released` — `clearing` is inside the window;
- a `payout` row exists, scheduled `clearance_days` out (14 by default);
- the ledger carries the release, the fee and the deposit return, all under one
  lock;
- `order.clearing_started` is queued to every registered endpoint.

Call `/confirm` again for the same side. It must be a no-op.

### 1.6 Clearance and payout

Wait for the window or move `payout_due_at` back by hand in the SQL editor. Then
let `payout-dispatch` run (or invoke it with the `x-cron-secret` header).

- `mature_clearing_deals()` promotes `clearing → released` first;
- `screen_payout` runs before anything is sent;
- `route_payout` writes a `payout_decisions` row — read it, it should name the
  rail, the checks, the score and a reason code;
- the transfer goes, then the booking. Confirm the money on the provider's own
  dashboard, not only in our tables.

Then `GET /balance?by=rail`: `paid_out` has moved and nothing else disagrees.

### 1.7 The refund path and the timer path

- A full refund on a held deal, through the original provider.
- A deal left alone until `auto_release_at` fires. `auto-release` writes the
  missing confirmations with `actor = 'auto'` and lets `confirm_deal` release,
  so the audit trail still tells a buyer who agreed from one who went quiet.

---

## 2. A forged webhook must return 401

On **every** rail, including `FakeProvider`:

```sh
curl -isX POST "$PH/flutterwave-webhook/$TENANT" \
  -H "Authorization: Bearer $ANON" -H "verif-hash: obviously-wrong" \
  -d '{"event":"charge.completed","data":{"status":"successful","amount":1000}}'
```

`401`, and nothing about the deal moves. Repeat against `stripe-webhook` with a
malformed `Stripe-Signature`, and again with a **valid signature but a wrong
amount** — that one must reach `disputed`, never `funded_held`.

Then replay a genuine webhook twice. The second is a no-op; the ledger has one
entry.

---

## 3. The way in

RLS is only proven here. PGlite shims `auth.uid()`, so nothing in the local
suites is evidence for any of this.

1. Sign up. Land in an empty company — no deals, no payouts, no sellers.
2. Sign out. Sign back in.
3. A dashboard call with **no bearer token** returns 401.
4. A call carrying company A's session, asking for company B's deal id, returns
   **that company's nothing** — a 404, not a 403. A 403 would confirm the row
   exists.
5. `GET /account/me` returns the tenant and role the session actually has.

Do 4 with a real second company and a real deal id copied from it. A test that
asks for a made-up uuid proves nothing.

---

## 4. The V2 paths

Spec §28's additions, and the reason this document exists rather than the V1
paragraph it replaces.

### 4.1 A partial refund at each of §7.1's four positions

| Position | What to expect |
|---|---|
| before capture | refused — nothing arrived |
| before release | one `refund` entry; the deal carries on and is still delivered and paid out for the rest |
| after release, before payout | a **positive `release`** puts it back in the hold, then the refund takes it out. `held` never goes negative |
| after payout | a `receivable` books what the seller owes; the refund stays `pending` for a person |

Then: two refunds summing past what the buyer paid must be refused, and the
deal's status must **not** become `partially_refunded` — §29.8. Check
`deal_amounts.refunded` instead.

### 4.2 A routing failure that falls back to a verified backup

Register a backup destination, verify it, and let its security hold expire.
Force the primary to fail `payout_primary_attempts` times. Only then may the
backup be used, and using it emits `payout.route_changed` exactly once.

Confirm the negative too: a payout with **one** failure does not move, and a
tenant with `payout_backup_enabled = false` never does.

### 4.3 A payout to an unverified seller is refused

Revoke a seller's verification after a payout has already been approved once.
The payout must go to `needs_verification`, and `approve_payout_review` must
**refuse** it — the way out is another attestation, not the approve button.

### 4.4 A country closed in data disappears, with no redeploy

```sql
insert into payment_markets (tenant_id, country, collect, payout, reason)
values (null, 'RW', false, false, 'Walkthrough: closed for the test');
```

`GET /payment-options?country=RW` now answers `closed: true` with that reason,
and `route_evaluation` returns `market_closed` ahead of every rail reason.
Delete the row; both come back. No deploy happened in between.

---

## 5. The scheduled jobs

`scripts/schedule-cron.sql`, applied by hand, once, per environment. Written is
not running.

```sql
select jobname, schedule from cron.job order by jobname;
select status, created from cron.job_run_details order by start_time desc limit 20;
```

`cron.job_run_details` saying "succeeded" means the request was **queued**.
The status codes are in `net._http_response` — check there for 200s, and for
401s, which mean `payhold.cron_secret` and the `CRON_SECRET` function secret
disagree.

---

## Recording the result

```sh
curl -sX POST "$PH/launch/walkthrough_money_path/sign-off" \
  -H "Authorization: Bearer $ADMIN_JWT" \
  -d '{"evidence":"run 2026-08-08, deals 9f3…/a21…, provider refs FLW-… and pi_…"}'
```

PayHold staff only — `platform_admins`, not a tenant owner, and never an API
key. The sign-off is appended, never edited: withdrawing one is
`{"signed": false}` with a reason, which leaves both rows in place.

`GET /launch` shows what is left. When `live_mode_allowed` is true, and not
before, `POST /provider-accounts` will accept `mode: "live"`.
