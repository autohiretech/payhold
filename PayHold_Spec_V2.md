# PayHold Marketplace Payments Platform — Specification V2

**Status:** source of truth. Supersedes `PayHold_Standalone_Spec_V1.docx`
(deleted 2026-08-07; recoverable from git at `f15f5e7`).

**Target launch markets:** Rwanda, United Arab Emirates, Mainland China,
United States.
**Primary client application:** AutoHireTech — tenant #1, a client like any
other, with no special access.
**Platform role:** reusable payment service for multiple marketplace
applications.

> **Financial and legal notice.** This is an engineering and product
> specification, not legal, regulatory, tax, or licensing advice. Before
> accepting customer money or holding funds for sellers, obtain written advice
> from qualified payments counsel in each launch market and confirm the
> licensing, safeguarding, AML/KYC, tax, consumer-protection, data-residency
> and money-transmission requirements that apply to the chosen providers and
> legal entities.

**How this document was assembled.** Sections 1–17 are the Manus AI engineer
handoff specification. Sections 18–28 are carried forward from the V1 build
specification: they describe subsystems that are already built and running and
for which the handoff document has no equivalent. Section 29 records every
point on which the two disagree and which one wins.

The source document's subtitle names the regulated term this product must never
claim. It is not reproduced here — see §18.

---

# Part I — The handoff specification

## 1. Executive decision

AutoHireTech does not implement payment logic itself. It is a client of a
standalone PayHold Payments API. PayHold owns checkout orchestration, provider
routing, payment verification, ledgering, held-order states, clearing windows,
seller onboarding, payouts, refunds, disputes, reconciliation, risk controls and
audit records. Other applications integrate through the same API, webhooks and
optional hosted checkout.

The system is **Fiverr-like in workflow**, but must not be described as a legal
custody arrangement or as a bank account unless the operating entity and custody
model have been approved by regulators and counsel. The implementation is
provider-managed marketplace payments and balances, with PayHold maintaining an
internal double-entry ledger and release policy. **PayHold must not pool funds
in an ordinary company operating account** and must not promise universal
worldwide payouts.

Fiverr's published payment options include major cards, Fiverr Balance, Apple
Pay, Google Pay, PayPal, PayPal Pay Later for selected users, Venmo for U.S.
clients, iDeal/Wero in the Netherlands, and wire transfers for Fiverr Pro.
Fiverr states that availability varies by country, device, payment provider and
regulation, and that it does not accept cryptocurrency [1]. Its order process
charges the buyer after confirmation; its seller guidance says earnings become
available after a 14-day clearance period, shorter for certain eligible seller
categories [2][3].

## 2. Implementation status

The V1 document described a browser-storage prototype and warned against
mistaking it for a production payment system. That warning still stands, but the
facts have moved. What exists as of 2026-08-07:

**Built and tested.** The Postgres money engine (`release_deal`, `confirm_deal`,
`refund_deal`, `settle_payout`, `capture_deposit`, `screen_payout`,
`decide_ai_suggestion` and the rest) across nine migrations. Nineteen Edge
Functions covering the V1 API surface, dashboard auth, the AI layer, and four
cron jobs. `FlutterwaveProvider` and `FakeProvider`. RLS. The signed outbound
webhook path with retry. Per-rail reconciliation with automatic payout freeze.
The deterministic risk rules and the manual payout hold. Fifteen dashboard
screens, which ran against an in-browser mock of the full v1 contract until the
Edge Functions caught up and are now clients of the real API — the mock is
deleted, and `src/api/http.ts` is the only implementation of `PayHoldClient`.

**Not built.** Everything this document adds beyond V1 — see §15 for the phase
list. Plus, carried over from V1's own backlog: `StripeProvider` and Stripe's
inbound webhook, the reminders cron, end-user confirmation tokens, invitations,
password reset, and dispute evidence storage.

**Never exercised against real money.** Every test to date runs against
`FakeProvider` or PGlite. No live provider call has been made. `RAILS_VERIFIED`
is `false` and stays false until each routing row is checked against provider
documentation and a signed agreement.

The engineer must not read "the screen renders" as "the route works." §17 says
this about checkout buttons; it applies to the whole system.

## 3. Product boundaries

### 3.1 PayHold owns

| Capability | Required behavior |
|---|---|
| Application tenancy | Multiple applications use isolated tenants, API keys, webhook endpoints, fee rules, currencies, branding. |
| Checkout | Hosted checkout and embeddable checkout session API. The client application never handles raw card data. |
| Payment orchestration | Select a provider and method based on buyer country, seller country, currency, risk, provider availability, transaction type. |
| Order ledger | Immutable double-entry records for authorization, capture, fees, held funds, refunds, reserves, releases, payouts. |
| Release policy | A configurable safety-clearing period after completion or buyer acceptance. |
| Payouts | Onboard sellers, collect payout destinations, schedule payouts, retry failures, expose payout status. |
| Disputes | Buyer/seller negotiation, evidence, support intervention, partial refunds, full refunds, final decisions. |
| Risk | Device and identity signals, velocity limits, sanctions screening, chargeback controls, payout holds, manual review. |
| Reconciliation | Compare provider reports, webhook events, internal ledger, and bank/payout records. |
| Audit | Append-only event history covering every money-affecting action and administrator decision. |

### 3.2 AutoHireTech owns

Vehicle listings, availability, bookings, trip dates, rental agreements,
host/driver experience, rental-specific cancellation rules, and the UI that
displays PayHold checkout or payment status. It creates a PayHold deal and
listens to PayHold webhooks.

It must **not** store payment credentials, decide that a provider payment
succeeded, mark a ledger entry as paid, or directly release seller funds.

## 4. Required payment methods and realistic routing

The requested methods are Visa, Mastercard, Stripe, WeChat Pay, Alipay, PayPal,
Venmo and Cash App. **Stripe is a processor, not a buyer-facing method** — it is
represented as a provider with its supported methods beneath it. Cash App is
implemented only through the official Cash App Pay business integration, never
by asking a user to send money to a personal account. Venmo is U.S.-specific and
must not be advertised globally.

| Requested method | Recommended provider path | Initial market expectation | Important limitation |
|---|---|---|---|
| Visa / Mastercard | Stripe and/or an approved regional acquirer | U.S., UAE, China-facing international checkout; Rwanda subject to provider account availability | Acceptance, settlement currencies, 3DS, disputes and seller payout countries all depend on the merchant account. |
| Stripe | Stripe Payments plus Connect where eligible | U.S. and UAE are listed Stripe business locations; China requires the correct entity/product setup | Not a universal payout solution. Confirm Rwanda seller onboarding and cross-border payout eligibility before launch. |
| Alipay | Stripe Alipay where platform and connected-account setup are approved, or a licensed China acquiring partner | China-facing and overseas Chinese buyers | Stripe documents Connect support as requiring approval, no dispute support, and refunds/partial refunds supported; the account location and currency matrix must be checked per entity [4]. |
| WeChat Pay | Stripe WeChat Pay where eligible, or an approved China payment partner | China-facing and overseas Chinese buyers | Stripe documents partial Connect support, no dispute support, standard payout timing. Not available as a blanket method for every Stripe account [5]. |
| PayPal | PayPal Checkout and approved marketplace/payout products | Strongest for U.S. and international buyers; country availability varies | PayPal must approve the business model and seller payout flow. A normal merchant account is never enough for marketplace holds. |
| Venmo | PayPal/Venmo business checkout where eligible | United States only | Tied to U.S. user and merchant eligibility. |
| Cash App | Cash App Pay or another officially approved business integration | United States only | No peer-to-peer transfers, no personal accounts. Confirm marketplace and refund support before committing. |
| Rwanda mobile money | Flutterwave or another licensed regional provider; MTN MoMo and Airtel Money where supported | Rwanda | Confirm collection and payout support, currency settlement, merchant licensing, webhook behavior, chargeback/refund behavior. |
| UAE local methods | Cards, bank transfer, approved local wallet/acquirer methods | UAE | Confirm UAE entity, acquiring license, local settlement, AML and payout requirements. |

Stripe describes Connect as a platform for marketplaces that collect customer
payments and pay out sellers [6]. Its global availability page lists the UAE,
Mainland China, Hong Kong, Singapore, Japan, the United States and others — but
**a listed business location is not a guarantee that every method or payout
feature is available for every seller country** [7].

## 5. Launch-market policy

The launch configuration is a **country-and-currency matrix, not a hard-coded
list**. A payment method appears only when the provider has confirmed that the
buyer country, seller country, presentment currency, transaction type, business
category and account configuration are all eligible.

| Market | Primary buyer methods | Seller payout direction | Launch currencies | Release policy |
|---|---|---|---|---|
| Rwanda | Visa, Mastercard, MTN MoMo, Airtel Money, bank transfer where supported | RWF mobile-money wallet or Rwandan bank account, subject to provider and KYC approval | RWF; USD/EUR only where the provider supports the route | 14 days after acceptance or automatic completion; longer on risk/dispute |
| UAE | Visa, Mastercard, Apple Pay/Google Pay where enabled, PayPal where approved, bank transfer | UAE bank account or approved provider destination | AED, USD | 7–14 days after acceptance; longer for new sellers |
| Mainland China | Alipay, WeChat Pay, UnionPay/cards through an approved China-capable provider, international cards where eligible | Requires an approved local structure and payout partner. **Do not promise cross-border payout until approved.** | CNY, plus others only when provider and entity support them | 14 days after acceptance; additional review for cross-border and high-value |
| United States | Visa, Mastercard, Amex, PayPal, Venmo, Cash App Pay, Apple Pay/Google Pay, ACH where approved | U.S. bank account or approved PayPal/Stripe-connected destination | USD | 14 days after acceptance, with reserve and chargeback monitoring |

The first launch must not claim that "anyone in the world can receive money."
The correct product promise is: **eligible sellers in supported countries can
receive payouts through supported providers after identity verification, risk
review, and a published clearing period.** Countries are added only through a
formal country-launch checklist.

### 5.1 Payout Preferences and Automatic Routing Center

One seller-facing centre. The seller selects a preferred payout destination,
verifies ownership, and may add a backup. PayHold then chooses only an eligible
route; **it must never silently redirect funds to another destination.**

| Component | Required behavior |
|---|---|
| Preferred payout method | Seller chooses bank account, mobile wallet, PayPal, Venmo, Cash App Pay or another method enabled for that seller's country and currency. |
| Backup method | A secondary verified destination, used only after a failed primary payout and an explicit routing-policy check. |
| Verification | Identity, country, tax information where required, account ownership, sanctions status, and provider onboarding before payouts are enabled. |
| Eligibility engine | Evaluates seller country, buyer country, currency, provider capability, transaction type, business category, limits, risk score, current provider status. |
| Routing priority | The seller's preferred eligible method first; otherwise the highest-ranked eligible fallback, with the reason shown. |
| No-route behavior | Keep the amount in `available` or `payout_blocked`, notify the seller, request an eligible destination. **Never discard or reroute funds invisibly.** |
| Currency handling | Pay in the original currency where possible. If conversion is necessary, show rate, markup, source and final amount before confirmation. |
| Status visibility | Display `clearing`, `available`, `processing`, `paid`, `failed`, `blocked` or `needs_verification`, with the reason and the next action. |
| Change protection | A newly added destination enters a short security hold and may require re-authentication or step-up verification before use. |

The routing engine uses a capability matrix, not hard-coded UI buttons. A
payout decision is **deterministic and auditable**: store the selected provider,
selected method, eligibility checks, ranking score, currency, fees,
exchange-rate source and reason code.

```ts
function choosePayoutRoute(input: PayoutContext): EligibleRoute | NoRoute {
  const routes = getConfiguredRoutes(input.applicationId)
    .filter(route => route.enabled)
    .filter(route => route.countries.includes(input.sellerCountry))
    .filter(route => route.currencies.includes(input.currency))
    .filter(route => route.supportsPayouts)
    .filter(route => route.supportsSeller(input.sellerId))
    .filter(route => route.supportsAmount(input.amount))
    .filter(route => route.riskStatus === "approved")
    .sort(bySellerPreferenceThenReliabilityThenCost);

  return routes[0] ?? { status: "no_route", reason: "no_eligible_verified_destination" }
}
```

When the primary payout fails, retry per the provider's documented rules, then
place the payout in `payout_failed` or `payout_blocked`. The verified backup may
be offered, but the seller must be notified and the change logged. A destination
changed after funds become available triggers a security delay and a re-check of
fraud, KYC and account ownership.

The UX shows **one PayHold balance with separate states** — `held`, `clearing`,
`available`, `processing`, `paid`, `blocked` — not one balance per provider. The
detail view identifies the provider and destination used for each payout.

### 5.2 Payout routing acceptance tests

1. A verified Rwanda seller selects mobile money and receives an eligible RWF route.
2. A U.S. seller selects Venmo but is shown a clear ineligibility message outside the U.S.
3. A China seller selects Alipay or WeChat Pay and is routed only if the approved provider supports seller payouts for that entity.
4. A seller with no verified destination is blocked from payout.
5. A primary payout failure does not lose funds and offers the verified backup route.
6. A currency mismatch shows conversion details.
7. A new payout destination is held for security review.
8. A disabled provider is removed from checkout and payout selection **without a code redeploy**.

## 6. Order lifecycle

Every transition is server-authorized, idempotent, timestamped and audit-logged.

```
created
  -> checkout_started
  -> payment_pending
  -> funded_held
  -> in_progress
  -> delivered
  -> buyer_review
  -> confirmed_buyer
  -> clearing
  -> released
  -> payout_pending
  -> paid_out

Alternative paths:
  payment_pending -> payment_failed | expired | canceled
  funded_held     -> refunded | disputed
  delivered       -> revision_requested | disputed | confirmed_buyer
  clearing        -> disputed | partially_refunded | refunded
  payout_pending  -> payout_failed -> payout_retrying | payout_blocked
```

**This lifecycle does not replace the both-confirmations release rule.** See
§20 and §29.1: `delivered` is the seller's confirmation, `confirmed_buyer` is
the buyer's, and release still requires both under a row lock.

### 6.1 Default timing model

| Event | Default rule | Configurable? |
|---|---|---|
| Payment confirmation | Mark `funded_held` only after server-side provider verification and ledger posting | Yes, by provider and method |
| Seller begins work | Only after `funded_held` | Yes, by application |
| Delivery or rental completion | Client application sends the completion event; PayHold records evidence | Yes |
| Buyer acceptance | Buyer may accept immediately; acceptance starts clearing | Yes |
| Automatic completion | 3 days without an open dispute after delivery for digital/service orders; for vehicle rentals, use return/check-in or a booking-specific rule | Yes |
| Safety clearing | **14 calendar days** after completion/acceptance, matching Fiverr's published standard | Yes, with legal/risk approval |
| New seller reserve | 7–30 additional days, or a rolling reserve based on risk | Yes |
| Payout execution | After clearing, KYC, sanctions, negative-balance and dispute checks pass | Yes |
| Provider payout arrival | Show the provider estimate and status; never promise a fixed arrival time before provider confirmation | Yes |

The clearing period is an **internal release policy** and must not be presented
as a guarantee that a provider or regulator considers the funds legally held.
Buyer and seller are shown the reason for each hold: standard clearance,
dispute, chargeback exposure, KYC, sanctions screening, payout failure, reserve,
or manual review.

## 7. Fees, refunds and balances

Every order shows a complete price breakdown **before payment**: service/rental
amount, platform fee, provider processing estimate where applicable, taxes,
discounts, optional deposit, total charged.

The ledger keeps these as **separate values**: buyer-paid amount, seller gross
amount, platform fee, provider fee, tax, reserve, refund amount, payout amount.

Implemented 2026-08-07 as `deal_amounts(deal)` — derived from the ledger, never
stored, all in the presentment currency. The balance carries six buckets rather
than four, and the distinction that matters is **whether the money left**:

| | leaves the provider balance? | still expected to be there? |
|---|---|---|
| platform fee, tax | no — reclassified, nothing sweeps them out | yes (`fees_retained`) |
| reserve | no — carved out of the clearing pool | yes (`reserved`) |
| provider fee | **yes** — the rail took it | no |
| payout | **yes** | no |

Getting that wrong is not cosmetic. Before this phase the reconciliation pass
(§13) expected the provider to be holding the amount *minus* our own commission,
which the provider had never been asked to send anywhere — so every released
deal reported drift equal to the fee, and drift freezes a tenant's payouts
automatically.

Fiverr credits canceled-order funds to Fiverr Balance by default while eligible
buyers may request an original-source refund, which can take up to 10 days after
processing [1][3]. PayHold improves on this by offering both a platform balance
and an original-source refund workflow where the provider supports it.

### 7.1 Refund rules

1. **Before capture** — cancel the authorization where possible.
2. **After capture, before release** — refund the held balance through the original provider where supported.
3. **After release, before payout** — reverse the seller payable ledger entry and refund the buyer, subject to reserve and dispute policy.
4. **After payout** — create a receivable from the seller, draw on reserves where available, escalate to support if the seller balance is insufficient.
5. Support **full, partial and line-item refunds**. Every refund carries a reason, an actor, a provider reference and an immutable audit record.
6. **Never promise identical refund timing across methods.** Alipay and WeChat Pay refund asynchronously; Stripe's Alipay documentation describes refunds up to 90 days after payment with asynchronous status webhooks [4].

## 8. Disputes and buyer protection

A Resolution Center modeled on Fiverr's published workflow. Buyer and seller can
request an update, extension, cancellation, partial refund or full refund. The
other party is notified and has **48 hours** to accept or decline; unresolved
requests may be auto-resolved by platform rule. A new dispute cannot be opened
while another request for the same order is open [2].

PayHold adds: evidence upload, structured reason codes, timeline view, rental
inspection photos, GPS/check-in evidence where lawful, communication export,
support assignment, **conflict-of-interest controls for administrators**, and a
final decision record.

A dispute freezes release and payout for the affected amount. A partial dispute
freezes only the disputed amount when the ledger can safely separate it.

## 9. Provider adapter architecture

A provider-neutral interface, so applications never depend on Stripe,
Flutterwave, PayPal or a China partner directly.

```ts
interface PaymentProvider {
  createCheckout(input: CreateCheckoutInput): Promise<CheckoutSession>;
  verifyPayment(input: VerifyPaymentInput): Promise<VerifiedPayment>;
  refund(input: RefundInput): Promise<RefundResult>;
  createSellerAccount(input: SellerOnboardingInput): Promise<SellerAccount>;
  updateSellerAccount(input: SellerAccountUpdate): Promise<SellerAccount>;
  createPayout(input: PayoutInput): Promise<PayoutResult>;
  getPayout(input: GetPayoutInput): Promise<PayoutStatus>;
  verifyWebhook(input: VerifyWebhookInput): Promise<ProviderEvent>;
  reconcile(input: ReconciliationInput): Promise<ReconciliationReport>;
}
```

Adapters for the first release: `stripe`, `flutterwave`, `paypal`,
`cash_app_pay` where approved, and `china_wallet_partner` for any Alipay/WeChat
route not covered by the selected Stripe account. **Each adapter declares its
capabilities rather than letting the UI guess**: `supportsCapture`,
`supportsPartialRefund`, `supportsMarketplacePayout`, `supportsSellerOnboarding`,
`supportsDispute`, `supportsLocalCurrency`, `supportsMobileMoney`,
`supportsAsyncRefund`.

**No caller may branch on the provider's identity.** Route by capability. See
§29.3 for which of these adapters ship enabled.

## 10. Multi-application API contract

Every request carries an application tenant. Separate live and test keys.
Rotate keys. Never expose a secret key in browser code.

### 10.1 Core endpoints

The handoff document's endpoint names appear on the left. PayHold's implemented
route is on the right — the object is a **deal**, not an order (§29.2).

| Handoff endpoint | PayHold route | Purpose |
|---|---|---|
| `POST /v1/checkout/sessions` | *to build* | Create a deal-linked hosted checkout session |
| `GET /v1/checkout/sessions/{id}` | *to build* | Retrieve session status |
| `POST /v1/orders` | `POST /v1/deals` | Create with buyer, seller, application, amount, currency, completion policy |
| `GET /v1/orders/{id}` | `GET /v1/deals/:id` | State and ledger summary |
| `POST /v1/orders/{id}/deliver` | `POST /v1/deals/:id/confirm` (`side=seller`) | Record seller delivery or service completion |
| `POST /v1/orders/{id}/accept` | `POST /v1/deals/:id/confirm` (`side=buyer`) | Record buyer acceptance |
| `POST /v1/orders/{id}/cancel` | *to build* | Request or authorize cancellation per policy |
| `POST /v1/orders/{id}/disputes` | *to build* (SQL `open_dispute` exists) | Open a dispute |
| `POST /v1/disputes/{id}/offers` | *to build* | Partial refund, extension or settlement offer |
| `POST /v1/refunds` | `POST /v1/deals/:id/refund` | Full or partial refund |
| `POST /v1/sellers` | `POST /v1/sellers` | Create a seller profile, begin KYC/payout onboarding |
| `GET /v1/sellers/{id}/capabilities` | *to build* | Whether the seller can receive payouts |
| `POST /v1/payouts` | *cron-dispatched* | Request or schedule a payout after clearing |
| `GET /v1/payouts/{id}` | `GET /v1/payouts/:id` | Payout state and provider reference |
| `POST /v1/webhooks/{provider}` | `/flutterwave-webhook/:tenant` | Receive and verify provider events |
| `GET /v1/reconciliation/runs/{id}` | *to build* | Reconciliation results |

PayHold endpoints with no handoff equivalent, all built and retained:
`GET /v1/payment-options`, `GET /v1/balance`, `POST /v1/webhooks-endpoints`,
`GET /v1/webhook-deliveries`, `POST /v1/payouts/:id/approve-review`,
`POST /v1/payouts/:id/hold`, `GET /v1/risk-signals`, the deposit lifecycle
(§22), the AI endpoints (§24), and `/account/*` (§25).

### 10.2 Webhook contract

Signed events to each application's registered endpoint. HMAC over
`timestamp + '.' + raw_body`, reject stale timestamps, require HTTPS, retry with
exponential backoff. Include an event ID; the receiving application must
acknowledge idempotently.

Event names: `checkout.completed`, `payment.succeeded`, `payment.failed`,
`order.funded_held`, `order.delivered`, `order.accepted`,
`order.clearing_started`, `order.released`, `refund.created`,
`refund.succeeded`, `refund.failed`, `dispute.opened`, `payout.pending`,
`payout.paid`, `payout.failed`, `seller.verification_required`,
`seller.verification_completed`.

PayHold's implementation detail: outbound deliveries carry
`PayHold-Signature: t=<unix>,v1=<hmac-sha256>` over `<t>.<raw body>` plus a
`PayHold-Event` header. Clients must verify the digest **and** bound the age of
`t`, or a captured delivery can be replayed at them. Failed deliveries retry
five times with backoff (1m, 5m, 30m, 2h) and then stop and wait for a person.

## 11. Data and ledger model

A relational database with immutable money records. **Amounts are integer minor
units plus an ISO currency code; never floating point.** Every provider-linked
record stores the provider transaction ID, provider account ID, application
tenant ID, order ID, idempotency key and ledger entry ID.

| Table | Required fields |
|---|---|
| `applications` | ID, name, allowed origins, mode, fee policy, webhook policy, status |
| `api_keys` | ID, application ID, environment, hashed secret, scopes, created/revoked timestamps |
| `buyers` | ID, application ID, external user ID, country, risk status |
| `sellers` | ID, application ID, external user ID, country, KYC status, payout capabilities |
| `orders` | ID, application ID, buyer ID, seller ID, amount, currency, state, completion policy, timestamps |
| `payment_attempts` | ID, order ID, provider, method, provider reference, status, idempotency key |
| `ledger_accounts` | ID, owner type, owner ID, currency, account type |
| `ledger_entries` | ID, debit account, credit account, amount, currency, source event, immutable timestamp |
| `refunds` | ID, order ID, amount, reason, provider reference, status |
| `disputes` | ID, order ID, opened by, reason, evidence, status, decision |
| `payouts` | ID, seller ID, order ID or batch ID, amount, currency, provider reference, status |
| `webhook_events` | ID, provider, event ID, payload hash, verification status, processed timestamp |
| `reconciliation_runs` | ID, provider, period, matched, missing, mismatched, resolution status |
| `audit_events` | ID, actor, action, entity, old state, new state, request ID, timestamp |

PayHold's built equivalents: `applications` → `tenants`, `orders` → `deals`,
`webhook_events` → `provider_events`, `audit_events` → `audit_log`,
`reconciliation_runs` → `reconciliation_alerts` (to be joined by a runs table).
`buyers`, `payment_attempts`, `ledger_accounts` and `refunds` are not yet built.

**A tenant's balance is derived** — `sum(ledger entries)` — and is never a stored
column. Payouts may never exceed it, checked inside the same transaction.

## 12. Security, compliance and operational requirements

Hosted payment fields or hosted checkout, so raw card numbers never pass through
application servers. TLS, secure cookies, CSRF protection where applicable,
strict origin allowlists, rate limits, secret-manager storage, least-privilege
service accounts, database encryption, encrypted backups, and structured
security logs with sensitive data redacted.

Seller onboarding includes identity verification, beneficial-owner collection
where applicable, sanctions screening, country eligibility, payout-account
ownership checks, and a state of `pending`, `verified`, `restricted`, `rejected`
or `review_required`.

**A seller must not receive a payout solely because a payment webhook said
"success."** The payout worker re-checks KYC, sanctions, negative balance,
disputes, chargeback exposure, reserve and provider capability.

The legal entity and provider contracts must be approved for marketplace
activity in all four markets. China requires special care for domestic
acceptance, cross-border settlement, foreign-exchange controls, data handling
and local partners. Rwanda and the UAE require provider and regulatory
confirmation for money movement and seller payouts.

**Compliance configuration must be data-driven so a country can be disabled
without redeploying code.** This is a structural requirement, not a preference —
see §29.4.

## 13. Reconciliation and failure handling

The system must be correct when webhooks arrive late, twice, out of order, or
not at all. Webhook processing is an **inbox/outbox** design: store the raw
event, verify its signature, deduplicate by provider event ID, enqueue
processing, post the ledger transaction exactly once, and emit application
webhooks from the resulting internal state.

A daily reconciliation job compares provider balances and transaction exports
against the internal ledger. **Any mismatch produces a case rather than silently
altering balances.** Payout failures retry with capped exponential backoff, then
move to `payout_blocked` for operator action. A provider outage disables only
the affected routes and leaves other methods available.

## 14. AutoHireTech integration example

```json
{
  "application_id": "autohiretech",
  "external_order_id": "booking_12345",
  "buyer": {"external_id": "user_77", "country": "US"},
  "seller": {"external_id": "host_204", "country": "RW"},
  "amount": {"value": 31500, "currency": "USD"},
  "description": "Toyota RAV4 — 3 days, Kigali",
  "completion_policy": {
    "completion_event": "vehicle_returned",
    "auto_complete_after_hours": 72,
    "clearing_days": 14
  },
  "metadata": {"booking_id": "bk_9b41", "vehicle_id": "rav4_12"}
}
```

PayHold returns a hosted checkout URL and a deal ID. AutoHireTech redirects the
buyer, then waits for `order.funded_held`. At vehicle return it sends
`vehicle_returned`; PayHold starts the acceptance/clearing policy, freezes funds
if a dispute opens, and sends `order.released` only after the hold rules pass.
AutoHireTech updates its UI from webhooks and **never infers payment state from
a browser redirect**.

Note this example is a US buyer paying a Rwandan seller — collection on Stripe,
payout on Flutterwave. That corridor is why balances reconcile per rail (§26).

## 15. Engineering phases and acceptance criteria

| Phase | Deliverable | Acceptance test |
|---|---|---|
| 1. Core platform | Tenancy, API keys, order model, ledger, audit log | Two test applications can create isolated orders and balances. |
| 2. Hosted checkout | Stripe test mode, card wallets, provider capability filtering | Test payments cannot be marked successful without verified provider events. |
| 3. Regional adapters | Flutterwave/Rwanda route, PayPal, Venmo/Cash App where approved, China wallet partner | Each route passes provider sandbox tests and documents unsupported combinations. |
| 4. Clearing and disputes | Delivery, acceptance, automatic completion, 14-day clearing, 48-hour resolution window, partial refund | Funds cannot be released while a dispute or payout block is active. |
| 5. Seller onboarding | KYC state machine, payout destinations, reserve policy | Unverified sellers cannot receive payouts. |
| 6. Reconciliation | Provider exports, webhook inbox, mismatch queue | Duplicate/out-of-order/missing webhooks do not double-post money. |
| 7. AutoHireTech SDK | Server-to-server integration, webhook consumer, hosted checkout launch | AutoHireTech can create and complete a rental order without payment-provider code. |
| 8. Security and launch | Penetration test, secrets review, incident runbook, compliance sign-off | Test-mode launch checklist passes and live keys remain disabled until approval. |

The execution order actually being followed is in `PAYHOLD_V2_PLAN.md`, which
sequences these against what is already built.

## 16. Launch checklist

Before live launch, create or confirm: legal entities, provider contracts,
merchant accounts, seller terms, buyer terms, privacy notices, refund and
cancellation rules, KYC/AML procedures, sanctions process, tax treatment,
support escalation path, chargeback response process, data-retention policy,
incident-response plan. Obtain **written provider confirmation for marketplace
payouts** in Rwanda, the UAE, Mainland China and the United States.

The production release begins in test mode: separate test and live credentials,
separate webhook endpoints, a feature flag per country and method, synthetic
payment scenarios, provider failure simulations, refund tests, payout failure
tests, dispute tests, reconciliation tests. **Do not enable a country or method
merely because its button renders in the checkout UI.**

## 17. Explicit non-goals

The first release must not support: cryptocurrency; anonymous seller payouts;
personal-account Cash App or Venmo transfers; manual "mark as paid" controls;
unverified bank destinations; pooled company funds represented as customer
holdings; or a promise that all buyers and sellers worldwide can use all
methods.

These create material fraud, regulatory, provider-contract and
consumer-protection risk.

---

# Part II — PayHold platform sections

Carried forward from V1. Each describes a subsystem that is built and running,
and for which Part I has no equivalent.

## 18. The language rule (non-negotiable)

Never write the word **escrow** in anything user-facing, public, or
marketing-adjacent. It is a regulated term. Use **"payment hold"** or **"buyer
protection"**. Internal code comments and variable names follow the same habit
so nothing leaks by copy-paste. The rule binds AI model output too: prompts
forbid the term and validators reject it.

This is stricter than §1, which only forbids *claiming* the legal arrangement.
Ours forbids the word. Ours wins — see §29.5.

## 19. Money model and custody

Funds sit in Flutterwave/Stripe balances — provider vaults. PayHold is the sole
keyholder and never custodies funds itself.

**Bring-your-own-keys.** Each tenant connects their own provider account. Buyer
money lands in that company's balance, not a PayHold-owned one. This was chosen
over pooled keys deliberately: pooling would put every tenant's buyer money in
PayHold's own balance, which is the regulated custody activity §1 and §17 both
steer away from. V1 offered a "pooled keys pilot" as an onboarding shortcut;
**that option is withdrawn** — §17 names it a non-goal.

Provider credentials are encrypted at rest in `tenant_provider_accounts` and
have no read path. API keys are hashed at rest and compared by hash. PayHold
never stores raw card numbers or full mobile-money numbers — provider
tokenization only. 3DS is requested on all card charges and never silently
downgraded.

## 20. The release rule

Money leaves a hold when **both buyer and seller confirm**, or when the
`auto_release_at` timer fires. Otherwise it refunds.

The atomic-release guard — `SELECT ... FOR UPDATE` around the both-confirmations
check — is only meaningful inside the transaction that writes the release. This
is why `release_deal`, `confirm_deal`, `refund_deal` and `settle_payout` are
`security definer` Postgres functions rather than TypeScript. Edge Functions own
FX, fees, provider calls and auth, and pass already-converted figures in.

The auto-release timer has no release path of its own: it writes the missing
confirmations with `actor = 'auto'` and lets `confirm_deal` release, so the timer
goes through the same row lock as a human confirmation and cannot drift from it.

## 21. Money invariants

Every money path must satisfy all of these.

1. **Service-role only.** All money writes happen in Edge Functions using the service role. Dashboard and API clients have zero direct write access.
2. **Verify then re-verify.** Every inbound provider webhook: check the signature *and* re-fetch the transaction from the provider API to confirm amount, currency and status — before touching any state.
3. **Amount/currency must match the deal.** Mismatch → `disputed`, never `funded_held`.
4. **Idempotent.** Unique `provider_ref`; duplicate webhooks are no-ops; release and refund are safe to call twice.
5. **Atomic release.** `SELECT ... FOR UPDATE` around the both-confirmations check. No double release, ever.
6. **Ledgered + audited.** Every state transition and every provider call writes a `ledger` entry (where money moves) and an `audit_log` row (always).
7. **Signed outbound.** Client webhooks are HMAC-signed so clients can verify PayHold really sent them.
8. **Tenant-scoped.** Every request is scoped to its API key's tenant. Responses must not reveal that other tenants exist.
9. **AI advises, never decides.** Model output is a suggestion. It runs on a read-only role and can only be executed by a human approval or a deterministic rule.
10. **Notified.** Every state transition queues a signed webhook to each registered endpoint, in the same transaction as the transition. A client endpoint being down can never fail a release — delivery is a separate, retrying pass.
11. **Rules stop, people send.** The deterministic risk rules may hold a payout for review and may do nothing else. They cannot release, refund or send, so a wrong rule costs a seller a wait rather than money. Only a person clears a hold, and the approval is recorded against them.

## 22. Security deposits

A separate primitive from the payment hold, and Part I does not cover it.

`POST /v1/deals/:id/deposit` + `/capture` + `/release` — a card pre-authorization
lifecycle. Unlike refunds, deposits **are** partially capturable: `capture_deposit`
takes an amount, because a scratched bumper is not the whole deposit. Ledger
entry types `deposit_hold`, `deposit_capture` and `deposit_release` keep it
separate from the deal's own money.

## 23. Risk rules and request context

Four fraud layers, and only one may stop anything.

- **3DS** requested on every card charge, never silently downgraded.
- **Tokenization** — no raw card or full mobile-money number is ever stored.
- **Radar** on Stripe card charges.
- **Deterministic risk rules**, checked before a payout leaves: a first payout to
  a seller who registered just before the booking; a jump past 3× anything they
  have been paid before; a dispute lost in the last 90 days; a deal funded and
  released within minutes.

A rule may hold a payout for review and nothing else. Signals are recorded
whether or not the rules are switched on — that history is what a fraud model of
our own trains on later (§24.4) and it cannot be backfilled. The rules are
arithmetic over our own tables, which is exactly what lets them act at all under
invariant 9. The AI risk *narrator* is a separate thing: it summarises, it never
holds.

A person may also hold a payout by hand (`hold_payout`), because the only other
way to stop one seller was freezing the tenant — which stops every honest seller
with them. `review_held_by` tells the two apart: null means a rule did it, a name
means somebody did and can be asked why.

**Where a payment came from** is recorded in `request_context` — an address, a
provenance (`provider` / `hosted_page` / `client_attested`) and the event it was
seen at. Observation only: no rule reads it, and capture cannot fail a payment.
The three sources are kept apart because a client can tell us anything and a
provider is reporting what it saw.

Two things bind anyone writing a rule against it. In the launch markets most
buyers pay by mobile money from behind carrier-grade NAT, so a shared address is
usually a carrier rather than a person — IP is worth having for geo-mismatch and
cross-tenant reuse, not as a verdict. And it is the first personal data PayHold
stores, kept indefinitely by decision so §24.4 has history to train on, which
carries a stated purpose and a deletion path as obligations rather than options.

## 24. PayHold Intelligence

An AI layer from day one, renting a pre-trained model's reasoning (Claude via
the Anthropic API, `claude-opus-5`) pointed at PayHold's own data. **Invariant 9
is the whole design**: it advises, a human approves, the approval is what writes
to the ledger. It is non-critical by construction — if the API is down, every
money path still works.

### 24.1 Golden rule

No AI output may release, refund, capture, dispatch a payout or change a deal's
status. Every AI output is a suggestion attached to a deal or dispute, shown with
an explicit approve/reject by a human; the approval, not the generation, is the
event that writes to the ledger. AI runs read-only against the database on a
scoped role, never the service role.

This is enforced by a Postgres role rather than by convention: the drafting
functions connect as `payhold_ai`, which holds no execute on any money function.
`decide_ai_suggestion` — locked, requiring an approver's name — is the single
bridge across.

Prompts contain only that tenant's own data. No raw card or full mobile-money
numbers in these tables. The language rule (§18) binds model output.

### 24.2 Buildable from day one

- **Dispute assistant** — reads both sides' statements, photo descriptions and
  the full deal history; drafts a suggested resolution with the events it cited.
  An admin approves; the approval executes. **As of V2 this includes a partial
  refund with an amount** (§29.6) — V1's `escalate`-only compromise existed
  because the engine had no partial-refund primitive to express a split in.
- **Risk narrator** — before a large payout or on a flag, summarises what is
  known about the counterparties. Advisory only, never an auto-block. It reads
  the Fraud screen and cannot act on it.
- **Support assistant** — answers tenant questions from our own docs. Retrieval
  only; no write tools bound.

### 24.3 Data logging

Logging starts now because the labels §24.4 needs cannot be backfilled.

```
ai_suggestions(id, tenant_id, deal_id, kind, model, prompt_version, input_hash,
  output jsonb, cost_usd, created_at, decided_by, decision, decided_at)
deal_outcomes(id, tenant_id, deal_id, outcome, reason_code, notes,
  amount_disputed, resolved_at, created_at)
risk_signals(id, tenant_id, deal_id, seller_id, signal, value jsonb, created_at)
```

`deal_outcomes` is written by triggers on the money path, not by anything AI, so
the labels cover resolutions no model saw.

### 24.4 Buildable after ~6–12 months of real transactions

Our own fraud scoring model trained on `deal_outcomes`, and anomaly detection on
ledger and payout patterns — velocity, destination churn, round-trip refunds —
surfaced as suggestions through the same approve/reject flow. Gate: do not train
until there is enough labelled volume to beat the rules engine on a held-out set.

### 24.5 Cost and failure behaviour

Per-tenant monthly AI budget in settings. Over budget → AI features degrade to
off, never a blocked money path. Short timeouts; responses schema-validated
before storage; invalid output discarded and logged, never rendered.

## 25. Dashboard access and tenancy

Dashboard access is separate from the API. A company signs up and its people
sign in with an email and password held by Supabase Auth — not an API key, which
is a server credential and belongs on a server.

`POST /account/signup` creates the company and its first `owner`;
`GET /account/me` turns a session into a tenant and a role. Signing in never
touches our code: the dashboard exchanges the password with Supabase Auth
directly. Passwords are never stored, logged or read back by anything in this
repository. Minimum twelve characters — a dashboard session reads every deal and
payout a company has.

The dashboard is behind that gate in full. The hosted buyer and seller pages
(`/pay/:id`, `/status/:id`) are not, and must never be — someone opening a
payment link from an email has no PayHold account.

**Master-admin is a different axis of authority** from tenant roles, held in
`platform_admins`, deliberately not a `tenant_users` role. Conflating them is how
a client's "owner" ends up able to see other tenants.

RLS gives dashboard sessions `select` on their own tenant's rows and **no write
policy at all**. The absence is the control, not an oversight.

## 26. Cron jobs

| Job | Function | Status |
|---|---|---|
| Auto-release timer | `auto-release` | built |
| Clearance → payout dispatch | `payout-dispatch` | built — screens before it transfers |
| Outbound webhook delivery | `webhook-dispatch` | built |
| Ledger-vs-provider reconciliation | `reconcile` | built |
| Reminders | — | not built; needs a channel decided first |

**Written is not running.** Schedules live in `scripts/schedule-cron.sql` and are
applied by hand, once, per environment. They are staggered deliberately:
**reconcile → auto-release → payout-dispatch**, because drift freezes payouts and
a dispatch that went first would send money out of a balance we already know we
cannot explain.

Reconciliation compares **per rail, not per currency** — you cannot ask two
providers about one number. Any drift freezes that tenant's payouts
automatically. Nothing unfreezes automatically: the numbers agreeing again is not
the same as someone having understood why they did.

Scheduled jobs authenticate on `CRON_SECRET`, not an API key. A deployment
without that secret set refuses to run them.

## 27. Operations guide — how to add anything

Keep this section accurate in the same commit as any behavior change.

- **A new company (tenant).** Insert tenant → create settings → store their provider keys (encrypted) → generate API key → register webhook endpoints → run one full sandbox deal → go live. No pooled-key pilot (§19).
- **A payment provider.** New class implementing `PaymentProvider` + a webhook function + a routing entry. Ledger and API unchanged.
- **A market or currency.** Add to the routing matrix (§29.4 — data, not code); verify the provider supports collection **and** payout there; sandbox test; complete the country-launch checklist (§5).
- **Fees or timers for a company.** Edit that tenant's settings in the dashboard; applies to new deals only. In-flight deals keep the settings they were created with, AI settings included.
- **Staff.** `tenant_users` row with a role. Master-admin only via the database.
- **A new deal type.** Nothing to change — the engine only needs amount, parties, dates. Machines, services, equipment all flow identically.
- **Notification channels.** Sender function called from status transitions; per-tenant sender IDs in settings.
- **An AI assistant.** Bump `ai_suggestions.prompt_version`; run in shadow mode (suggestions logged, not shown) for a week; compare against the humans' actual decisions; then enable per tenant. Model upgrades follow the same drill.
- **Quick triage.** Payment without deal → webhook logs + reconciliation recover it. Failed payout → auto-retry, error in `audit_log`. Ledger mismatch → tenant payouts frozen until resolved. Key leak → revoke/rotate; no secrets are ever client-side.

## 28. Testing gate before any live traffic

Full sandbox walkthrough, all of it: pay (test card + test mobile money) → held →
confirm ×2 → release → clearance → payout; refund path; timer path; and a
forged-webhook test that **must** return 401.

The way in gets walked too: sign up → land in an empty company → sign out → sign
back in → a dashboard call with no bearer token **must** return 401, and one
carrying a session belonging to another company must return that company's
nothing rather than this one's rows. RLS is only proven against the real project
(PGlite shims `auth.uid()`), so this is where that check lives.

V2 adds to the gate: a partial refund at each of the four §7.1 lifecycle points;
a routing failure that falls back to a verified backup; a payout to an unverified
seller that must be refused; and a country disabled in data that disappears from
checkout without a redeploy.

The whole run is written out in order in
`payhold-backend/scripts/sandbox-walkthrough.md`, and each part signs off a §16
checklist item by name. It is deliberately not automated: half of it is watching
what happens on a provider's own dashboard, and a script that could green-light
itself is the thing §16 exists to prevent.

**Nothing here is what permits live traffic.** §16's gate is, and it is
enforced: `POST /v1/provider-accounts` refuses `mode: "live"` while any required
checklist item is outstanding. The walkthrough is four of those items.

---

# Part III — Standing divergences

Where Part I and Part II disagree, this is the ruling. Anything in the codebase
that contradicts a ruling here is a bug.

## 29.1 Release requires both confirmations — Part II wins

Part I's §6 lifecycle releases on buyer acceptance alone. PayHold releases only
when both buyer and seller have confirmed, or the timer fires. Invariant 5's row
lock is what makes double-release impossible and it is load-bearing.

The lifecycle is adopted **around** that rule, not instead of it. Two of §6's
states are not implemented as states, because they already exist here under
another name:

| §6 state | PayHold state | Why |
|---|---|---|
| `delivered` | `confirmed_seller` | The seller saying the work is done *is* the seller's confirmation. |
| `buyer_review` | `confirmed_seller` | The same window seen from the other side: seller in, buyer not. |

The wire keeps both names — `order.delivered` fires on the seller's
confirmation, `order.accepted` on the buyer's (§10.2) — because an event name is
free and a second *state* is not.

One further difference in meaning: §6 reads `confirmed_buyer` as "delivered
**and** accepted", the last stop before clearing. Here the model is symmetric —
either side may confirm first — so `confirmed_buyer` means "the buyer has
confirmed and the seller has not". §6's sequence is one path through that, not
the only one.

**`clearing` is a rename, not a new step.** V1 wrote the release ledger entry,
set `released`, and used `payout_due_at` to hold the money through the clearance
window — so `released` already meant "out of the hold, not yet payable", which
is what §6 calls `clearing`. V2 gives the two halves separate names: `clearing`
inside the window, `released` past it and payable (§5.1's `available`), then
`payout_pending` while the transfer is with the provider. When money moves did
not change.

Implemented 2026-08-07. `payhold-backend/tests/lifecycle.test.ts` is the
acceptance spec; the mock's `engine.test.ts` was the other half of it until the
dashboard cut over and the mock was deleted.

## 29.2 The object is a `deal`, not an `order` — Part II wins

`deal` is the name in the enum, every SQL function, all fifteen screens and the
public API. Renaming buys nothing functional and breaks
AutoHire's integration. §10.1 carries the mapping.

Webhook **event names** do take §10.2's `order.*` vocabulary, and that was a
**breaking rename**, not the free change this section first claimed. There is no
per-event subscription — `enqueue_webhooks` fans out to every registered
endpoint — so emitting the V1 and V2 name together would double every client's
delivery volume rather than easing a migration. One event per transition, and
the rename is affordable exactly once: before any live traffic, with AutoHire as
the only integration. After launch this becomes a versioned endpoint.

| V1 | V2 |
|---|---|
| `deal.funded_held` | `order.funded_held` |
| `deal.confirmed` (side=seller) | `order.delivered` |
| `deal.confirmed` (side=buyer) | `order.accepted` |
| `deal.released` | `order.clearing_started` |
| — | `order.released` (new: the window closed) |
| `deal.refunded` | `refund.succeeded` |
| `deal.disputed` | `dispute.opened` |
| `deal.paid_out` | `payout.paid` |

## 29.3 Unapproved rails ship declared but disabled — Part I, scoped

§9 lists `paypal`, `cash_app_pay` and `china_wallet_partner` as first-release
adapters. They are registered as capability rows with `enabled = false` and no
implementation; `loadProvider` throws for them, loudly, rather than falling back
to a fake that would silently collect nothing.

`StripeProvider` **is** built, because three of the four launch markets need it.
No rail is enabled without written provider confirmation (§16).

## 29.4 Country enablement is data, not code — Part I wins

§12 requires that a country be disabled without redeploying code. Today
`_shared/countries.ts` is *generated source* and enablement is a code change.
The generator keeps emitting the country registry; **enablement moves into
data.** This is a structural requirement and §5.2's eighth acceptance test
exists to prove it.

Implemented across Phases 5 and 6: `payout_routes` carries the rails,
`payment_markets` carries the country switch, and §29.11 records exactly how
much moved and what deliberately did not.

## 29.5 The language rule is stricter than §1 — Part II wins

§1 forbids *claiming* the legal arrangement. §18 forbids the word. §18 wins, in
code, UI, comments and model output alike. The source document's own subtitle
would fail this rule, which is why it is not reproduced.

## 29.6 Refunds are partial as well as full — Part I wins

This **overrides** V1's recorded design decision that refunds are all-or-nothing.
§7.1.5 requires full, partial and line-item refunds; §8 requires partial-refund
offers in the Resolution Center; §6 has a `partially_refunded` state.

Consequences, all of them intended: `refund_deal` takes an amount and optional
line items; the ledger gains a cumulative refund guard checked under the release
lock; and the dispute assistant (§24.2) can draft a split instead of escalating.
Invariant 9 is untouched — the model proposes an amount, a named person's
approval writes it.

## 29.8 `partially_refunded` is declared and never written — Part II wins

§6 lists it as a state. It is implemented as an *amount*, not a status.

A deal refunded by a third before release still has to be delivered, confirmed,
cleared and paid out for the other two thirds. A deal whose status said
`partially_refunded` would sit outside `HOLDING_STATUSES`, unreachable by
`confirm_deal`, invisible to `mature_clearing_deals` and undispatchable —
collapsing "how far along is this deal" and "how much has gone back" into one
column makes the second readable at the cost of the first.

How much has gone back is derived, from the `refunds` table and
`deal_amounts.refunded`. Only a **full** refund is a lifecycle event, and it has
always had a state of its own.

The enum value stays declared, so a future model that does want the label — a
post-payout deal settled at less than it was paid, say — needs an endpoint
rather than a migration.

Implemented 2026-08-07. `payhold-backend/tests/partial-refunds.test.ts` is the
acceptance spec.

## 29.9 §5.1's seven payout states are six stored and two derived — Part II wins

§5.1 lists `clearing | available | processing | paid | failed | blocked |
needs_verification` as the statuses to display. Only two of them are new facts,
and two of them are not payout facts at all.

`payout_status` gained **`blocked`** and **`needs_verification`**. It did not
gain `clearing` or `available`: a payout row exists in `scheduled` across both,
and which one it reads as is a question about the *deal's* clearance window —
which `payout-dispatch` already treats as authoritative, maturing deals before
it scans for payouts. Storing them on the payout as well would be one fact with
two writers. `payout_display_status()` derives §5.1's vocabulary; `payouts.status`
keeps every distinction an operator needs.

The two new statuses are separated from `held_for_review` by **who can end
them**, which is the whole reason they are worth having:

| | ends when |
|---|---|
| `held_for_review` | a named person approves. A machine never may — invariant 11 |
| `needs_verification` | somebody attests to the missing fact (`verify_seller`) |
| `blocked` | a route exists, or a dispute resolves |

That is a **strengthening** of §12's gate. Until Phase 5 the eligibility checks
produced `held_for_review`, which put "we have never verified this seller" in
the same queue as "this payout is unusually large" — and an operator with the
approve button could clear the first, which is what §12's sentence says must not
be possible. `approve_payout_review` still accepts only `held_for_review`.

Both new states are machine-recoverable and are in `DISPATCHABLE`, deliberately.
A rule is not *sending* anything when it re-screens and finds the reason gone;
it is the same shape as `frozen` clearing once reconciliation is resolved.

Implemented 2026-08-07. `payhold-backend/tests/payout-routing.test.ts` is the
acceptance spec — its dashboard mirror went with the mock.

## 29.10 A route is never a fallback for another route — Part II reading of §5.1

§5.1's routing priority is "the seller's preferred eligible method first;
otherwise the highest-ranked eligible fallback", which reads as though a payout
may move between rails. It cannot, and the same section says why: **"it must
never silently redirect funds to another destination."**

A destination is a token minted by one provider for one rail. A MoMo token means
nothing to a bank transfer, so "fall back to the next rail" would mean paying a
different destination — the thing the sentence forbids. The fallback §5.1
actually gates is the seller's **backup destination**, behind a failed primary
payout, an explicit policy check and a notification, and that is what
`route_payout` implements.

`route_evaluation` still ranks every rail, because the losing rows are the
eligibility record §5.1 asks to be stored and are what answers a seller asking
why the rail they chose will not work. Only the row matching the destination's
own rail can win.

## 29.11 The registry stays generated; only enablement is data — Part II scoping of §29.4

§29.4 says country enablement moves out of code. It does not say the country
*registry* does, and the difference is the whole of this ruling.

`countries.ts` records which currency a market uses, which wallets exist there,
whether Stripe can pay into it, whether it is sanctioned — roughly 200 rows of
transcribed provider documentation, emitted into both repos by one generator
(`gen-countries.py`) so the two copies cannot disagree. Copying that into SQL
would give it a second home, and the first time somebody edited one and not the
other the two would part company silently. That is precisely the failure the
generator exists to prevent, and it would be reintroduced in the name of a
requirement that does not ask for it.

So the split is:

| | lives in | changes when |
|---|---|---|
| what is **possible** | the generated registry | a provider's coverage actually changes |
| what is **on** | `payment_markets`, `payout_routes`, `provider_capabilities` | somebody decides, with no deploy |

`payment_markets` is an **overlay**, not a mirror: a country with no row behaves
as the registry says, and a row is a deliberate departure carrying a required
`reason`. Closing a market is one insert; reopening it is one delete. Both
directions are covered by §5.2's eighth acceptance test and by §15 phase 3's.

The same shape applies to adapters. `provider_capabilities` holds §9's eight
flags plus `implemented` and `enabled`, and `route_evaluation` reads it — so
switching an adapter off disables exactly its own routes, which is §15 phase 3's
second sentence. `payout_routes.provider` became `not null` in the same change:
Phase 5 used a null to mean "unbuilt" because §9's adapters had no enum values
yet, and a check constraint cannot look at another table. Now each rail names
the adapter that would carry it — one adapter carries several, since Venmo rides
PayPal's API and both Chinese wallets ride one partner — and a trigger refuses
to enable a route whose adapter is not live.

Implemented 2026-08-07. `payhold-backend/tests/capability-matrix.test.ts` is the
acceptance spec.

## 29.12 A checkout session is a buyer's credential, not a payment — Part II reading of §10.1

§10.1 asks for `POST /v1/checkout/sessions` and `GET /v1/checkout/sessions/{id}`
and says only "deal-linked hosted checkout session". What that object *is* was
left open, and getting it wrong is how §15 phase 2's acceptance test —
"test payments cannot be marked successful without verified provider events" —
stops being true.

**A session is a scoped, expiring credential for one payment on one deal.** It
exists so a buyer can choose a payment method without holding an API key, and
without the client's server proxying the choice. It is not a payment, not a
promise of one, and no function that touches it can reach `funded_held` or write
a ledger entry. `tests/checkout-sessions.test.ts` asserts that against the
function bodies and not only against their behaviour.

Three consequences worth recording.

**`checkout.completed` is not the funding event.** It fires when the buyer
finishes the hosted flow and is handed to the provider — the deal is
`payment_pending` at that moment. `order.funded_held` fires when money actually
arrives, after a webhook verified a signature and re-fetched the transaction. A
client that conflated them would ship goods against a card that has not settled,
so the two are deliberately separate events rather than one event with a flag.

**The token is stored in plaintext, unlike an API key.** The reasoning that
makes hashing right for a key does not transfer: a key is only ever *compared*,
so we never need it back, while a payment link has to stay re-derivable because
re-sending one is an ordinary support action. What bounds the risk instead is
scope and time — 256 bits, an expiry, and authority over exactly one payment on
one deal, which is no broader than the deal id that already opens the hosted
page.

**`checkout_started -> created` became a legal transition**, the only backwards
edge in §6's machine. It means a payment link was withdrawn. Nothing has
happened to the deal at that point — no provider call, no money, no state anyone
outside the system observed — so leaving it in `checkout_started` would have the
status claim a buyer had somewhere to pay when they did not.

Implemented 2026-08-07. `checkout_started` had been declared and unreachable
since Phase 1; this is its first writer.

## 29.7 Clearance default moves from 7 days to 14 — Part I wins

V1 defaulted `clearance_days` to 7. §6.1 defaults to 14 calendar days, matching
Fiverr's published standard, with per-market values in §5. `auto_release_days`
stays at 3, which both documents agree on.

In-flight deals keep the settings they were created with, so this is a change to
new deals only.

## 29.13 §16 is enforced and §17 is structural — Part II, stricter than Part I

§16 reads as a list to "create or confirm" and §15's phase 8 asks that "live
keys remain disabled until approval", neither of which says who stops what. Both
are now enforced rather than advisory, and §17 is enforced somewhere else
entirely. The split is the ruling.

**§16 is rows and a gate.** `launch_checklist` carries the section's items and
`POST /v1/provider-accounts` refuses `mode: "live"` while any required one is
outstanding. There is exactly one writer of `tenant_provider_accounts`, so one
check is the whole gate, and a test asserts that stays true. Most items are
attestations with a person's name and a pointer to the evidence; the rest have
acceptance in code, and those whose code is missing carry `blocked_by` and
cannot be signed off by anybody.

The checklist is **platform-scoped and has no `tenant_id`**. The items are about
PayHold — our legal entity, our contracts, our incident-response plan — so a
tenant connecting live credentials is gated on our readiness, because it is our
system their buyers' money would move through.

**§17 is not on that list.** Its seven entries are prohibitions rather than
tasks: nothing about them gets signed, and a checklist row saying "we do not
support cryptocurrency" would be a tick somebody clicks rather than a control.
Each is refused by something structural instead — an adapter that cannot be
enabled while unbuilt, the §12 eligibility gate, a not-null `tenant_id` on every
credential and every ledger entry, and `paid_needs_a_provider_reference`, which
is what makes "no manual mark-as-paid control **anywhere**" true of a correction
run by hand and not only of the code paths we know about.
`payhold-backend/tests/launch-gate.test.ts` is where each is pinned.

Implemented 2026-08-08. The gate ships shut.

## 29.14 A reconciliation run's `missing` counts the inbox, not an export diff — Part II scoping of §13

§13 asks the daily job to compare "provider balances **and transaction
exports**" against the internal ledger. The balance half is built and has been
since V1. The export half is not, and the run record says `missing` while
meaning something narrower than the sentence does.

`PaymentProvider` exposes `balances()` and nothing that enumerates
transactions. Adding a listing call to satisfy the wording would mean one
adapter implementing it, `FakeProvider` answering from fixtures, and every real
rail reporting zero discrepancies — a control that looks authoritative and
checks nothing. That is worse than a smaller claim.

So `missing` counts **verified inbound events we never posted**:
`provider_events` rows inside the run's window with `signature_ok` and no
`processed_at`. It is the arrears half of §13's own inbox/outbox design — money
the provider has told us about that our ledger has not booked — and it is true.
A forgery we refused is excluded, or every probe at a webhook endpoint would
read as a reconciliation failure.

What it does not catch is a transaction the provider never webhooked at all.
That shows up in the balance comparison as drift, which freezes payouts, so the
gap is narrower than it sounds. Widening `missing` to a real export diff is one
adapter method and one column when a provider agreement makes exports available.

Implemented 2026-08-08. `payhold-backend/tests/reconciliation-runs.test.ts`.

## 29.15 A spent retry budget is `blocked` with no clock — Part II reading of §13

§13 says payout failures "retry with capped exponential backoff, then move to
`payout_blocked` for operator action." We have no `payout_blocked` status and
are not adding one: `blocked` already means "stopped by a fact that is neither
the seller's to fix nor an operator's to approve", which is what this is.

The difficulty is that `blocked` is **dispatchable**. §5.1's no-route case is
re-screened every pass on purpose, because a route appearing is not something
anybody has to do anything about, and a machine that re-asks and finds the
reason gone overrules nobody (§29.9's reasoning, applied to routing). A payout a
rail has refused five times is the opposite: re-asking sends the same failure to
the same seller all night.

So the stop is expressed on the retry clock rather than in a second status.
`payouts.next_attempt_at` carries the backoff, and **null means no machine may
attempt this payout again** — the dispatch scan filters `<= now()`, which
excludes nulls by construction, while the approve and retry endpoints go through
the same shared `dispatchPayout` and are unaffected. A person is not a machine,
and that distinction is the column's whole purpose.

Two consequences are deliberate. A person's retry is **one** more attempt rather
than a fresh series, because `route_payout` reads the attempt counter to decide
whether the seller's verified backup destination may be used (§29.10) and
resetting it would quietly send the next attempt back to the primary that has
been failing. And the ladder is the webhook dispatcher's — 1m, 5m, 30m, 2h,
capped — because two backoff curves in one system are two things to reason about
during an incident for no gain.

Implemented 2026-08-08. `payhold-backend/tests/payout-retry.test.ts`.

---

## References

1. Fiverr Help Center — Payment methods
2. Fiverr Help Center — Using the Resolution Center
3. Fiverr Help Center — Managing your orders and revenue clearance
4. Stripe Documentation — Alipay payments
5. Stripe — WeChat Pay
6. Stripe Documentation — Platforms and marketplaces with Connect
7. Stripe — Global availability
