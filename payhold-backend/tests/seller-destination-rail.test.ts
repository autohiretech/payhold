/**
 * The rail a destination claims has to be one its corridor is actually paid on.
 *
 * A Rwandan seller in production held a `stripe_connect` primary tokenized by
 * Flutterwave — `Card •••• 4538`, country `RW` — and every payout against it
 * was `blocked` with "stripe_connect cannot pay a destination in RW". The row
 * was written because `POST /sellers/:id/destinations` checked only
 * `route.blocked`, and RW/RWF is not blocked; it is Flutterwave's.
 *
 * The handler itself runs under `Deno.serve` behind a Supabase client, so it
 * is not importable here. What is pinned instead is the pure half it now calls:
 * `RAIL_ADAPTER`, checked against the seeded `payout_routes` rows rather than
 * against a copy of itself, and `assertRailOnRoute` on the corridors that
 * matter — the one that leaked and the ones that must keep working.
 *
 * **`assertRailOnRoute` gained a fourth argument on 2026-09-10** — the
 * corridor's `route_evaluation` rows — and the reason is the whole of
 * `rail-adapter.ts`'s second header: it used to compare the rail's adapter
 * against `payoutRoute().provider`, the single *preferred* adapter, which
 * refused any other enabled rail the table carries. That was invisible while
 * every market had one live payout rail and stopped being invisible the day
 * PayPal's 88 markets were switched on. The refusals below are unchanged;
 * `tests/paypal-alongside-stripe.test.ts` is what pins the acceptances that
 * check used to get wrong.
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { migrated, type Harness } from './harness'
import { payoutRoute } from '../supabase/functions/_shared/rails'
import { PayHoldError, type Country, type Currency } from '../supabase/functions/_shared/types'
import {
  assertRailOnRoute,
  RAIL_ADAPTER,
  railAdapterFor,
  railRow,
} from '../supabase/functions/sellers/rail-adapter'

let h: Harness
let tenant: string

beforeAll(async () => {
  h = await migrated()
  const { rows: [t] } = await h.db.query<{ id: string }>(
    `insert into tenants (name, slug) values ('Rail Co', 'rail-co') returning id`,
  )
  tenant = t.id
})

afterAll(() => h.close())

/** The platform table's verdict for a corridor — what the handler reads. */
async function rails(country: Country, currency: Currency): Promise<unknown> {
  const { rows } = await h.db.query(
    `select * from route_evaluation($1, $2, $3, 0, null::payout_provider)`,
    [tenant, country, currency],
  )
  return rows
}

function refusal(fn: () => void): PayHoldError {
  try {
    fn()
  } catch (err) {
    if (err instanceof PayHoldError) return err
    throw new Error(`threw, but not a PayHoldError: ${(err as Error).message}`)
  }
  throw new Error('accepted, but should have been refused')
}

describe('RAIL_ADAPTER is the routing table\'s own rail → adapter column', () => {
  test('every platform route agrees with the map, and the map names nothing else', async () => {
    // `payout_routes.provider` is the one place SQL writes this relationship
    // down, and `20260807000011` made it not null so the declared-and-disabled
    // rails still name their adapter. If either side gains a rail the other
    // does not know, this is where it shows.
    const { rows } = await h.db.query<{ payout_provider: string; provider: string }>(
      `select payout_provider::text, provider::text
         from payout_routes where tenant_id is null
        order by payout_provider`,
    )
    const seeded = Object.fromEntries(rows.map((r) => [r.payout_provider, r.provider]))
    expect(seeded).toEqual(RAIL_ADAPTER)
  })

  test('a string that is not a rail has no adapter', () => {
    // The body is untrusted JSON; the enum that would refuse `card` sits after
    // the tokenize call, which is too late to be the first line of defence.
    expect(railAdapterFor('card')).toBeNull()
    expect(railAdapterFor('stripe')).toBeNull()
  })

  test('route_evaluation names the same adapter the map does, rail by rail', async () => {
    // The comparison `assertRailOnRoute` now makes. It reads the adapter off
    // the rail's own row rather than off the corridor's preferred one, so the
    // two sides of that comparison are pinned here rather than assumed.
    const rows = await rails('US', 'USD')
    for (const rail of Object.keys(RAIL_ADAPTER)) {
      expect(railRow(rows, rail)?.provider, rail).toBe(RAIL_ADAPTER[rail as keyof typeof RAIL_ADAPTER])
    }
  })
})

describe('§5.1 — a destination may only claim a rail its corridor is paid on', () => {
  test('stripe_connect for RW is refused, naming the corridor', async () => {
    const route = payoutRoute('RW', 'RWF')
    // Not blocked — that is the whole point. The old guard let this through.
    expect(route.blocked).toBe(false)
    expect(route.provider).toBe('flutterwave')

    const rows = await rails('RW', 'RWF')
    const err = refusal(() => assertRailOnRoute('stripe_connect', 'RW', route, rows))
    expect(err.code).toBe('policy_violation')
    // The opening words are `route_payout`'s, so the sentence a seller saw on
    // their Earnings page is the one the client now sees at registration.
    expect(err.message).toMatch(/^stripe_connect cannot pay a destination in RW\./)
    expect(err.message).toMatch(/via Flutterwave/)
    expect(err.message).toMatch(/other payout methods offered for Rwanda/)
    expect(err.message).not.toMatch(/payment-options|GET \//)
  })

  test('flutterwave_momo for RW is still accepted', async () => {
    const rows = await rails('RW', 'RWF')
    expect(() => assertRailOnRoute('flutterwave_momo', 'RW', payoutRoute('RW', 'RWF'), rows))
      .not.toThrow()
  })

  test('flutterwave_bank for RW is still accepted', async () => {
    // Both Flutterwave rails ride the same adapter; the guard is about the
    // rail's own row in the table, not about momo versus bank.
    const rows = await rails('RW', 'RWF')
    expect(() => assertRailOnRoute('flutterwave_bank', 'RW', payoutRoute('RW', 'RWF'), rows))
      .not.toThrow()
  })

  test('stripe_connect for US is still accepted', async () => {
    const route = payoutRoute('US', 'USD')
    expect(route.provider).toBe('stripe')
    const rows = await rails('US', 'USD')
    expect(() => assertRailOnRoute('stripe_connect', 'US', route, rows)).not.toThrow()
  })

  test('flutterwave_momo for US is refused the same way round', async () => {
    // The mirror image of the production row: a rail whose table row does not
    // carry the corridor, in a market another rail does pay.
    const rows = await rails('US', 'USD')
    const err = refusal(() => assertRailOnRoute('flutterwave_momo', 'US', payoutRoute('US', 'USD'), rows))
    expect(err.code).toBe('policy_violation')
    expect(err.message).toMatch(/^flutterwave_momo cannot pay a destination in US\./)
  })

  test('a rail nobody declared is refused before anything is tokenized', async () => {
    const rows = await rails('RW', 'RWF')
    const err = refusal(() => assertRailOnRoute('card', 'RW', payoutRoute('RW', 'RWF'), rows))
    expect(err.code).toBe('policy_violation')
    expect(err.message).toMatch(/is not a payout method PayHold knows/)
  })

  test('no rows at all fails closed', () => {
    // `route_evaluation` judges every declared rail, so an empty answer is a
    // corridor nothing carries rather than a question nobody asked.
    const err = refusal(() => assertRailOnRoute('flutterwave_momo', 'RW', payoutRoute('RW', 'RWF'), []))
    expect(err.message).toMatch(/^flutterwave_momo cannot pay a destination in RW\./)
  })

  test('a table row naming a different adapter from the map is refused as a fault', () => {
    // Neither side is trustworthy alone: `loadProvider` is asked for the map's
    // adapter and `route_payout` will send on the row's. A disagreement is
    // refused rather than resolved in favour of either.
    const rows = [{ payout_provider: 'paypal', provider: 'stripe', reason_code: 'eligible' }]
    const err = refusal(() => assertRailOnRoute('paypal', 'US', payoutRoute('US', 'USD'), rows))
    expect(err.message).toMatch(/carried by stripe in the routing table but PayHold mints/)
  })
})
