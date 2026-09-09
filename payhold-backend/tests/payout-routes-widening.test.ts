/**
 * Migration 20260909000003 — the routing table catches up with the registry,
 * for the corridors the FX table can already price.
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

describe('payout_routes: widened to the registry, then pruned to what the providers document', () => {
  test.each([
    ['BE', 'EUR'], ['AT', 'EUR'], ['SK', 'EUR'], ['PT', 'EUR'], ['CH', 'CHF'],
  ])('the Stripe Connect row carries %s in %s (Express list, self-serve region)', async (country, currency) => {
    expect(await inRoute('stripe_connect', country, currency)).toBe(true)
  })

  test.each([
    ['HR', 'EUR'], ['LI', 'CHF'], ['BR', 'BRL'], ['JP', 'JPY'], ['SG', 'SGD'], ['MX', 'MXN'],
  ])('%s in %s was widened and then pruned — not on the Express list, or outside the self-serve region', async (country, currency) => {
    expect(await inRoute('stripe_connect', country, currency)).toBe(false)
  })

  test('the Flutterwave bank row carries BF in XOF — the one added corridor with a transfer guide', async () => {
    expect(await inRoute('flutterwave_bank', 'BF', 'XOF')).toBe(true)
  })

  test.each([
    ['BJ', 'XOF'], ['ML', 'XOF'], ['TG', 'XOF'], ['CF', 'XAF'], ['GA', 'XAF'],
    ['MW', 'MWK'], ['SL', 'SLE'],
  ])('%s in %s was widened and then pruned — no transfer guide, request-only, or an undocumented currency code', async (country, currency) => {
    expect(await inRoute('flutterwave_bank', country, currency)).toBe(false)
  })

  test.each([['PL', 'PLN'], ['SE', 'SEK'], ['HK', 'HKD'], ['NZ', 'NZD']])(
    '%s in %s was never added and is covered by nothing — its currency is not in the FX table',
    async (country, currency) => {
      expect(await inRoute('stripe_connect', country, currency)).toBe(false)
      expect(await covered(country, currency)).toBe(false)
    },
  )

  test('the momo row did not widen — no account_bank codes exist for BF or MW', async () => {
    expect(await inRoute('flutterwave_momo', 'BF', 'XOF')).toBe(false)
    expect(await inRoute('flutterwave_momo', 'MW', 'MWK')).toBe(false)
  })

  test('the launch corridors are untouched', async () => {
    expect(await inRoute('flutterwave_momo', 'RW', 'RWF')).toBe(true)
    expect(await inRoute('flutterwave_bank', 'RW', 'RWF')).toBe(true)
    expect(await inRoute('stripe_connect', 'US', 'USD')).toBe(true)
    expect(await inRoute('stripe_connect', 'AE', 'AED')).toBe(true)
  })

  test('the Stripe note no longer claims Africa is unreachable', async () => {
    const { rows } = await h.db.query<{ note: string }>(
      `select note from payout_routes where tenant_id is null and payout_provider = 'stripe_connect'`,
    )
    expect(rows[0].note).toMatch(/no self-serve route/i)
    expect(rows[0].note).not.toMatch(/cannot reach/i)
  })

  test('re-running the widening adds nothing twice', async () => {
    const n = async () => (await h.db.query<{ n: number }>(
      `select cardinality(countries) as n from payout_routes
        where tenant_id is null and payout_provider = 'stripe_connect'`,
    )).rows[0].n
    const before = await n()
    await h.db.query(
      `update payout_routes
          set countries = array(select distinct unnest(countries || array['AT','BE']::country_code[]))
        where tenant_id is null and payout_provider = 'stripe_connect'`,
    )
    expect(await n()).toBe(before)
  })
})
