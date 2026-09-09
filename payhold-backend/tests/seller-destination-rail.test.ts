/**
 * The rail a destination claims has to be the one its corridor is paid on.
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
 * against a copy of itself, and `assertRailOnRoute` on the three corridors
 * that matter — the one that leaked and the two that must keep working.
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { migrated, type Harness } from './harness'
import { payoutRoute } from '../supabase/functions/_shared/rails'
import { PayHoldError } from '../supabase/functions/_shared/types'
import {
  assertRailOnRoute,
  RAIL_ADAPTER,
  railAdapterFor,
} from '../supabase/functions/sellers/rail-adapter'

let h: Harness

beforeAll(async () => {
  h = await migrated()
})

afterAll(() => h.close())

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
})

describe('§5.1 — a destination may only claim the rail its corridor is paid on', () => {
  test('stripe_connect for RW is refused, naming the corridor', () => {
    const route = payoutRoute('RW', 'RWF')
    // Not blocked — that is the whole point. The old guard let this through.
    expect(route.blocked).toBe(false)
    expect(route.provider).toBe('flutterwave')

    const err = refusal(() => assertRailOnRoute('stripe_connect', 'RW', route))
    expect(err.code).toBe('policy_violation')
    // The opening words are `route_payout`'s, so the sentence a seller saw on
    // their Earnings page is the one the client now sees at registration.
    expect(err.message).toMatch(/^stripe_connect cannot pay a destination in RW\./)
    expect(err.message).toMatch(/via Flutterwave/)
    expect(err.message).toMatch(/payment-options\?payout_country=RW/)
  })

  test('flutterwave_momo for RW is still accepted', () => {
    expect(() => assertRailOnRoute('flutterwave_momo', 'RW', payoutRoute('RW', 'RWF')))
      .not.toThrow()
  })

  test('flutterwave_bank for RW is still accepted', () => {
    // Both Flutterwave rails ride the same adapter; the guard is about the
    // adapter the token was minted on, not about momo versus bank.
    expect(() => assertRailOnRoute('flutterwave_bank', 'RW', payoutRoute('RW', 'RWF')))
      .not.toThrow()
  })

  test('stripe_connect for US is still accepted', () => {
    const route = payoutRoute('US', 'USD')
    expect(route.provider).toBe('stripe')
    expect(() => assertRailOnRoute('stripe_connect', 'US', route)).not.toThrow()
  })

  test('flutterwave_momo for US is refused the same way round', () => {
    // The mirror image of the production row: a rail whose adapter cannot
    // reach the corridor, in a market Stripe does pay.
    const err = refusal(() => assertRailOnRoute('flutterwave_momo', 'US', payoutRoute('US', 'USD')))
    expect(err.code).toBe('policy_violation')
    expect(err.message).toMatch(/^flutterwave_momo cannot pay a destination in US\./)
  })

  test('a rail nobody declared is refused before anything is tokenized', () => {
    const err = refusal(() => assertRailOnRoute('card', 'RW', payoutRoute('RW', 'RWF')))
    expect(err.code).toBe('policy_violation')
    expect(err.message).toMatch(/is not a payout method PayHold knows/)
  })
})
