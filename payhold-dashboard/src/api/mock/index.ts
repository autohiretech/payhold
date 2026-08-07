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

import type {
  AdminApi,
  DealListFilter,
  PayHoldClient,
  SimulationApi,
  WebhookDeliveryFilter,
} from '../client'
import {
  HOLDING_STATUSES,
  PayHoldError,
  type AiChatMessage,
  type AiDecision,
  type AiSuggestion,
  type AiUsage,
  type ApiKey,
  type AuditLogEntry,
  type Balance,
  type ConfirmSide,
  type Country,
  type CreateDealInput,
  type CreateDealResult,
  type CreateSellerInput,
  type Currency,
  type Deal,
  type DealOutcome,
  type Dispute,
  type LedgerEntry,
  type ConnectProviderInput,
  type PaymentMethod,
  type Payout,
  type PayoutProvider,
  type Provider,
  type ProviderAccount,
  type ProviderRequirement,
  type RailStatus,
  type RailBalance,
  type ReconciliationAlert,
  type RequestContext,
  type RiskSignal,
  type Seller,
  type Tenant,
  type TenantSettings,
  type WebhookDelivery,
  type WebhookEndpoint,
} from '../types'
import {
  countryName,
  currenciesFor,
  defaultCurrencyFor,
  defaultProviderFor,
  isMarketSupported,
  payoutRoute,
} from '@/lib/rails'
import { canConvert, convert } from '@/lib/fx'
import {
  aiUsage,
  askAssistant,
  decideSuggestion,
  draftDisputeSuggestion,
  draftRiskSummary,
} from './ai'
import {
  approvePayoutReview,
  holdPayout,
  audit,
  captureDeposit,
  computeBalances,
  computeRailBalances,
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
  runReconciliation,
  settingsFor,
} from './engine'
import { attemptDelivery } from './webhooks'
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

/**
 * What each rail needs before it can be connected.
 *
 * Mirrors `REQUIRED_FIELDS` in the backend's `provider-accounts` function. The
 * field names are the contract — a rename on either side breaks connecting,
 * loudly, at the point of connection rather than at the first charge.
 */
const PROVIDER_REQUIREMENTS: ProviderRequirement[] = [
  {
    provider: 'flutterwave',
    fields: ['secret_key', 'public_key', 'encryption_key', 'webhook_hash'],
    where:
      'Flutterwave dashboard → Settings → API Keys (webhook_hash is the secret hash on Settings → Webhooks)',
  },
  {
    provider: 'stripe',
    fields: ['secret_key', 'webhook_secret'],
    where:
      'Stripe dashboard → Developers → API keys, and Developers → Webhooks for the signing secret',
  },
]

function delay<T>(value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), LATENCY_MS))
}

/**
 * What to charge a buyer in this market, given what the seller is owed.
 *
 * Their own settlement currency if their market can take it, otherwise the
 * best international currency their market can — USD first, since it is the
 * most widely accepted and the one every rate table has.
 */
function presentmentCurrencyFor(
  buyerCountry: Country,
  settlement: Currency,
): Currency | null {
  if (isMarketSupported(buyerCountry, settlement)) return settlement

  const payable = currenciesFor(buyerCountry)
  const preferred: Currency[] = ['USD', 'EUR', 'GBP']

  return (
    preferred.find((c) => payable.includes(c) && canConvert(settlement, c)) ??
    payable.find((c) => canConvert(settlement, c)) ??
    null
  )
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

      // Default the buyer to the seller's market — most deals are local. A
      // foreign-currency deal still defaults there: the buyer picks their own
      // country at checkout, and every country can pay by card.
      const buyerCountry: Country = input.buyer_country ?? seller.country

      // The seller is owed `input.currency`. If the buyer's market cannot be
      // charged in it — an Indian card cannot be charged RWF — find a currency
      // it can, and convert. Refusing the deal would turn away a legitimate
      // customer over a mechanical detail they cannot control.
      const presentmentCurrency = presentmentCurrencyFor(buyerCountry, input.currency)

      if (!presentmentCurrency) {
        throw new PayHoldError(
          'policy_violation',
          `PayHold cannot take a payment from ${countryName(buyerCountry)}.`,
        )
      }

      const converted = convert(input.amount, input.currency, presentmentCurrency)
      if (!converted) {
        throw new PayHoldError(
          'policy_violation',
          `No exchange rate is available between ${input.currency} and ${presentmentCurrency}.`,
        )
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
        presentment_currency: presentmentCurrency,
        presentment_amount: converted.amount,
        // Locked when the buyer pays, not now — the rate here is only for
        // display until then.
        fx_rate: null,
        deposit_amount: input.deposit_amount ?? null,
        buyer_country: buyerCountry,
        provider: defaultProviderFor(buyerCountry, presentmentCurrency),
        payment_method: null,
        payment_network: null,
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
      const DESTINATION_LABEL: Record<PayoutProvider, string> = {
        flutterwave_momo: 'Mobile money',
        flutterwave_bank: 'Bank',
        stripe_connect: 'Stripe',
      }
      const label = DESTINATION_LABEL[input.payout_provider]

      const payoutCurrency = input.payout_currency ?? defaultCurrencyFor(input.country)
      const route = payoutRoute(input.country, payoutCurrency)

      // Refuse a destination we could never send money to, rather than
      // discovering it when the first payout is due.
      if (route.blocked) {
        throw new PayHoldError('policy_violation', route.reason)
      }

      const created: Seller = {
        id: nextId('sel'),
        tenant_id: db.current_tenant_id,
        name: input.name,
        country: input.country,
        payout_currency: payoutCurrency,
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

  async getRailBalances(): Promise<RailBalance[]> {
    const db = getDb()
    return delay(computeRailBalances(db, db.current_tenant_id))
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

  async holdPayout(id: string, heldBy: string, reason: string): Promise<Payout> {
    return delay(clone(mutate((db) => holdPayout(db, id, heldBy, reason))))
  }

  async approvePayoutReview(id: string, approvedBy: string): Promise<Payout> {
    return delay(clone(mutate((db) => approvePayoutReview(db, id, approvedBy))))
  }

  async listRiskSignals(dealId?: string): Promise<RiskSignal[]> {
    const db = getDb()
    const signals = db.risk_signals
      .filter((s) => s.tenant_id === db.current_tenant_id)
      .filter((s) => !dealId || s.deal_id === dealId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
    return delay(clone(signals))
  }

  /**
   * Where payments were made from. Read-only here as it is in the backend —
   * there is no mock method that writes one, because nothing in the engine
   * should be able to.
   */
  async listRequestContext(dealId?: string): Promise<RequestContext[]> {
    const db = getDb()
    const rows = db.request_context
      .filter((c) => c.tenant_id === db.current_tenant_id)
      .filter((c) => !dealId || c.deal_id === dealId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
    return delay(clone(rows))
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
      if (patch.risk_rules_enabled !== undefined) {
        cfg.risk_rules_enabled = patch.risk_rules_enabled
      }
      if (patch.risk_review_threshold_usd !== undefined) {
        if (patch.risk_review_threshold_usd < 0) {
          throw new PayHoldError(
            'policy_violation',
            'The review threshold cannot be negative',
          )
        }
        cfg.risk_review_threshold_usd = patch.risk_review_threshold_usd
      }

      audit(db, cfg.tenant_id, null, 'dashboard', 'settings.updated', { ...patch })
      return clone(cfg)
    })
    return delay(updated)
  }

  // -- Payment provider accounts -------------------------------------------

  async listRailStatus(): Promise<RailStatus[]> {
    const db = getDb()
    const accounts = db.provider_accounts.filter(
      (a) => a.tenant_id === db.current_tenant_id,
    )

    const rails: RailStatus[] = (['flutterwave', 'stripe'] as Provider[]).map((p) => {
      const account = accounts.find((a) => a.provider === p)
      return {
        provider: p,
        connected: Boolean(account),
        mode: account?.mode ?? 'test',
      }
    })

    // Demo mode is "active" precisely when no real rail is connected. It
    // disappears the moment real keys arrive, rather than lingering as a
    // second way money might be moving.
    rails.push({
      provider: 'fake',
      connected: accounts.length === 0,
      mode: 'test',
    })

    return delay(rails.sort((a, b) => a.provider.localeCompare(b.provider)))
  }

  async listProviderAccounts(): Promise<ProviderAccount[]> {
    const db = getDb()
    // `credentials` is not stored on the mock either. Keeping the mock honest
    // about that means no screen can accidentally come to depend on reading
    // them back, which the real backend will never allow.
    const accounts = db.provider_accounts
      .filter((a) => a.tenant_id === db.current_tenant_id)
      .map(({ provider, mode, connected_at }) => ({ provider, mode, connected_at }))
    return delay(clone(accounts))
  }

  async listProviderRequirements(): Promise<ProviderRequirement[]> {
    return delay(clone(PROVIDER_REQUIREMENTS))
  }

  async connectProvider(input: ConnectProviderInput): Promise<ProviderAccount> {
    const spec = PROVIDER_REQUIREMENTS.find((r) => r.provider === input.provider)
    if (!spec) {
      throw new PayHoldError(
        'policy_violation',
        `${input.provider} cannot be connected`,
      )
    }

    const missing = spec.fields.filter((f) => !input.credentials[f]?.trim())
    if (missing.length > 0) {
      throw new PayHoldError(
        'policy_violation',
        `Missing ${missing.join(', ')}. Find them at ${spec.where}.`,
      )
    }

    // The same test/live guard the backend applies. A live secret key
    // connected as "test" would move real money during a sandbox walkthrough,
    // so the mock refuses it too — otherwise the dashboard would look like it
    // accepted something the real API rejects.
    if (input.provider === 'flutterwave') {
      const isTestKey = (input.credentials.secret_key ?? '').includes('_TEST-')
      if (isTestKey !== (input.mode === 'test')) {
        throw new PayHoldError(
          'policy_violation',
          isTestKey
            ? 'That is a test secret key, but you selected live mode.'
            : 'That is a live secret key, but you selected test mode. Live keys move real money.',
        )
      }
    }

    const account = mutate((db) => {
      const existing = db.provider_accounts.find(
        (a) => a.tenant_id === db.current_tenant_id && a.provider === input.provider,
      )
      const connected_at = nowIso()

      if (existing) {
        existing.mode = input.mode
        existing.connected_at = connected_at
      } else {
        db.provider_accounts.push({
          tenant_id: db.current_tenant_id,
          provider: input.provider,
          mode: input.mode,
          connected_at,
        })
      }

      // Audited without the credentials — only that a connection happened.
      audit(db, db.current_tenant_id, null, 'dashboard', 'provider.connected', {
        provider: input.provider,
        mode: input.mode,
      })

      return { provider: input.provider, mode: input.mode, connected_at }
    })

    return delay(account)
  }

  async disconnectProvider(provider: Provider): Promise<void> {
    mutate((db) => {
      // Money in flight on this rail would be unreachable without its
      // credentials: no payout could be sent, no refund issued.
      const holding = db.deals.filter(
        (d) =>
          d.tenant_id === db.current_tenant_id &&
          d.provider === provider &&
          (HOLDING_STATUSES.includes(d.status) || d.status === 'released'),
      ).length

      if (holding > 0) {
        throw new PayHoldError(
          'policy_violation',
          `${holding} deal${holding === 1 ? ' still holds' : 's still hold'} money on ` +
            `${provider}. Settle or refund ${holding === 1 ? 'it' : 'them'} before disconnecting.`,
        )
      }

      db.provider_accounts = db.provider_accounts.filter(
        (a) => !(a.tenant_id === db.current_tenant_id && a.provider === provider),
      )

      audit(db, db.current_tenant_id, null, 'dashboard', 'provider.disconnected', {
        provider,
      })
    })

    return delay(undefined)
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
    // The signing secret is stripped on the way out, the way the real API
    // strips it — a screen that could read it would be a screen that leaks it.
    const endpoints = db.webhook_endpoints
      .filter((w) => w.tenant_id === db.current_tenant_id)
      .map(({ secret: _secret, ...endpoint }) => endpoint)
    return delay(clone(endpoints))
  }

  async createWebhookEndpoint(
    url: string,
  ): Promise<{ endpoint: WebhookEndpoint; secret: string }> {
    const result = mutate((db) => {
      const secret = `whsec_${Array.from({ length: 24 }, () =>
        Math.floor(Math.random() * 36).toString(36),
      ).join('')}`

      const endpoint: WebhookEndpoint & { secret: string } = {
        id: nextId('whe'),
        tenant_id: db.current_tenant_id,
        url,
        secret,
        masked_secret: `whsec_••••••••••••${secret.slice(-4)}`,
        created_at: nowIso(),
        disabled_at: null,
      }
      db.webhook_endpoints.push(endpoint)
      audit(db, endpoint.tenant_id, null, 'dashboard', 'webhook_endpoint.created', {
        url,
      })

      // Returned once, here, and never again — the caller has exactly one
      // chance to store it, which is the same deal API keys get.
      const { secret: _secret, ...visible } = endpoint
      return { endpoint: clone(visible), secret }
    })
    return delay(result)
  }

  async disableWebhookEndpoint(id: string): Promise<WebhookEndpoint> {
    const updated = mutate((db) => {
      const found = db.webhook_endpoints.find(
        (w) => w.id === id && w.tenant_id === db.current_tenant_id,
      )
      if (!found) throw new PayHoldError('not_found', `Endpoint ${id} not found`)

      found.disabled_at = nowIso()
      audit(db, found.tenant_id, null, 'dashboard', 'webhook_endpoint.disabled', {
        url: found.url,
      })

      const { secret: _secret, ...visible } = found
      return clone(visible)
    })
    return delay(updated)
  }

  async listWebhookDeliveries(
    filter: WebhookDeliveryFilter = {},
  ): Promise<WebhookDelivery[]> {
    const db = getDb()
    const deliveries = db.webhook_deliveries
      .filter((d) => d.tenant_id === db.current_tenant_id)
      .filter((d) => !filter.endpoint_id || d.endpoint_id === filter.endpoint_id)
      .filter((d) => !filter.deal_id || d.deal_id === filter.deal_id)
      .filter((d) => !filter.status?.length || filter.status.includes(d.status))
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, filter.limit ?? 100)
    return delay(clone(deliveries))
  }

  async retryWebhookDelivery(id: string): Promise<WebhookDelivery> {
    const delivery = mutate((db) => {
      const found = db.webhook_deliveries.find(
        (d) => d.id === id && d.tenant_id === db.current_tenant_id,
      )
      if (!found) throw new PayHoldError('not_found', `Delivery ${id} not found`)
      if (found.status === 'delivered') {
        throw new PayHoldError('invalid_state', 'This one already went through')
      }
      return clone(attemptDelivery(db, found))
    })
    return delay(delivery)
  }

  // -- Intelligence ---------------------------------------------------------
  //
  // Reads are tenant-scoped like everything else. The writes here touch three
  // tables — ai_suggestions, ai_chat, audit — and no others.

  async listAiSuggestions(dealId?: string): Promise<AiSuggestion[]> {
    const db = getDb()
    const rows = db.ai_suggestions
      .filter(
        (s) => s.tenant_id === db.current_tenant_id && (!dealId || s.deal_id === dealId),
      )
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
    return delay(clone(rows))
  }

  async draftDisputeSuggestion(disputeId: string): Promise<AiSuggestion> {
    return delay(clone(mutate((db) => draftDisputeSuggestion(db, disputeId))))
  }

  async draftRiskSummary(dealId: string): Promise<AiSuggestion> {
    await this.getDeal(dealId)
    return delay(clone(mutate((db) => draftRiskSummary(db, dealId))))
  }

  async decideAiSuggestion(
    id: string,
    decision: AiDecision,
    decidedBy: string,
  ): Promise<AiSuggestion> {
    return delay(clone(mutate((db) => decideSuggestion(db, id, decision, decidedBy))))
  }

  async askAssistant(question: string): Promise<AiChatMessage> {
    return delay(clone(mutate((db) => askAssistant(db, question))))
  }

  async listAiChat(): Promise<AiChatMessage[]> {
    const db = getDb()
    return delay(
      clone(db.ai_chat.filter((m) => m.tenant_id === db.current_tenant_id)),
    )
  }

  async listDealOutcomes(): Promise<DealOutcome[]> {
    const db = getDb()
    const rows = db.deal_outcomes
      .filter((o) => o.tenant_id === db.current_tenant_id)
      .sort((a, b) => b.resolved_at.localeCompare(a.resolved_at))
    return delay(clone(rows))
  }

  async getAiUsage(): Promise<AiUsage> {
    const db = getDb()
    return delay(clone(aiUsage(db, db.current_tenant_id)))
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

    async runReconciliation(): Promise<ReconciliationAlert[]> {
      return delay(clone(mutate((db) => runReconciliation(db))))
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
    async simulateFunding(
      dealId: string,
      method?: PaymentMethod,
      network?: string,
    ): Promise<Deal> {
      return delay(clone(mutate((db) => fundDeal(db, dealId, method, network))))
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

    failNextWebhook(): void {
      mutate((db) => {
        db.fail_next_webhook = true
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
