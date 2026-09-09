/**
 * Migrations 20260909000003, 000004 and 000006 — the routing table catches up
 * with the registry, is pruned to what the providers document, and then is
 * brought to exactly the corridors Stripe's and Flutterwave's own pages
 * support as this repository sends them.
 *
 * Coverage here means "a route row exists for the corridor", judged the way
 * `payment-options` now judges it: any `route_evaluation` row whose reason is
 * not a country/currency/rail failure. Amount limits are a per-payout
 * question and deliberately not part of it, so `p_amount` is 0.
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { migrated, type Harness } from './harness'

let h: Harness
let tenant: string

beforeAll(async () => {
  h = await migrated()
  const { rows: [t] } = await h.db.query<{ id: string }>(
    `insert into tenants (name, slug) values ('Widening Co', 'widening-co') returning id`,
  )
  tenant = t.id
})

afterAll(() => h.close())

/**
 * Two different questions, kept apart the way the handler keeps them apart.
 * `inRoute` asks whether the corridor is *in* a rail's platform row — the
 * thing the migration changes, and independent of whether that rail happens
 * to be enabled in this fixture. `covered` mirrors `payment-options` exactly:
 * any `route_evaluation` row that is eligible or fails only on amount. The
 * declared-and-disabled rails (paypal, venmo, …) return `provider_disabled`
 * for every corridor and count for neither.
 */
async function inRoute(rail: string, country: string, currency: string): Promise<boolean> {
  const { rows } = await h.db.query<{ ok: boolean }>(
    `select ($2 = any(countries) and $3 = any(currencies)) as ok
       from payout_routes where tenant_id is null and payout_provider = $1`,
    [rail, country, currency],
  )
  return rows[0]?.ok ?? false
}

const COVERED = new Set(['eligible', 'below_route_minimum', 'above_route_maximum'])
async function covered(country: string, currency: string): Promise<boolean> {
  const { rows } = await h.db.query<{ reason_code: string }>(
    `select reason_code from route_evaluation($1, $2, $3, 0, null)`,
    [tenant, country, currency],
  )
  return rows.some((r) => COVERED.has(r.reason_code))
}

async function row(rail: string): Promise<{ countries: string[]; currencies: string[]; note: string }> {
  const { rows } = await h.db.query<{ countries: string[]; currencies: string[]; note: string }>(
    `select countries::text[] as countries, currencies::text[] as currencies, note
       from payout_routes where tenant_id is null and payout_provider = $1`,
    [rail],
  )
  return rows[0]
}

const sorted = (xs: string[]) => [...xs].sort()

describe('payout_routes: widened to the registry, pruned, then matched to what the providers document (000003 → 000004 → 000006)', () => {
  // -------------------------------------------------------------------------
  // The end state, in full. A wrong row here is money collected that cannot
  // be paid out, so the whole array is pinned rather than a sample of it.
  // -------------------------------------------------------------------------

  test('flutterwave_bank carries exactly the corridors with an ungated transfer guide', async () => {
    const r = await row('flutterwave_bank')
    expect(sorted(r.countries)).toEqual(sorted(['RW', 'UG', 'GH', 'NG', 'ZA', 'ZM', 'CI', 'SN', 'CM', 'ET']))
    expect(sorted(r.currencies)).toEqual(sorted(['RWF', 'UGX', 'GHS', 'NGN', 'ZAR', 'ZMW', 'XOF', 'XAF', 'ETB']))
  })

  test('flutterwave_momo carries exactly the markets the transfer table names a wallet code for', async () => {
    const r = await row('flutterwave_momo')
    expect(sorted(r.countries)).toEqual(sorted(['RW', 'KE', 'UG', 'TZ', 'GH', 'ZM', 'CI', 'SN', 'CM', 'ET']))
    expect(sorted(r.currencies)).toEqual(sorted(['RWF', 'KES', 'UGX', 'TZS', 'GHS', 'ZMW', 'XOF', 'XAF', 'ETB']))
  })

  test('stripe_connect carries the seeded rows plus every supported country inside the self-serve region', async () => {
    const r = await row('stripe_connect')
    expect(sorted(r.countries)).toEqual(sorted([
      // seeded in 20260807000009
      'US', 'AE', 'GB', 'DE', 'FR', 'NL', 'IE', 'ES', 'IT', 'CA', 'AU',
      // 000003, kept by 000004: eurozone and Switzerland
      'AT', 'BE', 'CH', 'CY', 'EE', 'FI', 'GR', 'LT', 'LU', 'LV', 'MT', 'PT', 'SI', 'SK',
      // 000006: the non-euro EEA members, and the two 000004 pruned on a wrong reading
      'BG', 'CZ', 'DK', 'HU', 'NO', 'PL', 'RO', 'SE', 'HR', 'LI',
    ]))
    expect(sorted(r.currencies)).toEqual(sorted([
      'USD', 'AED', 'EUR', 'GBP', 'CAD', 'AUD', 'CHF',
      'BGN', 'CZK', 'DKK', 'HUF', 'NOK', 'PLN', 'RON', 'SEK',
    ]))
  })

  // -------------------------------------------------------------------------
  // 000003 and 000004 — still true after 000006
  // -------------------------------------------------------------------------

  test.each([
    ['BE', 'EUR'], ['AT', 'EUR'], ['SK', 'EUR'], ['PT', 'EUR'], ['CH', 'CHF'],
  ])('the Stripe Connect row carries %s in %s (supported country, self-serve region)', async (country, currency) => {
    expect(await inRoute('stripe_connect', country, currency)).toBe(true)
  })

  test.each([
    ['BR', 'BRL'], ['JP', 'JPY'], ['SG', 'SGD'], ['MX', 'MXN'],
  ])('%s in %s was widened and then pruned — outside the self-serve region, so the platform would have to be there', async (country, currency) => {
    expect(await inRoute('stripe_connect', country, currency)).toBe(false)
  })

  test('the Flutterwave bank row carries BF in XOF — a transfer guide exists', async () => {
    // Removed again by 20260910000002: the guide exists, the bank list does
    // not, so nothing can be registered there. See that migration.
    expect(await inRoute('flutterwave_bank', 'BF', 'XOF')).toBe(false)
  })

  test.each([
    ['BJ', 'XOF'], ['ML', 'XOF'], ['TG', 'XOF'], ['CF', 'XAF'], ['GA', 'XAF'],
    ['MW', 'MWK'], ['SL', 'SLE'],
  ])('%s in %s was widened and then pruned — no transfer guide, request-only, or an undocumented currency code', async (country, currency) => {
    expect(await inRoute('flutterwave_bank', country, currency)).toBe(false)
    expect(await covered(country, currency)).toBe(false)
  })

  test.each([['HK', 'HKD'], ['NZ', 'NZD'], ['GI', 'GIP']])(
    '%s in %s is a supported Stripe country outside the self-serve region and is covered by nothing',
    async (country, currency) => {
      expect(await inRoute('stripe_connect', country, currency)).toBe(false)
      expect(await covered(country, currency)).toBe(false)
    },
  )

  test('the momo row still has no BF or MW — no transfer code exists for either', async () => {
    expect(await inRoute('flutterwave_momo', 'BF', 'XOF')).toBe(false)
    expect(await inRoute('flutterwave_momo', 'MW', 'MWK')).toBe(false)
  })

  // -------------------------------------------------------------------------
  // 000006 — Flutterwave
  // -------------------------------------------------------------------------

  test('Ethiopia is on both Flutterwave rails in ETB — a transfer guide and the AMOLEMONEY code', async () => {
    expect(await inRoute('flutterwave_bank', 'ET', 'ETB')).toBe(true)
    expect(await inRoute('flutterwave_momo', 'ET', 'ETB')).toBe(true)
    expect(await covered('ET', 'ETB')).toBe(true)
  })

  test.each([
    ['KE', 'KES', 'not available by default — submit a request'],
    ['TZ', 'TZS', 'only available to businesses registered in Tanzania'],
    ['EG', 'EGP', 'not available by default — submit a request'],
  ])('%s in %s is off the Flutterwave bank row — "%s"', async (country, currency) => {
    expect(await inRoute('flutterwave_bank', country, currency)).toBe(false)
  })

  test('Kenya and Tanzania stay reachable by mobile money, so the corridor is still covered', async () => {
    expect(await inRoute('flutterwave_momo', 'KE', 'KES')).toBe(true)
    expect(await inRoute('flutterwave_momo', 'TZ', 'TZS')).toBe(true)
    expect(await covered('KE', 'KES')).toBe(true)
    expect(await covered('TZ', 'TZS')).toBe(true)
  })

  test('Egypt is covered by nothing — bank and wallet transfers are both request-only', async () => {
    expect(await inRoute('flutterwave_momo', 'EG', 'EGP')).toBe(false)
    expect(await covered('EG', 'EGP')).toBe(false)
  })

  test('the bank row says what it now means', async () => {
    const r = await row('flutterwave_bank')
    expect(r.note).toMatch(/submit a request/i)
    expect(r.note).toMatch(/registered in Tanzania/i)
    expect(r.note).toMatch(/mobile money/i)
  })

  // -------------------------------------------------------------------------
  // 000006 — Stripe
  // -------------------------------------------------------------------------

  test.each([
    ['BG', 'BGN'], ['CZ', 'CZK'], ['DK', 'DKK'], ['HU', 'HUF'],
    ['NO', 'NOK'], ['PL', 'PLN'], ['RO', 'RON'], ['SE', 'SEK'],
  ])('%s in %s joined the Stripe Connect row once the FX table could price it', async (country, currency) => {
    expect(await inRoute('stripe_connect', country, currency)).toBe(true)
    expect(await covered(country, currency)).toBe(true)
  })

  test.each([['HR', 'EUR'], ['LI', 'CHF']])(
    '%s in %s is back — 000004 pruned it as "not on the Express list", and Stripe\'s platform-country endpoint lists it with a full service agreement',
    async (country, currency) => {
      expect(await inRoute('stripe_connect', country, currency)).toBe(true)
      expect(await covered(country, currency)).toBe(true)
    },
  )

  test('the Stripe note carries the region rule and no longer claims Africa is unreachable', async () => {
    const r = await row('stripe_connect')
    expect(r.note).toMatch(/no self-serve route/i)
    expect(r.note).not.toMatch(/cannot reach/i)
    expect(r.note).toMatch(/United States, United Kingdom, EEA, Canada, and Switzerland/)
    expect(r.note).toMatch(/Contact sales/)
  })

  // -------------------------------------------------------------------------
  // Unchanged, and re-runnable
  // -------------------------------------------------------------------------

  test('the launch corridors are untouched', async () => {
    expect(await inRoute('flutterwave_momo', 'RW', 'RWF')).toBe(true)
    expect(await inRoute('flutterwave_bank', 'RW', 'RWF')).toBe(true)
    expect(await inRoute('stripe_connect', 'US', 'USD')).toBe(true)
    expect(await inRoute('stripe_connect', 'AE', 'AED')).toBe(true)
  })

  test('re-running the widening adds nothing twice', async () => {
    const n = async () => (await h.db.query<{ n: number }>(
      `select cardinality(countries) as n from payout_routes
        where tenant_id is null and payout_provider = 'stripe_connect'`,
    )).rows[0].n
    const before = await n()
    await h.db.query(
      `update payout_routes
          set countries = array(select distinct unnest(countries || array['AT','BE','HR','LI']::country_code[]))
        where tenant_id is null and payout_provider = 'stripe_connect'`,
    )
    expect(await n()).toBe(before)
  })

  test('re-running the removal removes nothing twice', async () => {
    const n = async () => (await h.db.query<{ n: number }>(
      `select cardinality(countries) as n from payout_routes
        where tenant_id is null and payout_provider = 'flutterwave_bank'`,
    )).rows[0].n
    const before = await n()
    await h.db.query(
      `update payout_routes
          set countries = array(select unnest(countries) except select unnest(array['KE','TZ','EG']::country_code[]))
        where tenant_id is null and payout_provider = 'flutterwave_bank'`,
    )
    expect(await n()).toBe(before)
  })
})
