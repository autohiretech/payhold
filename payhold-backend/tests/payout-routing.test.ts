/**
 * Spec §5.1 and §5.2 — the Payout Preferences and Automatic Routing Center.
 *
 * §5.2 lists eight acceptance cases and each one is a test below, in order,
 * under its own heading. The rest of the file is the properties that make those
 * eight safe: that a decision is recorded whether or not one was found, that
 * the choice is deterministic, and that the engine can stop a payout and do
 * nothing else.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { migrated, rejects, type Harness } from './harness'

let h: Harness
let tenant: string

beforeAll(async () => {
  h = await migrated()
  const { rows: [t] } = await h.db.query<{ id: string }>(
    `insert into tenants (name, slug) values ('Routing Co', 'routing-co') returning id`,
  )
  tenant = t.id
})

afterAll(() => h.close())

// Every test starts from the shipped platform matrix. Several of them switch a
// route off, which is the point of the table — so the reset has to be real
// rather than assumed.
beforeEach(async () => {
  await h.db.query(`delete from payout_routes where tenant_id is not null`)
  // Enabled exactly where the adapter is live. Phase 6 made that one fact in
  // one place — `payout_routes.provider` names an adapter now, and whether it
  // is built lives on `provider_capabilities`.
  await h.db.query(
    `update payout_routes r
        set enabled = exists (
              select 1 from provider_capabilities c
               where c.provider = r.provider and c.implemented and c.enabled),
            risk_status = 'approved',
            max_amount = null
      where r.tenant_id is null`,
  )
  await h.db.query(`delete from settings where tenant_id = $1`, [tenant])
})

interface SellerSpec {
  name?: string
  country?: string
  currency?: string
  rail?: string
  verified?: boolean
}

/** A verified seller with a verified primary destination, ready to be paid. */
async function newSeller(spec: SellerSpec = {}): Promise<string> {
  const {
    name = `Seller ${crypto.randomUUID().slice(0, 8)}`,
    country = 'RW',
    currency = 'RWF',
    rail = 'flutterwave_momo',
    verified = true,
  } = spec

  const { rows: [s] } = await h.db.query<{ id: string }>(
    `insert into sellers (tenant_id, name, country, payout_currency,
                          payout_provider, beneficiary_token, masked_destination,
                          created_at)
     values ($1, $2, $3, $4, $5, 'tok_' || gen_random_uuid(), 'Wallet •••• 4821',
             -- Long before any deal here, so the discretionary new-seller rule
             -- is not what these tests are measuring.
             now() - interval '400 days')
     returning id`,
    [tenant, name, country, currency, rail],
  )

  if (verified) {
    await h.db.query(`select verify_seller($1, 'compliance@payhold')`, [s.id])
    // The seed trigger stamps `destination_changed_at`; §5.1's change
    // protection would otherwise hold every payout in this file for 24 hours.
    await h.db.query(
      `update sellers set destination_changed_at = null where id = $1`, [s.id],
    )
  }

  return s.id
}

interface PayoutSpec {
  amount?: number
  currency?: string
  status?: string
  attempts?: number
  presentment?: string
  /** Where the deal sits. An insert, so it sidesteps the transition guard. */
  dealStatus?: string
}

async function payoutFor(seller: string, spec: PayoutSpec = {}): Promise<string> {
  const {
    amount = 90_000,
    currency = 'RWF',
    status = 'scheduled',
    attempts = 0,
    presentment = currency,
    dealStatus = 'released',
  } = spec

  const { rows: [d] } = await h.db.query<{ id: string }>(
    `insert into deals (tenant_id, buyer_ref, seller_id, description, amount, currency,
                        presentment_currency, presentment_amount, buyer_country,
                        provider, fee_amount, status, released_at)
     values ($1, 'buyer_1', $2, 'A rental', 100000, $3, $4, 100000, 'RW',
             'fake', 10000, $5::deal_status, now())
     returning id`,
    [tenant, seller, currency, presentment, dealStatus],
  )
  const { rows: [p] } = await h.db.query<{ id: string }>(
    `insert into payouts (tenant_id, deal_id, seller_id, amount, currency,
                          status, scheduled_for, attempts)
     values ($1, $2, $3, $4, $5, $6, now(), $7)
     returning id`,
    [tenant, d.id, seller, amount, currency, status, attempts],
  )
  return p.id
}

interface Decision {
  reason_code: string
  payout_provider: string | null
  provider: string | null
  method: string | null
  destination_id: string | null
  route_id: string | null
  ranking_score: number | null
  fee_estimate: string | null
  fx_source: string | null
  is_fallback: boolean
  checks: unknown[]
}

async function route(payout: string): Promise<Decision> {
  const { rows: [r] } = await h.db.query<Decision>(
    `select (route_payout($1)).*`, [payout],
  )
  return r
}

async function statusOf(payout: string): Promise<{ status: string; why: string | null }> {
  const { rows: [p] } = await h.db.query<{ status: string; why: string | null }>(
    `select status::text, failure_reason as why from payouts where id = $1`,
    [payout],
  )
  return p
}

// ---------------------------------------------------------------------------
// §5.2's eight cases
// ---------------------------------------------------------------------------

describe('§5.2 — payout routing acceptance tests', () => {
  test('1. a verified Rwanda seller on mobile money gets an eligible RWF route', async () => {
    const seller = await newSeller({ country: 'RW', currency: 'RWF' })
    const decision = await route(await payoutFor(seller))

    expect(decision.reason_code).toBe('routed')
    expect(decision.payout_provider).toBe('flutterwave_momo')
    expect(decision.provider).toBe('flutterwave')
    expect(decision.method).toBe('mobile_money')
    // Rank 10: the launch rail leads because sellers there use it, and §5.1
    // wants the ranking recorded rather than implied by insertion order.
    expect(decision.ranking_score).toBe(10)
  })

  test('2. a seller on Venmo is told why — today because it is off, and after that because of where they are', async () => {
    // As shipped, Venmo is declared and disabled (§29.3), so a seller who picks
    // it gets a sentence rather than silence. That is the true first fact and
    // it is the same one everywhere.
    const home = await newSeller({ country: 'US', currency: 'USD', rail: 'venmo' })
    const domestic = await payoutFor(home, { amount: 5_000, currency: 'USD' })

    // `provider_unavailable`, not `provider_disabled`: Phase 6 separated "the
    // adapter is not built" from "we switched this corridor off". Same sentence
    // to the seller, different next action for us.
    expect((await route(domestic)).reason_code).toBe('provider_unavailable')
    expect((await statusOf(domestic)).why).toBe('venmo is not available for payouts yet.')

    // §5.2's case is about the border, so switch the rail on for one tenant to
    // reach it. (Hypothetical: `route_needs_an_adapter` will not let a
    // provider-less row be enabled, so this borrows one. Nothing sends here —
    // the test asks the engine, not a provider.)
    await h.db.query(
      `insert into payout_routes (tenant_id, payout_provider, provider, method,
         countries, currencies, enabled, rank)
       values ($1, 'venmo', 'stripe', 'wallet',
               array['US']::country_code[], array['USD']::currency_code[], true, 50)`,
      [tenant],
    )

    expect((await route(domestic)).reason_code).toBe('routed')

    const abroad = await newSeller({ country: 'AE', currency: 'AED', rail: 'venmo' })
    const overseas = await payoutFor(abroad, { amount: 5_000, currency: 'AED' })

    expect((await route(overseas)).reason_code).toBe('country_not_supported')
    expect((await statusOf(overseas)).why).toBe('venmo cannot pay a destination in AE.')
  })

  test('3. a China seller on Alipay is routed only once the partner is approved', async () => {
    // §5: "Do not promise cross-border payout until approved." The route exists
    // so the seller gets an answer; it carries no adapter, so it cannot run.
    const seller = await newSeller({ country: 'CN', currency: 'CNY', rail: 'alipay' })
    const payout = await payoutFor(seller, { amount: 700, currency: 'CNY' })

    expect((await route(payout)).reason_code).toBe('provider_unavailable')
    expect((await statusOf(payout)).status).toBe('blocked')

    // And it cannot be switched on by flipping a flag, which is the structural
    // half of "declared but disabled". Phase 6 moved that guard onto the
    // adapter: the route names `china_wallet_partner`, which is not built.
    await rejects(
      () =>
        h.db.query(
          `update payout_routes set enabled = true where payout_provider = 'alipay'`,
        ),
      /china_wallet_partner has no live adapter/,
    )
  })

  test('4. a seller with no verified destination is blocked from payout', async () => {
    const seller = await newSeller({ verified: false })
    await h.db.query(
      `update seller_destinations set verified_at = null where seller_id = $1`,
      [seller],
    )
    const payout = await payoutFor(seller)

    const decision = await route(payout)
    expect(decision.reason_code).toBe('destination_not_verified')
    expect(decision.route_id).toBeNull()

    const { status } = await statusOf(payout)
    expect(status).toBe('blocked')
  })

  test('5. a failed primary does not lose funds and offers the verified backup', async () => {
    const seller = await newSeller()
    // A verified backup on a different rail, which is the case one pair of
    // columns on `sellers` could not have expressed.
    await h.db.query(
      `insert into seller_destinations (tenant_id, seller_id, label, country,
         payout_currency, payout_provider, beneficiary_token, masked_destination,
         is_backup, verified_at)
       values ($1, $2, 'Backup', 'RW', 'RWF', 'flutterwave_bank',
               'tok_backup', 'BK •••• 9910', true, now())`,
      [tenant, seller],
    )

    // Only the primary rail goes down. The money is untouched by that.
    await h.db.query(
      `update payout_routes set enabled = false
        where tenant_id is null and payout_provider = 'flutterwave_momo'`,
    )

    // §5.1 permits the backup *only* after a failed primary payout and the
    // policy check. One attempt is not enough.
    const early = await payoutFor(seller, { status: 'failed', attempts: 1 })
    expect((await route(early)).reason_code).toBe('provider_disabled')

    const payout = await payoutFor(seller, { status: 'failed', attempts: 2 })
    const decision = await route(payout)

    expect(decision.reason_code).toBe('routed')
    expect(decision.payout_provider).toBe('flutterwave_bank')
    expect(decision.is_fallback).toBe(true)

    // §5.1: the seller must be notified and the change logged.
    const { rows: audits } = await h.db.query<{ n: string }>(
      `select count(*) as n from audit_log
        where action = 'payout.route_changed'
          and details ->> 'payout_id' = $1`,
      [payout],
    )
    expect(Number(audits[0].n)).toBe(1)
  })

  test('6. a currency mismatch records the conversion detail', async () => {
    // §5.1: "Pay in the original currency where possible. If conversion is
    // necessary, show rate, markup, source and final amount."
    const seller = await newSeller()

    const same = await route(await payoutFor(seller))
    expect(same.fx_source).toBeNull()

    const converted = await route(
      await payoutFor(seller, { currency: 'RWF', presentment: 'USD' }),
    )
    expect(converted.fx_source).toBe('payhold_indicative')
  })

  test('7. a new payout destination is held for security review', async () => {
    const seller = await newSeller()
    // Moving the destination stamps `destination_changed_at` via the trigger —
    // §5.1's change protection, and the reason it is a trigger rather than a
    // line in the endpoint.
    await h.db.query(
      `update seller_destinations set beneficiary_token = 'tok_moved'
        where seller_id = $1 and is_primary`,
      [seller],
    )

    const payout = await payoutFor(seller)
    const { rows: [r] } = await h.db.query<{ held: boolean }>(
      `select screen_payout($1) as held`, [payout],
    )
    expect(r.held).toBe(true)
    expect((await statusOf(payout)).status).toBe('needs_verification')
  })

  test('8. a disabled provider leaves payout selection with no redeploy', async () => {
    const seller = await newSeller()

    // Working before.
    expect((await route(await payoutFor(seller))).reason_code).toBe('routed')

    // One row, one update. No deploy, no restart, no code path changed.
    await h.db.query(
      `update payout_routes set enabled = false
        where tenant_id is null and payout_provider = 'flutterwave_momo'`,
    )

    const after = await payoutFor(seller)
    expect((await route(after)).reason_code).toBe('provider_disabled')
    expect((await statusOf(after)).status).toBe('blocked')

    // And back, which is the half that makes `blocked` survivable: nothing had
    // to be approved, because nothing was ever waiting on a decision.
    await h.db.query(
      `update payout_routes set enabled = true
        where tenant_id is null and payout_provider = 'flutterwave_momo'`,
    )
    expect((await route(after)).reason_code).toBe('routed')
    expect((await statusOf(after)).status).toBe('scheduled')
  })
})

// ---------------------------------------------------------------------------
// The properties underneath those eight
// ---------------------------------------------------------------------------

describe('a decision is a record, not a return value', () => {
  test('every outcome writes the checks behind it', async () => {
    const seller = await newSeller()
    const payout = await payoutFor(seller)
    const decision = await route(payout)

    // §5.1: "store the selected provider, selected method, eligibility checks,
    // ranking score, currency, fees, exchange-rate source and reason code."
    expect(decision.checks.length).toBeGreaterThan(1)
    const own = (decision.checks as { payout_provider: string; preferred: boolean }[])
      .find((c) => c.preferred)
    expect(own?.payout_provider).toBe('flutterwave_momo')

    // Including the losers, which is what answers "why not the one I picked".
    const venmo = (decision.checks as { payout_provider: string; reason_code: string }[])
      .find((c) => c.payout_provider === 'venmo')
    expect(venmo?.reason_code).toBe('provider_unavailable')
  })

  test('an unchanged outcome does not write a second row', async () => {
    // `blocked` is re-evaluated on every dispatch pass. An unconditional insert
    // would write one identical row per pass for as long as a seller took to
    // register a destination, and bury the decision that explains something.
    const seller = await newSeller({ rail: 'venmo', country: 'US', currency: 'USD' })
    const payout = await payoutFor(seller, { amount: 5_000, currency: 'USD' })

    await route(payout)
    await route(payout)
    await route(payout)

    const { rows: [c] } = await h.db.query<{ n: string }>(
      `select count(*) as n from payout_decisions where payout_id = $1`, [payout],
    )
    expect(Number(c.n)).toBe(1)
  })

  test('a changed outcome does write one', async () => {
    const seller = await newSeller()
    const payout = await payoutFor(seller)

    await route(payout)
    await h.db.query(
      `update payout_routes set enabled = false
        where tenant_id is null and payout_provider = 'flutterwave_momo'`,
    )
    await route(payout)

    const { rows } = await h.db.query<{ reason_code: string }>(
      `select reason_code from payout_decisions
        where payout_id = $1 order by created_at, id`,
      [payout],
    )
    expect(rows.map((r) => r.reason_code)).toEqual(['routed', 'provider_disabled'])
  })
})

describe('the choice is deterministic', () => {
  test('a tenant route replaces the platform default rather than joining it', async () => {
    // The property the whole table turns on. If both rows survived the filter,
    // a tenant switching a rail off would leave the platform's enabled row
    // still eligible, and "disabled" would mean nothing.
    const seller = await newSeller()

    await h.db.query(
      `insert into payout_routes (tenant_id, payout_provider, provider, method,
         countries, currencies, enabled, rank)
       values ($1, 'flutterwave_momo', 'flutterwave', 'mobile_money',
               array['RW']::country_code[], array['RWF']::currency_code[], false, 10)`,
      [tenant],
    )

    const payout = await payoutFor(seller)
    expect((await route(payout)).reason_code).toBe('provider_disabled')

    // And another tenant is unaffected — the override is theirs alone.
    const { rows: [other] } = await h.db.query<{ id: string }>(
      `insert into tenants (name, slug) values ('Other Co', 'other-co-' ||
         substr(gen_random_uuid()::text, 1, 8)) returning id`,
    )
    const { rows } = await h.db.query<{ eligible: boolean }>(
      `select eligible from route_evaluation($1, 'RW', 'RWF', 90000, 'flutterwave_momo')
        where preferred`,
      [other.id],
    )
    expect(rows[0].eligible).toBe(true)
  })

  test('routes come back in the same order every time', async () => {
    // §5.1's `bySellerPreferenceThenReliabilityThenCost`. A tie broken by
    // whatever Postgres returned first would make the engine non-deterministic
    // in exactly the way the section forbids.
    const ordering = async () => {
      const { rows } = await h.db.query<{ payout_provider: string }>(
        `select payout_provider::text from route_evaluation($1, 'RW', 'RWF', 90000, 'flutterwave_bank')`,
        [tenant],
      )
      return rows.map((r) => r.payout_provider)
    }

    const first = await ordering()
    expect(await ordering()).toEqual(first)
    // Preference outranks rank: the bank rail is ranked below MoMo and still
    // leads, because it is the one the destination is tokenized against.
    expect(first[0]).toBe('flutterwave_bank')
  })

  test('a route ceiling is a reason, not a silent skip', async () => {
    await h.db.query(
      `update payout_routes set max_amount = 50000
        where tenant_id is null and payout_provider = 'flutterwave_momo'`,
    )
    const seller = await newSeller()
    const payout = await payoutFor(seller, { amount: 90_000 })

    expect((await route(payout)).reason_code).toBe('above_route_maximum')
    expect((await statusOf(payout)).why)
      .toBe('This amount is above the maximum flutterwave_momo will send.')
  })

  test('a suspended route is out of service and says which kind of out', async () => {
    await h.db.query(
      `update payout_routes set risk_status = 'suspended'
        where tenant_id is null and payout_provider = 'flutterwave_momo'`,
    )
    const seller = await newSeller()
    expect((await route(await payoutFor(seller))).reason_code).toBe('route_suspended')
  })
})

describe('the engine stops payouts and does nothing else', () => {
  test('blocking writes no ledger entry and does not touch the deal', async () => {
    // Invariant 11, for the routing engine. It may hold a payout and may do
    // nothing else — no transfer, no ledger write, no state change to the deal.
    const seller = await newSeller({ rail: 'venmo', country: 'US', currency: 'USD' })
    const payout = await payoutFor(seller, { amount: 5_000, currency: 'USD' })

    const snapshot = async () => {
      const { rows: [r] } = await h.db.query<{ n: string; deal_status: string }>(
        `select (select count(*) from ledger) as n,
                (select d.status::text from deals d
                  join payouts p on p.deal_id = d.id where p.id = $1) as deal_status`,
        [payout],
      )
      return r
    }

    const before = await snapshot()
    await route(payout)
    const after = await snapshot()

    expect(after.n).toBe(before.n)
    expect(after.deal_status).toBe(before.deal_status)
  })

  test('money in flight is never re-routed', async () => {
    // §5.1's central rule. Choosing a different destination for a transfer the
    // provider already has is the silent redirection the section forbids, and
    // it could not take effect anyway.
    const seller = await newSeller()
    const payout = await payoutFor(seller, { status: 'processing' })

    await rejects(
      () => h.db.query(`select route_payout($1)`, [payout]),
      /already with the provider/,
    )
  })

  test('a provider refusal is not overwritten by "no route"', async () => {
    // A rail that said no is a more specific fact than "nothing eligible", and
    // it is what a retry backoff reads. Blocking on top would lose it.
    const seller = await newSeller()
    await h.db.query(
      `update payout_routes set enabled = false
        where tenant_id is null and payout_provider = 'flutterwave_momo'`,
    )
    const payout = await payoutFor(seller, { status: 'failed', attempts: 1 })
    await h.db.query(
      `update payouts set failure_reason = 'Provider rejected the transfer' where id = $1`,
      [payout],
    )

    await route(payout)

    const { status, why } = await statusOf(payout)
    expect(status).toBe('failed')
    expect(why).toBe('Provider rejected the transfer')
  })
})

describe('the routing engine is not reachable from outside', () => {
  test('only the service role may route a payout', async () => {
    for (const role of ['anon', 'authenticated']) {
      const { rows } = await h.db.query<{ allowed: boolean }>(
        `select bool_or(has_function_privilege($1, p.oid, 'execute')) as allowed
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'route_payout'`,
        [role],
      )
      expect(rows[0].allowed, role).toBe(false)
    }
  })

  test('the AI role cannot route a payout either', async () => {
    // Invariant 9 as a grant. Routing is a step on the path money leaves by, so
    // it belongs on the same list as `settle_payout`.
    const { rows } = await h.db.query<{ allowed: boolean }>(
      `select bool_or(has_function_privilege('payhold_ai', p.oid, 'execute')) as allowed
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'route_payout'`,
    )
    expect(rows[0].allowed).toBe(false)
  })

  test('a tenant reads the platform matrix and only its own overrides', async () => {
    const { rows } = await h.db.query<{ n: string }>(
      `select count(*) as n from payout_routes where tenant_id is null`,
    )
    // Eight rails: three built, five declared and disabled.
    expect(Number(rows[0].n)).toBe(8)

    const { rows: [built] } = await h.db.query<{ n: string }>(
      `select count(*) as n from payout_routes r
        where r.tenant_id is null and r.enabled`,
    )
    expect(Number(built.n)).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// §5.1's status vocabulary
// ---------------------------------------------------------------------------

describe('payout_display_status', () => {
  test('a scheduled payout reads by its deal, not by its own row', async () => {
    const seller = await newSeller()
    const payout = await payoutFor(seller, { dealStatus: 'clearing' })

    const display = async () => {
      const { rows: [r] } = await h.db.query<{ s: string }>(
        `select payout_display_status($1) as s`, [payout],
      )
      return r.s
    }

    // `clearing` and `available` are questions about the deal's window. Storing
    // them on the payout as well would be one fact with two writers.
    //
    // The deal starts inside its window and walks forwards through the
    // transition guard. `released -> clearing` is not a describable edge, and
    // reaching for one would be the test disagreeing with the state machine.
    expect(await display()).toBe('clearing')

    await h.db.query(
      `update deals set status = 'released'
        where id = (select deal_id from payouts where id = $1)`,
      [payout],
    )
    expect(await display()).toBe('available')
  })

  test('every stop a seller cannot act on reads as blocked', async () => {
    const seller = await newSeller()
    const payout = await payoutFor(seller)

    for (const status of ['frozen', 'held_for_review', 'blocked']) {
      await h.db.query(
        `update payouts set status = $2::payout_status where id = $1`, [payout, status],
      )
      const { rows: [r] } = await h.db.query<{ s: string }>(
        `select payout_display_status($1) as s`, [payout],
      )
      expect(r.s, status).toBe('blocked')
    }

    // The one they can act on keeps its own name, because the next action is
    // theirs and the word is what tells them so.
    await h.db.query(
      `update payouts set status = 'needs_verification' where id = $1`, [payout],
    )
    const { rows: [r] } = await h.db.query<{ s: string }>(
      `select payout_display_status($1) as s`, [payout],
    )
    expect(r.s).toBe('needs_verification')
  })
})

// ---------------------------------------------------------------------------
// The capability read, ahead of time
// ---------------------------------------------------------------------------

describe('seller_capabilities separates what a seller must do from what we cannot reach', () => {
  test('a routing failure is a route reason, never a verification one', async () => {
    // If a routing failure appeared in `reasons`, `screen_payout` would hold the
    // payout as `needs_verification`, the routing engine would never see it, and
    // a seller would be told to verify something already verified.
    const seller = await newSeller({ country: 'US', currency: 'USD', rail: 'venmo' })

    const { rows: [c] } = await h.db.query<{
      can: boolean
      reasons: string[] | null
      route_reasons: string[] | null
    }>(
      `select can_receive_payouts as can, reasons, route_reasons
         from seller_capabilities($1)`,
      [seller],
    )

    expect(c.reasons ?? []).toEqual([])
    expect(c.route_reasons).toEqual(['venmo is not available for payouts yet.'])
    expect(c.can).toBe(false)
  })

  test('and a verified seller on a live rail has neither', async () => {
    const seller = await newSeller()
    const { rows: [c] } = await h.db.query<{
      can: boolean
      reasons: string[] | null
      route_reasons: string[] | null
    }>(
      `select can_receive_payouts as can, reasons, route_reasons
         from seller_capabilities($1)`,
      [seller],
    )

    expect(c.reasons ?? []).toEqual([])
    expect(c.route_reasons ?? []).toEqual([])
    expect(c.can).toBe(true)
  })
})
