/**
 * `GET /balance?live=1` — the fallback path's data contract.
 *
 * `balance/index.ts` is a Deno Edge Function (`Deno.serve`, `npm:` imports),
 * and this suite is vitest/PGlite, which is the split every other test file in
 * this repo already respects (`vitest.config.ts`'s header, `package.json`'s
 * `test:sql` vs `test:functions`). So this cannot invoke the handler itself —
 * there is no Deno runtime here, and no other test in this repository invokes
 * an Edge Function's `index.ts` directly. What it *can* verify against real
 * Postgres is the thing the handler's fallback path is built on: what
 * `record_reconciliation` actually leaves behind in `reconciliation_alerts`,
 * because that table (not a mock, not an assumption) is where a failed live
 * call has to look for "the most recent provider balance already stored by
 * reconciliation for that rail+currency".
 *
 * Two things are pinned:
 *
 *   1. The real, sometimes-surprising shape of what gets stored — in
 *      particular that a rail which has never drifted has *no row at all*,
 *      which is exactly the case the header comment on `balance/index.ts`
 *      calls out as something the dashboard cannot tell apart from "never
 *      checked".
 *   2. That the selection rule `lastRecordedBalances` implements —
 *      `coalesce(resolved_at, last_seen_at)`, most recent wins, isolated by
 *      `(tenant_id, provider, currency)` — is correct against rows a second,
 *      independent tenant's history cannot leak into.
 *
 * Tests assert deltas and freshly-created rows scoped to their own tenant,
 * never absolute counts, because other files in this suite (and this one, run
 * alongside them) share one PGlite instance per file but tenants are created
 * fresh per test.
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

const record = (
  tenant: string,
  ledger: number,
  provider_balance: number,
  currency = 'USD',
  rail = 'stripe',
) =>
  h.db.query(
    `select record_reconciliation($1, $2::provider, $3::currency_code, $4, $5, null)`,
    [tenant, rail, currency, ledger, provider_balance],
  )

interface AlertRow {
  currency: string
  provider_balance: number
  last_seen_at: string
  resolved_at: string | null
}

/** Every historical row for one rail+currency, oldest first. */
const alertsFor = async (
  tenant: string,
  provider = 'stripe',
  currency = 'USD',
): Promise<AlertRow[]> => {
  const { rows } = await h.db.query<AlertRow>(
    `select currency, provider_balance, last_seen_at, resolved_at
       from reconciliation_alerts
      where tenant_id = $1 and provider = $2::provider and currency = $3::currency_code
      order by detected_at asc`,
    [tenant, provider, currency],
  )
  return rows
}

/**
 * The exact selection rule `lastRecordedBalances` (`balance/index.ts`) applies
 * in application code: "when was this figure recorded" is
 * `coalesce(resolved_at, last_seen_at)`, and the newest one wins. Reimplemented
 * here — rather than imported, since the source is a Deno module this Node
 * test runner cannot load — so the algorithm itself is exercised against rows
 * a real migration and a real function produced.
 */
function pickLatest(rows: AlertRow[]): { amount: number; as_of: string } | null {
  let best: { amount: number; as_of: string } | null = null
  for (const row of rows) {
    const asOf = row.resolved_at ?? row.last_seen_at
    if (!best || new Date(asOf) > new Date(best.as_of)) {
      best = { amount: row.provider_balance, as_of: asOf }
    }
  }
  return best
}

describe('what reconciliation actually stores', () => {
  test('a rail that has never drifted leaves no row at all', async () => {
    const tenant = await newTenant()

    await record(tenant, 100_000, 100_000, 'USD', 'stripe')

    const rows = await alertsFor(tenant, 'stripe', 'USD')
    expect(rows).toEqual([])
    // This is the gap `balance/index.ts`'s header names explicitly: a
    // perfectly healthy rail and a rail nobody has ever checked are the same
    // "no stored figure" to a caller of `lastRecordedBalances`.
  })

  test('a drift opens one row, and a repeated drift updates it rather than duplicating it', async () => {
    const tenant = await newTenant()

    await record(tenant, 100_000, 90_000, 'USD', 'stripe')
    let rows = await alertsFor(tenant, 'stripe', 'USD')
    expect(rows).toHaveLength(1)
    expect(rows[0].provider_balance).toBe(90_000)
    expect(rows[0].resolved_at).toBeNull()

    await record(tenant, 100_000, 85_000, 'USD', 'stripe')
    rows = await alertsFor(tenant, 'stripe', 'USD')
    expect(rows).toHaveLength(1)
    expect(rows[0].provider_balance).toBe(85_000)
    expect(rows[0].resolved_at).toBeNull()
  })

  test('balances agreeing again resolves the row rather than deleting it, and a later drift opens a new one', async () => {
    const tenant = await newTenant()

    await record(tenant, 100_000, 90_000, 'USD', 'stripe') // opens
    await record(tenant, 100_000, 100_000, 'USD', 'stripe') // resolves

    let rows = await alertsFor(tenant, 'stripe', 'USD')
    expect(rows).toHaveLength(1)
    expect(rows[0].resolved_at).not.toBeNull()
    expect(rows[0].provider_balance).toBe(100_000)

    await record(tenant, 100_000, 70_000, 'USD', 'stripe') // opens a second case

    rows = await alertsFor(tenant, 'stripe', 'USD')
    expect(rows).toHaveLength(2)
    expect(rows[0].resolved_at).not.toBeNull() // the old, closed case
    expect(rows[1].resolved_at).toBeNull() // the new, open one
    expect(rows[1].provider_balance).toBe(70_000)
  })
})

describe('picking the most recently recorded figure', () => {
  test('an open case is picked by last_seen_at', async () => {
    const tenant = await newTenant()
    await record(tenant, 100_000, 90_000, 'USD', 'stripe')

    const rows = await alertsFor(tenant, 'stripe', 'USD')
    const picked = pickLatest(rows)
    expect(picked).not.toBeNull()
    expect(picked!.amount).toBe(90_000)
    expect(picked!.as_of).toBe(rows[0].last_seen_at)
  })

  test('a resolved case that is newer than an older open-looking record still wins', async () => {
    const tenant = await newTenant()

    // Two full drift/resolve cycles, each producing its own historical row.
    await record(tenant, 100_000, 90_000, 'USD', 'stripe')
    await record(tenant, 100_000, 100_000, 'USD', 'stripe') // resolves case 1
    await record(tenant, 100_000, 60_000, 'USD', 'stripe') // opens case 2
    await record(tenant, 100_000, 100_000, 'USD', 'stripe') // resolves case 2

    const rows = await alertsFor(tenant, 'stripe', 'USD')
    expect(rows).toHaveLength(2)

    const picked = pickLatest(rows)
    expect(picked).not.toBeNull()
    // Both cases resolved back to the true ledger figure; the point is that
    // picking "most recent" does not accidentally prefer row order or the
    // larger drift over the actual timestamp.
    expect(picked!.amount).toBe(100_000)
    expect(picked!.as_of).toBe(rows[1].resolved_at)
  })

  test('a currency with no history returns nothing to fall back to', async () => {
    const tenant = await newTenant()
    await record(tenant, 100_000, 90_000, 'USD', 'stripe')

    // A different currency on the same rail, never recorded.
    const rows = await alertsFor(tenant, 'stripe', 'RWF')
    expect(pickLatest(rows)).toBeNull()
  })

  test('rows are isolated by tenant, provider and currency', async () => {
    const tenantA = await newTenant()
    const tenantB = await newTenant()

    await record(tenantA, 100_000, 90_000, 'USD', 'stripe')
    await record(tenantB, 500_000, 400_000, 'USD', 'stripe')
    // Same tenant, different rail, same currency — must not be picked up by
    // the stripe query, and must not corrupt the flutterwave one either.
    await record(tenantA, 200_000, 150_000, 'USD', 'flutterwave')
    // Same tenant and rail, different currency — must not be picked up by USD.
    await record(tenantA, 300_000, 250_000, 'RWF', 'stripe')

    const aStripeUsd = await alertsFor(tenantA, 'stripe', 'USD')
    expect(aStripeUsd).toHaveLength(1)
    expect(aStripeUsd[0].provider_balance).toBe(90_000)

    const bStripeUsd = await alertsFor(tenantB, 'stripe', 'USD')
    expect(bStripeUsd).toHaveLength(1)
    expect(bStripeUsd[0].provider_balance).toBe(400_000)

    const aStripeRwf = await alertsFor(tenantA, 'stripe', 'RWF')
    expect(aStripeRwf).toHaveLength(1)
    expect(aStripeRwf[0].provider_balance).toBe(250_000)

    const aFlutterwaveUsd = await alertsFor(tenantA, 'flutterwave', 'USD')
    expect(aFlutterwaveUsd).toHaveLength(1)
    expect(aFlutterwaveUsd[0].provider_balance).toBe(150_000)

    // A cell nobody ever wrote to (tenant B never touched flutterwave) stays
    // truly empty rather than picking up someone else's row.
    const bFlutterwaveUsd = await alertsFor(tenantB, 'flutterwave', 'USD')
    expect(bFlutterwaveUsd).toHaveLength(0)
  })
})

describe('rail_balances() supplies the (provider, currency) identities atRail anchors on', () => {
  test('a rail and currency with no ledger activity at all does not appear', async () => {
    const tenant = await newTenant()

    const { rows } = await h.db.query<{ provider: string; currency: string }>(
      `select provider::text, currency::text from rail_balances($1)`,
      [tenant],
    )
    expect(rows).toEqual([])
    // This is the case `atRailForRail` documents as contributing nothing on a
    // failed live call: no ledger row anywhere for this tenant means no
    // (provider, currency) identity to hang a fallback row on, live-call
    // failure or not.
  })
})
