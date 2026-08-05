/**
 * Secrets at rest.
 *
 * Three separate jobs live here, and they are deliberately not
 * interchangeable:
 *
 *   encrypt/decrypt  provider credentials — REVERSIBLE, because we have to
 *                    present them to Flutterwave on every charge.
 *   hashApiKey       client API keys — ONE-WAY, because we never need the
 *                    original, only to recognise it.
 *   signPayload      outbound webhooks — HMAC, so clients can prove a
 *                    notification really came from PayHold.
 *
 * Using the wrong one is the whole failure mode: a hashed credential is
 * useless, and a reversibly-stored API key is a breach waiting for a database
 * dump. Nothing here falls back to a default key — a missing master key throws
 * rather than silently encrypting with something guessable.
 */

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** Bump when the key or scheme changes; old blobs keep decrypting. */
const CURRENT_VERSION = 'v1'

// ---------------------------------------------------------------------------
// Master key
// ---------------------------------------------------------------------------

/**
 * The master key encrypting every tenant's provider credentials.
 *
 * Lives in Supabase secrets as base64 of 32 random bytes:
 *   openssl rand -base64 32
 *   npx supabase secrets set CREDENTIALS_KEY=...
 *
 * It is never written to the database. Losing it means every stored credential
 * must be re-entered; leaking it means every one must be rotated.
 */
function masterKeyBytes(version: string): Uint8Array {
  // Versioned lookup so a rotation can decrypt old blobs with the old key
  // while writing new ones with the new key.
  const name = version === CURRENT_VERSION
    ? 'CREDENTIALS_KEY'
    : `CREDENTIALS_KEY_${version.toUpperCase()}`

  const raw = Deno.env.get(name)
  if (!raw) {
    throw new Error(
      `${name} is not set. Provider credentials cannot be stored or read ` +
      `without it. Generate one with: openssl rand -base64 32`,
    )
  }

  const bytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0))
  if (bytes.length !== 32) {
    throw new Error(`${name} must be base64 of exactly 32 bytes, got ${bytes.length}`)
  }
  return bytes
}

async function aesKey(version: string, usage: KeyUsage[]): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    'raw',
    masterKeyBytes(version) as BufferSource,
    { name: 'AES-GCM' },
    false,
    usage,
  )
}

// ---------------------------------------------------------------------------
// Provider credentials — reversible
// ---------------------------------------------------------------------------

const b64 = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))

const unb64 = (s: string): Uint8Array =>
  Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

/**
 * Encrypt a credential bundle for `tenant_provider_accounts`.
 *
 * Output is `v1.<iv>.<ciphertext>`, both base64. AES-GCM is authenticated, so
 * a tampered blob fails to decrypt rather than decrypting to garbage — which
 * matters when the plaintext is about to be sent to a payment provider.
 */
export async function encryptCredentials(
  credentials: Record<string, string>,
): Promise<string> {
  const key = await aesKey(CURRENT_VERSION, ['encrypt'])
  // 96-bit IV, fresh per encryption. Reusing one under the same key would
  // leak plaintext relationships; this is the one parameter never to economise
  // on.
  const iv = crypto.getRandomValues(new Uint8Array(12))

  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      key,
      encoder.encode(JSON.stringify(credentials)) as BufferSource,
    ),
  )

  return `${CURRENT_VERSION}.${b64(iv)}.${b64(ciphertext)}`
}

/** Reverse of `encryptCredentials`. Throws if the blob was altered. */
export async function decryptCredentials(
  blob: string,
): Promise<Record<string, string>> {
  const [version, ivPart, dataPart] = blob.split('.')
  if (!version || !ivPart || !dataPart) {
    throw new Error('Malformed credential blob')
  }

  const key = await aesKey(version, ['decrypt'])

  let plain: ArrayBuffer
  try {
    plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64(ivPart) as BufferSource },
      key,
      unb64(dataPart) as BufferSource,
    )
  } catch {
    // Deliberately vague: whether it was the wrong key or a tampered blob is
    // not something an attacker should learn from the error.
    throw new Error('Credential blob could not be decrypted')
  }

  return JSON.parse(decoder.decode(plain))
}

// ---------------------------------------------------------------------------
// API keys — one-way
// ---------------------------------------------------------------------------

/** Hex SHA-256. Lookup is by this value; the plaintext is never stored. */
export async function hashApiKey(plaintext: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    encoder.encode(plaintext) as BufferSource,
  )
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export interface GeneratedApiKey {
  /** Returned to the client exactly once, at creation. */
  plaintext: string
  /** What the dashboard displays forever after. */
  masked: string
  /** What goes in `api_keys.key_hash`. */
  hash: string
}

/**
 * Mint a client API key.
 *
 * The `ph_live_` / `ph_test_` prefix is not decoration: it lets a leaked key be
 * recognised in a log or a git history, and lets secret scanners match it.
 */
export async function generateApiKey(mode: 'test' | 'live'): Promise<GeneratedApiKey> {
  const random = crypto.getRandomValues(new Uint8Array(24))
  const body = Array.from(random)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')

  const plaintext = `ph_${mode}_${body}`
  return {
    plaintext,
    // Enough to identify which key this is, far too little to reconstruct it.
    masked: `ph_${mode}_${body.slice(0, 4)}…${body.slice(-4)}`,
    hash: await hashApiKey(plaintext),
  }
}

/**
 * Compare two secrets without leaking their contents through timing.
 *
 * A plain `===` on strings returns early at the first differing byte, which
 * over enough requests reveals a prefix. Both values are hashed first so the
 * comparison is over fixed-length data.
 */
export async function secureEquals(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([hashApiKey(a), hashApiKey(b)])
  let diff = 0
  for (let i = 0; i < ha.length; i++) {
    diff |= ha.charCodeAt(i) ^ hb.charCodeAt(i)
  }
  return diff === 0
}

// ---------------------------------------------------------------------------
// Outbound webhook signatures — spec §6
// ---------------------------------------------------------------------------

/**
 * Sign a client notification so they can verify PayHold really sent it.
 *
 * The timestamp is inside the signed material, so a captured payload cannot be
 * replayed a week later against a client checking freshness. Clients verify by
 * recomputing HMAC over `${timestamp}.${body}`.
 */
export async function signPayload(
  secret: string,
  body: string,
  timestamp: number = Math.floor(Date.now() / 1000),
): Promise<{ signature: string; timestamp: number; header: string }> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret) as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )

  const mac = new Uint8Array(
    await crypto.subtle.sign(
      'HMAC',
      key,
      encoder.encode(`${timestamp}.${body}`) as BufferSource,
    ),
  )

  const signature = Array.from(mac)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')

  return {
    signature,
    timestamp,
    // What goes in the `PayHold-Signature` header.
    header: `t=${timestamp},v1=${signature}`,
  }
}

/**
 * Verify an inbound signature we issued — used by tests and by any PayHold
 * component receiving its own notifications.
 *
 * `tolerance` bounds replay: a signature older than this is refused even
 * though the HMAC is perfectly valid.
 */
export async function verifySignedPayload(
  secret: string,
  body: string,
  header: string,
  tolerance = 300,
): Promise<boolean> {
  const parts = Object.fromEntries(
    header.split(',').map((p) => p.split('=').map((s) => s.trim()) as [string, string]),
  )
  const timestamp = Number(parts.t)
  if (!Number.isFinite(timestamp) || !parts.v1) return false

  const age = Math.abs(Math.floor(Date.now() / 1000) - timestamp)
  if (age > tolerance) return false

  const expected = await signPayload(secret, body, timestamp)
  return await secureEquals(expected.signature, parts.v1)
}

/** A webhook signing secret, shown to the client once at creation. */
export function generateWebhookSecret(): { plaintext: string; masked: string } {
  const random = crypto.getRandomValues(new Uint8Array(24))
  const body = Array.from(random)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  return {
    plaintext: `whsec_${body}`,
    masked: `whsec_${body.slice(0, 4)}…${body.slice(-4)}`,
  }
}
