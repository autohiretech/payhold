/**
 * Rail routing invariants.
 *
 * These encode the rules that decide whether money arrives or gets stuck. The
 * backend's provider router must satisfy all of them.
 *
 * The headline guarantee is the first block: **every country can pay.**
 */

import { describe, expect, it } from 'vitest'
import type { Country, PayoutKind } from '@/api/types'
import { COUNTRIES } from './countries'
import { PROVENANCE, PROVENANCE_READING_DATES, provenanceFor } from './railProvenance'
import {
  PAYOUT_KIND_RAIL,
  PAYOUT_PROVIDER_LABEL,
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
  railsForPayoutKinds,
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

  // A seller's country is nullable in the database, and rows in production
  // have none. This used to throw "e is not iterable" out of the spread and
  // took the whole Sellers table to the router's error page.
  it('answers with nothing where there is no country, instead of throwing', () => {
    for (const missing of [null, undefined, '', 'R', 'RWA', '12']) {
      expect(countryFlag(missing as never), String(missing)).toBe('')
    }
  })
})

describe('local rails appear only where they really exist', () => {
  it('offers mobile money collection in exactly the eleven markets Flutterwave names a wallet for', () => {
    const momoCountries = COUNTRIES.filter((c) => c.momo).map((c) => c.code)

    expect(momoCountries.sort()).toEqual(
      ['BF', 'CI', 'CM', 'GH', 'KE', 'MW', 'RW', 'SN', 'TZ', 'UG', 'ZM'].sort(),
    )
  })

  it('keeps where Flutterwave collects apart from where it pays out', () => {
    // Two different pages, and they disagree. Egypt and Malawi have a
    // collection channel and a "submit a request" gate on transfers; Ethiopia
    // has a transfer guide and no collection channel; Zambia's wallets collect
    // but no collection page names a local card rail there.
    expect(countryInfo('EG').flutterwaveLocal).toBe(true)
    expect(countryInfo('EG').flutterwavePayout).toBe(false)
    // Malawi collects, and is payable by wallet only — its bank sits behind
    // the same "submit a request" gate as Egypt's while AIRTELMW does not.
    expect(countryInfo('MW').flutterwaveLocal).toBe(true)
    expect(countryInfo('MW').flutterwavePayout).toBe(true)
    expect(countryInfo('MW').momoPayout).toBe(true)
    expect(countryInfo('MW').bankPayout).toBe(false)
    expect(countryInfo('ET').flutterwaveLocal).toBe(false)
    expect(countryInfo('ET').flutterwavePayout).toBe(true)
    expect(countryInfo('ZM').flutterwaveLocal).toBe(false)
    expect(countryInfo('ZM').momo).toBe(true)
    expect(countryInfo('ZM').flutterwavePayout).toBe(true)
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

  it('cannot pay much of the world, and says so', () => {
    // PayPal counts now (20260910000005). It used to be excluded from this
    // filter because the rail was switched off, so a PayPal-listed market was
    // genuinely unreachable; with it on, leaving it out would have this test
    // asserting that markets we can pay are blocked.
    const unreachable = COUNTRIES.filter(
      (c) => !c.flutterwavePayout && !c.stripePayout && !c.paypalPayout && !c.restricted,
    )
    // The honest headline: collection is universal, payout is not — still true
    // with a third rail on, just by a narrower margin.
    expect(unreachable.length).toBeGreaterThan(40)

    for (const info of unreachable) {
      const route = payoutRoute(info.code, info.currency)
      expect(route.blocked, info.code).toBe(true)
      // ...but a buyer there can still pay.
      expect(collectionRails(info.code, 'USD').length, info.code).toBeGreaterThan(0)
    }
  })

  it('routes a foreign-currency payout to the bank, and asks the host to confirm nothing', () => {
    // This used to demand `/confirm with/i` — the sentence told the reader to
    // check with Flutterwave that their account could pay a third-party
    // beneficiary. Two things were wrong with that and only one has changed.
    //
    // The corridor is now confirmed: the account holder checked with
    // Flutterwave on 2026-09-10 and USD bank payouts work (`20260910000010`),
    // so the caution is answered rather than outstanding. And it was always
    // addressed to the wrong person — this text reaches a **host** through
    // AutoHire's toast, and a car owner can confirm nothing with Flutterwave.
    //
    // Which currencies are actually confirmed is data now, not prose:
    // `payout_routes.cross_border_currencies` carries USD and nothing else, so
    // an unconfirmed currency is never carried by the row and never reaches
    // this sentence. That is a stronger guarantee than asking the reader to go
    // and check, which is the point of the change.
    const route = payoutRoute('RW', 'USD')

    expect(route.provider).toBe('flutterwave')
    expect(route.kind).toBe('bank')
    // §16's per-market confirmation is a separate gate and is untouched.
    expect(route.verified).toBe(false)
    expect(route.reason).toBe('Paid in USD via Flutterwave, to a bank account in Rwanda.')
    expect(route.reason).not.toMatch(/confirm|beneficiary/i)
  })

  it('blocks outright where neither provider can reach the seller — Egypt collects, and Flutterwave transfers there are request-only', () => {
    // Egypt is the sharper case than a market with no Flutterwave presence at
    // all: buyers there pay on a local rail, and the money still cannot go
    // back out, because Flutterwave documents EGP bank and wallet transfers as
    // "not available by default — submit a request".
    expect(countryInfo('EG').flutterwaveLocal).toBe(true)
    const route = payoutRoute('EG', 'EGP')

    expect(route.blocked).toBe(true)
    expect(route.provider).toBeNull()
    expect(route.reason).toMatch(/cannot send money/i)
  })

  it('says collection still works even where payout does not', () => {
    const route = payoutRoute('EG', 'EGP')
    expect(route.reason).toMatch(/collection works everywhere/i)
    expect(collectionRails('EG', 'EGP').length).toBeGreaterThan(0)
  })

  it('pays an Ethiopian seller to a wallet or a bank, though nothing collects locally there', () => {
    // The reverse of Egypt: a transfer guide and an Amole Money transfer code,
    // no collection channel behind either. Both rails are payout-only and
    // neither reaches checkout.
    const route = payoutRoute('ET', 'ETB')
    expect(route.provider).toBe('flutterwave')
    expect(route.kind).toBe('momo')
    expect(route.blocked).toBe(false)

    expect(payoutRails('ET').map((r) => r.method).sort()).toEqual([
      'bank_transfer',
      'mobile_money',
    ])
    expect(payoutRails('ET').every((r) => !r.collect)).toBe(true)
    expect(collectionRails('ET', 'ETB')).toHaveLength(0)
    expect(marketSummary('ET').hasLocalRails).toBe(false)
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

/**
 * `payout.methods` arrives in kinds and a destination is tokenized against a
 * rail, so the translation has to be total: a kind with no rail is a
 * destination the backend offers and this side cannot register.
 */
describe('payout kinds, as the backend answers them', () => {
  const KINDS: PayoutKind[] = ['momo', 'bank', 'connect', 'paypal']

  it('gives every kind a rail, and every rail a word', () => {
    for (const kind of KINDS) {
      const rail = PAYOUT_KIND_RAIL[kind]
      expect(rail).toBeDefined()
      expect(PAYOUT_PROVIDER_LABEL[rail]).toBeTruthy()
    }
  })

  it('keeps the backend’s order — the preferred destination stays first', () => {
    // `payoutMethods` sorts `kind` to the head deliberately; re-ranking here
    // would preselect a destination other than the one a payout would take.
    expect(railsForPayoutKinds(['paypal', 'connect'])).toEqual([
      'paypal',
      'stripe_connect',
    ])
    expect(railsForPayoutKinds(['connect', 'paypal'])).toEqual([
      'stripe_connect',
      'paypal',
    ])
  })

  it('offers nothing when the answer is nothing', () => {
    // A closed market and an unroutable corridor both arrive as an empty list,
    // and an empty picker is the only honest rendering of one.
    expect(railsForPayoutKinds([])).toEqual([])
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
      // Three independent flags, from three providers' own pages. PayPal
      // joined on 2026-09-10 and is neither a subset nor a superset of the
      // other two — it reaches Kenya and Indonesia, and misses Nigeria.
      const reachable = info.flutterwavePayout || info.stripePayout || info.paypalPayout
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

  it('flags that nothing has been verified against a signed provider agreement', () => {
    // Deliberately fails the day someone flips the flag without also updating
    // the warning the dashboard shows. Documentation provenance is the weaker,
    // per-row claim and lives in `railProvenance.ts`; this constant is about
    // contracts and settled transfers, and stays false until there is one.
    expect(RAILS_VERIFIED).toBe(false)
  })
})

describe('rail provenance — what has been checked against provider documentation', () => {
  it('every entry names a rail that exists, in a direction that rail supports', () => {
    for (const key of Object.keys(PROVENANCE)) {
      const [direction, provider, country, method] = key.split(':')
      const rows = RAILS.filter((r) =>
        r.provider === provider && r.country === country &&
        (direction === 'collect' ? r.collect : r.payout) &&
        (method === undefined || r.method === method)
      )
      expect(rows.length, `${key} names no rail row`).toBeGreaterThan(0)
    }
  })

  it('every checked entry carries the page it was read against and the date', () => {
    for (const [key, rec] of Object.entries(PROVENANCE)) {
      expect(rec.state, key).not.toBe('unchecked')
      expect(rec.source, key).toMatch(/^https:\/\//)
      // Two reading dates now: the 2026-09-09 sweep, and PayPal's Payouts
      // country table re-read on 2026-09-10 when the payout direction was
      // added. A record has to carry the date it was actually read.
      expect(PROVENANCE_READING_DATES, key).toContain(rec.checked)
    }
  })

  it('an unlisted row is unchecked, never silently documented', () => {
    // A rail no provenance entry can name — nothing is keyed on the fake
    // adapter — so the lookup has to fall through to `unchecked` rather than
    // to whatever the nearest real row says.
    expect(
      provenanceFor(
        { provider: 'fake', country: 'RW', method: 'card', currencies: [], networks: [], collect: true, payout: false },
        'collect',
      ).state,
    ).toBe('unchecked')
  })

  it('the launch corridor is documented on both sides', () => {
    const momo = RAILS.find((r) => r.provider === 'flutterwave' && r.country === 'RW' && r.method === 'mobile_money')!
    expect(provenanceFor(momo, 'collect').state).toBe('documented')
    expect(provenanceFor(momo, 'payout').state).toBe('documented')
  })

  it('a corridor the routing table was pruned of reads as not supported here', () => {
    // Kenya keeps its Flutterwave bank row in the registry — the flag is per
    // country and M-Pesa is documented — and 20260909000006 took the bank
    // corridor out of `payout_routes` because Flutterwave documents it as
    // "not available by default — submit a request". Unsupported here and
    // absent there is the two halves agreeing.
    const ke = RAILS.find((r) => r.provider === 'flutterwave' && r.country === 'KE' && r.method === 'bank_transfer')
    expect(ke).toBeDefined()
    // The row exists to collect and does not carry a payout direction, which
    // is the gate expressed in the registry rather than only in a note. The
    // reading itself is asserted in railProvenance.test.ts against the
    // unpruned claims.
    expect(ke!.collect).toBe(true)
    expect(ke!.payout).toBe(false)
  })
})

describe('PayPal payouts — the third source of truth', () => {
  it('marks the wallet rail payable exactly where PayPal lists a recipient', () => {
    for (const info of COUNTRIES) {
      const wallet = RAILS.filter(
        (r) => r.country === info.code && r.provider === 'paypal' && r.method === 'wallet',
      )
      if (info.restricted) {
        expect(wallet, info.code).toHaveLength(0)
        continue
      }
      expect(wallet, info.code).toHaveLength(1)
      expect(wallet[0]!.collect, info.code).toBe(true)
      expect(wallet[0]!.payout, info.code).toBe(info.paypalPayout)
    }

    expect(COUNTRIES.filter((c) => c.paypalPayout)).toHaveLength(88)
  })

  it('is not derived from Stripe or Flutterwave — it reaches markets neither does, and misses ones they carry', () => {
    // Kenya and Indonesia: PayPal lists them, Stripe does not pay out there.
    for (const code of ['KE', 'ID', 'IN', 'MX', 'ZA', 'SN'] as const) {
      expect(countryInfo(code).paypalPayout, code).toBe(true)
    }
    expect(countryInfo('KE').stripePayout).toBe(false)
    // Nigeria and Rwanda: Flutterwave pays them, PayPal's table does not
    // list them at all.
    for (const code of ['NG', 'RW', 'UG', 'TZ', 'ET'] as const) {
      expect(countryInfo(code).paypalPayout, code).toBe(false)
    }
    expect(countryInfo('RW').flutterwavePayout).toBe(true)
  })

  it('never takes a corridor an existing rail already carries', () => {
    // `payoutRoute` decides Flutterwave-vs-Stripe and knows nothing about
    // PayPal, deliberately: it is a fallback for markets neither reaches, and
    // preferring it silently would reroute sellers being paid today.
    expect(payoutRoute('RW', 'RWF').provider).toBe('flutterwave')
    expect(payoutRoute('KE', 'KES').provider).toBe('flutterwave')
    expect(payoutRoute('US', 'USD').provider).toBe('stripe')
    expect(payoutRoute('GB', 'GBP').provider).toBe('stripe')
  })

  it('routes a PayPal-only market to PayPal, since nothing else reaches it', () => {
    // This asserted `blocked` while the rail was off. Switching it on
    // (20260910000005) is precisely a decision about these markets: they are
    // the ones that had no payout at all, which is also why PayPal cannot
    // hijack anything — there is no incumbent rail to displace.
    const only = COUNTRIES.find(
      (c) => c.paypalPayout && !c.flutterwavePayout && !c.stripePayout && !c.restricted,
    )
    expect(only, 'expected a market only PayPal lists').toBeTruthy()
    const route = payoutRoute(only!.code, only!.currency)
    expect(route.blocked).toBe(false)
    expect(route.provider).toBe('paypal')
    expect(route.kind).toBe('paypal')
    // …and a buyer there can still pay, which is the whole shape of this table.
    expect(collectionRails(only!.code, 'USD').length).toBeGreaterThan(0)
  })

  it('emits no venmo or cash_app_pay rail at all', () => {
    // Venmo rides PayPal's adapter and is a `payout_provider` rail of its own,
    // refused permanently by §17; Cash App Pay has an adapter name and no
    // class. Neither may ever appear as a rail's provider here — Venmo is not
    // even a `Provider`, which is why this compares over the widened list
    // rather than against the union.
    const providers: string[] = RAILS.map((r) => r.provider)
    expect(providers).not.toContain('venmo')
    expect(providers).not.toContain('cash_app_pay')
    // …and no PayPal payout row advertises a Venmo wallet behind it.
    expect(
      RAILS.some((r) => r.payout && r.networks.some((n) => /venmo|cash ?app/i.test(n))),
    ).toBe(false)
  })
})
