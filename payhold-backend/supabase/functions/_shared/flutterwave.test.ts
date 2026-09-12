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
import {
  FlutterwaveProvider,
  payoutIdFromTransferReference,
  proxyConfig,
  splitBeneficiaryName,
  toMajor,
  toMinor,
  transferReference,
  type FlutterwaveCredentials,
} from './flutterwave.ts'
import { PayHoldError } from './types.ts'

const CREDS: FlutterwaveCredentials = {
  secret_key: 'FLWSECK_TEST-x',
  public_key: 'FLWPUBK_TEST-x',
  encryption_key: 'FLWSECK_TESTe1a2b3c4d5e6',
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
  const p = new FlutterwaveProvider(CREDS, '', 'test')
  assert(!p.verifySignature('{}', new Headers()))
})

Deno.test('a webhook with the wrong verif-hash is refused', () => {
  const p = new FlutterwaveProvider(CREDS, '', 'test')
  assert(!p.verifySignature('{}', new Headers({ 'verif-hash': 'wrong' })))
  // Same length, one character different — the constant-time path.
  assert(!p.verifySignature('{}', new Headers({ 'verif-hash': 'super-secret-hasX' })))
})

Deno.test('a webhook with the right verif-hash is accepted', () => {
  const p = new FlutterwaveProvider(CREDS, '', 'test')
  assert(p.verifySignature('{}', new Headers({ 'verif-hash': 'super-secret-hash' })))
})

Deno.test('a provider with no configured hash accepts nothing', () => {
  // An unconfigured webhook secret must fail closed. Accepting everything
  // because nothing was set is how the forged-webhook test starts passing 200.
  const p = new FlutterwaveProvider({ ...CREDS, webhook_hash: '' }, '', 'test')
  assert(!p.verifySignature('{}', new Headers({ 'verif-hash': '' })))
  assert(!p.verifySignature('{}', new Headers({ 'verif-hash': 'anything' })))
})

// ---------------------------------------------------------------------------
// Direct charge — the path that lets a buyer finish inside a client's own page
// ---------------------------------------------------------------------------

/** Capture the request without letting it leave. */
function intercept(response: unknown, status = 200) {
  const seen: { url?: string; body?: string; idempotencyKey?: string } = {}
  const original = globalThis.fetch

  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    seen.url = String(url)
    seen.body = init?.body ? String(init.body) : undefined
    seen.idempotencyKey = new Headers(init?.headers).get('idempotency-key') ?? undefined
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
    const result = await new FlutterwaveProvider(CREDS, '', 'test').charge({
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
    const result = await new FlutterwaveProvider(CREDS, '', 'test').charge({
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
    const result = await new FlutterwaveProvider(CREDS, '', 'test').charge({
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
    const result = await new FlutterwaveProvider(CREDS, '', 'test').charge({
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
        new FlutterwaveProvider(CREDS, '', 'test').charge({
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
    const result = await new FlutterwaveProvider(CREDS, '', 'test').charge(CHARGE)
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
    const result = await new FlutterwaveProvider(CREDS, '', 'test').charge({
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
    const result = await new FlutterwaveProvider(CREDS, '', 'test').validate({
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
    const result = await new FlutterwaveProvider(CREDS, '', 'test').validate({
      reference: 'FLW-REF-5',
      otp: '000000',
      method: 'mobile_money',
    })

    assertEquals(result.next_action?.type, 'otp')
  } finally {
    restore()
  }
})

// ---------------------------------------------------------------------------
// Direct card — the §6 exception, and what must stay true inside it
// ---------------------------------------------------------------------------

const CARD = {
  number: '5531 8866 5214 2950',
  cvv: '564',
  expiry_month: '09',
  expiry_year: '32',
  name: 'A Renter',
}

const CARD_CHARGE = { ...CHARGE, method: 'card' as const, three_d_secure: true }

Deno.test('a card never leaves in the clear', async () => {
  const { seen, restore } = intercept({
    status: 'success',
    data: { flw_ref: 'FLW-C1' },
    meta: { authorization: { mode: 'pin' } },
  })

  try {
    await new FlutterwaveProvider(CREDS, '', 'test').charge({ ...CARD_CHARGE, card: CARD })

    assert(seen.url?.includes('/charges?type=card'), seen.url)

    const body = JSON.parse(seen.body ?? '{}')
    // The whole payload is one encrypted string. Anything else in this body
    // would be a card number in a request log somewhere.
    assertEquals(Object.keys(body), ['client'])
    assert(!(seen.body ?? '').includes('5531'), 'the PAN appeared in the body')
    assert(!(seen.body ?? '').includes('564'), 'the CVV appeared in the body')
  } finally {
    restore()
  }
})

Deno.test('a PIN demand is its own action, not an OTP', async () => {
  const { restore } = intercept({
    status: 'success',
    data: { flw_ref: 'FLW-C2' },
    meta: { authorization: { mode: 'pin', instruction: 'Enter your card PIN.' } },
  })

  try {
    const result = await new FlutterwaveProvider(CREDS, '', 'test').charge({
      ...CARD_CHARGE,
      card: CARD,
    })
    // A PIN goes back to the charge endpoint with the card; a code goes to
    // validate-charge. Collapsing the two would post a PIN somewhere useless.
    assertEquals(result.next_action?.type, 'pin')
  } finally {
    restore()
  }
})

Deno.test('an address demand names the fields rather than leaving them to guess', async () => {
  const { restore } = intercept({
    status: 'success',
    data: { flw_ref: 'FLW-C3' },
    meta: { authorization: { mode: 'avs_noauth' } },
  })

  try {
    const result = await new FlutterwaveProvider(CREDS, '', 'test').charge({
      ...CARD_CHARGE,
      card: CARD,
    })
    assertEquals(result.next_action?.type, 'avs')
    if (result.next_action?.type !== 'avs') throw new Error('expected avs')
    assertEquals(result.next_action.fields.includes('zipcode'), true)
  } finally {
    restore()
  }
})

Deno.test('the second attempt does not replay the first response', async () => {
  const first = intercept({ status: 'success', data: {}, meta: { authorization: { mode: 'pin' } } })
  let firstKey: string | undefined
  try {
    await new FlutterwaveProvider(CREDS, '', 'test').charge({ ...CARD_CHARGE, card: CARD })
    firstKey = first.seen.idempotencyKey
  } finally {
    first.restore()
  }

  const second = intercept({ status: 'success', data: { flw_ref: 'r' }, meta: { authorization: { mode: 'otp' } } })
  try {
    await new FlutterwaveProvider(CREDS, '', 'test').charge({
      ...CARD_CHARGE,
      card: CARD,
      authorization: { mode: 'pin', pin: '3310' },
      attempt: 1,
    })
    // Same tx_ref, different key. Sharing one would make the rail hand back the
    // PIN demand again, for ever, to a buyer who has already answered it.
    assert(
      firstKey !== second.seen.idempotencyKey,
      `both attempts used ${firstKey}`,
    )
  } finally {
    second.restore()
  }
})

Deno.test('3DS is a redirect to the issuer, which is the one correct handoff', async () => {
  const { restore } = intercept({
    status: 'success',
    data: { flw_ref: 'FLW-C4' },
    meta: { authorization: { mode: 'redirect', redirect: 'https://bank.test/3ds' } },
  })

  try {
    const result = await new FlutterwaveProvider(CREDS, '', 'test').charge({
      ...CARD_CHARGE,
      card: CARD,
    })
    assertEquals(result.next_action?.type, 'redirect')
    assertEquals(result.payment_link, 'https://bank.test/3ds')
  } finally {
    restore()
  }
})

Deno.test('an account with no encryption key cannot charge a card at all', async () => {
  const { restore } = intercept({ status: 'success', data: {} })
  try {
    await assertRejects(
      () =>
        new FlutterwaveProvider({ ...CREDS, encryption_key: '' }, '', 'test').charge({
          ...CARD_CHARGE,
          card: CARD,
        }),
      PayHoldError,
      'no encryption key',
    )
  } finally {
    restore()
  }
})

Deno.test('a mistyped encryption key is a sentence, not a crypto stack trace', async () => {
  const { restore } = intercept({ status: 'success', data: {} })
  try {
    await assertRejects(
      () =>
        new FlutterwaveProvider({ ...CREDS, encryption_key: 'too-short' }, '', 'test').charge({
          ...CARD_CHARGE,
          card: CARD,
        }),
      PayHoldError,
      'wrong length',
    )
  } finally {
    restore()
  }
})

Deno.test('a card charge with no card still gets the hosted page', async () => {
  const { seen, restore } = intercept({ status: 'success', data: { link: 'https://hosted' } })
  try {
    // The default posture, and the one every other tenant keeps.
    const result = await new FlutterwaveProvider(CREDS, '', 'test').charge(CARD_CHARGE)
    assert(seen.url?.endsWith('/payments'), seen.url)
    assertEquals(result.next_action?.type, 'element')
  } finally {
    restore()
  }
})

// ---------------------------------------------------------------------------
// Bank transfer — the method that never needed a page
// ---------------------------------------------------------------------------

Deno.test('a bank transfer answers with an account, not a page', async () => {
  const { seen, restore } = intercept({
    status: 'success',
    data: { flw_ref: 'FLW-BT1' },
    meta: {
      authorization: {
        transfer_reference: 'FLW-T-1',
        transfer_account: '0067100155',
        transfer_bank: 'Bank of Kigali',
        transfer_amount: 2_277_000,
        account_expiration: '2026-08-10 15:48:00',
        transfer_note: 'N/A',
      },
    },
  })

  try {
    const result = await new FlutterwaveProvider(CREDS, '', 'test').charge({
      ...CHARGE,
      method: 'bank_transfer',
    })

    assert(seen.url?.includes('/charges?type=bank_transfer'), seen.url)
    // Per charge, not permanent — a permanent account cannot tell two bookings
    // apart when the same person pays for both.
    assertEquals(JSON.parse(seen.body ?? '{}').is_permanent, false)

    assertEquals(result.next_action?.type, 'transfer')
    if (result.next_action?.type !== 'transfer') throw new Error('expected transfer')
    assertEquals(result.next_action.account, '0067100155')
    assertEquals(result.next_action.bank, 'Bank of Kigali')
    // Their figure, not ours — they decide the exact amount and a transfer a
    // franc out does not match.
    assertEquals(result.next_action.amount, '2277000')
    // 'N/A' is not a note, it is the absence of one.
    assertEquals(result.next_action.note, null)
    assertEquals(result.payment_link, '')
  } finally {
    restore()
  }
})

Deno.test('a transfer the rail will not mint an account for falls back to the page', async () => {
  // No account means no way to pay by bank in the app. The hosted page is the
  // only remaining route, so taking it beats showing the buyer nothing.
  const { restore } = intercept({ status: 'success', data: { link: 'https://hosted' } })

  try {
    const result = await new FlutterwaveProvider(CREDS, '', 'test').charge({
      ...CHARGE,
      method: 'bank_transfer',
    })
    assertEquals(result.next_action?.type, 'redirect')
    assertEquals(result.payment_link, 'https://hosted')
  } finally {
    restore()
  }
})

Deno.test('verify derives the provider fee from what actually settled', async () => {
  // `amount_settled` is what the wallet actually holds; the fee is charged −
  // settled, not the reported `app_fee`, which can exclude VAT or test-mode
  // differences. 1000 charged, 945 settled → 55 fee, not the reported 35.
  const { restore } = intercept({
    data: {
      id: 12345,
      tx_ref: 'tx_1',
      amount: 1000,
      charged_amount: 1000,
      currency: 'RWF',
      status: 'successful',
      payment_type: 'mobilemoney',
      app_fee: 35,
      amount_settled: 945,
    },
  })

  try {
    const v = await new FlutterwaveProvider(CREDS, '', 'test').verify('tx_1')
    assertEquals(v.fee, 55)
    assertEquals(v.amount, 1000)
    assertEquals(v.currency, 'RWF')
  } finally {
    restore()
  }
})

Deno.test('verify surfaces a card token only once the charge has succeeded', async () => {
  const { restore } = intercept({
    data: {
      id: 12347,
      tx_ref: 'tx_3',
      amount: 1000,
      currency: 'RWF',
      status: 'successful',
      payment_type: 'card',
      card: { type: 'VISA', token: 'flw-token-1' },
    },
  })

  try {
    const v = await new FlutterwaveProvider(CREDS, '', 'test').verify('tx_3')
    assertEquals(v.saved_payment_method, 'flw-token-1')
  } finally {
    restore()
  }
})

Deno.test('mobile money never carries a saved payment method, even if a rail sent one', async () => {
  const { restore } = intercept({
    data: {
      id: 12348,
      tx_ref: 'tx_4',
      amount: 1000,
      currency: 'RWF',
      status: 'successful',
      payment_type: 'mobilemoney',
    },
  })

  try {
    const v = await new FlutterwaveProvider(CREDS, '', 'test').verify('tx_4')
    assertEquals(v.saved_payment_method, null)
  } finally {
    restore()
  }
})

Deno.test('an unsuccessful charge never reports a saved payment method', async () => {
  const { restore } = intercept({
    data: {
      id: 12349,
      tx_ref: 'tx_5',
      amount: 1000,
      currency: 'RWF',
      status: 'pending',
      payment_type: 'card',
      card: { type: 'VISA', token: 'flw-token-2' },
    },
  })

  try {
    const v = await new FlutterwaveProvider(CREDS, '', 'test').verify('tx_5')
    assertEquals(v.saved_payment_method, null)
  } finally {
    restore()
  }
})

Deno.test('chargeSaved sends the saved token to the tokenized-charges endpoint', async () => {
  const { seen, restore } = intercept({ data: { id: 999, status: 'successful' } })

  try {
    const out = await new FlutterwaveProvider(CREDS, '', 'test').chargeSaved({
      token: 'flw-token-1',
      amount: 45_000,
      currency: 'RWF',
      idempotency_key: 'balance:deal_1',
    })
    assertEquals(out.provider_ref, '999')
  } finally {
    restore()
  }

  assertEquals(seen.url?.includes('/tokenized-charges'), true, seen.url)
  const body = JSON.parse(seen.body!)
  assertEquals(body.token, 'flw-token-1')
  // RWF is zero-decimal, so major and minor units are the same number here —
  // the case that has already caught a wrong divide-by-100 once in this file.
  assertEquals(body.amount, 45_000)
})

Deno.test('verify falls back to app_fee when settlement is absent', async () => {
  const { restore } = intercept({
    data: {
      id: 12346,
      tx_ref: 'tx_2',
      amount: 1000,
      currency: 'RWF',
      status: 'successful',
      payment_type: 'mobilemoney',
      app_fee: 35,
    },
  })

  try {
    assertEquals((await new FlutterwaveProvider(CREDS, '', 'test').verify('tx_2')).fee, 35)
  } finally {
    restore()
  }
})

Deno.test('a settlement that lands late is still preferred over app_fee', async () => {
  const original = globalThis.fetch
  // The incident this pins: a Nigerian-issued card charges 7.5% VAT on top of
  // Flutterwave's 3.8% fee, and `app_fee` excludes it — confirmed live, a
  // deal's booked provider_fee came out exactly 3.8% of the charge with no
  // VAT at all, because `amount_settled` was not there yet on the first look.
  // Two calls come back with it absent before the third has it.
  let calls = 0
  globalThis.fetch = (() => {
    calls++
    const amount_settled = calls >= 3 ? 945 : undefined
    return Promise.resolve(
      new Response(JSON.stringify({
        data: {
          id: 12350,
          tx_ref: 'tx_6',
          amount: 1000,
          charged_amount: 1000,
          currency: 'RWF',
          status: 'successful',
          payment_type: 'card',
          app_fee: 35,
          amount_settled,
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    )
  }) as typeof fetch

  try {
    const v = await new FlutterwaveProvider(CREDS, '', 'test').verify('tx_6')
    // 1000 − 945 = 55, not the VAT-excluding app_fee of 35.
    assertEquals(v.fee, 55)
    assertEquals(calls, 3)
  } finally {
    globalThis.fetch = original
  }
})

// ---------------------------------------------------------------------------
// Refunds
// ---------------------------------------------------------------------------

Deno.test('refund reports the confirmed amount_refunded, in the original transaction currency', async () => {
  const { seen, restore } = interceptMany([
    // GET /transactions/verify_by_reference — the original charge, read for
    // its own currency the same way `capture` already trusts it.
    { status: 'success', data: { id: 555, currency: 'RWF' } },
    // POST /transactions/:id/refund
    { status: 'success', data: { id: 777, amount_refunded: 5000 } },
  ])
  try {
    const p = new FlutterwaveProvider(CREDS, '', 'test')
    const result = await p.refund({
      provider_ref: 'tx-ref-1',
      amount: 5000,
      currency: 'RWF',
      idempotency_key: 'idem-refund-1',
    })

    assertEquals(result.provider_ref, '777')
    // RWF is zero-decimal on this rail — 5000 major units is 5000 minor.
    assertEquals(result.amount, 5000)
    assertEquals(result.currency, 'RWF')
    assertEquals(seen[1].method, 'POST')
    assert(seen[1].url.endsWith('/transactions/555/refund'))
  } finally {
    restore()
  }
})

Deno.test('refund with no amount_refunded confirms nothing, rather than guessing', async () => {
  const { restore } = interceptMany([
    { status: 'success', data: { id: 555, currency: 'RWF' } },
    { status: 'success', data: { id: 778 } },
  ])
  try {
    const p = new FlutterwaveProvider(CREDS, '', 'test')
    const result = await p.refund({
      provider_ref: 'tx-ref-2',
      amount: 5000,
      currency: 'RWF',
      idempotency_key: 'idem-refund-2',
    })

    assertEquals(result.amount, undefined)
    assertEquals(result.currency, undefined)
  } finally {
    restore()
  }
})

// ---------------------------------------------------------------------------
// Tokenizing a destination, and asking what became of a transfer
// ---------------------------------------------------------------------------
//
// Both of these were live-payout blockers rather than unit-test gaps: every
// test in this file runs against an intercepted fetch, so a beneficiary
// registered with no `account_bank` and a transfer nothing ever settled both
// looked fine here until somebody read Flutterwave's own documentation.

Deno.test('tokenize: a mobile money beneficiary names its carrier', async () => {
  const { seen, restore } = intercept({
    status: 'success',
    data: { id: 88, account_number: '250788123456' },
  })
  try {
    const p = new FlutterwaveProvider(CREDS, '', 'test')
    const result = await p.tokenize({
      destination: '+250 788 123 456',
      currency: 'RWF',
      country: 'RW',
      network: 'MTN',
      beneficiary_name: 'Aline U.',
    })

    const body = JSON.parse(seen.body!)
    assertEquals(body.account_bank, 'MTN')
    // Normalised: the rail takes digits led by the dialling code, and
    // "+250 788 123 456" is what a person actually types.
    assertEquals(body.account_number, '250788123456')
    // The seller's own name, not the constant this used to send.
    assertEquals(body.beneficiary_name, 'Aline U.')
    assertEquals(result.beneficiary_token, '88')
    // Their `bank_name` is unset for every mobile corridor, so the wallet is
    // the honest word for it.
    assertEquals(result.masked_destination, 'MTN •••• 3456')
  } finally {
    restore()
  }
})

Deno.test('tokenize: a bank beneficiary carries its bank code', async () => {
  const { seen, restore } = intercept({
    status: 'success',
    data: { id: 91, account_number: '0690000031', bank_name: 'Access Bank' },
  })
  try {
    const p = new FlutterwaveProvider(CREDS, '', 'test')
    const result = await p.tokenize({
      destination: '0690000031',
      currency: 'NGN',
      country: 'NG',
      bank_code: '044',
      beneficiary_name: 'Chidi O.',
    })

    const body = JSON.parse(seen.body!)
    assertEquals(body.account_bank, '044')
    assertEquals(body.account_number, '0690000031')
    assertEquals(result.masked_destination, 'Access Bank •••• 0031')
  } finally {
    restore()
  }
})

Deno.test('tokenize: a destination naming neither is refused before it is sent', async () => {
  const { seen, restore } = intercept({ status: 'success', data: { id: 1 } })
  try {
    const p = new FlutterwaveProvider(CREDS, '', 'test')
    await assertRejects(
      () => p.tokenize({ destination: '0788123456', currency: 'RWF', country: 'RW' }),
      PayHoldError,
    )
    // Nothing left the building: the old code sent `account_bank: undefined`
    // here and registered a beneficiary no transfer could reach.
    assertEquals(seen.url, undefined)
  } finally {
    restore()
  }
})

Deno.test('transferStatus: only SUCCESSFUL and FAILED are answers', async () => {
  for (const [reported, expected] of [
    ['SUCCESSFUL', 'paid'],
    ['FAILED', 'failed'],
    ['NEW', 'pending'],
    ['PENDING', 'pending'],
    // Anything we do not recognise waits rather than booking a failure — a
    // seller must never be told their money bounced because we misread a word.
    ['SOMETHING_ELSE', 'pending'],
  ] as const) {
    const { seen, restore } = intercept({ status: 'success', data: { status: reported } })
    try {
      const p = new FlutterwaveProvider(CREDS, '', 'test')
      const result = await p.transferStatus('12345')
      assertEquals(result.status, expected, reported)
      assert(seen.url!.endsWith('/transfers/12345'))
    } finally {
      restore()
    }
  }
})

Deno.test('transferStatus reads the confirmed amount and fee off the transfer', async () => {
  // USD, not RWF — Flutterwave's own `ZERO_DECIMAL` set means a Rwandan franc
  // does not multiply by 100 on the way to minor units, and a currency this
  // test does not exercise elsewhere is what keeps that distinction visible.
  const { restore } = intercept({
    status: 'success',
    data: { status: 'SUCCESSFUL', amount: 100, fee: 2.5, currency: 'USD' },
  })
  try {
    const p = new FlutterwaveProvider(CREDS, '', 'test')
    const result = await p.transferStatus('12345')
    assertEquals(result.status, 'paid')
    assertEquals(result.amount, 10_000)
    assertEquals(result.currency, 'USD')
    assertEquals(result.fee, 250)
  } finally {
    restore()
  }
})

Deno.test('transferStatus reports no fee as null, never zero, when the rail names none', async () => {
  const { restore } = intercept({
    status: 'success',
    data: { status: 'SUCCESSFUL', amount: 100, currency: 'USD' },
  })
  try {
    const p = new FlutterwaveProvider(CREDS, '', 'test')
    const result = await p.transferStatus('12345')
    assertEquals(result.fee, null)
  } finally {
    restore()
  }
})

Deno.test('release reads amount and fee straight off the create-transfer response, when given', async () => {
  const { restore } = intercept({
    status: 'success',
    data: { id: 9099, status: 'SUCCESSFUL', amount: 100, fee: 1.5, currency: 'USD' },
  })
  try {
    const result = await new FlutterwaveProvider(CREDS, '', 'test').release({
      payout_id: 'payout-fee-1',
      beneficiary_token: '4242',
      amount: 10_000,
      currency: 'USD',
      idempotency_key: 'idem-fee-1',
    })
    assertEquals(result.amount, 10_000)
    assertEquals(result.currency, 'USD')
    assertEquals(result.fee, 150)
  } finally {
    restore()
  }
})

// ---------------------------------------------------------------------------
// Transfers in the sandbox — the reference is what makes a mock settle
// ---------------------------------------------------------------------------

const PAYOUT_ID = '7b1f3c6e-2a4d-4e8f-9b0c-1d2e3f4a5b6c'

const PAYOUT = {
  payout_id: PAYOUT_ID,
  beneficiary_token: '4242',
  amount: 45_000,
  currency: 'RWF',
  idempotency_key: `payout:${PAYOUT_ID}`,
}

Deno.test('a test-mode transfer carries the sandbox settle marker', async () => {
  // https://developer.flutterwave.com/v3.0/docs/testing — a mocked transfer
  // stays PENDING forever unless its reference ends with `_PMCK`; `DU_1`
  // behind it is their documented one-minute delay.
  const { seen, restore } = intercept({
    status: 'success',
    data: { id: 9001, status: 'NEW' },
  })
  try {
    const result = await new FlutterwaveProvider(CREDS, '', 'test').release(PAYOUT)
    const body = JSON.parse(seen.body!)
    assertEquals(body.reference, `${PAYOUT_ID}_PMCKDU_1`)
    assert(body.reference.endsWith('_PMCK') || /_PMCKDU_\d+$/.test(body.reference))
    // The id is still the leading part, so the webhook can find the payout.
    assert(body.reference.startsWith(PAYOUT_ID))
    assertEquals(seen.idempotencyKey, `payout:${PAYOUT_ID}`)
    // No `amount`/`currency`/`fee` on this mocked response — undefined and
    // null rather than a guessed figure.
    assertEquals(result, {
      provider_ref: '9001',
      status: 'pending',
      amount: undefined,
      currency: undefined,
      fee: null,
    })
  } finally {
    restore()
  }
})

Deno.test('a live-mode transfer carries the bare payout id and nothing else', async () => {
  const { seen, restore } = intercept({
    status: 'success',
    data: { id: 9002, status: 'NEW' },
  })
  try {
    await new FlutterwaveProvider({ ...CREDS, secret_key: 'FLWSECK-x' }, '', 'live').release(PAYOUT)
    assertEquals(JSON.parse(seen.body!).reference, PAYOUT_ID)
  } finally {
    restore()
  }
})

Deno.test('the reference is a pure function of payout id and mode', () => {
  // Same payout, same mode, same reference on every attempt — which is what a
  // retry after a failed attempt relies on.
  assertEquals(transferReference(PAYOUT_ID, 'test'), transferReference(PAYOUT_ID, 'test'))
  assertEquals(transferReference(PAYOUT_ID, 'live'), PAYOUT_ID)
  assert(transferReference(PAYOUT_ID, 'test') !== PAYOUT_ID)
})

Deno.test('the webhook recovers the payout id from a suffixed or bare reference', () => {
  // Every reference this adapter ever sends, in either mode, round-trips.
  for (const mode of ['test', 'live'] as const) {
    assertEquals(payoutIdFromTransferReference(transferReference(PAYOUT_ID, mode)), PAYOUT_ID, mode)
  }
  // Their other documented markers share the prefix and are stripped the same
  // way — a person testing the failure path by hand still reaches the payout.
  assertEquals(payoutIdFromTransferReference(`${PAYOUT_ID}_PMCK`), PAYOUT_ID)
  assertEquals(payoutIdFromTransferReference(`${PAYOUT_ID}_PMCK_ST_F`), PAYOUT_ID)
  assertEquals(payoutIdFromTransferReference(`${PAYOUT_ID}_PMCK_ST_FDU_1`), PAYOUT_ID)
  assertEquals(payoutIdFromTransferReference(PAYOUT_ID.toUpperCase()), PAYOUT_ID.toUpperCase())
})

Deno.test('the webhook refuses a reference that is not a payout id once the marker is gone', () => {
  for (const garbage of [
    '',
    '_PMCK',
    '_PMCKDU_1',
    'dfs23fhr7ntg0293039_PMCK',
    'not-a-uuid',
    `${PAYOUT_ID}x_PMCK`,
    `${PAYOUT_ID}_pmck`,
    `x${PAYOUT_ID}`,
    `${PAYOUT_ID}; drop table payouts`,
  ]) {
    assertEquals(payoutIdFromTransferReference(garbage), null, JSON.stringify(garbage))
  }
})

// ---------------------------------------------------------------------------
// The outbound proxy — credentials leave the URL and travel as basicAuth
// ---------------------------------------------------------------------------

Deno.test('proxy credentials are split out of the URL into basicAuth', () => {
  assertEquals(proxyConfig('http://flutterwave-proxy:s3cret@203.0.113.7:3128'), {
    url: 'http://203.0.113.7:3128',
    basicAuth: { username: 'flutterwave-proxy', password: 's3cret' },
  })
  // The vendor's own example shape from CLAUDE.md.
  assertEquals(proxyConfig('http://user:pass@us-east-static-01.quotaguard.com:9293'), {
    url: 'http://us-east-static-01.quotaguard.com:9293',
    basicAuth: { username: 'user', password: 'pass' },
  })
})

Deno.test('proxy credentials are decoded, so a password with @ or # arrives literally', () => {
  const { basicAuth } = proxyConfig('http://u%40ser:p%40ss%23word%2F@proxy.example:3128')
  assertEquals(basicAuth, { username: 'u@ser', password: 'p@ss#word/' })
})

Deno.test('a proxy URL without credentials passes only the URL', () => {
  const cfg = proxyConfig('http://proxy.example:3128')
  assertEquals(cfg, { url: 'http://proxy.example:3128' })
  assertEquals('basicAuth' in cfg, false)
  // A path or trailing slash on the input does not survive into the proxy url.
  assertEquals(proxyConfig('https://proxy.example/').url, 'https://proxy.example')
})

Deno.test('the proxy url handed to Deno never carries the credentials', () => {
  const cfg = proxyConfig('http://someone:hunter2@proxy.example:3128')
  assertEquals(cfg.url.includes('hunter2'), false)
  assertEquals(cfg.url.includes('someone'), false)
})

Deno.test('a proxy URL that is not a URL throws rather than being sent', () => {
  // `flutterwaveClient` catches this and logs a fixed sentence — the thrown
  // error quotes the input, which is the one string holding the password.
  for (const bad of [
    'not a url',
    // The scheme forgotten: `new URL` accepts this as an opaque URL whose
    // scheme is the username, and Deno would be handed `flutterwave-proxy://`.
    'flutterwave-proxy:s3cret@host:3128',
    'ftp://user:pass@host:21',
    'http://',
  ]) {
    let threw = false
    try {
      proxyConfig(bad)
    } catch {
      threw = true
    }
    assert(threw, bad)
  }
})

// ---------------------------------------------------------------------------
// Kenya M-Pesa — the one transfer corridor that wants more than a beneficiary
// ---------------------------------------------------------------------------
//
// Read from their create-a-transfer reference on 2026-09-09: `meta.sender`,
// `sender_country`, `first_name`, `last_name` and `mobile_number` are "required
// for … M-Pesa transfers", `meta` is an array of objects, and the last three
// describe the beneficiary. `release` sent no `meta` at all, so every KES
// wallet payout was refused at the rail with the buyer's money collected.

/** Capture every request in order and answer each from the list. */
function interceptMany(responses: unknown[]) {
  const seen: { url: string; method: string; body?: string }[] = []
  const original = globalThis.fetch

  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    seen.push({
      url: String(url),
      method: init?.method ?? 'GET',
      body: init?.body ? String(init.body) : undefined,
    })
    const response = responses[seen.length - 1] ?? { status: 'error', message: 'unexpected call' }
    return Promise.resolve(
      new Response(JSON.stringify(response), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
  }) as typeof fetch

  return { seen, restore: () => { globalThis.fetch = original } }
}

const KES_MOMO_PAYOUT = {
  payout_id: PAYOUT_ID,
  beneficiary_token: '4242',
  amount: 120_000, // KES 1,200.00 — a decimal currency
  currency: 'KES',
  idempotency_key: `payout:${PAYOUT_ID}`,
  rail: 'flutterwave_momo' as const,
  country: 'KE',
  beneficiary_name: 'Akinyi Kimwei',
  sender_name: 'AutoHire Ltd',
  sender_country: 'RW',
}

Deno.test('a KES wallet transfer carries the five M-Pesa meta fields, read off the beneficiary', async () => {
  const { seen, restore } = interceptMany([
    // GET /beneficiaries/4242 — the number stays with the rail, never with us.
    { status: 'success', data: { id: 4242, account_number: '254712345678', bank_code: 'MPS' } },
    // POST /transfers
    { status: 'success', data: { id: 9010, status: 'NEW' } },
  ])
  try {
    const result = await new FlutterwaveProvider(CREDS, '', 'live').release(KES_MOMO_PAYOUT)

    assertEquals(seen.length, 2)
    assertEquals(seen[0].method, 'GET')
    assert(seen[0].url.endsWith('/beneficiaries/4242'))
    assertEquals(seen[1].method, 'POST')
    assert(seen[1].url.endsWith('/transfers'))

    const body = JSON.parse(seen[1].body!)
    assertEquals(body.beneficiary, 4242)
    assertEquals(body.currency, 'KES')
    assertEquals(body.amount, 1200)
    // An array of one object — the transfer shape, not the charge shape.
    assert(Array.isArray(body.meta))
    assertEquals(body.meta, [{
      sender: 'AutoHire Ltd',
      sender_country: 'RW',
      mobile_number: '254712345678',
      first_name: 'Akinyi',
      last_name: 'Kimwei',
    }])
    assertEquals(result, {
      provider_ref: '9010',
      status: 'pending',
      amount: undefined,
      currency: undefined,
      fee: null,
    })
  } finally {
    restore()
  }
})

Deno.test('a RWF wallet transfer carries no meta and asks the rail nothing extra', async () => {
  const { seen, restore } = interceptMany([
    { status: 'success', data: { id: 9011, status: 'NEW' } },
  ])
  try {
    await new FlutterwaveProvider(CREDS, '', 'live').release({
      ...KES_MOMO_PAYOUT,
      currency: 'RWF',
      country: 'RW',
      amount: 45_000,
    })
    // One call: the transfer itself. No beneficiary lookup for a corridor that
    // does not need one.
    assertEquals(seen.length, 1)
    assert(seen[0].url.endsWith('/transfers'))
    const body = JSON.parse(seen[0].body!)
    assertEquals(body.meta, undefined)
    assert(!('meta' in body))
  } finally {
    restore()
  }
})

Deno.test('a KES bank transfer is not an M-Pesa transfer and carries no meta', async () => {
  const { seen, restore } = interceptMany([
    { status: 'success', data: { id: 9012, status: 'NEW' } },
  ])
  try {
    await new FlutterwaveProvider(CREDS, '', 'live').release({
      ...KES_MOMO_PAYOUT,
      rail: 'flutterwave_bank',
    })
    assertEquals(seen.length, 1)
    assert(!('meta' in JSON.parse(seen[0].body!)))
  } finally {
    restore()
  }
})

Deno.test('a legacy caller naming no rail gets the transfer it always got', async () => {
  const { seen, restore } = interceptMany([
    { status: 'success', data: { id: 9013, status: 'NEW' } },
  ])
  try {
    await new FlutterwaveProvider(CREDS, '', 'test').release({ ...PAYOUT, currency: 'KES' })
    assertEquals(seen.length, 1)
    assert(!('meta' in JSON.parse(seen[0].body!)))
  } finally {
    restore()
  }
})

Deno.test('an M-Pesa transfer with no sender on file is refused before anything is sent', async () => {
  const { seen, restore } = interceptMany([])
  try {
    const p = new FlutterwaveProvider(CREDS, '', 'live')
    const err = await assertRejects(
      () => p.release({ ...KES_MOMO_PAYOUT, sender_country: undefined }),
      PayHoldError,
    )
    assertEquals(err.code, 'policy_violation')
    assert(err.message.includes("sender's name and country"))
    assert(err.message.includes('no country on file'))
    // Nothing reached the rail — no lookup, no transfer.
    assertEquals(seen.length, 0)
  } finally {
    restore()
  }
})

Deno.test('an M-Pesa transfer with no beneficiary name is refused before anything is sent', async () => {
  const { seen, restore } = interceptMany([])
  try {
    const p = new FlutterwaveProvider(CREDS, '', 'live')
    const err = await assertRejects(
      () => p.release({ ...KES_MOMO_PAYOUT, beneficiary_name: '   ' }),
      PayHoldError,
    )
    assert(err.message.includes("beneficiary's name"))
    assertEquals(seen.length, 0)
  } finally {
    restore()
  }
})

Deno.test('an M-Pesa transfer whose beneficiary the rail holds no number for is refused, and no transfer is sent', async () => {
  const { seen, restore } = interceptMany([
    { status: 'success', data: { id: 4242 } },
  ])
  try {
    const p = new FlutterwaveProvider(CREDS, '', 'live')
    const err = await assertRejects(() => p.release(KES_MOMO_PAYOUT), PayHoldError)
    assert(err.message.includes('holds no mobile number for beneficiary 4242'))
    // The lookup happened; the transfer did not.
    assertEquals(seen.length, 1)
    assertEquals(seen[0].method, 'GET')
  } finally {
    restore()
  }
})

Deno.test('a beneficiary name splits on the first space, and a single word fills both fields', () => {
  assertEquals(splitBeneficiaryName('Akinyi Kimwei'), { first_name: 'Akinyi', last_name: 'Kimwei' })
  // Everything after the first space is the last name — a compound surname is
  // not truncated to its first word.
  assertEquals(
    splitBeneficiaryName('Jean de Dieu Habimana'),
    { first_name: 'Jean', last_name: 'de Dieu Habimana' },
  )
  // A person with one name is still a person with two required fields.
  assertEquals(splitBeneficiaryName('Wanjiru'), { first_name: 'Wanjiru', last_name: 'Wanjiru' })
  // Stray whitespace is what people type; it is not part of a name.
  assertEquals(splitBeneficiaryName('  Akinyi   Kimwei  '), { first_name: 'Akinyi', last_name: 'Kimwei' })
  // Nothing to split is nothing — the caller refuses rather than inventing one.
  assertEquals(splitBeneficiaryName(''), null)
  assertEquals(splitBeneficiaryName('   '), null)
  assertEquals(splitBeneficiaryName(undefined), null)
})

// ---------------------------------------------------------------------------
// balances() — the clearing split
// ---------------------------------------------------------------------------

Deno.test('balances sums the Collection and Payout wallets into amount; the Collection wallet is reported, not a derived gap', async () => {
  const { restore } = intercept({
    status: 'success',
    data: [{
      currency: 'USD',
      ledger_balance: 100,
      available_balance: 60,
      reserved_balance: 5,
    }],
  })
  try {
    const p = new FlutterwaveProvider(CREDS, '', 'live')
    const [usd] = await p.balances()
    // `amount` is the two wallets summed: 100 Collection + 60 Payout, not
    // `ledger_balance` re-labelled and not either one alone. This is the
    // figure `reconciliation.ts` compares against everything still owed —
    // reading only Collection would under-report the moment Payout holds
    // real money.
    assertEquals(usd.amount, 16_000)
    // `available` is still exactly the Payout wallet — what a disbursement
    // pre-flight check should read before attempting a transfer.
    assertEquals(usd.available, 6_000)
    // No settlement-lag figure exists between two independent wallets, so
    // this is never the Collection/Payout gap re-labelled as "clearing".
    // The Collection wallet, reported as itself — not `amount - available`,
    // and not null. It is money at the rail that cannot fund a payout today,
    // which is what the screen's "not yet available" column means.
    assertEquals(usd.pending, 10_000)
    assertEquals(usd.reserved, 500)
    // Flutterwave's `/balances` names no clearing date.
    assertEquals(usd.available_on, null)
  } finally {
    restore()
  }
})

Deno.test('balances reports available and reserved as null when the rail does not send them', async () => {
  const { restore } = intercept({
    status: 'success',
    data: [{ currency: 'RWF', ledger_balance: 1000 }],
  })
  try {
    const p = new FlutterwaveProvider(CREDS, '', 'live')
    const [rwf] = await p.balances()
    // Only the Collection wallet was reported; the Payout wallet term is 0 by
    // the `?? 0` fallback, so amount is unchanged from reading `ledger_balance`
    // alone — this is the case that was already correct before the fix, and
    // must stay correct after it.
    assertEquals(rwf.amount, 1000)
    // Never zero, never derived from the ledger figure — the rail simply did
    // not send an `available_balance` for this currency.
    assertEquals(rwf.available, null)
    // The Collection wallet is present on this row and RWF is zero-decimal,
    // so it reports 1000 unchanged — the same figure `amount` carries here,
    // because the Payout wallet term is absent.
    assertEquals(rwf.pending, 1000)
    assertEquals(rwf.reserved, null)
    assertEquals(rwf.available_on, null)
  } finally {
    restore()
  }
})

Deno.test('balances sums both wallets even when Payout exceeds Collection', async () => {
  // Two independent wallets, not a settlement-lag pair — `available_balance`
  // (Payout) is under no constraint to stay below `ledger_balance`
  // (Collection): a direct bank top-up straight into Payout, bypassing
  // Collection entirely, would report exactly this shape and it is not a
  // reporting quirk to guard against.
  const { restore } = intercept({
    status: 'success',
    data: [{ currency: 'USD', ledger_balance: 50, available_balance: 80 }],
  })
  try {
    const p = new FlutterwaveProvider(CREDS, '', 'live')
    const [usd] = await p.balances()
    assertEquals(usd.amount, 13_000)
    // Collection is reported as itself even when it is the smaller wallet —
    // there is no clamping and no subtraction, so a Payout-heavy account
    // still shows exactly what sits on each side.
    assertEquals(usd.pending, 5_000)
  } finally {
    restore()
  }
})
