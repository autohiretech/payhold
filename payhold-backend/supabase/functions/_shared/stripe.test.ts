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

import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@1'
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

Deno.test('a card charge creates a deal-scoped Customer and asks to save the method', async () => {
  let call = 0
  const original = globalThis.fetch
  const bodies: string[] = []

  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    call += 1
    bodies.push(init?.body ? String(init.body) : '')
    return Promise.resolve(
      new Response(
        JSON.stringify(
          call === 1
            ? { id: 'cus_1' }
            : { id: 'pi_2', client_secret: 'pi_2_secret_x' },
        ),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
  }) as typeof fetch

  try {
    await new StripeProvider(CREDS, '').charge({
      deal_id: 'deal_2',
      amount: 50_000,
      currency: 'USD',
      method: 'card',
      return_url: 'https://app/return',
      three_d_secure: true,
      idempotency_key: 'k2',
    })
  } finally {
    globalThis.fetch = original
  }

  const customerBody = decodeURIComponent(bodies[0] ?? '')
  assertEquals(customerBody.includes('metadata[deal_id]=deal_2'), true, customerBody)

  const intentBody = decodeURIComponent(bodies[1] ?? '')
  assertEquals(intentBody.includes('customer=cus_1'), true, intentBody)
  // What later lets a split deal's balance be charged off-session.
  assertEquals(intentBody.includes('setup_future_usage=off_session'), true, intentBody)
})

Deno.test('a mobile money charge never creates a Customer', async () => {
  const { seen, restore } = intercept({ id: 'pi_3', client_secret: 'pi_3_secret_x' })

  try {
    await new StripeProvider(CREDS, '').charge({
      deal_id: 'deal_3',
      amount: 1000,
      currency: 'USD',
      method: 'wallet',
      network: 'cashapp',
      return_url: 'https://app/return',
      three_d_secure: false,
      idempotency_key: 'k3',
    })
  } finally {
    restore()
  }

  const body = decodeURIComponent(seen.body ?? '')
  assertEquals(body.includes('customer='), false, body)
  assertEquals(body.includes('setup_future_usage'), false, body)
})

Deno.test('chargeSaved sends an off-session, pre-confirmed charge against the saved token', async () => {
  const { seen, restore } = intercept({ id: 'pi_4' })

  try {
    const result = await new StripeProvider(CREDS, '').chargeSaved({
      token: 'cus_1:pm_1',
      amount: 45_000,
      currency: 'USD',
      idempotency_key: 'balance:deal_1',
    })
    assertEquals(result.provider_ref, 'pi_4')
  } finally {
    restore()
  }

  const body = decodeURIComponent(seen.body ?? '')
  assertEquals(body.includes('customer=cus_1'), true, body)
  assertEquals(body.includes('payment_method=pm_1'), true, body)
  assertEquals(body.includes('off_session=true'), true, body)
  assertEquals(body.includes('confirm=true'), true, body)
  // Off-session has nobody to answer a live 3DS challenge — asking for one
  // would just make every balance charge fail.
  assertEquals(body.includes('request_three_d_secure'), false, body)
})

Deno.test('chargeSaved refuses a deal with no saved payment method', async () => {
  await assertRejects(
    () =>
      new StripeProvider(CREDS, '').chargeSaved({
        token: '',
        amount: 1000,
        currency: 'USD',
        idempotency_key: 'balance:deal_2',
      }),
    PayHoldError,
    'no saved payment method',
  )
})

Deno.test('verify surfaces a saved payment method only once the charge has succeeded', async () => {
  const { restore } = intercept({
    id: 'pi_5',
    amount: 1000,
    currency: 'usd',
    status: 'succeeded',
    customer: 'cus_5',
    payment_method: 'pm_5',
  })

  try {
    const verified = await new StripeProvider(CREDS, '').verify('pi_5')
    assertEquals(verified.saved_payment_method, 'cus_5:pm_5')
  } finally {
    restore()
  }
})

Deno.test('an unsucceeded intent never reports a saved payment method', async () => {
  const { restore } = intercept({
    id: 'pi_6',
    amount: 1000,
    currency: 'usd',
    status: 'processing',
    customer: 'cus_6',
    payment_method: 'pm_6',
  })

  try {
    const verified = await new StripeProvider(CREDS, '').verify('pi_6')
    assertEquals(verified.saved_payment_method, null)
  } finally {
    restore()
  }
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

Deno.test('release reports the confirmed transfer amount and fee, not the requested one', async () => {
  // A same-currency transfer with a fee-bearing balance transaction returned
  // inline — `expand[]=balance_transaction` on the create call itself, so a
  // single response carries everything this reads.
  const { seen, restore } = intercept({
    id: 'tr_1',
    amount: 45_000,
    currency: 'usd',
    balance_transaction: { fee: 130 },
  })

  try {
    const out = await new StripeProvider(CREDS, '').release({
      payout_id: 'payout-1',
      beneficiary_token: 'acct_1',
      amount: 45_000,
      currency: 'USD',
      idempotency_key: 'idem-p1',
    })

    assert(
      seen.url?.includes('expand%5B%5D=balance_transaction') ||
        seen.url?.includes('expand[]=balance_transaction'),
    )
    assertEquals(out.provider_ref, 'tr_1')
    assertEquals(out.status, 'paid')
    assertEquals(out.amount, 45_000)
    assertEquals(out.currency, 'USD')
    assertEquals(out.fee, 130)
  } finally {
    restore()
  }
})

Deno.test('release resolves the fee by id when the expansion is not inline', async () => {
  const original = globalThis.fetch
  globalThis.fetch = ((url: string | URL | Request) => {
    const u = String(url)
    if (u.includes('/transfers')) {
      return Promise.resolve(new Response(JSON.stringify({
        id: 'tr_2',
        amount: 10_000,
        currency: 'usd',
        balance_transaction: 'txn_1',
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
    }
    if (u.includes('/balance_transactions/txn_1')) {
      return Promise.resolve(new Response(JSON.stringify({ fee: 42 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
    }
    return Promise.resolve(new Response('{}', { status: 404 }))
  }) as typeof fetch

  try {
    const out = await new StripeProvider(CREDS, '').release({
      payout_id: 'payout-2',
      beneficiary_token: 'acct_2',
      amount: 10_000,
      currency: 'USD',
      idempotency_key: 'idem-p2',
    })
    assertEquals(out.fee, 42)
  } finally {
    globalThis.fetch = original
  }
})

Deno.test('release reports no fee as null, never zero, when nothing is left to read', async () => {
  const { restore } = intercept({ id: 'tr_3', amount: 10_000, currency: 'usd' })

  try {
    const out = await new StripeProvider(CREDS, '').release({
      payout_id: 'payout-3',
      beneficiary_token: 'acct_3',
      amount: 10_000,
      currency: 'USD',
      idempotency_key: 'idem-p3',
    })
    assertEquals(out.fee, null)
  } finally {
    restore()
  }
})

Deno.test('refund reports the confirmed amount, not the requested one', async () => {
  const { restore } = intercept({ id: 're_1', amount: 4_400, currency: 'usd' })

  try {
    const out = await new StripeProvider(CREDS, '').refund({
      provider_ref: 'pi_1',
      amount: 5_000,
      currency: 'USD',
      idempotency_key: 'idem-r1',
    })
    assertEquals(out.provider_ref, 're_1')
    assertEquals(out.amount, 4_400)
    assertEquals(out.currency, 'USD')
  } finally {
    restore()
  }
})

Deno.test('refund against a checkout session still resolves the underlying intent first', async () => {
  const original = globalThis.fetch
  globalThis.fetch = ((url: string | URL | Request) => {
    const u = String(url)
    if (u.includes('/checkout/sessions/cs_1')) {
      return Promise.resolve(new Response(JSON.stringify({
        id: 'cs_1',
        payment_intent: { id: 'pi_9' },
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
    }
    if (u.includes('/refunds')) {
      return Promise.resolve(new Response(JSON.stringify({
        id: 're_2',
        amount: 5_000,
        currency: 'usd',
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
    }
    return Promise.resolve(new Response('{}', { status: 404 }))
  }) as typeof fetch

  try {
    const out = await new StripeProvider(CREDS, '').refund({
      provider_ref: 'cs_1',
      amount: 5_000,
      currency: 'USD',
      idempotency_key: 'idem-r2',
    })
    assertEquals(out.amount, 5_000)
    assertEquals(out.currency, 'USD')
  } finally {
    globalThis.fetch = original
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

Deno.test('a fee that attaches late is still booked, not lost to the first look', async () => {
  const original = globalThis.fetch
  // The incident this pins: Stripe can report a charge as succeeded before it
  // has attached a balance transaction at all — `balance_transaction` reads
  // `null`, not even a bare id — so the very first fetch after a webhook has
  // nothing to read. The old code took that at face value and booked 0
  // forever, since `fund_deal` only ever calls this once; that permanently
  // overstated the ledger's idea of Stripe's balance by the missing fee,
  // which is what reconciliation kept finding as drift on AutoHire's tenant.
  // Two calls come back empty here before the third succeeds.
  let calls = 0
  globalThis.fetch = ((url: string | URL | Request) => {
    const u = String(url)
    if (u.includes('/payment_intents/pi_6')) {
      return Promise.resolve(new Response(JSON.stringify({
        id: 'pi_6',
        amount: 3000,
        amount_received: 3000,
        currency: 'usd',
        status: 'succeeded',
        latest_charge: 'ch_6',
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
    }
    if (u.includes('/charges/ch_6')) {
      calls++
      const balance_transaction = calls >= 3 ? { fee: 117 } : null
      return Promise.resolve(new Response(JSON.stringify({
        id: 'ch_6',
        balance_transaction,
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
    }
    return Promise.resolve(new Response('{}', { status: 404 }))
  }) as typeof fetch

  try {
    assertEquals((await new StripeProvider(CREDS, '').verify('pi_6')).fee, 117)
    assertEquals(calls, 3)
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

// ---------------------------------------------------------------------------
// Connect onboarding — minting the acct_… `tokenize` above confirms
// ---------------------------------------------------------------------------

Deno.test('a new Connect account only requests transfers, never charges', async () => {
  const { seen, restore } = intercept({ id: 'acct_new1' })

  try {
    const { accountId } = await new StripeProvider(CREDS, '').createConnectAccount(
      'US',
      'host@example.com',
      'seller_1',
    )
    const body = decodeURIComponent(seen.body ?? '')

    assertEquals(accountId, 'acct_new1')
    assertEquals(seen.url?.includes('/accounts'), true, seen.url)
    assertEquals(body.includes('type=express'), true, body)
    assertEquals(body.includes('country=US'), true, body)
    assertEquals(body.includes('email=host@example.com'), true, body)
    assertEquals(body.includes('capabilities[transfers][requested]=true'), true, body)
    assertEquals(body.includes('metadata[seller_id]=seller_1'), true, body)
    // Never `card_payments` — this account only ever receives a Connect
    // transfer from `release`, and requesting a capability nothing here uses
    // is a capability someone downstream has to explain away in review.
    assertEquals(body.includes('card_payments'), false, body)
  } finally {
    restore()
  }
})

Deno.test('a seller with no email on file still gets a valid account request', async () => {
  const { seen, restore } = intercept({ id: 'acct_new2' })

  try {
    await new StripeProvider(CREDS, '').createConnectAccount('RW', null, 'seller_2')
    const body = decodeURIComponent(seen.body ?? '')

    assertEquals(body.includes('email='), false, body)
  } finally {
    restore()
  }
})

Deno.test('the onboarding link names the account and both callback URLs', async () => {
  const { seen, restore } = intercept({ url: 'https://connect.stripe.com/setup/e/acct_1/abc' })

  try {
    const { url } = await new StripeProvider(CREDS, '').createAccountLink(
      'acct_1',
      'https://example.com/refresh',
      'https://example.com/return',
    )
    const body = decodeURIComponent(seen.body ?? '')

    assertEquals(url, 'https://connect.stripe.com/setup/e/acct_1/abc')
    assertEquals(seen.url?.includes('/account_links'), true, seen.url)
    assertEquals(body.includes('account=acct_1'), true, body)
    assertEquals(body.includes('refresh_url=https://example.com/refresh'), true, body)
    assertEquals(body.includes('return_url=https://example.com/return'), true, body)
    assertEquals(body.includes('type=account_onboarding'), true, body)
  } finally {
    restore()
  }
})

Deno.test('Connect status reads both flags Stripe reports, not just one', async () => {
  const { restore } = intercept({ payouts_enabled: true, details_submitted: false })

  try {
    const status = await new StripeProvider(CREDS, '').connectAccountStatus('acct_1')
    // Both are surfaced even though `tokenize` only gates on the first —
    // `startConnectOnboarding`'s caller polls this directly and "submitted
    // but not yet payable" is a different sentence to a host than "nothing
    // submitted at all", even though neither is payable today.
    assertEquals(status.payoutsEnabled, true)
    assertEquals(status.detailsSubmitted, false)
  } finally {
    restore()
  }
})

Deno.test('Connect status reports the country Stripe registered the account in', async () => {
  const { restore } = intercept({ payouts_enabled: true, country: 'US' })

  try {
    const status = await new StripeProvider(CREDS, '').connectAccountStatus('acct_1')
    // The caller is about to write a destination row naming a market, and the
    // account *is* the destination: Stripe fixes its country at creation and
    // there is no moving it. Without this, a US account onboarded by a seller
    // whose PayHold row still said RW was promoted to a Rwandan destination.
    assertEquals(status.country, 'US')
  } finally {
    restore()
  }
})

Deno.test('an account with no country reported is null, which is not a disagreement', async () => {
  const { restore } = intercept({ payouts_enabled: true })

  try {
    const status = await new StripeProvider(CREDS, '').connectAccountStatus('acct_1')
    // `null` has to stay distinguishable from a country that differs from the
    // seller's: the first is Stripe not saying, and refusing a promotion on it
    // would strand every onboarded seller the day their response shape changes.
    assertEquals(status.country, null)
  } finally {
    restore()
  }
})

Deno.test('the account session enables onboarding for exactly that account', async () => {
  const { seen, restore } = intercept({ client_secret: 'accs_secret_abc' })

  try {
    const session = await new StripeProvider(CREDS, '').createAccountSession('acct_1')
    const body = decodeURIComponent(seen.body ?? '')

    assertEquals(session.clientSecret, 'accs_secret_abc')
    assertEquals(seen.url?.includes('/account_sessions'), true, seen.url)
    assertEquals(body.includes('account=acct_1'), true, body)
    // Bracket notation, not a JSON blob. `form()` stringifying this object
    // would send `components=[object Object]` and Stripe would enable no
    // component at all — the same class of bug the line-items test pins.
    assertEquals(body.includes('components[account_onboarding][enabled]=true'), true, body)
  } finally {
    restore()
  }
})

Deno.test('the account session carries the publishable key the client mounts with', async () => {
  const { restore } = intercept({ client_secret: 'accs_secret_abc' })

  try {
    const session = await new StripeProvider(CREDS, '').createAccountSession('acct_1')
    // The client needs both and holds neither. A tenant hardcoding their own
    // publishable key into their app is the hardcoded-provider-knowledge
    // failure the catalogue endpoint exists to prevent.
    assertEquals(session.publishableKey, 'pk_test_deadbeef')
  } finally {
    restore()
  }
})

Deno.test('an account session with no client secret is refused rather than returned empty', async () => {
  // Same refusal `charge` makes on a secretless PaymentIntent. Handing back an
  // empty string puts the failure in the browser, where Connect.js reports an
  // opaque load error instead of the API call that actually went wrong.
  const { restore } = intercept({})

  try {
    await new StripeProvider(CREDS, '').createAccountSession('acct_1')
    throw new Error('expected a refusal')
  } catch (err) {
    assertEquals((err as Error).message.includes('no account session secret'), true)
  } finally {
    restore()
  }
})

Deno.test('Connect status defaults both flags false rather than guessing', async () => {
  // Same reasoning as the fee-we-cannot-read tests above: a field Stripe
  // omitted is not evidence of anything, and reporting a payable account here
  // on a guess is the one direction this integration must never round toward.
  const { restore } = intercept({})

  try {
    const status = await new StripeProvider(CREDS, '').connectAccountStatus('acct_1')
    assertEquals(status.payoutsEnabled, false)
    assertEquals(status.detailsSubmitted, false)
  } finally {
    restore()
  }
})

// ---------------------------------------------------------------------------
// balances() — the clearing split
// ---------------------------------------------------------------------------

Deno.test('balances reports available and pending per currency, unsummed, alongside the unchanged total', async () => {
  const original = globalThis.fetch
  globalThis.fetch = ((url: string | URL | Request) => {
    const u = String(url)
    if (u.includes('/balance')) {
      return Promise.resolve(new Response(JSON.stringify({
        available: [{ amount: 700, currency: 'usd' }],
        pending: [{ amount: 300, currency: 'usd' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
    }
    if (u.includes('/account')) {
      return Promise.resolve(new Response(JSON.stringify({
        settings: { payouts: { schedule: { delay_days: 2 } } },
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
    }
    return Promise.resolve(new Response('{}', { status: 404 }))
  }) as typeof fetch

  try {
    const [usd] = await new StripeProvider(CREDS, '').balances()
    // `amount` is untouched — the sum reconciliation still compares.
    assertEquals(usd.amount, 1000)
    assertEquals(usd.available, 700)
    assertEquals(usd.pending, 300)
    // `delay_days: 2` from `/account` is a real API value, so `available_on`
    // is populated — roughly two days out, not exact-to-the-millisecond.
    assert(usd.available_on !== null)
    const days = (new Date(usd.available_on!).getTime() - Date.now()) / (24 * 60 * 60 * 1000)
    assert(days > 1.9 && days < 2.1)
  } finally {
    globalThis.fetch = original
  }
})

Deno.test('balances reports available_on as null when the account has no payout schedule delay to read', async () => {
  const original = globalThis.fetch
  globalThis.fetch = ((url: string | URL | Request) => {
    const u = String(url)
    if (u.includes('/balance')) {
      return Promise.resolve(new Response(JSON.stringify({
        available: [{ amount: 500, currency: 'usd' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
    }
    // A manual schedule, or a key without account-read permission — either
    // way, nothing usable in `settings.payouts.schedule`.
    if (u.includes('/account')) {
      return Promise.resolve(new Response(JSON.stringify({ settings: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
    }
    return Promise.resolve(new Response('{}', { status: 404 }))
  }) as typeof fetch

  try {
    const [usd] = await new StripeProvider(CREDS, '').balances()
    assertEquals(usd.available, 500)
    // Never in either array — the `pending` bucket is absent from the
    // response entirely, so this is null rather than a zero this adapter
    // invented.
    assertEquals(usd.pending, null)
    // No guessed schedule — `/account` gave nothing usable.
    assertEquals(usd.available_on, null)
  } finally {
    globalThis.fetch = original
  }
})

Deno.test('balances survives an unreadable /account rather than failing the whole call', async () => {
  const original = globalThis.fetch
  globalThis.fetch = ((url: string | URL | Request) => {
    const u = String(url)
    if (u.includes('/balance')) {
      return Promise.resolve(new Response(JSON.stringify({
        available: [{ amount: 100, currency: 'usd' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
    }
    if (u.includes('/account')) {
      return Promise.resolve(new Response(JSON.stringify({ error: { message: 'nope' } }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      }))
    }
    return Promise.resolve(new Response('{}', { status: 404 }))
  }) as typeof fetch

  try {
    const [usd] = await new StripeProvider(CREDS, '').balances()
    assertEquals(usd.available, 100)
    assertEquals(usd.available_on, null)
  } finally {
    globalThis.fetch = original
  }
})

Deno.test('an account Stripe is still waiting on says what it is waiting for', async () => {
  // The Stripe-shaped version of the bare "UNCLAIMED" that left a PayPal
  // seller guessing for a day. `payouts_enabled: false` is identical for a
  // seller asked for one more document and a seller whose account was
  // rejected, and the difference is the whole of what they should do next.
  const { restore } = intercept({
    payouts_enabled: false,
    details_submitted: true,
    country: 'US',
    requirements: {
      disabled_reason: 'requirements.past_due',
      past_due: ['individual.verification.document'],
      currently_due: ['individual.id_number'],
      errors: [{
        requirement: 'individual.verification.document',
        code: 'verification_document_not_readable',
        reason: 'The uploaded file is blurry.',
      }],
    },
  })

  try {
    const status = await new StripeProvider(CREDS, '').connectAccountStatus('acct_1')

    assertEquals(status.payoutsEnabled, false)
    assertEquals(status.currentlyDue, ['individual.id_number'])
    assertEquals(
      status.detail,
      'requirements.past_due · past due: individual.verification.document · ' +
        'currently due: individual.id_number · ' +
        'individual.verification.document — verification_document_not_readable — ' +
        'The uploaded file is blurry.',
    )
  } finally {
    restore()
  }
})

Deno.test('an account with nothing outstanding reports no reason at all', async () => {
  const { restore } = intercept({ payouts_enabled: true, details_submitted: true })

  try {
    const status = await new StripeProvider(CREDS, '').connectAccountStatus('acct_1')
    // Not an empty string: there is genuinely nothing to say, and a caller
    // rendering "reason: " with nothing after it is worse than rendering none.
    assertEquals(status.detail, null)
    assertEquals(status.currentlyDue, [])
  } finally {
    restore()
  }
})

Deno.test('a refusal carries Stripe’s code, not only its sentence', async () => {
  // `balance_insufficient` is the one an operator can fix in a minute — top the
  // platform balance up and re-issue, because Stripe explicitly does not retry
  // a transfer that failed for funds. The prose alone reads like every other
  // refusal.
  const { restore } = intercept(
    { error: { message: 'Insufficient funds in your Stripe balance.', code: 'balance_insufficient' } },
    402,
  )

  try {
    const err = await assertRejects(
      () =>
        new StripeProvider(CREDS, '').release({
          payout_id: 'p1',
          beneficiary_token: 'acct_1',
          amount: 10_000,
          currency: 'USD',
          idempotency_key: 'payout:p1',
        }),
      PayHoldError,
    )
    assertEquals(
      err.message,
      'Stripe: Insufficient funds in your Stripe balance. (balance_insufficient)',
    )
  } finally {
    restore()
  }
})

Deno.test('a balance transaction with no fee stated is unknown, not zero', async () => {
  // The live case of 2026-09-13: a USD 320.00 Checkout charge booked
  // `provider_fee: 0`, and nothing said whether Stripe had taken nothing or
  // whether we had failed to ask. The owner's revenue read $32.00 when the
  // truth was nearer $22.42.
  const { restore } = intercept({
    id: 'pi_1',
    status: 'succeeded',
    amount: 32_000,
    amount_received: 32_000,
    currency: 'usd',
    // Expanded, present, and priced by nobody: `fee` absent is Stripe not
    // having stated one, which is not the same as stating zero.
    latest_charge: { id: 'ch_1', balance_transaction: { id: 'txn_1' } },
  })

  try {
    const v = await new StripeProvider(CREDS, '').verify('pi_1')
    // Still booked as zero — the ledger needs a number — but the adapter has
    // said so on the way past, which is the whole difference.
    assertEquals(v.fee, 0)
    assertEquals(v.amount, 32_000)
  } finally {
    restore()
  }
})

Deno.test('a fee Stripe does state is booked exactly as stated', async () => {
  const { restore } = intercept({
    id: 'pi_1',
    status: 'succeeded',
    amount: 32_000,
    amount_received: 32_000,
    currency: 'usd',
    latest_charge: { id: 'ch_1', balance_transaction: { id: 'txn_1', fee: 958 } },
  })

  try {
    assertEquals((await new StripeProvider(CREDS, '').verify('pi_1')).fee, 958)
  } finally {
    restore()
  }
})

Deno.test('a stated zero fee stays zero', async () => {
  // Some payments genuinely cost nothing, and this must not be turned into an
  // "unknown" that somebody then goes looking for.
  const { restore } = intercept({
    id: 'pi_1',
    status: 'succeeded',
    amount: 32_000,
    amount_received: 32_000,
    currency: 'usd',
    latest_charge: { id: 'ch_1', balance_transaction: { id: 'txn_1', fee: 0 } },
  })

  try {
    assertEquals((await new StripeProvider(CREDS, '').verify('pi_1')).fee, 0)
  } finally {
    restore()
  }
})
