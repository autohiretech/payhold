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
  computeDealAmounts,
  computeRailBalances,
  computeSellerWallets,
  confirmDeal,
  fundDeal,
  openDispute,
  refundDeal,
  requireDeal,
  resolveDispute,
  retryPayout,
  runCron,
  settingsFor,
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
    // The second confirmation releases the money from the hold and starts the
    // safety window. `released` is the far side of that window (spec §6).
    expect(deal.status).toBe('clearing')
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

  it('after release, the seller payable is reversed rather than refused', () => {
    // V1 refused this outright and §29.6 adopts §7.1.3 instead: reverse the
    // payable, refund the buyer. The guard moved from the lifecycle to the
    // cumulative amount.
    const id = newDeal()
    fundDeal(db, id)
    confirmDeal(db, id, 'buyer')
    confirmDeal(db, id, 'seller')

    const deal = refundDeal(db, id, 'Damaged on arrival')
    expect(deal.status).toBe('refunded')

    // The un-release keeps `held` at zero rather than driving it negative.
    const held = db.ledger
      .filter((e) => e.deal_id === id && ['hold', 'release', 'refund'].includes(e.entry_type))
      .reduce((n, e) => n + e.amount, 0)
    expect(held).toBe(0)
  })

  it('a partial refund leaves the rest held and the deal running — §7.1.2', () => {
    const id = newDeal()
    const before = fundDeal(db, id).presentment_amount

    const deal = refundDeal(db, id, 'One day cut short', Math.round(before / 4))

    // §29.8: a partial refund is an amount, not a lifecycle position.
    expect(deal.status).toBe('funded_held')
    expect(computeDealAmounts(db, id).refunded).toBe(Math.round(before / 4))
  })

  it('refunds cannot add up to more than the buyer paid', () => {
    const id = newDeal()
    const paid = fundDeal(db, id).presentment_amount

    refundDeal(db, id, 'First', Math.round(paid * 0.7))
    expect(() => refundDeal(db, id, 'Too much', Math.round(paid * 0.4))).toThrow(
      /exceeds the/i,
    )
  })

  it('a refund after payout books what the seller owes — §7.1.4', () => {
    const id = newDeal()
    fundDeal(db, id)
    confirmDeal(db, id, 'buyer')
    confirmDeal(db, id, 'seller')
    advanceClock(24 * 30)
    runCron(db)

    expect(requireDeal(db, id).status).toBe('paid_out')

    refundDeal(db, id, 'Chargeback', 10_000)
    const a = computeDealAmounts(db, id)

    // Nothing left the provider: there was nothing there to send.
    expect(a.receivable).toBe(10_000)
    expect(requireDeal(db, id).status).toBe('paid_out')
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

describe('fees, tax and reserve — spec §7', () => {
  /** What a provider would actually be holding, from money that crossed it. */
  function providerHolds(): number {
    return db.ledger
      .filter(
        (e) =>
          e.tenant_id === AUTOHIRE &&
          ['hold', 'provider_fee', 'refund', 'payout'].includes(e.entry_type),
      )
      .reduce((n, e) => n + e.amount, 0)
  }

  function ledgerSays(): number {
    return computeRailBalances(db, AUTOHIRE).reduce(
      (n, r) =>
        n + r.held + r.pending_clearance + r.available + r.reserved + r.fees_retained,
      0,
    )
  }

  it('a released deal does not drift by our own commission', () => {
    // The bug this pins: the platform fee is a debit in the clearing pool, but
    // nothing sweeps it out of the tenant's provider balance — under
    // bring-your-own-keys there is no such transfer. Without `fees_retained`
    // the two figures differed by exactly the fee on every released deal, and
    // drift freezes that tenant's payouts automatically.
    const id = newDeal()
    fundDeal(db, id)
    confirmDeal(db, id, 'buyer')
    confirmDeal(db, id, 'seller')

    expect(ledgerSays()).toBe(providerHolds())
  })

  it('the breakdown adds up to what the buyer paid', () => {
    const id = newDeal()
    const deal = requireDeal(db, id)
    deal.tax_amount = 4_000
    fundDeal(db, id)
    confirmDeal(db, id, 'buyer')
    confirmDeal(db, id, 'seller')

    const a = computeDealAmounts(db, id)
    expect(a.tax).toBe(4_000)
    expect(
      a.platform_fee + a.provider_fee + a.tax + a.reserve +
        a.paid_out + a.refunded + a.seller_net,
    ).toBe(a.buyer_paid)
  })

  it('a reserve is carved out of the pool and is not payable', () => {
    settingsFor(db, AUTOHIRE).reserve_rate = 0.2
    settingsFor(db, AUTOHIRE).reserve_days = 30

    const id = newDeal()
    fundDeal(db, id)
    confirmDeal(db, id, 'buyer')
    confirmDeal(db, id, 'seller')

    const a = computeDealAmounts(db, id)
    expect(a.reserve).toBeGreaterThan(0)
    // Whatever is reserved is not in the seller's net, and not in `available`.
    const rails = computeRailBalances(db, AUTOHIRE)
    expect(rails.reduce((n, r) => n + r.reserved, 0)).toBe(a.reserve)
  })

  it('the reserve ends exactly when the payout comes due', () => {
    settingsFor(db, AUTOHIRE).reserve_rate = 0.2
    settingsFor(db, AUTOHIRE).reserve_days = 30

    const id = newDeal()
    fundDeal(db, id)
    confirmDeal(db, id, 'buyer')
    confirmDeal(db, id, 'seller')

    // One payout per deal, so a reserve outliving it would have nothing to
    // send it.
    const deal = requireDeal(db, id)
    expect(deal.reserve_until).toBe(deal.payout_due_at)
  })

  it('returning the reserve moves nothing in or out of the vault', () => {
    settingsFor(db, AUTOHIRE).reserve_rate = 0.2
    settingsFor(db, AUTOHIRE).reserve_days = 30

    const id = newDeal()
    fundDeal(db, id)
    confirmDeal(db, id, 'buyer')
    confirmDeal(db, id, 'seller')

    // The reserve ends at exactly the moment the payout comes due, so no clock
    // position isolates the return from the transfer. What is checkable — and
    // what actually matters — is that the reconciliation identity survives the
    // whole lifecycle: buckets in, buckets out, still equal to the money that
    // genuinely crossed the provider boundary.
    advanceClock(24 * 60)
    runCron(db)

    expect(computeDealAmounts(db, id).reserve).toBe(0)
    expect(ledgerSays()).toBe(providerHolds())
  })
})

describe('the clearance window — spec §6', () => {
  it('the second confirmation lands in clearing, with the money already out of the hold', () => {
    const id = newDeal()
    fundDeal(db, id)
    confirmDeal(db, id, 'buyer')
    const deal = confirmDeal(db, id, 'seller')

    expect(deal.status).toBe('clearing')
    expect(deal.released_at).toBeTruthy()
    // The release entry is written here, not on entry to `released`. The state
    // names which side of the safety window the deal is on; it does not decide
    // when money moves.
    expect(
      db.ledger.filter((e) => e.deal_id === id && e.entry_type === 'release'),
    ).toHaveLength(1)
  })

  it('a deal inside its window is not matured', () => {
    const id = newDeal()
    fundDeal(db, id)
    confirmDeal(db, id, 'buyer')
    confirmDeal(db, id, 'seller')

    runCron(db)
    expect(requireDeal(db, id).status).toBe('clearing')
  })

  it('a deal past its window becomes released, and the client is told', () => {
    const id = newDeal()
    fundDeal(db, id)
    confirmDeal(db, id, 'buyer')
    confirmDeal(db, id, 'seller')

    advanceClock(24 * 30)
    const result = runCron(db)

    expect(result.cleared).toBeGreaterThan(0)
    expect(
      db.webhook_deliveries.some(
        (d) => d.deal_id === id && d.event === 'order.released',
      ),
    ).toBe(true)
  })

  it('maturing moves no money', () => {
    const id = newDeal()
    fundDeal(db, id)
    confirmDeal(db, id, 'buyer')
    confirmDeal(db, id, 'seller')

    const before = db.ledger.filter((e) => e.deal_id === id).length
    advanceClock(24 * 30)
    runCron(db)

    // The payout that follows writes its own entry, so count only what the
    // promotion itself could have added.
    const added = db.ledger
      .filter((e) => e.deal_id === id)
      .slice(before)
      .filter((e) => e.entry_type !== 'payout')
    expect(added).toHaveLength(0)
  })

  it('a dispute opened during clearing freezes the promotion', () => {
    const id = newDeal()
    fundDeal(db, id)
    confirmDeal(db, id, 'buyer')
    confirmDeal(db, id, 'seller')
    openDispute(db, id, 'buyer', 'Damage found on return')

    advanceClock(24 * 30)
    runCron(db)

    expect(requireDeal(db, id).status).toBe('disputed')
  })

  it('a deal carrying its own clearing days wins over the tenant setting — §14', () => {
    const id = newDeal()
    const deal = requireDeal(db, id)
    deal.completion_policy = {
      completion_event: 'vehicle_returned',
      auto_complete_after_hours: 72,
      clearing_days: 1,
    }

    fundDeal(db, id)
    confirmDeal(db, id, 'buyer')
    confirmDeal(db, id, 'seller')

    const days =
      (new Date(requireDeal(db, id).payout_due_at!).getTime() -
        new Date(requireDeal(db, id).released_at!).getTime()) /
      86_400_000
    expect(Math.round(days)).toBe(1)
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
    expect(deal.status).toBe('clearing')
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
    // Still `clearing`: this retry is a person pushing a payout inside the
    // safety window, so nothing has matured it. The failure must not move the
    // deal either — a payout that did not go changes nothing about the deal.
    expect(requireDeal(db, id).status).toBe('clearing')

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

    resolveDispute(db, dispute.id, 'release', 'Delivery photos check out', { decidedBy: 'user:ops@payhold.test' })

    expect(requireDeal(db, id).status).toBe('clearing')
    expect(dispute.status).toBe('resolved_released')
  })

  it('resolving in the buyer favour refunds', () => {
    const id = newDeal()
    fundDeal(db, id)
    const dispute = openDispute(db, id, 'buyer', 'Never delivered')

    resolveDispute(db, dispute.id, 'refund', 'No proof of delivery', { decidedBy: 'user:ops@payhold.test' })

    expect(requireDeal(db, id).status).toBe('refunded')
    expect(dispute.status).toBe('resolved_refunded')
  })

  it('cannot be resolved twice', () => {
    const id = newDeal()
    fundDeal(db, id)
    const dispute = openDispute(db, id, 'buyer', 'Never delivered')
    resolveDispute(db, dispute.id, 'refund', 'first', { decidedBy: 'user:ops@payhold.test' })

    expect(() => resolveDispute(db, dispute.id, 'release', 'second', { decidedBy: 'user:ops@payhold.test' })).toThrow(
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
    const deal = fundDeal(db, id, 'mobile_money')

    expect(deal.provider).toBe('flutterwave')
    expect(deal.payment_method).toBe('mobile_money')
    expect(deal.payment_network).toBe('MTN')
    expect(db.ledger.filter((e) => e.deal_id === id).every((e) => e.provider === 'flutterwave')).toBe(true)
  })

  it('moves a deal onto Stripe when the buyer pays by international card', () => {
    const usd = db.deals.find(
      (d) => d.currency === 'USD' && d.buyer_country === 'US',
    )
    expect(usd?.provider).toBe('stripe')
    expect(usd?.provider_ref).toMatch(/^pi-/)
  })

  it('refuses a method that market cannot use', () => {
    // Rwanda has a bank-transfer rail in RWF but not in USD, and routing
    // follows what the buyer is charged.
    const id = newDeal()
    const deal = requireDeal(db, id)
    deal.presentment_currency = 'USD'
    expect(() => fundDeal(db, id, 'bank_transfer')).toThrow(/not available/i)
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

  /**
   * The property the seller wallet rests on. A wallet computed a second way is
   * free to disagree with the balance the reconciliation pass checks against a
   * provider, and the number a seller reads would be the one nobody checks.
   *
   * `fees_retained` is excluded on purpose and is asserted non-zero, so this
   * cannot pass by every bucket happening to be equal.
   */
  it('has seller wallets that sum to the tenant balance, less what is ours', () => {
    const totals = computeBalances(db, AUTOHIRE)
    const wallets = computeSellerWallets(db, AUTOHIRE)

    for (const total of totals) {
      const mine = wallets.filter((w) => w.currency === total.currency)
      const sum = (pick: (w: (typeof mine)[number]) => number) =>
        mine.reduce((acc, w) => acc + pick(w), 0)

      expect(sum((w) => w.held)).toBe(total.held)
      expect(sum((w) => w.pending_clearance)).toBe(total.pending_clearance)
      expect(sum((w) => w.available)).toBe(total.available)
      expect(sum((w) => w.reserved)).toBe(total.reserved)
      expect(sum((w) => w.paid_out)).toBe(total.paid_out)
    }

    expect(totals.some((t) => t.fees_retained > 0)).toBe(true)
  })

  it('keeps one seller wallet to that seller, and to their tenant', () => {
    const all = computeSellerWallets(db, AUTOHIRE)
    const first = all[0]
    expect(first).toBeDefined()
    if (!first) return

    const one = computeSellerWallets(db, AUTOHIRE, first.seller_id)
    expect(one.every((w) => w.seller_id === first.seller_id)).toBe(true)

    // A seller of another account is unreachable, not merely filtered out of
    // the list — the same thing tenant scoping means everywhere else.
    const foreign = computeSellerWallets(db, 'ten_0002', first.seller_id)
    expect(foreign).toEqual([])
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
