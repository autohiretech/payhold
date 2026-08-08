/**
 * §5.1's Payout Preferences and Automatic Routing Center.
 *
 * The mirror of `20260807000009_payout_routing.sql` — `route_evaluation`,
 * `route_payout`, `route_reason_text` and `payout_display_status`, in the same
 * order and with the same reason codes. A change to either is a change to both,
 * the rule `types.ts` already sets for the wire contract.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * The rule that shapes all of it — §5.1: **"it must never silently redirect
 * funds to another destination."**
 *
 * That is why a route is not a fallback for another route. A destination is a
 * token minted by one provider for one rail, so "the highest-ranked eligible
 * fallback" cannot mean a different rail for the same destination. It means the
 * seller's *backup destination*, and §5.1 gates that behind a failed primary
 * payout, an explicit policy check and a notification.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Invariant 11 is unchanged. The engine may set a payout to `blocked` and may
 * do nothing else: no ledger entry, no provider call, no change to the deal.
 */

import type {
  Country,
  Currency,
  Money,
  Payout,
  PayoutDecision,
  PayoutDisplayStatus,
  PayoutProvider,
  PayoutRoute,
  ProviderCapability,
  RouteCheck,
  RouteReasonCode,
  Seller,
  SellerDestination,
} from '../types'
import { audit, mintId, now, nowIso, type MockDb } from './store'
import { emitWebhook } from './webhooks'
import { routeReasonText } from '@/lib/rails'

/**
 * `route_reason_text` lives in `lib/rails.ts` and is re-exported here.
 *
 * It is the SQL function's mirror like everything else in this file, but it is
 * also **rail vocabulary a screen has to render** — the Routing Center turns a
 * stored `reason_code` back into a sentence — and screens do not import from
 * the mock. The convention already says where a provider-facing phrase lives,
 * so it lives there and this file borrows it.
 */
export { routeReasonText } from '@/lib/rails'

// ---------------------------------------------------------------------------
// The launch matrix — §5, as rows
// ---------------------------------------------------------------------------

/**
 * The platform defaults, mirroring the seed in `20260807000009_payout_routing.sql`.
 * A tenant overrides one by adding their own row for the same rail.
 *
 * The country lists are deliberately narrower than `countries.ts` knows about.
 * That file is the generated registry of where money *can* go in principle;
 * this is where it may go **today**, which §5 calls "a country-and-currency
 * matrix, not a hard-coded list" and adds to "only through a formal
 * country-launch checklist". Adding a country is a row, not a release.
 */
export function platformPayoutRoutes(createdAt: string): PayoutRoute[] {
  const base = {
    tenant_id: null,
    supports_payouts: true,
    risk_status: 'approved' as const,
    min_amount: 0,
    max_amount: null,
    fee_fixed: 0,
    fee_bps: 0,
    created_at: createdAt,
  }

  return [
    // Rwanda leads because it is the launch market and mobile money is what
    // sellers there actually use. That is the rank, not an accident of order.
    {
      ...base,
      id: 'route_fw_momo',
      payout_provider: 'flutterwave_momo',
      provider: 'flutterwave',
      method: 'mobile_money',
      countries: ['RW', 'KE', 'UG', 'TZ', 'GH', 'ZM', 'CI', 'SN', 'CM'],
      currencies: ['RWF', 'KES', 'UGX', 'TZS', 'GHS', 'ZMW', 'XOF', 'XAF'],
      enabled: true,
      rank: 10,
      note: "MTN and Airtel wallets via Flutterwave Transfers. The launch rail for §5's Rwanda row.",
    },
    {
      ...base,
      id: 'route_fw_bank',
      payout_provider: 'flutterwave_bank',
      provider: 'flutterwave',
      method: 'bank_account',
      countries: ['RW', 'KE', 'UG', 'TZ', 'GH', 'NG', 'ZA', 'ZM', 'CI', 'SN', 'CM', 'EG'],
      currencies: ['RWF', 'KES', 'UGX', 'TZS', 'GHS', 'NGN', 'ZAR', 'ZMW', 'XOF', 'XAF', 'EGP'],
      enabled: true,
      rank: 20,
      note: 'Bank transfer via Flutterwave. Slower than a wallet, and the only African route for an amount a wallet will not hold.',
    },
    // §5's UAE and United States rows. Stripe cannot pay a Rwandan recipient,
    // which is why the two rails above exist and why this list stops here.
    {
      ...base,
      id: 'route_stripe_connect',
      payout_provider: 'stripe_connect',
      provider: 'stripe',
      method: 'bank_account',
      countries: ['US', 'AE', 'GB', 'DE', 'FR', 'NL', 'IE', 'ES', 'IT', 'CA', 'AU'],
      currencies: ['USD', 'AED', 'EUR', 'GBP', 'CAD', 'AUD'],
      enabled: true,
      rank: 30,
      note: 'Stripe Connect payouts. Cannot reach African destinations — see the Flutterwave rails.',
    },
    // Declared and disabled, spec §29.3. Each names the adapter that *would*
    // carry it — one adapter carries several rails — and none of those adapters
    // is built, which is what `providerCapabilities` says and what stops these
    // being enabled.
    {
      ...base,
      id: 'route_paypal',
      payout_provider: 'paypal',
      provider: 'paypal',
      method: 'wallet',
      countries: ['US', 'AE', 'GB', 'DE', 'FR', 'NL', 'IE', 'ES', 'IT', 'CA', 'AU'],
      currencies: ['USD', 'AED', 'EUR', 'GBP', 'CAD', 'AUD'],
      enabled: false,
      rank: 40,
      note: 'Declared so a seller gets a specific answer. No adapter and no signed agreement — §29.3.',
    },
    {
      ...base,
      id: 'route_venmo',
      payout_provider: 'venmo',
      // Venmo destinations are reached through PayPal's API.
      provider: 'paypal',
      method: 'wallet',
      countries: ['US'],
      currencies: ['USD'],
      enabled: false,
      rank: 50,
      note: "United States only, by Venmo's own rules. §17 also rules out personal Venmo accounts, so this stays off even once an adapter exists.",
    },
    {
      ...base,
      id: 'route_cash_app',
      payout_provider: 'cash_app_pay',
      provider: 'cash_app_pay',
      method: 'wallet',
      countries: ['US'],
      currencies: ['USD'],
      enabled: false,
      rank: 60,
      note: 'United States only. Declared, not built — §29.3.',
    },
    // §5's Mainland China row: "Do not promise cross-border payout until
    // approved." These exist so a Chinese seller is told that rather than
    // told nothing.
    {
      ...base,
      id: 'route_alipay',
      payout_provider: 'alipay',
      provider: 'china_wallet_partner',
      method: 'wallet',
      countries: ['CN'],
      currencies: ['CNY'],
      enabled: false,
      rank: 70,
      note: 'Requires an approved local structure and payout partner. §5 forbids promising this route until it exists.',
    },
    {
      ...base,
      id: 'route_wechat',
      payout_provider: 'wechat_pay',
      provider: 'china_wallet_partner',
      method: 'wallet',
      countries: ['CN'],
      currencies: ['CNY'],
      enabled: false,
      rank: 80,
      note: 'Requires an approved local structure and payout partner. §5 forbids promising this route until it exists.',
    },
  ]
}

// ---------------------------------------------------------------------------
// What each adapter can do — §9
// ---------------------------------------------------------------------------

/**
 * The mirror of the seed in `20260807000011_capability_matrix.sql`.
 *
 * §9: "each adapter declares its capabilities rather than letting the UI
 * guess." `implemented` and `enabled` are separate because they fail
 * differently — an unbuilt adapter is a roadmap item, a disabled one is an
 * outage — and an operator has to tell those apart at 3am.
 */
export function platformProviderCapabilities(): ProviderCapability[] {
  return [
    {
      provider: 'flutterwave',
      implemented: true,
      enabled: true,
      supports_capture: true,
      supports_partial_refund: true,
      supports_marketplace_payout: true,
      supports_seller_onboarding: false,
      supports_dispute: false,
      supports_local_currency: true,
      supports_mobile_money: true,
      supports_async_refund: true,
      note:
        'Cards, mobile money and bank transfer across the African markets. The only rail that can pay a Rwandan seller.',
    },
    {
      provider: 'stripe',
      implemented: true,
      enabled: true,
      supports_capture: true,
      supports_partial_refund: true,
      supports_marketplace_payout: true,
      supports_seller_onboarding: true,
      supports_dispute: true,
      supports_local_currency: true,
      // African mobile money is Flutterwave's, which is the structural reason
      // both adapters exist.
      supports_mobile_money: false,
      supports_async_refund: true,
      note:
        'PaymentIntents with manual capture for deposits, Radar on every card charge, Connect for marketplace payouts.',
    },
    {
      // §12: a full lifecycle with zero keys. It claims everything, because a
      // capability it refused would make a demo path unreachable for a reason
      // that is not true of any real rail.
      provider: 'fake',
      implemented: true,
      enabled: true,
      supports_capture: true,
      supports_partial_refund: true,
      supports_marketplace_payout: true,
      supports_seller_onboarding: true,
      supports_dispute: true,
      supports_local_currency: true,
      supports_mobile_money: true,
      supports_async_refund: false,
      note: 'Demo mode. Fakes the counterparty and nothing else — every guard still applies.',
    },
    // Declared and unbuilt — §29.3. The flags describe what the documentation
    // says these APIs can do, so the day an adapter lands the row is already
    // right; `implemented` is what says it has not.
    {
      provider: 'paypal',
      implemented: false,
      enabled: false,
      supports_capture: true,
      supports_partial_refund: true,
      supports_marketplace_payout: true,
      supports_seller_onboarding: true,
      supports_dispute: true,
      supports_local_currency: true,
      supports_mobile_money: false,
      supports_async_refund: false,
      note:
        'Declared so a seller who picks PayPal or Venmo gets a specific answer. No adapter and no signed agreement.',
    },
    {
      provider: 'cash_app_pay',
      implemented: false,
      enabled: false,
      supports_capture: false,
      supports_partial_refund: true,
      supports_marketplace_payout: true,
      supports_seller_onboarding: false,
      supports_dispute: true,
      supports_local_currency: false,
      supports_mobile_money: false,
      supports_async_refund: false,
      note: 'United States only. Declared, not built.',
    },
    {
      provider: 'china_wallet_partner',
      implemented: false,
      enabled: false,
      supports_capture: false,
      supports_partial_refund: true,
      supports_marketplace_payout: true,
      supports_seller_onboarding: false,
      supports_dispute: false,
      supports_local_currency: true,
      supports_mobile_money: false,
      // §7.1.6: Alipay and WeChat refunds settle up to 90 days out.
      supports_async_refund: true,
      note:
        'Alipay and WeChat Pay routes the selected Stripe account does not cover. §5: do not promise cross-border payout until an approved local structure exists.',
    },
  ]
}

/**
 * Is this market open, in this direction, for this tenant?
 *
 * Absent rows mean open, which is what makes `payment_markets` an overlay: the
 * registry decides what is possible and this decides what is switched on, and a
 * market nobody has ruled on is not closed. A tenant row replaces the
 * platform's, the same rule `resolvedRoutes` applies to rails.
 */
export function marketOpen(
  db: MockDb,
  tenantId: string,
  country: Country,
  direction: 'collect' | 'payout',
): boolean {
  const rows = db.payment_markets.filter(
    (m) => m.country === country && (m.tenant_id === null || m.tenant_id === tenantId),
  )
  const row = rows.find((m) => m.tenant_id === tenantId) ?? rows[0]
  return row ? row[direction] : true
}

/** The adapters that are built and switched on right now. */
function adapterLive(db: MockDb, provider: PayoutRoute['provider']): boolean {
  const row = db.provider_capabilities.find((c) => c.provider === provider)
  // A missing row means live, for the same overlay reason as `marketOpen`.
  return row ? row.implemented && row.enabled : true
}

// ---------------------------------------------------------------------------
// The filter chain — §5.1's pseudocode, in the order it is written
// ---------------------------------------------------------------------------

/**
 * A tenant's row for a rail **replaces** the platform's rather than sitting
 * beside it. Without that, a tenant switching a rail off would leave the
 * platform's enabled row still eligible and "disabled" would mean nothing.
 */
function resolvedRoutes(db: MockDb, tenantId: string): PayoutRoute[] {
  const byRail = new Map<PayoutProvider, PayoutRoute>()

  for (const route of db.payout_routes) {
    if (route.tenant_id !== null && route.tenant_id !== tenantId) continue
    const held = byRail.get(route.payout_provider)
    // The tenant's own wins; otherwise the platform default stands.
    if (!held || (held.tenant_id === null && route.tenant_id !== null)) {
      byRail.set(route.payout_provider, route)
    }
  }

  return [...byRail.values()]
}

function verdict(
  db: MockDb,
  tenantId: string,
  route: PayoutRoute,
  country: Country,
  currency: Currency,
  amount: Money,
): RouteReasonCode {
  // §12's country switch comes first: a closed market is closed whatever the
  // rails say, and it is the only one of these an operator can reverse in a
  // minute.
  if (!marketOpen(db, tenantId, country, 'payout')) return 'market_closed'
  // Then the adapter, then the route. "The rail is unbuilt or out of service"
  // and "we switched this corridor off" are different sentences that need
  // different next actions.
  if (!adapterLive(db, route.provider)) return 'provider_unavailable'
  if (!route.enabled) return 'provider_disabled'
  if (route.risk_status === 'suspended') return 'route_suspended'
  if (route.risk_status !== 'approved') return 'route_under_review'
  if (!route.supports_payouts) return 'payouts_not_supported'
  if (!route.countries.includes(country)) return 'country_not_supported'
  if (!route.currencies.includes(currency)) return 'currency_not_supported'
  if (amount < route.min_amount) return 'below_route_minimum'
  if (route.max_amount !== null && amount > route.max_amount) {
    return 'above_route_maximum'
  }
  return 'routed'
}

/**
 * Every route with its verdict, not only the survivors.
 *
 * The losing rows are the eligibility record `PayoutDecision.checks` stores, and
 * a seller asking "why can I not use Venmo" needs the answer for the rail they
 * picked rather than the name of one they did not.
 *
 * `rail` is the destination's own rail: it sorts to the front and does not
 * filter, so the evaluation stays readable as a whole. `routePayout` is what
 * insists the winner match it.
 */
export function routeEvaluation(
  db: MockDb,
  tenantId: string,
  country: Country,
  currency: Currency,
  amount: Money,
  rail: PayoutProvider | null = null,
): RouteCheck[] {
  return resolvedRoutes(db, tenantId)
    .map((route): RouteCheck => {
      const reason = verdict(db, tenantId, route, country, currency, amount)
      return {
        route_id: route.id,
        provider: route.provider,
        payout_provider: route.payout_provider,
        method: route.method,
        rank: route.rank,
        fee_estimate: route.fee_fixed + Math.floor((amount * route.fee_bps) / 10_000),
        preferred: rail !== null && route.payout_provider === rail,
        eligible: reason === 'routed',
        reason_code: reason === 'routed' ? 'routed' : reason,
      }
    })
    // §5.1's `bySellerPreferenceThenReliabilityThenCost`, with eligibility ahead
    // of all of it. The last key is there so the order is total: a tie broken by
    // insertion order would make the engine non-deterministic in exactly the way
    // §5.1 forbids.
    .sort((a, b) =>
      Number(b.eligible) - Number(a.eligible) ||
      Number(b.preferred) - Number(a.preferred) ||
      a.rank - b.rank ||
      a.fee_estimate - b.fee_estimate ||
      a.payout_provider.localeCompare(b.payout_provider)
    )
}

// ---------------------------------------------------------------------------
// Destinations
// ---------------------------------------------------------------------------

export function primaryDestination(
  db: MockDb,
  sellerId: string,
): SellerDestination | undefined {
  return db.seller_destinations.find((d) => d.seller_id === sellerId && d.is_primary)
}

/**
 * A seller is created with their destination, or not at all.
 *
 * The mirror of `sellers_seed_primary_destination`, and a trigger there for the
 * reason it is a helper here: without it, every seller created after §5.1 would
 * have no destination row and be unpayable for a reason nobody chose — the
 * table would be the record in name only.
 *
 * It runs on creation and not on change, deliberately: moving a destination is
 * a `seller_destinations` write and goes through the security hold.
 */
export function seedPrimaryDestination(db: MockDb, seller: Seller): SellerDestination {
  const destination: SellerDestination = {
    id: mintId(db, 'dest'),
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
    // Unverified: §12's gate is that somebody attests to the ownership check,
    // and a destination that verified itself on creation is not a gate.
    verified_at: null,
    security_hold_until: null,
    created_at: seller.created_at,
  }

  db.seller_destinations.push(destination)
  return destination
}

function usableBackup(db: MockDb, sellerId: string): SellerDestination | undefined {
  return db.seller_destinations.find((d) =>
    d.seller_id === sellerId &&
    d.is_backup &&
    d.verified_at !== null &&
    (d.security_hold_until === null ||
      new Date(d.security_hold_until).getTime() <= now().getTime())
  )
}

// ---------------------------------------------------------------------------
// Choosing, recording, and — when there is nothing to choose — blocking
// ---------------------------------------------------------------------------

/** §5.1's routing-policy check, all of it, before the backup is even read. */
function backupAllowed(db: MockDb, payout: Payout): boolean {
  const cfg = db.settings.find((s) => s.tenant_id === payout.tenant_id)
  return payout.status === 'failed' &&
    payout.attempts >= (cfg?.payout_primary_attempts ?? 2) &&
    (cfg?.payout_backup_enabled ?? true)
}

/**
 * Choose a route, record the decision, and block the payout if there is none.
 *
 * One function rather than a chooser and a recorder, because §5.1 wants the
 * decision auditable and a recorder the caller may forget to invoke is not an
 * audit. Every *changed* outcome writes a row — an unchanged one does not, or a
 * blocked payout re-evaluated on every pass would bury the decision that
 * explains something under identical copies of itself.
 */
export function routePayout(db: MockDb, payout: Payout): PayoutDecision {
  if (payout.status === 'paid' || payout.status === 'processing') {
    // Choosing a different destination for money in flight is the silent
    // redirection §5.1 forbids, and it could not take effect anyway.
    throw new Error(`Payout ${payout.id} is already with the provider`)
  }

  const deal = db.deals.find((d) => d.id === payout.deal_id)
  const seller = db.sellers.find((s) => s.id === payout.seller_id) as Seller | undefined

  let destination = primaryDestination(db, payout.seller_id)
  let fallback = false

  // The evaluation is recorded against the destination we would prefer to use,
  // so `checks` answers "why not the seller's own choice".
  const checks = routeEvaluation(
    db,
    payout.tenant_id,
    destination?.country ?? seller?.country ?? 'RW',
    payout.currency,
    payout.amount,
    destination?.payout_provider ?? seller?.payout_provider ?? null,
  )

  let chosen = destination && destination.verified_at
    ? checks.find((c) => c.eligible && c.preferred)
    : undefined

  // Only now, and only if the primary produced nothing.
  if (!chosen && backupAllowed(db, payout)) {
    const backup = usableBackup(db, payout.seller_id)
    if (backup) {
      const alternative = routeEvaluation(
        db,
        payout.tenant_id,
        backup.country,
        payout.currency,
        payout.amount,
        backup.payout_provider,
      ).find((c) => c.eligible && c.preferred)

      if (alternative) {
        chosen = alternative
        destination = backup
        fallback = true
      }
    }
  }

  // §5.1's currency handling. A payout in the currency that was collected has
  // no rate to show; one that was converted names where the rate came from.
  const converted = deal ? deal.presentment_currency !== payout.currency : false
  const fxSource = !converted
    ? null
    : deal?.fx_rate != null
    ? 'deal_locked_rate' as const
    : 'payhold_indicative' as const

  const reason: RouteReasonCode = chosen
    ? 'routed'
    : !destination
    ? 'no_eligible_verified_destination'
    : !destination.verified_at
    ? 'destination_not_verified'
    : checks.find((c) => c.preferred)?.reason_code ?? 'no_route_for_destination'

  const previous = [...db.payout_decisions]
    .filter((d) => d.payout_id === payout.id)
    .pop()

  const unchanged = previous &&
    previous.reason_code === reason &&
    previous.destination_id === (destination?.id ?? null) &&
    previous.route_id === (chosen?.route_id ?? null)

  const decision: PayoutDecision = unchanged ? previous : {
    id: mintId(db, 'pd'),
    tenant_id: payout.tenant_id,
    payout_id: payout.id,
    route_id: chosen?.route_id ?? null,
    destination_id: destination?.id ?? null,
    provider: chosen?.provider ?? null,
    payout_provider: chosen?.payout_provider ?? null,
    method: chosen?.method ?? null,
    currency: payout.currency,
    amount: payout.amount,
    ranking_score: chosen?.rank ?? null,
    fee_estimate: chosen?.fee_estimate ?? null,
    fx_source: fxSource,
    fx_rate: fxSource ? deal?.fx_rate ?? null : null,
    is_fallback: fallback,
    reason_code: reason,
    checks,
    created_at: nowIso(),
  }

  if (!unchanged) db.payout_decisions.push(decision)

  if (!chosen) {
    // §5.1's no-route behaviour: keep the amount, say why, ask for a
    // destination. Nothing is discarded and nothing is rerouted.
    //
    // `failed` is left alone. A provider that refused a transfer is a more
    // specific fact than "no route", and it is what a retry reads.
    if (payout.status !== 'failed' && payout.status !== 'blocked') {
      payout.status = 'blocked'
      payout.failure_reason = routeReasonText(
        reason,
        destination?.payout_provider ?? seller?.payout_provider ?? 'flutterwave_momo',
        destination?.country ?? seller?.country ?? 'RW',
        payout.currency,
      )
    }

    audit(db, payout.tenant_id, payout.deal_id, 'system', 'payout.blocked', {
      payout_id: payout.id,
      reason_code: reason,
    })

    return decision
  }

  payout.destination_id = destination?.id ?? null
  if (payout.status === 'blocked') {
    // A route exists again, so whatever the engine last said no longer holds.
    payout.status = 'scheduled'
    payout.failure_reason = null
  }

  // §5.1: the seller must be notified when the backup is used, and the change
  // logged. Once — a later pass re-picking the same backup is not a new change.
  if (fallback && (!previous || !previous.is_fallback)) {
    audit(db, payout.tenant_id, payout.deal_id, 'system', 'payout.route_changed', {
      payout_id: payout.id,
      destination_id: destination?.id,
      masked_destination: destination?.masked_destination,
      reason: 'The primary destination failed; the verified backup was used',
    })
    emitWebhook(db, payout.tenant_id, 'payout.route_changed', payout.deal_id, {
      payout_id: payout.id,
      destination: destination?.masked_destination,
      payout_provider: destination?.payout_provider,
    })
  }

  return decision
}

// ---------------------------------------------------------------------------
// §5.1's status vocabulary, derived
// ---------------------------------------------------------------------------

/**
 * "Display `clearing`, `available`, `processing`, `paid`, `failed`, `blocked`
 * or `needs_verification`, with the reason and the next action."
 *
 * Two of those seven are not payout facts. A payout row exists in `scheduled`
 * from the moment of release, and whether that reads as `clearing` or
 * `available` is a question about the **deal's** window. Storing them on the
 * payout as well would be one fact with two writers.
 *
 * `frozen` and `held_for_review` both surface as `blocked`: to a seller they are
 * the same thing — stopped, and not their move. The operator's view reads
 * `payout.status`, which keeps every distinction.
 */
export function payoutDisplayStatus(db: MockDb, payout: Payout): PayoutDisplayStatus {
  switch (payout.status) {
    case 'paid':
    case 'processing':
    case 'failed':
    case 'needs_verification':
      return payout.status
    case 'blocked':
    case 'frozen':
    case 'held_for_review':
      return 'blocked'
  }

  return db.deals.find((d) => d.id === payout.deal_id)?.status === 'clearing'
    ? 'clearing'
    : 'available'
}

/** The routing decision behind a payout, newest first. */
export function latestDecision(
  db: MockDb,
  payoutId: string,
): PayoutDecision | null {
  return [...db.payout_decisions].filter((d) => d.payout_id === payoutId).pop() ?? null
}
