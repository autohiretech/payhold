/**
 * Run with: deno test supabase/functions/_shared/payout-funding.test.ts
 *
 * The property under test is a refusal that must almost never fire. A payout
 * preflight has two ways to be wrong and they are not symmetrical: letting
 * through a transfer the rail cannot fund costs a seller a failed attempt out
 * of five, while blocking one the rail *could* have funded stops money that
 * was about to reach somebody. The second is worse, so every ambiguous case
 * here resolves to "proceed" and each of those cases gets its own test.
 *
 * The case that motivates the file is the one a live rail will not reproduce
 * on demand: a total that is present and a withdrawable subset that is not.
 */

import { assertEquals } from 'jsr:@std/assert@1'
import { railFunding, shortfallReason, type RailBalance } from './payout-funding.ts'

const NGN = (amount: number, available?: number | null): RailBalance => ({
  currency: 'NGN',
  amount,
  ...(available === undefined ? {} : { available }),
})

// ---------------------------------------------------------------------------
// The shortfall it exists to catch
// ---------------------------------------------------------------------------

Deno.test('a total that is present with a subset that is not is a shortfall', () => {
  // The shape found on a real account: the money is at the rail and our ledger
  // is entirely correct about it, and none of it can move today.
  const verdict = railFunding([NGN(5_966_457, 0)], 'NGN', 100_000)

  assertEquals(verdict, {
    verdict: 'short',
    currency: 'NGN',
    available: 0,
    needed: 100_000,
    shortfall: 100_000,
  })
})

Deno.test('the shortfall is what is missing, not what is needed', () => {
  const verdict = railFunding([NGN(5_966_457, 60_000)], 'NGN', 100_000)

  assertEquals(verdict.verdict, 'short')
  if (verdict.verdict !== 'short') return
  assertEquals(verdict.shortfall, 40_000)
  // The total is deliberately not consulted: it is the figure reconciliation
  // compares, and it is not what a transfer spends.
  assertEquals(verdict.available, 60_000)
})

// ---------------------------------------------------------------------------
// Everything ambiguous proceeds
// ---------------------------------------------------------------------------

Deno.test('a rail that reports no withdrawable figure proceeds', () => {
  // `available` absent is silence. Reading it as zero would block every payout
  // on every rail that has not been taught to report one.
  assertEquals(railFunding([NGN(5_966_457)], 'NGN', 100_000), {
    verdict: 'unknown',
    because: 'rail_did_not_say',
  })
})

Deno.test('an explicit null is silence too, not zero', () => {
  assertEquals(railFunding([NGN(5_966_457, null)], 'NGN', 100_000), {
    verdict: 'unknown',
    because: 'rail_did_not_say',
  })
})

Deno.test('a currency the rail said nothing about proceeds', () => {
  // An absent row is not a balance of nought — a rail may simply not enumerate
  // a currency it holds nothing in, and it may equally be about to accept the
  // transfer anyway.
  assertEquals(railFunding([NGN(5_966_457, 0)], 'RWF', 100_000), {
    verdict: 'unknown',
    because: 'no_such_currency',
  })
})

Deno.test('an empty response proceeds rather than blocking everything', () => {
  assertEquals(railFunding([], 'NGN', 100_000), {
    verdict: 'unknown',
    because: 'no_such_currency',
  })
})

// ---------------------------------------------------------------------------
// The boundary
// ---------------------------------------------------------------------------

Deno.test('exactly enough is enough', () => {
  // A rail with precisely the amount withdrawable can send precisely the
  // amount. Fees are the rail's own and come off its side; predicting one here
  // would block a payout that would have gone.
  assertEquals(railFunding([NGN(100_000, 100_000)], 'NGN', 100_000), { verdict: 'ok' })
})

Deno.test('one minor unit short is short', () => {
  const verdict = railFunding([NGN(100_000, 99_999)], 'NGN', 100_000)
  assertEquals(verdict.verdict, 'short')
})

Deno.test('a withdrawable subset larger than the total is still just enough', () => {
  // Not a case that should arise, and not this function's to police: it asks
  // one question and `amount` is not part of it. Asserting a relationship
  // between the two here would turn a rail's odd reporting into a held payout.
  assertEquals(railFunding([NGN(0, 100_000)], 'NGN', 100_000), { verdict: 'ok' })
})

Deno.test('the right currency is picked out of several', () => {
  const balances: RailBalance[] = [
    { currency: 'USD', amount: 900_000, available: 900_000 },
    { currency: 'NGN', amount: 5_966_457, available: 0 },
    { currency: 'RWF', amount: 100, available: 100 },
  ]

  assertEquals(railFunding(balances, 'USD', 100_000), { verdict: 'ok' })
  assertEquals(railFunding(balances, 'NGN', 100_000).verdict, 'short')
})

// ---------------------------------------------------------------------------
// What the operator reads
// ---------------------------------------------------------------------------

const short = {
  verdict: 'short',
  currency: 'NGN',
  available: 0,
  needed: 100_000,
  shortfall: 100_000,
} as const

Deno.test('the reason carries both figures and says nothing was sent', () => {
  const reason = shortfallReason(short, 'flutterwave', 'live')

  assertEquals(reason.includes('0 NGN withdrawable'), true)
  assertEquals(reason.includes('needs 100000 NGN'), true)
  assertEquals(reason.includes('Nothing has been sent'), true)
  assertEquals(reason.includes('re-checked every pass'), true)
})

Deno.test('the live reason prescribes no fix, because none is established', () => {
  // The two-wallet reading of this rail's figures was disproved and reverted
  // (3b977d3), and what makes the subset grow is not something this codebase
  // can currently assert. A sentence telling somebody to change a settlement
  // setting would be advice we cannot support, possibly about a setting that
  // is already correct.
  const reason = shortfallReason(short, 'flutterwave', 'live')

  for (const claim of ['collection balance', 'settle', 'Settings', 'top that balance up']) {
    assertEquals(reason.includes(claim), false, `live reason should not claim: ${claim}`)
  }
})

Deno.test('the test-mode reason says this is expected, so nobody hunts a setting', () => {
  // Documented rather than inferred: mocked collections are never settled into
  // the withdrawable balance, and virtual-account funding is off in test mode.
  const reason = shortfallReason(short, 'flutterwave', 'test')

  assertEquals(reason.includes('test-mode account'), true)
  assertEquals(reason.includes('without anything being misconfigured'), true)
})
