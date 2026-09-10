/**
 * A destination may only be registered on a rail the routing table carries
 * for its country — and on a corridor the adapter can actually send on.
 *
 * `tests/seller-destination-rail.test.ts` pins the second of three checks a
 * new destination passes (`assertRailOnRoute`: is the rail's adapter the
 * corridor's adapter). This file pins the third and the one beside it:
 *
 *   `assertRailSwitchedOn`      does `route_evaluation` — the engine
 *                               `route_payout` will consult when the money is
 *                               due, tenant override included — say this rail
 *                               is on for this country?
 *   `assertRailRequirementsMet` can the adapter build the transfer at all, or
 *                               does the corridor want fields PayHold does not
 *                               collect (ZA bank), or a fact about the tenant
 *                               it cannot know (TZ bank)?
 *
 * Without the first, a Kenyan seller could register `flutterwave_bank` the day
 * the KE bank row is pruned (Flutterwave gates Kenyan bank transfers behind a
 * request): the registry still says Kenya is payable and Flutterwave is still
 * the adapter, so the other two checks pass, and the payout is `blocked` with
 * the buyer's money held. The same hole `8c3386e` closed for Stripe Connect
 * in Rwanda, one layer down.
 *
 * Every route row here is a **tenant override**, so these assertions hold
 * whatever the platform defaults say — another migration is reshaping those
 * rows the same day, and a tenant row replaces the platform's for its rail
 * (`route_evaluation`'s `distinct on`). The handler runs under `Deno.serve`
 * and cannot be imported; `RouteEvaluator` is the slice of a Supabase client
 * it hands the check, and PGlite answers it with the identical SQL.
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { migrated, type Harness } from './harness'
import { PayHoldError } from '../supabase/functions/_shared/types'
import {
  assertRailRequirementsMet,
  assertRailSwitchedOn,
  railVerdict,
  type RouteEvaluator,
} from '../supabase/functions/sellers/rail-adapter'

let h: Harness
let tenant: string
let db: RouteEvaluator

beforeAll(async () => {
  h = await migrated()

  const { rows: [t] } = await h.db.query<{ id: string }>(
    `insert into tenants (name, slug) values ('Rail Gate Co', 'rail-gate-co') returning id`,
  )
  tenant = t.id

  // This tenant's own view of the table. `flutterwave_bank` reaches RW and NG
  // and nothing else; `flutterwave_momo` reaches RW and KE; `stripe_connect`
  // is switched off outright. None of it depends on a platform row.
  await h.db.query(
    `insert into payout_routes (tenant_id, payout_provider, provider, method,
       countries, currencies, enabled, rank, min_amount)
     values
       ($1, 'flutterwave_bank', 'flutterwave', 'bank_account',
        array['RW','NG']::country_code[], array['RWF','NGN']::currency_code[], true, 20, 1000),
       ($1, 'flutterwave_momo', 'flutterwave', 'mobile_money',
        array['RW','KE']::country_code[], array['RWF','KES']::currency_code[], true, 10, 0),
       ($1, 'stripe_connect', 'stripe', 'bank_account',
        array['US']::country_code[], array['USD']::currency_code[], false, 30, 0)`,
    [tenant],
  )

  // What `sellers/index.ts` hands the check, answered by the same function.
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

async function refusal(fn: () => Promise<void> | void): Promise<PayHoldError> {
  try {
    await fn()
  } catch (err) {
    if (err instanceof PayHoldError) return err
    throw new Error(`threw, but not a PayHoldError: ${(err as Error).message}`)
  }
  throw new Error('accepted, but should have been refused')
}

describe('assertRailSwitchedOn — the table, not the registry, says whether a rail pays a country', () => {
  test('flutterwave_bank for KE is refused when the bank row does not carry KE', async () => {
    const err = await refusal(() => assertRailSwitchedOn(db, tenant, 'flutterwave_bank', 'KE', 'KES'))
    expect(err.code).toBe('policy_violation')
    expect(err.message).toBe(
      'flutterwave_bank is not switched on for KE — ' +
        'Choose one of the other payout methods offered for Kenya.',
    )
  })

  test('the refusal names payment-options as the fix', async () => {
    const err = await refusal(() => assertRailSwitchedOn(db, tenant, 'flutterwave_bank', 'KE', 'KES'))
    // Points the host at their payout screen, never at an API path — this
    // message reaches a car owner verbatim in a toast.
    expect(err.message).toMatch(/other payout methods offered for Kenya/)
    expect(err.message).not.toMatch(/payment-options|GET \//)
  })

  test('flutterwave_momo for RW is accepted', async () => {
    await expect(assertRailSwitchedOn(db, tenant, 'flutterwave_momo', 'RW', 'RWF')).resolves.toBeUndefined()
  })

  test('flutterwave_momo for KE is accepted — M-Pesa is the corridor Kenya keeps', async () => {
    await expect(assertRailSwitchedOn(db, tenant, 'flutterwave_momo', 'KE', 'KES')).resolves.toBeUndefined()
  })

  test('flutterwave_bank for RW is accepted, and a route minimum does not count against a registration', async () => {
    // The bank row carries `min_amount = 1000`; the check asks with amount 0,
    // so the verdict is `below_route_minimum` — a corridor a seller can be set
    // up in, exactly as `payment-options` reads it.
    await expect(assertRailSwitchedOn(db, tenant, 'flutterwave_bank', 'RW', 'RWF')).resolves.toBeUndefined()
  })

  test('a rail the tenant switched off is refused even where the platform may carry it', async () => {
    const err = await refusal(() => assertRailSwitchedOn(db, tenant, 'stripe_connect', 'US', 'USD'))
    expect(err.message).toMatch(/^stripe_connect is not switched on for US/)
  })

  test('a currency the row does not carry is refused', async () => {
    const err = await refusal(() => assertRailSwitchedOn(db, tenant, 'flutterwave_bank', 'RW', 'USD'))
    expect(err.message).toMatch(/^flutterwave_bank is not switched on for RW/)
  })

  test('country is compared case-insensitively and the sentence uses the upper-case code', async () => {
    await expect(assertRailSwitchedOn(db, tenant, 'flutterwave_momo', 'rw', 'rwf')).resolves.toBeUndefined()
    const err = await refusal(() => assertRailSwitchedOn(db, tenant, 'flutterwave_bank', 'ke', 'kes'))
    expect(err.message).toMatch(/^flutterwave_bank is not switched on for KE/)
  })

  test('a database error is a fault, not a refusal', async () => {
    const broken: RouteEvaluator = {
      rpc: async () => ({ data: null, error: { message: 'connection lost' } }),
    }
    await expect(assertRailSwitchedOn(broken, tenant, 'flutterwave_momo', 'RW', 'RWF'))
      .rejects.toThrow(/route_evaluation failed: connection lost/)
  })
})

describe('railVerdict — the pure judgement', () => {
  test('eligible and the two amount reasons are on; everything else is off', () => {
    const rows = [
      { payout_provider: 'flutterwave_momo', reason_code: 'eligible' },
      { payout_provider: 'flutterwave_bank', reason_code: 'below_route_minimum' },
      { payout_provider: 'stripe_connect', reason_code: 'above_route_maximum' },
      { payout_provider: 'paypal', reason_code: 'provider_disabled' },
      { payout_provider: 'venmo', reason_code: 'country_not_supported' },
    ]
    expect(railVerdict(rows, 'flutterwave_momo').on).toBe(true)
    expect(railVerdict(rows, 'flutterwave_bank').on).toBe(true)
    expect(railVerdict(rows, 'stripe_connect').on).toBe(true)
    expect(railVerdict(rows, 'paypal')).toEqual({ on: false, reason_code: 'provider_disabled' })
    expect(railVerdict(rows, 'venmo')).toEqual({ on: false, reason_code: 'country_not_supported' })
  })

  test('no row for the rail fails closed', () => {
    expect(railVerdict([], 'flutterwave_bank')).toEqual({ on: false, reason_code: null })
    expect(railVerdict(null, 'flutterwave_bank').on).toBe(false)
    expect(railVerdict([{ payout_provider: 'flutterwave_momo', reason_code: 'eligible' }], 'flutterwave_bank').on)
      .toBe(false)
  })
})

describe('assertRailRequirementsMet — corridors the adapter cannot send on', () => {
  test('flutterwave_bank for ZA is refused, quoting the fields Flutterwave requires', () => {
    const err = (() => {
      try {
        assertRailRequirementsMet('flutterwave_bank', 'ZA')
      } catch (e) {
        return e as PayHoldError
      }
      throw new Error('accepted')
    })()
    expect(err).toBeInstanceOf(PayHoldError)
    expect(err.code).toBe('policy_violation')
    expect(err.message).toBe(
      'flutterwave_bank cannot pay a bank account in ZA yet. ' +
        "Flutterwave requires the recipient's first name, last name, email, mobile number " +
        'and address on every South African bank transfer, and PayHold does not collect ' +
        'an email or address yet. ' +
        'Choose one of the other payout methods offered for South Africa.',
    )
  })

  test('flutterwave_bank for TZ is refused, quoting the registration restriction', () => {
    expect(() => assertRailRequirementsMet('flutterwave_bank', 'TZ')).toThrow(
      'flutterwave_bank cannot pay a bank account in TZ yet. ' +
        'Flutterwave pays Tanzanian bank accounts only for businesses registered in Tanzania. ' +
        'Choose one of the other payout methods offered for Tanzania.',
    )
  })

  test('lower-case codes are the same refusal', () => {
    expect(() => assertRailRequirementsMet('flutterwave_bank', 'za')).toThrow(/in ZA yet/)
  })

  test('mobile money in those countries is untouched', () => {
    expect(() => assertRailRequirementsMet('flutterwave_momo', 'TZ')).not.toThrow()
    expect(() => assertRailRequirementsMet('flutterwave_momo', 'ZA')).not.toThrow()
  })

  test('bank accounts elsewhere are untouched', () => {
    expect(() => assertRailRequirementsMet('flutterwave_bank', 'RW')).not.toThrow()
    expect(() => assertRailRequirementsMet('flutterwave_bank', 'NG')).not.toThrow()
    expect(() => assertRailRequirementsMet('flutterwave_bank', 'KE')).not.toThrow()
    expect(() => assertRailRequirementsMet('stripe_connect', 'ZA')).not.toThrow()
  })
})
