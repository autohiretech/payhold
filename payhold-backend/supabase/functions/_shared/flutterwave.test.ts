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
    await new FlutterwaveProvider(CREDS, '').charge({ ...CARD_CHARGE, card: CARD })

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
    const result = await new FlutterwaveProvider(CREDS, '').charge({
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
    const result = await new FlutterwaveProvider(CREDS, '').charge({
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
    await new FlutterwaveProvider(CREDS, '').charge({ ...CARD_CHARGE, card: CARD })
    firstKey = first.seen.idempotencyKey
  } finally {
    first.restore()
  }

  const second = intercept({ status: 'success', data: { flw_ref: 'r' }, meta: { authorization: { mode: 'otp' } } })
  try {
    await new FlutterwaveProvider(CREDS, '').charge({
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
    const result = await new FlutterwaveProvider(CREDS, '').charge({
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
        new FlutterwaveProvider({ ...CREDS, encryption_key: '' }, '').charge({
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
        new FlutterwaveProvider({ ...CREDS, encryption_key: 'too-short' }, '').charge({
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
    const result = await new FlutterwaveProvider(CREDS, '').charge(CARD_CHARGE)
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
    const result = await new FlutterwaveProvider(CREDS, '').charge({
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
    const result = await new FlutterwaveProvider(CREDS, '').charge({
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
    const v = await new FlutterwaveProvider(CREDS, '').verify('tx_1')
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
    const v = await new FlutterwaveProvider(CREDS, '').verify('tx_3')
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
    const v = await new FlutterwaveProvider(CREDS, '').verify('tx_4')
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
    const v = await new FlutterwaveProvider(CREDS, '').verify('tx_5')
    assertEquals(v.saved_payment_method, null)
  } finally {
    restore()
  }
})

Deno.test('chargeSaved sends the saved token to the tokenized-charges endpoint', async () => {
  const { seen, restore } = intercept({ data: { id: 999, status: 'successful' } })

  try {
    const out = await new FlutterwaveProvider(CREDS, '').chargeSaved({
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
    assertEquals((await new FlutterwaveProvider(CREDS, '').verify('tx_2')).fee, 35)
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
    const v = await new FlutterwaveProvider(CREDS, '').verify('tx_6')
    // 1000 − 945 = 55, not the VAT-excluding app_fee of 35.
    assertEquals(v.fee, 55)
    assertEquals(calls, 3)
  } finally {
    globalThis.fetch = original
  }
})
