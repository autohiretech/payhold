/**
 * MockClient — implements the full PayHoldClient contract against the local
 * engine, plus the `sim` hooks the dev panel uses.
 *
 * Two behaviours here exist to keep us honest rather than to look good:
 *
 *   1. Every read is scoped to the current tenant, the same way the real API
 *      scopes by API key. Cross-tenant data is unreachable, not just hidden.
 *   2. Calls are artificially latent, so the UI has to handle loading states
 *      properly instead of assuming instant data.
 */

import type { AdminApi, DealListFilter, PayHoldClient, SimulationApi } from '../client'
import {
  PayHoldError,
  type ApiKey,
  type AuditLogEntry,
  type Balance,
  type ConfirmSide,
  type CreateDealInput,
  type CreateDealResult,
  type CreateSellerInput,
  type Deal,
  type Dispute,
  type LedgerEntry,
  type Payout,
  type ReconciliationAlert,
  type Seller,
  type Tenant,
  type TenantSettings,
  type WebhookEndpoint,
} from '../types'
import {
  audit,
  captureDeposit,
  computeBalances,
  confirmDeal,
  fundDeal,
  injectDrift,
  openDispute,
  refundDeal,
  releaseDeposit,
  requireDeal,
  resolveDispute,
  retryPayout,
  runCron,
  settingsFor,
} from './engine'
import { seedDb } from './seed'
import {
  addDays,
  advanceClock,
  getDb,
  loadDb,
  mutate,
  nextId,
  now,
  nowIso,
  resetDb,
} from './store'

/** Network feel, so loading and error states get exercised in development. */
const LATENCY_MS = 180

function delay<T>(value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), LATENCY_MS))
}

/** Deep copy on the way out — screens must never mutate the store by accident. */
function clone<T>(value: T): T {
  return structuredClone(value)
}

export class MockClient implements PayHoldClient {
  constructor() {
    loadDb(seedDb)
  }

  // -- Deals ---------------------------------------------------------------

  async createDeal(input: CreateDealInput): Promise<CreateDealResult> {
    const result = mutate((db) => {
      const tenantId = db.current_tenant_id
      const cfg = settingsFor(db, tenantId)

      if (!cfg.currencies.includes(input.currency)) {
        throw new PayHoldError(
          'policy_violation',
          `${input.currency} is not enabled for this account`,
        )
      }
      if (input.amount <= 0) {
        throw new PayHoldError('policy_violation', 'Amount must be greater than zero')
      }
      const seller = db.sellers.find(
        (s) => s.id === input.seller_id && s.tenant_id === tenantId,
      )
      if (!seller) {
        throw new PayHoldError('not_found', `Seller ${input.seller_id} not found`)
      }

      const createdAt = nowIso()
      const deal: Deal = {
        id: nextId('deal'),
        tenant_id: tenantId,
        buyer_ref: input.buyer_ref,
        seller_id: input.seller_id,
        description: input.description,
        amount: input.amount,
        currency: input.currency,
        deposit_amount: input.deposit_amount ?? null,
        provider: 'flutterwave',
        provider_ref: null,
        status: 'created',
        expected_complete_at: input.expected_complete_at ?? addDays(createdAt, 3),
        auto_release_at: null,
        released_at: null,
        payout_due_at: null,
        fee_amount: Math.round(input.amount * cfg.service_fee_rate),
        confirmations: [],
        metadata: input.metadata ?? {},
        created_at: createdAt,
        updated_at: createdAt,
      }
      db.deals.push(deal)

      audit(db, tenantId, deal.id, 'dashboard', 'deal.created', {
        amount: deal.amount,
        currency: deal.currency,
      })

      return {
        deal: clone(deal),
        payment_link: `https://pay.payhold.dev/d/${deal.id}`,
      }
    })
    return delay(result)
  }

  async getDeal(id: string): Promise<Deal> {
    const db = getDb()
    const deal = requireDeal(db, id)
    if (deal.tenant_id !== db.current_tenant_id) {
      // Same response as a genuinely missing deal — other tenants' records
      // must not be distinguishable from records that do not exist.
      throw new PayHoldError('not_found', `Deal ${id} not found`)
    }
    return delay(clone(deal))
  }

  async listDeals(filter: DealListFilter = {}): Promise<Deal[]> {
    const db = getDb()
    const term = filter.search?.trim().toLowerCase()

    const deals = db.deals
      .filter((d) => d.tenant_id === db.current_tenant_id)
      .filter((d) => !filter.status?.length || filter.status.includes(d.status))
      .filter((d) => !filter.seller_id || d.seller_id === filter.seller_id)
      .filter(
        (d) =>
          !term ||
          d.id.toLowerCase().includes(term) ||
          d.buyer_ref.toLowerCase().includes(term) ||
          d.description.toLowerCase().includes(term),
      )
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, filter.limit ?? 500)

    return delay(clone(deals))
  }

  async confirmDeal(id: string, side: ConfirmSide): Promise<Deal> {
    await this.getDeal(id) // tenant scoping
    return delay(clone(mutate((db) => confirmDeal(db, id, side))))
  }

  async refundDeal(id: string, reason: string): Promise<Deal> {
    await this.getDeal(id)
    return delay(clone(mutate((db) => refundDeal(db, id, reason))))
  }

  // -- Deposits ------------------------------------------------------------

  async captureDeposit(dealId: string, amount: number): Promise<Deal> {
    await this.getDeal(dealId)
    return delay(clone(mutate((db) => captureDeposit(db, dealId, amount))))
  }

  async releaseDeposit(dealId: string): Promise<Deal> {
    await this.getDeal(dealId)
    return delay(clone(mutate((db) => releaseDeposit(db, dealId))))
  }

  // -- Sellers -------------------------------------------------------------

  async listSellers(): Promise<Seller[]> {
    const db = getDb()
    const sellers = db.sellers.filter((s) => s.tenant_id === db.current_tenant_id)
    return delay(clone(sellers))
  }

  async createSeller(input: CreateSellerInput): Promise<Seller> {
    const seller = mutate((db) => {
      // The raw destination is tokenized here and immediately discarded — the
      // real system never stores it, and neither does the mock.
      const tail = input.destination.replace(/\D/g, '').slice(-4) || '0000'
      const label =
        input.payout_provider === 'flutterwave_momo'
          ? 'MoMo'
          : input.payout_provider === 'flutterwave_bank'
            ? 'Bank'
            : 'Stripe'

      const created: Seller = {
        id: nextId('sel'),
        tenant_id: db.current_tenant_id,
        name: input.name,
        payout_provider: input.payout_provider,
        beneficiary_token: `ben_fw_${nextId('tok')}`,
        masked_destination: `${label} •••• ${tail}`,
        created_at: nowIso(),
      }
      db.sellers.push(created)
      audit(db, created.tenant_id, null, 'dashboard', 'seller.created', {
        seller_id: created.id,
        name: created.name,
      })
      return clone(created)
    })
    return delay(seller)
  }

  // -- Money ---------------------------------------------------------------

  async getBalance(): Promise<Balance[]> {
    const db = getDb()
    return delay(computeBalances(db, db.current_tenant_id))
  }

  async listLedger(dealId?: string): Promise<LedgerEntry[]> {
    const db = getDb()
    const entries = db.ledger
      .filter((e) => e.tenant_id === db.current_tenant_id)
      .filter((e) => !dealId || e.deal_id === dealId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
    return delay(clone(entries))
  }

  async listPayouts(): Promise<Payout[]> {
    const db = getDb()
    const payouts = db.payouts
      .filter((p) => p.tenant_id === db.current_tenant_id)
      .sort((a, b) => b.scheduled_for.localeCompare(a.scheduled_for))
    return delay(clone(payouts))
  }

  async retryPayout(id: string): Promise<Payout> {
    return delay(clone(mutate((db) => retryPayout(db, id))))
  }

  // -- Disputes ------------------------------------------------------------

  async listDisputes(): Promise<Dispute[]> {
    const db = getDb()
    const disputes = db.disputes
      .filter((d) => d.tenant_id === db.current_tenant_id)
      .sort((a, b) => b.opened_at.localeCompare(a.opened_at))
    return delay(clone(disputes))
  }

  async openDispute(
    dealId: string,
    raisedBy: ConfirmSide,
    reason: string,
  ): Promise<Dispute> {
    await this.getDeal(dealId)
    return delay(clone(mutate((db) => openDispute(db, dealId, raisedBy, reason))))
  }

  async resolveDispute(
    id: string,
    resolution: 'release' | 'refund',
    note: string,
  ): Promise<Dispute> {
    return delay(clone(mutate((db) => resolveDispute(db, id, resolution, note))))
  }

  // -- Settings and access -------------------------------------------------

  async getSettings(): Promise<TenantSettings> {
    const db = getDb()
    return delay(clone(settingsFor(db, db.current_tenant_id)))
  }

  async updateSettings(patch: Partial<TenantSettings>): Promise<TenantSettings> {
    const updated = mutate((db) => {
      const cfg = settingsFor(db, db.current_tenant_id)

      if (patch.service_fee_rate !== undefined) {
        if (patch.service_fee_rate < 0 || patch.service_fee_rate > 0.5) {
          throw new PayHoldError(
            'policy_violation',
            'Service fee must be between 0% and 50%',
          )
        }
        cfg.service_fee_rate = patch.service_fee_rate
      }
      if (patch.buyer_fee !== undefined) cfg.buyer_fee = patch.buyer_fee
      if (patch.clearance_days !== undefined) cfg.clearance_days = patch.clearance_days
      if (patch.auto_release_days !== undefined) {
        cfg.auto_release_days = patch.auto_release_days
      }
      if (patch.currencies) cfg.currencies = patch.currencies

      audit(db, cfg.tenant_id, null, 'dashboard', 'settings.updated', { ...patch })
      return clone(cfg)
    })
    return delay(updated)
  }

  async listApiKeys(): Promise<ApiKey[]> {
    const db = getDb()
    const keys = db.api_keys
      .filter((k) => k.tenant_id === db.current_tenant_id)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
    return delay(clone(keys))
  }

  async createApiKey(label: string): Promise<{ key: ApiKey; plaintext: string }> {
    const result = mutate((db) => {
      const secret = Array.from({ length: 32 }, () =>
        Math.floor(Math.random() * 36).toString(36),
      ).join('')
      const plaintext = `ph_live_${secret}`

      const key: ApiKey = {
        id: nextId('key'),
        tenant_id: db.current_tenant_id,
        label,
        masked_key: `${plaintext.slice(0, 11)}•••••••••••••••${plaintext.slice(-4)}`,
        created_at: nowIso(),
        revoked_at: null,
        last_used_at: null,
      }
      db.api_keys.push(key)
      audit(db, key.tenant_id, null, 'dashboard', 'api_key.created', { label })
      return { key: clone(key), plaintext }
    })
    return delay(result)
  }

  async revokeApiKey(id: string): Promise<ApiKey> {
    const key = mutate((db) => {
      const found = db.api_keys.find(
        (k) => k.id === id && k.tenant_id === db.current_tenant_id,
      )
      if (!found) throw new PayHoldError('not_found', `Key ${id} not found`)
      found.revoked_at = nowIso()
      audit(db, found.tenant_id, null, 'dashboard', 'api_key.revoked', {
        label: found.label,
      })
      return clone(found)
    })
    return delay(key)
  }

  async listWebhookEndpoints(): Promise<WebhookEndpoint[]> {
    const db = getDb()
    const endpoints = db.webhook_endpoints.filter(
      (w) => w.tenant_id === db.current_tenant_id,
    )
    return delay(clone(endpoints))
  }

  async createWebhookEndpoint(
    url: string,
  ): Promise<{ endpoint: WebhookEndpoint; secret: string }> {
    const result = mutate((db) => {
      const secret = `whsec_${Array.from({ length: 24 }, () =>
        Math.floor(Math.random() * 36).toString(36),
      ).join('')}`

      const endpoint: WebhookEndpoint = {
        id: nextId('whe'),
        tenant_id: db.current_tenant_id,
        url,
        masked_secret: `whsec_••••••••••••${secret.slice(-4)}`,
        created_at: nowIso(),
        disabled_at: null,
      }
      db.webhook_endpoints.push(endpoint)
      audit(db, endpoint.tenant_id, null, 'dashboard', 'webhook_endpoint.created', {
        url,
      })
      return { endpoint: clone(endpoint), secret }
    })
    return delay(result)
  }

  // -- Audit ---------------------------------------------------------------

  async listAuditLog(dealId?: string): Promise<AuditLogEntry[]> {
    const db = getDb()
    const entries = db.audit
      .filter((a) => a.tenant_id === db.current_tenant_id)
      .filter((a) => !dealId || a.deal_id === dealId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
    return delay(clone(entries))
  }

  // -- Tenant --------------------------------------------------------------

  async getTenant(): Promise<Tenant> {
    const db = getDb()
    const tenant = db.tenants.find((t) => t.id === db.current_tenant_id)
    if (!tenant) throw new PayHoldError('not_found', 'Tenant not found')
    return delay(clone(tenant))
  }

  // -- Master-admin --------------------------------------------------------

  admin: AdminApi = {
    async listTenants(): Promise<Tenant[]> {
      return delay(clone(getDb().tenants))
    },

    async listReconciliationAlerts(): Promise<ReconciliationAlert[]> {
      const alerts = getDb()
        .alerts.slice()
        .sort((a, b) => b.detected_at.localeCompare(a.detected_at))
      return delay(clone(alerts))
    },

    async freezePayouts(tenantId: string): Promise<Tenant> {
      return delay(
        clone(
          mutate((db) => {
            const tenant = db.tenants.find((t) => t.id === tenantId)
            if (!tenant) throw new PayHoldError('not_found', 'Tenant not found')
            tenant.status = 'payouts_frozen'
            audit(db, tenantId, null, 'payhold-staff', 'tenant.payouts_frozen', {})
            return tenant
          }),
        ),
      )
    },

    async unfreezePayouts(tenantId: string): Promise<Tenant> {
      return delay(
        clone(
          mutate((db) => {
            const tenant = db.tenants.find((t) => t.id === tenantId)
            if (!tenant) throw new PayHoldError('not_found', 'Tenant not found')
            tenant.status = 'active'
            for (const alert of db.alerts) {
              if (alert.tenant_id === tenantId && !alert.resolved_at) {
                alert.resolved_at = nowIso()
              }
            }
            audit(db, tenantId, null, 'payhold-staff', 'tenant.payouts_unfrozen', {})
            return tenant
          }),
        ),
      )
    },
  }

  // -- Simulation ----------------------------------------------------------

  sim: SimulationApi = {
    async simulateFunding(dealId: string): Promise<Deal> {
      return delay(clone(mutate((db) => fundDeal(db, dealId))))
    },

    async advanceTime(hours: number): Promise<void> {
      advanceClock(hours)
      mutate((db) => runCron(db))
    },

    async runCron(): Promise<void> {
      mutate((db) => runCron(db))
    },

    failNextPayout(): void {
      mutate((db) => {
        db.fail_next_payout = true
      })
    },

    async injectDrift(tenantId: string, amount: number): Promise<void> {
      mutate((db) => injectDrift(db, tenantId, amount))
    },

    async reset(): Promise<void> {
      resetDb(seedDb)
    },

    now(): Date {
      return now()
    },
  }

  /** Dev-only: act as a different tenant, to prove isolation holds. */
  switchTenant(tenantId: string): void {
    mutate((db) => {
      db.current_tenant_id = tenantId
    })
  }
}
