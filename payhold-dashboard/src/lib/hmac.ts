/**
 * HMAC-SHA256, synchronously, in about a hundred lines.
 *
 * Invariant 7 says outbound webhooks are signed so a client can verify PayHold
 * really sent them. A mock that emitted a decorative signature string would
 * make that claim untestable — a client could not check it, and neither could
 * we. So the mock signs for real, with the same construction the Edge Function
 * uses via Web Crypto, and `webhooks.test.ts` verifies a delivery the way a
 * client's server would.
 *
 * Why not `crypto.subtle`: it is async, and the mock engine is synchronous all
 * the way down because the money paths it stands in for are transactional. An
 * `await` inside `releaseDeal` would be a lie about the backend's shape.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n))

/**
 * Every index below is a loop counter inside a fixed-size typed array, so
 * `noUncheckedIndexedAccess` has nothing real to warn about — and `!` on each
 * of the sixty-odd reads in the compression function would bury the algorithm.
 */
const u32 = (arr: Uint32Array, i: number): number => arr[i] as number

function sha256(message: Uint8Array): Uint8Array {
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ])

  // Pad to a multiple of 64 bytes: a 0x80 byte, zeros, then the bit length as
  // a big-endian 64-bit integer.
  const bitLength = message.length * 8
  const padded = new Uint8Array(Math.ceil((message.length + 9) / 64) * 64)
  padded.set(message)
  padded[message.length] = 0x80
  new DataView(padded.buffer).setUint32(padded.length - 4, bitLength >>> 0, false)
  new DataView(padded.buffer).setUint32(
    padded.length - 8,
    Math.floor(bitLength / 0x100000000),
    false,
  )

  const w = new Uint32Array(64)
  const view = new DataView(padded.buffer)

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4, false)
    for (let i = 16; i < 64; i++) {
      const x = u32(w, i - 15)
      const y = u32(w, i - 2)
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10)
      w[i] = (u32(w, i - 16) + s0 + u32(w, i - 7) + s1) >>> 0
    }

    let a = u32(h, 0)
    let b = u32(h, 1)
    let c = u32(h, 2)
    let d = u32(h, 3)
    let e = u32(h, 4)
    let f = u32(h, 5)
    let g = u32(h, 6)
    let hh = u32(h, 7)

    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const t1 = (hh + s1 + ch + u32(K, i) + u32(w, i)) >>> 0
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (s0 + maj) >>> 0

      hh = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }

    h[0] = (u32(h, 0) + a) >>> 0
    h[1] = (u32(h, 1) + b) >>> 0
    h[2] = (u32(h, 2) + c) >>> 0
    h[3] = (u32(h, 3) + d) >>> 0
    h[4] = (u32(h, 4) + e) >>> 0
    h[5] = (u32(h, 5) + f) >>> 0
    h[6] = (u32(h, 6) + g) >>> 0
    h[7] = (u32(h, 7) + hh) >>> 0
  }

  const out = new Uint8Array(32)
  const outView = new DataView(out.buffer)
  for (let i = 0; i < 8; i++) outView.setUint32(i * 4, u32(h, i), false)
  return out
}

const BLOCK_SIZE = 64

function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
  const block = new Uint8Array(BLOCK_SIZE)
  block.set(key.length > BLOCK_SIZE ? sha256(key) : key)

  const inner = new Uint8Array(BLOCK_SIZE + message.length)
  const outer = new Uint8Array(BLOCK_SIZE + 32)

  for (let i = 0; i < BLOCK_SIZE; i++) {
    const byte = block[i] as number
    inner[i] = byte ^ 0x36
    outer[i] = byte ^ 0x5c
  }

  inner.set(message, BLOCK_SIZE)
  outer.set(sha256(inner), BLOCK_SIZE)
  return sha256(outer)
}

const encoder = new TextEncoder()

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Raw hex digest. Exported for the test vectors, not for callers. */
export function hmacHex(secret: string, message: string): string {
  return toHex(hmacSha256(encoder.encode(secret), encoder.encode(message)))
}

/**
 * What goes in the `PayHold-Signature` header.
 *
 * The timestamp is inside the signed string, not merely beside it: without
 * that, a captured delivery could be replayed forever and still verify. A
 * client checks the timestamp is recent *and* the digest matches.
 *
 * `timestamp` is unix **seconds**, matching `signPayload` in the backend's
 * `_shared/crypto.ts`. The two must agree byte for byte — a client who
 * implements verification against the mock's documentation and then receives
 * the real thing has to get the same answer.
 */
export function signPayload(secret: string, timestamp: number, body: string): string {
  return `t=${timestamp},v1=${hmacHex(secret, `${timestamp}.${body}`)}`
}

/**
 * The check a client performs on their side. Lives here so the test can prove
 * a delivery verifies, rather than asserting the signer agrees with itself.
 *
 * A real client also bounds the age of the timestamp, which is what actually
 * stops a replay; the backend's `verifySignedPayload` takes a `tolerance` for
 * exactly that. There is none here because the mock's clock is a simulation
 * that routinely jumps thirty days.
 */
export function verifySignature(
  secret: string,
  header: string,
  body: string,
): boolean {
  const timestamp = /t=([^,]+)/.exec(header)?.[1]
  const digest = /v1=([0-9a-f]+)/.exec(header)?.[1]
  if (!timestamp || !digest) return false

  const expected = hmacHex(secret, `${timestamp}.${body}`)

  // Length-independent comparison. The mock has no attacker, but a client
  // copying this shape into their own server does.
  if (expected.length !== digest.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ digest.charCodeAt(i)
  }
  return diff === 0
}
