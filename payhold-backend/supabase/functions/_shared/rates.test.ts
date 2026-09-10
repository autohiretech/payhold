/**
 * Run with: deno test --allow-env supabase/functions/_shared/rates.test.ts
 *
 * The property under test is a refusal, and it is the whole reason this module
 * exists: a tenant operating on real credentials must get a rate somebody
 * actually quoted, or an error. The failure this guards against is not a crash
 * — it is a deal created successfully at a rate out of a table nobody has
 * updated since August 2026, discovered weeks later as an unexplainable
 * difference between what was collected and what was owed.
 *
 * The one permitted exception is demo mode, and it is tested here beside the
 * refusal rather than somewhere else, so that widening it is a visible edit to
 * a file that says in its header why it must not be widened.
 *
 * `intercept` is `flutterwave.test.ts`'s, for the same reason it is there: the
 * request must be inspectable without leaving the machine.
 */

import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@1'
import { encryptCredentials } from './crypto.ts'
import { clearRateCache, liveRate } from './rates.ts'
import { PayHoldError } from './types.ts'
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'

/** A deterministic 32-byte key, so tests do not depend on the environment. */
const TEST_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)))

const TENANT = '11111111-1111-1111-1111-111111111111'

/** Capture the request without letting it leave. */
function intercept(response: unknown, status = 200) {
  const seen: { url?: string; authorization?: string; calls: number } = { calls: 0 }
  const original = globalThis.fetch

  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    seen.calls += 1
    seen.url = String(url)
    seen.authorization = new Headers(init?.headers).get('authorization') ?? undefined
    return Promise.resolve(
      new Response(JSON.stringify(response), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    )
  }) as typeof fetch

  return { seen, restore: () => { globalThis.fetch = original } }
}

/** Refuses to be called at all — for the paths that must touch no network. */
function noNetwork() {
  const original = globalThis.fetch
  globalThis.fetch = (() => {
    throw new Error('a rate was fetched on a path that must not fetch one')
  }) as typeof fetch
  return { restore: () => { globalThis.fetch = original } }
}

interface AccountRow {
  provider: string
  mode: string
  encrypted_credentials?: string
}

/**
 * Just enough of the query builder for the two reads this module makes:
 * `connectedRails`' un-terminated select (awaited directly, hence `then`) and
 * the single-row credential read.
 */
function fakeDb(accounts: AccountRow[]): SupabaseClient {
  const from = (table: string) => {
    let rows = table === 'tenant_provider_accounts' ? [...accounts] : []
    // deno-lint-ignore no-explicit-any
    const builder: any = {
      select: () => builder,
      eq: (column: string, value: unknown) => {
        if (column === 'provider') rows = rows.filter((r) => r.provider === value)
        return builder
      },
      maybeSingle: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
      // deno-lint-ignore no-explicit-any
      then: (resolve: any, reject: any) =>
        Promise.resolve({ data: rows, error: null }).then(resolve, reject),
    }
    return builder
  }

  return { from } as unknown as SupabaseClient
}

/** Their envelope for `GET /v3/transfers/rates`. */
function quote(sourceCurrency: string, destinationCurrency: string, rate: number) {
  return {
    status: 'success',
    message: 'Transfer amount fetched',
    data: {
      rate,
      source: { currency: sourceCurrency, amount: 1 },
      destination: { currency: destinationCurrency, amount: rate },
    },
  }
}

async function connectedTenant(): Promise<SupabaseClient> {
  Deno.env.set('CREDENTIALS_KEY', TEST_KEY)
  return fakeDb([{
    provider: 'flutterwave',
    mode: 'live',
    encrypted_credentials: await encryptCredentials({
      secret_key: 'FLWSECK-live-abc',
      public_key: 'FLWPUBK-live-abc',
      encryption_key: 'FLWSECKe1a2b3c4',
      webhook_hash: 'hash',
    }),
  }])
}

// ---------------------------------------------------------------------------
// The live rate is the one that prices the charge
// ---------------------------------------------------------------------------

Deno.test('a live rate is used, and asked for as a rate rather than a total', async () => {
  clearRateCache()
  const db = await connectedTenant()
  const { seen, restore } = intercept(quote('RWF', 'USD', 0.00069))

  try {
    const result = await liveRate(db, TENANT, 'RWF', 'USD')

    assertEquals(result.source, 'flutterwave')
    assertEquals(result.rate, 0.00069)

    // `amount=1` is what makes the answer a rate. Asking for the deal's own
    // amount would return a total, and the figure locked onto the deal has to
    // outlive that one amount.
    assert(seen.url?.includes('amount=1'), seen.url)
    assert(seen.url?.includes('source_currency=RWF'), seen.url)
    assert(seen.url?.includes('destination_currency=USD'), seen.url)
    // The tenant's own key, decrypted here and nowhere else.
    assertEquals(seen.authorization, 'Bearer FLWSECK-live-abc')
  } finally {
    restore()
  }
})

Deno.test('the rate is derived from the two named amounts, not their bare `rate`', async () => {
  // A bare number has no direction. When the amounts are there they say which
  // way round the corridor runs, and they win — a rate applied upside down
  // does not look wrong, it looks like a very good exchange.
  clearRateCache()
  const db = await connectedTenant()
  const { restore } = intercept({
    status: 'success',
    data: {
      rate: 1450, // the inverse, as if quoted the other way
      source: { currency: 'RWF', amount: 1000 },
      destination: { currency: 'USD', amount: 0.69 },
    },
  })

  try {
    const result = await liveRate(db, TENANT, 'RWF', 'USD')
    assertEquals(result.rate, 0.00069)
  } finally {
    restore()
  }
})

Deno.test('a reply about a different corridor is not an answer to our question', async () => {
  clearRateCache()
  const db = await connectedTenant()
  const { restore } = intercept(quote('KES', 'USD', 0.0077))

  try {
    await assertRejects(
      () => liveRate(db, TENANT, 'RWF', 'USD'),
      PayHoldError,
      'could not be read',
    )
  } finally {
    restore()
  }
})

Deno.test('a quoted rate is cached for the corridor rather than re-asked', async () => {
  clearRateCache()
  const db = await connectedTenant()
  const { seen, restore } = intercept(quote('RWF', 'EUR', 0.00064))

  try {
    await liveRate(db, TENANT, 'RWF', 'EUR')
    await liveRate(db, TENANT, 'RWF', 'EUR')
    assertEquals(seen.calls, 1)
  } finally {
    restore()
  }
})

Deno.test('the same currency both sides asks nobody anything', async () => {
  clearRateCache()
  const db = await connectedTenant()
  const { restore } = noNetwork()

  try {
    assertEquals(await liveRate(db, TENANT, 'RWF', 'RWF'), { rate: 1, source: 'identity' })
  } finally {
    restore()
  }
})

// ---------------------------------------------------------------------------
// Real credentials + no live rate = a refusal, never the table
// ---------------------------------------------------------------------------

Deno.test('a rail that refuses the quote refuses the deal — no table fallback', async () => {
  clearRateCache()
  const db = await connectedTenant()
  const { restore } = intercept({ status: 'error', message: 'Invalid currency pair' }, 400)

  try {
    const err = await assertRejects(
      () => liveRate(db, TENANT, 'RWF', 'USD'),
      PayHoldError,
      'Invalid currency pair',
    )
    // The point is not that it threw; it is that the indicative table's own
    // RWF→USD rate never reached the caller.
    assert(!String(err).includes('0.000714'))
  } finally {
    restore()
  }
})

Deno.test('an unreachable rail refuses too — not knowing is not a rate', async () => {
  clearRateCache()
  const db = await connectedTenant()
  const original = globalThis.fetch
  globalThis.fetch = (() => Promise.reject(new Error('connection timed out'))) as typeof fetch

  try {
    await assertRejects(
      () => liveRate(db, TENANT, 'RWF', 'USD'),
      PayHoldError,
      'will not price a charge against an indicative table',
    )
  } finally {
    globalThis.fetch = original
  }
})

Deno.test('a tenant on another rail alone is refused, not quietly given the table', async () => {
  // Stripe connected, Flutterwave not. This account is moving real money, so
  // the narrow reading — "no Flutterwave, so demo mode" — would put the
  // indicative table back on a live charge for exactly the tenants hardest to
  // notice it on.
  clearRateCache()
  const db = fakeDb([{ provider: 'stripe', mode: 'live', encrypted_credentials: 'v1.x.y' }])
  const { restore } = noNetwork()

  try {
    await assertRejects(
      () => liveRate(db, TENANT, 'RWF', 'USD'),
      PayHoldError,
      'has not connected Flutterwave',
    )
  } finally {
    restore()
  }
})

// ---------------------------------------------------------------------------
// Demo mode — the one place the table may still price something
// ---------------------------------------------------------------------------

Deno.test('a tenant with no connected rail falls back to the indicative table', async () => {
  // "Demo mode with zero keys must work end to end" — there is no credential
  // to quote with, and refusing would stop a fresh account creating its first
  // cross-border deal.
  clearRateCache()
  const db = fakeDb([])
  const { restore } = noNetwork()

  try {
    const result = await liveRate(db, TENANT, 'USD', 'RWF')
    assertEquals(result.source, 'payhold_indicative')
    assertEquals(result.rate, 1400)
  } finally {
    restore()
  }
})

Deno.test('demo mode still refuses a corridor the table has no rate for', async () => {
  clearRateCache()
  const db = fakeDb([])
  const { restore } = noNetwork()

  try {
    await assertRejects(
      () => liveRate(db, TENANT, 'USD', 'XXX'),
      PayHoldError,
      'No exchange rate is available',
    )
  } finally {
    restore()
  }
})

Deno.test('a table rate is never cached into a real tenant\'s answer', async () => {
  // Demo first, then a connected tenant on the same corridor. If the demo
  // answer had been cached, the second call would return it wearing
  // `flutterwave` as its source — the silent fallback, laundered.
  clearRateCache()
  const demo = noNetwork()
  try {
    assertEquals((await liveRate(fakeDb([]), TENANT, 'USD', 'RWF')).source, 'payhold_indicative')
  } finally {
    demo.restore()
  }

  const db = await connectedTenant()
  const { seen, restore } = intercept(quote('USD', 'RWF', 1387.5))
  try {
    const result = await liveRate(db, TENANT, 'USD', 'RWF')
    assertEquals(seen.calls, 1)
    assertEquals(result.source, 'flutterwave')
    assertEquals(result.rate, 1387.5)
  } finally {
    restore()
  }
})
