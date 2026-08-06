/**
 * Reconciliation — ledger against what each provider says it holds.
 *
 * The job compares and decides. That is the whole difference between this and
 * what came before: previously the dev panel wrote an alert directly, which
 * proved only that the dashboard could render one. Here the drift is set on the
 * *provider's* side and the pass has to find it.
 *
 * The rule it enforces is asymmetric on purpose. Drift freezes payouts by
 * itself, because money we cannot account for must stop moving immediately.
 * Nothing unfreezes by itself, because "the numbers agree again" is not the
 * same as "someone understood why they did not."
 */

import { beforeEach, describe, expect, it } from 'vitest'
import {
  computeRailBalances,
  confirmDeal,
  driftKey,
  fundDeal,
  runCron,
  runReconciliation,
} from './engine'
import { seedDb } from './seed'
import { advanceClock, loadDb, resetDb, type MockDb } from './store'

const AUTOHIRE = 'ten_0001'
const EQUIPCO = 'ten_0002'

let db: MockDb

beforeEach(() => {
  localStorage.clear()
  db = resetDb(seedDb)
  loadDb(seedDb)
})

function tenant(id: string) {
  return db.tenants.find((t) => t.id === id)!
}

function openAlerts(tenantId: string) {
  return db.alerts.filter((a) => a.tenant_id === tenantId && !a.resolved_at)
}

describe('finding drift', () => {
  it('raises nothing when the books agree', () => {
    runReconciliation(db, AUTOHIRE)

    expect(openAlerts(AUTOHIRE)).toHaveLength(0)
    expect(tenant(AUTOHIRE).status).toBe('active')
  })

  it('finds the disagreement the fixtures seed and freezes that tenant', () => {
    // Rwanda Equipment's Flutterwave balance is 250.00 RWF more than their
    // ledger accounts for. Nobody has told the dashboard that — the pass has
    // to notice.
    runReconciliation(db, EQUIPCO)

    const [alert] = openAlerts(EQUIPCO)
    expect(alert).toBeDefined()
    expect(alert!.provider).toBe('flutterwave')
    expect(alert!.currency).toBe('RWF')
    expect(alert!.drift).toBe(25_000)
    expect(alert!.provider_balance - alert!.ledger_balance).toBe(alert!.drift)
    expect(tenant(EQUIPCO).status).toBe('payouts_frozen')
  })

  it('leaves other tenants alone', () => {
    runReconciliation(db)

    expect(openAlerts(AUTOHIRE)).toHaveLength(0)
    expect(tenant(AUTOHIRE).status).toBe('active')
  })

  it('compares per rail, not per currency', () => {
    const rails = computeRailBalances(db, AUTOHIRE)
    const stripeUsd = rails.find(
      (r) => r.provider === 'stripe' && r.currency === 'USD',
    )
    expect(stripeUsd).toBeDefined()

    db.provider_drift[driftKey(AUTOHIRE, 'stripe', 'USD')] = -500
    runReconciliation(db, AUTOHIRE)

    const alerts = openAlerts(AUTOHIRE)
    expect(alerts).toHaveLength(1)
    // Flutterwave also holds USD-denominated rows for this tenant; only the
    // rail that actually disagrees is flagged.
    expect(alerts[0]!.provider).toBe('stripe')
    expect(alerts[0]!.drift).toBe(-500)
  })

  it('measures everything still with the provider, not just held funds', () => {
    // Release a deal so its money sits in clearance rather than in hold. It has
    // not left the provider, so the reconciled figure must not move.
    const id = db.deals.find(
      (d) => d.status === 'created' && d.tenant_id === AUTOHIRE && !d.deposit_amount,
    )!.id
    fundDeal(db, id)
    runReconciliation(db, AUTOHIRE)
    expect(openAlerts(AUTOHIRE)).toHaveLength(0)

    confirmDeal(db, id, 'buyer')
    confirmDeal(db, id, 'seller')
    runReconciliation(db, AUTOHIRE)

    expect(openAlerts(AUTOHIRE)).toHaveLength(0)
  })
})

describe('one alert per rail', () => {
  it('refreshes the open alert instead of piling up copies', () => {
    runReconciliation(db, EQUIPCO)
    const first = openAlerts(EQUIPCO)[0]!
    const detectedAt = first.detected_at

    advanceClock(6)
    runReconciliation(db, EQUIPCO)
    runReconciliation(db, EQUIPCO)

    const alerts = openAlerts(EQUIPCO)
    expect(alerts).toHaveLength(1)
    expect(alerts[0]!.id).toBe(first.id)
    // Still the same finding, seen again — first sighting preserved.
    expect(alerts[0]!.detected_at).toBe(detectedAt)
    expect(alerts[0]!.last_seen_at).not.toBe(detectedAt)
  })

  it('closes the alert when the drift goes away', () => {
    runReconciliation(db, EQUIPCO)
    expect(openAlerts(EQUIPCO)).toHaveLength(1)

    db.provider_drift[driftKey(EQUIPCO, 'flutterwave', 'RWF')] = 0
    runReconciliation(db, EQUIPCO)

    expect(openAlerts(EQUIPCO)).toHaveLength(0)
    expect(db.alerts.find((a) => a.tenant_id === EQUIPCO)!.resolved_at).toBeTruthy()
  })

  it('does not unfreeze on its own when the drift goes away', () => {
    runReconciliation(db, EQUIPCO)
    db.provider_drift[driftKey(EQUIPCO, 'flutterwave', 'RWF')] = 0
    runReconciliation(db, EQUIPCO)

    // The books agree again, and payouts stay stopped until a person says so.
    expect(tenant(EQUIPCO).status).toBe('payouts_frozen')
  })

  it('freezes once, not on every pass', () => {
    runReconciliation(db, EQUIPCO)
    runReconciliation(db, EQUIPCO)
    runReconciliation(db, EQUIPCO)

    const freezes = db.audit.filter(
      (a) => a.tenant_id === EQUIPCO && a.action === 'tenant.payouts_frozen',
    )
    expect(freezes).toHaveLength(1)
  })
})

describe('drift stops money leaving', () => {
  it('runs before payouts in the same cron pass', () => {
    // Rwanda Equipment starts the pass looking healthy — the drift is on
    // Flutterwave's side and nothing has checked yet. If dispatch ran first,
    // their due payouts would go out before the freeze landed.
    expect(tenant(EQUIPCO).status).toBe('active')

    // Give them a payout waiting to go out.
    const id = db.deals.find(
      (d) => d.status === 'funded_held' && d.tenant_id === EQUIPCO,
    )!.id
    confirmDeal(db, id, 'buyer')
    confirmDeal(db, id, 'seller')
    expect(db.payouts.some((p) => p.deal_id === id && p.status === 'scheduled')).toBe(
      true,
    )

    advanceClock(24 * 30)
    runCron(db)

    expect(tenant(EQUIPCO).status).toBe('payouts_frozen')
    expect(
      db.payouts
        .filter((p) => p.tenant_id === EQUIPCO && p.paid_at === null)
        .every((p) => p.status !== 'paid'),
    ).toBe(true)
    expect(
      db.payouts.some((p) => p.tenant_id === EQUIPCO && p.status === 'frozen'),
    ).toBe(true)
  })

  it('reports what it found through the cron result', () => {
    const result = runCron(db)
    expect(result.drift_alerts).toBeGreaterThan(0)
  })

  it('writes an audit row a person can act on', () => {
    runReconciliation(db, EQUIPCO)

    const entry = db.audit.find(
      (a) => a.tenant_id === EQUIPCO && a.action === 'reconciliation.mismatch',
    )
    expect(entry).toBeDefined()
    expect(entry!.details).toMatchObject({
      provider: 'flutterwave',
      currency: 'RWF',
      drift: 25_000,
    })
  })
})
