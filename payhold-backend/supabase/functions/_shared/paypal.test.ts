/**
 * PayPalProvider — the parts that are checkable without a PayPal account.
 *
 * Nothing here reaches the network, for the reason `stripe.test.ts` does not:
 * CI must not talk to a provider. What it pins is the shape of what we send and
 * the correctness of what we refuse, because those are the two expensive places
 * — a wrong amount field collects the wrong money, and a wrong signature check
 * accepts a forged webhook.
 *
 * The amount conversion carries most of the weight here. PayPal takes major
 * units as decimal strings while `Money` is minor units everywhere in PayHold,
 * so every figure crosses a boundary Stripe's adapter deliberately does not
 * have. A missing conversion on this rail is a charge off by a factor of a
 * hundred, in either direction.
 */

import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@1'
import { PayPalProvider, fromValue, toValue, type PayPalCredentials } from './paypal.ts'
import { PayHoldError } from './types.ts'

const CREDS: PayPalCredentials = {
  client_id: 'client-test',
  client_secret: 'secret-test',
  webhook_id: 'WH-TEST-1',
  mode: 'test',
}

interface Seen {
  url?: string
  body?: string
  headers?: Headers
}

/**
 * Capture requests without letting them leave.
 *
 * The token exchange is answered first and separately: every call on this rail
 * makes two round trips, and a test that had to describe the OAuth hop each
 * time would be testing the harness.
 */
function intercept(responses: unknown[], status = 200) {
  const seen: Seen[] = []
  const original = globalThis.fetch
  const queue = [...responses]

  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    const target = String(url)
    seen.push({
      url: target,
      body: init?.body ? String(init.body) : undefined,
      headers: new Headers(init?.headers),
    })

    if (target.endsWith('/v1/oauth2/token')) {
      return Promise.resolve(
        new Response(JSON.stringify({ access_token: 'tok-1', expires_in: 32400 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
    }

    return Promise.resolve(
      new Response(JSON.stringify(queue.shift() ?? {}), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    )
  }) as typeof fetch

  return { seen, restore: () => { globalThis.fetch = original } }
}

/** Requests that are not the OAuth hop. */
const calls = (seen: Seen[]): Seen[] =>
  seen.filter((s) => !s.url?.endsWith('/v1/oauth2/token'))

const ORDER = {
  id: 'ORDER-1',
  status: 'CREATED',
  links: [{ rel: 'payer-action', href: 'https://paypal.com/checkoutnow?token=ORDER-1' }],
}

Deno.test('amounts become major-unit decimal strings, not minor units', () => {
  // The conversion Stripe's adapter deliberately does not have. 10000 minor
  // units is one hundred dollars, and PayPal must be told so in its own terms.
  assertEquals(toValue(10_000, 'USD'), '100.00')
  assertEquals(toValue(1, 'USD'), '0.01')
  assertEquals(fromValue('100.00', 'USD'), 10_000)
  assertEquals(fromValue('0.01', 'USD'), 1)
})

Deno.test('zero-decimal currencies are PayPal\'s list, not ours', () => {
  // JPY is zero-decimal everywhere. HUF and TWD are decimal currencies that
  // PayPal nonetheless refuses fractions in — a rule about their API rather
  // than about the money, which is why this list is not shared with the
  // other adapters.
  assertEquals(toValue(5_000, 'JPY'), '5000')
  assertEquals(toValue(5_000, 'HUF'), '5000')
  assertEquals(fromValue('5000', 'JPY'), 5_000)
})

Deno.test('a charge creates an order and hands back where to send the buyer', async () => {
  const { seen, restore } = intercept([ORDER])
  try {
    const pp = new PayPalProvider(CREDS, 'https://pay.example')
    const result = await pp.charge({
      deal_id: 'deal-1',
      amount: 10_000,
      currency: 'USD',
      method: 'wallet',
      return_url: 'https://pay.example/done',
      three_d_secure: true,
      idempotency_key: 'idem-1',
    })

    const [call] = calls(seen)
    assert(call.url?.endsWith('/v2/checkout/orders'))

    const body = JSON.parse(call.body!)
    assertEquals(body.intent, 'CAPTURE')
    assertEquals(body.purchase_units[0].amount.value, '100.00')
    assertEquals(body.purchase_units[0].amount.currency_code, 'USD')
    // The deal travels with the order, so a webhook about it is traceable back
    // without trusting anything the buyer could have edited.
    assertEquals(body.purchase_units[0].custom_id, 'deal-1')

    assertEquals(result.provider_ref, 'ORDER-1')
    assertEquals(result.payment_link, ORDER.links[0].href)
  } finally {
    restore()
  }
})

Deno.test('a charge names wallet_approval, not the generic redirect', async () => {
  // Without this, startCharge fills in `{ type: 'redirect', url: payment_link
  // }`, and the checkout client puts that url in an iframe — the same as it
  // does Flutterwave's hosted page. PayPal refuses to be framed exactly like
  // Stripe Checkout does, so that iframe loads PayPal's page and is
  // immediately blocked: a buyer sees it arrive and vanish, with no way to
  // pay. wallet_approval is what the client's popup-based button expects.
  const { restore } = intercept([ORDER])
  try {
    const pp = new PayPalProvider(CREDS, 'https://pay.example')
    const result = await pp.charge({
      deal_id: 'deal-1',
      amount: 10_000,
      currency: 'USD',
      method: 'wallet',
      return_url: 'https://pay.example/done',
      three_d_secure: true,
      idempotency_key: 'idem-1',
    })

    assertEquals(result.next_action, {
      type: 'wallet_approval',
      provider: 'paypal',
      client_id: CREDS.client_id,
      order: 'ORDER-1',
      currency: 'USD',
      approval_url: ORDER.links[0].href,
    })
  } finally {
    restore()
  }
})

Deno.test('idempotency is a header, so a retry is not a second order', async () => {
  const { seen, restore } = intercept([ORDER])
  try {
    const pp = new PayPalProvider(CREDS, 'https://pay.example')
    await pp.charge({
      deal_id: 'deal-1',
      amount: 10_000,
      currency: 'USD',
      method: 'card',
      return_url: 'https://pay.example/done',
      three_d_secure: true,
      idempotency_key: 'idem-42',
    })

    assertEquals(calls(seen)[0].headers?.get('paypal-request-id'), 'idem-42')
  } finally {
    restore()
  }
})

Deno.test('mobile money is refused rather than quietly charged another way', async () => {
  const { restore } = intercept([ORDER])
  try {
    const pp = new PayPalProvider(CREDS, 'https://pay.example')
    await assertRejects(
      () =>
        pp.charge({
          deal_id: 'deal-1',
          amount: 10_000,
          currency: 'USD',
          method: 'mobile_money',
          return_url: 'https://pay.example/done',
          three_d_secure: true,
          idempotency_key: 'idem-1',
        }),
      PayHoldError,
      'cannot take a mobile_money payment',
    )
  } finally {
    restore()
  }
})

Deno.test('a deposit is held rather than taken — §22', async () => {
  const { seen, restore } = intercept([{ ...ORDER, intent: 'AUTHORIZE' }])
  try {
    const pp = new PayPalProvider(CREDS, 'https://pay.example')
    await pp.preauth({
      deal_id: 'deal-1',
      amount: 25_000,
      currency: 'USD',
      return_url: 'https://pay.example/done',
      idempotency_key: 'idem-1',
    })

    const body = JSON.parse(calls(seen)[0].body!)
    // AUTHORIZE, not CAPTURE. The whole difference between a payment and a
    // hold against damage.
    assertEquals(body.intent, 'AUTHORIZE')
    assertEquals(body.purchase_units[0].amount.value, '250.00')
  } finally {
    restore()
  }
})

Deno.test('a deposit hold also names wallet_approval, not the generic redirect', async () => {
  const { restore } = intercept([{ ...ORDER, intent: 'AUTHORIZE' }])
  try {
    const pp = new PayPalProvider(CREDS, 'https://pay.example')
    const result = await pp.preauth({
      deal_id: 'deal-1',
      amount: 25_000,
      currency: 'USD',
      return_url: 'https://pay.example/done',
      idempotency_key: 'idem-1',
    })

    assertEquals(result.next_action, {
      type: 'wallet_approval',
      provider: 'paypal',
      client_id: CREDS.client_id,
      order: 'ORDER-1',
      currency: 'USD',
      approval_url: ORDER.links[0].href,
    })
  } finally {
    restore()
  }
})

Deno.test('a partial deposit capture leaves the rest held', async () => {
  const { seen, restore } = intercept([
    { amount: { currency_code: 'USD', value: '250.00' } },
    { id: 'CAPTURE-9' },
  ])
  try {
    const pp = new PayPalProvider(CREDS, 'https://pay.example')
    const out = await pp.capture('AUTH-1', 10_000)

    const body = JSON.parse(calls(seen)[1].body!)
    assertEquals(body.amount.value, '100.00')
    // The decision to keep the remainder may not have been made yet, so the
    // authorization must survive a partial capture.
    assertEquals(body.final_capture, false)
    assertEquals(out.provider_ref, 'CAPTURE-9')
  } finally {
    restore()
  }
})

Deno.test('a refund is issued against the capture, never the order', async () => {
  const { seen, restore } = intercept([{ id: 'REFUND-1' }])
  try {
    const pp = new PayPalProvider(CREDS, 'https://pay.example')
    await pp.refund({
      provider_ref: 'CAPTURE-7',
      amount: 2_500,
      currency: 'USD',
      idempotency_key: 'idem-r1',
    })

    const [call] = calls(seen)
    assert(call.url?.includes('/v2/payments/captures/CAPTURE-7/refund'))
    assertEquals(JSON.parse(call.body!).amount.value, '25.00')
  } finally {
    restore()
  }
})

Deno.test('verify reads the capture, and reports their fee separately', async () => {
  const { restore } = intercept([
    {
      id: 'CAPTURE-7',
      status: 'COMPLETED',
      amount: { currency_code: 'USD', value: '100.00' },
      seller_receivable_breakdown: {
        paypal_fee: { currency_code: 'USD', value: '3.49' },
      },
    },
  ])
  try {
    const pp = new PayPalProvider(CREDS, 'https://pay.example')
    const v = await pp.verify('CAPTURE-7')

    assertEquals(v.status, 'successful')
    assertEquals(v.amount, 10_000)
    // The rail genuinely took it, so it is a provider_fee and reduces what
    // reconciliation expects — it belongs in no retained bucket.
    assertEquals(v.fee, 349)
    // A PayPal payment is a wallet payment. How the buyer funded *their*
    // wallet is PayPal's business and they do not tell us — so `wallet` is
    // the whole honest answer, and it used to be null for want of the value.
    assertEquals(v.method, 'wallet')
  } finally {
    restore()
  }
})

Deno.test('an order-embedded capture with no fee breakdown is looked up directly', async () => {
  // The exact incident this pins: settle-pending calls `verify` with the
  // order id every time (that is what `charge` hands out as the checkout
  // session's reference), so this — capture-id lookup 404s, falls through to
  // the order, whose embedded capture is a summary — is the path the common
  // case actually takes, not the direct-capture-id branch above. A real,
  // successful PayPal deal booked provider_fee: 0 because nothing here ever
  // asked about the capture by its own id, where the full breakdown lives.
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = ((url: string | URL | Request) => {
    const target = String(url)
    if (target.endsWith('/v1/oauth2/token')) {
      return Promise.resolve(
        new Response(JSON.stringify({ access_token: 't', expires_in: 32400 }), { status: 200 }),
      )
    }
    calls++
    if (calls === 1) {
      // `/v2/payments/captures/ORDER-9` — ORDER-9 is not a capture id.
      return Promise.resolve(new Response('{}', { status: 404 }))
    }
    if (calls === 2) {
      // `/v2/checkout/orders/ORDER-9` — the embedded capture has no breakdown.
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: 'ORDER-9',
            status: 'COMPLETED',
            purchase_units: [{
              amount: { currency_code: 'USD', value: '100.00' },
              payments: {
                captures: [{
                  id: 'CAPTURE-9',
                  status: 'COMPLETED',
                  amount: { currency_code: 'USD', value: '100.00' },
                }],
              },
            }],
          }),
          { status: 200 },
        ),
      );
    }
    // `/v2/payments/captures/CAPTURE-9` — the direct lookup, with the full
    // breakdown the order's embedded copy did not carry.
    assert(target.endsWith('/v2/payments/captures/CAPTURE-9'));
    return Promise.resolve(
      new Response(
        JSON.stringify({
          id: 'CAPTURE-9',
          status: 'COMPLETED',
          amount: { currency_code: 'USD', value: '100.00' },
          seller_receivable_breakdown: {
            paypal_fee: { currency_code: 'USD', value: '3.49' },
          },
        }),
        { status: 200 },
      ),
    );
  }) as typeof fetch;

  try {
    const pp = new PayPalProvider(CREDS, 'https://pay.example');
    const v = await pp.verify('ORDER-9');
    assertEquals(v.fee, 349);
    assertEquals(calls, 3);
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test('an unfinished order verifies as pending, never as failed', async () => {
  // A capture id 404s, so it falls through to the order — which is the path a
  // caller holding a `charge` result takes.
  const { restore } = intercept([
    {},
    {
      id: 'ORDER-1',
      status: 'PAYER_ACTION_REQUIRED',
      purchase_units: [{ amount: { currency_code: 'USD', value: '100.00' } }],
    },
  ], 404)

  const original = globalThis.fetch
  let first = true
  globalThis.fetch = ((url: string | URL | Request) => {
    const target = String(url)
    if (target.endsWith('/v1/oauth2/token')) {
      return Promise.resolve(
        new Response(JSON.stringify({ access_token: 't', expires_in: 32400 }), { status: 200 }),
      )
    }
    if (first) {
      first = false
      return Promise.resolve(new Response('{}', { status: 404 }))
    }
    return Promise.resolve(
      new Response(
        JSON.stringify({
          id: 'ORDER-1',
          status: 'PAYER_ACTION_REQUIRED',
          purchase_units: [{ amount: { currency_code: 'USD', value: '100.00' } }],
        }),
        { status: 200 },
      ),
    )
  }) as typeof fetch

  try {
    const pp = new PayPalProvider(CREDS, 'https://pay.example')
    const v = await pp.verify('ORDER-1')
    // An abandoned order that later completes must still be able to fund the
    // deal, so this is pending rather than failed.
    assertEquals(v.status, 'pending')
    assertEquals(v.amount, 10_000)
  } finally {
    globalThis.fetch = original
    restore()
  }
})

Deno.test('an approved-but-uncaptured order verifies as pending, never as successful', async () => {
  // APPROVED is an *order* status — the buyer said yes, the merchant has not
  // captured yet — and has no equivalent in a capture's own status
  // vocabulary. Reporting it as 'successful' with no capture id to hand back
  // is what let `fund_deal` book the *order* id as `provider_ref`, which a
  // later refund then 404s against — a refund is only ever valid on a
  // capture. A capture id 404s first, so this falls through to the order,
  // the same path `verify` takes for any caller holding a `charge` result.
  const original = globalThis.fetch
  let first = true
  globalThis.fetch = ((url: string | URL | Request) => {
    const target = String(url)
    if (target.endsWith('/v1/oauth2/token')) {
      return Promise.resolve(
        new Response(JSON.stringify({ access_token: 't', expires_in: 32400 }), { status: 200 }),
      )
    }
    if (first) {
      first = false
      return Promise.resolve(new Response('{}', { status: 404 }))
    }
    return Promise.resolve(
      new Response(
        JSON.stringify({
          id: 'ORDER-2',
          status: 'APPROVED',
          purchase_units: [{ amount: { currency_code: 'USD', value: '100.00' } }],
        }),
        { status: 200 },
      ),
    )
  }) as typeof fetch

  try {
    const pp = new PayPalProvider(CREDS, 'https://pay.example')
    const v = await pp.verify('ORDER-2')
    assertEquals(v.status, 'pending')
    assertEquals(v.provider_ref, 'ORDER-2')
  } finally {
    globalThis.fetch = original
  }
})

Deno.test('a payout is one item, and acceptance is not settlement', async () => {
  const { seen, restore } = intercept([
    { batch_header: { payout_batch_id: 'BATCH-1', batch_status: 'PENDING' } },
  ])
  try {
    const pp = new PayPalProvider(CREDS, 'https://pay.example')
    const out = await pp.release({
      payout_id: 'payout-1',
      beneficiary_token: 'seller@example.com',
      amount: 90_000,
      currency: 'USD',
      idempotency_key: 'idem-p1',
    })

    const body = JSON.parse(calls(seen)[0].body!)
    assertEquals(body.items.length, 1)
    assertEquals(body.items[0].amount.value, '900.00')
    assertEquals(body.items[0].recipient_type, 'EMAIL')
    assertEquals(body.sender_batch_header.sender_batch_id, 'idem-p1')

    // Their batch is accepted first and processed after. Reporting a seller
    // paid here would be reporting money that has not moved.
    assertEquals(out.status, 'pending')
    assertEquals(out.provider_ref, 'BATCH-1')
  } finally {
    restore()
  }
})

Deno.test('a payer id payout goes as PAYPAL_ID, not as an email', async () => {
  const { seen, restore } = intercept([
    { batch_header: { payout_batch_id: 'BATCH-2', batch_status: 'SUCCESS' } },
  ])
  try {
    const pp = new PayPalProvider(CREDS, 'https://pay.example')
    const out = await pp.release({
      payout_id: 'payout-2',
      beneficiary_token: 'YVWL8QRTKZ7YJ',
      amount: 1_000,
      currency: 'USD',
      idempotency_key: 'idem-p2',
    })

    assertEquals(JSON.parse(calls(seen)[0].body!).items[0].recipient_type, 'PAYPAL_ID')
    assertEquals(out.status, 'paid')
  } finally {
    restore()
  }
})

Deno.test('a destination is an account handle, not bank details', async () => {
  const pp = new PayPalProvider(CREDS, 'https://pay.example')

  const email = await pp.tokenize({
    destination: 'seller@example.com',
    currency: 'USD',
    country: 'US',
  })
  assertEquals(email.beneficiary_token, 'seller@example.com')
  // The mask is what a screen shows. The raw handle is a personal identifier
  // and never appears in a response or an audit row.
  assert(!email.masked_destination.includes('seller@'))

  await assertRejects(
    () => pp.tokenize({ destination: '', currency: 'USD', country: 'US' }),
    PayHoldError,
  )

  // An account number arriving here is a client misunderstanding worth naming
  // rather than storing.
  await assertRejects(
    () =>
      pp.tokenize({
        destination: '4111 1111 1111 1111',
        currency: 'USD',
        country: 'US',
      }),
    PayHoldError,
    'not bank details',
  )
})

Deno.test('an unverifiable webhook is refused, never accepted', async () => {
  const pp = new PayPalProvider(CREDS, 'https://pay.example')

  // No headers at all.
  assertEquals(await pp.verifySignature('{}', new Headers()), false)

  // A cert_url that is not PayPal's is an attacker naming where a key comes
  // from. Refused before we ever ask them about it.
  const forged = new Headers({
    'paypal-transmission-id': 'a',
    'paypal-transmission-time': 'b',
    'paypal-transmission-sig': 'c',
    'paypal-cert-url': 'https://evil.example/cert.pem',
    'paypal-auth-algo': 'SHA256withRSA',
  })
  assertEquals(await pp.verifySignature('{}', forged), false)
})

Deno.test('an unreachable PayPal means unverified, not verified', async () => {
  const original = globalThis.fetch
  globalThis.fetch = (() => Promise.reject(new Error('network down'))) as typeof fetch

  try {
    const pp = new PayPalProvider(CREDS, 'https://pay.example')
    const headers = new Headers({
      'paypal-transmission-id': 'a',
      'paypal-transmission-time': 'b',
      'paypal-transmission-sig': 'c',
      'paypal-cert-url': 'https://api-m.sandbox.paypal.com/v1/certs/x.pem',
      'paypal-auth-algo': 'SHA256withRSA',
    })
    // Invariant 2 has no degraded mode. A webhook we could not check is one a
    // forger would want us to accept.
    assertEquals(await pp.verifySignature('{}', headers), false)
  } finally {
    globalThis.fetch = original
  }
})

Deno.test('a verified webhook says SUCCESS and nothing weaker', async () => {
  for (const [status, expected] of [['SUCCESS', true], ['FAILURE', false]] as const) {
    const { restore } = intercept([{ verification_status: status }])
    try {
      const pp = new PayPalProvider(CREDS, 'https://pay.example')
      const headers = new Headers({
        'paypal-transmission-id': 'a',
        'paypal-transmission-time': 'b',
        'paypal-transmission-sig': 'c',
        'paypal-cert-url': 'https://api-m.sandbox.paypal.com/v1/certs/x.pem',
        'paypal-auth-algo': 'SHA256withRSA',
      })
      assertEquals(await pp.verifySignature('{"id":"EV-1"}', headers), expected)
    } finally {
      restore()
    }
  }
})

Deno.test('sandbox and live are different hosts, not a flag', async () => {
  for (const [mode, host] of [
    ['test', 'api-m.sandbox.paypal.com'],
    ['live', 'api-m.paypal.com'],
  ] as const) {
    const { seen, restore } = intercept([ORDER])
    try {
      const pp = new PayPalProvider({ ...CREDS, mode }, 'https://pay.example')
      await pp.charge({
        deal_id: 'deal-1',
        amount: 100,
        currency: 'USD',
        method: 'card',
        return_url: 'https://pay.example/done',
        three_d_secure: true,
        idempotency_key: 'idem-1',
      })
      assert(calls(seen)[0].url?.includes(host), `${mode} should hit ${host}`)
    } finally {
      restore()
    }
  }
})

Deno.test('the bearer token is fetched once and reused', async () => {
  const { seen, restore } = intercept([ORDER, ORDER])
  try {
    const pp = new PayPalProvider(CREDS, 'https://pay.example')
    const charge = () =>
      pp.charge({
        deal_id: 'deal-1',
        amount: 100,
        currency: 'USD',
        method: 'card',
        return_url: 'https://pay.example/done',
        three_d_secure: true,
        idempotency_key: 'idem-1',
      })

    await charge()
    await charge()

    // A provider is constructed per request, so a token fetch per call would
    // double every round trip on this rail.
    const tokenCalls = seen.filter((s) => s.url?.endsWith('/v1/oauth2/token'))
    assertEquals(tokenCalls.length, 1)
  } finally {
    restore()
  }
})

Deno.test('a rejected token exchange never quotes their body back', async () => {
  const original = globalThis.fetch
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify({ error_description: 'Client Authentication failed' }), {
        status: 401,
      }),
    )) as typeof fetch

  try {
    const pp = new PayPalProvider(CREDS, 'https://pay.example')
    const err = await assertRejects(() => pp.balances(), PayHoldError)
    // Their text can quote the client id back, and a credential does not
    // belong in an error a client might see.
    assert(!String(err).includes('Client Authentication failed'))
  } finally {
    globalThis.fetch = original
  }
})
