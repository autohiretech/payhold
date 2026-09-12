/**
 * Which handlers an API key can reach — pinned from the source, so that a new
 * one is a decision somebody made rather than something `requireRole` let slip.
 *
 * `requireRole` returns early for `caller.kind === 'api_key'` (`_shared/auth.ts`):
 * a key has no role, and most of the API exists to be called by a client's
 * server. That is right for deals and sellers and wrong for anything that
 * decides where money or events go. Every handler that is a person's act has
 * therefore had to refuse a key itself, before `requireRole` — and
 * `webhook-endpoints` did not: any key could register its own URL, receiving
 * every event with a signing secret of its choosing, or disable the client's.
 *
 * So this file inventories every `requireRole(caller …)` in a function a key
 * can authenticate to, and holds each to one of two answers:
 *
 *   - it refuses a key earlier in the same handler, or
 *   - it is on `KEY_REACHABLE`, with the reason a program may do it.
 *
 * The allowlist is checked in both directions — an entry whose handler has
 * since gained a guard, or no longer exists, fails too — so the list stays a
 * true description rather than a record of what was once true.
 *
 * Nothing here runs a function (each starts a server on import); it reads them.
 * No database, so it is fast and runs with the rest of `npm test`.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const FUNCTIONS = fileURLToPath(new URL('../supabase/functions/', import.meta.url))

/**
 * Handlers a key may reach on purpose, keyed `<function> <handler>` — the
 * handler being the enclosing `async function`, or `router <METHOD>` for a
 * `case` inside `Deno.serve`.
 */
const KEY_REACHABLE: Record<string, string> = {
  'disputes open':
    'A platform opens a dispute on behalf of its buyer; the parties act through the client.',
  'disputes makeOffer': 'Offers are made by a party, and parties reach PayHold through the client.',
  'disputes respondOffer': 'Accepting or declining an offer is a party\'s act, relayed by the client.',
  'disputes withdrawOffer': 'Withdrawing an offer is a party\'s act, relayed by the client.',
  'disputes addEvidence': 'Evidence comes from the parties, through the client that holds them.',
  'payouts retry':
    'Re-sending a payout a provider refused is not a judgement; it refuses held payouts, which only a person clears.',
  'webhook-endpoints retryDelivery':
    'Re-arms a delivery to an endpoint a signed-in person registered, signed with the secret PayHold holds — a client recovering from its own outage may ask.',
}

/**
 * A key is refused before the role check — a condition that ends the handler
 * for a key, not merely a mention of `caller.kind` (`const viaApiKey = …` is not
 * a refusal). Shared refusers are accepted by name, and each named one is itself
 * checked to throw for a key (`refusers throw for a key`, below).
 */
const KEY_REFUSAL = new RegExp(
  [
    String.raw`if\s*\(\s*caller\.kind\s*!==\s*'dashboard'\s*\)\s*\{?\s*throw\b`,
    String.raw`if\s*\(\s*caller\.kind\s*===\s*'api_key'\s*\)\s*\{?\s*(?:throw|return)\b`,
    String.raw`if\s*\(\s*req\.headers\.get\('x-api-key'\)\s*\)\s*\{?\s*throw\b`,
    String.raw`\b(refuseApiKey\w*)\(\s*caller\s*\)`,
  ].join('|'),
)

/** Every shared `refuseApiKey…` helper a handler calls, and the file defining it. */
function refusersInUse(): string[] {
  const names = new Set<string>()
  for (const name of functionNames()) {
    for (const m of source(name).matchAll(/\b(refuseApiKey\w*)\(\s*caller\s*\)/g)) names.add(m[1])
  }
  return [...names].sort()
}

/** The function authenticates API keys at all. */
const ACCEPTS_KEYS = /\bresolveCaller\(|\bcallerFromApiKey\(/

interface Site {
  key: string
  line: number
  guarded: boolean
}

function functionNames(): string[] {
  return readdirSync(FUNCTIONS, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('_') && d.name !== 'node_modules')
    .map((d) => d.name)
    .filter((name) => existsSync(join(FUNCTIONS, name, 'index.ts')))
    .sort()
}

function source(name: string): string {
  return readFileSync(join(FUNCTIONS, name, 'index.ts'), 'utf8')
}

/** Every role check in one function, with the handler it sits in. */
function roleChecks(name: string, src: string): Site[] {
  const lines = src.split('\n')
  const sites: Site[] = []
  let handler = 'router'
  let method = ''
  let scopeStart = 0

  lines.forEach((line, i) => {
    const fn = line.match(/^(?:export\s+)?async function (\w+)\s*\(/)
    if (fn) {
      handler = fn[1]
      method = ''
      scopeStart = i
    }
    if (/^Deno\.serve\(/.test(line)) {
      handler = 'router'
      method = ''
      scopeStart = i
    }
    const branch = line.match(/^\s*case '(GET|POST|PATCH|PUT|DELETE)':/)
    if (branch && handler === 'router') {
      method = branch[1]
      scopeStart = i
    }
    if (/\brequireRole\(caller\b/.test(line)) {
      const before = lines.slice(scopeStart, i).join('\n')
      sites.push({
        key: `${name} ${handler === 'router' && method ? `router ${method}` : handler}`,
        line: i + 1,
        guarded: KEY_REFUSAL.test(before),
      })
    }
  })
  return sites
}

function keyReachableRoleChecks(): Site[] {
  return functionNames().flatMap((name) => {
    const src = source(name)
    return ACCEPTS_KEYS.test(src) ? roleChecks(name, src) : []
  })
}

describe('API key boundaries', () => {
  test('the premise: requireRole lets an API key through', () => {
    // If this changes, every guard below is belt-and-braces rather than the
    // only thing standing between a key and a person's act — rethink the file.
    const auth = readFileSync(join(FUNCTIONS, '_shared', 'auth.ts'), 'utf8')
    expect(auth).toMatch(
      /export function requireRole\([^)]*\)[^{]*\{\s*if \(caller\.kind === 'api_key'\) return/,
    )
  })

  test('the inventory finds role checks at all', () => {
    // A parser that silently matched nothing would pass everything below.
    const sites = keyReachableRoleChecks()
    expect(sites.length).toBeGreaterThan(10)
    expect(sites.map((s) => s.key)).toContain('webhook-endpoints router POST')
  })

  test('every role check a key can reach refuses the key first, or is allowlisted with a reason', () => {
    const unexplained = keyReachableRoleChecks()
      .filter((s) => !s.guarded && !(s.key in KEY_REACHABLE))
      .map((s) => `${s.key} (index.ts:${s.line})`)
    expect(
      unexplained,
      'These handlers are reachable with an API key because requireRole lets keys through. ' +
        "Refuse a key before requireRole (`if (caller.kind !== 'dashboard') throw …`), " +
        'or add the handler to KEY_REACHABLE with the reason a program may do it.',
    ).toEqual([])
  })

  test('the allowlist describes the code as it is', () => {
    const sites = keyReachableRoleChecks()
    for (const key of Object.keys(KEY_REACHABLE)) {
      const matching = sites.filter((s) => s.key === key)
      expect(matching, `${key} is allowlisted but has no role check any more`).not.toEqual([])
      expect(
        matching.every((s) => !s.guarded),
        `${key} now refuses API keys — remove it from KEY_REACHABLE`,
      ).toBe(true)
    }
  })

  test('webhook endpoints are registered and disabled by a person, never a key', () => {
    const sites = roleChecks('webhook-endpoints', source('webhook-endpoints'))
    for (const key of ['webhook-endpoints router POST', 'webhook-endpoints router DELETE']) {
      const site = sites.find((s) => s.key === key)
      expect(site, `${key} has no role check`).toBeDefined()
      expect(site!.guarded, `${key} must refuse an API key`).toBe(true)
    }
  })

  test('the other doors that decide where money or events go refuse a key', () => {
    // Read per function rather than from the key-reachable inventory, so a door
    // is pinned even where its function authenticates with a session today.
    for (const key of [
      'api-keys router',
      'settings router',
      'payouts approveReview',
      'payouts hold',
      // 'balance recordExternalTransfer' stood here until the handler was
      // removed (2026-09-12). It was on this list because a claim that money
      // moved somewhere PayHold cannot check is a person's statement, and a
      // client's server filing them could have balanced its own books against
      // us. The door is gone rather than guarded, which is the stronger form of
      // the same protection — but only while it stays gone: if
      // POST /balance/external-transfers ever comes back, put this line back
      // with it.
      'account resetSandbox',
      'ai-decisions router',
    ]) {
      const name = key.split(' ')[0]
      const site = roleChecks(name, source(name)).find((s) => s.key === key)
      expect(site, `${key} has no role check`).toBeDefined()
      expect(site!.guarded, `${key} must refuse an API key`).toBe(true)
    }
  })

  test('refusers throw for a key', () => {
    // A shared helper counts as a refusal above only because it throws for a
    // key; pin that, so renaming its body into a no-op cannot pass silently.
    const shared = readdirSync(join(FUNCTIONS, '_shared'))
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .map((f) => readFileSync(join(FUNCTIONS, '_shared', f), 'utf8'))
      .join('\n')
    const refusers = refusersInUse()
    expect(refusers).toContain('refuseApiKeyOnAiDecisions')
    for (const name of refusers) {
      expect(
        shared,
        `${name} must return for a non-key caller and throw for a key`,
      ).toMatch(
        new RegExp(
          String.raw`export function ${name}\([^)]*\)[^{]*\{\s*if \(caller\.kind !== 'api_key'\) return\s*throw\b`,
        ),
      )
    }
  })

  test('provider credentials are never reachable with a key', () => {
    // Connecting Stripe or Flutterwave decides whose account buyers pay into.
    // It authenticates with a session only, so a key never gets as far as a
    // role check there.
    const src = source('provider-accounts')
    expect(src).not.toMatch(ACCEPTS_KEYS)
    expect(src).toMatch(/\bcallerFromJwt\(/)
  })
})
