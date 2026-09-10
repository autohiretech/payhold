/**
 * Migrations 20260909000003, 000004 and 000006 — the routing table catches up
 * with the registry, is pruned to what the providers document, and then is
 * brought to exactly the corridors Stripe's and Flutterwave's own pages
 * support as this repository sends them.
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

type Row = {
  countries: string[]
  currencies: string[]
  cross_border_currencies: string[]
  note: string
}

async function row(rail: string): Promise<Row> {
  const { rows } = await h.db.query<Row>(
    `select countries::text[] as countries,
            currencies::text[] as currencies,
            cross_border_currencies::text[] as cross_border_currencies,
            note
       from payout_routes where tenant_id is null and payout_provider = $1`,
    [rail],
  )
  return rows[0]
}

const sorted = (xs: string[]) => [...xs].sort()

describe('payout_routes: widened to the registry, pruned, then matched to what the providers document (000003 → 000004 → 000006)', () => {
  // -------------------------------------------------------------------------
  // The end state, in full. A wrong row here is money collected that cannot
  // be paid out, so the whole array is pinned rather than a sample of it.
  // -------------------------------------------------------------------------

  test('flutterwave_bank carries exactly the corridors with an ungated transfer guide', async () => {
    const r = await row('flutterwave_bank')
    expect(sorted(r.countries)).toEqual(sorted(['RW', 'UG', 'GH', 'NG', 'ZA', 'ZM', 'CI', 'SN', 'CM', 'ET']))
    // USD joined in `20260910000010`, when the account holder confirmed with
    // Flutterwave that a bank account can be paid in dollars. It is the one
    // currency here that is not somebody's local money, which is exactly why
    // it also has to be in `cross_border_currencies` before it is ever
    // offered — carried and offered are two different columns.
    expect(sorted(r.currencies))
      .toEqual(sorted(['RWF', 'UGX', 'GHS', 'NGN', 'ZAR', 'ZMW', 'XOF', 'XAF', 'ETB', 'USD']))
    expect(r.cross_border_currencies).toEqual(['USD'])
  })

  test('the wallet gains no settlement currency when the bank does', async () => {
    // `20260910000010` confirmed the dollar corridor for **bank accounts**. A
    // mobile money wallet is denominated in its country's currency and there
    // is no dollar wallet to open, so this is not a gate waiting on a provider
    // — it is what the instrument is, and the wallet's array stays empty
    // permanently. Without this, the next person widening the bank rail could
    // reasonably widen the wallet beside it and strand every payout.
    const wallet = await row('flutterwave_momo')
    expect(wallet.cross_border_currencies).toEqual([])
    expect(wallet.currencies).not.toContain('USD')
  })

  test('flutterwave_momo carries exactly the markets the transfer table names a wallet code for', async () => {
    const r = await row('flutterwave_momo')
    expect(sorted(r.countries)).toEqual(sorted(['RW', 'KE', 'UG', 'TZ', 'GH', 'ZM', 'CI', 'SN', 'CM', 'ET', 'MW']))
    expect(sorted(r.currencies)).toEqual(sorted(['RWF', 'KES', 'UGX', 'TZS', 'GHS', 'ZMW', 'XOF', 'XAF', 'ETB', 'MWK']))
  })

  test('stripe_connect carries the seeded rows plus every supported country inside the self-serve region', async () => {
    const r = await row('stripe_connect')
    expect(sorted(r.countries)).toEqual(sorted([
      // seeded in 20260807000009
      'US', 'AE', 'GB', 'DE', 'FR', 'NL', 'IE', 'ES', 'IT', 'CA', 'AU',
      // 000003, kept by 000004: eurozone and Switzerland
      'AT', 'BE', 'CH', 'CY', 'EE', 'FI', 'GR', 'LT', 'LU', 'LV', 'MT', 'PT', 'SI', 'SK',
      // 000006: the non-euro EEA members, and the two 000004 pruned on a wrong reading
      'BG', 'CZ', 'DK', 'HU', 'NO', 'PL', 'RO', 'SE', 'HR', 'LI',
    ]))
    expect(sorted(r.currencies)).toEqual(sorted([
      'USD', 'AED', 'EUR', 'GBP', 'CAD', 'AUD', 'CHF',
      'BGN', 'CZK', 'DKK', 'HUF', 'NOK', 'PLN', 'RON', 'SEK',
    ]))
  })

  // -------------------------------------------------------------------------
  // 000003 and 000004 — still true after 000006
  // -------------------------------------------------------------------------

  test.each([
    ['BE', 'EUR'], ['AT', 'EUR'], ['SK', 'EUR'], ['PT', 'EUR'], ['CH', 'CHF'],
  ])('the Stripe Connect row carries %s in %s (supported country, self-serve region)', async (country, currency) => {
    expect(await inRoute('stripe_connect', country, currency)).toBe(true)
  })

  test.each([
    ['BR', 'BRL'], ['JP', 'JPY'], ['SG', 'SGD'], ['MX', 'MXN'],
  ])('%s in %s was widened and then pruned — outside the self-serve region, so the platform would have to be there', async (country, currency) => {
    expect(await inRoute('stripe_connect', country, currency)).toBe(false)
  })

  test('the Flutterwave bank row no longer carries BF in XOF', async () => {
    // Removed again by 20260910000002: the guide exists, the bank list does
    // not, so nothing can be registered there. See that migration.
    expect(await inRoute('flutterwave_bank', 'BF', 'XOF')).toBe(false)
  })

  test.each([
    // MW was here until 20260910000004 — its bank corridor is still pruned,
    // but the wallet reaches it now, so it is no longer unreachable.
    ['BJ', 'XOF'], ['ML', 'XOF'], ['TG', 'XOF'], ['CF', 'XAF'], ['GA', 'XAF'],
    ['SL', 'SLE'],
  ])('%s in %s was widened and then pruned — no transfer guide, request-only, or an undocumented currency code', async (country, currency) => {
    expect(await inRoute('flutterwave_bank', country, currency)).toBe(false)
    expect(await covered(country, currency)).toBe(false)
  })

  test.each([['HK', 'HKD'], ['NZ', 'NZD'], ['GI', 'GIP']])(
    '%s in %s is a supported Stripe country outside the self-serve region and is covered by nothing',
    async (country, currency) => {
      expect(await inRoute('stripe_connect', country, currency)).toBe(false)
      expect(await covered(country, currency)).toBe(false)
    },
  )

  test('the momo row still has no BF — no transfer code exists for it', async () => {
    expect(await inRoute('flutterwave_momo', 'BF', 'XOF')).toBe(false)
  })

  test('Malawi is paid by wallet and not by bank — the gate is on the bank only', async () => {
    // 20260910000004. The bank page's "not available by default — submit a
    // request" is current and applies to the bank destination; the MWK wallet
    // payout to AIRTELMW carries no such caveat in either doc tree.
    expect(await inRoute('flutterwave_momo', 'MW', 'MWK')).toBe(true)
    expect(await inRoute('flutterwave_bank', 'MW', 'MWK')).toBe(false)
    expect(await covered('MW', 'MWK')).toBe(true)
  })

  // -------------------------------------------------------------------------
  // 000006 — Flutterwave
  // -------------------------------------------------------------------------

  test('Ethiopia is on both Flutterwave rails in ETB — a transfer guide and the AMOLEMONEY code', async () => {
    expect(await inRoute('flutterwave_bank', 'ET', 'ETB')).toBe(true)
    expect(await inRoute('flutterwave_momo', 'ET', 'ETB')).toBe(true)
    expect(await covered('ET', 'ETB')).toBe(true)
  })

  test.each([
    ['KE', 'KES', 'not available by default — submit a request'],
    ['TZ', 'TZS', 'only available to businesses registered in Tanzania'],
    ['EG', 'EGP', 'not available by default — submit a request'],
  ])('%s in %s is off the Flutterwave bank row — "%s"', async (country, currency) => {
    expect(await inRoute('flutterwave_bank', country, currency)).toBe(false)
  })

  test('Kenya and Tanzania stay reachable by mobile money, so the corridor is still covered', async () => {
    expect(await inRoute('flutterwave_momo', 'KE', 'KES')).toBe(true)
    expect(await inRoute('flutterwave_momo', 'TZ', 'TZS')).toBe(true)
    expect(await covered('KE', 'KES')).toBe(true)
    expect(await covered('TZ', 'TZS')).toBe(true)
  })

  test('Egypt is covered by nothing — bank and wallet transfers are both request-only', async () => {
    expect(await inRoute('flutterwave_momo', 'EG', 'EGP')).toBe(false)
    expect(await covered('EG', 'EGP')).toBe(false)
  })

  test('the bank row says what it now means', async () => {
    const r = await row('flutterwave_bank')
    expect(r.note).toMatch(/submit a request/i)
    expect(r.note).toMatch(/registered in Tanzania/i)
    expect(r.note).toMatch(/mobile money/i)
    // `20260910000010` appended rather than rewrote, so the corridor caveats
    // above survive the dollar corridor being announced. A note that
    // replaced them would have traded researched detail for news.
    expect(r.note).toMatch(/Also pays in USD/)
  })

  // -------------------------------------------------------------------------
  // 000006 — Stripe
  // -------------------------------------------------------------------------

  test.each([
    ['BG', 'BGN'], ['CZ', 'CZK'], ['DK', 'DKK'], ['HU', 'HUF'],
    ['NO', 'NOK'], ['PL', 'PLN'], ['RO', 'RON'], ['SE', 'SEK'],
  ])('%s in %s joined the Stripe Connect row once the FX table could price it', async (country, currency) => {
    expect(await inRoute('stripe_connect', country, currency)).toBe(true)
    expect(await covered(country, currency)).toBe(true)
  })

  test.each([['HR', 'EUR'], ['LI', 'CHF']])(
    '%s in %s is back — 000004 pruned it as "not on the Express list", and Stripe\'s platform-country endpoint lists it with a full service agreement',
    async (country, currency) => {
      expect(await inRoute('stripe_connect', country, currency)).toBe(true)
      expect(await covered(country, currency)).toBe(true)
    },
  )

  test('the Stripe note carries the region rule and no longer claims Africa is unreachable', async () => {
    const r = await row('stripe_connect')
    expect(r.note).toMatch(/no self-serve route/i)
    expect(r.note).not.toMatch(/cannot reach/i)
    expect(r.note).toMatch(/United States, United Kingdom, EEA, Canada, and Switzerland/)
    expect(r.note).toMatch(/Contact sales/)
  })

  // -------------------------------------------------------------------------
  // Unchanged, and re-runnable
  // -------------------------------------------------------------------------

  test('the launch corridors are untouched', async () => {
    expect(await inRoute('flutterwave_momo', 'RW', 'RWF')).toBe(true)
    expect(await inRoute('flutterwave_bank', 'RW', 'RWF')).toBe(true)
    expect(await inRoute('stripe_connect', 'US', 'USD')).toBe(true)
    expect(await inRoute('stripe_connect', 'AE', 'AED')).toBe(true)
  })

  test('re-running the widening adds nothing twice', async () => {
    const n = async () => (await h.db.query<{ n: number }>(
      `select cardinality(countries) as n from payout_routes
        where tenant_id is null and payout_provider = 'stripe_connect'`,
    )).rows[0].n
    const before = await n()
    await h.db.query(
      `update payout_routes
          set countries = array(select distinct unnest(countries || array['AT','BE','HR','LI']::country_code[]))
        where tenant_id is null and payout_provider = 'stripe_connect'`,
    )
    expect(await n()).toBe(before)
  })

  // -------------------------------------------------------------------------
  // 20260910000003 — PayPal's own corridor, still switched off
  // -------------------------------------------------------------------------

  const PAYPAL_COUNTRIES = [
    'AU', 'AT', 'BE', 'BR', 'CA', 'CN', 'DK', 'FR', 'DE', 'HK', 'IL', 'IT',
    'JP', 'NL', 'NO', 'PL', 'PT', 'SG', 'ES', 'SE', 'CH', 'TR', 'GB', 'US',
    'CY', 'CZ', 'EC', 'FI', 'GR', 'HU', 'LI', 'LU', 'MY', 'MT', 'NZ', 'PH', 'SM', 'SI',
    'AD', 'AR', 'BS', 'BH', 'BW', 'BG', 'CL', 'CO', 'CR', 'HR', 'DO', 'SV',
    'EE', 'GE', 'GI', 'GT', 'HN', 'IS', 'ID', 'IE', 'JM', 'JO', 'KZ', 'KE',
    'KW', 'LV', 'LS', 'LT', 'MU', 'MD', 'MC', 'MA', 'MZ', 'NI', 'OM', 'PA',
    'PE', 'QA', 'RO', 'SA', 'SN', 'RS', 'SK', 'ZA', 'AE', 'UY', 'VE', 'VN',
    'IN', 'MX',
  ]
  const PAYPAL_CURRENCIES = [
    'AUD', 'BRL', 'CAD', 'CHF', 'CNY', 'CZK', 'DKK', 'EUR', 'GBP',
    'HUF', 'JPY', 'MXN', 'NOK', 'PLN', 'SEK', 'SGD', 'USD',
  ]

  test('the paypal row carries PayPal\'s own receive-and-withdraw markets, not Stripe\'s copied list', async () => {
    const r = await row('paypal')
    expect(sorted(r.countries)).toEqual(sorted(PAYPAL_COUNTRIES))
    expect(r.countries).toHaveLength(88)
    expect(sorted(r.currencies)).toEqual(sorted(PAYPAL_CURRENCIES))
    // The four tiers all grant a recipient receive-and-withdraw, so all four
    // are here — India and Mexico included, whose restriction is on sending.
    expect(r.countries).toContain('IN')
    expect(r.countries).toContain('MX')
    // Every currency has an FX rate behind it, the same rule 000006 applied.
    expect(r.currencies).not.toContain('HKD')
    expect(r.currencies).not.toContain('RUB')
  })

  test('the paypal row is switched on, and its adapter is what let it be', async () => {
    // `20260910000005`, at the account holder's instruction: §16's
    // signed-agreement gate was a policy refusal written into
    // `assert_route_has_live_provider`, and it is gone. What replaced it is
    // nothing — the row is enabled or disabled by its own flag now, like every
    // other rail — except the adapter check, which this row passes rather than
    // being waved through: PayPal is `implemented` and `enabled` in
    // `provider_capabilities`.
    const { rows: [r] } = await h.db.query<{ enabled: boolean; provider: string; note: string }>(
      `select enabled, provider, note from payout_routes
        where tenant_id is null and payout_provider = 'paypal'`,
    )
    expect(r.enabled).toBe(true)
    expect(r.provider).toBe('paypal')
    // The note says what the row is and what it does not promise: PayHold will
    // attempt these payouts, and whether PayPal accepts them depends on the
    // Payouts API being approved on the connected account.
    expect(r.note).toMatch(/Payouts API/i)
  })

  test('§17 is untouched — venmo and cash_app_pay still cannot be enabled at all', async () => {
    // The distinction the migration's header draws: §16 was a document waiting
    // to be signed and could be lifted; §17 is a rule about the instruments —
    // personal accounts may not receive marketplace payouts — and is not.
    for (const rail of ['venmo', 'cash_app_pay']) {
      await expect(h.db.query(
        `update payout_routes set enabled = true
          where tenant_id is null and payout_provider = $1`,
        [rail],
      )).rejects.toThrow(/personal accounts only/i)
    }
  })

  test('a PayPal corridor routes now that the rail is on', async () => {
    // The row describes the corridor and the engine now carries it. Note US:
    // `route_evaluation` returns every rail with its verdict, so PayPal is
    // picked out by name rather than by rank — Stripe Connect is also eligible
    // there, and both being eligible at once is the point. A seller in a
    // market with two live rails may register on either, which is what
    // `sellers/rail-adapter.ts` was fixed to allow on 2026-09-10.
    for (const [country, currency] of [['IN', 'USD'], ['ID', 'USD'], ['US', 'USD']]) {
      const { rows } = await h.db.query<{ reason_code: string }>(
        `select reason_code from route_evaluation($1, $2, $3, 0, 'paypal')
          where payout_provider = 'paypal'`,
        [tenant, country, currency],
      )
      expect(rows, `${country}/${currency}`).toHaveLength(1)
      expect(rows[0].reason_code, `${country}/${currency}`).toBe('eligible')
    }

    // Indonesia is on PayPal's table and on no other rail. It went from
    // uncovered to covered the moment the row was enabled, which is the whole
    // of what switching the rail on bought.
    expect(await inRoute('paypal', 'ID', 'USD')).toBe(true)
    expect(await covered('ID', 'USD')).toBe(true)

    // And the currency arrays still bind: KE is on PayPal's country list and
    // KES is on nobody's priceable-currency list, so the corridor is refused
    // on the currency rather than the country. Eligibility is per pair.
    const { rows: ke } = await h.db.query<{ reason_code: string }>(
      `select reason_code from route_evaluation($1, 'KE', 'KES', 0, 'paypal')
        where payout_provider = 'paypal'`,
      [tenant],
    )
    expect(ke[0].reason_code).toBe('currency_not_supported')
  })

  test('venmo and cash_app_pay remain unroutable, and permanently so', async () => {
    // The two reason codes differ and are meant to: Venmo's adapter is live
    // (it rides PayPal's) and its *route* is off, which is `provider_disabled`;
    // Cash App Pay has no adapter at all, which is `provider_unavailable`.
    // Same sentence to the seller, different next action for us.
    for (const [rail, code] of [
      ['venmo', 'provider_disabled'],
      ['cash_app_pay', 'provider_unavailable'],
    ]) {
      const { rows: [r] } = await h.db.query<{ enabled: boolean }>(
        `select enabled from payout_routes
          where tenant_id is null and payout_provider = $1`,
        [rail],
      )
      expect(r.enabled, rail).toBe(false)

      await expect(h.db.query(
        `update payout_routes set enabled = true
          where tenant_id is null and payout_provider = $1`,
        [rail],
      )).rejects.toThrow(/personal accounts only/i)

      const { rows } = await h.db.query<{ reason_code: string }>(
        `select reason_code from route_evaluation($1, 'US', 'USD', 0, $2)
          where payout_provider = $2`,
        [tenant, rail],
      )
      expect(rows, rail).toHaveLength(1)
      expect(rows[0].reason_code, rail).toBe(code)
    }
  })

  test('re-running the removal removes nothing twice', async () => {
    const n = async () => (await h.db.query<{ n: number }>(
      `select cardinality(countries) as n from payout_routes
        where tenant_id is null and payout_provider = 'flutterwave_bank'`,
    )).rows[0].n
    const before = await n()
    await h.db.query(
      `update payout_routes
          set countries = array(select unnest(countries) except select unnest(array['KE','TZ','EG']::country_code[]))
        where tenant_id is null and payout_provider = 'flutterwave_bank'`,
    )
    expect(await n()).toBe(before)
  })
})
