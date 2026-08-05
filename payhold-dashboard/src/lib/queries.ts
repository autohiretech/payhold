/**
 * Shared query keys and hooks. Centralised so a mutation can invalidate the
 * right things without every screen guessing at key names.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, isSimulated, type DealListFilter } from '@/api'

export const keys = {
  tenant: ['tenant'] as const,
  balance: ['balance'] as const,
  deals: (filter?: DealListFilter) => ['deals', filter ?? {}] as const,
  deal: (id: string) => ['deal', id] as const,
  ledger: (dealId?: string) => ['ledger', dealId ?? 'all'] as const,
  payouts: ['payouts'] as const,
  disputes: ['disputes'] as const,
  sellers: ['sellers'] as const,
  settings: ['settings'] as const,
  apiKeys: ['api-keys'] as const,
  webhooks: ['webhook-endpoints'] as const,
  audit: (dealId?: string) => ['audit', dealId ?? 'all'] as const,
  tenants: ['admin', 'tenants'] as const,
  alerts: ['admin', 'alerts'] as const,
}

export const useTenant = () =>
  useQuery({ queryKey: keys.tenant, queryFn: () => api.getTenant() })

export const useBalance = () =>
  useQuery({ queryKey: keys.balance, queryFn: () => api.getBalance() })

export const useDeals = (filter?: DealListFilter) =>
  useQuery({ queryKey: keys.deals(filter), queryFn: () => api.listDeals(filter) })

export const useDeal = (id: string) =>
  useQuery({ queryKey: keys.deal(id), queryFn: () => api.getDeal(id) })

export const useSellers = () =>
  useQuery({ queryKey: keys.sellers, queryFn: () => api.listSellers() })

export const usePayouts = () =>
  useQuery({ queryKey: keys.payouts, queryFn: () => api.listPayouts() })

export const useDisputes = () =>
  useQuery({ queryKey: keys.disputes, queryFn: () => api.listDisputes() })

export const useSettings = () =>
  useQuery({ queryKey: keys.settings, queryFn: () => api.getSettings() })

export const useLedger = (dealId?: string) =>
  useQuery({ queryKey: keys.ledger(dealId), queryFn: () => api.listLedger(dealId) })

export const useAudit = (dealId?: string) =>
  useQuery({ queryKey: keys.audit(dealId), queryFn: () => api.listAuditLog(dealId) })

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
