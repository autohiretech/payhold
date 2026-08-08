/**
 * §5.1 and §5.2 — the Payout Preferences and Automatic Routing Center.
 *
 * The mirror of `payhold-backend/tests/payout-routing.test.ts`, case for case.
 * §5.2 lists eight acceptance tests and each one is here in order; the rest is
 * the properties that make those eight safe — a decision recorded whether or
 * not one was found, a deterministic choice, and an engine that stops payouts
 * and does nothing else.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import type { Country, Currency, Payout, PayoutProvider, SellerDestination } from '../types'
import { confirmDeal, fundDeal, requireDeal, runCron } from './engine'
import {
  marketOpen,
  payoutDisplayStatus,
  primaryDestination,
  routeEvaluation,
  routePayout,
} from './routing'
import { seedDb } from './seed'
import { advanceClock, loadDb, mintId, nowIso, resetDb, type MockDb } from './store'

const AUTOHIRE = 'ten_0001'

let db: MockDb

beforeEach(() => {
  localStorage.clear()
  db = resetDb(seedDb)
  loadDb(seedDb)
})

function newDeal(): string {
  const deal = db.deals.find(
    (d) => d.status === 'created' && d.tenant_id === AUTOHIRE && !d.deposit_amount,
  )
  if (!deal) throw new Error('fixture missing an unfunded deal')
  return deal.id
}

/**
 * Point a deal's seller at a destination in a given market, on a given rail.
 *
 * The destination is the record, so this rewrites that row and the seller's
 * copy of it — which the backend keeps in step with a trigger.
 */
function relocate(
  dealId: string,
  country: Country,
  currency: Currency,
  rail: PayoutProvider,
): SellerDestination {
  const seller = db.sellers.find((s) => s.id === requireDeal(db, dealId).seller_id)!
  seller.country = country
  seller.payout_currency = currency
  seller.payout_provider = rail

  const destination = primaryDestination(db, seller.id)!
  Object.assign(destination, {
    country,
    payout_currency: currency,
    payout_provider: rail,
  })
  return destination
}

/** Run a deal to the point where its payout is waiting to be dispatched. */
function payoutFor(dealId: string): Payout {
  fundDeal(db, dealId)
  confirmDeal(db, dealId, 'buyer')
  confirmDeal(db, dealId, 'seller')
  advanceClock(24 * 30)

  const payout = db.payouts.find((p) => p.deal_id === dealId)
  if (!payout) throw new Error('release did not queue a payout')
  return payout
}

/** The rail this deal's seller is actually tokenized against. */
function railOf(dealId: string): PayoutProvider {
  return primaryDestination(db, requireDeal(db, dealId).seller_id)!.payout_provider
}

function platformRoute(rail: PayoutProvider) {
  return db.payout_routes.find(
    (r) => r.tenant_id === null && r.payout_provider === rail,
  )!
}

function disable(rail: PayoutProvider): void {
  platformRoute(rail).enabled = false
}

// ---------------------------------------------------------------------------
// §5.2's eight cases
// ---------------------------------------------------------------------------

describe('§5.2 — payout routing acceptance tests', () => {
  it('1. a verified Rwanda seller on mobile money gets an eligible RWF route', () => {
    const id = newDeal()
    relocate(id, 'RW', 'RWF', 'flutterwave_momo')
    const decision = routePayout(db, payoutFor(id))

    expect(decision.reason_code).toBe('routed')
    expect(decision.payout_provider).toBe('flutterwave_momo')
    expect(decision.provider).toBe('flutterwave')
    expect(decision.method).toBe('mobile_money')
    // Rank 10: the launch rail leads because sellers there use it, and §5.1
    // wants the ranking recorded rather than implied by insertion order.
    expect(decision.ranking_score).toBe(10)
  })

  it('2. a seller on Venmo is told why — today because it is off, and after that because of where they are', () => {
    // As shipped, Venmo is declared and disabled (§29.3), so a seller who picks
    // it gets a sentence rather than silence.
    const id = newDeal()
    relocate(id, 'US', 'USD', 'venmo')
    const payout = payoutFor(id)
    payout.currency = 'USD'

    // `provider_unavailable`, not `provider_disabled`: Phase 6 separated "the
    // adapter is not built" from "we switched this corridor off". Same sentence
    // to the seller, different next action for us.
    expect(routePayout(db, payout).reason_code).toBe('provider_unavailable')
    expect(payout.failure_reason).toBe('venmo is not available for payouts yet.')

    // §5.2's case is about the border, so switch the rail on for one tenant to
    // reach it. Hypothetical: it borrows a live adapter, because a route whose
    // adapter is unbuilt cannot be enabled. Nothing sends here — the test asks
    // the engine, not a provider.
    db.payout_routes.push({
      ...db.payout_routes.find((r) => r.payout_provider === 'venmo')!,
      id: 'route_venmo_tenant',
      tenant_id: AUTOHIRE,
      provider: 'stripe',
      enabled: true,
    })

    expect(routePayout(db, payout).reason_code).toBe('routed')

    relocate(id, 'AE', 'AED', 'venmo')
    payout.status = 'scheduled'
    expect(routePayout(db, payout).reason_code).toBe('country_not_supported')
    expect(payout.failure_reason).toBe('venmo cannot pay a destination in AE.')
  })

  it('3. a China seller on Alipay is routed only once the partner is approved', () => {
    // §5: "Do not promise cross-border payout until approved." The route exists
    // so the seller gets an answer; its adapter — `china_wallet_partner` — is
    // declared and unbuilt, so it cannot run.
    const id = newDeal()
    relocate(id, 'CN', 'CNY', 'alipay')
    const payout = payoutFor(id)
    payout.currency = 'CNY'

    expect(routePayout(db, payout).reason_code).toBe('provider_unavailable')
    expect(payout.status).toBe('blocked')
  })

  it('4. a seller with no verified destination is blocked from payout', () => {
    const id = newDeal()
    const payout = payoutFor(id)
    primaryDestination(db, requireDeal(db, id).seller_id)!.verified_at = null

    const decision = routePayout(db, payout)
    expect(decision.reason_code).toBe('destination_not_verified')
    expect(decision.route_id).toBeNull()
    expect(payout.status).toBe('blocked')
  })

  it('5. a failed primary does not lose funds and offers the verified backup', () => {
    const id = newDeal()
    const seller = requireDeal(db, id).seller_id
    const primary = primaryDestination(db, seller)!

    // A verified backup on a different rail — the case one pair of columns on
    // `sellers` could not have expressed.
    db.seller_destinations.push({
      ...primary,
      id: mintId(db, 'dest'),
      label: 'Backup',
      payout_provider: railOf(id) === 'flutterwave_bank'
        ? 'flutterwave_momo'
        : 'flutterwave_bank',
      beneficiary_token: 'ben_fw_bk_test',
      masked_destination: 'BK •••• 9910',
      is_primary: false,
      is_backup: true,
      verified_at: nowIso(),
    })

    // Only the primary rail goes down. The money is untouched by that.
    disable(railOf(id))

    const payout = payoutFor(id)

    // §5.1 permits the backup *only* after a failed primary payout and the
    // policy check. One attempt is not enough.
    payout.status = 'failed'
    payout.attempts = 1
    expect(routePayout(db, payout).reason_code).toBe('provider_disabled')

    payout.attempts = 2
    const decision = routePayout(db, payout)

    expect(decision.reason_code).toBe('routed')
    expect(decision.payout_provider).not.toBe(primary.payout_provider)
    expect(decision.is_fallback).toBe(true)

    // §5.1: the seller must be notified and the change logged.
    expect(
      db.audit.filter(
        (a) => a.action === 'payout.route_changed' && a.details.payout_id === payout.id,
      ),
    ).toHaveLength(1)
  })

  it('6. a currency mismatch records the conversion detail', () => {
    // §5.1: "Pay in the original currency where possible. If conversion is
    // necessary, show rate, markup, source and final amount."
    const id = newDeal()
    const payout = payoutFor(id)
    requireDeal(db, id).presentment_currency = 'USD'

    expect(routePayout(db, payout).fx_source).toBe('payhold_indicative')
  })

  it('6b. and a payout in the currency collected has no rate to show', () => {
    // The case §5.1 prefers — "pay in the original currency where possible" —
    // and it is a separate test because the decision is recorded once per
    // outcome: re-routing the same payout after changing the deal underneath it
    // would be asking a question the engine never faces.
    const payout = payoutFor(newDeal())

    expect(routePayout(db, payout).fx_source).toBeNull()
  })

  it('7. a new payout destination is held for security review', () => {
    // §5.1's change protection: a stolen session must not be able to redirect a
    // payout and have it leave before anybody notices.
    const id = newDeal()
    const payout = payoutFor(id)
    db.sellers.find((s) => s.id === requireDeal(db, id).seller_id)!
      .destination_changed_at = nowIso()

    runCron(db)
    expect(payout.status).toBe('needs_verification')
  })

  it('8. a disabled provider leaves payout selection with no redeploy', () => {
    const id = newDeal()
    const payout = payoutFor(id)

    // One row, one field. No deploy, no restart, no code path changed.
    disable(railOf(id))
    expect(routePayout(db, payout).reason_code).toBe('provider_disabled')
    expect(payout.status).toBe('blocked')

    // And back, which is the half that makes `blocked` survivable: nothing had
    // to be approved, because nothing was ever waiting on a decision.
    platformRoute(railOf(id)).enabled = true

    expect(routePayout(db, payout).reason_code).toBe('routed')
    expect(payout.status).toBe('scheduled')
  })
})

// ---------------------------------------------------------------------------
// The properties underneath those eight
// ---------------------------------------------------------------------------

describe('a decision is a record, not a return value', () => {
  it('every outcome writes the checks behind it', () => {
    const id = newDeal()
    relocate(id, 'RW', 'RWF', 'flutterwave_momo')
    const decision = routePayout(db, payoutFor(id))

    // §5.1: "store the selected provider, selected method, eligibility checks,
    // ranking score, currency, fees, exchange-rate source and reason code."
    expect(decision.checks.length).toBeGreaterThan(1)
    expect(decision.checks.find((c) => c.preferred)?.payout_provider)
      .toBe('flutterwave_momo')

    // Including the losers, which is what answers "why not the one I picked".
    expect(decision.checks.find((c) => c.payout_provider === 'venmo')?.reason_code)
      .toBe('provider_unavailable')
  })

  it('an unchanged outcome does not write a second row', () => {
    // `blocked` is re-evaluated on every dispatch pass. An unconditional write
    // would bury the decision that explains something under identical copies.
    const id = newDeal()
    relocate(id, 'US', 'USD', 'venmo')
    const payout = payoutFor(id)
    payout.currency = 'USD'

    routePayout(db, payout)
    routePayout(db, payout)
    routePayout(db, payout)

    expect(db.payout_decisions.filter((d) => d.payout_id === payout.id)).toHaveLength(1)
  })

  it('a changed outcome does write one', () => {
    const id = newDeal()
    const payout = payoutFor(id)

    routePayout(db, payout)
    disable(railOf(id))
    routePayout(db, payout)

    expect(
      db.payout_decisions
        .filter((d) => d.payout_id === payout.id)
        .map((d) => d.reason_code),
    ).toEqual(['routed', 'provider_disabled'])
  })
})

describe('the choice is deterministic', () => {
  it('a tenant route replaces the platform default rather than joining it', () => {
    // The property the whole table turns on. If both rows survived the filter,
    // a tenant switching a rail off would leave the platform's enabled row
    // still eligible, and "disabled" would mean nothing.
    const id = newDeal()
    relocate(id, 'RW', 'RWF', 'flutterwave_momo')
    const payout = payoutFor(id)

    db.payout_routes.push({
      ...platformRoute('flutterwave_momo'),
      id: 'route_fw_momo_tenant',
      tenant_id: AUTOHIRE,
      enabled: false,
    })

    expect(routePayout(db, payout).reason_code).toBe('provider_disabled')

    // Another tenant is unaffected — the override is theirs alone.
    expect(
      routeEvaluation(db, 'ten_other', 'RW', 'RWF', 90_000, 'flutterwave_momo')
        .find((c) => c.preferred)?.eligible,
    ).toBe(true)
  })

  it('routes come back in the same order every time', () => {
    // §5.1's `bySellerPreferenceThenReliabilityThenCost`. A tie broken by
    // insertion order would make the engine non-deterministic in exactly the
    // way the section forbids.
    const order = () =>
      routeEvaluation(db, AUTOHIRE, 'RW', 'RWF', 90_000, 'flutterwave_bank')
        .map((c) => c.payout_provider)

    const first = order()
    expect(order()).toEqual(first)
    // Preference outranks rank: the bank rail is ranked below MoMo and still
    // leads, because it is the one the destination is tokenized against.
    expect(first[0]).toBe('flutterwave_bank')
  })

  it('a route ceiling is a reason, not a silent skip', () => {
    const id = newDeal()
    relocate(id, 'RW', 'RWF', 'flutterwave_momo')
    const payout = payoutFor(id)
    platformRoute('flutterwave_momo').max_amount = 1

    expect(routePayout(db, payout).reason_code).toBe('above_route_maximum')
    expect(payout.failure_reason)
      .toBe('This amount is above the maximum flutterwave_momo will send.')
  })

  it('a suspended route is out of service and says which kind of out', () => {
    const id = newDeal()
    const payout = payoutFor(id)
    platformRoute(railOf(id)).risk_status = 'suspended'

    expect(routePayout(db, payout).reason_code).toBe('route_suspended')
  })
})

describe('the engine stops payouts and does nothing else', () => {
  it('blocking writes no ledger entry and does not touch the deal', () => {
    // Invariant 11, for the routing engine. It may stop a payout and may do
    // nothing else — no transfer, no ledger write, no state change to the deal.
    const id = newDeal()
    relocate(id, 'US', 'USD', 'venmo')
    const payout = payoutFor(id)
    payout.currency = 'USD'

    const entries = db.ledger.length
    const status = requireDeal(db, id).status

    routePayout(db, payout)

    expect(db.ledger).toHaveLength(entries)
    expect(requireDeal(db, id).status).toBe(status)
  })

  it('money in flight is never re-routed', () => {
    // §5.1's central rule. Choosing a different destination for a transfer the
    // provider already has is the silent redirection the section forbids.
    const payout = payoutFor(newDeal())
    payout.status = 'processing'

    expect(() => routePayout(db, payout)).toThrow(/already with the provider/)
  })

  it('a provider refusal is not overwritten by "no route"', () => {
    // A rail that said no is a more specific fact than "nothing eligible", and
    // it is what a retry reads. Blocking on top would lose it.
    const id = newDeal()
    const payout = payoutFor(id)
    disable(railOf(id))
    payout.status = 'failed'
    payout.attempts = 1
    payout.failure_reason = 'Provider rejected the transfer'

    routePayout(db, payout)

    expect(payout.status).toBe('failed')
    expect(payout.failure_reason).toBe('Provider rejected the transfer')
  })

  it('a disputed deal blocks the payout rather than sending it', () => {
    // §8, and the reason screening runs before routing: routing un-blocks a
    // payout it can route, so a disputed one would be let back into the queue.
    const id = newDeal()
    const payout = payoutFor(id)
    requireDeal(db, id).status = 'disputed'

    runCron(db)

    expect(payout.status).toBe('blocked')
    expect(payout.failure_reason).toBe('The deal is disputed')
  })
})

// ---------------------------------------------------------------------------
// §5.1's status vocabulary
// ---------------------------------------------------------------------------

describe('payoutDisplayStatus', () => {
  it('a scheduled payout reads by its deal, not by its own row', () => {
    // `clearing` and `available` are questions about the deal's window. Storing
    // them on the payout as well would be one fact with two writers.
    const id = newDeal()
    fundDeal(db, id)
    confirmDeal(db, id, 'buyer')
    confirmDeal(db, id, 'seller')

    const payout = db.payouts.find((p) => p.deal_id === id)!
    expect(requireDeal(db, id).status).toBe('clearing')
    expect(payoutDisplayStatus(db, payout)).toBe('clearing')

    advanceClock(24 * 30)
    runCron(db)
    // The deal has been paid out by now, so ask the question of a payout that
    // is still waiting: what `available` means is "past the window, unsent".
    requireDeal(db, id).status = 'released'
    payout.status = 'scheduled'
    expect(payoutDisplayStatus(db, payout)).toBe('available')
  })

  it('every stop a seller cannot act on reads as blocked', () => {
    const payout = payoutFor(newDeal())

    for (const status of ['frozen', 'held_for_review', 'blocked'] as const) {
      payout.status = status
      expect(payoutDisplayStatus(db, payout), status).toBe('blocked')
    }

    // The one they can act on keeps its own name, because the next action is
    // theirs and the word is what tells them so.
    payout.status = 'needs_verification'
    expect(payoutDisplayStatus(db, payout)).toBe('needs_verification')
  })
})

// ---------------------------------------------------------------------------
// §9 and §12 — the capability matrix
// ---------------------------------------------------------------------------

describe('§9 — adapters declare what they can do', () => {
  it('an adapter going down takes only its own routes', () => {
    const id = newDeal()
    relocate(id, 'RW', 'RWF', 'flutterwave_momo')
    const payout = payoutFor(id)
    expect(routePayout(db, payout).reason_code).toBe('routed')

    // One row, one field. No deploy — §15 phase 3.
    db.provider_capabilities.find((c) => c.provider === 'flutterwave')!.enabled = false

    payout.status = 'scheduled'
    expect(routePayout(db, payout).reason_code).toBe('provider_unavailable')

    // Both Flutterwave rails, because the adapter is what went down — and
    // nobody else's.
    const checks = routeEvaluation(db, AUTOHIRE, 'US', 'USD', 90_000, 'stripe_connect')
    expect(checks.find((c) => c.payout_provider === 'stripe_connect')?.eligible).toBe(true)
    expect(checks.find((c) => c.payout_provider === 'flutterwave_bank')?.reason_code)
      .toBe('provider_unavailable')
  })

  it('one adapter carries several rails', () => {
    // Venmo destinations are reached through PayPal's API, and both Chinese
    // wallets through one partner. `payout_provider` names the rail, `provider`
    // names the adapter, and conflating them is what two types avoid.
    const byPayPal = db.payout_routes
      .filter((r) => r.tenant_id === null && r.provider === 'paypal')
      .map((r) => r.payout_provider)
      .sort()
    expect(byPayPal).toEqual(['paypal', 'venmo'])
  })

  it('mobile money is Flutterwave\'s and no one else\'s', () => {
    // The structural reason both adapters exist, stated as data so a caller can
    // ask rather than branch on the provider's name.
    const wallets = db.provider_capabilities
      .filter((c) => c.implemented && c.supports_mobile_money)
      .map((c) => c.provider)
      .sort()
    expect(wallets).toEqual(['fake', 'flutterwave'])
  })
})

describe('§12 — closing a market is a row', () => {
  it('a closed market blocks payout selection, ahead of every rail reason', () => {
    const id = newDeal()
    relocate(id, 'RW', 'RWF', 'flutterwave_momo')
    const payout = payoutFor(id)
    expect(routePayout(db, payout).reason_code).toBe('routed')

    db.payment_markets.push({
      id: mintId(db, 'mkt'),
      tenant_id: null,
      country: 'RW',
      collect: false,
      payout: false,
      reason: 'Suspended pending a licence review',
      created_at: nowIso(),
    })

    payout.status = 'scheduled'
    const closed = routePayout(db, payout)
    expect(closed.reason_code).toBe('market_closed')
    expect(payout.failure_reason)
      .toBe('PayHold is not sending payouts to RW at the moment.')
  })

  it('a market nobody has ruled on is open', () => {
    // The overlay property. `payment_markets` is not a copy of the registry —
    // it holds deliberate departures from it, and absence means nothing was
    // decided rather than that everything is shut.
    expect(db.payment_markets).toEqual([])
    expect(marketOpen(db, AUTOHIRE, 'KE', 'payout')).toBe(true)
  })

  it('collect and payout close independently', () => {
    // A market can be one-way. Collecting from a country we cannot pay into is
    // the normal case for most of the world, and the reverse happens too.
    db.payment_markets.push({
      id: mintId(db, 'mkt'),
      tenant_id: null,
      country: 'RW',
      collect: true,
      payout: false,
      reason: 'Payouts paused; collection unaffected',
      created_at: nowIso(),
    })

    expect(marketOpen(db, AUTOHIRE, 'RW', 'collect')).toBe(true)
    expect(marketOpen(db, AUTOHIRE, 'RW', 'payout')).toBe(false)
  })

  it('a tenant closure replaces the platform default rather than joining it', () => {
    db.payment_markets.push({
      id: mintId(db, 'mkt'),
      tenant_id: null,
      country: 'RW',
      collect: false,
      payout: false,
      reason: 'Platform: closed',
      created_at: nowIso(),
    }, {
      id: mintId(db, 'mkt'),
      tenant_id: AUTOHIRE,
      country: 'RW',
      collect: true,
      payout: true,
      reason: 'This tenant has its own licence',
      created_at: nowIso(),
    })

    // The same rule `resolvedRoutes` applies to rails: more specific wins, and
    // it wins in both directions rather than only towards "closed".
    expect(marketOpen(db, AUTOHIRE, 'RW', 'payout')).toBe(true)
    expect(marketOpen(db, 'ten_0002', 'RW', 'payout')).toBe(false)
  })
})
