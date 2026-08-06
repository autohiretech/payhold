/**
 * Known-answer tests. A signing routine that is merely self-consistent will
 * pass any test written against itself, so these are RFC 4231's vectors — if
 * our HMAC disagrees with the rest of the world, a client verifying with a
 * standard library would reject deliveries that we consider correctly signed.
 */

import { describe, expect, it } from 'vitest'
import { hmacHex, signPayload, verifySignature } from './hmac'

describe('HMAC-SHA256 against RFC 4231', () => {
  it('matches test case 1', () => {
    expect(hmacHex('\x0b'.repeat(20), 'Hi There')).toBe(
      'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7',
    )
  })

  it('matches test case 2', () => {
    expect(hmacHex('Jefe', 'what do ya want for nothing?')).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    )
  })

})

/**
 * The vectors above only cover short keys and one-block messages. The property
 * that actually matters is agreement with a standard implementation —
 * specifically Web Crypto, which is what the Edge Function signs with. If these
 * two ever diverge, deliveries signed by the mock and by the real backend would
 * not verify the same way, and the seam between them would be a lie.
 */
describe('agrees with Web Crypto', () => {
  const encoder = new TextEncoder()

  async function subtleHmac(secret: string, message: string): Promise<string> {
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    )
    const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(message))
    return Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, '0')).join(
      '',
    )
  }

  const cases: [string, string][] = [
    ['whsec_short', ''],
    ['whsec_short', 'x'],
    // A key past the 64-byte block size has to be hashed down first.
    ['k'.repeat(200), 'a normal looking payload'],
    // 55, 56 and 64 bytes: either side of the length field, and exactly full.
    ['whsec_boundary', 'b'.repeat(55)],
    ['whsec_boundary', 'b'.repeat(56)],
    ['whsec_boundary', 'b'.repeat(64)],
    ['whsec_boundary', 'b'.repeat(1000)],
    ['whsec_unicode', JSON.stringify({ description: 'Kigali → Musanze, 3 days' })],
  ]

  it.each(cases)('matches for case %#', async (secret, message) => {
    expect(hmacHex(secret, message)).toBe(await subtleHmac(secret, message))
  })
})

describe('delivery signatures', () => {
  const secret = 'whsec_test_0123456789'
  const body = JSON.stringify({ event: 'deal.released', deal_id: 'deal_0001' })
  const timestamp = 1_785_920_400

  it('verifies with the secret the client was given', () => {
    const header = signPayload(secret, timestamp, body)
    expect(verifySignature(secret, header, body)).toBe(true)
  })

  it('fails when the body is altered in transit', () => {
    const header = signPayload(secret, timestamp, body)
    const tampered = JSON.stringify({
      event: 'deal.released',
      deal_id: 'deal_9999',
    })
    expect(verifySignature(secret, header, tampered)).toBe(false)
  })

  it('fails under a different secret — this is the forgery case', () => {
    const header = signPayload(secret, timestamp, body)
    expect(verifySignature('whsec_someone_elses', header, body)).toBe(false)
  })

  it('covers the timestamp, so a captured delivery cannot be replayed', () => {
    const header = signPayload(secret, timestamp, body)
    const replayed = header.replace(String(timestamp), String(timestamp + 86_400))
    expect(verifySignature(secret, replayed, body)).toBe(false)
  })

  it('rejects a header that carries no signature at all', () => {
    expect(verifySignature(secret, `t=${timestamp}`, body)).toBe(false)
  })
})
