/**
 * `overageFor` — the one piece of installment billing that is pure enough to
 * test without a database. `balanceFigures` and `settle_deal_balance` (the
 * SQL side) are covered in `tests/migrations.test.ts`, against a real
 * Postgres, because they need FX and settings that only exist there.
 */

import { assertEquals } from 'jsr:@std/assert@1'
import { clampOverage, overageFor } from './figures.ts'
import type { Deal } from './types.ts'

/** Just enough of `Deal` for `overageFor`, which reads four fields only. */
function deal(fields: Partial<Deal>): Deal {
  return {
    overage_rate: null,
    overage_unit_seconds: null,
    expected_complete_at: null,
    ...fields,
  } as Deal
}

Deno.test('no rate set — always zero, whatever the time', () => {
  const d = deal({ expected_complete_at: '2026-01-01T00:00:00Z' })
  assertEquals(overageFor(d, new Date('2026-06-01T00:00:00Z')), 0)
})

Deno.test('no expected_complete_at — always zero, even with a rate set', () => {
  const d = deal({ overage_rate: 500, overage_unit_seconds: 3600 })
  assertEquals(overageFor(d, new Date()), 0)
})

Deno.test('on time — zero', () => {
  const d = deal({
    overage_rate: 500,
    overage_unit_seconds: 3600,
    expected_complete_at: '2026-01-01T12:00:00Z',
  })
  assertEquals(overageFor(d, new Date('2026-01-01T11:00:00Z')), 0)
  assertEquals(overageFor(d, new Date('2026-01-01T12:00:00Z')), 0)
})

Deno.test('a started unit is a whole unit — hourly', () => {
  const d = deal({
    overage_rate: 500,
    overage_unit_seconds: 3600,
    expected_complete_at: '2026-01-01T12:00:00Z',
  })
  // One second late still owes a full hour, the way a rental desk rounds.
  assertEquals(overageFor(d, new Date('2026-01-01T12:00:01Z')), 500)
  // Exactly one hour late: exactly one unit, not two.
  assertEquals(overageFor(d, new Date('2026-01-01T13:00:00Z')), 500)
  // One second into the second hour: two units.
  assertEquals(overageFor(d, new Date('2026-01-01T13:00:01Z')), 1_000)
})

Deno.test('daily unit works the same way, at its own scale', () => {
  const d = deal({
    overage_rate: 5_000,
    overage_unit_seconds: 86_400,
    expected_complete_at: '2026-01-01T00:00:00Z',
  })
  assertEquals(overageFor(d, new Date('2026-01-02T00:00:00Z')), 5_000)
  assertEquals(overageFor(d, new Date('2026-01-03T12:00:00Z')), 15_000)
})

Deno.test('clampOverage: no override at all leaves the computed number alone', () => {
  assertEquals(clampOverage(15_000, undefined), 15_000)
  assertEquals(clampOverage(15_000, null), 15_000)
})

Deno.test('clampOverage: a smaller override wins', () => {
  assertEquals(clampOverage(15_000, 5_000), 5_000)
})

Deno.test('clampOverage: zero waives the charge entirely', () => {
  assertEquals(clampOverage(15_000, 0), 0)
})

Deno.test('clampOverage: a bigger override has no effect — it can only reduce', () => {
  assertEquals(clampOverage(5_000, 50_000), 5_000)
})

Deno.test('clampOverage: a negative override floors at zero rather than adding money', () => {
  assertEquals(clampOverage(5_000, -1_000), 0)
})

Deno.test('clampOverage: a non-numeric value (bad metadata) is ignored, not thrown', () => {
  assertEquals(clampOverage(15_000, 'nope'), 15_000)
})
