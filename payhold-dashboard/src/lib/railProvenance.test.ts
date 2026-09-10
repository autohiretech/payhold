import { describe, expect, it } from 'vitest'
import {
  PROVENANCE,
  PROVENANCE_READING_DATES,
  PROVENANCE_CLAIMS,
  provenanceFor,
  provenanceRows,
} from './railProvenance'
import { RAILS, type Rail } from './rails'
import type { Country } from '@/api/types'

const claim = (key: string) => {
  const rec = PROVENANCE_CLAIMS[key]
  if (!rec) throw new Error(`no claim recorded for ${key}`)
  return rec
}

const row = (provider: Rail['provider'], country: string, method: Rail['method']) => {
  const rail = RAILS.find((r) => r.provider === provider && r.country === country && r.method === method)
  if (!rail) throw new Error(`no ${provider} ${method} row for ${country} in the registry`)
  return rail
}

describe('rail provenance — every claim is a page and a date', () => {
  it('no claim is unchecked, and every one carries an https source and the reading date', () => {
    for (const [key, rec] of Object.entries(PROVENANCE_CLAIMS)) {
      expect(rec.state, key).not.toBe('unchecked')
      expect(rec.source, key).toMatch(/^https:\/\//)
      // Two reading dates: the 2026-09-09 sweep, and PayPal's Payouts
      // country table re-read on 2026-09-10 for the payout direction.
      expect(PROVENANCE_READING_DATES, key).toContain(rec.checked)
      expect(rec.note, `${key} needs a sentence a person can act on`).toBeTruthy()
    }
  })

  it('PROVENANCE is the claims pruned to rows the registry builds — never a superset', () => {
    for (const [key, rec] of Object.entries(PROVENANCE)) {
      expect(PROVENANCE_CLAIMS[key]).toBe(rec)
      const [direction, provider, country, method] = key.split(':')
      const rows = RAILS.filter((r) =>
        r.provider === provider && r.country === country &&
        (direction === 'collect' ? r.collect : r.payout) &&
        (method === undefined || r.method === method))
      expect(rows.length, `${key} names no rail row`).toBeGreaterThan(0)
    }
  })

  it('a row with no entry is unchecked, never silently documented', () => {
    const phantom: Rail = { provider: 'fake', country: 'RW', method: 'card', currencies: [], networks: [], collect: true, payout: false }
    expect(provenanceFor(phantom, 'collect').state).toBe('unchecked')
  })
})

describe('rail provenance — spot checks against what was read on 2026-09-09', () => {
  it('Rwanda mobile money is documented both ways', () => {
    const momo = row('flutterwave', 'RW', 'mobile_money')
    expect(provenanceFor(momo, 'collect').state).toBe('documented')
    expect(provenanceFor(momo, 'payout').state).toBe('documented')
  })

  it('Kenya bank payout is not supported: on request, per Flutterwave', () => {
    // Read off the unpruned claims. Since `bankPayout` split from
    // `flutterwavePayout` (2026-09-10) Kenya's bank rail no longer carries a
    // payout direction at all — it is gated, which is what this note says — so
    // the row is not rendered and the claim prunes out of `PROVENANCE`. The
    // reading still has to be on file and still has to say why.
    const rec = PROVENANCE_CLAIMS['payout:flutterwave:KE:bank_transfer']!
    expect(rec.state).toBe('unsupported')
    expect(rec.note).toMatch(/submit a request/)
    expect(rec.source).toContain('kenya-1')
    expect(provenanceFor(row('flutterwave', 'KE', 'bank_transfer'), 'payout').state)
      .toBe('unchecked')
  })

  it('Ethiopia bank payout is documented', () => {
    const rec = claim('payout:flutterwave:ET:bank_transfer')
    expect(rec.state).toBe('documented')
    expect(rec.source).toContain('ethiopian-bank-account-transfers')
  })

  it('South Africa bank payout is not supported for want of fields PayHold does not collect', () => {
    const rec = provenanceFor(row('flutterwave', 'ZA', 'bank_transfer'), 'payout')
    expect(rec.state).toBe('unsupported')
    expect(rec.note).toMatch(/recipient_address/)
  })

  it('Sierra Leone bank payout is not supported: SLL, not SLE', () => {
    // Pinned on the claims table: the registry dropped Sierra Leone's
    // Flutterwave rows on 2026-09-09, and the finding should outlive the row.
    const rec = claim('payout:flutterwave:SL:bank_transfer')
    expect(rec.state).toBe('unsupported')
    expect(rec.note).toMatch(/SLL/)
  })

  it('Poland Stripe payout is documented; Japan is outside the self-serve region', () => {
    expect(provenanceFor(row('stripe', 'PL', 'bank_transfer'), 'payout').state).toBe('documented')
    expect(provenanceFor(row('stripe', 'JP', 'bank_transfer'), 'payout').state).toBe('unsupported')
  })

  it('Croatia and Liechtenstein Stripe payouts are documented — the old "not on Express list" entry was wrong', () => {
    expect(provenanceFor(row('stripe', 'HR', 'bank_transfer'), 'payout').state).toBe('documented')
    expect(provenanceFor(row('stripe', 'LI', 'bank_transfer'), 'payout').state).toBe('documented')
  })

  it('a Stripe international card row is documented, citing Stripe', () => {
    const rec = provenanceFor(row('stripe', 'PL', 'card'), 'collect')
    expect(rec.state).toBe('documented')
    expect(rec.source).toContain('docs.stripe.com')
  })

  it('PayPal: listed markets are documented, unlisted ones stay unchecked with the reason', () => {
    expect(provenanceFor(row('paypal', 'DE', 'wallet'), 'collect').state).toBe('documented')
    expect(provenanceFor(row('paypal', 'KE', 'wallet'), 'collect').state).toBe('documented')
    expect(provenanceFor(row('paypal', 'IN', 'wallet'), 'collect').note).toMatch(/Receive and withdraw/)
    // Absent from the Payouts recipient table is not "cannot pay": a different
    // product, and the buyer-country page could not be read.
    const ng = provenanceFor(row('paypal', 'NG', 'wallet'), 'collect')
    expect(ng.state).toBe('unchecked')
    expect(ng.note).toMatch(/could not be read/)
    expect(provenanceFor(row('paypal', 'RW', 'wallet'), 'collect').state).toBe('unchecked')
  })

  it('Flutterwave collection: Nigeria bank transfer documented, Rwanda bank transfer not', () => {
    expect(provenanceFor(row('flutterwave', 'NG', 'bank_transfer'), 'collect').state).toBe('documented')
    expect(provenanceFor(row('flutterwave', 'RW', 'bank_transfer'), 'collect').state).toBe('unsupported')
  })
})

describe('rail provenance — PayPal payouts, read 2026-09-10', () => {
  it('documents a payout row for every tier of PayPal’s recipient table', () => {
    // All four tiers grant "receive and withdraw", which is the whole of what
    // a payout needs, so all four are documented rather than only the top one.
    const tiers: [Country, string][] = [
      ['US', 'Fully localized'],
      ['NZ', 'Send, receive, and withdraw in local currency'],
      ['KE', 'Send, receive, and withdraw'],
      ['IN', 'Receive and withdraw'],
      ['MX', 'Receive and withdraw'],
    ]
    for (const [country, tier] of tiers) {
      const rec = provenanceFor(row('paypal', country, 'wallet'), 'payout')
      expect(rec.state, country).toBe('documented')
      expect(rec.source, country).toContain('developer.paypal.com')
      expect(rec.note, country).toContain(tier)
      expect(rec.checked, country).toBe('2026-09-10')
    }
  })

  it('says on every payout row that the rail is still switched off', () => {
    // The provenance records what the page says. Whether the corridor is on is
    // `payout_routes`, and it is not — §16 wants a signed agreement first.
    const rec = provenanceFor(row('paypal', 'GB', 'wallet'), 'payout')
    expect(rec.note).toMatch(/disabled until a payout agreement is signed/i)
  })

  it('marks a market absent from the recipient table unsupported for payout', () => {
    // The mirror image of the collect rows: for *collection* the table's
    // silence is not an answer, and those stay `unchecked`. For payout it is
    // exactly the answer, because that table is the recipient list.
    for (const country of ['NG', 'RW', 'UG', 'ET']) {
      const rec = claim(`payout:paypal:${country}:wallet`)
      expect(rec.state, country).toBe('unsupported')
      expect(rec.note, country).toMatch(/Absent from PayPal’s Payouts country/)
    }
  })

  it('builds no payout row where PayPal lists no recipient, so the claim is pruned', () => {
    expect(row('paypal', 'NG', 'wallet').payout).toBe(false)
    expect(PROVENANCE['payout:paypal:NG:wallet']).toBeUndefined()
    // …and does build one where PayPal does.
    expect(row('paypal', 'KE', 'wallet').payout).toBe(true)
    expect(PROVENANCE['payout:paypal:KE:wallet']).toBeTruthy()
  })

  it('leaves the collect rows exactly as they were', () => {
    // They were set deliberately: `unchecked` where PayPal's buyer-country
    // list could not be read, and that finding is not this change's to undo.
    const ng = provenanceFor(row('paypal', 'NG', 'wallet'), 'collect')
    expect(ng.state).toBe('unchecked')
    expect(ng.checked).toBe('2026-09-09')
    expect(provenanceFor(row('paypal', 'RW', 'wallet'), 'collect').state).toBe('unchecked')
    expect(provenanceFor(row('paypal', 'DE', 'wallet'), 'collect').checked).toBe('2026-09-09')
  })
})

describe('rail provenance — coverage', () => {
  it('at most 104 (row, direction) pairs are unchecked — the PayPal wallet rows left on 2026-09-09, and only those', () => {
    const unchecked = provenanceRows().filter((r) => r.record.state === 'unchecked')
    expect(unchecked.length).toBeLessThanOrEqual(104)
    const notPaypal = unchecked.filter((r) => !(r.rail.provider === 'paypal' && r.direction === 'collect'))
    expect(
      notPaypal.map((r) => `${r.direction}:${r.rail.provider}:${r.rail.country}:${r.rail.method}`),
    ).toHaveLength(0)
    for (const r of unchecked) expect(r.record.note, r.rail.country).toMatch(/could not be read/)
  })
})
