/**
 * The capability matrix, read — §9 and §12.
 *
 * Two questions live in rows rather than in code, and they are different
 * questions asked by different people:
 *
 *   **Is this adapter live?**  `provider_capabilities`. An outage or a
 *   commercial decision, and it disables exactly that provider's routes.
 *
 *   **Is this market open?**   `payment_markets`. §12 requires a country to be
 *   disabled without a redeploy, and this is the switch.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * What did **not** move, and why (spec §29.11).
 *
 * The country registry stays generated. `countries.ts` records which currency a
 * market uses, which wallets exist there, whether Stripe can pay into it — all
 * transcribed from provider documentation by one generator into two repos.
 * Copying that into SQL would give it a second home that drifts the first time
 * somebody edits one and not the other, which is the failure the generator
 * exists to prevent.
 *
 * So: **the registry says what is possible, the matrix says what is on.**
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'
import type { Country, Provider } from './types.ts'

export interface MarketClosure {
  country: Country
  collect: boolean
  payout: boolean
  reason: string
}

/**
 * Every market closure that applies to this tenant, its own and the platform's.
 *
 * A set of closures rather than a per-country question, because the catalogue
 * answers "which markets are open" for every country at once and 55 round trips
 * would be a query per row of a page nobody paginates.
 */
export async function closedMarkets(
  db: SupabaseClient,
  tenantId: string,
): Promise<Map<Country, MarketClosure>> {
  const { data } = await db.rpc('closed_markets', { p_tenant: tenantId })

  return new Map(
    ((data ?? []) as MarketClosure[]).map((row) => [row.country, row]),
  )
}

/**
 * The adapters that are built and switched on right now.
 *
 * A missing row means live: `provider_capabilities` is authoritative for the
 * adapters it names, and a rail nobody has ruled on is not switched off. The
 * same overlay reasoning as `market_open`.
 */
export async function liveProviders(db: SupabaseClient): Promise<Set<Provider>> {
  const { data } = await db
    .from('provider_capabilities')
    .select('provider, implemented, enabled')

  const rows = (data ?? []) as {
    provider: Provider
    implemented: boolean
    enabled: boolean
  }[]

  return new Set(
    rows.filter((r) => r.implemented && r.enabled).map((r) => r.provider),
  )
}
