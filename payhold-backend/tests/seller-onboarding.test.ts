/**
 * Spec §12 and §5.1 — seller onboarding, KYC, and payout destinations.
 *
 * §15's phase-5 acceptance criterion is one line — "unverified sellers cannot
 * receive payouts" — and it is the first suite below. The rest is §5.1's
 * change protection and the capability read a client shows a seller.
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { migrated, rejects, type Harness } from './harness'

let h: Harness
let tenant: string

beforeAll(async () => {
  h = await migrated()
  const { rows: [t] } = await h.db.query<{ id: string }>(
    `insert into tenants (name, slug) values ('Onboard Co', 'onboard-co') returning id`,
  )
  tenant = t.id
})

afterAll(() => h.close())

/** A seller as `POST /v1/sellers` creates one: unverified, with a destination. */
async function newSeller(name = 'Seller'): Promise<string> {
  const { rows: [s] } = await h.db.query<{ id: string }>(
    `insert into sellers (tenant_id, name, country, payout_currency,
                          payout_provider, beneficiary_token, masked_destination,
                          created_at)
     values ($1, $2, 'RW', 'RWF', 'flutterwave_momo',
             'tok_' || gen_random_uuid(), 'MTN •••• 4821',
             -- Registered long before this deal, so the discretionary
             -- new-seller rule is not what these tests are measuring.
             now() - interval '400 days')
     returning id`,
    [tenant, name],
  )
  return s.id
}

/** A payout for that seller, sitting scheduled and ready to be screened. */
async function payoutFor(seller: string): Promise<string> {
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

async function capabilities(
  seller: string,
): Promise<{ can: boolean; kyc: string; reasons: string[] }> {
  const { rows: [c] } = await h.db.query<{
    can_receive_payouts: boolean
    kyc_status: string
    reasons: string[] | null
  }>(`select * from seller_capabilities($1)`, [seller])
  return { can: c.can_receive_payouts, kyc: c.kyc_status, reasons: c.reasons ?? [] }
}

describe('§15 phase 5 — unverified sellers cannot receive payouts', () => {
  test('a fresh seller is pending, and their payout is held', async () => {
    const seller = await newSeller()
    expect((await capabilities(seller)).kyc).toBe('pending')

    const payout = await payoutFor(seller)
    expect(await screen(payout)).toBe(true)

    const { rows: [p] } = await h.db.query<{ status: string }>(
      `select status::text from payouts where id = $1`, [payout],
    )
    // Phase 5 gave the gate its own status. `held_for_review` is a queue an
    // operator can clear; this is not one, deliberately — see below.
    expect(p.status).toBe('needs_verification')
  })

  test('an operator cannot approve past the gate', async () => {
    // §12's sentence, made structural. While eligibility produced
    // `held_for_review`, "we have never verified this seller" sat in the same
    // queue as "this payout is unusually large", and the approve button cleared
    // both. The way out of `needs_verification` is `verify_seller` — an
    // attestation with a name on it — and nothing else.
    const seller = await newSeller('Cannot be approved through')
    const payout = await payoutFor(seller)
    await screen(payout)

    await expect(
      h.db.query(`select approve_payout_review($1, 'ops@payhold')`, [payout]),
    ).rejects.toThrow(/not held for review/)
  })

  test('verifying the seller puts the payout back in the queue by itself', async () => {
    // The other half of the same decision. `needs_verification` is
    // machine-recoverable — a rule that re-screens and finds the reason gone is
    // not *sending* anything, so invariant 11 is untouched — and it has to be,
    // or a verified seller would sit in a state `mark_payout_processing`
    // refuses and no pass would ever move.
    const seller = await newSeller('Verified after the hold')
    const payout = await payoutFor(seller)
    await screen(payout)

    await h.db.query(`select verify_seller($1, 'compliance@payhold')`, [seller])
    expect(await screen(payout)).toBe(false)

    const { rows: [p] } = await h.db.query<{ status: string; held: string | null }>(
      `select status::text, review_held_at::text as held from payouts where id = $1`,
      [payout],
    )
    expect(p.status).toBe('scheduled')
    expect(p.held).toBeNull()
  })

  test('an earlier approval does not skip the eligibility gate', async () => {
    // The hole Phase 4 left. `screen_payout` returned early on an approval,
    // which was right while everything below that line was a discretionary
    // rule; the gate then landed above it and inherited the short-circuit. A
    // seller whose verification was revoked after an approval would have been
    // paid.
    const seller = await newSeller('Approved, then revoked')
    await h.db.query(`select verify_seller($1, 'compliance@payhold')`, [seller])
    const payout = await payoutFor(seller)

    await h.db.query(
      `update payouts set status = 'held_for_review', review_held_at = now()
        where id = $1`,
      [payout],
    )
    await h.db.query(`select approve_payout_review($1, 'ops@payhold')`, [payout])

    await h.db.query(
      `update sellers set kyc_status = 'restricted' where id = $1`, [seller],
    )

    expect(await screen(payout)).toBe(true)

    const { rows: [p] } = await h.db.query<{ status: string }>(
      `select status::text from payouts where id = $1`, [payout],
    )
    expect(p.status).toBe('needs_verification')
  })

  test('the gate is not a risk rule — switching those off does not open it', async () => {
    // This is the distinction the whole migration turns on. The discretionary
    // rules are arithmetic a tenant may reasonably decline to act on;
    // eligibility is not, and a tenant that switched the rules off must not
    // thereby start paying sellers it has never verified.
    await h.db.query(
      `insert into settings (tenant_id, key, value) values ($1, 'risk_rules_enabled', '0')
       on conflict (tenant_id, key) do update set value = excluded.value`,
      [tenant],
    )

    const seller = await newSeller('Unverified with rules off')
    expect(await screen(await payoutFor(seller))).toBe(true)

    await h.db.query(
      `delete from settings where tenant_id = $1 and key = 'risk_rules_enabled'`,
      [tenant],
    )
  })

  test('a hold from the gate is a rule hold, not a person one', async () => {
    const seller = await newSeller('Rule held')
    const payout = await payoutFor(seller)
    await screen(payout)

    const { rows: [p] } = await h.db.query<{ by: string | null }>(
      `select review_held_by as by from payouts where id = $1`, [payout],
    )
    // Null means arithmetic did it; a name means somebody did and can be asked
    // why. Invariant 11's distinction, and the gate is on the arithmetic side.
    expect(p.by).toBeNull()
  })

  test('a verified seller with a verified destination goes through', async () => {
    const seller = await newSeller('Verified')
    await h.db.query(`select verify_seller($1, 'compliance@payhold')`, [seller])

    expect((await capabilities(seller)).can).toBe(true)
    expect(await screen(await payoutFor(seller))).toBe(false)
  })

  test('the reason is recorded as a signal a person can read', async () => {
    const seller = await newSeller('Signalled')
    const payout = await payoutFor(seller)
    await screen(payout)

    const { rows: [sig] } = await h.db.query<{ signal: string; explanation: string }>(
      `select signal, explanation from risk_signals
        where seller_id = $1 and signal = 'not_eligible'`,
      [seller],
    )
    expect(sig.explanation).toMatch(/cannot be paid yet/)
    expect(sig.explanation).toMatch(/not verified/)
  })
})

describe('seller capabilities — §10.1', () => {
  test('a fresh seller is told everything that is missing, not just the first', async () => {
    const seller = await newSeller('Missing everything')
    const c = await capabilities(seller)

    expect(c.can).toBe(false)
    expect(c.reasons).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/not verified/),
        expect.stringMatching(/[Ss]anctions screening has not been run/),
        expect.stringMatching(/destination has not been verified/),
      ]),
    )
  })

  test('stale sanctions screening is a reason on its own', async () => {
    const seller = await newSeller('Stale screen')
    await h.db.query(`select verify_seller($1, 'compliance@payhold')`, [seller])
    await h.db.query(
      `update sellers set sanctions_checked_at = now() - interval '400 days' where id = $1`,
      [seller],
    )

    const c = await capabilities(seller)
    expect(c.can).toBe(false)
    expect(c.reasons.join(' ')).toMatch(/out of date/)
  })

  test('a seller under review is not verified', async () => {
    const seller = await newSeller('Under review')
    await h.db.query(`select verify_seller($1, 'compliance@payhold')`, [seller])
    await h.db.query(`select verify_seller($1, 'compliance@payhold', false)`, [seller])

    expect((await capabilities(seller)).kyc).toBe('review_required')
    expect(await screen(await payoutFor(seller))).toBe(true)
  })

  test('a verification records who made it', async () => {
    const seller = await newSeller('Attested')
    await rejects(
      () => h.db.query(`select verify_seller($1, '')`, [seller]),
      /must record who made it/,
    )

    await h.db.query(`select verify_seller($1, 'grace@autohire.rw')`, [seller])
    const { rows } = await h.db.query<{ actor: string }>(
      `select actor from audit_log where action = 'seller.verified'
         and details ->> 'seller_id' = $1`,
      [seller],
    )
    expect(rows[0].actor).toBe('grace@autohire.rw')
  })
})

describe('§5.1 change protection', () => {
  test('a seller is created with their destination, whoever inserted them', async () => {
    // A trigger rather than a line in the endpoint: the endpoint is not the
    // only thing that inserts a seller, and a seller with no destination row
    // would be unpayable for a reason nobody chose.
    const seller = await newSeller('Auto destination')
    const { rows } = await h.db.query<{ is_primary: boolean }>(
      `select is_primary from seller_destinations where seller_id = $1`, [seller],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].is_primary).toBe(true)
  })

  test('moving the destination holds the next payout', async () => {
    const seller = await newSeller('Moved')
    await h.db.query(`select verify_seller($1, 'compliance@payhold')`, [seller])
    expect(await screen(await payoutFor(seller))).toBe(false)

    await h.db.query(
      `update seller_destinations
          set beneficiary_token = 'tok_somewhere_else',
              masked_destination = 'MTN •••• 9999'
        where seller_id = $1 and is_primary`,
      [seller],
    )

    expect(await screen(await payoutFor(seller))).toBe(true)
  })

  test('re-saving the same destination is not a change', async () => {
    const seller = await newSeller('Unmoved')
    await h.db.query(`select verify_seller($1, 'compliance@payhold')`, [seller])

    await h.db.query(
      `update seller_destinations set label = 'Main account'
        where seller_id = $1 and is_primary`,
      [seller],
    )

    // Stamping this would hold a payout for nothing — the money is going to
    // exactly where it was going to go before.
    expect(await screen(await payoutFor(seller))).toBe(false)
  })

  test('the seller row follows the primary destination and cannot disagree', async () => {
    const seller = await newSeller('Synced')
    await h.db.query(
      `update seller_destinations
          set beneficiary_token = 'tok_new', masked_destination = 'Airtel •••• 1111'
        where seller_id = $1 and is_primary`,
      [seller],
    )

    const { rows: [s] } = await h.db.query<{ token: string; masked: string }>(
      `select beneficiary_token as token, masked_destination as masked
         from sellers where id = $1`,
      [seller],
    )
    expect(s.token).toBe('tok_new')
    expect(s.masked).toBe('Airtel •••• 1111')
  })

  test('a seller cannot have two primaries or two backups', async () => {
    const seller = await newSeller('Two destinations')
    await rejects(
      () => h.db.query(
        `insert into seller_destinations (tenant_id, seller_id, country, payout_currency,
                                          payout_provider, beneficiary_token,
                                          masked_destination, is_primary)
         values ($1, $2, 'RW', 'RWF', 'flutterwave_momo', 'tok_2', 'MTN •••• 2', true)`,
        [tenant, seller],
      ),
      /seller_destinations_one_primary/,
    )
  })

  test('a backup can be registered alongside the primary', async () => {
    const seller = await newSeller('With backup')
    await h.db.query(
      `insert into seller_destinations (tenant_id, seller_id, label, country,
                                        payout_currency, payout_provider,
                                        beneficiary_token, masked_destination, is_backup)
       values ($1, $2, 'Backup', 'RW', 'RWF', 'flutterwave_bank',
               'tok_backup', 'BK •••• 0073', true)`,
      [tenant, seller],
    )

    const { rows } = await h.db.query<{ n: number }>(
      `select count(*)::int as n from seller_destinations where seller_id = $1`, [seller],
    )
    expect(rows[0].n).toBe(2)

    // Registering it does not make it the one that gets used — §5.1 says the
    // backup is reached only after a failed primary payout and an explicit
    // routing check, which is Phase 5.
    const { rows: [s] } = await h.db.query<{ token: string }>(
      `select beneficiary_token as token from sellers where id = $1`, [seller],
    )
    expect(s.token).not.toBe('tok_backup')
  })

  test('a destination in its security hold blocks the payout', async () => {
    const seller = await newSeller('Held destination')
    await h.db.query(`select verify_seller($1, 'compliance@payhold')`, [seller])
    await h.db.query(
      `update seller_destinations set security_hold_until = now() + interval '12 hours'
        where seller_id = $1 and is_primary`,
      [seller],
    )

    const c = await capabilities(seller)
    expect(c.can).toBe(false)
    expect(c.reasons.join(' ')).toMatch(/security hold/)
    expect(await screen(await payoutFor(seller))).toBe(true)
  })
})

describe('§11 external user id — the client’s own handle', () => {
  const withHandle = (name: string, handle: string | null) =>
    h.db.query(
      `insert into sellers (tenant_id, name, country, payout_currency, payout_provider,
                            beneficiary_token, masked_destination, external_user_id)
       values ($1, $2, 'RW', 'RWF', 'flutterwave_momo',
               'tok_' || gen_random_uuid(), 'MTN •••• 4821', $3)`,
      [tenant, name, handle],
    )

  test('one seller per handle, per tenant', async () => {
    // The constraint the mapping is worthless without. A client retrying a
    // registration that timed out would otherwise get a second seller for the
    // same person, with a second beneficiary token, and nothing afterwards
    // could say which of the two a payout should go to.
    await withHandle('Host A', 'host_4821')
    await rejects(
      () => withHandle('Host A again', 'host_4821'),
      /sellers_external_user_key/,
    )
  })

  test('any number of sellers may have no handle', async () => {
    // Null is not a handle. Somebody registering by hand from the dashboard
    // supplies nothing here, and those rows must stay legal.
    await withHandle('Unmapped one', null)
    await withHandle('Unmapped two', null)

    const { rows } = await h.db.query<{ n: number }>(
      `select count(*)::int as n from sellers
        where tenant_id = $1 and external_user_id is null`,
      [tenant],
    )
    expect(rows[0].n).toBeGreaterThanOrEqual(2)
  })

  test('two tenants may number their own users from the same handle', async () => {
    const { rows: [other] } = await h.db.query<{ id: string }>(
      `insert into tenants (name, slug) values ('Other Co', 'other-co') returning id`,
    )
    await h.db.query(
      `insert into sellers (tenant_id, name, country, payout_currency, payout_provider,
                            beneficiary_token, masked_destination, external_user_id)
       values ($1, 'Their host', 'RW', 'RWF', 'flutterwave_momo',
               'tok_other', 'MTN •••• 0001', 'host_4821')`,
      [other.id],
    )

    // Two clients numbering their users from 1 is the expected case, not a
    // collision — which is why the index is scoped to the tenant.
    const { rows } = await h.db.query<{ n: number }>(
      `select count(*)::int as n from sellers where external_user_id = 'host_4821'`,
    )
    expect(rows[0].n).toBe(2)
  })
})
