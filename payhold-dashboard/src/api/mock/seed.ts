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
  AiChatMessage,
  AiSuggestion,
  ApiKey,
  AuditLogEntry,
  ConfirmSide,
  Country,
  Currency,
  Deal,
  DealOutcome,
  DealStatus,
  Dispute,
  DisputeEvidence,
  LedgerEntry,
  PaymentMethod,
  Payout,
  Provider,
  ProviderAccount,
  ReconciliationAlert,
  ReconciliationRun,
  RequestContext,
  Seller,
  SellerDestination,
  Tenant,
  TenantSettings,
  WebhookEndpoint,
} from '../types'
import { AI_META, composeDisputeDraft, hashInput } from './ai'
import {
  BUMPER_AT_RETURN,
  BUMPER_CLOSE_UP,
  CANCELLATION_MESSAGE,
  DEPOT_GATE_LOG,
  MECHANIC_INVOICE,
  PANEL_BEATER_QUOTE,
  PICKUP_WIDE,
  PRE_HIRE_CHECKLIST,
} from './evidence-photos'
import { collectionRails, defaultProviderFor, providerFor } from '@/lib/rails'
import { makeAccount } from './accounts'
import { payoutFindings, recordFindings } from './risk'
import { platformLaunchChecklist } from './launch'
import { platformPayoutRoutes, platformProviderCapabilities } from './routing'
import { SCHEMA_VERSION, addDays, mintId, type MockDb } from './store'

const AUTOHIRE = 'ten_0001'
const EQUIPCO = 'ten_0002'

/**
 * The fixture logins, and the only credentials in this repository.
 *
 * They are printed on the sign-in screen of a mock build on purpose: that build
 * is a simulation with no backend behind it, and hiding the password to a
 * browser-side fixture would be security theatre with a support cost. They are
 * meaningless against a real deployment, where accounts live in Supabase Auth
 * and none of this file runs.
 *
 * Both are `owner` — the fixtures include connecting rails and clearing a held
 * payout, and a `viewer` could do neither.
 */
export const DEMO_LOGINS = [
  {
    email: 'owner@autohire.example',
    password: 'payhold-demo-2026',
    company: 'AutoHire',
    full_name: 'Aline Uwase',
    tenant_id: AUTOHIRE,
  },
  {
    email: 'owner@rwanda-equipment.example',
    password: 'payhold-demo-2026',
    company: 'Rwanda Equipment Co',
    full_name: 'Jean-Paul Habimana',
    tenant_id: EQUIPCO,
  },
]

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
      // Below the §6.1 default of 14 on purpose: a tenant that has chosen its
      // own window is the normal case, and a fixture where every number equals
      // the default teaches nothing about which ones are configurable.
      clearance_days: 7,
      auto_release_days: 3,
      // Rwanda is home; KES covers the Kenya expansion, USD the tourist trade.
      currencies: ['RWF', 'USD', 'KES'],
      ai_enabled: true,
      ai_monthly_budget_usd: 25_00,
      risk_rules_enabled: true,
      risk_review_threshold_usd: 1_000_00,
    },
    {
      tenant_id: EQUIPCO,
      service_fee_rate: 0.08,
      buyer_fee: 50000,
      clearance_days: 5,
      auto_release_days: 4,
      currencies: ['RWF'],
      // Deliberately off, so switching tenant in the dev panel shows what a
      // company without Intelligence looks like: no drafts, no chat, and every
      // money path behaving exactly as it does for AutoHire.
      ai_enabled: false,
      ai_monthly_budget_usd: 10_00,
      // Equipment hire moves larger sums less often, so the same absolute
      // threshold would hold every payout they make. Their number is their
      // own, which is the §17 promise: a limit is a setting, not a deploy.
      risk_rules_enabled: true,
      risk_review_threshold_usd: 5_000_00,
    },
  ]

  const sellers: Seller[] = [
    {
      id: 'sel_0001',
      tenant_id: AUTOHIRE,
      name: 'Jean-Paul Habimana',
      country: 'RW',
      payout_currency: 'RWF',
      payout_provider: 'flutterwave_momo',
      beneficiary_token: 'ben_fw_8sk21',
      masked_destination: 'MTN •••• 4821',
      // Verified, like every seller that predates V2's KYC gate — the
      // migration grandfathers them for the same reason. A demo where every
      // payout is held teaches the wrong lesson about the gate.
      kyc_status: 'verified' as const,
      external_user_id: null,
      sanctions_checked_at: ago(30),
      destination_changed_at: null,
      created_at: ago(198),
    },
    {
      id: 'sel_0002',
      tenant_id: AUTOHIRE,
      name: 'Kigali City Rentals',
      country: 'RW',
      payout_currency: 'RWF',
      payout_provider: 'flutterwave_bank',
      beneficiary_token: 'ben_fw_2ma94',
      masked_destination: 'BK •••• 0073',
      // Verified, like every seller that predates V2's KYC gate — the
      // migration grandfathers them for the same reason. A demo where every
      // payout is held teaches the wrong lesson about the gate.
      kyc_status: 'verified' as const,
      external_user_id: null,
      sanctions_checked_at: ago(30),
      destination_changed_at: null,
      created_at: ago(176),
    },
    {
      id: 'sel_0003',
      tenant_id: AUTOHIRE,
      name: 'Aline Uwase',
      country: 'RW',
      payout_currency: 'RWF',
      payout_provider: 'flutterwave_momo',
      beneficiary_token: 'ben_fw_5df10',
      masked_destination: 'Airtel •••• 9302',
      // Verified, like every seller that predates V2's KYC gate — the
      // migration grandfathers them for the same reason. A demo where every
      // payout is held teaches the wrong lesson about the gate.
      kyc_status: 'verified' as const,
      external_user_id: null,
      sanctions_checked_at: ago(30),
      destination_changed_at: null,
      created_at: ago(120),
    },
    {
      id: 'sel_0004',
      tenant_id: AUTOHIRE,
      name: 'Musanze Fleet Services',
      country: 'RW',
      payout_currency: 'RWF',
      payout_provider: 'flutterwave_bank',
      beneficiary_token: 'ben_fw_7qz45',
      masked_destination: 'Equity •••• 6611',
      // Verified, like every seller that predates V2's KYC gate — the
      // migration grandfathers them for the same reason. A demo where every
      // payout is held teaches the wrong lesson about the gate.
      kyc_status: 'verified' as const,
      external_user_id: null,
      sanctions_checked_at: ago(30),
      destination_changed_at: null,
      created_at: ago(88),
    },
    {
      id: 'sel_0006',
      tenant_id: AUTOHIRE,
      name: 'Nairobi Car Hire Ltd',
      country: 'KE',
      payout_currency: 'KES',
      payout_provider: 'flutterwave_momo',
      beneficiary_token: 'ben_fw_4ke82',
      masked_destination: 'M-Pesa •••• 5540',
      // Verified, like every seller that predates V2's KYC gate — the
      // migration grandfathers them for the same reason. A demo where every
      // payout is held teaches the wrong lesson about the gate.
      kyc_status: 'verified' as const,
      external_user_id: null,
      sanctions_checked_at: ago(30),
      destination_changed_at: null,
      created_at: ago(52),
    },
    /**
     * Registered a day before taking a booking, and now due their first payout.
     * That combination is the new-seller rule's whole subject, and without
     * somebody it applies to the Fraud screen has nothing to show and no way to
     * be checked. Nothing is wrong with them — most sellers who register on a
     * Tuesday are exactly who they say they are — which is the point: the rule
     * makes them wait for a person, and it may do nothing else.
     */
    {
      id: 'sel_0007',
      tenant_id: AUTOHIRE,
      name: 'Théoneste Ndayisaba',
      country: 'RW',
      payout_currency: 'RWF',
      payout_provider: 'flutterwave_momo',
      beneficiary_token: 'ben_fw_9tn07',
      masked_destination: 'MTN •••• 3157',
      // Verified, like every seller that predates V2's KYC gate — the
      // migration grandfathers them for the same reason. A demo where every
      // payout is held teaches the wrong lesson about the gate.
      kyc_status: 'verified' as const,
      external_user_id: null,
      sanctions_checked_at: ago(30),
      destination_changed_at: null,
      created_at: ago(14),
    },
    {
      id: 'sel_0005',
      tenant_id: EQUIPCO,
      name: 'Nyabugogo Plant Hire',
      country: 'RW',
      payout_currency: 'RWF',
      payout_provider: 'flutterwave_momo',
      beneficiary_token: 'ben_fw_1cc38',
      masked_destination: 'MTN •••• 7714',
      // Verified, like every seller that predates V2's KYC gate — the
      // migration grandfathers them for the same reason. A demo where every
      // payout is held teaches the wrong lesson about the gate.
      kyc_status: 'verified' as const,
      external_user_id: null,
      sanctions_checked_at: ago(30),
      destination_changed_at: null,
      created_at: ago(40),
    },
  ]

  const deals: Deal[] = []
  const ledger: LedgerEntry[] = []
  const payouts: Payout[] = []
  const audit: AuditLogEntry[] = []
  const disputes: Dispute[] = []
  const deal_outcomes: DealOutcome[] = []
  const ai_suggestions: AiSuggestion[] = []

  /**
   * A dispute with both sides on the record.
   *
   * The fixtures give the assistant something real to weigh: a statement from
   * each party and the evidence they submitted, timestamped. The three seeded
   * cases are chosen to produce all three recommendations — one that clearly
   * favours the seller, one that clearly favours the buyer, and one the
   * evidence genuinely splits, which has to come back "ask a person".
   */
  interface DisputeSpec {
    raised_by: ConfirmSide
    reason: string
    counter_statement?: string
    /** `day` is days after the deal was created. */
    evidence?: {
      side: ConfirmSide
      kind: 'photo' | 'document'
      description: string
      /** Served by the client site; PayHold holds the reference, not the file. */
      url: string | null
      day: number
    }[]
    /** Seed it already closed, the way a past case would be. */
    resolved?: 'released' | 'refunded'
    resolution_note?: string
  }

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
    /** The specific wallet or scheme, e.g. "M-Pesa". */
    network?: string
    deposit_amount?: number
    status: DealStatus
    /** Days ago the deal was created. */
    created: number
    confirmed?: ConfirmSide[]
    /** Days ago the payout was actually sent, for paid_out deals. */
    paid?: number
    payout_failed?: boolean
    dispute?: DisputeSpec
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
      country: 'US',
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
      method: 'mobile_money',
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
      method: 'mobile_money',
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
      method: 'mobile_money',
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
    //
    // The first of these is what the Fraud screen is for: cleared, due, and
    // stopped by a rule rather than sent. It is a real hold produced by the
    // real rules at seed time — see `screenSeededPayouts` — so the explanation
    // on the screen is the one `risk.ts` writes today, not a copy of it.
    {
      tenant_id: AUTOHIRE,
      seller_id: 'sel_0007',
      buyer_ref: 'bk_9a52',
      description: 'Hilux double cab — 4 days, Nyungwe',
      amount: 38_000_00,
      status: 'released',
      created: 13,
      confirmed: ['buyer', 'seller'],
    },
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
      // A closed case, so the assistant has history to weigh and the training
      // set has a label that predates today's demo.
      dispute: {
        raised_by: 'buyer',
        reason:
          'The host cancelled on the morning of collection and the car was never delivered. Nobody answered the number on the booking.',
        evidence: [
          {
            side: 'buyer',
            kind: 'photo',
            description: 'Screenshot of the cancellation message',
            url: CANCELLATION_MESSAGE,
            day: 0.5,
          },
          {
            side: 'buyer',
            kind: 'document',
            description: 'Call log showing four unanswered calls',
            url: null,
            day: 0.7,
          },
        ],
        resolved: 'refunded',
        resolution_note:
          'Host cancelled with no notice and offered no replacement vehicle.',
      },
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
      // The buyer signed off before the seller found the damage — which is
      // exactly the ordering that should carry weight.
      confirmed: ['buyer'],
      dispute: {
        raised_by: 'seller',
        reason:
          'Vehicle returned with a cracked rear bumper and a deep scratch across the tailgate.',
        counter_statement:
          'The scratch was there when I collected it — I pointed it out to the yard attendant before I drove off.',
        evidence: [
          {
            side: 'seller',
            kind: 'photo',
            description: 'Rear bumper at return, timestamped',
            url: BUMPER_AT_RETURN,
            day: 4.0,
          },
          {
            side: 'seller',
            kind: 'photo',
            description: 'The crack, close up',
            url: BUMPER_CLOSE_UP,
            day: 4.05,
          },
          {
            side: 'seller',
            kind: 'document',
            description: 'Panel-beater quote for RWF 180,000',
            url: PANEL_BEATER_QUOTE,
            day: 4.2,
          },
          {
            side: 'buyer',
            kind: 'photo',
            description: 'One photo taken at pickup, bumper not clearly visible',
            url: PICKUP_WIDE,
            day: 4.4,
          },
        ],
      },
    },
    {
      tenant_id: AUTOHIRE,
      seller_id: 'sel_0004',
      buyer_ref: 'bk_9885',
      description: 'Isuzu pickup — 2 days, delivery run',
      amount: 13_000_00,
      status: 'disputed',
      created: 12,
      // The seller has stayed silent, which is the whole case.
      dispute: {
        raised_by: 'buyer',
        reason:
          'The pickup was never delivered. Nobody arrived at the depot and no one answered the number on the booking.',
        evidence: [
          {
            side: 'buyer',
            kind: 'document',
            description: 'Depot gate log showing no vehicle arrived that day',
            url: DEPOT_GATE_LOG,
            day: 2.4,
          },
        ],
      },
    },
    {
      tenant_id: AUTOHIRE,
      seller_id: 'sel_0006',
      buyer_ref: 'bk_9a91',
      description: 'Mazda Demio — 3 days, Nakuru',
      amount: 19_000_00,
      currency: 'KES',
      method: 'mobile_money',
      status: 'disputed',
      created: 7,
      // Both sides answered, both submitted something, neither is ahead. This
      // is the case that has to come back "ask a person" rather than guess.
      dispute: {
        raised_by: 'buyer',
        reason:
          'Car overheated on the second day and I lost half a day of the trip waiting for a mechanic.',
        counter_statement:
          'The coolant was topped up before collection. The renter drove 400km on a hire booked for town use.',
        evidence: [
          {
            side: 'buyer',
            kind: 'document',
            description: 'Mechanic invoice from Nakuru, dated day two',
            url: MECHANIC_INVOICE,
            day: 2.2,
          },
          {
            side: 'seller',
            kind: 'document',
            description: 'Pre-hire checklist signed at collection',
            url: PRE_HIRE_CHECKLIST,
            day: 2.8,
          },
        ],
      },
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
      spec.country ?? (currency === 'KES' ? 'KE' : currency === 'USD' ? 'US' : 'RW')
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
      // Fixtures are all priced in a currency the buyer's market can pay,
      // so presentment matches settlement and no conversion applies.
      presentment_currency: currency,
      presentment_amount: spec.amount,
      fx_rate: null,
      deposit_amount: spec.deposit_amount ?? null,
      buyer_country: country,
      provider,
      payment_method: spec.status === 'created' ? null : method,
      payment_network:
        spec.status === 'created'
          ? null
          : (spec.network ??
            collectionRails(country, currency).find((r) => r.method === method)
              ?.networks[0] ??
            (method === 'card' ? 'Visa' : null)),
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
      // Fixtures carry no tax, discount or reserve: they should demonstrate the
      // ordinary shape, and a breakdown with a figure in every line teaches
      // less about which ones are optional.
      tax_amount: 0,
      discount_amount: 0,
      provider_fee_amount: 0,
      reserve_amount: 0,
      reserve_until: null,
      // Fixtures carry no per-deal policy: they should demonstrate the tenant's
      // settings, which is what a new account actually sees.
      completion_policy: {
        completion_event: null,
        auto_complete_after_hours: null,
        clearing_days: null,
      },
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
      // Fixtures are all priced in a currency the buyer's market can pay,
      // so presentment matches settlement and no conversion applies.
      presentment_currency: currency,
      presentment_amount: spec.amount,
      fx_rate: null,
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

    if (spec.dispute) {
      const d = spec.dispute
      // A dispute always follows whatever confirmations came before it — the
      // ordering is the evidence, so getting it wrong here would quietly teach
      // the assistant the opposite of what the fixture means.
      const lastConfirmation = deal.confirmations.at(-1)?.confirmed_at
      const openedAt = lastConfirmation
        ? addDays(lastConfirmation, 0.3)
        : addDays(createdAt, 3.2)
      const resolvedAt = d.resolved ? addDays(createdAt, 5) : null

      const evidence: DisputeEvidence[] = (d.evidence ?? []).map((e) => ({
        side: e.side,
        kind: e.kind,
        description: e.description,
        url: e.url,
        // Fixtures record the capture time as the moment it was filed. A
        // seeded photo claiming to have been taken at handover would be
        // inventing evidence for a case nobody argued.
        captured_at: null,
        submitted_at: addDays(createdAt, e.day),
      }))

      const disputeId = id('dsp')
      disputes.push({
        id: disputeId,
        tenant_id: spec.tenant_id,
        deal_id: dealId,
        raised_by: d.raised_by,
        raised_by_actor: `user:${d.raised_by}`,
        reason: d.reason,
        // The fixtures predate §8's codes and none of them was filed under one.
        // Defaulting rather than back-filling keeps them honest.
        reason_code: 'other',
        disputed_amount: null,
        counter_statement: d.counter_statement ?? null,
        evidence,
        status: !d.resolved
          ? 'open'
          : d.resolved === 'released'
            ? 'resolved_released'
            : 'resolved_refunded',
        opened_at: openedAt,
        resolved_at: resolvedAt,
        resolution_note: d.resolution_note ?? null,
        decided_by: d.resolved ? 'payhold-staff' : null,
      })
      log(`user:${d.raised_by}`, 'deal.disputed', openedAt, { reason: d.reason })
      for (const e of evidence) {
        log(`user:${e.side}`, 'dispute.evidence_submitted', e.submitted_at, {
          description: e.description,
        })
      }

      if (d.resolved && resolvedAt) {
        log('payhold-staff', 'dispute.resolved', resolvedAt, {
          resolution: d.resolved === 'released' ? 'release' : 'refund',
          note: d.resolution_note,
        })
        deal_outcomes.push({
          id: id('out'),
          tenant_id: spec.tenant_id,
          deal_id: dealId,
          outcome: d.resolved === 'released' ? 'dispute_released' : 'dispute_refunded',
          reason_code: `dispute_${d.raised_by}_raised`,
          notes: d.resolution_note ?? null,
          amount_disputed: spec.amount,
          resolved_at: resolvedAt,
          created_at: resolvedAt,
        })
      }
    } else if (spec.status === 'paid_out' || spec.status === 'refunded') {
      // Every terminal deal gets a label, not just the interesting ones — a
      // training set of nothing but disputes teaches a model that every deal
      // goes wrong.
      const at = spec.paid ? ago(spec.paid) : addDays(createdAt, 2)
      deal_outcomes.push({
        id: id('out'),
        tenant_id: spec.tenant_id,
        deal_id: dealId,
        outcome: spec.status === 'refunded' ? 'refunded' : 'released_clean',
        reason_code: spec.status === 'refunded' ? 'client_refund' : 'both_confirmed',
        notes: null,
        amount_disputed: null,
        resolved_at: at,
        created_at: at,
      })
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
        // §13's retry clock. A failed fixture is mid-ladder rather than
        // exhausted — the seeded state is a payout still being retried, which
        // is the one an operator has a decision to make about.
        next_attempt_at: spec.payout_failed
          ? addDays(payoutDue, 0.3)
          : paidAt
            ? null
            : payoutDue,
        review_held_at: null,
        review_held_by: null,
        review_hold_reason: null,
        review_approved_by: null,
        review_approved_at: null,
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

  /**
   * A payout destination that moved days before a payout is due. Nothing is
   * wrong with it — sellers change phones — but it is the single line a human
   * most wants surfaced before they approve, so the risk narrator has a real
   * row to cite rather than an invented one.
   */
  audit.push({
    id: id('aud'),
    tenant_id: AUTOHIRE,
    deal_id: null,
    actor: 'api:autohire-prod',
    action: 'seller.destination_updated',
    details: {
      seller_id: 'sel_0001',
      masked_destination: 'MTN •••• 4821',
      previous: 'MTN •••• 1190',
    },
    created_at: ago(1),
  })

  /**
   * Two drafts, produced by running the real drafting code over the fixtures
   * rather than by hand — so the demo opens with something to decide, and the
   * seeded wording can never drift from what the button produces.
   *
   * One is waiting on a person. The other was approved days ago, so the trail
   * is visible from the first minute: a suggestion, the named human who took
   * it, and the labelled outcome that followed.
   */
  const draftView = { deals, disputes, sellers, audit } as MockDb

  const draftFor = (
    dispute: Dispute,
    at: string,
    decided?: { by: string; at: string },
  ) => {
    const { output, input } = composeDisputeDraft(draftView, dispute)
    const suggestionId = id('ais')

    ai_suggestions.push({
      id: suggestionId,
      tenant_id: dispute.tenant_id,
      deal_id: dispute.deal_id,
      kind: 'dispute_resolution',
      model: AI_META.model,
      prompt_version: AI_META.prompt.dispute,
      input_hash: hashInput(input),
      output,
      cost_usd: AI_META.cost.dispute,
      created_at: at,
      decision: decided ? 'approved' : null,
      decided_by: decided?.by ?? null,
      decided_at: decided?.at ?? null,
    })

    audit.push({
      id: id('aud'),
      tenant_id: dispute.tenant_id,
      deal_id: dispute.deal_id,
      actor: `ai:${AI_META.model}`,
      action: 'ai.suggestion_drafted',
      details: {
        suggestion_id: suggestionId,
        kind: 'dispute_resolution',
        prompt_version: AI_META.prompt.dispute,
        cost_usd: AI_META.cost.dispute,
      },
      created_at: at,
    })

    if (decided) {
      audit.push({
        id: id('aud'),
        tenant_id: dispute.tenant_id,
        deal_id: dispute.deal_id,
        actor: decided.by,
        action: 'ai.suggestion_approved',
        details: { suggestion_id: suggestionId, kind: 'dispute_resolution' },
        created_at: decided.at,
      })
    }
  }

  const waiting = disputes.find(
    (d) => d.status === 'open' && d.reason.includes('bumper'),
  )
  if (waiting) draftFor(waiting, ago(0.08))

  const closedDispute = disputes.find((d) => d.status === 'resolved_refunded')
  if (closedDispute?.resolved_at) {
    draftFor(closedDispute, addDays(closedDispute.resolved_at, -0.05), {
      by: 'grace@autohire.rw',
      at: closedDispute.resolved_at,
    })
  }

  /**
   * No transcript. The assistant shows nothing until it is asked something —
   * a panel that opens already full of this account's business is noise at
   * best, and at worst it looks like something happened while you were away.
   */
  const ai_chat: AiChatMessage[] = []

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

  /**
   * The secret is here because this file stands in for the backend, where it
   * lives encrypted in `webhook_endpoints.secret_encrypted`. It never leaves
   * the mock: the client returns `masked_secret`, and the only code that reads
   * the real value is the signer.
   */
  const webhook_endpoints: (WebhookEndpoint & { secret: string })[] = [
    {
      id: id('whe'),
      tenant_id: AUTOHIRE,
      url: 'https://autohiretech.pages.dev/api/payhold-events',
      secret: 'whsec_demo_autohire_signing_key_3f21',
      masked_secret: 'whsec_••••••••••••3f21',
      created_at: ago(210),
      disabled_at: null,
    },
    {
      id: id('whe'),
      tenant_id: EQUIPCO,
      url: 'https://rwandaequipment.rw/hooks/payhold',
      secret: 'whsec_demo_equipco_signing_key_9ab4',
      masked_secret: 'whsec_••••••••••••9ab4',
      created_at: ago(46),
      disabled_at: null,
    },
  ]

  /**
   * No rails connected. A fresh demo runs entirely on the fake provider, which
   * is exactly what §12 requires — a full lifecycle before any real credentials
   * exist. Seeding a connected account would hide the one screen a new company
   * has to visit first.
   */
  const provider_accounts: (ProviderAccount & { tenant_id: string })[] = []

  /**
   * No alert is seeded. What is seeded is the *disagreement*: Flutterwave is
   * reporting 250.00 RWF more than Rwanda Equipment's ledger accounts for, and
   * the first reconciliation pass discovers it and freezes their payouts.
   *
   * Handing the dashboard a pre-written alert would have demonstrated the
   * alert component. This demonstrates the job.
   */
  const alerts: ReconciliationAlert[] = []
  // §13's run records. Empty at seed for the same reason `webhook_deliveries`
  // is: a pass is something the cron does, and inventing one nobody ran would
  // be a fixture claiming we had looked.
  const reconciliation_runs: ReconciliationRun[] = []

  const provider_drift: Record<string, number> = {
    [`${EQUIPCO}:flutterwave:RWF`]: 25_000,
  }

  // One owner per fixture company. Without these the demo would be reachable
  // only by signing up, and a fresh signup gets an empty tenant — so there
  // would be no way to see the fixtures the rest of this file exists for.
  const accounts = DEMO_LOGINS.map((login, i) =>
    makeAccount(
      id('acct'),
      login.email,
      login.password,
      login.tenant_id,
      ago(i === 0 ? 210 : 46),
      login.full_name,
    ),
  )

  /**
   * Where each funded deal was paid from — spec §6.
   *
   * Derived from the deals rather than hand-listed, so the Fraud screen always
   * has something to show and a fixture can never point at a deal that was
   * renamed out from under it.
   *
   * Three things are encoded on purpose, because they are the three shapes an
   * operator has to learn to read:
   *
   *   1. **A shared address is usually innocent here.** Several unrelated MTN
   *      buyers land on 41.186.0.x, because Rwandan mobile money sits behind
   *      carrier-grade NAT. A screen that highlighted that as suspicious would
   *      cry wolf on most of this account's honest traffic.
   *   2. **Provenance changes the weight.** The Stripe tourist's address is
   *      provider-reported; one deal carries only a client-attested one, which
   *      is a claim rather than an observation.
   *   3. **Absence is normal.** Some deals have no address at all — an older
   *      integration that sends nothing. That is a gap in a report, not a flag.
   */
  const request_context: RequestContext[] = []

  const NAT_POOL = ['41.186.0.42', '41.186.0.42', '41.186.0.51', '105.178.12.9']
  let natIndex = 0

  for (const deal of deals) {
    if (deal.status === 'created') continue

    // One deal deliberately has nothing recorded against it.
    if (deal.buyer_ref === 'bk_9b92') continue

    const attested = deal.buyer_ref === 'bk_9c07'
    const foreignCard = deal.provider === 'stripe'
    const ip = foreignCard
      ? '81.2.69.144'
      : (NAT_POOL[natIndex++ % NAT_POOL.length] as string)

    request_context.push({
      id: id('rqc'),
      tenant_id: deal.tenant_id,
      deal_id: deal.id,
      source: attested ? 'client_attested' : 'provider',
      event: attested ? 'pay_started' : 'charge_confirmed',
      ip,
      // Only the provider reports one, and only where it has one to report.
      ip_country: attested ? null : foreignCard ? 'GB' : 'RW',
      user_agent: foreignCard
        ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15'
        : 'Mozilla/5.0 (Linux; Android 13; TECNO KI5k) AppleWebKit/537.36',
      created_at: deal.created_at,
    })
  }

  /**
   * §5.1: every seller's registered destination becomes their primary, verified
   * for the same reason their KYC is — nothing here has ever taken live money,
   * so there is no unverified seller to catch, and leaving them pending would
   * hold every payout in the demo for a fact untrue of them.
   *
   * `sel_0001` also gets a verified backup, so the fallback path §5.1 gates
   * behind a failed primary is something the demo can actually reach.
   */
  const seller_destinations: SellerDestination[] = sellers.flatMap((seller) => {
    const primary: SellerDestination = {
      id: `dest_${seller.id.slice(-4)}_p`,
      tenant_id: seller.tenant_id,
      seller_id: seller.id,
      label: 'Primary',
      country: seller.country,
      payout_currency: seller.payout_currency,
      payout_provider: seller.payout_provider,
      beneficiary_token: seller.beneficiary_token,
      masked_destination: seller.masked_destination,
      is_primary: true,
      is_backup: false,
      verified_at: seller.created_at,
      security_hold_until: null,
      created_at: seller.created_at,
    }

    if (seller.id !== 'sel_0001') return [primary]

    return [primary, {
      ...primary,
      id: `dest_${seller.id.slice(-4)}_b`,
      label: 'Backup',
      payout_provider: 'flutterwave_bank' as const,
      beneficiary_token: 'ben_fw_bk_3312',
      masked_destination: 'BK of Kigali •••• 9910',
      is_primary: false,
      is_backup: true,
    }]
  })

  const db: MockDb = {
    version: SCHEMA_VERSION,
    clock_offset_ms: 0,
    current_tenant_id: AUTOHIRE,
    tenants,
    accounts,
    settings,
    sellers,
    seller_destinations,
    deals,
    ledger,
    payouts,
    // §5's launch matrix as rows. Which corridor is open is data, so a demo can
    // switch one off and watch a payout block — §5.2's eighth case.
    payout_routes: platformPayoutRoutes(ago(365)),
    payout_decisions: [],
    // §9's matrix. Three adapters built, three declared — and no closed
    // markets, because `payment_markets` is an overlay: a country nobody has
    // ruled on is open.
    provider_capabilities: platformProviderCapabilities(),
    payment_markets: [],
    // §16, and nothing signed. The gate ships shut, because the list is a list
    // of things nobody has done yet — seeding a signature would make the demo
    // teach that live keys are one click away.
    launch_checklist: platformLaunchChecklist(),
    launch_sign_offs: [],
    // No fixture sessions: a payment link is a thing that was issued, not a
    // state a deal rests in, and a seeded one would be expired by the time
    // anybody loaded the demo.
    checkout_sessions: [],
    disputes,
    dispute_offers: [],
    // No fixture refunds: the seeded deals all ran cleanly or are still
    // running, and a refund is a thing that happened rather than a state.
    refunds: [],
    api_keys,
    provider_accounts,
    webhook_endpoints,
    webhook_deliveries: [],
    audit,
    alerts,
    reconciliation_runs,
    risk_signals: [],
    request_context,
    ai_suggestions,
    ai_chat,
    deal_outcomes,
    fail_next_payout: false,
    fail_next_webhook: false,
    provider_drift,
    id_counter: counter,
  }

  screenSeededPayouts(db)

  return db
}

/**
 * Run the deterministic rules over the payouts that have come due and not gone
 * out, the way the dispatcher does when it picks them up.
 *
 * The fixtures could have carried a hand-written hold and a hand-written
 * signal, and that would have been a lie in two directions: a demo whose fraud
 * screen shows a rule the code would not have fired, and a wording that drifts
 * from `risk.ts` the first time somebody edits an explanation. So this calls
 * the real rules and records what they actually say — the same reason the
 * seeded AI drafts are produced by running `composeDisputeDraft` rather than by
 * copying its output.
 *
 * Two departures from `screenPayout`, both deliberate. Nothing is queued for
 * delivery, because the seeded history predates the delivery log the same way
 * the rest of it does — `webhook_deliveries` starts empty on purpose. And the
 * hold is stamped at the payout's due date rather than at seed time, because
 * that is when the dispatcher would have looked at it.
 */
function screenSeededPayouts(db: MockDb): void {
  for (const payout of db.payouts) {
    // Only what the dispatcher would have reached: due, and still unsent.
    if (payout.status !== 'scheduled') continue
    if (new Date(payout.scheduled_for) > new Date()) continue

    const cfg = db.settings.find((s) => s.tenant_id === payout.tenant_id)
    if (!cfg) continue

    const findings = payoutFindings(db, payout, cfg)
    if (findings.length === 0) continue

    // Recorded whether or not the rules are switched on. The setting governs
    // holding, not noticing.
    recordFindings(db, payout.tenant_id, payout.deal_id, payout.seller_id, findings, {
      id: () => mintId(db, 'risk'),
      at: payout.scheduled_for,
    })

    const blocking = findings.filter((f) => f.severity === 'review')
    if (!cfg.risk_rules_enabled || blocking.length === 0) continue

    payout.status = 'held_for_review'
    payout.review_held_at = payout.scheduled_for

    db.audit.push({
      id: mintId(db, 'aud'),
      tenant_id: payout.tenant_id,
      deal_id: payout.deal_id,
      actor: 'system',
      action: 'payout.held_for_review',
      details: {
        payout_id: payout.id,
        signals: blocking.map((f) => f.signal),
        reasons: blocking.map((f) => f.explanation),
      },
      created_at: payout.scheduled_for,
    })
  }
}
