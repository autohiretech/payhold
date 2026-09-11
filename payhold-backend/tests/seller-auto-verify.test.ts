/**
 * `seller_auto_verify` — the tenant setting that lets a client's own onboarding
 * stand in for PayHold's per-seller attestation.
 *
 * The property worth pinning is not "the flag writes different columns" but
 * that **nothing downstream changed**: `screen_payout`, `seller_capabilities`
 * and `route_payout` still read exactly the columns they always read, and still
 * refuse an unverified seller. The flag only decides what gets written into
 * those columns on the way in — which is what keeps one fact with one set of
 * readers, the failure `20260809000002`'s header describes.
 *
 * The second half of the file is the **other** flag, `seller_verification_relay`
 * (`20260910000011`), and the reason it is a separate switch is the first
 * half's insert-time write: a tenant that reviews each host by hand needs
 * PayHold to take its word per seller, and would get the opposite from
 * `seller_auto_verify` — every unreviewed signup verified on arrival. So all
 * four combinations are exercised here, along with the properties that keep
 * the new door narrow: it stamps no destination, the audit row says which
 * attestation is behind it, and with the flag off the refusal a client reads is
 * the identical sentence it has always been.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { migrated, type Harness } from './harness'

let h: Harness

beforeAll(async () => {
  h = await migrated()
})

afterAll(() => h.close())

/** A tenant, with the flag set however this case needs it. */
async function newTenant(slug: string, autoVerify: boolean): Promise<string> {
  const { rows: [t] } = await h.db.query<{ id: string }>(
    `insert into tenants (name, slug) values ($1, $1) returning id`,
    [slug],
  )
  if (autoVerify) {
    // A flag is stored as 1, never a JSON `true` — `setting_num` casts to
    // numeric and a literal `false` raises inside whichever money function
    // asked. See the note on SPEC in _shared/settings.ts.
    await h.db.query(
      `insert into settings (tenant_id, key, value) values ($1, 'seller_auto_verify', '1')`,
      [t.id],
    )
  }
  return t.id
}

/** A seller registered with a destination, as `POST /v1/sellers` creates one. */
async function newSeller(tenant: string, name = 'Host'): Promise<string> {
  const { rows: [s] } = await h.db.query<{ id: string }>(
    `insert into sellers (tenant_id, name, country, payout_currency,
                          payout_provider, beneficiary_token, masked_destination,
                          created_at)
     values ($1, $2, 'RW', 'RWF', 'flutterwave_momo',
             'tok_' || gen_random_uuid(), 'MTN •••• 4821',
             -- Long before the deal, so the discretionary new-seller rule is
             -- not what any of these cases are measuring.
             now() - interval '400 days')
     returning id`,
    [tenant, name],
  )
  return s.id
}

async function primaryDestination(seller: string) {
  const { rows: [d] } = await h.db.query<{
    verified_at: string | null
    security_hold_until: string | null
    in_hold: boolean
  }>(
    `select verified_at, security_hold_until,
            coalesce(security_hold_until > now(), false) as in_hold
       from seller_destinations
      where seller_id = $1 and is_primary`,
    [seller],
  )
  return d
}

async function capabilities(seller: string) {
  const { rows: [c] } = await h.db.query<{
    can_receive_payouts: boolean
    kyc_status: string
    reasons: string[] | null
  }>(`select * from seller_capabilities($1)`, [seller])
  return { can: c.can_receive_payouts, kyc: c.kyc_status, reasons: c.reasons ?? [] }
}

/** A released deal with a payout scheduled against it, ready to screen. */
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
    `insert into payouts (tenant_id, deal_id, seller_id, amount, currency,
                          status, scheduled_for)
     values ($1, $2, $3, 90000, 'RWF', 'scheduled', now())
     returning id`,
    [tenant, d.id, seller],
  )
  return p.id
}

const screen = async (payout: string): Promise<boolean> => {
  const { rows: [r] } = await h.db.query<{ screen_payout: boolean }>(
    `select screen_payout($1)`, [payout],
  )
  return r.screen_payout
}

describe('off by default — nothing changes', () => {
  test('a seller is pending, and their destination is unverified and in hold', async () => {
    const tenant = await newTenant('plain-co', false)
    const seller = await newSeller(tenant)

    const caps = await capabilities(seller)
    expect(caps.kyc).toBe('pending')
    expect(caps.can).toBe(false)

    const dest = await primaryDestination(seller)
    expect(dest.verified_at).toBeNull()
    // Seeded destinations carry no stamp of their own — the seller's
    // `destination_changed_at` is what holds them. Either way, not verified.
    expect(dest.in_hold).toBe(false)
  })

  test('their payout is held at needs_verification', async () => {
    const tenant = await newTenant('plain-payout-co', false)
    const seller = await newSeller(tenant)
    const payout = await payoutFor(tenant, seller)

    expect(await screen(payout)).toBe(true)

    const { rows: [p] } = await h.db.query<{ status: string }>(
      `select status::text from payouts where id = $1`, [payout],
    )
    expect(p.status).toBe('needs_verification')
  })
})

describe('on — the tenant attests once for the account', () => {
  test('a new seller is verified with a fresh sanctions stamp', async () => {
    const tenant = await newTenant('trusted-co', true)
    const seller = await newSeller(tenant)

    const { rows: [s] } = await h.db.query<{
      kyc_status: string
      sanctions_checked_at: string | null
    }>(
      `select kyc_status::text, sanctions_checked_at from sellers where id = $1`,
      [seller],
    )
    expect(s.kyc_status).toBe('verified')
    expect(s.sanctions_checked_at).not.toBeNull()
  })

  test('the seeded destination is verified and out of hold', async () => {
    const tenant = await newTenant('trusted-seed-co', true)
    const seller = await newSeller(tenant)

    const dest = await primaryDestination(seller)
    expect(dest.verified_at).not.toBeNull()
    // `now()`, never null: null means "never had a hold" to every reader, and
    // they then fall back to `sellers.destination_changed_at` — which the sync
    // trigger stamps, so a null here would be a 24-hour hold in disguise.
    expect(dest.security_hold_until).not.toBeNull()
    expect(dest.in_hold).toBe(false)
  })

  test('seller_capabilities says they can be paid, with no reasons', async () => {
    const tenant = await newTenant('trusted-caps-co', true)
    const seller = await newSeller(tenant)

    const caps = await capabilities(seller)
    expect(caps.kyc).toBe('verified')
    expect(caps.reasons).toEqual([])
    expect(caps.can).toBe(true)
  })

  test('a scheduled payout is not held', async () => {
    const tenant = await newTenant('trusted-payout-co', true)
    const seller = await newSeller(tenant)
    const payout = await payoutFor(tenant, seller)

    expect(await screen(payout)).toBe(false)

    const { rows: [p] } = await h.db.query<{ status: string }>(
      `select status::text from payouts where id = $1`, [payout],
    )
    expect(p.status).toBe('scheduled')
  })

  test('a destination added later lands verified and immediately usable', async () => {
    const tenant = await newTenant('trusted-change-co', true)
    const seller = await newSeller(tenant)

    await h.db.query(
      `select * from add_seller_destination($1, $2, 'RW', 'RWF', 'flutterwave_momo',
                                            'tok_new', 'Airtel •••• 9931',
                                            'Mobile Money', 'primary', 'user:owner@example.com')`,
      [seller, tenant],
    )

    const dest = await primaryDestination(seller)
    expect(dest.verified_at).not.toBeNull()
    expect(dest.in_hold).toBe(false)
    expect((await capabilities(seller)).can).toBe(true)
  })

  test('the audit trail says the flag did it, not a person', async () => {
    const tenant = await newTenant('trusted-audit-co', true)
    await newSeller(tenant)

    const { rows } = await h.db.query<{ actor: string }>(
      `select actor from audit_log
        where tenant_id = $1 and action = 'seller.auto_verified'`,
      [tenant],
    )
    expect(rows.length).toBe(1)
    expect(rows[0].actor).toBe('system')
  })
})

describe('the gates themselves are untouched', () => {
  test('a seller verified by the flag, then un-verified, is held again', async () => {
    const tenant = await newTenant('revoke-co', true)
    const seller = await newSeller(tenant)
    const payout = await payoutFor(tenant, seller)

    // `verify_seller(.., false)` is the operator withdrawing it. If the flag
    // had weakened the gate rather than the write, this would still pass.
    await h.db.query(
      `select verify_seller($1, 'user:admin@example.com', false)`, [seller],
    )

    expect(await screen(payout)).toBe(true)
    expect((await capabilities(seller)).can).toBe(false)
  })

  test('turning the flag on does not retroactively verify existing sellers', async () => {
    const tenant = await newTenant('retro-co', false)
    const seller = await newSeller(tenant)
    expect((await capabilities(seller)).kyc).toBe('pending')

    await h.db.query(
      `insert into settings (tenant_id, key, value) values ($1, 'seller_auto_verify', '1')`,
      [tenant],
    )

    // Still pending: the flag governs what is written on the way in, and this
    // row was already written. Documented in the migration header.
    expect((await capabilities(seller)).kyc).toBe('pending')
  })
})


// ---------------------------------------------------------------------------
// `seller_verification_relay` — the tenant's own review, reported per seller
// ---------------------------------------------------------------------------
//
// A second setting, and the reason it is second rather than a widening of the
// first is the case above: `seller_auto_verify` writes `verified` at INSERT,
// before anybody has looked at anything. A client that creates the PayHold
// seller the moment somebody ticks "I want to host" would verify every
// unreviewed signup on arrival, and a later per-seller decision would have
// nothing left to decide. This flag leaves the insert path alone and only says
// whose word `POST /v1/sellers/:id/verify` will take.

/** `resolveCaller` puts the credential's label here, never a person's name. */
const API_KEY = 'api_key:AutoHire live'

async function setFlag(tenant: string, key: string): Promise<void> {
  // 1, never a JSON `true` — see `newTenant` above and `encode` in settings.ts.
  await h.db.query(
    `insert into settings (tenant_id, key, value) values ($1, $2, '1')`,
    [tenant, key],
  )
}

const relayOn = (tenant: string) => setFlag(tenant, 'seller_verification_relay')

/**
 * Stores the relay explicitly off. Since `20260911000001` the setting defaults
 * on, so "off" is no longer the absence of a row — a test that means relay off
 * has to store it, or it quietly tests the default instead.
 */
async function relayOff(tenant: string): Promise<void> {
  await h.db.query(
    `insert into settings (tenant_id, key, value) values ($1, 'seller_verification_relay', '0')`,
    [tenant],
  )
}

async function verifyBy(
  seller: string,
  actor: string,
  verified: boolean,
  viaApiKey: boolean,
): Promise<void> {
  await h.db.query(
    `select * from verify_seller($1, $2, $3, $4)`,
    [seller, actor, verified, viaApiKey],
  )
}

async function auditFor(tenant: string, action: string) {
  const { rows } = await h.db.query<{ actor: string; details: Record<string, unknown> }>(
    `select actor, details from audit_log
      where tenant_id = $1 and action = $2 order by created_at`,
    [tenant, action],
  )
  return rows
}

describe('the two flags are independent, and all four combinations are meant', () => {
  test('relay on, auto-verify off: a fresh seller is still pending', async () => {
    // The whole point of the split. Turning relay on must not verify anybody;
    // it only says who may make the decision later.
    const tenant = await newTenant('relay-only-co', false)
    await relayOn(tenant)
    const seller = await newSeller(tenant)

    const caps = await capabilities(seller)
    expect(caps.kyc).toBe('pending')
    expect(caps.can).toBe(false)
    expect(await primaryDestination(seller)).toMatchObject({ verified_at: null })
  })

  test('relay on: an API key may verify a seller its own review passed', async () => {
    const tenant = await newTenant('relay-co', false)
    await relayOn(tenant)
    const seller = await newSeller(tenant)
    expect((await capabilities(seller)).kyc).toBe('pending')

    await verifyBy(seller, API_KEY, true, true)

    const { rows: [s] } = await h.db.query<{
      kyc_status: string
      sanctions_checked_at: string | null
    }>(
      `select kyc_status::text, sanctions_checked_at from sellers where id = $1`,
      [seller],
    )
    expect(s.kyc_status).toBe('verified')
    // The relayed decision covers the sanctions screen too — it is the same
    // claim, about the same review.
    expect(s.sanctions_checked_at).not.toBeNull()
  })

  test('relay off: the same call is refused, in both directions', async () => {
    const tenant = await newTenant('no-relay-co', false)
    await relayOff(tenant)
    const seller = await newSeller(tenant)

    await expect(verifyBy(seller, API_KEY, true, true))
      .rejects.toThrow(/policy_violation/)
    // Withdrawing is the safe direction and still ends where the relay does:
    // with none turned on, this account's verifications were made by named
    // people, and a credential overturning one names nobody.
    await expect(verifyBy(seller, API_KEY, false, true))
      .rejects.toThrow(/policy_violation/)

    expect((await capabilities(seller)).kyc).toBe('pending')
    expect(await auditFor(tenant, 'seller.verified')).toHaveLength(0)
  })

  test('auto-verify on, relay off: sellers arrive verified and the key is still refused', async () => {
    const tenant = await newTenant('auto-only-co', true)
    await relayOff(tenant)
    const seller = await newSeller(tenant)
    expect((await capabilities(seller)).kyc).toBe('verified')

    // The two settings answer different questions, so one must not be read as
    // the other — this is the combination that would break if it were.
    await expect(verifyBy(seller, API_KEY, false, true))
      .rejects.toThrow(/policy_violation/)
    expect((await capabilities(seller)).kyc).toBe('verified')
  })

  test('both on: the platform may also withdraw, and the payout stops again', async () => {
    const tenant = await newTenant('auto-and-relay-co', true)
    await relayOn(tenant)
    const seller = await newSeller(tenant)
    const payout = await payoutFor(tenant, seller)
    expect(await screen(payout)).toBe(false)

    await verifyBy(seller, API_KEY, false, true)

    expect(await screen(payout)).toBe(true)
    expect((await capabilities(seller)).can).toBe(false)
  })

  test('a person is unaffected by either flag', async () => {
    const tenant = await newTenant('person-still-co', false)
    const seller = await newSeller(tenant)

    await verifyBy(seller, 'user:owner@example.com', true, false)
    expect((await capabilities(seller)).kyc).toBe('verified')
  })
})

describe('on by default (20260911000001)', () => {
  test('an account that never stored the setting accepts its API key', async () => {
    const tenant = await newTenant('default-relay-co', false)
    const seller = await newSeller(tenant)

    await verifyBy(seller, API_KEY, true, true)

    expect((await capabilities(seller)).kyc).toBe('verified')
  })

  test('the default still verifies nobody on arrival', async () => {
    // On by default loosens whose word is taken, not when: a seller still lands
    // pending until their platform says otherwise about them.
    const tenant = await newTenant('default-relay-pending-co', false)
    const seller = await newSeller(tenant)

    expect((await capabilities(seller)).kyc).toBe('pending')
  })
})

describe('the audit trail tells the two paths apart', () => {
  test('the relayed one names the credential and the relay', async () => {
    const tenant = await newTenant('relay-audit-co', false)
    await relayOn(tenant)
    const seller = await newSeller(tenant)
    await verifyBy(seller, API_KEY, true, true)

    const rows = await auditFor(tenant, 'seller.verified')
    expect(rows).toHaveLength(1)
    // The credential, not a name. An audit row must never answer "who said
    // this seller was verified" with a person who was not there.
    expect(rows[0].actor).toBe(API_KEY)
    expect(rows[0].details.attested_by).toBe('tenant_verification_relay')
    expect(rows[0].details.seller_id).toBe(seller)
  })

  test("a person's verification is recorded as a person's", async () => {
    const tenant = await newTenant('person-audit-co', false)
    await relayOn(tenant)
    const seller = await newSeller(tenant)
    await verifyBy(seller, 'user:amina@payhold', true, false)

    const rows = await auditFor(tenant, 'seller.verified')
    expect(rows).toHaveLength(1)
    expect(rows[0].actor).toBe('user:amina@payhold')
    expect(rows[0].details.attested_by).toBe('person')
  })

  test('a withdrawal carries the same distinction', async () => {
    const tenant = await newTenant('relay-withdraw-audit-co', false)
    await relayOn(tenant)
    const seller = await newSeller(tenant)
    await verifyBy(seller, API_KEY, false, true)

    const rows = await auditFor(tenant, 'seller.review_required')
    expect(rows).toHaveLength(1)
    expect(rows[0].actor).toBe(API_KEY)
    expect(rows[0].details.attested_by).toBe('tenant_verification_relay')
  })
})

describe('nothing downstream moved', () => {
  test('a seller verified this way still stops on an unverified destination', async () => {
    const tenant = await newTenant('relay-destination-co', false)
    await relayOn(tenant)
    const seller = await newSeller(tenant)
    const payout = await payoutFor(tenant, seller)

    await verifyBy(seller, API_KEY, true, true)

    // Verified, and unpayable. The relayed decision says who this person is;
    // it stamps no destination, because a payout account is a different
    // question — `verify_seller_destination` is the way out and it refuses an
    // API key.
    expect((await capabilities(seller)).kyc).toBe('verified')
    expect(await primaryDestination(seller)).toMatchObject({ verified_at: null })

    const caps = await capabilities(seller)
    expect(caps.can).toBe(false)
    expect(caps.reasons.join(' ')).toMatch(/destination/i)

    expect(await screen(payout)).toBe(true)
    const { rows: [p] } = await h.db.query<{ status: string }>(
      `select status::text from payouts where id = $1`, [payout],
    )
    expect(p.status).toBe('needs_verification')

    // And the way out is a person, on the endpoint that has always wanted one.
    const { rows: [d] } = await h.db.query<{ id: string }>(
      `select id from seller_destinations where seller_id = $1 and is_primary`,
      [seller],
    )
    await h.db.query(
      `select * from verify_seller_destination($1, $2, 'user:owner@example.com')`,
      [d.id, tenant],
    )
    expect(await screen(payout)).toBe(false)
  })

  test('a person verifying still stamps the primary destination', async () => {
    // Unchanged behaviour, pinned because the relayed path deliberately
    // departs from it: there, the two checks were looked at in one review.
    const tenant = await newTenant('person-destination-co', false)
    const seller = await newSeller(tenant)

    await verifyBy(seller, 'user:owner@example.com', true, false)
    expect((await primaryDestination(seller)).verified_at).not.toBeNull()
  })
})

describe('the sentence a refused client reads has not changed', () => {
  const REFUSAL =
    "Verifying a seller is a person\\'s decision and cannot be done with an API key"

  /** `functions/sellers/index.ts`, comments stripped — see `launch-gate`. */
  const code = readFileSync(
    join(import.meta.dirname, '..', 'supabase', 'functions', 'sellers', 'index.ts'),
    'utf8',
  )
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

  test('word for word, and still the only thing an unrelayed tenant gets', () => {
    expect(code.split(REFUSAL)).toHaveLength(2)
  })

  test('it is reached only after the relay setting has been asked', () => {
    // The refusal moved behind a read of the tenant's own attestation. If that
    // read were dropped the string would still be here, so what is pinned is
    // that the flag — and this flag, not the insert-time one — stands in front
    // of it.
    const [before] = code.split(REFUSAL)
    expect(before).toMatch(/seller_verification_relay/)
    expect(before).toMatch(/readSettings\(db, caller\.tenant_id\)/)
    expect(before).not.toMatch(/seller_auto_verify/)
  })

  test('the call says which attestation it is relaying', () => {
    expect(code).toMatch(/p_via_api_key: viaApiKey/)
  })
})
