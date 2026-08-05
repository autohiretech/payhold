/**
 * Rail routing invariants.
 *
 * These encode the rules that make the difference between money arriving and
 * money being stuck. The backend's provider router must satisfy all of them.
 */

import { describe, expect, it } from 'vitest'
import {
  RAILS,
  collectionRails,
  defaultProviderFor,
  isMarketSupported,
  payoutCapability,
  payoutRails,
  providerFor,
} from './rails'

describe('collection routing', () => {
  it('offers M-Pesa first to a Kenyan buyer paying in KES', () => {
    const rails = collectionRails('KE', 'KES')
    expect(rails[0]?.method).toBe('mpesa')
    expect(rails[0]?.provider).toBe('flutterwave')
  })

  it('offers mobile money before cards in Rwanda', () => {
    const methods = collectionRails('RW', 'RWF').map((r) => r.method)
    expect(methods.indexOf('mtn_momo')).toBeLessThan(methods.indexOf('card'))
  })

  it('routes an international card payment to Stripe', () => {
    expect(providerFor('INTL', 'USD', 'card')).toBe('stripe')
  })

  it('routes a Rwandan card payment to Flutterwave, not Stripe', () => {
    expect(providerFor('RW', 'RWF', 'card')).toBe('flutterwave')
  })

  it('does not offer M-Pesa to a Rwandan buyer', () => {
    expect(collectionRails('RW', 'RWF').some((r) => r.method === 'mpesa')).toBe(false)
    expect(providerFor('RW', 'RWF', 'mpesa')).toBeNull()
  })

  it('does not offer mobile money in a currency the wallet does not hold', () => {
    // No RWF wallet takes USD — a tourist paying USD gets a card, not MoMo.
    expect(collectionRails('RW', 'USD').every((r) => r.method === 'card')).toBe(true)
  })

  it('lets a buyer anywhere pay by international card in USD', () => {
    expect(isMarketSupported('TZ', 'USD')).toBe(true)
    expect(providerFor('TZ', 'USD', 'card')).toBe('stripe')
  })

  it('reports a market as unsupported when no rail can take the currency', () => {
    // We have no Tanzanian shilling rail configured at all.
    expect(isMarketSupported('TZ', 'UGX')).toBe(false)
    expect(collectionRails('TZ', 'UGX')).toHaveLength(0)
  })

  it('never returns a duplicate method from the same provider', () => {
    for (const [country, currency] of [
      ['RW', 'RWF'],
      ['KE', 'KES'],
      ['INTL', 'USD'],
    ] as const) {
      const rails = collectionRails(country, currency)
      const seen = rails.map((r) => `${r.method}:${r.provider}`)
      expect(new Set(seen).size).toBe(seen.length)
    }
  })
})

describe('payout routing — the rule that catches people out', () => {
  it('never pays an African seller via Stripe', () => {
    for (const country of ['RW', 'KE', 'UG'] as const) {
      expect(payoutCapability(country).provider).toBe('flutterwave')
      expect(payoutRails(country).every((r) => r.provider === 'flutterwave')).toBe(true)
    }
  })

  it('says why, in a sentence a human can act on', () => {
    expect(payoutCapability('RW').reason).toMatch(/Stripe cannot send funds to Rwanda/i)
  })

  it('has no payout rail where none is configured', () => {
    expect(payoutCapability('GH').provider).toBeNull()
  })

  it('never marks a card rail as payable — refunds are not payouts', () => {
    expect(RAILS.filter((r) => r.method === 'card').every((r) => !r.payout)).toBe(true)
  })
})

describe('rail table integrity', () => {
  it('gives every rail at least one currency', () => {
    expect(RAILS.every((r) => r.currencies.length > 0)).toBe(true)
  })

  it('has no rail that can neither collect nor pay out', () => {
    expect(RAILS.every((r) => r.collect || r.payout)).toBe(true)
  })

  it('always resolves a default provider, even for an unroutable pair', () => {
    // Falls back rather than throwing — the deal is still created, and the
    // checkout page is where the buyer learns no method is available.
    expect(defaultProviderFor('TZ', 'UGX')).toBe('flutterwave')
  })

  it('flags that nothing has been verified against provider docs yet', () => {
    // This deliberately fails the day someone marks rails verified without
    // updating the warning shown in the dashboard.
    expect(RAILS.every((r) => !r.verified)).toBe(true)
  })
})
