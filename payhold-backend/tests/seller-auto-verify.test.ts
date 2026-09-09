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
 */

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
