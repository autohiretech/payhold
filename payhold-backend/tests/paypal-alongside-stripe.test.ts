/**
 * PayPal is a rail a market may *also* be paid on, not only where nothing else
 * reaches.
 *
 * Reported 2026-09-10 by a host in the United States: choosing PayPal as a
 * payout method was refused with "PayPal isn't a way to get paid in this
 * market yet — try Mobile Money or Bank instead." PayPal's route row had been
 * enabled hours earlier (`20260910000005`) carrying 88 countries including US
 * and 17 currencies including USD, and `GET /v1/payment-options?payout_country=US`
 * was already listing it. What refused it was `assertRailOnRoute`, comparing
 * the rail's adapter against `payoutRoute().provider` — the **one preferred**
 * adapter for the corridor, which for the US is Stripe. Every market had
 * exactly one live payout rail until that migration, so "the preferred
 * adapter" and "the only adapter" had never been different things.
 *
 * What this file pins is the shape that replaced it: a rail is registerable
 * when the routing table carries it for that country **and** currency, whether
 * or not it is the one PayHold would have picked. `payoutRoute`'s ordering is
 * untouched and PayPal is still last in it — it decides the default, and
 * nobody already paid on a local rail moves onto PayPal.
 *
 * Every row here is the **platform** table as the migrations seed it, with no
 * tenant override, because the report is about what the shipped table does.
 * `tests/seller-rail-gate.test.ts` is the tenant-override counterpart.
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { migrated, type Harness } from './harness'
import { payoutRoute } from '../supabase/functions/_shared/rails'
import { payoutMethods } from '../supabase/functions/_shared/payout-methods'
import { PayHoldError, type Country, type Currency } from '../supabase/functions/_shared/types'
import {
  assertRailOnRoute,
  assertRailSwitchedOnRows,
  evaluateRails,
  type RouteEvaluator,
} from '../supabase/functions/sellers/rail-adapter'

let h: Harness
let tenant: string
let db: RouteEvaluator

beforeAll(async () => {
  h = await migrated()

  const { rows: [t] } = await h.db.query<{ id: string }>(
    `insert into tenants (name, slug) values ('Alongside Co', 'alongside-co') returning id`,
  )
  tenant = t.id

  db = {
    async rpc(fn, args) {
      expect(fn).toBe('route_evaluation')
      const { rows } = await h.db.query(
        `select * from route_evaluation($1, $2, $3, $4, $5::payout_provider)`,
        [args.p_tenant, args.p_country, args.p_currency, args.p_amount, args.p_rail],
      )
      return { data: rows, error: null }
    },
  }
})

afterAll(() => h.close())

/** The three checks `POST /v1/sellers` makes, in the order it makes them. */
async function register(rail: string, country: Country, currency: Currency): Promise<void> {
  const route = payoutRoute(country, currency)
  if (route.blocked) throw new PayHoldError('policy_violation', route.reason)
  const rails = await evaluateRails(db, tenant, country, currency)
  assertRailOnRoute(rail, country, route, rails)
  assertRailSwitchedOnRows(rails, rail, country)
}

async function refusal(fn: () => Promise<void>): Promise<PayHoldError> {
  try {
    await fn()
  } catch (err) {
    if (err instanceof PayHoldError) return err
    throw new Error(`threw, but not a PayHoldError: ${(err as Error).message}`)
  }
  throw new Error('accepted, but should have been refused')
}

/** What `GET /v1/payment-options?payout_country=` would put in `payout.methods`. */
async function methodsFor(country: Country, currency: Currency): Promise<string[]> {
  const route = payoutRoute(country, currency)
  if (route.blocked) return []
  return payoutMethods(await evaluateRails(db, tenant, country, currency), route.kind)
}

describe('the reported bug — a United States host choosing PayPal', () => {
  test('payoutRoute still prefers Stripe for the US, and that is correct', () => {
    // Unchanged on purpose. The fix is not to re-rank the rails: preferring a
    // wallet over a corridor that already works would reroute sellers who are
    // being paid perfectly well today.
    const route = payoutRoute('US', 'USD')
    expect(route.provider).toBe('stripe')
    expect(route.kind).toBe('connect')
    expect(route.blocked).toBe(false)
  })

  test('a US seller may register paypal — it is enabled and routable for US/USD', async () => {
    await expect(register('paypal', 'US', 'USD')).resolves.toBeUndefined()
  })

  test('a US seller may still register stripe_connect', async () => {
    await expect(register('stripe_connect', 'US', 'USD')).resolves.toBeUndefined()
  })

  test('payment-options offers both, preferred first', async () => {
    const methods = await methodsFor('US', 'USD')
    expect(methods).toContain('connect')
    expect(methods).toContain('paypal')
    // `kind` sorts first and is the whole of its authority over this list.
    expect(methods[0]).toBe('connect')
  })

  test('what payment-options offers is exactly what registration accepts', async () => {
    // The two answers disagreeing is the bug, stated as a property rather than
    // as one market's expected list.
    const KIND_RAIL: Record<string, string> = {
      momo: 'flutterwave_momo',
      bank: 'flutterwave_bank',
      connect: 'stripe_connect',
      paypal: 'paypal',
    }
    for (const [country, currency] of [
      ['US', 'USD'],
      ['RW', 'RWF'],
      ['KE', 'KES'],
      ['GB', 'GBP'],
    ] as [Country, Currency][]) {
      for (const kind of await methodsFor(country, currency)) {
        await expect(
          register(KIND_RAIL[kind], country, currency),
          `${KIND_RAIL[kind]} is offered for ${country}/${currency} and must be registerable`,
        ).resolves.toBeUndefined()
      }
    }
  })
})

describe('the Rwanda incident is refused by exactly the same sentence as before', () => {
  test('a Rwandan seller still may not register stripe_connect', async () => {
    // `Card •••• 4538`, country RW, `payout_provider = 'stripe_connect'`, and
    // every payout against it blocked. RW/RWF is not a blocked corridor — it
    // is Flutterwave's — so `route.blocked` never caught this and the rail
    // check is the whole of the defence.
    const err = await refusal(() => register('stripe_connect', 'RW', 'RWF'))
    expect(err.code).toBe('policy_violation')
    expect(err.message).toMatch(/^stripe_connect cannot pay a destination in RW\./)
    expect(err.message).toMatch(/via Flutterwave/)
    expect(err.message).toMatch(/payment-options\?payout_country=RW/)
  })

  test('a Rwandan seller may still register their own rails', async () => {
    await expect(register('flutterwave_momo', 'RW', 'RWF')).resolves.toBeUndefined()
    await expect(register('flutterwave_bank', 'RW', 'RWF')).resolves.toBeUndefined()
  })

  test('RW is not on PayPal\'s list, so paypal is refused there too', async () => {
    // Not a gap in the fix — PayPal's own country table does not carry Rwanda,
    // and RWF is not a currency the FX table can price for the row either. A
    // rail the table does not carry is refused exactly as Stripe is.
    const err = await refusal(() => register('paypal', 'RW', 'RWF'))
    expect(err.message).toMatch(/^paypal cannot pay a destination in RW\./)
    expect(await methodsFor('RW', 'RWF')).not.toContain('paypal')
  })

  test('a rail nobody declared is still refused before anything is tokenized', async () => {
    const err = await refusal(() => register('card', 'US', 'USD'))
    expect(err.message).toMatch(/is not a payout method PayHold knows/)
  })
})

describe('eligibility is per (country, currency), not per country', () => {
  test('Kenya is on PayPal\'s country list but KES is not on its currency list', async () => {
    const { rows } = await h.db.query<{ reason_code: string }>(
      `select reason_code from route_evaluation($1, 'KE', 'KES', 0, 'paypal')
        where payout_provider = 'paypal'`,
      [tenant],
    )
    // The FX ceiling doing its job: the row's currencies are PayPal's own list
    // intersected with what `PER_USD` can price, and KES is in neither.
    expect(rows[0]?.reason_code).toBe('currency_not_supported')
    expect(await methodsFor('KE', 'KES')).toEqual(['momo'])
    await expect(refusal(() => register('paypal', 'KE', 'KES'))).resolves.toBeDefined()
  })

  test('a Kenyan seller paid in USD may register paypal — same country, priceable currency', async () => {
    expect(await methodsFor('KE', 'USD')).toContain('paypal')
    await expect(register('paypal', 'KE', 'USD')).resolves.toBeUndefined()
  })

  test('the Kenyan wallet is unaffected either way', async () => {
    await expect(register('flutterwave_momo', 'KE', 'KES')).resolves.toBeUndefined()
  })
})

describe('a rail whose route row is disabled is still refused', () => {
  test('venmo and cash_app_pay are permanently off, and neither is registerable in the US', async () => {
    // §17: personal-account instruments that may not receive a marketplace
    // payout. `assert_route_has_live_provider` raises on any attempt to enable
    // either row, so this refusal cannot be switched off by a table edit.
    for (const rail of ['venmo', 'cash_app_pay']) {
      const err = await refusal(() => register(rail, 'US', 'USD'))
      expect(err.code).toBe('policy_violation')
      expect(err.message).toMatch(new RegExp(`^${rail} cannot pay a destination in US\\.`))
    }
    const methods = await methodsFor('US', 'USD')
    expect(methods).toEqual(['connect', 'paypal'])
  })

  test('the trigger still refuses to enable them', async () => {
    await expect(
      h.db.query(
        `update payout_routes set enabled = true
          where tenant_id is null and payout_provider = 'venmo'`,
      ),
    ).rejects.toThrow(/personal accounts only/)
  })

  test('switching the platform paypal row off puts the US back to Stripe alone', async () => {
    await h.db.query(
      `update payout_routes set enabled = false
        where tenant_id is null and payout_provider = 'paypal'`,
    )
    try {
      const err = await refusal(() => register('paypal', 'US', 'USD'))
      expect(err.message).toMatch(/^paypal cannot pay a destination in US\./)
      expect(await methodsFor('US', 'USD')).toEqual(['connect'])
      // And the rail the market is actually preferred on is untouched by it.
      await expect(register('stripe_connect', 'US', 'USD')).resolves.toBeUndefined()
    } finally {
      await h.db.query(
        `update payout_routes set enabled = true
          where tenant_id is null and payout_provider = 'paypal'`,
      )
    }
  })
})

describe('a market only PayPal reaches', () => {
  test('Andorra pays by PayPal alone, and paypal is what payoutRoute prefers there', async () => {
    // The case PayPal was ranked last *for*: neither local rail reaches AD, so
    // the wallet is the difference between a payout and none. Nothing about
    // this behaviour changed — it is here so the fix cannot be read as having
    // moved PayPal's position in the ranking.
    const route = payoutRoute('AD', 'EUR')
    expect(route.provider).toBe('paypal')
    expect(await methodsFor('AD', 'EUR')).toEqual(['paypal'])
    await expect(register('paypal', 'AD', 'EUR')).resolves.toBeUndefined()
    await expect(refusal(() => register('stripe_connect', 'AD', 'EUR'))).resolves.toBeDefined()
  })
})
