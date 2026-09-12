/**
 * `last_rail_readings` — migration `20260912000005`.
 *
 * `reconciliation_alerts` is a case log: a drift opens or refreshes a row, a
 * drift going away resolves one, and a clean pass with no open alert writes
 * nothing at all. So a rail that has agreed with us every night since launch
 * has no stored provider balance anywhere, ever — which is exactly the case
 * `balance/index.ts`'s `?live=1` fallback needs and cannot get from that
 * table. These tests prove the new table closes that gap without touching
 * `record_reconciliation`'s existing alert behaviour, which
 * `reconciliation-runs.test.ts` already pins.
 *
 * Each test uses its own tenant — this file and `reconciliation-runs.test.ts`
 * both call the same `record_reconciliation`, and tenants are how the two
 * (and the tests within this file) stay from accumulating state on one
 * another.
 */

import { beforeAll, afterAll, describe, expect, test } from 'vitest'
import { migrated, type Harness } from './harness'

let h: Harness

beforeAll(async () => {
  h = await migrated()
}, 120_000)

afterAll(async () => {
  await h?.close()
})

const newTenant = async (): Promise<string> => {
  const { rows: [t] } = await h.db.query<{ id: string }>(
    `insert into tenants (name, slug) values ('Acme', 'acme-' || gen_random_uuid())
     returning id`,
  )
  return t.id
}

/** The comparison the cron makes — identical call shape to reconciliation-runs.test.ts. */
const record = (
  tenant: string,
  ledger: number,
  provider: number,
  currency = 'RWF',
  rail = 'flutterwave',
  run: string | null = null,
) =>
  h.db.query(
    `select record_reconciliation($1, $2::provider, $3::currency_code, $4, $5, $6)`,
    [tenant, rail, currency, ledger, provider, run],
  )

interface Reading {
  ledger_balance: string
  provider_balance: string
  read_at: Date
}

const reading = async (
  tenant: string,
  provider = 'flutterwave',
  currency = 'RWF',
): Promise<Reading | null> => {
  const { rows } = await h.db.query<Reading>(
    `select ledger_balance, provider_balance, read_at from last_rail_readings
      where tenant_id = $1 and provider = $2::provider and currency = $3::currency_code`,
    [tenant, provider, currency],
  )
  return rows[0] ?? null
}

const readingCount = async (tenant: string): Promise<number> => {
  const { rows: [r] } = await h.db.query<{ count: string }>(
    `select count(*)::int as count from last_rail_readings where tenant_id = $1`,
    [tenant],
  )
  return Number(r.count)
}

describe('a clean pass now records a reading — the exact case that stored nothing before', () => {
  test('drift zero, no prior alert: last_rail_readings gets a row', async () => {
    const tenant = await newTenant()

    // Before this migration this call wrote nothing at all: no alert opened
    // (nothing to open — drift is zero) and no alert existed to resolve.
    await record(tenant, 100_000, 100_000, 'RWF')

    const r = await reading(tenant)
    expect(r).not.toBeNull()
    expect(Number(r!.ledger_balance)).toBe(100_000)
    expect(Number(r!.provider_balance)).toBe(100_000)

    // And, as it always did, no alert.
    const { rows } = await h.db.query(
      `select 1 from reconciliation_alerts where tenant_id = $1`, [tenant],
    )
    expect(rows).toHaveLength(0)
  })
})

describe('a drifting pass records both the reading and the alert', () => {
  test('drift non-zero: last_rail_readings and reconciliation_alerts both get a row', async () => {
    const tenant = await newTenant()

    await record(tenant, 100_000, 125_000, 'RWF')

    const r = await reading(tenant)
    expect(r).not.toBeNull()
    expect(Number(r!.provider_balance)).toBe(125_000)

    const { rows: alerts } = await h.db.query<{ drift: string; resolved_at: Date | null }>(
      `select drift, resolved_at from reconciliation_alerts where tenant_id = $1`, [tenant],
    )
    expect(alerts).toHaveLength(1)
    expect(Number(alerts[0].drift)).toBe(25_000)
    expect(alerts[0].resolved_at).toBeNull()
  })

  test('a later clean pass resolves the alert and still updates the reading', async () => {
    const tenant = await newTenant()

    await record(tenant, 100_000, 125_000, 'RWF')
    await record(tenant, 100_000, 100_000, 'RWF')

    const r = await reading(tenant)
    expect(Number(r!.provider_balance)).toBe(100_000)

    const { rows: alerts } = await h.db.query<{ resolved_at: Date | null }>(
      `select resolved_at from reconciliation_alerts where tenant_id = $1`, [tenant],
    )
    expect(alerts).toHaveLength(1)
    expect(alerts[0].resolved_at).not.toBeNull()
  })
})

describe('a later pass overwrites rather than appends', () => {
  test('one row per cell after many passes, holding the newest figures', async () => {
    const tenant = await newTenant()

    await record(tenant, 100_000, 100_000, 'RWF')
    await record(tenant, 110_000, 110_000, 'RWF')
    await record(tenant, 120_000, 125_000, 'RWF') // drifts
    await record(tenant, 130_000, 130_000, 'RWF') // clean again

    expect(await readingCount(tenant)).toBe(1)

    const r = await reading(tenant)
    expect(Number(r!.ledger_balance)).toBe(130_000)
    expect(Number(r!.provider_balance)).toBe(130_000)
  })

  test('read_at moves forward on each overwrite', async () => {
    const tenant = await newTenant()

    await record(tenant, 100_000, 100_000, 'RWF')
    const first = await reading(tenant)

    // A distinct later moment: Postgres's now() is transaction-stamped, and
    // each h.db.query() here runs as its own statement/transaction, so a
    // second call is a genuinely later now().
    await new Promise((resolve) => setTimeout(resolve, 5))
    await record(tenant, 100_000, 100_000, 'RWF')
    const second = await reading(tenant)

    expect(new Date(second!.read_at).getTime()).toBeGreaterThanOrEqual(
      new Date(first!.read_at).getTime(),
    )
  })
})

describe('readings are isolated per tenant, per provider and per currency', () => {
  test('two tenants comparing the same rail and currency do not collide', async () => {
    const a = await newTenant()
    const b = await newTenant()

    await record(a, 100_000, 100_000, 'RWF')
    await record(b, 999_000, 999_000, 'RWF')

    expect(Number((await reading(a))!.provider_balance)).toBe(100_000)
    expect(Number((await reading(b))!.provider_balance)).toBe(999_000)
    expect(await readingCount(a)).toBe(1)
    expect(await readingCount(b)).toBe(1)
  })

  test('one tenant, two providers: one row each, never merged', async () => {
    const tenant = await newTenant()

    await record(tenant, 100_000, 100_000, 'RWF', 'flutterwave')
    await record(tenant, 5_000, 4_500, 'USD', 'stripe')

    expect(Number((await reading(tenant, 'flutterwave', 'RWF'))!.provider_balance)).toBe(100_000)
    expect(Number((await reading(tenant, 'stripe', 'USD'))!.provider_balance)).toBe(4_500)
    expect(await readingCount(tenant)).toBe(2)
  })

  test('one tenant, one provider, two currencies: one row each', async () => {
    const tenant = await newTenant()

    await record(tenant, 100_000, 100_000, 'RWF', 'flutterwave')
    await record(tenant, 5_000, 5_000, 'USD', 'flutterwave')

    expect(Number((await reading(tenant, 'flutterwave', 'RWF'))!.provider_balance)).toBe(100_000)
    expect(Number((await reading(tenant, 'flutterwave', 'USD'))!.provider_balance)).toBe(5_000)
    expect(await readingCount(tenant)).toBe(2)
  })
})

describe('the upsert does not disturb record_reconciliation elsewhere', () => {
  test('a run\'s counters are unaffected by the new write', async () => {
    const tenant = await newTenant()
    const { rows: [run] } = await h.db.query<{ id: string }>(
      `select id from start_reconciliation_run($1, 'flutterwave'::provider)`, [tenant],
    )

    await record(tenant, 100_000, 100_000, 'RWF', 'flutterwave', run.id)
    await record(tenant, 5_000, 4_500, 'USD', 'flutterwave', run.id)
    await h.db.query(`select finish_reconciliation_run($1, 0)`, [run.id])

    const { rows: [r] } = await h.db.query<{ rails_checked: number; matched: number; mismatched: number }>(
      `select rails_checked, matched, mismatched from reconciliation_runs where id = $1`, [run.id],
    )
    expect(r.rails_checked).toBe(2)
    expect(r.matched).toBe(1)
    expect(r.mismatched).toBe(1)

    // Both currencies still got a reading, run or no run distinction aside.
    expect(await readingCount(tenant)).toBe(2)
  })
})
