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
  // §29.18 turns person verification off by default. This file exercises the
  // PayHold-side verification the setting can still hand back to a person, so
  // the account stores it off.
  await h.db.query(
    `insert into settings (tenant_id, key, value) values ($1, 'platform_owns_verification', '0')`,
    [tenant],
  )
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

/**
 * A seller can exist before a payout destination does.
 *
 * `POST /v1/sellers` used to require one in the same request, and the schema
 * enforced it: `country`, `payout_provider`, `beneficiary_token` and
 * `masked_destination` were all `not null`. Nothing about accruing money ever
 * read a destination — `held` and `available` are ledger sums keyed on
 * `deal_id` and `seller_id` — so the only thing that was ever actually
 * blocked was the payout, and `seller_capabilities` has answered "No payout
 * destination has been registered" since `20260807000007`. It was dead code:
 * `seed_primary_destination` always ran, because the columns it read from
 * were never null. `20260814000001` makes both halves reachable.
 */
describe('a seller can exist before a payout destination does', () => {
  /** A seller as `POST /v1/sellers` creates one with no destination at all. */
  async function sellerWithNoDestination(name = 'No destination yet'): Promise<string> {
    const { rows: [s] } = await h.db.query<{ id: string }>(
      `insert into sellers (tenant_id, name, created_at)
       values ($1, $2, now() - interval '400 days')
       returning id`,
      [tenant, name],
    )
    return s.id
  }

  test('the row is created with every destination column null', async () => {
    const seller = await sellerWithNoDestination()
    const { rows: [s] } = await h.db.query<{
      country: string | null
      token: string | null
      masked: string | null
    }>(
      `select country, beneficiary_token as token, masked_destination as masked
         from sellers where id = $1`,
      [seller],
    )
    expect(s.country).toBeNull()
    expect(s.token).toBeNull()
    expect(s.masked).toBeNull()
  })

  test('the seed trigger writes no destination row for one', async () => {
    // The trap this migration exists to avoid: firing the trigger anyway would
    // write a `seller_destinations` row full of nulls, which `seller_capabilities`
    // would find and read as a real (if unverified) destination rather than as
    // none at all.
    const seller = await sellerWithNoDestination()
    const { rows } = await h.db.query<{ n: number }>(
      `select count(*)::int as n from seller_destinations where seller_id = $1`,
      [seller],
    )
    expect(rows[0].n).toBe(0)
  })

  test('capabilities name the missing destination as its own reason', async () => {
    const seller = await sellerWithNoDestination()
    const c = await capabilities(seller)
    expect(c.can).toBe(false)
    expect(c.reasons.join(' ')).toMatch(/No payout destination has been registered/)
  })

  test('money still accrues: a deal can be created and held', async () => {
    // `deals.seller_id` only asks for a row in `sellers`, and the ledger has no
    // idea a destination exists. Held money never depended on one.
    const seller = await sellerWithNoDestination()
    const { rows: [d] } = await h.db.query<{ id: string }>(
      `insert into deals (tenant_id, buyer_ref, seller_id, description, amount,
                          currency, presentment_currency, presentment_amount,
                          buyer_country, provider, status)
       values ($1, 'buyer_1', $2, 'A rental', 100000, 'RWF', 'RWF', 100000, 'RW',
               'fake', 'funded_held')
       returning id`,
      [tenant, seller],
    )
    await h.db.query(
      `insert into ledger (tenant_id, deal_id, entry_type, amount, currency, provider)
       values ($1, $2, 'hold', 100000, 'RWF', 'fake')`,
      [tenant, d.id],
    )

    const { rows: [bal] } = await h.db.query<{ held: string }>(
      `select held::text as held from rail_balances($1)
        where provider = 'fake' and currency = 'RWF'`,
      [tenant],
    )
    expect(Number(bal.held)).toBe(100000)
  })

  test('a payout is held at the eligibility gate, not blocked as a routing failure', async () => {
    // Money accrues and a payout can still be scheduled; what stops is the
    // transfer, at the same gate an unverified destination stops at — not a
    // routing failure, and not a crash from evaluating a null country.
    const seller = await sellerWithNoDestination()
    const payout = await payoutFor(seller)
    expect(await screen(payout)).toBe(true)

    const { rows: [p] } = await h.db.query<{ status: string }>(
      `select status::text from payouts where id = $1`, [payout],
    )
    expect(p.status).toBe('needs_verification')

    const { rows: [sig] } = await h.db.query<{ explanation: string }>(
      `select explanation from risk_signals
        where seller_id = $1 and signal = 'not_eligible'`,
      [seller],
    )
    expect(sig.explanation).toMatch(/No payout destination has been registered/)
  })

  test('route_payout blocks cleanly rather than evaluating a null country', async () => {
    // Not reachable from the cron — `dispatchPayout` never calls `route_payout`
    // once `screen_payout` holds the payout — but `route_payout` is callable on
    // its own, and a destination-less seller has no country for
    // `route_evaluation` to judge routes against. This is the guard against
    // that silently reading as "eligible" for lack of a country to refuse.
    const seller = await sellerWithNoDestination()
    await h.db.query(`select verify_seller($1, 'compliance@payhold')`, [seller])
    await h.db.query(
      `update sellers set sanctions_checked_at = now() where id = $1`, [seller],
    )
    const payout = await payoutFor(seller)

    const { rows: [decision] } = await h.db.query<{
      reason_code: string
      route_id: string | null
    }>(`select reason_code, route_id from route_payout($1)`, [payout]);

    expect(decision.reason_code).toBe('no_eligible_verified_destination')
    expect(decision.route_id).toBeNull()

    const { rows: [p] } = await h.db.query<{ status: string; reason: string | null }>(
      `select status::text, failure_reason as reason from payouts where id = $1`,
      [payout],
    )
    expect(p.status).toBe('blocked')
    expect(p.reason).toMatch(/No verified payout destination has been registered/)
  })

  test('their first destination can be added after the fact, and becomes primary', async () => {
    const seller = await sellerWithNoDestination('Adds one later')
    const { rows: [added] } = await h.db.query<{ id: string; is_primary: boolean }>(
      `select id, is_primary from add_seller_destination(
         $1, $2, 'RW', 'RWF', 'flutterwave_momo', 'tok_first', 'MTN •••• 5150',
         null, 'primary', 'api')`,
      [seller, tenant],
    )
    expect(added.is_primary).toBe(true)

    // The seller row now follows it, through the same sync trigger every other
    // destination change goes through.
    const { rows: [s] } = await h.db.query<{ token: string; country: string }>(
      `select beneficiary_token as token, country from sellers where id = $1`,
      [seller],
    )
    expect(s.token).toBe('tok_first')
    expect(s.country).toBe('RW')
  })

  test('verified and given a destination, the payout clears the gate like any other', async () => {
    const seller = await sellerWithNoDestination('Full circle')
    await h.db.query(`select verify_seller($1, 'compliance@payhold')`, [seller])
    const { rows: [dest] } = await h.db.query<{ id: string }>(
      `select id from add_seller_destination($1, $2, 'RW', 'RWF', 'flutterwave_momo',
                                             'tok_circle', 'MTN •••• 1200', null,
                                             'primary', 'api')`,
      [seller, tenant],
    )
    // `verify_seller` stamps the primary as verified only if it existed at the
    // time it ran; called after adding one, it has to be asked again.
    await h.db.query(`select verify_seller($1, 'compliance@payhold')`, [seller])

    // Their very first destination still serves the standard security hold —
    // `add_seller_destination` never special-cases "first ever", because a
    // seller who has been quietly accruing money is exactly the target an
    // account takeover would want, not less of one for having no prior
    // destination to compare against.
    let c = await capabilities(seller)
    expect(c.can).toBe(false)
    expect(c.reasons.join(' ')).toMatch(/security hold/)

    await h.db.query(`select end_destination_hold($1, $2, 'compliance@payhold')`,
      [dest.id, tenant])

    c = await capabilities(seller)
    expect(c.can).toBe(true)
    expect(await screen(await payoutFor(seller))).toBe(false)
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

describe('§5.1 — verifying one destination', () => {
  // `verify_seller` stamps the primary as part of one identity review, and only
  // the primary that existed when it ran. A destination added afterwards — the
  // seller's one live destination, since §29.17 — is verified on its own.
  async function tenantOf(seller: string): Promise<string> {
    const { rows } = await h.db.query<{ tenant_id: string }>(
      `select tenant_id from sellers where id = $1`, [seller],
    )
    return rows[0].tenant_id
  }

  /** A destination added after the review: it replaces the seeded one. */
  async function addLater(seller: string, tenant: string): Promise<string> {
    const { rows } = await h.db.query<{ id: string }>(
      `select id from add_seller_destination($1, $2, 'RW', 'RWF', 'flutterwave_momo',
                                             'tok_later', 'MTN •••• 4242', 'Later',
                                             'primary', 'grace@autohire.rw')`,
      [seller, tenant],
    )
    return rows[0].id
  }

  // A `Date`, not a string — PGlite hands back the driver's own type, and
  // saying otherwise made an equality check compare object identity.
  async function verifiedAt(id: string): Promise<Date | null> {
    const { rows } = await h.db.query<{ verified_at: Date | null }>(
      `select verified_at from seller_destinations where id = $1`, [id],
    )
    return rows[0].verified_at
  }

  test('a destination added after the review is verified on its own', async () => {
    const seller = await newSeller('Added after review')
    const tenant = await tenantOf(seller)
    await h.db.query(`select verify_seller($1, 'compliance@payhold')`, [seller])
    const later = await addLater(seller, tenant)

    // The review stamped the destination that existed then, not this one.
    expect(await verifiedAt(later)).toBeNull()

    await h.db.query(
      `select verify_seller_destination($1, $2, 'grace@autohire.rw')`,
      [later, tenant],
    )
    expect(await verifiedAt(later)).not.toBeNull()
  })

  test('it does not end the security hold, and refuses a blank actor', async () => {
    const seller = await newSeller('Two stops')
    const tenant = await tenantOf(seller)
    const later = await addLater(seller, tenant)

    await expect(
      h.db.query(`select verify_seller_destination($1, $2, '   ')`, [later, tenant]),
    ).rejects.toThrow(/policy_violation/)

    await h.db.query(
      `select verify_seller_destination($1, $2, 'grace@autohire.rw')`,
      [later, tenant],
    )

    // Each stops a payout on its own and §5.1 wants both, so verifying must
    // never quietly satisfy the hold as well.
    const { rows } = await h.db.query<{ held: boolean }>(
      `select security_hold_until > now() as held
         from seller_destinations where id = $1`,
      [later],
    )
    expect(rows[0].held).toBe(true)
  })

  test('a second call writes no second audit row, and withdrawing reverses it', async () => {
    const seller = await newSeller('Idempotent')
    const tenant = await tenantOf(seller)
    const later = await addLater(seller, tenant)

    await h.db.query(
      `select verify_seller_destination($1, $2, 'grace@autohire.rw')`, [later, tenant],
    )
    const first = await verifiedAt(later)
    await h.db.query(
      `select verify_seller_destination($1, $2, 'someone.else@autohire.rw')`,
      [later, tenant],
    )
    // Unchanged stamp, and no second name against a decision the first made.
    expect(await verifiedAt(later)).toEqual(first)
    const { rows: a } = await h.db.query<{ n: string }>(
      `select count(*) as n from audit_log
        where action = 'seller.destination_verified'
          and details->>'destination_id' = $1`,
      [later],
    )
    expect(Number(a[0].n)).toBe(1)

    await h.db.query(
      `select verify_seller_destination($1, $2, 'grace@autohire.rw', false)`,
      [later, tenant],
    )
    expect(await verifiedAt(later)).toBeNull()
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

  test('a seller cannot have two primaries', async () => {
    const seller = await newSeller('Two destinations')
    await rejects(
      () => h.db.query(
        `insert into seller_destinations (tenant_id, seller_id, country, payout_currency,
                                          payout_provider, beneficiary_token,
                                          masked_destination, is_primary)
         values ($1, $2, 'RW', 'RWF', 'flutterwave_momo', 'tok_2', 'MTN •••• 2', true)`,
        [tenant, seller],
      ),
      // Either index refuses it — the row is primary and live — and Postgres
      // does not promise which it checks first.
      /seller_destinations_one_(primary|live)/,
    )
  })

  test('a backup cannot be registered at all', async () => {
    // §29.17: one live destination per seller, and the backup role is gone. The
    // constraint refuses it before the one-live index would.
    const seller = await newSeller('With backup')
    await rejects(
      () => h.db.query(
        `insert into seller_destinations (tenant_id, seller_id, label, country,
                                          payout_currency, payout_provider,
                                          beneficiary_token, masked_destination, is_backup)
         values ($1, $2, 'Backup', 'RW', 'RWF', 'flutterwave_bank',
                 'tok_backup', 'BK •••• 0073', true)`,
        [tenant, seller],
      ),
      /seller_destinations_no_backup/,
    )

    const { rows } = await h.db.query<{ n: number }>(
      `select count(*)::int as n from seller_destinations where seller_id = $1`, [seller],
    )
    expect(rows[0].n).toBe(1)
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

describe('§5.1 moving a destination', () => {
  /** What `POST /v1/sellers/:id/destinations` calls, with the token already minted. */
  const add = (
    seller: string,
    token: string,
    opts: { role?: string; provider?: string; masked?: string; label?: string } = {},
  ) =>
    h.db.query<{ id: string; is_primary: boolean; is_backup: boolean; hold: string | null }>(
      `select id, is_primary, is_backup, security_hold_until as hold
         from add_seller_destination($1, $2, 'RW', 'RWF', $3, $4, $5, $6, $7, 'api')`,
      [
        seller,
        tenant,
        opts.provider ?? 'flutterwave_bank',
        token,
        opts.masked ?? 'BK •••• 7788',
        opts.label ?? null,
        opts.role ?? 'primary',
      ],
    )

  test('the new destination becomes primary and the old one is archived, not deleted', async () => {
    const seller = await newSeller('Moving house')
    const { rows: [before] } = await h.db.query<{ id: string }>(
      `select id from seller_destinations where seller_id = $1 and is_primary`, [seller],
    )

    const { rows: [added] } = await add(seller, 'tok_new_bank')
    expect(added.is_primary).toBe(true)

    // Archived, not deleted: a paid payout still has to be able to say where it
    // went. It says what replaced it, and it is no longer live.
    const { rows } = await h.db.query<{
      id: string
      is_primary: boolean
      archived: boolean
      replaced_by: string | null
    }>(
      `select id, is_primary, archived_at is not null as archived, replaced_by
         from seller_destinations where seller_id = $1
        order by created_at`,
      [seller],
    )
    expect(rows).toHaveLength(2)
    const old = rows.find((r) => r.id === before.id)!
    expect(old.is_primary).toBe(false)
    expect(old.archived).toBe(true)
    expect(old.replaced_by).toBe(added.id)
    expect(rows.filter((r) => !r.archived).map((r) => r.id)).toEqual([added.id])

    // The seller row follows, through the same trigger that seeds it.
    const { rows: [s] } = await h.db.query<{ token: string }>(
      `select beneficiary_token as token from sellers where id = $1`, [seller],
    )
    expect(s.token).toBe('tok_new_bank')
  })

  test('the new destination arrives unverified and inside its hold', async () => {
    // §5.1's change protection, and the reason this is not `POST /sellers`
    // again. Both conditions are independently enough to refuse a payout.
    const seller = await newSeller('Held after moving')
    await h.db.query(`select verify_seller($1, 'compliance@payhold')`, [seller])
    expect((await capabilities(seller)).can).toBe(true)

    await add(seller, 'tok_moved')

    const c = await capabilities(seller)
    expect(c.can).toBe(false)
    expect(c.reasons.join(' ')).toMatch(/not been verified/)
    expect(c.reasons.join(' ')).toMatch(/security hold/)
    expect(await screen(await payoutFor(seller))).toBe(true)
  })

  test('a backup is refused, and nothing moves', async () => {
    const seller = await newSeller('Adding a backup')
    const { rows: [s0] } = await h.db.query<{ token: string }>(
      `select beneficiary_token as token from sellers where id = $1`, [seller],
    )

    await rejects(
      () => add(seller, 'tok_backup', { role: 'backup' }),
      /backup_destination_removed: A seller has one payout destination; adding one replaces the current one\./,
    )

    const { rows: [s1] } = await h.db.query<{ token: string }>(
      `select beneficiary_token as token from sellers where id = $1`, [seller],
    )
    expect(s1.token).toBe(s0.token)
    const { rows } = await h.db.query<{ n: number }>(
      `select count(*)::int as n from seller_destinations
        where seller_id = $1 and archived_at is null`,
      [seller],
    )
    expect(rows[0].n).toBe(1)
  })

  test('the change is on the audit log, as a mask', async () => {
    const seller = await newSeller('Audited move')
    await add(seller, 'tok_audited', { masked: 'BK •••• 4444' })

    const { rows: [before] } = await h.db.query<{ id: string }>(
      `select id from seller_destinations
        where seller_id = $1 and archived_at is not null`,
      [seller],
    )
    const { rows: [entry] } = await h.db.query<{ details: Record<string, unknown> }>(
      `select details from audit_log
        where action = 'seller.destination_added' and details ->> 'seller_id' = $1`,
      [seller],
    )
    expect(entry.details.destination).toBe('BK •••• 4444')
    // What it replaced is named, so the history reads without a join.
    expect(entry.details.archived_destination_ids).toEqual([before.id])
    // §19: the token is the thing money moves against, and an audit log is
    // where one would survive longest.
    expect(JSON.stringify(entry.details)).not.toContain('tok_audited')
  })

  test('another tenant’s seller does not exist', async () => {
    const { rows: [other] } = await h.db.query<{ id: string }>(
      `insert into tenants (name, slug) values ('Someone Else', 'someone-else') returning id`,
    )
    const seller = await newSeller('Not yours')

    await rejects(
      () => h.db.query(
        `select add_seller_destination($1, $2, 'RW', 'RWF', 'flutterwave_bank',
                                       'tok_theirs', 'BK •••• 0000', null, 'primary', 'api')`,
        [seller, other.id],
      ),
      /does not exist/,
    )
  })

  test('a role that is not primary is refused', async () => {
    const seller = await newSeller('Bad role')
    await rejects(
      () => add(seller, 'tok_bad_role', { role: 'preferred' }),
      /backup_destination_removed/,
    )
  })
})

describe('active — status only, not an eligibility check', () => {
  test('a new seller is active by default', async () => {
    const seller = await newSeller('Freshly registered')
    const { rows: [s] } = await h.db.query<{ active: boolean }>(
      `select active from sellers where id = $1`, [seller],
    )
    expect(s.active).toBe(true)
  })

  test('it can be set false and back, and audits who set it', async () => {
    const seller = await newSeller('Toggled twice')

    const { rows: [off] } = await h.db.query<{ active: boolean }>(
      `select active from set_seller_active($1, $2, false, 'api_key:autohire')`,
      [seller, tenant],
    )
    expect(off.active).toBe(false)

    const { rows: [on] } = await h.db.query<{ active: boolean }>(
      `select active from set_seller_active($1, $2, true, 'api_key:autohire')`,
      [seller, tenant],
    )
    expect(on.active).toBe(true)

    const { rows: logs } = await h.db.query<{ action: string; actor: string }>(
      `select action, actor from audit_log
        where details ->> 'seller_id' = $1
        order by created_at`,
      [seller],
    )
    expect(logs.map((l) => l.action)).toEqual(['seller.deactivated', 'seller.activated'])
    expect(logs.every((l) => l.actor === 'api_key:autohire')).toBe(true)
  })

  test('it carries no weight on the payout path', async () => {
    // The whole point: a seller who stepped back is still owed whatever they
    // already earned. Verified, funded, and inactive — the payout still goes.
    const seller = await newSeller('Stepped back mid-clearance')
    await h.db.query(`select verify_seller($1, 'compliance@payhold')`, [seller])
    await h.db.query(`select set_seller_active($1, $2, false, 'api_key:autohire')`,
      [seller, tenant])

    expect((await capabilities(seller)).can).toBe(true)
    expect(await screen(await payoutFor(seller))).toBe(false)
  })

  test('setting it to what it already is writes no audit row', async () => {
    // The common case once a host toggles: PATCH-and-mostly-no-op. A caller
    // that cannot cheaply know whether a seller is already active — as
    // `payhold-ensure-seller` cannot without a second round trip — has to be
    // able to call this unconditionally on every toggle without flooding the
    // log with "was true, set true" rows.
    const seller = await newSeller('Already active')

    await h.db.query(`select set_seller_active($1, $2, true, 'api_key:autohire')`,
      [seller, tenant])

    const { rows: [n] } = await h.db.query<{ n: number }>(
      `select count(*)::int as n from audit_log
        where action in ('seller.activated', 'seller.deactivated')
          and details ->> 'seller_id' = $1`,
      [seller],
    )
    expect(n.n).toBe(0)
  })

  test('it refuses an unknown seller, and a seller belonging to another tenant', async () => {
    const { rows: [other] } = await h.db.query<{ id: string }>(
      `insert into tenants (name, slug) values ('Active Flag Co', 'active-flag-co') returning id`,
    )
    const seller = await newSeller('Not yours')

    await rejects(
      () => h.db.query(
        `select set_seller_active($1, $2, false, 'api_key:someone-else')`,
        [seller, other.id],
      ),
      /does not exist/,
    )
  })

  test('a blank actor still falls back to a recorded name', async () => {
    // Unlike verify_seller, this is not an attestation — a blank actor is not
    // refused, because the caller may genuinely be an API key with no person
    // behind the request. The audit row still names something.
    const seller = await newSeller('No actor given')
    await h.db.query(`select set_seller_active($1, $2, false, '')`, [seller, tenant])

    const { rows: [log] } = await h.db.query<{ actor: string }>(
      `select actor from audit_log
        where action = 'seller.deactivated' and details ->> 'seller_id' = $1`,
      [seller],
    )
    expect(log.actor).toBe('api')
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

// ---------------------------------------------------------------------------

/**
 * §5.1's step-up: ending a destination's security hold early, and the
 * inconsistency that had to be fixed for it to mean anything.
 *
 * One hold was being read three ways — `seller_capabilities` and `route_payout`
 * off `seller_destinations.security_hold_until`, `screen_payout` off
 * `sellers.destination_changed_at` and the current setting. The first two tests
 * below are the writer; the rest are the three readers agreeing.
 */
describe('§5.1 ending a security hold', () => {
  /** A destination as `POST /v1/sellers/:id/destinations` writes one: held, unverified. */
  const addHeld = async (seller: string, token = 'tok_stepup') => {
    const { rows: [d] } = await h.db.query<{ id: string; hold: string | null }>(
      `select id, security_hold_until as hold
         from add_seller_destination($1, $2, 'RW', 'RWF', 'flutterwave_bank',
                                     $3, 'BK •••• 9910', null, 'primary', 'api')`,
      [seller, tenant, token],
    )
    return d
  }

  const endHold = (destination: string, actor = 'ops@payhold.test') =>
    h.db.query(`select * from end_destination_hold($1, $2, $3)`,
      [destination, tenant, actor])

  test('it refuses to end a hold without a name', async () => {
    const seller = await newSeller('Nameless step-up')
    const dest = await addHeld(seller)

    // The same refusal `verify_seller` and `approve_payout_review` make. A
    // decision without a decider is not a record.
    await rejects(() => endHold(dest.id, '   '), /must record who ended it/)
  })

  test('it ends the hold, names the person, and says how much was skipped', async () => {
    const seller = await newSeller('Rang in and confirmed')
    const dest = await addHeld(seller)
    expect(dest.hold).not.toBeNull()

    await endHold(dest.id)

    const { rows: [after] } = await h.db.query<{ lapsed: boolean }>(
      `select security_hold_until <= now() as lapsed
         from seller_destinations where id = $1`, [dest.id],
    )
    expect(after.lapsed).toBe(true)

    const { rows: [log] } = await h.db.query<{ actor: string; details: Record<string, unknown> }>(
      `select actor, details from audit_log
        where action = 'seller.destination_hold_ended'
          and details ->> 'destination_id' = $1`,
      [dest.id],
    )
    expect(log.actor).toBe('ops@payhold.test')
    // The original expiry, so "how much of it was skipped" is answerable.
    expect(log.details.held_until).toBeTruthy()
    expect(Number(log.details.hours_remaining)).toBeGreaterThan(0)
    // The mask, never the token (§19).
    expect(log.details.destination).toBe('BK •••• 9910')
  })

  test('it is silent rather than wrong on a hold that already lapsed', async () => {
    const seller = await newSeller('Waited it out')
    const dest = await addHeld(seller)

    await endHold(dest.id)
    await endHold(dest.id, 'someone-else@payhold.test')

    // An expired hold is not an error, and a second call must not put a second
    // person's name against a decision the first one already made.
    const { rows: [n] } = await h.db.query<{ n: number }>(
      `select count(*)::int as n from audit_log
        where action = 'seller.destination_hold_ended'
          and details ->> 'destination_id' = $1`,
      [dest.id],
    )
    expect(n.n).toBe(1)
  })

  test('ending the hold does not verify the destination', async () => {
    const seller = await newSeller('Still unverified')
    const dest = await addHeld(seller)
    await endHold(dest.id)

    // Two independent conditions, and §5.1 wants both. Ending one must not
    // quietly satisfy the other — that is the whole shape of the takeover this
    // protects against.
    const c = await capabilities(seller)
    expect(c.reasons.join(' ')).not.toMatch(/security hold/)
    expect(c.reasons.join(' ')).toMatch(/not been verified/)
    expect(await screen(await payoutFor(seller))).toBe(true)
  })

  test('the gate and the capability read describe one hold the same way', async () => {
    const seller = await newSeller('One sentence')
    await h.db.query(`select verify_seller($1, 'ops@payhold.test', true)`, [seller])
    const dest = await addHeld(seller, 'tok_one_sentence')

    // `screen_payout` used to derive its own window from the seller timestamp,
    // so the two could — and did — stop a payout for reasons that did not match
    // what the seller was shown.
    const payout = await payoutFor(seller)
    expect(await screen(payout)).toBe(true)

    const { rows: [sig] } = await h.db.query<{ reasons: string[] }>(
      `select array(select jsonb_array_elements_text(value -> 'reasons')) as reasons
         from risk_signals
        where seller_id = $1 and signal = 'not_eligible'
        order by created_at desc limit 1`,
      [seller],
    )
    const shown = (await capabilities(seller)).reasons
    expect(sig.reasons).toContain(
      shown.find((r) => r.includes('security hold')),
    )

    // And once it is ended, the gate lets go — the payout goes back in the
    // queue rather than waiting for a pass that would never come.
    await endHold(dest.id)
    await h.db.query(`select verify_seller($1, 'ops@payhold.test', true)`, [seller])

    expect(await screen(payout)).toBe(false)
    const { rows: [p] } = await h.db.query<{ status: string }>(
      `select status::text from payouts where id = $1`, [payout],
    )
    expect(p.status).toBe('scheduled')
  })

  test('a seeded primary with no stamp keeps the protection it had', async () => {
    // `sellers_seed_primary_destination` writes no expiry, so these rows have
    // only `destination_changed_at` to go on. The fallback is not a
    // transitional kindness — it is the only protection they get.
    const seller = await newSeller('Seeded, then moved')
    await h.db.query(`select verify_seller($1, 'ops@payhold.test', true)`, [seller])
    await h.db.query(
      `update seller_destinations set security_hold_until = null where seller_id = $1`,
      [seller],
    )
    await h.db.query(
      `update sellers set destination_changed_at = now() - interval '1 hour' where id = $1`,
      [seller],
    )

    const c = await capabilities(seller)
    expect(c.reasons.join(' ')).not.toMatch(/security hold/)

    // The stamp says nothing, so the seller timestamp still decides.
    expect(await screen(await payoutFor(seller))).toBe(true)
  })

  test('the AI role cannot end a security hold', async () => {
    // Invariant 9 as a grant list. A recreated function is granted to PUBLIC,
    // which is the trap `refund_deal` and `resolve_dispute` both walked into.
    const { rows } = await h.db.query<{ allowed: boolean }>(
      `select bool_or(has_function_privilege('payhold_ai', p.oid, 'execute')) as allowed
         from pg_proc p where p.proname = 'end_destination_hold'`,
    )
    expect(rows[0].allowed).toBe(false)
  })
})

// ---------------------------------------------------------------------------

/**
 * §5.1's move back is gone with §29.17. There is one live destination, so there
 * is nothing to move back *to*: returning to a destination used before is adding
 * it again, with a new row and a new hold, like any other destination.
 */
describe('§29.17 nothing moves back', () => {
  test('promote_seller_destination no longer exists', async () => {
    const { rows } = await h.db.query<{ n: number }>(
      `select count(*)::int as n from pg_proc where proname = 'promote_seller_destination'`,
    )
    expect(rows[0].n).toBe(0)
  })

  test('adding a destination used before is a new row inside a new hold', async () => {
    const seller = await newSeller('Back to mobile money')
    await h.db.query(`select verify_seller($1, 'ops@payhold.test', true)`, [seller])
    const { rows: [old] } = await h.db.query<{ token: string; masked: string }>(
      `select beneficiary_token as token, masked_destination as masked
         from seller_destinations where seller_id = $1 and is_primary`,
      [seller],
    )

    await h.db.query(
      `select add_seller_destination($1, $2, 'RW', 'RWF', 'flutterwave_bank',
                                     'tok_bank', 'BK •••• 5757', null, 'primary', 'api')`,
      [seller, tenant],
    )
    const { rows: [back] } = await h.db.query<{ id: string; verified: boolean; held: boolean }>(
      `select id, verified_at is not null as verified, security_hold_until > now() as held
         from add_seller_destination($1, $2, 'RW', 'RWF', 'flutterwave_momo', $3, $4,
                                     null, 'primary', 'api')`,
      [seller, tenant, old.token, old.masked],
    )

    expect(back.verified).toBe(false)
    expect(back.held).toBe(true)
    const { rows } = await h.db.query<{ n: number; live: number }>(
      `select count(*)::int as n, count(*) filter (where archived_at is null)::int as live
         from seller_destinations where seller_id = $1`,
      [seller],
    )
    expect(rows[0]).toEqual({ n: 3, live: 1 })
  })
})
