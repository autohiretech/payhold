/**
 * Rail routing invariants.
 *
 * These encode the rules that decide whether money arrives or gets stuck. The
 * backend's provider router must satisfy all of them.
 *
 * The headline guarantee is the first block: **every country can pay.**
 */

import { describe, expect, it } from 'vitest'
import type { Country } from '@/api/types'
import { COUNTRIES } from './countries'
import {
  RAILS,
  RAILS_VERIFIED,
  collectionRails,
  countryFlag,
  countryInfo,
  currenciesFor,
  defaultCurrencyFor,
  defaultProviderFor,
  isMarketSupported,
  marketSummary,
  payoutCapability,
  payoutRails,
  payoutRoute,
  providerFor,
} from './rails'

const ALL: Country[] = COUNTRIES.map((c) => c.code)

/** Everywhere a payment is legally possible. */
const PAYABLE = COUNTRIES.filter((c) => !c.restricted).map((c) => c.code)

describe('every country can pay — the coverage guarantee', () => {
  it('covers the whole world, all 54 African countries included', () => {
    expect(ALL.length).toBeGreaterThanOrEqual(190)

    const africanRegions = [
      'North Africa',
      'West Africa',
      'Central Africa',
      'East Africa',
      'Southern Africa',
    ]
    const african = COUNTRIES.filter((c) => africanRegions.includes(c.region))
    expect(african).toHaveLength(54)

    for (const code of ['US', 'GB', 'IN', 'CN', 'BR', 'AU', 'JP', 'RW'] as const) {
      expect(ALL).toContain(code)
    }
  })

  it('gives every unsanctioned country at least one way to pay', () => {
    for (const country of PAYABLE) {
      const rails = collectionRails(country, 'USD')
      expect(rails.length, `${country} has no payment option`).toBeGreaterThan(0)
    }
  })

  it('accepts USD and EUR from anywhere it is legal to, via card acquiring', () => {
    for (const country of PAYABLE) {
      for (const currency of ['USD', 'EUR'] as const) {
        expect(
          isMarketSupported(country, currency),
          `${country} cannot pay in ${currency}`,
        ).toBe(true)
        expect(providerFor(country, currency, 'card')).not.toBeNull()
      }
    }
  })

  it('always resolves a provider for a card in every payable market', () => {
    for (const country of PAYABLE) {
      expect(defaultProviderFor(country, 'USD')).toMatch(/flutterwave|stripe/)
    }
  })

  it('takes no payment at all from a sanctioned market', () => {
    const restricted = COUNTRIES.filter((c) => c.restricted).map((c) => c.code)
    expect(restricted.length).toBeGreaterThan(0)

    for (const country of restricted) {
      expect(collectionRails(country, 'USD'), country).toHaveLength(0)
      expect(payoutRoute(country, 'USD').blocked, country).toBe(true)
      expect(payoutRoute(country, 'USD').reason).toMatch(/sanctions or embargo/i)
    }
  })

  it('gives each country a distinct flag emoji', () => {
    const flags = ALL.map(countryFlag)
    expect(new Set(flags).size).toBe(flags.length)
  })
})

describe('local rails appear only where they really exist', () => {
  it('offers mobile money in exactly the ten markets Flutterwave documents', () => {
    const momoCountries = COUNTRIES.filter((c) => c.momo).map((c) => c.code)

    expect(momoCountries.sort()).toEqual(
      ['BF', 'CI', 'CM', 'GH', 'KE', 'MW', 'RW', 'SN', 'TZ', 'UG', 'ZM'].sort(),
    )
  })

  it('names the wallets that actually operate in each market', () => {
    expect(countryInfo('KE').momoNetworks).toEqual(['M-Pesa'])
    expect(countryInfo('RW').momoNetworks).toEqual(['MTN', 'Airtel Money'])
    expect(countryInfo('TZ').momoNetworks).toContain('HaloPesa')
    expect(countryInfo('SN').momoNetworks).toContain('Wave')
  })

  it('does not invent mobile money where Flutterwave has none', () => {
    for (const country of ['ET', 'MA', 'AO', 'DZ', 'US'] as const) {
      expect(
        collectionRails(country, defaultCurrencyFor(country)).some(
          (r) => r.method === 'mobile_money',
        ),
        `${country} should have no mobile money`,
      ).toBe(false)
    }
  })

  it('offers mobile money before cards where it exists', () => {
    const methods = collectionRails('KE', 'KES').map((r) => r.method)
    expect(methods[0]).toBe('mobile_money')
  })

  it('prefers a local rail over the international card rail', () => {
    expect(collectionRails('RW', 'RWF')[0]?.provider).toBe('flutterwave')
    expect(collectionRails('GH', 'GHS')[0]?.provider).toBe('flutterwave')
  })

  it('falls back to Stripe where no local rail exists', () => {
    expect(collectionRails('ET', 'USD')[0]?.provider).toBe('stripe')
    expect(providerFor('MG', 'USD', 'card')).toBe('stripe')
  })

  it('quotes Nigeria in Naira only', () => {
    // A Naira card settles in Naira whatever it is charged, so a Flutterwave
    // rail there must never carry USD.
    const ngLocal = RAILS.filter(
      (r) => r.country === 'NG' && r.provider === 'flutterwave',
    )
    expect(ngLocal.every((r) => !r.currencies.includes('USD'))).toBe(true)
    expect(ngLocal.length).toBeGreaterThan(0)
  })
})

describe('payout routing — where money can actually go', () => {
  it('pays a seller in their local currency wherever Flutterwave reaches', () => {
    for (const info of COUNTRIES.filter((c) => c.flutterwavePayout)) {
      const route = payoutRoute(info.code, info.currency)
      expect(route.provider, `${info.code} local payout`).toBe('flutterwave')
      expect(route.blocked).toBe(false)
    }
  })

  it('sends to a wallet where one exists, and a bank where it does not', () => {
    expect(payoutRoute('KE', 'KES').kind).toBe('momo')
    expect(payoutRoute('ZA', 'ZAR').kind).toBe('bank')
  })

  it('pays a US seller via Stripe', () => {
    const route = payoutRoute('US', 'USD')
    expect(route.provider).toBe('stripe')
    expect(route.kind).toBe('connect')
  })

  it('never routes an African payout through Stripe', () => {
    // Stripe has no payout corridor into any African market — routing there
    // would strand the money rather than deliver it.
    const african = COUNTRIES.filter((c) => c.region.endsWith('Africa'))
    expect(african).toHaveLength(54)

    for (const info of african) {
      for (const currency of [info.currency, 'USD', 'EUR'] as const) {
        expect(
          payoutRoute(info.code, currency).provider,
          `${info.code}/${currency}`,
        ).not.toBe('stripe')
      }
    }
  })

  it('routes payouts through Stripe in exactly its 44 supported countries', () => {
    const stripeMarkets = COUNTRIES.filter((c) => c.stripePayout)
    expect(stripeMarkets).toHaveLength(44)

    for (const info of stripeMarkets) {
      const route = payoutRoute(info.code, info.currency)
      // Flutterwave wins where it also has a local rail; otherwise Stripe.
      expect(route.blocked, info.code).toBe(false)
      if (!info.flutterwavePayout) expect(route.provider, info.code).toBe('stripe')
    }
  })

  it('cannot pay most of the world, and says so', () => {
    const unreachable = COUNTRIES.filter(
      (c) => !c.flutterwavePayout && !c.stripePayout && !c.restricted,
    )
    // The honest headline: collection is universal, payout is not.
    expect(unreachable.length).toBeGreaterThan(80)

    for (const info of unreachable) {
      const route = payoutRoute(info.code, info.currency)
      expect(route.blocked, info.code).toBe(true)
      // ...but a buyer there can still pay.
      expect(collectionRails(info.code, 'USD').length, info.code).toBeGreaterThan(0)
    }
  })

  it('flags a foreign-currency payout for confirmation rather than promising it', () => {
    const route = payoutRoute('RW', 'USD')

    expect(route.provider).toBe('flutterwave')
    expect(route.kind).toBe('bank')
    expect(route.verified).toBe(false)
    expect(route.reason).toMatch(/confirm with/i)
  })

  it('blocks outright where neither provider can reach the seller', () => {
    // Ethiopia has no Flutterwave payout rail and no Stripe presence.
    const route = payoutRoute('ET', 'ETB')
    expect(route.provider).toBeNull()

    expect(route.blocked).toBe(true)
    expect(route.provider).toBeNull()
    expect(route.reason).toMatch(/cannot send money/i)
  })

  it('says collection still works even where payout does not', () => {
    const route = payoutRoute('ET', 'ETB')
    expect(route.reason).toMatch(/collection works everywhere/i)
  })

  it('never returns a provider when blocked, nor a block when routed', () => {
    for (const country of PAYABLE) {
      for (const currency of [defaultCurrencyFor(country), 'USD'] as const) {
        const route = payoutRoute(country, currency)
        expect(
          route.blocked === (route.provider === null),
          `${country}/${currency}`,
        ).toBe(true)
      }
    }
  })

  it('agrees with payoutCapability for the local currency', () => {
    for (const country of PAYABLE) {
      expect(payoutCapability(country).provider).toBe(
        payoutRoute(country, defaultCurrencyFor(country)).provider,
      )
    }
  })

  it('never marks a card rail payable — a refund is not a payout', () => {
    expect(RAILS.filter((r) => r.method === 'card').every((r) => !r.payout)).toBe(true)
  })
})

describe('country is the primary choice', () => {
  it('answers "I chose Rwanda" with Flutterwave, RWF, and the local wallets', () => {
    const rw = marketSummary('RW')

    expect(rw.provider).toBe('flutterwave')
    expect(rw.currency).toBe('RWF')
    expect(rw.networks).toEqual(['MTN', 'Airtel Money'])
    expect(rw.localMethods.map((r) => r.method)).toEqual(
      expect.arrayContaining(['mobile_money', 'bank_transfer']),
    )
    expect(rw.schemes).toEqual(expect.arrayContaining(['visa', 'mastercard']))
    expect(rw.payout.provider).toBe('flutterwave')
    expect(rw.hasLocalRails).toBe(true)
  })

  it('summarises a card-only market honestly', () => {
    const et = marketSummary('ET')

    expect(et.hasLocalRails).toBe(false)
    expect(et.localMethods).toHaveLength(0)
    // A buyer there can still pay.
    expect(et.currencies).toEqual(expect.arrayContaining(['USD']))
    expect(et.schemes.length).toBeGreaterThan(0)
  })

  it('gives every market a summary that does not throw', () => {
    for (const country of PAYABLE) {
      const summary = marketSummary(country)
      expect(summary.name).toBeTruthy()
      expect(summary.currencies.length).toBeGreaterThan(0)
      expect(summary.schemes.length).toBeGreaterThan(0)
    }
  })

  it('never claims a local method a market does not have', () => {
    for (const country of ALL) {
      expect(
        marketSummary(country).localMethods.every((r) => r.country === country),
      ).toBe(true)
    }
  })

  it('offers Verve in Nigeria and nowhere else', () => {
    for (const country of ALL) {
      const localCard = RAILS.find(
        (r) =>
          r.country === country && r.provider === 'flutterwave' && r.method === 'card',
      )
      if (localCard?.schemes?.includes('verve')) expect(country).toBe('NG')
    }
  })
})

describe('rail table integrity', () => {
  it('gives every rail at least one currency', () => {
    expect(RAILS.every((r) => r.currencies.length > 0)).toBe(true)
  })

  it('has no rail that can neither collect nor pay out', () => {
    expect(RAILS.every((r) => r.collect || r.payout)).toBe(true)
  })

  it('gives every country a currency and a name', () => {
    for (const info of COUNTRIES) {
      expect(info.currency, `${info.code} currency`).toBeTruthy()
      expect(info.name.length).toBeGreaterThan(2)
    }
  })

  it('lists a payout rail for exactly the markets marked payable', () => {
    for (const info of COUNTRIES) {
      const reachable = info.flutterwavePayout || info.stripePayout
      expect(payoutRails(info.code).length > 0, info.code).toBe(reachable)
    }
  })

  it('reports currencies consistently between the two accessors', () => {
    for (const country of PAYABLE) {
      const fromRails = new Set(
        collectionRails(country, defaultCurrencyFor(country))
          .concat(collectionRails(country, 'USD'))
          .flatMap((r) => r.currencies),
      )
      for (const currency of fromRails) {
        expect(currenciesFor(country)).toContain(currency)
      }
    }
  })

  it('flags that nothing has been verified against provider docs yet', () => {
    // Deliberately fails the day someone flips the flag without also updating
    // the warning the dashboard shows.
    expect(RAILS_VERIFIED).toBe(false)
  })
})
