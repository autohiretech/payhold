/**
 * Address parsing, which is the whole of what this module decides.
 *
 * `normaliseIp` sits in front of an `inet` column, and it is the only thing
 * standing between a header an attacker controls and a row that either fails
 * to insert or — worse — inserts something an operator will later read as fact.
 * Everything it is unsure about it drops.
 */

import { assertEquals } from 'jsr:@std/assert@1'
import { clientIp, normaliseIp, payContext } from './request-context.ts'

Deno.test('ordinary v4 and v6 addresses survive', () => {
  assertEquals(normaliseIp('41.186.0.42'), '41.186.0.42')
  assertEquals(normaliseIp('2001:db8::1'), '2001:db8::1')
  assertEquals(normaliseIp('::1'), '::1')
  assertEquals(normaliseIp('  105.178.12.9  '), '105.178.12.9')
})

Deno.test('ports are stripped, in both notations', () => {
  assertEquals(normaliseIp('41.186.0.42:51820'), '41.186.0.42')
  assertEquals(normaliseIp('[2001:db8::1]:443'), '2001:db8::1')
  assertEquals(normaliseIp('[2001:db8::1]'), '2001:db8::1')
})

Deno.test('an octet over 255 is not an address', () => {
  // Postgres would reject this at the column and take the whole row with it,
  // including the event and the user agent, which are still worth having.
  assertEquals(normaliseIp('999.1.1.1'), null)
  assertEquals(normaliseIp('41.186.0.256'), null)
})

Deno.test('nonsense is dropped rather than stored', () => {
  assertEquals(normaliseIp(''), null)
  assertEquals(normaliseIp('   '), null)
  assertEquals(normaliseIp('unknown'), null)
  assertEquals(normaliseIp('41.186.0'), null)
  assertEquals(normaliseIp("'; drop table deals; --"), null)
  assertEquals(normaliseIp('<script>alert(1)</script>'), null)
})

Deno.test('a pathological header cannot make parsing expensive', () => {
  // Length-bounded before the v6 pattern runs. A 10k-character string of
  // colons is the shape that makes a naive regex here quadratic.
  assertEquals(normaliseIp(':'.repeat(10_000)), null)
})

Deno.test('the leftmost x-forwarded-for entry is the client', () => {
  const req = new Request('https://payhold.test/', {
    headers: { 'x-forwarded-for': '41.186.0.42, 10.0.0.1, 172.16.0.4' },
  })
  // Everything after the first entry is a proxy we added, not the buyer.
  assertEquals(clientIp(req), '41.186.0.42')
})

Deno.test('no forwarded header means no address, not a guess', () => {
  assertEquals(clientIp(new Request('https://payhold.test/')), null)
})

Deno.test('a forwarded header full of rubbish yields nothing', () => {
  const req = new Request('https://payhold.test/', {
    headers: { 'x-forwarded-for': 'unknown, 10.0.0.1' },
  })
  assertEquals(clientIp(req), null)
})

Deno.test('observed and attested are kept apart', () => {
  const req = new Request('https://payhold.test/', {
    headers: {
      'x-forwarded-for': '203.0.113.9',
      'user-agent': 'Mozilla/5.0 (Linux; Android 13)',
    },
  })

  const context = payContext(req, { buyer_ip: '41.186.0.42' })

  // The two are different claims and get different `source` values. Collapsing
  // them would let a client's self-report inherit a provider's credibility.
  assertEquals(context.observed, '203.0.113.9')
  assertEquals(context.attested, '41.186.0.42')
  assertEquals(context.userAgent, 'Mozilla/5.0 (Linux; Android 13)')
})

Deno.test('an unparseable attested address does not poison the observed one', () => {
  const req = new Request('https://payhold.test/', {
    headers: { 'x-forwarded-for': '203.0.113.9' },
  })

  const context = payContext(req, { buyer_ip: 'not-an-address' })

  assertEquals(context.attested, null)
  assertEquals(context.observed, '203.0.113.9')
})
