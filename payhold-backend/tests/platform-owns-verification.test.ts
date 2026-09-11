/**
 * Spec §29.18 — the tenant's own platform owns seller and destination
 * verification, migration `20260911000004`.
 *
 * With `platform_owns_verification` on — the default — a seller or a payout
 * account is verified only by the tenant's platform, over its API key, naming
 * the person there who decided. A person signed in to PayHold cannot verify or
 * un-verify either, `seller_auto_verify` writes nothing verified, and the relay
 * setting is superseded rather than consulted. What does not move: the security
 * hold still runs on its timer and only a person may end it early, the gates
 * still read the same columns, and nothing already verified is un-verified.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { migrated, rejects, type Harness } from './harness'

let h: Harness

beforeAll(async () => {
  h = await migrated()
}, 120_000)

afterAll(() => h.close())

/** `resolveCaller` puts the credential's label here, never a person's name. */
const KEY = 'api_key:AutoHire live'
const PERSON = 'user:owner@example.com'
const REPORTER = 'jane@autohire.rw'

type Flag = '0' | '1' | undefined

async function newTenant(settings: Record<string, Flag> = {}): Promise<string> {
  const slug = `owns-${crypto.randomUUID().slice(0, 12)}`
  const { rows: [t] } = await h.db.query<{ id: string }>(
    `insert into tenants (name, slug) values ($1, $1) returning id`, [slug],
  )
  for (const [key, value] of Object.entries(settings)) {
    if (value === undefined) continue
    await h.db.query(
      `insert into settings (tenant_id, key, value) values ($1, $2, $3)`, [t.id, key, value],
    )
  }
  return t.id
}

/** A seller registered with a destination, long enough ago that no rule fires. */
async function newSeller(tenant: string): Promise<string> {
  const { rows: [s] } = await h.db.query<{ id: string }>(
    `insert into sellers (tenant_id, name, country, payout_currency, payout_provider,
                          beneficiary_token, masked_destination, created_at)
     values ($1, 'Host', 'RW', 'RWF', 'flutterwave_momo', 'tok_' || gen_random_uuid(),
             'MTN •••• 4821', now() - interval '400 days')
     returning id`,
    [tenant],
  )
  return s.id
}

async function liveDestination(seller: string): Promise<string> {
  const { rows: [d] } = await h.db.query<{ id: string }>(
    `select id from seller_destinations where seller_id = $1 and archived_at is null`, [seller],
  )
  return d.id
}

const relaySeller = (seller: string, verified = true, reporter: string | null = REPORTER) =>
  h.db.query(
    `select * from verify_seller($1, $2, $3, true, $4)`, [seller, KEY, verified, reporter],
  )
const personSeller = (seller: string, verified = true) =>
  h.db.query(`select * from verify_seller($1, $2, $3)`, [seller, PERSON, verified])
const relayDestination = (
  destination: string,
  tenant: string,
  verified = true,
  reporter: string | null = REPORTER,
) =>
  h.db.query(
    `select * from verify_seller_destination($1, $2, $3, $4, true, $5)`,
    [destination, tenant, KEY, verified, reporter],
  )
const personDestination = (destination: string, tenant: string, verified = true) =>
  h.db.query(
    `select * from verify_seller_destination($1, $2, $3, $4)`,
    [destination, tenant, PERSON, verified],
  )

async function sellerRow(seller: string) {
  const { rows: [s] } = await h.db.query<{
    kyc: string
    verifier_source: string | null
    reported_verifier: string | null
  }>(
    `select kyc_status::text as kyc, verifier_source, reported_verifier
       from sellers where id = $1`,
    [seller],
  )
  return s
}

async function destinationRow(destination: string) {
  const { rows: [d] } = await h.db.query<{
    verified: boolean
    hold: string | null
    verifier_source: string | null
    reported_verifier: string | null
  }>(
    `select verified_at is not null as verified, security_hold_until::text as hold,
            verifier_source, reported_verifier
       from seller_destinations where id = $1`,
    [destination],
  )
  return d
}

async function capabilities(seller: string) {
  const { rows: [c] } = await h.db.query<{ can: boolean; reasons: string[] | null }>(
    `select can_receive_payouts as can, reasons from seller_capabilities($1)`, [seller],
  )
  return { can: c.can, reasons: (c.reasons ?? []).join(' ') }
}

async function payoutFor(tenant: string, seller: string): Promise<string> {
  const { rows: [d] } = await h.db.query<{ id: string }>(
    `insert into deals (tenant_id, buyer_ref, seller_id, description, amount, currency,
                        presentment_currency, presentment_amount, buyer_country,
                        provider, fee_amount, status, released_at)
     values ($1, 'buyer_1', $2, 'A rental', 100000, 'RWF', 'RWF', 100000, 'RW',
             'fake', 10000, 'released', now())
     returning id`,
    [tenant, seller],
  )
  const { rows: [p] } = await h.db.query<{ id: string }>(
    `insert into payouts (tenant_id, deal_id, seller_id, amount, currency, status, scheduled_for)
     values ($1, $2, $3, 90000, 'RWF', 'scheduled', now())
     returning id`,
    [tenant, d.id, seller],
  )
  return p.id
}

const screen = async (payout: string): Promise<boolean> => {
  const { rows: [r] } = await h.db.query<{ held: boolean }>(
    `select screen_payout($1) as held`, [payout],
  )
  return r.held
}

async function auditsFor(tenant: string, action: string) {
  const { rows } = await h.db.query<{ actor: string; details: Record<string, unknown> }>(
    `select actor, details from audit_log where tenant_id = $1 and action = $2
      order by created_at`,
    [tenant, action],
  )
  return rows
}

// ---------------------------------------------------------------------------

describe('on by default', () => {
  test('an account that never stored it owns verification; a stored 0 hands it back', async () => {
    const unset = await newTenant()
    const off = await newTenant({ platform_owns_verification: '0' })
    const { rows: [r] } = await h.db.query<{ unset: boolean; off: boolean }>(
      `select platform_owns_verification($1) as unset, platform_owns_verification($2) as off`,
      [unset, off],
    )
    expect(r).toEqual({ unset: true, off: false })
  })

  test('a person cannot verify a seller, in either direction', async () => {
    const tenant = await newTenant()
    const seller = await newSeller(tenant)

    for (const verified of [true, false]) {
      await rejects(() => personSeller(seller, verified), /verification_owned_by_platform/)
    }
    expect(await sellerRow(seller)).toMatchObject({ kyc: 'pending', verifier_source: null })
    expect(await auditsFor(tenant, 'seller.verified')).toHaveLength(0)
  })

  test('a person cannot verify a destination, in either direction', async () => {
    const tenant = await newTenant()
    const destination = await liveDestination(await newSeller(tenant))

    for (const verified of [true, false]) {
      await rejects(
        () => personDestination(destination, tenant, verified),
        /verification_owned_by_platform/,
      )
    }
    expect((await destinationRow(destination)).verified).toBe(false)
  })
})

describe('the platform verifies, over its key', () => {
  test('a seller verification is recorded against the credential with the reported name', async () => {
    const tenant = await newTenant()
    const seller = await newSeller(tenant)

    await relaySeller(seller)

    expect(await sellerRow(seller)).toEqual({
      kyc: 'verified',
      verifier_source: 'platform_reported',
      reported_verifier: REPORTER,
    })
    const [audit] = await auditsFor(tenant, 'seller.verified')
    expect(audit.actor).toBe(KEY)
    expect(audit.details).toMatchObject({
      verifier_source: 'platform_reported',
      reported_verifier: REPORTER,
      attested_by: 'tenant_verification_relay',
    })
  })

  test('it stamps no destination', async () => {
    const tenant = await newTenant()
    const seller = await newSeller(tenant)
    await relaySeller(seller)

    expect((await destinationRow(await liveDestination(seller))).verified).toBe(false)
    expect((await capabilities(seller)).reasons).toMatch(/destination has not been verified/)
  })

  test('a credential as the actor is relayed even without the flag', async () => {
    const tenant = await newTenant()
    const seller = await newSeller(tenant)

    // Not the person path — that would be `verification_owned_by_platform`. The
    // relayed path, which wants a name.
    await rejects(
      () => h.db.query(`select * from verify_seller($1, $2, true)`, [seller, KEY]),
      /invalid_request/,
    )
    await h.db.query(
      `select * from verify_seller(p_seller => $1, p_actor => $2, p_reported_verifier => $3)`,
      [seller, KEY, REPORTER],
    )
    expect((await sellerRow(seller)).verifier_source).toBe('platform_reported')
  })

  test('the reported name must be a person', async () => {
    const tenant = await newTenant()
    const seller = await newSeller(tenant)
    const destination = await liveDestination(seller)

    for (const bad of [null, '', '   ', 'api_key:AutoHire live', 'API_KEY:x', 'system', 'System auto', 'x'.repeat(201)]) {
      await rejects(() => relaySeller(seller, true, bad), /invalid_request/)
      await rejects(() => relayDestination(destination, tenant, true, bad), /invalid_request/)
    }
    expect((await sellerRow(seller)).kyc).toBe('pending')
  })

  test('a person may not smuggle a reported name through the person path', async () => {
    const tenant = await newTenant({ platform_owns_verification: '0' })
    const seller = await newSeller(tenant)
    await rejects(
      () => h.db.query(
        `select * from verify_seller($1, $2, true, false, $3)`, [seller, PERSON, REPORTER],
      ),
      /invalid_request/,
    )
  })

  test('ownership supersedes a stored relay of 0', async () => {
    const tenant = await newTenant({ seller_verification_relay: '0' })
    const seller = await newSeller(tenant)
    await relaySeller(seller)
    expect((await sellerRow(seller)).kyc).toBe('verified')
  })

  test('a destination verification records the name and never touches the hold', async () => {
    const tenant = await newTenant()
    const seller = await newSeller(tenant)
    const { rows: [added] } = await h.db.query<{ id: string }>(
      `select id from add_seller_destination($1, $2, 'RW', 'RWF', 'flutterwave_momo',
                                             'tok_new', 'MTN •••• 7070', null, 'primary', $3)`,
      [seller, tenant, KEY],
    )
    const before = await destinationRow(added.id)
    expect(before.hold).not.toBeNull()

    const { rows: [returned] } = await relayDestination(added.id, tenant)
    expect(returned).toMatchObject({ verifier_source: 'platform_reported', reported_verifier: REPORTER })

    const after = await destinationRow(added.id)
    expect(after).toEqual({
      verified: true,
      hold: before.hold,
      verifier_source: 'platform_reported',
      reported_verifier: REPORTER,
    })

    // Withdrawing is relayed the same way, and still leaves the hold alone.
    await relayDestination(added.id, tenant, false)
    expect(await destinationRow(added.id)).toMatchObject({ verified: false, hold: before.hold })

    const [audit] = await auditsFor(tenant, 'seller.destination_verified')
    expect(audit.actor).toBe(KEY)
    expect(audit.details.reported_verifier).toBe(REPORTER)
  })

  test('a seller verification can be withdrawn the same way', async () => {
    const tenant = await newTenant()
    const seller = await newSeller(tenant)
    await relaySeller(seller)
    await relaySeller(seller, false, 'amina@autohire.rw')
    expect(await sellerRow(seller)).toEqual({
      kyc: 'review_required',
      verifier_source: 'platform_reported',
      reported_verifier: 'amina@autohire.rw',
    })
  })

  test('a replaced destination is still refused, and an unknown one is not found', async () => {
    const tenant = await newTenant()
    const seller = await newSeller(tenant)
    const old = await liveDestination(seller)
    await h.db.query(
      `select add_seller_destination($1, $2, 'RW', 'RWF', 'flutterwave_momo',
                                     'tok_replacement', 'MTN •••• 1212', null, 'primary', $3)`,
      [seller, tenant, KEY],
    )

    await rejects(() => relayDestination(old, tenant), /destination_archived/)
    await rejects(() => relayDestination(crypto.randomUUID(), tenant), /not_found/)
  })
})

describe('with ownership handed back', () => {
  test('a person verifies as before, and the review stamps the destination', async () => {
    const tenant = await newTenant({ platform_owns_verification: '0' })
    const seller = await newSeller(tenant)
    await personSeller(seller)

    expect(await sellerRow(seller)).toEqual({
      kyc: 'verified', verifier_source: 'person', reported_verifier: null,
    })
    expect(await destinationRow(await liveDestination(seller))).toMatchObject({
      verified: true, verifier_source: 'person', reported_verifier: null,
    })
  })

  test('a seller key needs the relay, and gets verification_relay_off without it', async () => {
    const tenant = await newTenant({ platform_owns_verification: '0', seller_verification_relay: '0' })
    const seller = await newSeller(tenant)
    for (const verified of [true, false]) {
      await rejects(() => relaySeller(seller, verified), /verification_relay_off/)
    }

    const relaying = await newTenant({ platform_owns_verification: '0', seller_verification_relay: '1' })
    const other = await newSeller(relaying)
    await relaySeller(other)
    expect((await sellerRow(other)).kyc).toBe('verified')
  })

  test('a destination cannot be relayed at all', async () => {
    const tenant = await newTenant({ platform_owns_verification: '0', seller_verification_relay: '1' })
    const destination = await liveDestination(await newSeller(tenant))
    await rejects(() => relayDestination(destination, tenant), /destination_relay_off/)
  })
})

describe('the hold still runs on its timer', () => {
  test('a key that adds a destination and verifies everything cannot make money payable early', async () => {
    const tenant = await newTenant()
    const seller = await newSeller(tenant)
    await relaySeller(seller)
    const { rows: [added] } = await h.db.query<{ id: string }>(
      `select id from add_seller_destination($1, $2, 'RW', 'RWF', 'flutterwave_momo',
                                             'tok_takeover', 'MTN •••• 6666', null, 'primary', $3)`,
      [seller, tenant, KEY],
    )
    await relayDestination(added.id, tenant)

    // Every reader refuses it.
    const caps = await capabilities(seller)
    expect(caps.can).toBe(false)
    expect(caps.reasons).toMatch(/security hold/)

    const payout = await payoutFor(tenant, seller)
    expect(await screen(payout)).toBe(true)

    const { rows: [decision] } = await h.db.query<{ reason_code: string; route_id: string | null }>(
      `select reason_code, route_id from route_payout($1)`, [payout],
    )
    expect(decision).toEqual({ reason_code: 'destination_in_security_hold', route_id: null })

    await rejects(
      () => h.db.query(`select * from request_withdrawal($1, $2, $3)`, [seller, KEY, added.id]),
      /security hold/,
    )

    // The timer is the only way through for a key — and once it has run, the
    // same destination is paid with nobody approving anything.
    await h.db.query(
      `update seller_destinations set security_hold_until = now() - interval '1 minute'
        where id = $1`,
      [added.id],
    )
    await h.db.query(
      `update sellers set destination_changed_at = now() - interval '2 days' where id = $1`,
      [seller],
    )
    const later = await payoutFor(tenant, seller)
    expect(await screen(later)).toBe(false)
    const { rows: [routed] } = await h.db.query<{ reason_code: string; destination_id: string }>(
      `select reason_code, destination_id from route_payout($1)`, [later],
    )
    expect(routed).toEqual({ reason_code: 'routed', destination_id: added.id })
  })
})

describe('auto-verify is inert while the platform owns verification', () => {
  test('a stored 1 verifies nobody at registration', async () => {
    const tenant = await newTenant({ seller_auto_verify: '1' })
    const seller = await newSeller(tenant)

    expect((await sellerRow(seller)).kyc).toBe('pending')
    expect((await destinationRow(await liveDestination(seller))).verified).toBe(false)
    expect(await auditsFor(tenant, 'seller.auto_verified')).toHaveLength(0)
  })

  test('nor a destination added later, which serves the full hold', async () => {
    const tenant = await newTenant({ seller_auto_verify: '1' })
    const seller = await newSeller(tenant)
    const { rows: [added] } = await h.db.query<{ verified: boolean; hours: number; auto: boolean }>(
      `select verified_at is not null as verified,
              extract(epoch from security_hold_until - now()) / 3600 as hours,
              false as auto
         from add_seller_destination($1, $2, 'RW', 'RWF', 'flutterwave_momo',
                                     'tok_later', 'MTN •••• 5151', null, 'primary', $3)`,
      [seller, tenant, KEY],
    )
    expect(added.verified).toBe(false)
    expect(Number(added.hours)).toBeGreaterThan(23)

    const [audit] = await auditsFor(tenant, 'seller.destination_added')
    expect(audit.details.auto_verified).toBe(false)
  })

  test('handed back, it works as it did', async () => {
    const tenant = await newTenant({ seller_auto_verify: '1', platform_owns_verification: '0' })
    const seller = await newSeller(tenant)
    expect((await sellerRow(seller)).kyc).toBe('verified')
    expect((await destinationRow(await liveDestination(seller))).verified).toBe(true)
  })
})

describe('no stored combination leaves a seller or destination unverifiable', () => {
  test('all 27 combinations of ownership, relay and auto-verify', async () => {
    const values: Flag[] = [undefined, '0', '1']
    for (const owns of values) {
      for (const relay of values) {
        for (const auto of values) {
          const label = `ownership=${owns ?? 'unset'} relay=${relay ?? 'unset'} auto=${auto ?? 'unset'}`
          const tenant = await newTenant({
            platform_owns_verification: owns,
            seller_verification_relay: relay,
            seller_auto_verify: auto,
          })
          const seller = await newSeller(tenant)
          const destination = await liveDestination(seller)

          if (owns !== '0') {
            await relaySeller(seller)
            await relayDestination(destination, tenant)
          } else {
            await personSeller(seller)
          }

          expect((await sellerRow(seller)).kyc, label).toBe('verified')
          expect((await destinationRow(destination)).verified, label).toBe(true)
        }
      }
    }
  })
})

describe('already-verified rows stay verified', () => {
  test('handing verification to the platform un-verifies nobody', async () => {
    const tenant = await newTenant({ platform_owns_verification: '0' })
    const seller = await newSeller(tenant)
    await personSeller(seller)

    await h.db.query(
      `update settings set value = '1' where tenant_id = $1 and key = 'platform_owns_verification'`,
      [tenant],
    )

    expect((await sellerRow(seller)).kyc).toBe('verified')
    expect((await destinationRow(await liveDestination(seller))).verified).toBe(true)
  })
})

describe('grants and signatures', () => {
  test.each(['verify_seller', 'verify_seller_destination', 'add_seller_destination', 'route_payout'])(
    '%s is one function, and only the service role may call it',
    async (fn) => {
      const { rows: [n] } = await h.db.query<{ n: number }>(
        `select count(*)::int as n from pg_proc where proname = $1`, [fn],
      )
      expect(n.n).toBe(1)
      for (const role of ['anon', 'authenticated', 'payhold_ai']) {
        const { rows: [r] } = await h.db.query<{ ok: boolean }>(
          `select bool_or(has_function_privilege($1, p.oid, 'execute')) as ok
             from pg_proc p where p.proname = $2`,
          [role, fn],
        )
        expect(r.ok, `${role} on ${fn}`).toBe(false)
      }
    },
  )

  test('the signatures carry the report', async () => {
    const { rows } = await h.db.query<{ proname: string; args: string }>(
      `select proname, pg_get_function_identity_arguments(oid) as args
         from pg_proc where proname in ('verify_seller', 'verify_seller_destination')
        order by proname`,
    )
    expect(rows).toEqual([
      {
        proname: 'verify_seller',
        args: 'p_seller uuid, p_actor text, p_verified boolean, p_via_api_key boolean, p_reported_verifier text',
      },
      {
        proname: 'verify_seller_destination',
        args: 'p_destination uuid, p_tenant uuid, p_actor text, p_verified boolean, p_via_api_key boolean, p_reported_verifier text',
      },
    ])
  })
})

describe('the endpoints in front of it', () => {
  /** Comments stripped — the headers explain the rules at length. */
  const source = (...path: string[]) =>
    readFileSync(join(import.meta.dirname, '..', 'supabase', 'functions', ...path), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')

  const sellers = source('sellers', 'index.ts')
  const body = (name: string): string => {
    const start = sellers.indexOf(`async function ${name}(`)
    expect(start, name).toBeGreaterThan(-1)
    const rest = sellers.slice(start + 1)
    const end = rest.search(/\nasync function |\nDeno\.serve\(/)
    return sellers.slice(start, start + 1 + end)
  }

  test.each([
    'create', 'setActive', 'setName', 'addDestination', 'withdraw',
    'startConnectOnboarding', 'startConnectSession', 'connectStatus',
  ])('%s refuses a viewer', (name) => {
    expect(body(name)).toMatch(/requireSellerWriter\(caller\)/)
  })

  test('ending a hold refuses every caller but a signed-in writer before anything is read', () => {
    // `assertEndHoldCaller` refuses anything that is not a dashboard session,
    // and a viewer — pinned in `_shared/seller-verification.test.ts`.
    const endHold = body('endHold')
    const refusal = endHold.indexOf('assertEndHoldCaller(caller)')
    expect(refusal).toBeGreaterThan(-1)
    expect(refusal).toBeLessThan(endHold.indexOf('ownSeller('))
    expect(refusal).toBeLessThan(endHold.indexOf("rpc('end_destination_hold'"))
    expect(endHold).not.toMatch(/parseRelayedVerification|p_via_api_key|platform_owns_verification|requireRole/)
  })

  test('both verify routes pick the door from the caller and the settings, and pass the report on', () => {
    for (const [name, target] of [['verify', 'seller'], ['verifyDestination', 'destination']]) {
      const route = body(name)
      const read = route.indexOf('readSettings(db, caller.tenant_id)')
      expect(read, name).toBeGreaterThan(-1)
      const door = route.indexOf('verificationPath(caller,')
      expect(door, name).toBeGreaterThan(read)
      expect(route, name).toMatch(new RegExp(`target: '${target}'`))
      expect(route.indexOf('parseRelayedVerification('), name).toBeGreaterThan(door)
      expect(route.indexOf("rpc('verify_seller"), name).toBeGreaterThan(door)
      expect(route, name).toMatch(/p_reported_verifier: reportedVerifier/)
      expect(route, name).not.toMatch(/requireRole/)
    }
  })

  test('settings: only the owner changes ownership, and auto-verify is refused while it is on', () => {
    const settings = source('settings', 'index.ts')
    expect(settings).toMatch(/'platform_owns_verification' in patch && caller\.role !== 'owner'/)
    const guard = settings.indexOf('assertAutoVerifyAllowed(patch, current)')
    expect(guard).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(settings.indexOf('writeSettings(db'))
  })

  test('settings.ts defaults ownership on, as SQL does', () => {
    expect(source('_shared', 'settings.ts'))
      .toMatch(/platform_owns_verification: \{ kind: 'flag', fallback: true \}/)
  })
})
