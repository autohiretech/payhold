/**
 * Invariant tests for the mock engine.
 *
 * These are not really tests of the mock — they are the specification of what
 * payhold-backend must do, written down while it is cheap to change. Each one
 * maps to a rule in CLAUDE.md's "Invariants" section, and each should be
 * reproduced against the real Edge Functions later.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { PayHoldError } from '../types'
import {
  captureDeposit,
  computeBalances,
  computeRailBalances,
  confirmDeal,
  fundDeal,
  openDispute,
  refundDeal,
  requireDeal,
  resolveDispute,
  retryPayout,
  runCron,
} from './engine'
import { seedDb } from './seed'
import { advanceClock, loadDb, resetDb, type MockDb } from './store'

const AUTOHIRE = 'ten_0001'

let db: MockDb

beforeEach(() => {
  localStorage.clear()
  db = resetDb(seedDb)
  loadDb(seedDb)
})

/** A fresh unfunded deal, so each test starts from a known point. */
function newDeal(): string {
  const deal = db.deals.find(
    (d) => d.status === 'created' && d.tenant_id === AUTOHIRE && !d.deposit_amount,
  )
  if (!deal) throw new Error('fixture missing an unfunded deal')
  return deal.id
}

describe('funding', () => {
  it('moves a created deal to funds held and writes a ledger entry', () => {
    const id = newDeal()
    const deal = fundDeal(db, id)

    expect(deal.status).toBe('funded_held')
    expect(deal.provider_ref).toBeTruthy()
    expect(
      db.ledger.filter((e) => e.deal_id === id && e.entry_type === 'hold'),
    ).toHaveLength(1)
  })

  it('refuses to fund the same deal twice', () => {
    const id = newDeal()
    fundDeal(db, id)
    expect(() => fundDeal(db, id)).toThrow(PayHoldError)
  })
})

describe('release requires both confirmations', () => {
  it('does not release on one confirmation', () => {
    const id = newDeal()
    fundDeal(db, id)

    const deal = confirmDeal(db, id, 'buyer')
    expect(deal.status).toBe('confirmed_buyer')
    expect(deal.released_at).toBeNull()
  })

  it('releases the moment the second side confirms', () => {
    const id = newDeal()
    fundDeal(db, id)
    confirmDeal(db, id, 'buyer')

    const deal = confirmDeal(db, id, 'seller')
    expect(deal.status).toBe('released')
    expect(deal.released_at).toBeTruthy()
    expect(deal.payout_due_at).toBeTruthy()
  })

  it('is idempotent — confirming twice from one side changes nothing', () => {
    const id = newDeal()
    fundDeal(db, id)
    confirmDeal(db, id, 'buyer')
    const deal = confirmDeal(db, id, 'buyer')

    expect(deal.confirmations).toHaveLength(1)
    expect(deal.status).toBe('confirmed_buyer')
  })

  it('never double-releases', () => {
    const id = newDeal()
    fundDeal(db, id)
    confirmDeal(db, id, 'buyer')
    confirmDeal(db, id, 'seller')

    // A repeat confirmation on a released deal must not write a second
    // release entry or queue a second payout.
    expect(() => confirmDeal(db, id, 'seller')).toThrow(PayHoldError)
    expect(
      db.ledger.filter((e) => e.deal_id === id && e.entry_type === 'release'),
    ).toHaveLength(1)
    expect(db.payouts.filter((p) => p.deal_id === id)).toHaveLength(1)
  })

  it('queues exactly one payout for the net amount', () => {
    const id = newDeal()
    fundDeal(db, id)
    confirmDeal(db, id, 'buyer')
    const deal = confirmDeal(db, id, 'seller')

    const payout = db.payouts.find((p) => p.deal_id === id)
    expect(payout).toBeDefined()
    expect(payout!.amount).toBe(deal.amount - deal.fee_amount)
    expect(payout!.status).toBe('scheduled')
  })
})

describe('refunds', () => {
  it('reverses a held deal', () => {
    const id = newDeal()
    fundDeal(db, id)
    const deal = refundDeal(db, id, 'Host cancelled')

    expect(deal.status).toBe('refunded')
    expect(
      db.ledger.filter((e) => e.deal_id === id && e.entry_type === 'refund'),
    ).toHaveLength(1)
  })

  it('is blocked once funds have released', () => {
    const id = newDeal()
    fundDeal(db, id)
    confirmDeal(db, id, 'buyer')
    confirmDeal(db, id, 'seller')

    expect(() => refundDeal(db, id, 'too late')).toThrow(
      /already been released/i,
    )
  })

  it('is a no-op when repeated', () => {
    const id = newDeal()
    fundDeal(db, id)
    refundDeal(db, id, 'first')
    refundDeal(db, id, 'second')

    expect(
      db.ledger.filter((e) => e.deal_id === id && e.entry_type === 'refund'),
    ).toHaveLength(1)
  })
})

describe('auto-release timer', () => {
  it('confirms on a silent party behalf and releases', () => {
    const id = newDeal()
    fundDeal(db, id)
    confirmDeal(db, id, 'seller')

    advanceClock(24 * 30)
    const result = runCron(db)

    const deal = requireDeal(db, id)
    expect(result.auto_released).toBeGreaterThan(0)
    expect(deal.status).toBe('released')
    expect(deal.confirmations.find((c) => c.side === 'buyer')?.actor).toBe('auto')
  })

  it('does not fire on a disputed deal', () => {
    const id = newDeal()
    fundDeal(db, id)
    openDispute(db, id, 'buyer', 'Never delivered')

    advanceClock(24 * 60)
    runCron(db)

    expect(requireDeal(db, id).status).toBe('disputed')
  })
})

describe('payouts', () => {
  it('dispatches once the clearance window closes', () => {
    const id = newDeal()
    fundDeal(db, id)
    confirmDeal(db, id, 'buyer')
    confirmDeal(db, id, 'seller')

    advanceClock(24 * 30)
    runCron(db)

    const payout = db.payouts.find((p) => p.deal_id === id)
    expect(payout!.status).toBe('paid')
    expect(requireDeal(db, id).status).toBe('paid_out')
  })

  it('will not send while the tenant is frozen', () => {
    const id = newDeal()
    fundDeal(db, id)
    confirmDeal(db, id, 'buyer')
    confirmDeal(db, id, 'seller')

    const tenant = db.tenants.find((t) => t.id === AUTOHIRE)!
    tenant.status = 'payouts_frozen'

    advanceClock(24 * 30)
    runCron(db)

    expect(db.payouts.find((p) => p.deal_id === id)!.status).toBe('frozen')
    expect(requireDeal(db, id).status).toBe('released')
  })

  it('records a failure and can be retried', () => {
    const id = newDeal()
    fundDeal(db, id)
    confirmDeal(db, id, 'buyer')
    confirmDeal(db, id, 'seller')

    const payout = db.payouts.find((p) => p.deal_id === id)!

    // Dispatch this payout directly rather than through cron: a cron pass also
    // drains the fixtures' other due payouts, and whichever one goes first
    // would consume the failure flag.
    db.fail_next_payout = true
    retryPayout(db, payout.id)

    expect(payout.status).toBe('failed')
    expect(payout.failure_reason).toBeTruthy()
    expect(requireDeal(db, id).status).toBe('released')

    retryPayout(db, payout.id)
    expect(payout.status).toBe('paid')
    expect(payout.attempts).toBe(2)
    expect(requireDeal(db, id).status).toBe('paid_out')
  })
})

describe('disputes', () => {
  it('blocks confirmation while open', () => {
    const id = newDeal()
    fundDeal(db, id)
    openDispute(db, id, 'buyer', 'Damaged')

    expect(() => confirmDeal(db, id, 'buyer')).toThrow(PayHoldError)
  })

  it('resolving in the seller favour releases the funds', () => {
    const id = newDeal()
    fundDeal(db, id)
    const dispute = openDispute(db, id, 'seller', 'Buyer is unreachable')

    resolveDispute(db, dispute.id, 'release', 'Delivery photos check out')

    expect(requireDeal(db, id).status).toBe('released')
    expect(dispute.status).toBe('resolved_released')
  })

  it('resolving in the buyer favour refunds', () => {
    const id = newDeal()
    fundDeal(db, id)
    const dispute = openDispute(db, id, 'buyer', 'Never delivered')

    resolveDispute(db, dispute.id, 'refund', 'No proof of delivery')

    expect(requireDeal(db, id).status).toBe('refunded')
    expect(dispute.status).toBe('resolved_refunded')
  })

  it('cannot be resolved twice', () => {
    const id = newDeal()
    fundDeal(db, id)
    const dispute = openDispute(db, id, 'buyer', 'Never delivered')
    resolveDispute(db, dispute.id, 'refund', 'first')

    expect(() => resolveDispute(db, dispute.id, 'release', 'second')).toThrow(
      PayHoldError,
    )
  })
})

describe('security deposits', () => {
  function depositDeal(): string {
    const deal = db.deals.find(
      (d) => d.status === 'created' && d.deposit_amount && d.tenant_id === AUTOHIRE,
    )
    if (!deal) throw new Error('fixture missing a deal with a deposit')
    return deal.id
  }

  it('cannot capture more than was pre-authorised', () => {
    const id = depositDeal()
    fundDeal(db, id)
    const deal = requireDeal(db, id)

    expect(() => captureDeposit(db, id, deal.deposit_amount! + 1)).toThrow(
      /between 1 and the held deposit/i,
    )
  })

  it('releases the unused remainder on a partial capture', () => {
    const id = depositDeal()
    fundDeal(db, id)
    const deal = requireDeal(db, id)
    const capture = Math.floor(deal.deposit_amount! / 4)

    captureDeposit(db, id, capture)

    const released = db.ledger.find(
      (e) => e.deal_id === id && e.entry_type === 'deposit_release',
    )
    expect(released!.amount).toBe(-(deal.deposit_amount! - capture))
  })

  it('cannot be settled twice', () => {
    const id = depositDeal()
    fundDeal(db, id)
    captureDeposit(db, id, 100)

    expect(() => captureDeposit(db, id, 100)).toThrow(/already been settled/i)
  })
})

describe('balances are derived from the ledger', () => {
  it('counts a funded deal as held', () => {
    const id = newDeal()
    const before = computeBalances(db, AUTOHIRE).find((b) => b.currency === 'RWF')!
    const deal = fundDeal(db, id)
    const after = computeBalances(db, AUTOHIRE).find((b) => b.currency === 'RWF')!

    expect(after.held - before.held).toBe(deal.amount)
  })

  it('moves money from held to clearing on release, net of fee', () => {
    const id = newDeal()
    const deal = fundDeal(db, id)
    const before = computeBalances(db, AUTOHIRE).find((b) => b.currency === 'RWF')!

    confirmDeal(db, id, 'buyer')
    confirmDeal(db, id, 'seller')
    const after = computeBalances(db, AUTOHIRE).find((b) => b.currency === 'RWF')!

    expect(before.held - after.held).toBe(deal.amount)
    expect(after.pending_clearance - before.pending_clearance).toBe(
      deal.amount - deal.fee_amount,
    )
  })

  it('zeroes the deal out once paid', () => {
    const id = newDeal()
    fundDeal(db, id)
    confirmDeal(db, id, 'buyer')
    confirmDeal(db, id, 'seller')

    advanceClock(24 * 30)
    runCron(db)

    const dealEntries = db.ledger.filter((e) => e.deal_id === id)
    const heldNet = dealEntries
      .filter((e) => ['hold', 'release', 'refund'].includes(e.entry_type))
      .reduce((sum, e) => sum + e.amount, 0)

    expect(heldNet).toBe(0)
  })

  it('a refund leaves nothing held', () => {
    const id = newDeal()
    fundDeal(db, id)
    const before = computeBalances(db, AUTOHIRE).find((b) => b.currency === 'RWF')!
    refundDeal(db, id, 'cancelled')
    const after = computeBalances(db, AUTOHIRE).find((b) => b.currency === 'RWF')!

    expect(after.held).toBe(before.held - requireDeal(db, id).amount)
  })
})

describe('rails', () => {
  it('books the money to the rail the buyer actually paid on', () => {
    const id = newDeal()
    const deal = fundDeal(db, id, 'mtn_momo')

    expect(deal.provider).toBe('flutterwave')
    expect(deal.payment_method).toBe('mtn_momo')
    expect(db.ledger.filter((e) => e.deal_id === id).every((e) => e.provider === 'flutterwave')).toBe(true)
  })

  it('moves a deal onto Stripe when the buyer pays by international card', () => {
    const usd = db.deals.find(
      (d) => d.currency === 'USD' && d.buyer_country === 'INTL',
    )
    expect(usd?.provider).toBe('stripe')
    expect(usd?.provider_ref).toMatch(/^pi-/)
  })

  it('refuses a method that market cannot use', () => {
    const id = newDeal() // an RWF deal from Rwanda
    expect(() => fundDeal(db, id, 'mpesa')).toThrow(/not available/i)
  })

  it('keeps the Flutterwave and Stripe balances as separate pots', () => {
    const rails = computeRailBalances(db, AUTOHIRE)
    const providers = new Set(rails.map((r) => r.provider))

    expect(providers.has('flutterwave')).toBe(true)
    expect(providers.has('stripe')).toBe(true)

    // Every rail row belongs to exactly one provider/currency pair.
    const keys = rails.map((r) => `${r.provider}:${r.currency}`)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('has rail balances that sum to the currency totals', () => {
    const currencyTotals = computeBalances(db, AUTOHIRE)
    const rails = computeRailBalances(db, AUTOHIRE)

    for (const total of currencyTotals) {
      const sum = rails
        .filter((r) => r.currency === total.currency)
        .reduce((acc, r) => acc + r.held, 0)
      expect(sum).toBe(total.held)
    }
  })

  it('holds Kenyan M-Pesa money on Flutterwave, not Stripe', () => {
    const kesRails = computeRailBalances(db, AUTOHIRE).filter(
      (r) => r.currency === 'KES',
    )
    expect(kesRails.length).toBeGreaterThan(0)
    expect(kesRails.every((r) => r.provider === 'flutterwave')).toBe(true)
  })
})

describe('tenant isolation', () => {
  it('keeps each tenant balance to its own ledger entries', () => {
    const autohire = computeBalances(db, AUTOHIRE)
    const other = computeBalances(db, 'ten_0002')

    const autohireDeals = new Set(
      db.deals.filter((d) => d.tenant_id === AUTOHIRE).map((d) => d.id),
    )
    const otherEntries = db.ledger.filter((e) => e.tenant_id === 'ten_0002')

    expect(otherEntries.every((e) => !autohireDeals.has(e.deal_id!))).toBe(true)
    expect(autohire).not.toEqual(other)
  })
})

describe('every fixture status is represented', () => {
  it('covers the whole state machine', () => {
    const statuses = new Set(db.deals.map((d) => d.status))

    for (const s of [
      'created',
      'funded_held',
      'confirmed_buyer',
      'confirmed_seller',
      'released',
      'paid_out',
      'refunded',
      'disputed',
    ]) {
      expect(statuses.has(s as never), `missing fixture for ${s}`).toBe(true)
    }
  })
})
