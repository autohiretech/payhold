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
  // Egypt: a collection channel, and transfers documented as "not available by
  // default — submit a request" on both destinations.
  assertEquals(countryInfo('EG').flutterwaveLocal, true)
  assertEquals(countryInfo('EG').flutterwavePayout, false)

  // Malawi is the three-way case: it collects, its *bank* transfer is behind
  // the same request gate as Egypt's, and its wallet is not gated at all. One
  // payout flag could not say that, which is why `bankPayout` exists.
  assertEquals(countryInfo('MW').flutterwaveLocal, true)
  assertEquals(countryInfo('MW').flutterwavePayout, true)
  assertEquals(countryInfo('MW').momoPayout, true)
  assertEquals(countryInfo('MW').bankPayout, false)

  // Kenya is the same shape and was mis-stated until 2026-09-10: its bank
  // corridor left the routing table in 20260909000006 while the registry went
  // on claiming it.
  assertEquals(countryInfo('KE').momoPayout, true)
  assertEquals(countryInfo('KE').bankPayout, false)

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

Deno.test('Flutterwave pays out to exactly the thirteen markets reachable by some destination', () => {
  assertEquals(
    codes((c) => c.flutterwavePayout),
    ['CI', 'CM', 'ET', 'GH', 'KE', 'MW', 'NG', 'RW', 'SN', 'TZ', 'UG', 'ZA', 'ZM'],
  )
})

Deno.test('the bank row is narrower than the country flag, and matches the routing table', () => {
  // Kenya, Tanzania and Malawi are payable by wallet and gated by bank; Egypt
  // and Burkina Faso are not payable at all. This list is `flutterwave_bank`'s
  // countries after 20260910000002, country for country.
  assertEquals(
    codes((c) => c.bankPayout),
    ['CI', 'CM', 'ET', 'GH', 'NG', 'RW', 'SN', 'UG', 'ZA', 'ZM'],
  )
  for (const code of ['KE', 'TZ', 'MW']) {
    assertEquals(countryInfo(code).bankPayout, false, `${code} bank is gated`)
    assertEquals(countryInfo(code).flutterwavePayout, true, `${code} pays by wallet`)
  }
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
