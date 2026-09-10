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
  railLabel,
  railRoute,
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

/**
 * The rail behind each `payout.methods` entry — `RAIL_KIND` read backwards.
 * `methods` is a list of kinds because that is the vocabulary a payout form
 * speaks; registration takes the rail, so a test crossing the two needs this.
 */
const KIND_RAIL: Record<string, string> = {
  momo: 'flutterwave_momo',
  bank: 'flutterwave_bank',
  connect: 'stripe_connect',
  paypal: 'paypal',
}

/**
 * What the two handlers now put in `payout_route` — the same three checks
 * `register` makes, then the route built for the rail that passed them.
 */
async function describedRoute(rail: string, country: Country, currency: Currency) {
  await register(rail, country, currency)
  return railRoute(rail, country, payoutRoute(country, currency))
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
    expect(err.message).toMatch(/^Stripe payouts are not available in Rwanda\./)
    expect(err.message).toMatch(/via Flutterwave/)
    expect(err.message).toMatch(/other payout methods offered for Rwanda/)
    expect(err.message).not.toMatch(/payment-options|GET \//)
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
    expect(err.message).toMatch(/^PayPal payouts are not available in Rwanda\./)
    expect(await methodsFor('RW', 'RWF')).not.toContain('paypal')
  })

  test('a rail nobody declared is still refused before anything is tokenized', async () => {
    const err = await refusal(() => register('card', 'US', 'USD'))
    expect(err.message).toMatch(/^That is not a payout method we offer\./)
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
      expect(err.message).toMatch(
        new RegExp(`^${railLabel(rail)} payouts are not available in the United States\\.`),
      )
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
      expect(err.message).toMatch(/^PayPal payouts are not available in the United States\./)
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

/**
 * The other half of the same widening, found on the response side.
 *
 * `POST /v1/sellers` and `POST /v1/sellers/:id/destinations` both answered with
 * `payout_route: payoutRoute(country, currency)` — the corridor's single
 * *preferred* rail — whatever rail the caller had just registered a destination
 * on. That was one fact wearing two names while a market had one live payout
 * rail, and stopped being one the day PayPal's row was enabled: a US host
 * registering PayPal was handed `provider: 'stripe'`, `kind: 'connect'` and a
 * sentence about a bank account, describing a route their money will not travel
 * on. `railRoute` is the fix, and what it must not do is disturb the preferred
 * case — so both halves are pinned here.
 */
describe('payout_route describes the destination that was registered', () => {
  test('a US seller registering PayPal is described by PayPal, not by Stripe Connect', async () => {
    const route = await describedRoute('paypal', 'US', 'USD')
    expect(route.provider).toBe('paypal')
    expect(route.kind).toBe('paypal')
    expect(route.currency).toBe('USD')
    expect(route.blocked).toBe(false)
    expect(route.reason).toBe('Paid in USD to a PayPal account in United States.')
    // The reported symptom, stated as the thing that must not come back.
    expect(route.reason).not.toMatch(/Stripe/)
    // And nothing about the ranking moved: Stripe is still what the corridor
    // prefers and still what a seller who says nothing gets.
    expect(payoutRoute('US', 'USD').provider).toBe('stripe')
  })

  test('the preferred rail still gets the corridor\'s own route, unchanged', async () => {
    // The common case by a wide margin, and the one a rewrite could quietly
    // reword. It is the same object, not merely the same shape.
    expect(await describedRoute('stripe_connect', 'US', 'USD')).toEqual(payoutRoute('US', 'USD'))
  })

  test('a Rwandan seller on the bank rail is described as a bank account, not a wallet', async () => {
    // Two rails, one adapter: `kind` is what separates them, and it is exactly
    // what the corridor's route gets wrong for the second of them. RW prefers
    // the wallet because it has one.
    expect(payoutRoute('RW', 'RWF').kind).toBe('momo')

    const route = await describedRoute('flutterwave_bank', 'RW', 'RWF')
    expect(route.provider).toBe('flutterwave')
    expect(route.kind).toBe('bank')
    expect(route.reason).toBe('Paid in RWF via Flutterwave, to a bank account in Rwanda.')

    expect(await describedRoute('flutterwave_momo', 'RW', 'RWF')).toEqual(payoutRoute('RW', 'RWF'))
  })

  test('a Kenyan seller paid in USD on PayPal is described in USD on PayPal', async () => {
    // Eligibility is per (country, currency), and so is the description: the
    // currency the destination was registered in is the one it is paid in.
    const route = await describedRoute('paypal', 'KE', 'USD')
    expect(route.provider).toBe('paypal')
    expect(route.kind).toBe('paypal')
    expect(route.currency).toBe('USD')
    expect(route.reason).toBe('Paid in USD to a PayPal account in Kenya.')
  })

  test('every method payment-options offers is described by itself', async () => {
    // The property the four cases above are instances of, and the one that
    // catches a rail added later: nothing a client may register is described
    // as something else. `methods` and `kind` are the two lists that have to
    // agree, so this crosses them.
    for (const [country, currency] of [
      ['US', 'USD'],
      ['RW', 'RWF'],
      ['KE', 'KES'],
      ['KE', 'USD'],
      ['GB', 'GBP'],
      ['AD', 'EUR'],
    ] as [Country, Currency][]) {
      for (const kind of await methodsFor(country, currency)) {
        const route = await describedRoute(KIND_RAIL[kind], country, currency)
        expect(route.kind, `${KIND_RAIL[kind]} in ${country}/${currency}`).toBe(kind)
        expect(route.currency, `${KIND_RAIL[kind]} in ${country}/${currency}`).toBe(currency)
        expect(route.blocked).toBe(false)
        expect(route.provider).not.toBeNull()
      }
    }
  })
})
