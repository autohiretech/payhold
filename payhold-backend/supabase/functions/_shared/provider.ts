/**
 * One interface, all rails behind it — spec §7.
 *
 * Adding Paystack or DPO later is one new class implementing `PaymentProvider`,
 * one webhook function, and one routing entry. The ledger, the API and every
 * screen stay exactly as they are. That promise is only kept if nothing outside
 * this file knows which provider it is talking to, so:
 *
 *   - No caller may branch on `provider.name`. Route by capability, not by
 *     identity. `FlutterwaveProvider` is not "the African one", it is the one
 *     `payoutRail()` returns for that corridor.
 *   - Every method is idempotent on `idempotency_key`. Retries are normal:
 *     a cron pass that times out mid-transfer will run again.
 *   - Nothing here writes to the database. These are the outside-world calls;
 *     the bookkeeping half is the SQL functions in migration 000002, and
 *     keeping them apart is what makes a provider timeout recoverable.
 */

import type {
  Country,
  Currency,
  Money,
  PaymentMethod,
  PayoutProvider,
  Provider,
} from './types.ts'

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

export interface ChargeRequest {
  /** Our deal id, passed to the provider as their reference. */
  deal_id: string
  amount: Money
  currency: Currency
  method: PaymentMethod
  /** The specific wallet or scheme, when the buyer has chosen one. */
  network?: string
  /**
   * The buyer's mobile money number, when they typed one.
   *
   * Only a mobile money rail has any use for it, and only a direct charge —
   * a hosted page asks for it itself. It is passed to the provider and kept
   * nowhere: no column on this side stores it, because a wallet number is the
   * buyer's identity on that rail and PayHold has no reason to remember it.
   */
  phone?: string
  /**
   * The buyer's card, when the tenant collects the fields itself.
   *
   * **This is an exception to §6, it is off by default, and it is the tenant's
   * to take.** PayHold's normal posture is that a card never reaches this
   * system at all: the hosted page, the framed checkout and `payment_element`
   * all keep the number inside the provider's own origin, which is what makes
   * "PayHold does not handle card numbers" structurally true rather than a
   * promise. A tenant sending this has accepted PCI SAQ D on their own side —
   * see `rawCardAllowed` in `settings.ts`, which refuses it unless switched on
   * for that tenant.
   *
   * Prefer `payment_element` wherever the rail offers one. This exists because
   * Flutterwave does not: it has a hosted page and a full-viewport script, and
   * nothing in between, so a tenant who wants their own checkout on that rail
   * has no other route.
   *
   * What is guaranteed: encrypted for the provider on the way out, never
   * written to a column, never logged, never held past the request.
   */
  card?: {
    number: string
    cvv: string
    /** Two digits. */
    expiry_month: string
    /** Two digits — the short year, as the rail wants it. */
    expiry_year: string
    name?: string
    email?: string
  }
  /**
   * The second factor a card rail asked for after seeing the card.
   *
   * Answering it means sending the card *again*, which is the rail's design
   * rather than ours. Keeping it in the request — instead of caching the card
   * here between calls — is what lets the client hold it in memory and resend,
   * so nothing on this side ever stores one.
   */
  authorization?: {
    mode: 'pin' | 'avs_noauth'
    pin?: string
    city?: string
    address?: string
    state?: string
    country?: string
    zipcode?: string
  }
  /**
   * Distinguishes retries of one payment from each other.
   *
   * A card rail answers the first call with a demand for a PIN or an address,
   * and the answer is a second call carrying the same reference. The
   * idempotency key must therefore differ between them, or the rail replays the
   * first response and the buyer is asked for the same PIN forever.
   */
  attempt?: number
  /** Where the provider returns the buyer once they have paid. */
  return_url: string
  /**
   * Card charges request 3DS — spec §6. Providers that cannot honour it for a
   * given method ignore it; providers that can MUST NOT silently downgrade.
   */
  three_d_secure: boolean
  idempotency_key: string
}

/**
 * What the buyer has to do next, said precisely enough to be done in a page we
 * do not own.
 *
 * `payment_link` on its own could only ever mean "send them away", so every
 * rail had to end at somebody's hosted page and every integrator had to hand
 * the buyer over at the last step. These variants are the same information with
 * the shape kept: a client that understands them can finish a payment inside
 * its own checkout, and a client that does not can still read `payment_link`
 * and redirect exactly as before.
 *
 * The variants are ordered by how much they ask of the client.
 */
export type ChargeNextAction =
  /**
   * Nothing to collect and nothing to show — the buyer approves on their
   * handset. The client polls until the deal moves.
   */
  | { type: 'wait'; message: string }
  /**
   * The rail sent a one-time code and wants it back. `reference` is the
   * provider's handle for this half-finished charge and is what `validate`
   * must be given; it is the provider's, not ours, and means nothing elsewhere.
   */
  | { type: 'otp'; reference: string; message: string }
  /**
   * The card needs a PIN before it will authorise.
   *
   * Distinct from `otp` because the answer goes somewhere else: a PIN returns
   * to the *charge* endpoint alongside the card, while a code goes to
   * `validate`. Collapsing them would send a PIN to a route that cannot use it.
   * Usually followed by an `otp` action once the PIN is accepted.
   */
  | { type: 'pin'; message: string }
  /**
   * The card needs the billing address the issuer holds.
   *
   * `fields` names what to ask for rather than leaving a client to guess, and
   * is ordered the way a form should read.
   */
  | { type: 'avs'; message: string; fields: string[] }
  /**
   * A wallet the buyer signs into, approved in a window the client opens.
   *
   * Not `redirect`, though a link exists, and not `payment_element`, though the
   * provider serves the UI. A wallet is its own shape: the buyer must
   * authenticate with someone who is not us and never inside our frame — PayPal
   * refuses to be embedded, and should — but their SDK does it in a popup over
   * the client's page, so the checkout underneath survives.
   *
   * `order` is the provider's reference for the approval, which is what the
   * SDK's `createOrder` must hand back. `client_id` is publishable.
   */
  | {
    type: 'wallet_approval'
    provider: Provider
    client_id: string
    order: string
    currency: Currency
    /** Where to send them if the SDK cannot load at all. */
    approval_url: string
  }
  /**
   * The buyer pays us from their own banking app, into an account the rail
   * generated for this one charge.
   *
   * Nothing to collect and nowhere to send them: the account number *is* the
   * instruction, and a client that can print it needs no page of anybody's.
   * It expires, which is why `expires_at` is carried rather than left implied —
   * a buyer who comes back tomorrow must be told the account is stale rather
   * than paying into a dead one.
   */
  | {
    type: 'transfer'
    account: string
    bank: string
    /** Major units, as the buyer must type it into their banking app. */
    amount: string
    reference: string
    expires_at: string | null
    note: string | null
  }
  /**
   * The buyer must be taken to the provider. Framing it is the client's call
   * and their risk — Stripe Checkout refuses to be framed, Flutterwave does not.
   */
  | { type: 'redirect'; url: string }
  /**
   * The provider's fields, mounted into the client's own markup.
   *
   * This is the variant to reach for. The provider serves each input from its
   * own origin, so the card number never touches the client or us and SAQ A
   * holds — but the client positions and styles the container, so it is their
   * checkout rather than a page of somebody else's wearing a border. Stripe's
   * Payment Element and PayPal's CardFields are both this shape.
   *
   * `client_secret` authorises exactly one payment and nothing else. It is
   * meant for the buyer's browser — that is what it is for — but it must not be
   * logged or stored, so it travels no further than the response that carries it.
   */
  | {
    type: 'payment_element'
    provider: Provider
    /** The provider's publishable key. Public by construction. */
    publishable_key: string
    client_secret: string
    /** Where the provider returns the buyer if a step of its own intervenes. */
    return_url: string
  }
  /**
   * The provider collects the details itself, in the client's own page, from a
   * script it serves. This is what keeps a PAN out of both our infrastructure
   * and theirs while still ending inside their checkout: the fields belong to
   * the provider's iframe, the surrounding page belongs to the client.
   *
   * Weaker than `payment_element` and kept for rails that offer nothing better:
   * a script is free to draw wherever it likes, and Flutterwave's takes the
   * whole viewport with a method picker of its own.
   *
   * `reference` is the charge reference the widget must use — our deal id — so
   * the charge the browser creates is the one our webhook is waiting for.
   */
  | {
    type: 'element'
    provider: Provider
    /** The provider's publishable key. Public by construction. */
    public_key: string
    reference: string
    amount: Money
    currency: Currency
    /** Methods the widget should offer. Already narrowed to the live matrix. */
    options: string[]
    redirect_url: string
  }

export interface ChargeResult {
  /** The provider's own reference. Becomes `deals.provider_ref`. */
  provider_ref: string
  /**
   * Where to send the buyer to complete payment.
   *
   * Empty when `next_action` needs no page — a mobile money charge already
   * accepted by the rail has nowhere to send anyone. Clients that still treat
   * this as the whole answer get an empty string rather than a link to nothing.
   */
  payment_link: string
  /**
   * The precise version of `payment_link`. Optional so an adapter that has not
   * been taught this yet keeps compiling; `startCharge` fills in a `redirect`
   * for whatever omits it, which is what those adapters always meant.
   */
  next_action?: ChargeNextAction
}

/** The buyer's answer to an `otp` next action. */
export interface ValidateChargeRequest {
  /** The `reference` the `otp` action carried. */
  reference: string
  otp: string
  method: PaymentMethod
}

/**
 * What the provider says about a transaction, fetched fresh from their API.
 *
 * This is the "re-verify" half of spec §6: a webhook tells us something
 * happened, and then we ask the provider directly what actually happened. The
 * webhook body is never trusted for amounts.
 */
export interface VerifiedTransaction {
  provider_ref: string
  amount: Money
  currency: Currency
  status: 'pending' | 'successful' | 'failed'
  method: PaymentMethod | null
  network: string | null
  /**
   * What the rail charged us for taking this payment, in the same currency —
   * §7's "provider fee", and the one figure in this breakdown that only the
   * provider knows.
   *
   * Zero on a rail that does not itemise it. Booking it here rather than
   * guessing at a rate matters: unbooked, it is the difference between our
   * ledger and the provider's balance, which the reconciliation pass reads as
   * drift and answers by freezing the tenant's payouts.
   */
  fee: Money
  /**
   * A reusable reference to this buyer's payment method, present only once
   * the rail has actually confirmed the charge — a card is not reusable
   * until it has been used successfully once. `null` on a rail with no
   * saved-method capability (`ProviderCapabilities.supportsSavedPaymentMethod`)
   * and on every mobile money transaction, which has no reusable credential
   * at all: a MoMo charge is a one-time approval push, not a token.
   *
   * The caller persists this onto `deals.metadata` at funding time, which is
   * the only place a split deal's later `chargeSaved` call (the balance +
   * overage charge on return) can read it back from.
   */
  saved_payment_method: string | null
}

export interface PayoutRequest {
  payout_id: string
  /** A token from `sellers.beneficiary_token` — never a raw destination. */
  beneficiary_token: string
  amount: Money
  currency: Currency
  idempotency_key: string
  /**
   * The rail the destination was tokenized for, and the country it is in —
   * `seller_destinations.payout_provider` and `.country`.
   *
   * A token alone does not say what kind of account it stands for, and some
   * corridors want more than a token: Flutterwave's Kenya M-Pesa transfers are
   * refused without a `meta` block that a Rwandan MTN transfer must not carry.
   * An adapter reads these to decide whether it is on such a corridor. This is
   * an adapter looking at its own corridor, not a caller branching on a
   * provider's identity — the rule at the top of this file is untouched.
   */
  rail?: PayoutProvider
  country?: Country
  /**
   * Who the money is going to — `sellers.name`, the same value `tokenize` was
   * given. Kenya M-Pesa wants it again on the transfer, split into first and
   * last name.
   */
  beneficiary_name?: string
  /**
   * Who is sending it — the tenant's name and resident country, as Flutterwave
   * wants them on an M-Pesa transfer (`meta.sender`, `meta.sender_country`).
   *
   * `sender_country` has no column behind it yet: `tenants` carries a name and
   * nothing about where the company is. A caller that cannot fill it leaves it
   * out, and the adapter that needs it refuses with the gap named rather than
   * sending a transfer the rail will reject with the money already collected.
   */
  sender_name?: string
  sender_country?: Country
}

export interface PayoutResult {
  provider_ref: string
  /** Some rails settle asynchronously; the transfer webhook confirms later. */
  status: 'pending' | 'paid'
  /**
   * What the provider's own response says it actually sent, when it says so.
   *
   * `PayoutRequest.amount` is what PayHold *asked* the rail to send — the
   * figure `settle_payout` books today, because that is all this shape ever
   * carried back. Asking is not evidence sending happened for that exact
   * number: Flutterwave's create-transfer response and its `GET
   * /transfers/:id` both report their own `amount`, and Stripe's Transfer
   * object reports its own too. Optional because a caller reading only
   * `provider_ref`/`status` (every one until this field existed) must keep
   * compiling, and because a rail whose response this adapter has not yet
   * been taught to read from must not fabricate one.
   */
  amount?: Money
  /** The currency the confirmed `amount` above is denominated in, when known. */
  currency?: Currency
  /**
   * What the rail charged to send this transfer, when it says so.
   *
   * `null` means "asked, and the rail's own response carries no fee field to
   * read" — never a computed guess, and never `0` standing in for "unknown".
   * Undefined means this adapter has not been taught to look at all.
   * Recording this is new; nothing yet nets it against what a seller is told
   * they will receive — see the call sites for why.
   */
  fee?: Money | null
}

export interface RefundRequest {
  provider_ref: string
  amount: Money
  currency: Currency
  idempotency_key: string
}

/**
 * What a refund call actually returns.
 *
 * A refund's own response is the only place a *confirmed* refunded amount
 * comes from — `RefundRequest.amount` is what PayHold asked for, which is
 * exactly the number `deals/index.ts` used to treat as fact once the call did
 * not throw. Stripe's Refund object carries `amount` and `currency`; PayPal's
 * refund resource carries an `amount` block in its own major-unit shape;
 * Flutterwave's refund response is read alongside the transaction it refunds.
 * Optional for the same reason `PayoutResult.amount` is: a caller that only
 * ever read `provider_ref` must keep compiling, and an adapter that cannot
 * find the figure in the provider's response must not invent one.
 */
export interface RefundResult {
  provider_ref: string
  amount?: Money
  currency?: Currency
  /**
   * What the rail charged for the refund itself, when it says so. `null`
   * means the response carries no such field; `undefined` means this adapter
   * has not been taught to look. Never a guess, and never the original
   * collection fee restated.
   */
  fee?: Money | null
}

/** What `transferStatus` reports back — `PayoutResult`'s confirmed figures, without re-sending anything. */
export interface TransferStatusResult {
  status: PayoutResult['status'] | 'failed'
  amount?: Money
  currency?: Currency
  fee?: Money | null
  /**
   * The rail's own words for where this transfer is, in the rail's own
   * vocabulary — `PayPal batch PENDING, item UNCLAIMED`, `Flutterwave
   * NEW`. Short, human, and never translated into ours.
   *
   * It exists because `pending` is silent and can stay silent for a very
   * long time. On 2026-09-12 a live payout sat at `pending` for a day: the
   * cron asked PayPal every five minutes, booked "processing", wrote no
   * audit row and changed no column, and the seller's screen could only say
   * "not moving yet" — true, useless, and indistinguishable from a broken
   * job. Three buckets of the answer (paid, failed, everything else) are
   * enough to *decide* with and not enough to *explain* with.
   *
   * Recorded on the payout, shown to the seller, and never acted on: a
   * decision made by matching this string would be a decision made on prose
   * a provider is free to reword.
   */
  detail?: string
}

/** One `audit_log` row this decision calls for, or none. */
export interface RefundAuditEntry {
  action: string
  details: Record<string, unknown>
}

export interface RefundBookingDecision {
  /**
   * What `deals/index.ts` should pass as `refund_deal`'s `p_amount`.
   *
   * `null` preserves today's behaviour exactly: `refund_deal` recomputes
   * "everything still refundable, net of the provider's own fee" itself,
   * under its own row lock — which is safer than trusting a figure computed
   * a few round trips earlier, because a concurrent refund could have moved
   * the ceiling in between. This function only ever overrides that with an
   * explicit number when the provider's own answer disagrees with what was
   * asked for; agreement is the ordinary case and is left alone.
   */
  amount: number | null
  /** Every audit row this decision calls for — usually none. */
  audit: RefundAuditEntry[]
}

/**
 * Decides what a refund actually books, once the provider has answered.
 *
 * Pure and provider-agnostic on purpose: `deals/index.ts` is the only caller,
 * and this is what makes the "confirmed differs from requested" case provable
 * without a live provider, a database, or a fake standing in for either — the
 * `RefundResult` shapes each adapter's own tests already pin are the only
 * input this needs.
 *
 * Follows the precedent `fund_deal` sets for a webhook's re-verified amount
 * (root CLAUDE.md: "mismatch → disputed, never funded_held" — the money is
 * booked either way, because it genuinely moved, and what differs is whether
 * anyone is told). A refund has no lifecycle state to fall into the way a
 * mismatched charge does, so a discrepancy here becomes an audit row instead
 * of a status change — visible to an operator rather than silently absorbed
 * into whichever number was merely asked for.
 */
export function decideRefundBooking(input: {
  /** What PayHold asked the provider to refund — never what was confirmed. */
  requestedAmount: Money
  presentmentCurrency: Currency
  /** The request body's own `amount`, or null to let `refund_deal` compute its default. */
  callerAmount: number | null
  result: RefundResult
  provider: Provider
  providerRef: string
}): RefundBookingDecision {
  const { requestedAmount, presentmentCurrency, callerAmount, result, provider, providerRef } =
    input
  const audit: RefundAuditEntry[] = []
  let amount = callerAmount

  const confirmedAmount = result.amount
  const confirmedCurrency = result.currency
  // `refund_deal` always writes the deal's own `presentment_currency` — it has
  // no parameter to book a different one — so a rail reporting a different
  // currency is a fact this can surface but not correct on its own.
  const currencyMismatch = confirmedCurrency !== undefined &&
    confirmedCurrency !== presentmentCurrency

  if (confirmedAmount === undefined) {
    audit.push({
      action: 'refund.amount_unconfirmed',
      details: {
        assumed_amount: requestedAmount,
        assumed_currency: presentmentCurrency,
        provider,
        provider_ref: providerRef,
        note: "The provider's refund response reported no confirmed amount; " +
          'booking the requested figure.',
      },
    })
  } else if (currencyMismatch) {
    audit.push({
      action: 'refund.provider_currency_mismatch',
      details: {
        requested_amount: requestedAmount,
        requested_currency: presentmentCurrency,
        confirmed_amount: confirmedAmount,
        confirmed_currency: confirmedCurrency,
        provider,
        provider_ref: providerRef,
        note: 'Booked the requested figure. The provider reported a different ' +
          'currency, which refund_deal has no parameter to record.',
      },
    })
  } else if (confirmedAmount !== requestedAmount) {
    amount = confirmedAmount
    audit.push({
      action: 'refund.provider_amount_mismatch',
      details: {
        requested_amount: requestedAmount,
        confirmed_amount: confirmedAmount,
        currency: presentmentCurrency,
        provider,
        provider_ref: providerRef,
      },
    })
  }

  if (result.fee != null) {
    audit.push({
      action: 'refund.provider_fee',
      details: {
        fee: result.fee,
        currency: confirmedCurrency ?? presentmentCurrency,
        provider,
        provider_ref: providerRef,
      },
    })
  }

  return { amount, audit }
}

export interface PreauthRequest {
  deal_id: string
  amount: Money
  currency: Currency
  return_url: string
  idempotency_key: string
}

/**
 * Charge a payment method saved from an earlier, buyer-present charge on this
 * deal — off-session, with nobody watching. Used for exactly one thing: a
 * split deal's balance (plus any overage), charged the moment a rental is
 * confirmed returned.
 *
 * `token` is `VerifiedTransaction.saved_payment_method` off the deal's own
 * funding — never invented, never taken from a request body. A caller naming
 * its own token would be a caller charging any card it likes.
 */
export interface ChargeSavedRequest {
  token: string
  amount: Money
  currency: Currency
  idempotency_key: string
}

export interface TokenizeRequest {
  /** Raw MoMo number or bank account. Tokenized immediately, never stored. */
  destination: string
  currency: Currency
  country: string
  /**
   * Which wallet, for a mobile money destination — "MTN", "Airtel Money".
   *
   * Not optional in practice on the African rails and only optional in the
   * type because Stripe Connect has no equivalent: a beneficiary is registered
   * against a specific carrier, and Flutterwave refuses a transfer whose
   * `account_bank` does not name one. `_shared/momo.ts` maps it to the wire
   * code and **refuses an unknown pair** rather than sending a default.
   */
  network?: string
  /** The rail's own bank code, for a bank-account destination. */
  bank_code?: string
  /**
   * Who the account belongs to. Rails check it against the account they are
   * registering, so a constant here — which is what this used to send — is a
   * beneficiary that may be refused, and is a payout nobody can trace.
   */
  beneficiary_name?: string
}

export interface TokenizeResult {
  beneficiary_token: string
  /** Display-safe, e.g. "MTN •••• 4821". This is what we persist. */
  masked_destination: string
}

// ---------------------------------------------------------------------------
// The interface
// ---------------------------------------------------------------------------

/**
 * §9: "each adapter must expose capabilities rather than letting the UI guess."
 *
 * This is what makes "no caller may branch on `provider.name`" enforceable
 * rather than aspirational — a caller that needs to know whether a partial
 * refund is possible has somewhere to ask that is not the provider's identity.
 *
 * §7.1.6 is the immediate reason two of these exist: Alipay and WeChat Pay
 * refund asynchronously, and Stripe documents Alipay refunds up to 90 days
 * after payment. "All methods refund the same way" is a promise the product
 * must not make.
 *
 * The routing matrix that reads the rest of these is Phase 6.
 */
export interface ProviderCapabilities {
  supportsCapture: boolean
  supportsPartialRefund: boolean
  supportsMarketplacePayout: boolean
  supportsSellerOnboarding: boolean
  supportsDispute: boolean
  supportsLocalCurrency: boolean
  supportsMobileMoney: boolean
  /** The refund is acknowledged now and settles later, by webhook. */
  supportsAsyncRefund: boolean
  /**
   * Can this adapter save a payment method at charge time and charge it
   * again later, off-session? True for Stripe and Flutterwave cards. Never
   * true for a mobile money charge specifically — see
   * `VerifiedTransaction.saved_payment_method` — which is why this is a rail
   * capability rather than something `chargeSaved`'s presence alone answers:
   * an adapter that serves both cards and MoMo can carry this flag true while
   * still returning a null token for any given MoMo transaction.
   */
  supportsSavedPaymentMethod: boolean
}

export interface PaymentProvider {
  readonly name: Provider
  readonly capabilities: ProviderCapabilities

  /** Collect from the buyer. Returns where to send them to pay. */
  charge(req: ChargeRequest): Promise<ChargeResult>

  /**
   * Answer an `otp` next action and carry the charge on.
   *
   * Optional because issuing a code is a rail's behaviour, not a promise the
   * interface can make: Stripe never asks for one, and a method on every
   * adapter that all but one of them throws from would be a worse lie than its
   * absence. `startCharge`'s caller checks for it before offering the step.
   *
   * Returns a `ChargeResult` rather than a boolean because validating is not
   * always the last step — a rail may answer a correct code with another
   * action, and collapsing that into "done" would strand the buyer.
   */
  validate?(req: ValidateChargeRequest): Promise<ChargeResult>

  /**
   * Ask the provider what really happened. Called on every inbound webhook
   * before any state changes, and by the reconciliation cron.
   */
  verify(providerRef: string): Promise<VerifiedTransaction>

  /** Send funds to a tokenized beneficiary. */
  release(req: PayoutRequest): Promise<PayoutResult>

  /** Return the buyer's money. Safe to call twice. */
  refund(req: RefundRequest): Promise<RefundResult>

  /** Hold a card deposit without taking it. */
  preauth(req: PreauthRequest): Promise<ChargeResult>

  /** Take some or all of a held pre-auth. */
  capture(providerRef: string, amount: Money): Promise<{ provider_ref: string }>

  /**
   * Charge a payment method saved from this deal's own funding — a split
   * deal's balance, charged the moment a rental is confirmed returned, and
   * never called until then. Optional the way `validate?` is: PayPal has no
   * adapter for this, and a method every adapter implements but most throw
   * from would be a worse lie than its absence.
   * `ProviderCapabilities.supportsSavedPaymentMethod` is what a caller checks
   * first.
   */
  chargeSaved?(req: ChargeSavedRequest): Promise<{ provider_ref: string }>

  /** Turn a raw payout destination into a token we can safely store. */
  tokenize(req: TokenizeRequest): Promise<TokenizeResult>

  /**
   * Ask the rail what became of a transfer it accepted.
   *
   * Async rails answer `pending` when a transfer is created and settle it
   * minutes or hours later, so something has to *ask* — and re-sending the
   * original request is not that question. `dispatchPayout` used to re-POST
   * with the same idempotency key and read the reply as a poll, which works
   * only if the rail replays the original response; Flutterwave documents
   * idempotency for charges, not for transfers, so the second POST is either
   * refused as a duplicate reference (booked as a failure, on money that
   * actually left) or sends twice. Neither is a poll.
   *
   * Optional because a synchronous rail has nothing to add: it already told
   * us `paid` in the call that sent the money.
   *
   * Carries the same confirmed `amount`/`currency`/`fee` `PayoutResult` does,
   * for the same reason: Flutterwave's `GET /transfers/:id` reports the
   * transfer's own amount and fee, and a caller asking only "is this done yet"
   * used to throw both away.
   */
  transferStatus?(providerRef: string): Promise<TransferStatusResult>

  /**
   * Ask the rail to give back a transfer it is holding but has not delivered.
   *
   * Optional, and rare: most rails have no such call, and on the ones that do
   * it applies only while the money is in a specific limbo. PayPal's case is
   * an item sitting UNCLAIMED — sent to somebody with no account, who has 30
   * days to sign up before it returns on its own. Cancelling is how an
   * operator says "that address was wrong, give it back now" rather than
   * waiting out the month with the seller's money in the air.
   *
   * **It does not book anything.** The rail is asked; the next
   * `transferStatus` poll observes the result and the ordinary failure path
   * books it, clears the dead reference and lets the payout be sent again.
   * Booking here as well would be the same money recorded twice by two code
   * paths that could disagree.
   */
  cancelTransfer?(providerRef: string): Promise<{ detail: string }>

  /**
   * What this rail will convert a corridor at, right now.
   *
   * Optional for the same reason `banks` is: it is a real capability of a rail
   * that moves money across currencies, not something every adapter could
   * answer, and declaring it required would mean adapters throwing to satisfy
   * a signature. `_shared/rates.ts` is the only caller and refuses rather than
   * falling back to an indicative table when no connected rail offers it.
   */
  transferRate?(from: Currency, to: Currency): Promise<number>

  /**
   * The banks this rail can pay into in one country, so a client can render a
   * picker instead of asking a seller to type a code.
   *
   * Optional because it is not a universal capability: bank codes are a
   * Flutterwave concept, while a Stripe destination is a connected account
   * that carries its own bank details. Unlike `MOMO_NETWORKS` this cannot be
   * a table we transcribe — the list changes, and the rail publishes it.
   */
  banks?(country: string): Promise<{ code: string; name: string }[]>

  /**
   * What the provider says it is holding for us, per currency. The
   * reconciliation cron compares `amount` to `rail_balances()`, and a
   * mismatch freezes that tenant's payouts — so `amount` must keep meaning
   * exactly what it always has: everything still with the provider, not only
   * the spendable slice. `stripe.ts`'s and `flutterwave.ts`'s own comments on
   * why they sum rather than report only "available" are the reason this
   * field is never touched by the split below.
   *
   * `available`, `pending` and `available_on` are the dashboard's own
   * clearing-split view of the same rail — how much of `amount` can move
   * right now, how much is still held back, and when the held-back part is
   * expected to clear. All three are optional and independently nullable:
   * `null` means the rail's own response carried nothing to read for that
   * currency, never a computed stand-in and never zero standing in for
   * "unknown". A rail that has not been taught to look at all simply omits
   * the field, so every existing caller — `reconciliation.ts` included —
   * keeps compiling and keeps reading only `amount`.
   */
  balances(): Promise<
    {
      currency: Currency
      amount: Money
      /** What the rail says can move right now. `null` when it does not say. */
      available?: Money | null
      /**
       * What the rail is still holding back from `available` — not
       * `amount - available` computed here, but read from wherever the rail's
       * own response actually distinguishes the two. `null` when it does not.
       */
      pending?: Money | null
      /**
       * When the `pending` slice is expected to become `available`, as an
       * ISO timestamp the rail's own API reported — never a guess derived
       * from a generic schedule. `null` when the rail gives no such date, or
       * when there is nothing pending to clear.
       */
      available_on?: string | null
    }[]
  >

  /**
   * Verify an inbound webhook's signature. Flutterwave sends `verif-hash`,
   * Stripe an HMAC over the raw body — hence both arguments, and hence the
   * RAW body: parsing before verifying is how signature checks get defeated.
   *
   * A promise is allowed because those two are different kinds of check.
   * Flutterwave's is a shared secret compared verbatim and answers
   * synchronously; Stripe's is an HMAC, and Web Crypto has no synchronous
   * digest. Callers await either way, which costs a synchronous rail nothing
   * and is the only shape that lets a real signature scheme sit behind this
   * interface at all.
   */
  verifySignature(rawBody: string, headers: Headers): boolean | Promise<boolean>
}

// ---------------------------------------------------------------------------
