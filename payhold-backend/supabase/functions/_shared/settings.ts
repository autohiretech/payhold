/**
 * Per-tenant settings — spec §8.
 *
 * Stored as key/value jsonb so adding a setting never needs a migration, which
 * is what keeps §11.4's promise that fee and timer changes are a dashboard
 * edit rather than a deploy.
 *
 * A tenant with no row behaves like the documented defaults. That matters more
 * than it looks: a fresh tenant must be able to run a whole deal before anyone
 * has visited the settings screen.
 *
 * **In-flight deals keep the settings they were created with.** The fee is
 * computed once at creation and stored on the deal; the clearance and
 * auto-release windows are resolved into timestamps at the moment they start
 * running. Nothing re-reads this table to decide something about a deal that
 * already exists — otherwise changing a fee would silently reprice money
 * already collected.
 */

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { DEFAULT_SETTINGS, type Currency, type Money } from './types.ts'

export interface Settings {
  tenant_id: string
  service_fee_rate: number
  buyer_fee: Money
  clearance_days: number
  auto_release_days: number
  /** Empty means "no restriction recorded" — validated against the rails. */
  currencies: Currency[]
  risk_rules_enabled: boolean
  risk_review_threshold_usd: Money
  /**
   * How long a hosted checkout link lives (§10.1). Short enough that a stale
   * link in an inbox is not a live payment page; long enough that a buyer who
   * opens it the next morning is not sent back to the client.
   */
  checkout_session_hours: number
}

const DEFAULT_RISK_THRESHOLD_USD = 100_000

export async function loadSettings(
  db: SupabaseClient,
  tenantId: string,
): Promise<Settings> {
  const { data } = await db
    .from('settings')
    .select('key, value')
    .eq('tenant_id', tenantId)

  const raw = new Map((data ?? []).map((row) => [row.key as string, row.value]))

  const num = (key: string, fallback: number): number => {
    const value = Number(raw.get(key))
    return Number.isFinite(value) ? value : fallback
  }

  return {
    tenant_id: tenantId,
    service_fee_rate: num('service_fee_rate', DEFAULT_SETTINGS.service_fee_rate),
    buyer_fee: Math.round(num('buyer_fee', DEFAULT_SETTINGS.buyer_fee)),
    clearance_days: num('clearance_days', DEFAULT_SETTINGS.clearance_days),
    auto_release_days: num('auto_release_days', DEFAULT_SETTINGS.auto_release_days),
    currencies: Array.isArray(raw.get('currencies')) ? raw.get('currencies') : [],
    // Absent means on. A tenant who has never opened the settings screen still
    // gets the fraud controls; they have to switch them off deliberately.
    risk_rules_enabled: num('risk_rules_enabled', 1) !== 0,
    risk_review_threshold_usd: Math.round(
      num('risk_review_threshold_usd', DEFAULT_RISK_THRESHOLD_USD),
    ),
    checkout_session_hours: Math.round(num('checkout_session_hours', 24)),
  }
}

/**
 * What PayHold takes from a deal, in the settlement currency.
 *
 * Rounded to whole minor units — a fraction of a centime cannot be moved, and
 * carrying one would put the ledger permanently a rounding error away from the
 * provider's balance.
 */
export function feeFor(amount: Money, settings: Settings): Money {
  return Math.round(amount * settings.service_fee_rate)
}
