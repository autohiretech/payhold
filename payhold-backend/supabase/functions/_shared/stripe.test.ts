/**
 * StripeProvider — the parts that are checkable without a Stripe account.
 *
 * Nothing here reaches the network. What it pins is the shape of what we send
 * and the correctness of what we verify, because those are the two places a
 * mistake is expensive: a wrong request field collects the wrong amount or
 * silently drops 3DS, and a wrong signature check accepts a forged webhook.
 *
 * The live calls stay unexercised, like Flutterwave's. Nothing in CI talks to a
 * provider and nothing should.
 */

import { assertEquals, assertRejects } from 'jsr:@std/assert@1'
import { StripeProvider, type StripeCredentials } from './stripe.ts'
import { PayHoldError } from './types.ts'

const CREDS: StripeCredentials = {
  secret_key: 'sk_test_deadbeef',
  publishable_key: 'pk_test_deadbeef',
  webhook_secret: 'whsec_testsecret',
}

/** Capture the request without letting it leave. */
function intercept(response: unknown, status = 200) {
  const seen: { url?: string; body?: string; headers?: Headers } = {}
  const original = globalThis.fetch

  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    seen.url = String(url)
    seen.body = init?.body ? String(init.body) : undefined
    seen.headers = new Headers(init?.headers)
    return Promise.resolve(
      new Response(JSON.stringify(response), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    )
  }) as typeof fetch

  return { seen, restore: () => { globalThis.fetch = original } }
}

/** A `Stripe-Signature` header, built the way Stripe builds one. */
async function sign(body: string, secret: string, timestamp: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const digest = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${timestamp}.${body}`),
  )
  const hex = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  return `t=${timestamp},v1=${hex}`
}

// ---------------------------------------------------------------------------
// What we send
// ---------------------------------------------------------------------------

Deno.test('a charge asks for 3D Secure explicitly, never automatically', async () => {
  const { seen, restore } = intercept({ id: 'pi_1', client_secret: 'pi_1_secret_x' })

  try {
    await new StripeProvider(CREDS, '').charge({
      deal_id: 'deal_1',
      amount: 1500,
      currency: 'USD',
      method: 'card',
      return_url: 'https://app/return',
      three_d_secure: true,
      idempotency_key: 'k1',
    })
  } finally {
    restore()
  }

  const body = decodeURIComponent(seen.body ?? '')
  // §6, and the word that matters is `any`. Stripe's default is `automatic`,
  // which lets Radar decide — and a downgrade nobody asked for is exactly what
  // "never silently downgraded" forbids. The intent nests this one level
  // shallower than the Session did; the rule is the same rule.
  assertEquals(
    body.includes('payment_method_options[card][request_three_d_secure]=any'),
    true,
    body,
  )
})

Deno.test('amounts go to Stripe untouched, in the smallest unit', async () => {
  const { seen, restore } = intercept({ id: 'pi_1', client_secret: 'pi_1_secret_x' })

  try {
    await new StripeProvider(CREDS, '').charge({
      deal_id: 'deal_1',
      amount: 1500,
      currency: 'USD',
      method: 'card',
      return_url: 'https://app/return',
      three_d_secure: true,
      idempotency_key: 'k1',
    })
  } finally {
    restore()
  }

  const body = decodeURIComponent(seen.body ?? '')
  // Stripe takes the smallest currency unit, which is what `Money` already is —
  // hence no `toMajor` on this adapter, unlike Flutterwave's. A conversion here
  // would collect a hundredth or a hundred times the intended amount.
  assertEquals(body.includes('amount=1500'), true, body)
})

Deno.test('the idempotency key is a header, so a retry is not a second charge', async () => {
  const { seen, restore } = intercept({ id: 'pi_1', client_secret: 'pi_1_secret_x' })

  try {
    await new StripeProvider(CREDS, '').charge({
      deal_id: 'deal_1',
      amount: 1500,
      currency: 'USD',
      method: 'card',
      return_url: 'https://app/return',
      three_d_secure: true,
      idempotency_key: 'payout:abc',
    })
  } finally {
    restore()
  }

  assertEquals(seen.headers?.get('idempotency-key'), 'payout:abc')
})

Deno.test('a deposit is held rather than taken', async () => {
  const { seen, restore } = intercept({ id: 'cs_2', url: 'https://checkout/y' })

  try {
    await new StripeProvider(CREDS, '').preauth({
      deal_id: 'deal_2',
      amount: 50_000,
      currency: 'USD',
      return_url: 'https://app/return',
      idempotency_key: 'k2',
    })
  } finally {
    restore()
  }

  const body = decodeURIComponent(seen.body ?? '')
  // §22. `manual` is the whole of "hold a card deposit without taking it".
  assertEquals(body.includes('payment_intent_data[capture_method]=manual'), true, body)
})

Deno.test('mobile money is refused rather than quietly charged to a card', async () => {
  // Routing should never send a wallet payment here. Failing loudly beats
  // collecting a card payment from somebody who chose MTN.
  await assertRejects(
    () =>
      new StripeProvider(CREDS, '').charge({
        deal_id: 'deal_3',
        amount: 1000,
        currency: 'RWF',
        method: 'mobile_money',
        return_url: 'https://app/return',
        three_d_secure: true,
        idempotency_key: 'k3',
      }),
    PayHoldError,
    'mobile money',
  )
})

Deno.test('a payout destination must be a connected account, not bank details', async () => {
  // §19: PayHold never holds the destination. On Stripe the seller gives their
  // bank details to Stripe during Connect onboarding and we hold the account
  // id, so a raw number arriving here is a client misunderstanding worth
  // naming rather than storing.
  await assertRejects(
    () =>
      new StripeProvider(CREDS, '').tokenize({
        destination: '000123456789',
        currency: 'USD',
        country: 'US',
      }),
    PayHoldError,
    'connected account id',
  )
})

Deno.test('a connected account that cannot be paid is refused before it is stored', async () => {
  const { restore } = intercept({ id: 'acct_1', payouts_enabled: false })

  try {
    await assertRejects(
      () =>
        new StripeProvider(CREDS, '').tokenize({
          destination: 'acct_1',
          currency: 'USD',
          country: 'US',
        }),
      PayHoldError,
      'onboarding is incomplete',
    )
  } finally {
    restore()
  }
})

// ---------------------------------------------------------------------------
// What we believe
// ---------------------------------------------------------------------------

Deno.test('verify books what arrived, not what was asked for', async () => {
  const { restore } = intercept({
    id: 'pi_1',
    amount: 2000,
    amount_received: 1500,
    currency: 'usd',
    status: 'succeeded',
    latest_charge: {
      id: 'ch_1',
      payment_method_details: { type: 'card', card: { brand: 'visa' } },
      balance_transaction: { fee: 74 },
    },
  })

  try {
    const verified = await new StripeProvider(CREDS, '').verify('pi_1')
    // On a partially captured intent these differ, and booking `amount` would
    // credit a hold as though it were a payment.
    assertEquals(verified.amount, 1500)
    assertEquals(verified.currency, 'USD')
    assertEquals(verified.status, 'successful')
    assertEquals(verified.method, 'card')
    assertEquals(verified.network, 'visa')
    // §7's provider fee, from the only place Stripe states what it took.
    assertEquals(verified.fee, 74)
  } finally {
    restore()
  }
})

Deno.test('a held deposit verifies as pending, never as a payment or a failure', async () => {
  const { restore } = intercept({
    id: 'pi_2',
    amount: 50_000,
    currency: 'usd',
    status: 'requires_capture',
  })

  try {
    // §22: money is authorized and not taken. Calling it successful would fund
    // a deal from a deposit; calling it failed would drop a live hold.
    assertEquals((await new StripeProvider(CREDS, '').verify('pi_2')).status, 'pending')
  } finally {
    restore()
  }
})

Deno.test('a canceled intent verifies as failed', async () => {
  const { restore } = intercept({ id: 'pi_3', amount: 100, currency: 'usd', status: 'canceled' })

  try {
    assertEquals((await new StripeProvider(CREDS, '').verify('pi_3')).status, 'failed')
  } finally {
    restore()
  }
})

Deno.test('a fee we cannot read is zero rather than a guess', async () => {
  const { restore } = intercept({
    id: 'pi_4',
    amount: 1000,
    amount_received: 1000,
    currency: 'usd',
    status: 'succeeded',
    latest_charge: 'ch_4',
  })

  try {
    // Booking a guessed fee would put the ledger out by the difference, and the
    // reconciliation pass reads that as drift — which freezes the tenant.
    assertEquals((await new StripeProvider(CREDS, '').verify('pi_4')).fee, 0)
  } finally {
    restore()
  }
})

Deno.test('verify fetches the balance transaction when only its id came back', async () => {
  const original = globalThis.fetch
  // A webhook can deliver the intent with `latest_charge` as a bare id. The old
  // code booked fee 0 here; it must now fetch the charge (and its balance
  // transaction) to read the real fee.
  globalThis.fetch = ((url: string | URL | Request) => {
    const u = String(url)
    if (u.includes('/payment_intents/pi_5')) {
      return Promise.resolve(new Response(JSON.stringify({
        id: 'pi_5',
        amount: 2000,
        amount_received: 2000,
        currency: 'usd',
        status: 'succeeded',
        latest_charge: 'ch_5',
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
    }
    if (u.includes('/charges/ch_5')) {
      return Promise.resolve(new Response(JSON.stringify({
        id: 'ch_5',
        balance_transaction: { fee: 88 },
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
    }
    return Promise.resolve(new Response('{}', { status: 404 }))
  }) as typeof fetch

  try {
    assertEquals((await new StripeProvider(CREDS, '').verify('pi_5')).fee, 88)
  } finally {
    globalThis.fetch = original
  }
})

// ---------------------------------------------------------------------------
// The signature
// ---------------------------------------------------------------------------

Deno.test('a correctly signed webhook verifies', async () => {
  const body = '{"id":"evt_1","type":"checkout.session.completed"}'
  const header = await sign(body, CREDS.webhook_secret, Math.floor(Date.now() / 1000))

  const ok = await new StripeProvider(CREDS, '').verifySignature(
    body,
    new Headers({ 'stripe-signature': header }),
  )
  assertEquals(ok, true)
})

Deno.test('a forged signature does not', async () => {
  const body = '{"id":"evt_1"}'
  const header = await sign(body, 'whsec_someoneelses', Math.floor(Date.now() / 1000))

  assertEquals(
    await new StripeProvider(CREDS, '').verifySignature(
      body,
      new Headers({ 'stripe-signature': header }),
    ),
    false,
  )
})

Deno.test('a body edited after signing does not', async () => {
  const header = await sign('{"amount":100}', CREDS.webhook_secret, Math.floor(Date.now() / 1000))

  // The whole point of signing the raw bytes: an attacker who replays a real
  // delivery with a larger amount fails here, before anything is parsed.
  assertEquals(
    await new StripeProvider(CREDS, '').verifySignature(
      '{"amount":100000}',
      new Headers({ 'stripe-signature': header }),
    ),
    false,
  )
})

Deno.test('a valid signature outside the tolerance does not', async () => {
  const body = '{"id":"evt_1"}'
  const old = Math.floor(Date.now() / 1000) - 3600
  const header = await sign(body, CREDS.webhook_secret, old)

  // Bounding the age of `t` is the second obligation PayHold places on its own
  // clients, and it applies to us as a client of Stripe: without it a captured
  // delivery can be replayed indefinitely.
  assertEquals(
    await new StripeProvider(CREDS, '').verifySignature(
      body,
      new Headers({ 'stripe-signature': header }),
    ),
    false,
  )
})

Deno.test('an unsigned webhook does not', async () => {
  // The forged-webhook test in the launch gate must return 401 on every rail.
  assertEquals(
    await new StripeProvider(CREDS, '').verifySignature('{}', new Headers()),
    false,
  )
})

// ---------------------------------------------------------------------------
// Paying in the client's own page
// ---------------------------------------------------------------------------

const CHARGE = {
  deal_id: 'deal_1',
  amount: 1500,
  currency: 'USD' as const,
  method: 'card' as const,
  return_url: 'https://autohiretech.pages.dev/trips',
  three_d_secure: true,
  idempotency_key: 'charge:deal_1',
}

Deno.test('a charge opens an intent, not a page to send the buyer to', async () => {
  const { seen, restore } = intercept({ id: 'pi_9', client_secret: 'pi_9_secret_abc' })

  try {
    const result = await new StripeProvider(CREDS, '').charge(CHARGE)

    // Checkout Sessions can only be navigated to, and checkout.stripe.com
    // refuses to be framed — so reaching that endpoint here would mean the
    // buyer is being handed over no matter what the client wanted.
    assertEquals(seen.url, 'https://api.stripe.com/v1/payment_intents')

    assertEquals(result.provider_ref, 'pi_9')
    // Said plainly rather than as a link that finishes nothing.
    assertEquals(result.payment_link, '')

    assertEquals(result.next_action?.type, 'payment_element')
    if (result.next_action?.type !== 'payment_element') throw new Error('expected element')
    assertEquals(result.next_action.client_secret, 'pi_9_secret_abc')
    // Publishable, never the secret. This one crosses to a browser.
    assertEquals(result.next_action.publishable_key, 'pk_test_deadbeef')
  } finally {
    restore()
  }
})

Deno.test('the deal id rides on the intent, so the webhook can find its way back', async () => {
  const { seen, restore } = intercept({ id: 'pi_9', client_secret: 'pi_9_secret_abc' })

  try {
    await new StripeProvider(CREDS, '').charge(CHARGE)
    const body = decodeURIComponent(seen.body ?? '')
    assertEquals(body.includes('metadata[deal_id]=deal_1'), true, body)
  } finally {
    restore()
  }
})

Deno.test('an intent with no client secret is refused rather than returned empty', async () => {
  // A client that got `payment_element` with a blank secret would mount an
  // Element that can never confirm, and the buyer would sit in front of a form
  // that does nothing. Better to fail where it can be seen.
  const { restore } = intercept({ id: 'pi_9' })

  try {
    await assertRejects(
      () => new StripeProvider(CREDS, '').charge(CHARGE),
      PayHoldError,
      'no client secret',
    )
  } finally {
    restore()
  }
})

Deno.test('the hosted session is still available, and still 3DS', async () => {
  // Kept for callers that genuinely want to hand the buyer over — Stripe's own
  // receipt and wallet buttons come with it. Deleting it would take that from
  // every tenant at once.
  const { seen, restore } = intercept({ id: 'cs_5', url: 'https://checkout.stripe.com/x' })

  try {
    const result = await new StripeProvider(CREDS, '').chargeHosted(CHARGE)
    assertEquals(seen.url, 'https://api.stripe.com/v1/checkout/sessions')
    assertEquals(result.payment_link, 'https://checkout.stripe.com/x')
    assertEquals(result.provider_ref, 'cs_5')

    const body = decodeURIComponent(seen.body ?? '')
    assertEquals(
      body.includes('payment_intent_data[payment_method_options][card][request_three_d_secure]=any'),
      true,
      body,
    )
  } finally {
    restore()
  }
})

Deno.test('the intent is pinned to the chosen method, not left to the dashboard', async () => {
  const { seen, restore } = intercept({ id: 'pi_9', client_secret: 'pi_9_secret_abc' })

  try {
    await new StripeProvider(CREDS, '').charge(CHARGE)
    const body = decodeURIComponent(seen.body ?? '')

    // `automatic_payment_methods` hands the choice back to Stripe, and the
    // Payment Element then draws a tab for everything the dashboard has on —
    // so a buyer who already picked Card is shown Card, Link, Cash App and
    // PayPal again, one modal deeper. That is the nested picker this whole
    // integration exists to remove.
    assertEquals(body.includes('automatic_payment_methods'), false, body)
    assertEquals(body.includes('payment_method_types[0]=card'), true, body)
  } finally {
    restore()
  }
})
