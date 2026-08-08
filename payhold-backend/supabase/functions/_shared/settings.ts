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
import { PayHoldError, type Currency, type Money } from './types.ts'

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

/**
 * The whole settings surface, which is what the dashboard reads and writes.
 *
 * `Settings` above is the money path's narrow view of the same rows — the
 * handful of values a charge or a release needs. Both come from one spec below,
 * so a default cannot be right in one and stale in the other.
 */
export interface FullSettings extends Settings {
  /** §6.1's new-seller reserve. Zero rate means off, which is the default. */
  reserve_rate: number
  reserve_days: number
  reserve_after_payouts: number
  ai_enabled: boolean
  ai_monthly_budget_usd: Money
  ai_dispute_assistant: boolean
  ai_risk_narrator: boolean
  /** §5.1's routing policy for the seller's verified backup destination. */
  payout_backup_enabled: boolean
  payout_primary_attempts: number
  /** §13's budget before a refused payout stops being retried automatically. */
  payout_retry_max_attempts: number
  /** `wallet` stops the cron sending cleared money nobody has asked for. */
  payout_mode: 'auto' | 'wallet'
  /** §5.1's change protection: how long a moved destination holds a payout. */
  destination_hold_hours: number
  sanctions_max_age_days: number
}

type Kind = 'rate' | 'money' | 'count' | 'flag' | 'currencies' | 'payout_mode'

interface Spec {
  kind: Kind
  /** What a tenant with no row behaves like. */
  fallback: number | boolean | string | Currency[]
  min?: number
  max?: number
}

/**
 * Every setting, its shape and its default.
 *
 * **The defaults here must match the ones SQL passes to `setting_num` and
 * `setting_text`.** Both sides read the same rows and neither can call the
 * other: the money functions resolve a setting inside the transaction that
 * spends it, and this file resolves one to render a form. Where they disagree,
 * SQL is the authority — it is the copy money is actually moved on — so a
 * change here is a change in the migration that reads the same key.
 *
 * **A flag is stored as 1 or 0, never as a JSON boolean.** `setting_num` casts
 * `value #>> '{}'` to numeric, so a literal `false` in this table makes every
 * money function that reads that key fail on the cast rather than fall back.
 * `encode` below is the single place that is enforced.
 */
const SPEC: Record<keyof Omit<FullSettings, 'tenant_id'>, Spec> = {
  service_fee_rate: { kind: 'rate', fallback: 0.1, min: 0, max: 0.5 },
  buyer_fee: { kind: 'money', fallback: 0, min: 0 },
  // 14, not V1's 7 — spec §6.1 and §29.7, and what every SQL reader passes.
  clearance_days: { kind: 'count', fallback: 14, min: 0, max: 180 },
  auto_release_days: { kind: 'count', fallback: 3, min: 0, max: 180 },
  reserve_rate: { kind: 'rate', fallback: 0, min: 0, max: 0.5 },
  reserve_days: { kind: 'count', fallback: 30, min: 0, max: 365 },
  reserve_after_payouts: { kind: 'count', fallback: 3, min: 0, max: 100 },
  currencies: { kind: 'currencies', fallback: [] },
  ai_enabled: { kind: 'flag', fallback: true },
  ai_monthly_budget_usd: { kind: 'money', fallback: 2_500, min: 0 },
  ai_dispute_assistant: { kind: 'flag', fallback: true },
  ai_risk_narrator: { kind: 'flag', fallback: true },
  risk_rules_enabled: { kind: 'flag', fallback: true },
  risk_review_threshold_usd: { kind: 'money', fallback: 100_000, min: 0 },
  payout_backup_enabled: { kind: 'flag', fallback: true },
  payout_primary_attempts: { kind: 'count', fallback: 2, min: 1, max: 20 },
  // Floor 1: a budget of zero would block every payout on the first transient
  // error a rail has.
  payout_retry_max_attempts: { kind: 'count', fallback: 5, min: 1, max: 20 },
  payout_mode: { kind: 'payout_mode', fallback: 'auto' },
  destination_hold_hours: { kind: 'count', fallback: 24, min: 0, max: 720 },
  sanctions_max_age_days: { kind: 'count', fallback: 365, min: 1, max: 3_650 },
  checkout_session_hours: { kind: 'count', fallback: 24, min: 1, max: 720 },
}

type Key = keyof typeof SPEC

/** Read one stored value back into the shape the spec says it has. */
function decode(key: Key, raw: unknown): unknown {
  const spec = SPEC[key]
  if (raw === undefined || raw === null) return spec.fallback

  switch (spec.kind) {
    case 'flag':
      // Tolerant on the way in, strict on the way out: rows predating `encode`
      // may hold a JSON boolean, and refusing to render one would make a
      // settings screen unopenable over a value nothing else reads.
      return raw !== false && raw !== 0 && raw !== '0' && raw !== 'false'
    case 'currencies':
      return Array.isArray(raw) ? raw as Currency[] : spec.fallback
    case 'payout_mode':
      return raw === 'wallet' ? 'wallet' : 'auto'
    default: {
      const value = Number(raw)
      if (!Number.isFinite(value)) return spec.fallback
      return spec.kind === 'rate' ? value : Math.round(value)
    }
  }
}

/** Validate a submitted value and turn it into what goes in the jsonb column. */
function encode(key: Key, value: unknown): number | string | Currency[] {
  const spec = SPEC[key]

  const refuse = (why: string): never => {
    throw new PayHoldError('policy_violation', `${key}: ${why}`)
  }

  switch (spec.kind) {
    case 'flag':
      if (typeof value !== 'boolean') refuse('must be true or false')
      // Numeric, not boolean — see the note on SPEC.
      return value ? 1 : 0

    case 'currencies': {
      if (!Array.isArray(value) || value.some((c) => typeof c !== 'string')) {
        refuse('must be a list of currency codes')
      }
      return (value as string[]).map((c) => c.toUpperCase()) as Currency[]
    }

    case 'payout_mode':
      if (value !== 'auto' && value !== 'wallet') refuse('must be "auto" or "wallet"')
      return value as string

    default: {
      const num = Number(value)
      if (typeof value === 'boolean' || !Number.isFinite(num)) refuse('must be a number')
      if (spec.min !== undefined && num < spec.min) refuse(`cannot be below ${spec.min}`)
      if (spec.max !== undefined && num > spec.max) refuse(`cannot be above ${spec.max}`)
      return spec.kind === 'rate' ? num : Math.round(num)
    }
  }
}

async function rows(
  db: SupabaseClient,
  tenantId: string,
): Promise<Map<string, unknown>> {
  const { data } = await db
    .from('settings')
    .select('key, value')
    .eq('tenant_id', tenantId)

  return new Map((data ?? []).map((row) => [row.key as string, row.value]))
}

function assemble(tenantId: string, raw: Map<string, unknown>): FullSettings {
  const out = { tenant_id: tenantId } as Record<string, unknown>
  for (const key of Object.keys(SPEC) as Key[]) {
    out[key] = decode(key, raw.get(key))
  }
  return out as unknown as FullSettings
}

/** Everything, for the settings screen and `GET /v1/settings`. */
export async function readSettings(
  db: SupabaseClient,
  tenantId: string,
): Promise<FullSettings> {
  return assemble(tenantId, await rows(db, tenantId))
}

/**
 * Apply a patch and hand back the whole record.
 *
 * Unknown keys are refused rather than ignored. A settings screen that could
 * write anything would let a typo sit in the table looking like a setting,
 * and the money function reading the correctly-spelled key would go on using
 * its default with nobody the wiser.
 */
export async function writeSettings(
  db: SupabaseClient,
  tenantId: string,
  patch: Record<string, unknown>,
): Promise<{ settings: FullSettings; changed: string[] }> {
  const updates: { tenant_id: string; key: string; value: unknown; updated_at: string }[] = []
  const now = new Date().toISOString()

  for (const [key, value] of Object.entries(patch)) {
    if (key === 'tenant_id') continue
    if (!(key in SPEC)) {
      throw new PayHoldError('policy_violation', `Unknown setting "${key}"`)
    }
    if (value === undefined) continue

    updates.push({
      tenant_id: tenantId,
      key,
      value: encode(key as Key, value),
      updated_at: now,
    })
  }

  if (updates.length > 0) {
    const { error } = await db.from('settings').upsert(updates, {
      onConflict: 'tenant_id,key',
    })
    if (error) {
      console.error('settings write failed', { message: error.message })
      throw new PayHoldError('policy_violation', 'Could not save those settings')
    }
  }

  return {
    settings: await readSettings(db, tenantId),
    changed: updates.map((u) => u.key),
  }
}

export async function loadSettings(
  db: SupabaseClient,
  tenantId: string,
): Promise<Settings> {
  const {
    tenant_id,
    service_fee_rate,
    buyer_fee,
    clearance_days,
    auto_release_days,
    currencies,
    risk_rules_enabled,
    risk_review_threshold_usd,
    checkout_session_hours,
  } = await readSettings(db, tenantId)

  return {
    tenant_id,
    service_fee_rate,
    buyer_fee,
    clearance_days,
    auto_release_days,
    currencies,
    risk_rules_enabled,
    risk_review_threshold_usd,
    checkout_session_hours,
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
