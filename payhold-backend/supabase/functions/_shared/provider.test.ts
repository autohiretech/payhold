/**
 * `decideRefundBooking` — the confirmed-vs-requested decision for a refund,
 * pure so it is provable without a live provider, a database, or a fake
 * standing in for either. `deals/index.ts` is the only caller; each
 * adapter's own test file (`flutterwave.test.ts`, `stripe.test.ts`,
 * `paypal.test.ts`) pins the `RefundResult` shapes this function is fed.
 */

import { assertEquals } from 'jsr:@std/assert@1'
import { decideRefundBooking, type RefundResult } from './provider.ts'

const BASE = {
  requestedAmount: 5_000,
  presentmentCurrency: 'RWF',
  callerAmount: null,
  provider: 'flutterwave' as const,
  providerRef: 'ref-1',
}

Deno.test('the provider confirms exactly what was asked — booked amount stays null (refund_deal recomputes)', () => {
  const result: RefundResult = { provider_ref: 'r1', amount: 5_000, currency: 'RWF' }
  const decision = decideRefundBooking({ ...BASE, result })

  // Not forced to 5_000: leaving this null preserves refund_deal's own
  // re-check of what is still refundable under its row lock, which is safer
  // than trusting a figure computed several round trips earlier.
  assertEquals(decision.amount, null)
  assertEquals(decision.audit, [])
})

Deno.test('an explicit caller amount that the provider confirms is left alone', () => {
  // requestedAmount tracks callerAmount here because that IS what
  // `deals/index.ts` sends the provider when the caller names a figure.
  const result: RefundResult = { provider_ref: 'r1', amount: 2_000, currency: 'RWF' }
  const decision = decideRefundBooking({
    ...BASE,
    requestedAmount: 2_000,
    callerAmount: 2_000,
    result,
  })

  assertEquals(decision.amount, 2_000)
  assertEquals(decision.audit, [])
})

Deno.test('the provider confirms a different amount — books what happened, audits the gap', () => {
  const result: RefundResult = { provider_ref: 'r1', amount: 4_500, currency: 'RWF' }
  const decision = decideRefundBooking({ ...BASE, result })

  assertEquals(decision.amount, 4_500)
  assertEquals(decision.audit.length, 1)
  assertEquals(decision.audit[0].action, 'refund.provider_amount_mismatch')
  assertEquals(decision.audit[0].details.requested_amount, 5_000)
  assertEquals(decision.audit[0].details.confirmed_amount, 4_500)
})

Deno.test('a caller-named amount the provider undercuts is also overridden and audited', () => {
  const result: RefundResult = { provider_ref: 'r1', amount: 1_800, currency: 'RWF' }
  const decision = decideRefundBooking({
    ...BASE,
    requestedAmount: 2_000,
    callerAmount: 2_000,
    result,
  })

  assertEquals(decision.amount, 1_800)
  assertEquals(decision.audit[0].action, 'refund.provider_amount_mismatch')
})

Deno.test('the provider names no confirmed amount — falls back to the requested figure, audited as an assumption', () => {
  const result: RefundResult = { provider_ref: 'r1' }
  const decision = decideRefundBooking({ ...BASE, result })

  // null here, exactly as the matching case above — the fallback IS the
  // requested figure, and refund_deal computes the identical number under
  // its own lock. What differs from the matching case is that this is now
  // an audited assumption rather than a silent one.
  assertEquals(decision.amount, null)
  assertEquals(decision.audit.length, 1)
  assertEquals(decision.audit[0].action, 'refund.amount_unconfirmed')
  assertEquals(decision.audit[0].details.assumed_amount, 5_000)
})

Deno.test('the provider reports a different currency — the requested figure is booked, not the confirmed one', () => {
  const result: RefundResult = { provider_ref: 'r1', amount: 5_000, currency: 'USD' }
  const decision = decideRefundBooking({ ...BASE, result })

  // refund_deal has no parameter to book a currency other than the deal's
  // own presentment_currency, so the mismatch is surfaced but the requested
  // figure is what still goes in — never a number in the wrong currency.
  assertEquals(decision.amount, null)
  assertEquals(decision.audit.length, 1)
  assertEquals(decision.audit[0].action, 'refund.provider_currency_mismatch')
  assertEquals(decision.audit[0].details.confirmed_currency, 'USD')
})

Deno.test('a currency mismatch takes priority over an amount mismatch — one audit row, not two', () => {
  const result: RefundResult = { provider_ref: 'r1', amount: 4_500, currency: 'USD' }
  const decision = decideRefundBooking({ ...BASE, result })

  assertEquals(decision.audit.length, 1)
  assertEquals(decision.audit[0].action, 'refund.provider_currency_mismatch')
})

Deno.test('a reported fee is audited and never affects the booked amount', () => {
  const result: RefundResult = { provider_ref: 'r1', amount: 5_000, currency: 'RWF', fee: 150 }
  const decision = decideRefundBooking({ ...BASE, result })

  assertEquals(decision.amount, null)
  assertEquals(decision.audit.length, 1)
  assertEquals(decision.audit[0].action, 'refund.provider_fee')
  assertEquals(decision.audit[0].details.fee, 150)
})

Deno.test('no fee reported is silence, not an audit row', () => {
  const result: RefundResult = { provider_ref: 'r1', amount: 5_000, currency: 'RWF' }
  const decision = decideRefundBooking({ ...BASE, result })
  assertEquals(decision.audit, [])
})

Deno.test('a fee reported as null is silence too — asked, and there is nothing to report', () => {
  const result: RefundResult = { provider_ref: 'r1', amount: 5_000, currency: 'RWF', fee: null }
  const decision = decideRefundBooking({ ...BASE, result })
  assertEquals(decision.audit, [])
})

Deno.test('an amount mismatch and a reported fee both get their own audit row', () => {
  const result: RefundResult = { provider_ref: 'r1', amount: 4_500, currency: 'RWF', fee: 25 }
  const decision = decideRefundBooking({ ...BASE, result })

  assertEquals(decision.audit.length, 2)
  assertEquals(decision.audit.map((a) => a.action).sort(), [
    'refund.provider_amount_mismatch',
    'refund.provider_fee',
  ])
})
