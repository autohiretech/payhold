/**
 * Money formatting. `formatMoney`/`formatMoneyShort` used to divide every
 * currency by 100 unconditionally, including the zero-decimal ones PayHold's
 * own money engine never scales at all (`toMajor`/`toMinor` in
 * payhold-backend's `_shared/flutterwave.ts` are a no-op for them). That made
 * every RWF, UGX or CFA-franc figure in this dashboard read as 1/100th of the
 * real ledger value — confirmed against AutoHire's live tenant, where a
 * seller's actual RWF payouts summed to exactly the *undivided* figure
 * PayHold's own `ledger_balance` reports.
 */

import { describe, expect, it } from 'vitest'
import { formatMoney, formatMoneyShort } from './format'

describe('formatMoney', () => {
  it('does not scale a zero-decimal currency', () => {
    // A real payout from the ledger: 673,200 RWF, stored as 673200 — not
    // 67,320,000. Dividing by 100 would have rendered "RWF 6,732".
    expect(formatMoney(673_200, 'RWF')).toBe('RWF 673,200')
  })

  it('still scales an ordinary two-decimal currency', () => {
    expect(formatMoney(1_817, 'USD')).toBe('USD 18.17')
  })

  it('renders no decimal point for a zero-decimal currency', () => {
    expect(formatMoney(1, 'RWF')).toBe('RWF 1')
  })
})

describe('formatMoneyShort', () => {
  it('does not scale a zero-decimal currency before choosing K/M', () => {
    // 2,035,953 RWF is just past the K threshold on the real amount. Scaled
    // by 100 first, it would have read as a three-figure sum with no suffix
    // at all.
    expect(formatMoneyShort(2_035_953, 'RWF')).toBe('RWF 2.0M')
  })

  it('still scales an ordinary two-decimal currency before choosing K/M', () => {
    expect(formatMoneyShort(2_500_000_00, 'USD')).toBe('USD 2.5M')
  })
})
