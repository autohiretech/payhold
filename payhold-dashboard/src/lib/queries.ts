/**
 * Shared query keys and hooks. Centralised so a mutation can invalidate the
 * right things without every screen guessing at key names.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  api,
  isSimulated,
  type DealListFilter,
  type WebhookDeliveryFilter,
} from '@/api'

export const keys = {
  tenant: ['tenant'] as const,
  balance: ['balance'] as const,
  deals: (filter?: DealListFilter) => ['deals', filter ?? {}] as const,
  deal: (id: string) => ['deal', id] as const,
  dealAmounts: (id: string) => ['deal-amounts', id] as const,
  refunds: (dealId?: string) => ['refunds', dealId ?? 'all'] as const,
  checkoutSessions: (dealId?: string) =>
    ['checkout-sessions', dealId ?? 'all'] as const,
  ledger: (dealId?: string) => ['ledger', dealId ?? 'all'] as const,
  payouts: ['payouts'] as const,
  payoutRoutes: ['payout-routes'] as const,
  payoutRouting: (id: string) => ['payout-routing', id] as const,
  disputes: ['disputes'] as const,
  disputeOffers: (disputeId: string) => ['dispute-offers', disputeId] as const,
  disputeTimeline: (disputeId: string) => ['dispute-timeline', disputeId] as const,
  sellers: ['sellers'] as const,
  sellerDestinations: (sellerId?: string) =>
    ['seller-destinations', sellerId ?? 'all'] as const,
  sellerCapabilities: (sellerId: string) =>
    ['seller-capabilities', sellerId] as const,
  settings: ['settings'] as const,
  apiKeys: ['api-keys'] as const,
  railStatus: ['rail-status'] as const,
  providerRequirements: ['provider-requirements'] as const,
  webhooks: ['webhook-endpoints'] as const,
  webhookDeliveries: (filter?: WebhookDeliveryFilter) =>
    ['webhook-deliveries', filter ?? {}] as const,
  riskSignals: (dealId?: string) => ['risk-signals', dealId ?? 'all'] as const,
  requestContext: (dealId?: string) => ['request-context', dealId ?? 'all'] as const,
  audit: (dealId?: string) => ['audit', dealId ?? 'all'] as const,
  aiSuggestions: (dealId?: string) => ['ai-suggestions', dealId ?? 'all'] as const,
  aiChat: ['ai-chat'] as const,
  aiUsage: ['ai-usage'] as const,
  dealOutcomes: ['deal-outcomes'] as const,
  tenants: ['admin', 'tenants'] as const,
  alerts: ['admin', 'alerts'] as const,
  reconciliationRuns: ['admin', 'reconciliation-runs'] as const,
}

export const useTenant = () =>
  useQuery({ queryKey: keys.tenant, queryFn: () => api.getTenant() })

export const useBalance = () =>
  useQuery({ queryKey: keys.balance, queryFn: () => api.getBalance() })

export const useDeals = (filter?: DealListFilter) =>
  useQuery({ queryKey: keys.deals(filter), queryFn: () => api.listDeals(filter) })

export const useDeal = (id: string) =>
  useQuery({ queryKey: keys.deal(id), queryFn: () => api.getDeal(id) })

/** §7's breakdown — what happened, as against what the deal's columns agreed. */
export const useDealAmounts = (id: string) =>
  useQuery({ queryKey: keys.dealAmounts(id), queryFn: () => api.getDealAmounts(id) })

export const useRefunds = (dealId?: string) =>
  useQuery({ queryKey: keys.refunds(dealId), queryFn: () => api.listRefunds(dealId) })

export const useCheckoutSessions = (dealId?: string) =>
  useQuery({
    queryKey: keys.checkoutSessions(dealId),
    queryFn: () => api.listCheckoutSessions(dealId),
  })

export const useSellers = () =>
  useQuery({ queryKey: keys.sellers, queryFn: () => api.listSellers() })

export const useSellerDestinations = (sellerId?: string) =>
  useQuery({
    queryKey: keys.sellerDestinations(sellerId),
    queryFn: () => api.listSellerDestinations(sellerId),
  })

/** §12's onboarding read: every reason at once, so nothing is fixed serially. */
export const useSellerCapabilities = (sellerId: string) =>
  useQuery({
    queryKey: keys.sellerCapabilities(sellerId),
    queryFn: () => api.getSellerCapabilities(sellerId),
    enabled: Boolean(sellerId),
  })

export const usePayouts = () =>
  useQuery({ queryKey: keys.payouts, queryFn: () => api.listPayouts() })

/** §5.1's routing table. Read-only: enablement is data an operator changes. */
export const usePayoutRoutes = () =>
  useQuery({ queryKey: keys.payoutRoutes, queryFn: () => api.listPayoutRoutes() })

export const useDisputes = () =>
  useQuery({ queryKey: keys.disputes, queryFn: () => api.listDisputes() })

/** §8's requests, oldest first. One may be open per order at a time. */
export const useDisputeOffers = (disputeId: string) =>
  useQuery({
    queryKey: keys.disputeOffers(disputeId),
    queryFn: () => api.listDisputeOffers(disputeId),
  })

/**
 * §8's timeline. Derived on every read rather than stored, so it is refetched
 * along with everything else a resolution touches rather than cached apart.
 */
export const useDisputeTimeline = (disputeId: string) =>
  useQuery({
    queryKey: keys.disputeTimeline(disputeId),
    queryFn: () => api.disputeTimeline(disputeId),
  })

export const useSettings = () =>
  useQuery({ queryKey: keys.settings, queryFn: () => api.getSettings() })

/** Which payment rails this company has actually connected. */
export const useRailStatus = () =>
  useQuery({ queryKey: keys.railStatus, queryFn: () => api.listRailStatus() })

/**
 * What each rail needs before it can be connected. Cached indefinitely — this
 * describes the providers, not the tenant, so it cannot go stale mid-session.
 */
export const useProviderRequirements = () =>
  useQuery({
    queryKey: keys.providerRequirements,
    queryFn: () => api.listProviderRequirements(),
    staleTime: Infinity,
  })

export const useLedger = (dealId?: string) =>
  useQuery({ queryKey: keys.ledger(dealId), queryFn: () => api.listLedger(dealId) })

export const useAudit = (dealId?: string) =>
  useQuery({ queryKey: keys.audit(dealId), queryFn: () => api.listAuditLog(dealId) })

export const useWebhookEndpoints = () =>
  useQuery({ queryKey: keys.webhooks, queryFn: () => api.listWebhookEndpoints() })

export const useWebhookDeliveries = (filter?: WebhookDeliveryFilter) =>
  useQuery({
    queryKey: keys.webhookDeliveries(filter),
    queryFn: () => api.listWebhookDeliveries(filter),
  })

/** What the deterministic rules noticed — advisory context, or a live hold. */
export const useRiskSignals = (dealId?: string) =>
  useQuery({
    queryKey: keys.riskSignals(dealId),
    queryFn: () => api.listRiskSignals(dealId),
  })

/** Where payments were made from — the observation behind a signal. */
export const useRequestContext = (dealId?: string) =>
  useQuery({
    queryKey: keys.requestContext(dealId),
    queryFn: () => api.listRequestContext(dealId),
  })

// -- Intelligence -----------------------------------------------------------

export const useAiSuggestions = (dealId?: string) =>
  useQuery({
    queryKey: keys.aiSuggestions(dealId),
    queryFn: () => api.listAiSuggestions(dealId),
  })

export const useAiChat = () =>
  useQuery({ queryKey: keys.aiChat, queryFn: () => api.listAiChat() })

export const useAiUsage = () =>
  useQuery({ queryKey: keys.aiUsage, queryFn: () => api.getAiUsage() })

export const useDealOutcomes = () =>
  useQuery({ queryKey: keys.dealOutcomes, queryFn: () => api.listDealOutcomes() })

/**
 * Drafting and chatting are not money moves, so they invalidate narrowly:
 * suggestions, the transcript and the spend meter, and nothing else. A screen
 * refreshing its deal list because someone asked a question would be a small
 * lie about what just happened.
 */
export function useAiMutation<TArgs, TResult>(fn: (args: TArgs) => Promise<TResult>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      // The bare prefix catches the per-deal keys as well as the all-deals one.
      qc.invalidateQueries({ queryKey: ['ai-suggestions'] })
      qc.invalidateQueries({ queryKey: keys.aiChat })
      qc.invalidateQueries({ queryKey: keys.aiUsage })
    },
  })
}

/** Same, for drafts that take no arguments. */
export function useAiAction<TResult>(fn: () => Promise<TResult>) {
  const qc = useQueryClient()
  return useMutation<TResult, Error, void>({
    mutationFn: fn,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ai-suggestions'] })
      qc.invalidateQueries({ queryKey: keys.aiUsage })
    },
  })
}

/**
 * Money moves touch several views at once — a release changes the deal, the
 * ledger, the balance, the payout queue and the audit trail. Rather than
 * enumerate that at each call site, any money mutation invalidates everything.
 * The mock is local and the real API will be small, so the cost is noise.
 */
export function useMoneyMutation<TArgs, TResult>(fn: (args: TArgs) => Promise<TResult>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: () => qc.invalidateQueries(),
  })
}

/** Same, for actions that take no arguments. */
export function useMoneyAction<TResult>(fn: () => Promise<TResult>) {
  const qc = useQueryClient()
  return useMutation<TResult, Error, void>({
    mutationFn: fn,
    onSuccess: () => qc.invalidateQueries(),
  })
}

/** The simulated clock, for relative timestamps that respect time travel. */
export function simNow(): Date {
  return isSimulated(api) ? api.sim.now() : new Date()
}
