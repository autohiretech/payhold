/**
 * Fixture data for the mock.
 *
 * Goal: every screen has something real to render and every state in the deal
 * machine is represented, including the unhappy ones (failed payout, open
 * dispute, ledger drift). These fixtures double as the acceptance cases the
 * backend will have to reproduce.
 *
 * AutoHire is tenant #1 — a car and equipment hire marketplace. A second
 * tenant exists purely so the master-admin view and tenant isolation have
 * something to be true about.
 */

import type {
  ApiKey,
  AuditLogEntry,
  ConfirmSide,
  Country,
  Currency,
  Deal,
  DealStatus,
  Dispute,
  LedgerEntry,
  PaymentMethod,
  Payout,
  Provider,
  ReconciliationAlert,
  Seller,
  Tenant,
  TenantSettings,
  WebhookEndpoint,
} from '../types'
import { collectionRails, defaultProviderFor, providerFor } from '@/lib/rails'
import { SCHEMA_VERSION, addDays, type MockDb } from './store'

const AUTOHIRE = 'ten_0001'
const EQUIPCO = 'ten_0002'

export function seedDb(): MockDb {
  let counter = 0
  const id = (prefix: string) => {
    counter += 1
    return `${prefix}_${counter.toString(36).padStart(4, '0')}`
  }

  const t0 = new Date()
  /** Days ago, as an ISO string. */
  const ago = (days: number) => addDays(t0, -days)

  const tenants: Tenant[] = [
    {
      id: AUTOHIRE,
      name: 'AutoHire',
      slug: 'autohire',
      status: 'active',
      created_at: ago(210),
    },
    {
      id: EQUIPCO,
      name: 'Rwanda Equipment Co',
      slug: 'rwanda-equipment',
      status: 'active',
      created_at: ago(46),
    },
  ]

  const settings: TenantSettings[] = [
    {
      tenant_id: AUTOHIRE,
      service_fee_rate: 0.1,
      buyer_fee: 0,
      clearance_days: 7,
      auto_release_days: 3,
      // Rwanda is home; KES covers the Kenya expansion, USD the tourist trade.
      currencies: ['RWF', 'USD', 'KES'],
    },
    {
      tenant_id: EQUIPCO,
      service_fee_rate: 0.08,
      buyer_fee: 50000,
      clearance_days: 5,
      auto_release_days: 4,
      currencies: ['RWF'],
    },
  ]

  const sellers: Seller[] = [
    {
      id: 'sel_0001',
      tenant_id: AUTOHIRE,
      name: 'Jean-Paul Habimana',
      country: 'RW',
      payout_provider: 'flutterwave_momo',
      beneficiary_token: 'ben_fw_8sk21',
      masked_destination: 'MTN •••• 4821',
      created_at: ago(198),
    },
    {
      id: 'sel_0002',
      tenant_id: AUTOHIRE,
      name: 'Kigali City Rentals',
      country: 'RW',
      payout_provider: 'flutterwave_bank',
      beneficiary_token: 'ben_fw_2ma94',
      masked_destination: 'BK •••• 0073',
      created_at: ago(176),
    },
    {
      id: 'sel_0003',
      tenant_id: AUTOHIRE,
      name: 'Aline Uwase',
      country: 'RW',
      payout_provider: 'flutterwave_momo',
      beneficiary_token: 'ben_fw_5df10',
      masked_destination: 'Airtel •••• 9302',
      created_at: ago(120),
    },
    {
      id: 'sel_0004',
      tenant_id: AUTOHIRE,
      name: 'Musanze Fleet Services',
      country: 'RW',
      payout_provider: 'flutterwave_bank',
      beneficiary_token: 'ben_fw_7qz45',
      masked_destination: 'Equity •••• 6611',
      created_at: ago(88),
    },
    {
      id: 'sel_0006',
      tenant_id: AUTOHIRE,
      name: 'Nairobi Car Hire Ltd',
      country: 'KE',
      payout_provider: 'flutterwave_mpesa',
      beneficiary_token: 'ben_fw_4ke82',
      masked_destination: 'M-Pesa •••• 5540',
      created_at: ago(52),
    },
    {
      id: 'sel_0005',
      tenant_id: EQUIPCO,
      name: 'Nyabugogo Plant Hire',
      country: 'RW',
      payout_provider: 'flutterwave_momo',
      beneficiary_token: 'ben_fw_1cc38',
      masked_destination: 'MTN •••• 7714',
      created_at: ago(40),
    },
  ]

  const deals: Deal[] = []
  const ledger: LedgerEntry[] = []
  const payouts: Payout[] = []
  const audit: AuditLogEntry[] = []
  const disputes: Dispute[] = []

  interface DealSpec {
    tenant_id: string
    seller_id: string
    buyer_ref: string
    description: string
    amount: number
    currency?: Currency
    /** Defaults from the currency: KES→Kenya, USD→international, else Rwanda. */
    country?: Country
    /** Defaults to the first rail available in that market. */
    method?: PaymentMethod
    deposit_amount?: number
    status: DealStatus
    /** Days ago the deal was created. */
    created: number
    confirmed?: ConfirmSide[]
    /** Days ago the payout was actually sent, for paid_out deals. */
    paid?: number
    payout_failed?: boolean
    dispute_reason?: string
  }

  const specs: DealSpec[] = [
    // --- Awaiting payment ---------------------------------------------------
    {
      tenant_id: AUTOHIRE,
      seller_id: 'sel_0002',
      buyer_ref: 'bk_9d41',
      description: 'Toyota RAV4 — 3 days, Kigali',
      amount: 13_500_00,
      status: 'created',
      created: 0,
    },
    {
      tenant_id: AUTOHIRE,
      seller_id: 'sel_0001',
      buyer_ref: 'bk_9d38',
      description: 'Land Cruiser Prado — 5 days, Musanze trip',
      amount: 42_000_00,
      deposit_amount: 10_000_00,
      status: 'created',
      created: 1,
    },

    // --- Money held ---------------------------------------------------------
    {
      tenant_id: AUTOHIRE,
      seller_id: 'sel_0003',
      buyer_ref: 'bk_9c07',
      description: 'Hyundai Tucson — 2 days, airport pickup',
      amount: 9_800_00,
      status: 'funded_held',
      created: 2,
    },
    {
      tenant_id: AUTOHIRE,
      seller_id: 'sel_0004',
      buyer_ref: 'bk_9b92',
      description: 'Coaster minibus — 1 day, conference shuttle',
      amount: 28_000_00,
      deposit_amount: 5_000_00,
      status: 'funded_held',
      created: 3,
    },
    {
      // A tourist paying by international card — this one rides Stripe.
      tenant_id: AUTOHIRE,
      seller_id: 'sel_0002',
      buyer_ref: 'bk_9b41',
      description: 'Nissan X-Trail — 7 days, Akagera self-drive',
      amount: 315_00,
      currency: 'USD',
      country: 'INTL',
      method: 'card',
      status: 'funded_held',
      created: 4,
    },
    {
      // Kenya expansion — M-Pesa, collected and paid out on Flutterwave.
      tenant_id: AUTOHIRE,
      seller_id: 'sel_0006',
      buyer_ref: 'bk_9b12',
      description: 'Toyota Axio — 4 days, Nairobi',
      amount: 24_000_00,
      currency: 'KES',
      method: 'mpesa',
      status: 'funded_held',
      created: 2,
    },
    {
      tenant_id: AUTOHIRE,
      seller_id: 'sel_0006',
      buyer_ref: 'bk_9a44',
      description: 'Nissan Note — 3 days, Mombasa road trip',
      amount: 15_500_00,
      currency: 'KES',
      method: 'mpesa',
      status: 'paid_out',
      created: 38,
      confirmed: ['buyer', 'seller'],
      paid: 26,
    },
    {
      // Airtel Money, so both Rwandan wallets appear in the fixtures.
      tenant_id: AUTOHIRE,
      seller_id: 'sel_0003',
      buyer_ref: 'bk_9c55',
      description: 'Toyota Sienta — 2 days, Kigali',
      amount: 8_600_00,
      method: 'airtel_money',
      status: 'funded_held',
      created: 1,
    },

    // --- Partially confirmed ------------------------------------------------
    {
      tenant_id: AUTOHIRE,
      seller_id: 'sel_0001',
      buyer_ref: 'bk_9a76',
      description: 'Toyota Hiace — 4 days, Huye',
      amount: 22_400_00,
      status: 'confirmed_buyer',
      created: 6,
      confirmed: ['buyer'],
    },
    {
      tenant_id: AUTOHIRE,
      seller_id: 'sel_0003',
      buyer_ref: 'bk_9a12',
      description: 'Suzuki Swift — 2 days, city',
      amount: 7_200_00,
      status: 'confirmed_seller',
      created: 5,
      confirmed: ['seller'],
    },

    // --- Released, inside clearance ----------------------------------------
    {
      tenant_id: AUTOHIRE,
      seller_id: 'sel_0004',
      buyer_ref: 'bk_98f3',
      description: 'Land Cruiser 79 — 6 days, field survey',
      amount: 54_000_00,
      status: 'released',
      created: 9,
      confirmed: ['buyer', 'seller'],
    },
    {
      tenant_id: AUTOHIRE,
      seller_id: 'sel_0002',
      buyer_ref: 'bk_9877',
      description: 'Mazda CX-5 — 3 days, Rubavu',
      amount: 16_800_00,
      status: 'released',
      created: 11,
      confirmed: ['buyer', 'seller'],
    },

    // --- Cleared, payout scheduled or failed -------------------------------
    {
      tenant_id: AUTOHIRE,
      seller_id: 'sel_0003',
      buyer_ref: 'bk_9701',
      description: 'Toyota Vitz — 5 days, city',
      amount: 11_000_00,
      status: 'released',
      created: 19,
      confirmed: ['buyer', 'seller'],
      payout_failed: true,
    },

    // --- Paid out -----------------------------------------------------------
    {
      tenant_id: AUTOHIRE,
      seller_id: 'sel_0001',
      buyer_ref: 'bk_95c2',
      description: 'Toyota RAV4 — 4 days, Kigali',
      amount: 18_000_00,
      status: 'paid_out',
      created: 34,
      confirmed: ['buyer', 'seller'],
      paid: 22,
    },
    {
      tenant_id: AUTOHIRE,
      seller_id: 'sel_0004',
      buyer_ref: 'bk_9488',
      description: 'Coaster minibus — 2 days, wedding',
      amount: 46_000_00,
      status: 'paid_out',
      created: 41,
      confirmed: ['buyer', 'seller'],
      paid: 29,
    },
    {
      tenant_id: AUTOHIRE,
      seller_id: 'sel_0002',
      buyer_ref: 'bk_9331',
      description: 'Nissan Patrol — 8 days, Nyungwe',
      amount: 72_000_00,
      deposit_amount: 15_000_00,
      status: 'paid_out',
      created: 58,
      confirmed: ['buyer', 'seller'],
      paid: 46,
    },

    // --- Refunded -----------------------------------------------------------
    {
      tenant_id: AUTOHIRE,
      seller_id: 'sel_0003',
      buyer_ref: 'bk_96a5',
      description: 'Honda Fit — 1 day, cancelled by host',
      amount: 5_400_00,
      status: 'refunded',
      created: 26,
    },

    // --- Disputed -----------------------------------------------------------
    {
      tenant_id: AUTOHIRE,
      seller_id: 'sel_0001',
      buyer_ref: 'bk_9912',
      description: 'Toyota Fortuner — 3 days, Bugesera',
      amount: 24_000_00,
      status: 'disputed',
      created: 8,
      dispute_reason: 'Vehicle returned with damage to the rear bumper.',
    },
    {
      tenant_id: AUTOHIRE,
      seller_id: 'sel_0004',
      buyer_ref: 'bk_9885',
      description: 'Isuzu pickup — 2 days, delivery run',
      amount: 13_000_00,
      status: 'disputed',
      created: 12,
      dispute_reason: 'Buyer says the vehicle was never delivered.',
    },

    // --- Second tenant ------------------------------------------------------
    {
      tenant_id: EQUIPCO,
      seller_id: 'sel_0005',
      buyer_ref: 'ord_4410',
      description: 'Concrete mixer — 5 days',
      amount: 38_000_00,
      status: 'funded_held',
      created: 3,
    },
    {
      tenant_id: EQUIPCO,
      seller_id: 'sel_0005',
      buyer_ref: 'ord_4388',
      description: 'Scaffolding set — 14 days',
      amount: 61_000_00,
      status: 'paid_out',
      created: 30,
      confirmed: ['buyer', 'seller'],
      paid: 18,
    },
  ]

  for (const spec of specs) {
    const cfg = settings.find((s) => s.tenant_id === spec.tenant_id)!
    const currency: Currency = spec.currency ?? 'RWF'
    const country: Country =
      spec.country ?? (currency === 'KES' ? 'KE' : currency === 'USD' ? 'INTL' : 'RW')
    const method: PaymentMethod =
      spec.method ?? collectionRails(country, currency)[0]?.method ?? 'card'
    // Unpaid deals only have a provisional rail — the buyer has not chosen yet.
    const provider: Provider =
      spec.status === 'created'
        ? defaultProviderFor(country, currency)
        : (providerFor(country, currency, method) ?? 'flutterwave')
    const createdAt = ago(spec.created)
    const fee = Math.round(spec.amount * cfg.service_fee_rate)
    const dealId = id('deal')

    const expectedComplete = addDays(createdAt, 3)
    const confirmed = spec.confirmed ?? []
    const bothConfirmed = confirmed.length === 2
    // Release lands one day after the second confirmation, in fixture terms.
    const releasedAt = bothConfirmed ? addDays(createdAt, 4) : null
    const payoutDue = releasedAt ? addDays(releasedAt, cfg.clearance_days) : null

    const deal: Deal = {
      id: dealId,
      tenant_id: spec.tenant_id,
      buyer_ref: spec.buyer_ref,
      seller_id: spec.seller_id,
      description: spec.description,
      amount: spec.amount,
      currency,
      deposit_amount: spec.deposit_amount ?? null,
      buyer_country: country,
      provider,
      payment_method: spec.status === 'created' ? null : method,
      provider_ref:
        spec.status === 'created'
          ? null
          : `${provider === 'stripe' ? 'pi' : 'FLW'}-${id('ref')}`,
      status: spec.status,
      expected_complete_at: expectedComplete,
      auto_release_at:
        spec.status === 'created'
          ? null
          : addDays(expectedComplete, cfg.auto_release_days),
      released_at: spec.status === 'refunded' ? null : releasedAt,
      payout_due_at: spec.status === 'refunded' ? null : payoutDue,
      fee_amount: fee,
      confirmations: confirmed.map((side, i) => ({
        side,
        confirmed_at: addDays(createdAt, 3.5 + i * 0.2),
        actor: 'user' as const,
      })),
      metadata: { booking_id: spec.buyer_ref },
      created_at: createdAt,
      updated_at: createdAt,
    }
    deals.push(deal)

    const entry = (
      type: LedgerEntry['entry_type'],
      amount: number,
      at: string,
    ): void => {
      ledger.push({
        id: id('led'),
        tenant_id: spec.tenant_id,
        deal_id: dealId,
        entry_type: type,
        amount,
        currency,
        // Entries carry the rail that actually held the money, which is what
        // per-provider balances and reconciliation are computed from.
        provider: deal.provider,
        provider_ref: deal.provider_ref,
        created_at: at,
      })
    }

    const log = (actor: string, action: string, at: string, details = {}) => {
      audit.push({
        id: id('aud'),
        tenant_id: spec.tenant_id,
        deal_id: dealId,
        actor,
        action,
        details,
        created_at: at,
      })
    }

    log('api:autohire-prod', 'deal.created', createdAt, {
      amount: spec.amount,
      currency,
    })

    if (spec.status !== 'created') {
      const fundedAt = addDays(createdAt, 0.1)
      entry('hold', spec.amount, fundedAt)
      if (spec.deposit_amount) entry('deposit_hold', spec.deposit_amount, fundedAt)
      log('system', 'webhook.verified', fundedAt, { provider })
      log('system', 'deal.funded_held', fundedAt, {})
    }

    for (const c of deal.confirmations) {
      log(`user:${c.side}`, `deal.confirmed_${c.side}`, c.confirmed_at, {})
    }

    if (releasedAt && spec.status !== 'refunded') {
      entry('release', -spec.amount, releasedAt)
      entry('fee', -fee, releasedAt)
      if (spec.deposit_amount) {
        entry('deposit_release', -spec.deposit_amount, releasedAt)
      }
      log('system', 'deal.released', releasedAt, { fee_amount: fee })
    }

    if (spec.status === 'refunded') {
      const refundedAt = addDays(createdAt, 2)
      entry('refund', -spec.amount, refundedAt)
      log('api:autohire-prod', 'deal.refunded', refundedAt, {
        reason: 'Host cancelled',
      })
    }

    if (spec.dispute_reason) {
      const openedAt = addDays(createdAt, 3.2)
      disputes.push({
        id: id('dsp'),
        tenant_id: spec.tenant_id,
        deal_id: dealId,
        raised_by: spec.description.includes('never delivered') ? 'buyer' : 'seller',
        reason: spec.dispute_reason,
        status: 'open',
        opened_at: openedAt,
        resolved_at: null,
        resolution_note: null,
      })
      log('system', 'deal.disputed', openedAt, { reason: spec.dispute_reason })
    }

    // Payouts exist for anything that released and cleared.
    if (releasedAt && payoutDue) {
      const net = spec.amount - fee
      const paidAt = spec.paid ? ago(spec.paid) : null
      const status: Payout['status'] = spec.payout_failed
        ? 'failed'
        : paidAt
          ? 'paid'
          : 'scheduled'

      payouts.push({
        id: id('po'),
        tenant_id: spec.tenant_id,
        deal_id: dealId,
        seller_id: spec.seller_id,
        amount: net,
        currency,
        status,
        scheduled_for: payoutDue,
        paid_at: paidAt,
        failure_reason: spec.payout_failed
          ? 'Beneficiary rejected: MoMo account not active'
          : null,
        attempts: spec.payout_failed ? 3 : paidAt ? 1 : 0,
      })

      if (paidAt) {
        entry('payout', -net, paidAt)
        log('system', 'payout.paid', paidAt, { amount: net })
      }
      if (spec.payout_failed) {
        log('system', 'payout.failed', addDays(payoutDue, 0.2), {
          reason: 'Beneficiary rejected: MoMo account not active',
        })
      }
    }
  }

  const api_keys: ApiKey[] = [
    {
      id: id('key'),
      tenant_id: AUTOHIRE,
      label: 'autohire-prod',
      masked_key: 'ph_live_7f3•••••••••••••••a91c',
      created_at: ago(210),
      revoked_at: null,
      last_used_at: ago(0),
    },
    {
      id: id('key'),
      tenant_id: AUTOHIRE,
      label: 'autohire-staging',
      masked_key: 'ph_test_2b8•••••••••••••••44de',
      created_at: ago(210),
      revoked_at: null,
      last_used_at: ago(2),
    },
    {
      id: id('key'),
      tenant_id: AUTOHIRE,
      label: 'old-integration',
      masked_key: 'ph_live_9c1•••••••••••••••07ba',
      created_at: ago(190),
      revoked_at: ago(64),
      last_used_at: ago(66),
    },
    {
      id: id('key'),
      tenant_id: EQUIPCO,
      label: 'equipco-prod',
      masked_key: 'ph_live_5da•••••••••••••••31f7',
      created_at: ago(46),
      revoked_at: null,
      last_used_at: ago(1),
    },
  ]

  const webhook_endpoints: WebhookEndpoint[] = [
    {
      id: id('whe'),
      tenant_id: AUTOHIRE,
      url: 'https://autohiretech.pages.dev/api/payhold-events',
      masked_secret: 'whsec_••••••••••••3f21',
      created_at: ago(210),
      disabled_at: null,
    },
    {
      id: id('whe'),
      tenant_id: EQUIPCO,
      url: 'https://rwandaequipment.rw/hooks/payhold',
      masked_secret: 'whsec_••••••••••••9ab4',
      created_at: ago(46),
      disabled_at: null,
    },
  ]

  const alerts: ReconciliationAlert[] = [
    {
      id: id('rec'),
      tenant_id: EQUIPCO,
      currency: 'RWF',
      ledger_balance: 38_000_00,
      provider_balance: 38_250_00,
      drift: 25_000,
      detected_at: ago(0.4),
      resolved_at: null,
    },
  ]

  return {
    version: SCHEMA_VERSION,
    clock_offset_ms: 0,
    current_tenant_id: AUTOHIRE,
    tenants,
    settings,
    sellers,
    deals,
    ledger,
    payouts,
    disputes,
    api_keys,
    webhook_endpoints,
    audit,
    alerts,
    fail_next_payout: false,
    id_counter: counter,
  }
}
