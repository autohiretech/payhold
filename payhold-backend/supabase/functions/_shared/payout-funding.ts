/**
 * Can the rail actually cover this transfer right now?
 *
 * A different question from the one `assert_payout_funded` asks, and the
 * distinction is the whole reason this file exists. That function asks our
 * **ledger** whether the deal's clearing pool still covers what is leaving —
 * `settle_payout`'s own guard, asked early. It is right, and it knows nothing
 * about whether the money is movable at the rail yet.
 *
 * `PaymentProvider.balances()` reports two figures per currency and the
 * relationship between them is the thing to get right: `amount` is the rail's
 * **total** in that currency, and `available` is the **withdrawable subset of
 * it** — not a second pot beside it. That was established by arithmetic rather
 * than by field names, and the wrong reading was briefly shipped and reverted
 * the same day (`3b977d3`): at 13:00 a rail reported a total of 5,966,457 with
 * 0 withdrawable, matching our ledger's expectation exactly; money then became
 * withdrawable and the rail reported the same 5,966,457 total with 5,956,457
 * withdrawable. The total did not move while the subset did, which a total and
 * its subset do while two independent wallets cannot. Summing them invented a
 * surplus and would have frozen the tenant's payouts for a discrepancy that
 * did not exist.
 *
 * So a payout can be refused by the rail while our ledger is entirely correct:
 * the money is there, and not all of it is movable today. A tenant who
 * collects on one rail and pays out on another has the sharper version of the
 * same problem — no amount of collection on Stripe makes anything withdrawable
 * at Flutterwave. `dispatch.ts`'s own comment above the provider call has named
 * that gap for some time; this is the check that closes it.
 *
 * **What is not established, and must not be asserted in any message from
 * here**: what causes the subset to grow. Flutterwave's documentation
 * describes a settlement destination preference and a Collection/Payout split
 * in its dashboard vocabulary, its API defines neither field, and its help
 * pages say plainly that "collections mocked on test mode are not settled into
 * your available balance" — which leaves the observed sandbox movement above
 * unexplained. Telling somebody to go change a setting would be advice we
 * cannot support, possibly about a setting that is already correct. So the
 * sentences below report what the rail said and what was not sent, and stop
 * there.
 *
 * **This must never stop a payout that would have worked.** Three rules come
 * out of that, and all three are load-bearing:
 *
 *   - a rail that does not report a withdrawable figure answers `unknown`, and
 *     `unknown` proceeds. `balances()` documents `available` as null when "the
 *     rail's own response carried nothing to read for that currency, never a
 *     computed stand-in and never zero standing in for unknown", and a
 *     preflight reading null as empty would block every payout on every rail
 *     that has not been taught to look;
 *   - a currency the rail said nothing about is `unknown` too, not zero. An
 *     absent row is silence, and silence is not a balance of nought;
 *   - the caller swallows transport failures into `unknown`. A provider having
 *     a bad minute must not hold money that was about to move — the transfer
 *     is the next thing that would have failed anyway, and it fails with the
 *     rail's own sentence rather than our guess.
 *
 * Equality passes: a rail with exactly the amount withdrawable can send
 * exactly the amount. Fees are the rail's own and come off its side; a balance
 * short by a fee is a refusal we learn from the rail, not one to predict here.
 */

import type { Money } from './types.ts'

/** One `balances()` row, narrowed to the two fields this asks about. */
export interface RailBalance {
  currency: string
  /** The rail's total in this currency. Not this file's question. */
  amount: Money
  /** The withdrawable subset of `amount`. `null`/absent means the rail did not say. */
  available?: Money | null
}

export type RailFunding =
  /** Movable now, or the rail is not saying and we proceed exactly as before. */
  | { verdict: 'ok' }
  | { verdict: 'unknown'; because: 'no_such_currency' | 'rail_did_not_say' }
  /** The rail told us plainly that this much is not movable yet. */
  | {
    verdict: 'short'
    currency: string
    /** What the rail says is withdrawable now. */
    available: Money
    /** What the transfer needs. */
    needed: Money
    /** `needed - available`, so a message does not have to do arithmetic. */
    shortfall: Money
  }

/**
 * Ask the question of a `balances()` response.
 *
 * Pure, and separate from the call that fetches it, so every branch above is
 * testable without a rail — which matters more than usual here, because the
 * branch that must never misfire is the one a live rail will not show us on
 * demand.
 */
export function railFunding(
  balances: readonly RailBalance[],
  currency: string,
  needed: Money,
): RailFunding {
  const row = balances.find((b) => b.currency === currency)

  if (!row) return { verdict: 'unknown', because: 'no_such_currency' }

  const available = row.available
  if (available === null || available === undefined) {
    return { verdict: 'unknown', because: 'rail_did_not_say' }
  }

  if (available >= needed) return { verdict: 'ok' }

  return {
    verdict: 'short',
    currency,
    available,
    needed,
    shortfall: needed - available,
  }
}

/**
 * What to write on the payout, for a person to read.
 *
 * Reports the rail's own two figures and the fact that nothing was sent. It
 * deliberately prescribes nothing: see the header on why the cause of a small
 * withdrawable subset is not something this codebase can currently assert.
 *
 * The one thing worth saying beyond the figures is the test-mode caveat, and
 * it is said because it is documented rather than inferred — Flutterwave's own
 * help pages state that mocked collections are not settled into the available
 * balance and that virtual-account funding is off in test mode. A sandbox
 * account can therefore sit at zero withdrawable indefinitely, and an operator
 * seeing this on a test payout should not go looking for a misconfiguration.
 *
 * Amounts are minor units and are rendered by the reader, not here.
 */
export function shortfallReason(
  short: Extract<RailFunding, { verdict: 'short' }>,
  rail: string,
  mode: 'test' | 'live',
): string {
  const head = `Not sent: ${rail} reports ${short.available} ${short.currency} ` +
    `withdrawable and this payout needs ${short.needed} ${short.currency} ` +
    `(short by ${short.shortfall}). Nothing has been sent and the payout is ` +
    `re-checked every pass.`

  return mode === 'test'
    ? `${head} This is a test-mode account, where collections are never settled ` +
      `into the withdrawable balance, so this can persist without anything ` +
      `being misconfigured.`
    : head
}
