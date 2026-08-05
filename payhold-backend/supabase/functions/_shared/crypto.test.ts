/**
 * Run with: deno test --allow-env supabase/functions/_shared/crypto.test.ts
 *
 * These assert the properties that matter rather than the implementation: that
 * a round trip survives, that a tampered blob is REFUSED rather than quietly
 * mangled, that the same input encrypts differently every time, and that a
 * masked key cannot be walked back to the original.
 */

import { assert, assertEquals, assertNotEquals, assertRejects } from 'jsr:@std/assert@1'
import {
  decryptCredentials,
  encryptCredentials,
  generateApiKey,
  generateWebhookSecret,
  hashApiKey,
  secureEquals,
  signPayload,
  verifySignedPayload,
} from './crypto.ts'

/** A deterministic 32-byte key, so tests do not depend on the environment. */
const TEST_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)))

/**
 * `null` unsets the key. Not `undefined` — passing that explicitly still
 * triggers the default parameter, which is how this helper originally set the
 * key in the very test that meant to remove it.
 */
function withKey(value: string | null = TEST_KEY): void {
  if (value === null) Deno.env.delete('CREDENTIALS_KEY')
  else Deno.env.set('CREDENTIALS_KEY', value)
}

const FLW_CREDS = {
  secret_key: 'FLWSECK_TEST-abc123-X',
  public_key: 'FLWPUBK_TEST-def456-X',
  encryption_key: 'FLWSECK_TESTe1a2b3c4',
  webhook_hash: 'my-verif-hash',
}

Deno.test('credentials survive a round trip', async () => {
  withKey()
  const blob = await encryptCredentials(FLW_CREDS)
  assertEquals(await decryptCredentials(blob), FLW_CREDS)
})

Deno.test('the ciphertext contains no plaintext', async () => {
  withKey()
  const blob = await encryptCredentials(FLW_CREDS)
  for (const value of Object.values(FLW_CREDS)) {
    assert(!blob.includes(value), `blob leaked ${value}`)
  }
})

Deno.test('the same credentials encrypt differently every time', async () => {
  withKey()
  // A fresh IV per encryption. Identical blobs would tell an observer with
  // database access that two tenants use the same provider account.
  const a = await encryptCredentials(FLW_CREDS)
  const b = await encryptCredentials(FLW_CREDS)
  assertNotEquals(a, b)
  assertEquals(await decryptCredentials(a), await decryptCredentials(b))
})

Deno.test('a tampered blob is refused, not silently mangled', async () => {
  withKey()
  const blob = await encryptCredentials(FLW_CREDS)
  const [v, iv, data] = blob.split('.')

  // Flip one character of the ciphertext.
  const flipped = data[0] === 'A' ? 'B' : 'A'
  const tampered = `${v}.${iv}.${flipped}${data.slice(1)}`

  await assertRejects(
    () => decryptCredentials(tampered),
    Error,
    'could not be decrypted',
  )
})

Deno.test('a blob cannot be decrypted with a different master key', async () => {
  withKey()
  const blob = await encryptCredentials(FLW_CREDS)

  withKey(btoa(String.fromCharCode(...new Uint8Array(32).fill(9))))
  await assertRejects(() => decryptCredentials(blob), Error, 'could not be decrypted')

  withKey()
})

Deno.test('a missing master key throws instead of encrypting weakly', async () => {
  withKey(null)
  await assertRejects(
    () => encryptCredentials(FLW_CREDS),
    Error,
    'CREDENTIALS_KEY is not set',
  )
  withKey()
})

Deno.test('a wrong-length master key is rejected', async () => {
  withKey(btoa('too short'))
  await assertRejects(
    () => encryptCredentials(FLW_CREDS),
    Error,
    'exactly 32 bytes',
  )
  withKey()
})

Deno.test('malformed blobs are rejected', async () => {
  withKey()
  await assertRejects(() => decryptCredentials('not-a-blob'), Error, 'Malformed')
})

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

Deno.test('api key hashing is stable and one-way', async () => {
  const key = 'ph_test_abc123'
  assertEquals(await hashApiKey(key), await hashApiKey(key))
  assertNotEquals(await hashApiKey(key), await hashApiKey('ph_test_abc124'))
  // 32 bytes of SHA-256 as hex.
  assertEquals((await hashApiKey(key)).length, 64)
})

Deno.test('a generated key is prefixed, masked, and hashed', async () => {
  const key = await generateApiKey('test')
  assert(key.plaintext.startsWith('ph_test_'))
  assertEquals(key.hash, await hashApiKey(key.plaintext))

  // The mask must not be enough to reconstruct the key.
  assert(key.masked.length < key.plaintext.length)
  assert(!key.plaintext.includes(key.masked))
})

Deno.test('generated keys are unique', async () => {
  const keys = await Promise.all(
    Array.from({ length: 50 }, () => generateApiKey('live')),
  )
  assertEquals(new Set(keys.map((k) => k.plaintext)).size, 50)
})

Deno.test('secureEquals matches only identical secrets', async () => {
  assert(await secureEquals('ph_test_abc', 'ph_test_abc'))
  assert(!(await secureEquals('ph_test_abc', 'ph_test_abd')))
  assert(!(await secureEquals('ph_test_abc', 'ph_test_ab')))
})

// ---------------------------------------------------------------------------
// Outbound webhook signatures
// ---------------------------------------------------------------------------

Deno.test('a signed payload verifies', async () => {
  const body = JSON.stringify({ event: 'deal.released', deal_id: 'abc' })
  const { header } = await signPayload('whsec_x', body)
  assert(await verifySignedPayload('whsec_x', body, header))
})

Deno.test('a modified body fails verification', async () => {
  const body = JSON.stringify({ event: 'deal.released', amount: 1000 })
  const { header } = await signPayload('whsec_x', body)
  const tampered = JSON.stringify({ event: 'deal.released', amount: 100000 })
  assert(!(await verifySignedPayload('whsec_x', tampered, header)))
})

Deno.test('the wrong secret fails verification', async () => {
  const body = '{"event":"deal.released"}'
  const { header } = await signPayload('whsec_x', body)
  assert(!(await verifySignedPayload('whsec_y', body, header)))
})

Deno.test('a stale signature is refused even though the HMAC is valid', async () => {
  const body = '{"event":"deal.released"}'
  const old = Math.floor(Date.now() / 1000) - 3600
  const { header } = await signPayload('whsec_x', body, old)

  // The HMAC itself is correct — it is the age that disqualifies it.
  assert(!(await verifySignedPayload('whsec_x', body, header)))
  assert(await verifySignedPayload('whsec_x', body, header, 7200))
})

Deno.test('a garbled signature header is refused', async () => {
  const body = '{}'
  assert(!(await verifySignedPayload('whsec_x', body, 'nonsense')))
  assert(!(await verifySignedPayload('whsec_x', body, 't=abc,v1=def')))
})

Deno.test('webhook secrets are prefixed and masked', () => {
  const s = generateWebhookSecret()
  assert(s.plaintext.startsWith('whsec_'))
  assert(s.masked.length < s.plaintext.length)
})
