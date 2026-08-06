/**
 * Password digests for the **mock** backend, and nowhere else.
 *
 * Real accounts are Supabase Auth's: the password is posted to `/auth/v1/token`
 * over TLS, bcrypt-hashed on their side, and never touched by anything in this
 * repository. Nothing here runs in that configuration.
 *
 * So why hash at all in a browser simulation? Because the alternative is a
 * fixture file with a plaintext password in it, and a sign-in screen that
 * compares two strings is a sign-in screen nobody believes. Salted and
 * iterated, on the same synchronous SHA-256 `lib/hmac.ts` already carries for
 * webhook signatures, this behaves like the real thing at the only boundary
 * the mock has: a wrong password is refused and a right one is not.
 *
 * It is emphatically **not** a security control. localStorage is readable by
 * anything running on the page, the iteration count is set for a login that
 * has to feel instant, and the whole store can be edited by hand from the
 * console. Anyone reasoning about real credentials should be reading
 * `payhold-backend`, not this file.
 */

import { hmacHex } from '@/lib/hmac'

/**
 * Enough to make the digest cost something visible in a profiler, few enough
 * that a demo sign-in stays under a frame or two. PBKDF2's real-world counts
 * are three orders of magnitude higher, which is the honest measure of how far
 * this is from one.
 */
const ITERATIONS = 2_000

export function newSalt(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export function hashPassword(password: string, salt: string): string {
  let digest = hmacHex(salt, password)
  for (let i = 1; i < ITERATIONS; i++) {
    digest = hmacHex(salt, digest)
  }
  return digest
}

/**
 * Compare without an early return. There is no attacker here to time the
 * comparison, but this is the shape the backend uses (`secureEquals`), and a
 * mock that demonstrates the careless version teaches the careless version.
 */
export function verifyPassword(password: string, salt: string, hash: string): boolean {
  const expected = hashPassword(password, salt)
  if (expected.length !== hash.length) return false

  let diff = 0
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ hash.charCodeAt(i)
  }
  return diff === 0
}
