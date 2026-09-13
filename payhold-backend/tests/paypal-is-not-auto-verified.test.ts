/**
 * `20260913000005` — a typed PayPal address is not evidence.
 *
 * `seller_auto_verify` lets a tenant's own onboarding stand in for PayHold's
 * attestation, and on every other rail the thing being attested to was minted
 * by the rail: a Stripe `acct_…`, a Flutterwave beneficiary token. On PayPal
 * the token is an email address somebody typed, and PayPal will accept a payout
 * to one whose account is unconfirmed — batch `SUCCESS`, item `UNCLAIMED`,
 * money back thirty days later. So the flag no longer carries a PayPal
 * destination.
 *
 * What is pinned here: the flag still does everything it did on the other
 * rails (the regression this must not cause), a PayPal destination comes out
 * unverified and inside its hold on both paths that create one, and the two
 * real answers — PayPal's own, relayed by the connect flow, and a person's —
 * still verify it. The rule is about who may verify, never about whether a
 * PayPal destination can be verified at all.
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { migrated, type Harness } from './harness'

let h: Harness

beforeAll(async () => {
  h = await migrated()
})

afterAll(() => h.close())

/**
 * A tenant with `seller_auto_verify` on and verification its own — the
 * combination that verifies a destination at insert. `platform_owns_verification`
 * is on by default and supersedes the flag (§29.18), so it is stored off here
 * for the same reason `seller-auto-verify.test.ts` does it.
 */
async function trustingTenant(slug: string): Promise<string> {
  const { rows: [t] } = await h.db.query<{ id: string }>(
    `insert into tenants (name, slug) values ($1, $1) returning id`,
    [slug],
  )
  await h.db.query(
    `insert into settings (tenant_id, key, value) values
       ($1, 'platform_owns_verification', '0'), ($1, 'seller_auto_verify', '1')`,
    [t.id],
  )
  return t.id
}

/** A seller created with a destination, the way `POST /v1/sellers` creates one. */
async function sellerWith(
  tenant: string,
  rail: 'flutterwave_momo' | 'paypal',
): Promise<string> {
  const shape = rail === 'paypal'
    ? { country: 'US', currency: 'USD', token: 'host@example.com', masked: 'host@example.com' }
    : { country: 'RW', currency: 'RWF', token: 'tok_momo', masked: 'MTN •••• 4821' }

  const { rows: [s] } = await h.db.query<{ id: string }>(
    `insert into sellers (tenant_id, name, country, payout_currency,
                          payout_provider, beneficiary_token, masked_destination)
     values ($1, 'Host', $2, $3, $4, $5, $6)
     returning id`,
    [tenant, shape.country, shape.currency, rail, shape.token, shape.masked],
  )
  return s.id
}

async function liveDestination(seller: string) {
  const { rows: [d] } = await h.db.query<{
    id: string
    payout_provider: string
    verified_at: string | null
    in_hold: boolean
  }>(
    `select id, payout_provider, verified_at,
            coalesce(security_hold_until > now(), false) as in_hold
       from seller_destinations
      where seller_id = $1 and is_primary and archived_at is null`,
    [seller],
  )
  return d
}

const addDestination = (
  seller: string,
  tenant: string,
  rail: 'flutterwave_momo' | 'paypal',
) =>
  rail === 'paypal'
    ? h.db.query(
      `select * from add_seller_destination(
         p_seller => $1, p_tenant => $2, p_country => 'US', p_currency => 'USD',
         p_provider => 'paypal', p_token => 'host@example.com',
         p_masked => 'host@example.com', p_actor => 'api')`,
      [seller, tenant],
    )
    : h.db.query(
      `select * from add_seller_destination(
         p_seller => $1, p_tenant => $2, p_country => 'RW', p_currency => 'RWF',
         p_provider => 'flutterwave_momo', p_token => 'tok_new',
         p_masked => 'MTN •••• 7788', p_actor => 'api')`,
      [seller, tenant],
    )

describe('the flag still carries every other rail', () => {
  test('a seeded MoMo destination is verified and out of hold', async () => {
    const tenant = await trustingTenant('momo-seed-co')
    const seller = await sellerWith(tenant, 'flutterwave_momo')

    const dest = await liveDestination(seller)
    expect(dest.verified_at).not.toBeNull()
    expect(dest.in_hold).toBe(false)
  })

  test('a MoMo destination added later is verified and out of hold', async () => {
    const tenant = await trustingTenant('momo-add-co')
    const seller = await sellerWith(tenant, 'flutterwave_momo')
    await addDestination(seller, tenant, 'flutterwave_momo')

    const dest = await liveDestination(seller)
    expect(dest.verified_at).not.toBeNull()
    expect(dest.in_hold).toBe(false)
  })
})

describe('a PayPal address is left for PayPal', () => {
  test('a seeded PayPal destination is unverified', async () => {
    const tenant = await trustingTenant('paypal-seed-co')
    const seller = await sellerWith(tenant, 'paypal')

    const dest = await liveDestination(seller)
    expect(dest.payout_provider).toBe('paypal')
    expect(dest.verified_at).toBeNull()
  })

  test('a PayPal destination added later is unverified and serves its hold', async () => {
    const tenant = await trustingTenant('paypal-add-co')
    const seller = await sellerWith(tenant, 'flutterwave_momo')
    await addDestination(seller, tenant, 'paypal')

    const dest = await liveDestination(seller)
    expect(dest.payout_provider).toBe('paypal')
    expect(dest.verified_at).toBeNull()
    // `destination_hold_hours`, not the zero a trusted row gets: the §5.1
    // window is the only thing standing between a typed address and a transfer
    // now that nothing verifies it on the way in.
    expect(dest.in_hold).toBe(true)
  })

  test('the audit row says it was not auto-verified', async () => {
    const tenant = await trustingTenant('paypal-audit-co')
    const seller = await sellerWith(tenant, 'flutterwave_momo')
    await addDestination(seller, tenant, 'paypal')

    const { rows: [a] } = await h.db.query<{ auto_verified: boolean; provider: string }>(
      `select (details->>'auto_verified')::boolean as auto_verified,
              details->>'provider' as provider
         from audit_log
        where tenant_id = $1 and action = 'seller.destination_added'
        order by created_at desc limit 1`,
      [tenant],
    )
    expect(a.provider).toBe('paypal')
    expect(a.auto_verified).toBe(false)
  })
})

describe('what still verifies one', () => {
  test('a person can verify a PayPal destination', async () => {
    const tenant = await trustingTenant('paypal-person-co')
    const seller = await sellerWith(tenant, 'paypal')
    const dest = await liveDestination(seller)

    await h.db.query(
      `select * from verify_seller_destination($1, $2, $3, true)`,
      [dest.id, tenant, 'person:ops@payhold.test'],
    )

    expect((await liveDestination(seller)).verified_at).not.toBeNull()
  })

  test('the connect flow verifies it — add, then verify, as the endpoint does', async () => {
    // `completePayPalConnect` calls `add_seller_destination` with the payer id
    // and then `verify_seller_destination` on PayPal's `verified_account`. The
    // rule must not break that, or connecting an account would leave a host
    // exactly where typing one does.
    const tenant = await trustingTenant('paypal-connect-co')
    const seller = await sellerWith(tenant, 'flutterwave_momo')
    await h.db.query(
      `select * from add_seller_destination(
         p_seller => $1, p_tenant => $2, p_country => 'US', p_currency => 'USD',
         p_provider => 'paypal', p_token => 'PAYERID123',
         p_masked => 'PayPal •••• D123', p_actor => 'api')`,
      [seller, tenant],
    )

    const added = await liveDestination(seller)
    expect(added.verified_at).toBeNull()

    await h.db.query(
      `select * from verify_seller_destination($1, $2, $3, true)`,
      [added.id, tenant, 'person:paypal-connect'],
    )

    expect((await liveDestination(seller)).verified_at).not.toBeNull()
  })
})
