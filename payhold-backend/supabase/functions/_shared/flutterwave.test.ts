/**
 * Run with: deno test --allow-env supabase/functions/_shared/flutterwave.test.ts
 *
 * The unit conversion is the dangerous part of this file. PayHold stores minor
 * units; Flutterwave quotes major. For USD that is a factor of 100, and for
 * RWF — the launch currency — it is a factor of 1. Applying the USD rule to
 * RWF would charge a buyer 1/100th of the price and pay a seller 1/100th of
 * what they are owed, on every single transaction, silently.
 */

import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@1'
import { FlutterwaveProvider, toMajor, toMinor, type FlutterwaveCredentials } from './flutterwave.ts'
import { PayHoldError } from './types.ts'

const CREDS: FlutterwaveCredentials = {
  secret_key: 'FLWSECK_TEST-x',
  public_key: 'FLWPUBK_TEST-x',
  encryption_key: 'enc',
  webhook_hash: 'super-secret-hash',
}

Deno.test('zero-decimal currencies are not divided', () => {
  // RWF 1000 is one thousand francs, not ten.
  assertEquals(toMajor(1000, 'RWF'), 1000)
  assertEquals(toMinor(1000, 'RWF'), 1000)

  for (const currency of ['UGX', 'XOF', 'XAF', 'BIF', 'JPY']) {
    assertEquals(toMajor(5000, currency), 5000, currency)
    assertEquals(toMinor(5000, currency), 5000, currency)
  }
})

Deno.test('decimal currencies convert by 100', () => {
  assertEquals(toMajor(1000, 'USD'), 10)
  assertEquals(toMinor(10, 'USD'), 1000)
  assertEquals(toMajor(150_050, 'EUR'), 1500.5)
  assertEquals(toMinor(1500.5, 'EUR'), 150_050)
})

Deno.test('conversion round-trips without drift', () => {
  // Float multiplication is why toMinor rounds. 19.99 * 100 is 1998.9999…
  for (const [minor, currency] of [
    [1999, 'USD'], [1, 'USD'], [999_999_99, 'USD'],
    [1000, 'RWF'], [1, 'RWF'], [123_456_789, 'RWF'],
    [70, 'GBP'], [3333, 'KES'],
  ] as [number, string][]) {
    assertEquals(toMinor(toMajor(minor, currency), currency), minor, `${minor} ${currency}`)
  }
})

Deno.test('a webhook with no verif-hash is refused', () => {
  const p = new FlutterwaveProvider(CREDS, '')
  assert(!p.verifySignature('{}', new Headers()))
})

Deno.test('a webhook with the wrong verif-hash is refused', () => {
  const p = new FlutterwaveProvider(CREDS, '')
  assert(!p.verifySignature('{}', new Headers({ 'verif-hash': 'wrong' })))
  // Same length, one character different — the constant-time path.
  assert(!p.verifySignature('{}', new Headers({ 'verif-hash': 'super-secret-hasX' })))
})

Deno.test('a webhook with the right verif-hash is accepted', () => {
  const p = new FlutterwaveProvider(CREDS, '')
  assert(p.verifySignature('{}', new Headers({ 'verif-hash': 'super-secret-hash' })))
})

Deno.test('a provider with no configured hash accepts nothing', () => {
  // An unconfigured webhook secret must fail closed. Accepting everything
  // because nothing was set is how the forged-webhook test starts passing 200.
  const p = new FlutterwaveProvider({ ...CREDS, webhook_hash: '' }, '')
  assert(!p.verifySignature('{}', new Headers({ 'verif-hash': '' })))
  assert(!p.verifySignature('{}', new Headers({ 'verif-hash': 'anything' })))
})

// ---------------------------------------------------------------------------
// Direct charge — the path that lets a buyer finish inside a client's own page
// ---------------------------------------------------------------------------

/** Capture the request without letting it leave. */
function intercept(response: unknown, status = 200) {
  const seen: { url?: string; body?: string } = {}
  const original = globalThis.fetch

  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    seen.url = String(url)
    seen.body = init?.body ? String(init.body) : undefined
    return Promise.resolve(
      new Response(JSON.stringify(response), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    )
  }) as typeof fetch

  return { seen, restore: () => { globalThis.fetch = original } }
}

const CHARGE = {
  deal_id: 'd1',
  amount: 45_000,
  currency: 'RWF',
  method: 'mobile_money' as const,
  return_url: 'https://autohire.pages.dev/trips',
  three_d_secure: false,
  idempotency_key: 'charge:d1',
}

Deno.test('a wallet number routes to the direct rail, not the hosted page', async () => {
  const { seen, restore } = intercept({
    status: 'success',
    data: { flw_ref: 'FLW-REF-1', status: 'pending' },
    meta: { authorization: { mode: 'callback' } },
  })

  try {
    const result = await new FlutterwaveProvider(CREDS, '').charge({
      ...CHARGE,
      phone: '250788123456',
      network: 'MTN MoMo',
    })

    // `/payments` is the hosted page. Reaching it here would mean the buyer is
    // being sent somewhere despite having typed everything the rail needs.
    assert(seen.url?.includes('/charges?type=mobile_money_rwanda'), seen.url)

    const body = JSON.parse(seen.body ?? '{}')
    assertEquals(body.phone_number, '250788123456')
    // Their vocabulary, not the rails table's label.
    assertEquals(body.network, 'MTN')
    // RWF is zero-decimal: 45,000 francs, not 450.
    assertEquals(body.amount, 45_000)
    // tx_ref is what the webhook matches on. Anything else orphans the charge.
    assertEquals(body.tx_ref, 'd1')

    assertEquals(result.provider_ref, 'd1')
    assertEquals(result.next_action?.type, 'wait')
    // Nowhere to send anyone, and it says so rather than offering a dead link.
    assertEquals(result.payment_link, '')
  } finally {
    restore()
  }
})

Deno.test('an OTP request is passed on with the reference needed to answer it', async () => {
  const { restore } = intercept({
    status: 'success',
    data: { flw_ref: 'FLW-REF-2' },
    meta: { authorization: { mode: 'otp', instruction: 'Enter the code we sent.' } },
  })

  try {
    const result = await new FlutterwaveProvider(CREDS, '').charge({
      ...CHARGE,
      phone: '250788123456',
    })

    assertEquals(result.next_action?.type, 'otp')
    if (result.next_action?.type !== 'otp') throw new Error('expected otp')
    // `validate-charge` is addressed by flw_ref. Without it the box cannot submit.
    assertEquals(result.next_action.reference, 'FLW-REF-2')
    assertEquals(result.next_action.message, 'Enter the code we sent.')
  } finally {
    restore()
  }
})

Deno.test('an OTP with no reference degrades to waiting rather than an unanswerable box', async () => {
  const { restore } = intercept({
    status: 'success',
    data: {},
    meta: { authorization: { mode: 'otp' } },
  })

  try {
    const result = await new FlutterwaveProvider(CREDS, '').charge({
      ...CHARGE,
      phone: '250788123456',
    })
    // The charge is real and the webhook will still settle it. An OTP field
    // with nothing to submit against would be worse than saying "check your
    // phone", which is true either way.
    assertEquals(result.next_action?.type, 'wait')
  } finally {
    restore()
  }
})

Deno.test('a rail that answers with a redirect is still honoured', async () => {
  const { restore } = intercept({
    status: 'success',
    data: { flw_ref: 'FLW-REF-3' },
    meta: { authorization: { mode: 'redirect', redirect: 'https://flutterwave.test/auth' } },
  })

  try {
    const result = await new FlutterwaveProvider(CREDS, '').charge({
      ...CHARGE,
      phone: '250788123456',
    })

    assertEquals(result.next_action?.type, 'redirect')
    // Kept in step so a client reading only `payment_link` behaves identically.
    assertEquals(result.payment_link, 'https://flutterwave.test/auth')
  } finally {
    restore()
  }
})

Deno.test('a currency with no direct rail is refused, not quietly handed off', async () => {
  const { restore } = intercept({ status: 'success', data: { link: 'https://hosted' } })

  try {
    await assertRejects(
      () =>
        new FlutterwaveProvider(CREDS, '').charge({
          ...CHARGE,
          currency: 'GBP',
          phone: '447700900000',
        }),
      PayHoldError,
      'no direct mobile money rail',
    )
  } finally {
    restore()
  }
})

Deno.test('mobile money with no number still gets the hosted page', async () => {
  const { seen, restore } = intercept({ status: 'success', data: { link: 'https://hosted' } })

  try {
    // A client that does not collect a number must keep working exactly as it
    // did. The direct path is an upgrade, never a requirement.
    const result = await new FlutterwaveProvider(CREDS, '').charge(CHARGE)
    assert(seen.url?.endsWith('/payments'), seen.url)
    assertEquals(result.next_action?.type, 'redirect')
    assertEquals(result.payment_link, 'https://hosted')
  } finally {
    restore()
  }
})

Deno.test('card is offered as an element carrying the deal id as its reference', async () => {
  const { seen, restore } = intercept({ status: 'success', data: { link: 'https://hosted' } })

  try {
    const result = await new FlutterwaveProvider(CREDS, '').charge({
      ...CHARGE,
      method: 'card',
      three_d_secure: true,
    })

    // The hosted link is still made, and still 3DS. The element is an addition.
    assertEquals(JSON.parse(seen.body ?? '{}').authorization?.mode, 'redirect')
    assertEquals(result.payment_link, 'https://hosted')

    assertEquals(result.next_action?.type, 'element')
    if (result.next_action?.type !== 'element') throw new Error('expected element')
    // Publishable, never the secret. This one crosses to a browser.
    assertEquals(result.next_action.public_key, 'FLWPUBK_TEST-x')
    // Same reference as the hosted link, so the two are one charge and at most
    // one of them can ever complete.
    assertEquals(result.next_action.reference, 'd1')
    assertEquals(result.next_action.amount, 45_000)
  } finally {
    restore()
  }
})

Deno.test('validating a code reports what the rail said next, never success', async () => {
  const { seen, restore } = intercept({
    status: 'success',
    message: 'Charge validated',
    data: { flw_ref: 'FLW-REF-4', tx_ref: 'd1', status: 'successful' },
  })

  try {
    const result = await new FlutterwaveProvider(CREDS, '').validate({
      reference: 'FLW-REF-4',
      otp: '123456',
      method: 'mobile_money',
    })

    assert(seen.url?.endsWith('/validate-charge'), seen.url)
    assertEquals(JSON.parse(seen.body ?? '{}').flw_ref, 'FLW-REF-4')

    // Flutterwave said "successful" and this still only says "wait". The hold
    // is the webhook's after it re-fetches the transaction — §15 phase 2 — and
    // a validate that reported funding would be a second, unverified way in.
    assertEquals(result.next_action?.type, 'wait')
  } finally {
    restore()
  }
})

Deno.test('a rejected code comes back as another code, not as a dead end', async () => {
  const { restore } = intercept({
    status: 'success',
    data: { flw_ref: 'FLW-REF-5' },
    meta: { authorization: { mode: 'otp', instruction: 'Wrong code. Try again.' } },
  })

  try {
    const result = await new FlutterwaveProvider(CREDS, '').validate({
      reference: 'FLW-REF-5',
      otp: '000000',
      method: 'mobile_money',
    })

    assertEquals(result.next_action?.type, 'otp')
  } finally {
    restore()
  }
})
