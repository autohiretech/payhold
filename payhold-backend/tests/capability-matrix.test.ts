/**
 * Spec §9 and §12 — the capability matrix.
 *
 * §15's phase-3 acceptance criteria are three sentences and each is a suite
 * below: disabling a country in data removes it from both checkout and payout
 * selection with no redeploy; a provider outage disables only its own routes;
 * and unsupported combinations are documented rather than silently missing.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { migrated, rejects, type Harness } from './harness'

let h: Harness
let tenant: string
let other: string

beforeAll(async () => {
  h = await migrated()
  const { rows } = await h.db.query<{ id: string }>(
    `insert into tenants (name, slug) values
       ('Matrix Co', 'matrix-co'), ('Neighbour Co', 'neighbour-co')
     returning id`,
  )
  tenant = rows[0].id
  other = rows[1].id
})

afterAll(() => h.close())

beforeEach(async () => {
  await h.db.query(`delete from payment_markets`)
  await h.db.query(`delete from payout_routes where tenant_id is not null`)
  // The state the migrations actually leave, not a synthetic one. PayPal is
  // built as of `20260808000003` and deliberately still off — no signed
  // agreement — so a fixture that enabled everything implemented would be
  // testing a configuration that does not exist.
  await h.db.query(
    `update provider_capabilities
        set enabled = implemented and provider <> 'paypal'`,
  )
  await h.db.query(
    `update payout_routes r
        set enabled = exists (
          select 1 from provider_capabilities c
           where c.provider = r.provider and c.implemented and c.enabled)
      where r.tenant_id is null`,
  )
})

interface Verdict {
  payout_provider: string
  eligible: boolean
  reason_code: string
}

async function evaluate(
  scope: string,
  country: string,
  currency: string,
  rail: string,
): Promise<Verdict> {
  const { rows: [v] } = await h.db.query<Verdict>(
    `select payout_provider::text, eligible, reason_code
       from route_evaluation($1, $2, $3, 90000, $4::payout_provider)
      where preferred`,
    [scope, country, currency, rail],
  )
  return v
}

// ---------------------------------------------------------------------------
// §9 — each adapter declares its capabilities
// ---------------------------------------------------------------------------

describe('§9 — adapters declare what they can do', () => {
  test('every adapter the first release names has a row', async () => {
    const { rows } = await h.db.query<{ provider: string }>(
      `select provider::text from provider_capabilities order by provider::text`,
    )
    // §9's five, plus the demo rail that §12 requires work with zero keys.
    expect(rows.map((r) => r.provider).sort()).toEqual([
      'cash_app_pay',
      'china_wallet_partner',
      'fake',
      'flutterwave',
      'paypal',
      'stripe',
    ])
  })

  test('four are built and two are declared', async () => {
    const { rows } = await h.db.query<{ provider: string }>(
      `select provider::text from provider_capabilities
        where implemented order by provider::text`,
    )
    // `paypal` joined in `20260808000003` — `_shared/paypal.ts` exists and
    // `loadProvider` returns it, which is the whole claim `implemented` makes.
    expect(rows.map((r) => r.provider)).toEqual([
      'fake', 'flutterwave', 'paypal', 'stripe',
    ])
  })

  test('a built adapter is still not an enabled one', async () => {
    // The distinction the two columns exist for. PayPal has a class now and is
    // still off: no signed agreement, and §16 wants written payout confirmation
    // per market. Building the code is not the same act as turning the rail on,
    // and `implemented` moving must not drag `enabled` with it.
    const { rows } = await h.db.query<{ enabled: boolean }>(
      `select enabled from provider_capabilities where provider = 'paypal'`,
    )
    expect(rows[0].enabled).toBe(false)
  })

  test('nothing unbuilt can be switched on', async () => {
    // The structural half of "declared but disabled" — §29.3. A check
    // constraint rather than a convention, because a convention survives until
    // somebody edits a row whose header they did not read.
    await rejects(
      () =>
        h.db.query(
          `update provider_capabilities set enabled = true
            where provider = 'china_wallet_partner'`,
        ),
      /enabled_needs_an_implementation/,
    )
  })

  test('mobile money is Flutterwave\'s and no one else\'s', async () => {
    // The structural reason both adapters exist, stated as data so a caller can
    // ask rather than branch on the provider's name.
    const { rows } = await h.db.query<{ provider: string }>(
      `select provider::text from provider_capabilities
        where supports_mobile_money and implemented order by provider::text`,
    )
    expect(rows.map((r) => r.provider)).toEqual(['fake', 'flutterwave'])
  })
})

// ---------------------------------------------------------------------------
// §15 phase 3 — a provider outage disables only its own routes
// ---------------------------------------------------------------------------

describe('§15 phase 3 — an adapter going down takes only its own routes', () => {
  test('switching an adapter off blocks its rails and leaves the others', async () => {
    expect((await evaluate(tenant, 'RW', 'RWF', 'flutterwave_momo')).eligible).toBe(true)
    expect((await evaluate(tenant, 'US', 'USD', 'stripe_connect')).eligible).toBe(true)

    // One row, one field. No deploy.
    await h.db.query(
      `update provider_capabilities set enabled = false where provider = 'flutterwave'`,
    )

    const momo = await evaluate(tenant, 'RW', 'RWF', 'flutterwave_momo')
    expect(momo.eligible).toBe(false)
    expect(momo.reason_code).toBe('provider_unavailable')

    // Both Flutterwave rails, because the adapter is what went down.
    expect((await evaluate(tenant, 'RW', 'RWF', 'flutterwave_bank')).eligible).toBe(false)

    // And nobody else's.
    expect((await evaluate(tenant, 'US', 'USD', 'stripe_connect')).eligible).toBe(true)
  })

  test('an unavailable adapter reads differently from a disabled corridor', async () => {
    // Two facts an operator has to tell apart at 3am: "this rail cannot carry
    // anything right now" and "we switched this corridor off". Same sentence to
    // the seller, different next action for us.
    //
    // Venmo rides PayPal, which has a class as of `20260808000003` and is still
    // switched off commercially. Note that it reads the same as a rail with no
    // code at all: `route_evaluation` asks whether the adapter is *usable*, and
    // implemented-but-disabled and unbuilt are both "no" to that question. The
    // difference between them lives on the capability row, which is where an
    // operator reads it and where `enabled_needs_an_implementation` binds.
    expect((await evaluate(tenant, 'US', 'USD', 'venmo')).reason_code)
      .toBe('provider_unavailable')

    await h.db.query(
      `update payout_routes set enabled = false
        where tenant_id is null and payout_provider = 'flutterwave_momo'`,
    )
    expect((await evaluate(tenant, 'RW', 'RWF', 'flutterwave_momo')).reason_code)
      .toBe('provider_disabled')
  })

  test('a route cannot be enabled while its adapter is not live', async () => {
    // A check constraint cannot look at another table, which is why the Phase 5
    // version could only guard a null. This guards the real condition.
    await h.db.query(
      `update provider_capabilities set enabled = false where provider = 'stripe'`,
    )

    await rejects(
      () =>
        h.db.query(
          `insert into payout_routes (tenant_id, payout_provider, provider, method,
             countries, currencies, enabled, rank)
           values ($1, 'stripe_connect', 'stripe', 'bank_account',
                   array['US']::country_code[], array['USD']::currency_code[], true, 10)`,
          [tenant],
        ),
      /stripe has no live adapter/,
    )
  })

  test('every payout route names an adapter', async () => {
    // Phase 6 made `provider` not-null: whether a rail is built is one fact in
    // one place now, and a null was the old vocabulary for it.
    const { rows: [c] } = await h.db.query<{ n: string }>(
      `select count(*) as n from payout_routes where provider is null`,
    )
    expect(Number(c.n)).toBe(0)
  })

  test('one adapter may carry several rails', async () => {
    // Venmo destinations are reached through PayPal's API, and both Chinese
    // wallets through one partner. `payout_provider` names the rail;
    // `provider` names the adapter. Conflating them is what two enums avoid.
    const { rows } = await h.db.query<{ payout_provider: string }>(
      `select payout_provider::text from payout_routes
        where provider = 'paypal' and tenant_id is null
        order by payout_provider::text`,
    )
    expect(rows.map((r) => r.payout_provider)).toEqual(['paypal', 'venmo'])
  })
})

// ---------------------------------------------------------------------------
// §12 — a country can be disabled without a redeploy
// ---------------------------------------------------------------------------

describe('§12 — closing a market is a row', () => {
  test('a closed market blocks payout selection', async () => {
    expect((await evaluate(tenant, 'RW', 'RWF', 'flutterwave_momo')).eligible).toBe(true)

    await h.db.query(
      `insert into payment_markets (tenant_id, country, collect, payout, reason)
       values (null, 'RW', false, false, 'Suspended pending a licence review')`,
    )

    const closed = await evaluate(tenant, 'RW', 'RWF', 'flutterwave_momo')
    expect(closed.eligible).toBe(false)
    // Ahead of every rail reason: a closed market is closed whatever the rails
    // say, and it is the one an operator here can reverse in a minute.
    expect(closed.reason_code).toBe('market_closed')
  })

  test('collect and payout close independently', async () => {
    // A market can be one-way. Collecting from a country we cannot pay into is
    // the normal case for most of the world, and the reverse happens too.
    await h.db.query(
      `insert into payment_markets (tenant_id, country, collect, payout, reason)
       values (null, 'RW', true, false, 'Payouts paused; collection unaffected')`,
    )

    expect((await evaluate(tenant, 'RW', 'RWF', 'flutterwave_momo')).reason_code)
      .toBe('market_closed')

    const { rows: [m] } = await h.db.query<{ open: boolean }>(
      `select market_open($1, 'RW', 'collect') as open`, [tenant],
    )
    expect(m.open).toBe(true)
  })

  test('a market nobody has ruled on is open', async () => {
    // The overlay property. `payment_markets` is not a copy of the registry —
    // it holds deliberate departures from it, and absence means nothing was
    // decided rather than that everything is shut.
    const { rows: [m] } = await h.db.query<{ open: boolean }>(
      `select market_open($1, 'KE', 'payout') as open`, [tenant],
    )
    expect(m.open).toBe(true)

    const { rows: [c] } = await h.db.query<{ n: string }>(
      `select count(*) as n from closed_markets($1)`, [tenant],
    )
    expect(Number(c.n)).toBe(0)
  })

  test('a tenant closure replaces the platform default rather than joining it', async () => {
    await h.db.query(
      `insert into payment_markets (tenant_id, country, collect, payout, reason)
       values (null, 'RW', false, false, 'Platform: closed')`,
    )
    await h.db.query(
      `insert into payment_markets (tenant_id, country, collect, payout, reason)
       values ($1, 'RW', true, true, 'This tenant has its own licence')`,
      [tenant],
    )

    // The same rule `route_evaluation` applies to routes: more specific wins,
    // and it wins in both directions rather than only towards "closed".
    const { rows: [own] } = await h.db.query<{ open: boolean }>(
      `select market_open($1, 'RW', 'payout') as open`, [tenant],
    )
    expect(own.open).toBe(true)

    const { rows: [neighbour] } = await h.db.query<{ open: boolean }>(
      `select market_open($1, 'RW', 'payout') as open`, [other],
    )
    expect(neighbour.open).toBe(false)
  })

  test('a closure carries the reason, because somebody will ask', async () => {
    await h.db.query(
      `insert into payment_markets (tenant_id, country, collect, payout, reason)
       values (null, 'CN', false, false, 'No approved local structure yet — §5')`,
    )

    const { rows: [row] } = await h.db.query<{ reason: string }>(
      `select reason from closed_markets($1) where country = 'CN'`, [tenant],
    )
    expect(row.reason).toBe('No approved local structure yet — §5')
  })

  test('a closure with no reason is refused', async () => {
    // "Why can nobody in Kenya pay us" is a question somebody asks three months
    // after whoever switched it off has forgotten.
    await rejects(
      () =>
        h.db.query(
          `insert into payment_markets (tenant_id, country, collect, payout)
           values (null, 'KE', false, false)`,
        ),
      /reason/,
    )
  })

  test('reopening is the same row, removed', async () => {
    await h.db.query(
      `insert into payment_markets (tenant_id, country, collect, payout, reason)
       values (null, 'RW', false, false, 'Temporary')`,
    )
    expect((await evaluate(tenant, 'RW', 'RWF', 'flutterwave_momo')).eligible).toBe(false)

    await h.db.query(`delete from payment_markets where country = 'RW'`)
    expect((await evaluate(tenant, 'RW', 'RWF', 'flutterwave_momo')).eligible).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Reachability
// ---------------------------------------------------------------------------

describe('the matrix is readable and not writable', () => {
  test('a signed-in person can read the capabilities', async () => {
    // A tenant whose payout was refused needs to see that the rail is off
    // rather than guess. These are facts about our adapters, not tenant data.
    const { rows } = await h.db.query<{ allowed: boolean }>(
      `select has_table_privilege('authenticated', 'provider_capabilities', 'select') as allowed`,
    )
    expect(rows[0].allowed).toBe(true)
  })

  test('and cannot write either table', async () => {
    // The same rule as every other table: the absence of a write policy is the
    // control, and every write goes through a function holding the service role.
    for (const table of ['provider_capabilities', 'payment_markets', 'payout_routes']) {
      for (const verb of ['insert', 'update', 'delete']) {
        const { rows } = await h.db.query<{ allowed: boolean }>(
          `select has_table_privilege('authenticated', $1, $2) as allowed`,
          [table, verb],
        )
        expect(rows[0].allowed, `${verb} on ${table}`).toBe(false)
      }
    }
  })
})
