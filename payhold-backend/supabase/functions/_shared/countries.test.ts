/**
 * Run with: deno test --allow-env supabase/functions/_shared/countries.test.ts
 *
 * The registry is generated, so what is worth pinning is not its shape but the
 * facts transcribed into it — read from the providers' own pages on
 * 2026-09-09 and cited in `gen-countries.py`. A flag here that the provider
 * does not back is money collected that cannot be paid out.
 */

import { assert, assertEquals } from 'jsr:@std/assert@1'
import { COUNTRIES, type CountryInfo, countryInfo } from './countries.ts'

const codes = (pick: (c: CountryInfo) => boolean) =>
  COUNTRIES.filter(pick).map((c) => c.code).sort()

Deno.test('Flutterwave collection and Flutterwave payout are independent flags', () => {
  // Egypt and Malawi: a collection channel, and transfers documented as "not
  // available by default — submit a request".
  for (const code of ['EG', 'MW']) {
    assertEquals(countryInfo(code).flutterwaveLocal, true, `${code} collects`)
    assertEquals(countryInfo(code).flutterwavePayout, false, `${code} does not pay out`)
  }

  // Ethiopia: a bank-transfer guide and a momo transfer code, no collection page.
  assertEquals(countryInfo('ET').flutterwaveLocal, false)
  assertEquals(countryInfo('ET').flutterwavePayout, true)

  // And the launch market has both, so the split is not "one or the other".
  assertEquals(countryInfo('RW').flutterwaveLocal, true)
  assertEquals(countryInfo('RW').flutterwavePayout, true)
})

Deno.test('Flutterwave collects locally in exactly the thirteen markets its collection pages name', () => {
  assertEquals(
    codes((c) => c.flutterwaveLocal),
    ['BF', 'CI', 'CM', 'EG', 'GH', 'KE', 'MW', 'NG', 'RW', 'SN', 'TZ', 'UG', 'ZA'],
  )
})

Deno.test('Flutterwave pays out to exactly the thirteen markets with an ungated transfer guide or a momo transfer code', () => {
  assertEquals(
    codes((c) => c.flutterwavePayout),
    ['BF', 'CI', 'CM', 'ET', 'GH', 'KE', 'NG', 'RW', 'SN', 'TZ', 'UG', 'ZA', 'ZM'],
  )
})

Deno.test('the CFA members no Flutterwave page names are card-only, not local markets', () => {
  // "XOF means the CFA zone" was this repository's inference, not the
  // provider's statement. A buyer there still pays on the international rail.
  for (const code of ['BJ', 'GW', 'ML', 'NE', 'TG', 'CF', 'TD', 'CG', 'GQ', 'GA']) {
    const info = countryInfo(code)
    assertEquals(info.flutterwaveLocal, false, `${code} local`)
    assertEquals(info.flutterwavePayout, false, `${code} payout`)
    assertEquals(info.momo, false, `${code} momo`)
    assertEquals(info.restricted, false, `${code} restricted`)
  }
})

Deno.test('Sierra Leone is neither collected in nor paid out to — Flutterwave documents SLL, the registry prices SLE', () => {
  assertEquals(countryInfo('SL').flutterwaveLocal, false)
  assertEquals(countryInfo('SL').flutterwavePayout, false)
})

Deno.test('mobile money collection is unchanged — eleven markets, and no Ethiopia', () => {
  assertEquals(
    codes((c) => c.momo),
    ['BF', 'CI', 'CM', 'GH', 'KE', 'MW', 'RW', 'SN', 'TZ', 'UG', 'ZM'],
  )
  assertEquals(countryInfo('ET').momo, false)
})

Deno.test('Stripe supports a business account with payouts in 44 countries, Croatia and Liechtenstein included', () => {
  const stripe = codes((c) => c.stripePayout)
  assertEquals(stripe.length, 44)
  for (const code of ['HR', 'LI', 'BG', 'CZ', 'DK', 'HU', 'NO', 'PL', 'RO', 'SE']) {
    assert(stripe.includes(code), `${code} should be a Stripe market`)
  }
  // Rwanda is not a platform country and cannot be a connected-account one.
  assert(!stripe.includes('RW'))
})
