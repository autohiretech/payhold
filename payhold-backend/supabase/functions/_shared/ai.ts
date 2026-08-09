/**
 * Availability, budget, provenance and the write of a suggestion — spec §12.
 *
 * The three drafting functions differ only in what they ask the model. What
 * they must all do identically is everything around that: refuse when the
 * tenant has the feature off or the budget spent, hash the exact case file,
 * serve an identical case file from cache rather than paying twice, and write
 * one `ai_suggestions` row plus one `audit_log` row.
 *
 * Doing it once here is not only about duplication. `assertAiAvailable` is the
 * §12.5 degrade path, and a degrade path that three functions implement
 * separately is a degrade path that two of them will eventually get wrong.
 */

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { aiConfigured, MODEL } from './anthropic.ts'
import { aiDbConfigured } from './ai-db.ts'
import { PayHoldError, type Money, type Timestamp } from './types.ts'

/** Defaults for a tenant who has never opened the Intelligence settings. */
const DEFAULTS = {
  ai_enabled: true,
  /** $25.00, USD minor units. */
  ai_monthly_budget_usd: 2_500,
  ai_dispute_assistant: true,
  ai_risk_narrator: true,
} as const

export type AiFeature = 'ai_dispute_assistant' | 'ai_risk_narrator'

export interface AiSettings {
  ai_enabled: boolean
  ai_monthly_budget_usd: Money
  ai_dispute_assistant: boolean
  ai_risk_narrator: boolean
}

export interface AiUsage extends AiSettings {
  /**
   * Can this deployment answer at all?
   *
   * That is `SUPABASE_JWT_SECRET` and nothing else. A missing model key is no
   * longer a blocker — `askClaude` serves `ai-demo.ts`'s stand-in — but the
   * `payhold_ai` role has no stand-in and must not get one: minting that token
   * is what keeps invariant 9 a grant list rather than a convention, and the
   * only "fallback" available would be the service role.
   *
   * Separate from `ai_enabled` for the reason `implemented` and `enabled` are
   * separate columns on `provider_capabilities`: the two fail differently and
   * have different remedies. A tenant switch is a field on the Settings screen;
   * an unset function secret is not, and a screen that offers the first as the
   * cure for the second sends somebody to toggle a switch that cannot help.
   */
  configured: boolean
  /**
   * True when there is no `ANTHROPIC_API_KEY` and answers come from the
   * stand-in. Drafts work; they are a fixed rule over the case file rather than
   * a model's reading of it, and every screen showing one has to say so.
   */
  demo: boolean
  enabled: boolean
  spend_usd: Money
  budget_usd: Money
  over_budget: boolean
  suggestions_this_month: number
  labelled_outcomes: number
}

/**
 * The AI half of `settings`, read the same key/value way as the money half.
 *
 * Separate from `loadSettings` on purpose: nothing on a money path should have
 * a reason to load these, and keeping them apart makes that visible in the
 * import list of any file that does.
 */
export async function loadAiSettings(
  db: SupabaseClient,
  tenantId: string,
): Promise<AiSettings> {
  const { data } = await db
    .from('settings')
    .select('key, value')
    .eq('tenant_id', tenantId)
    .in('key', [
      'ai_enabled',
      'ai_monthly_budget_usd',
      'ai_dispute_assistant',
      'ai_risk_narrator',
    ])

  const raw = new Map((data ?? []).map((row) => [row.key as string, row.value]))

  const flag = (key: keyof AiSettings, fallback: boolean): boolean => {
    const value = raw.get(key)
    if (value === undefined || value === null) return fallback
    return value !== false && value !== 0 && value !== 'false'
  }

  const budget = Number(raw.get('ai_monthly_budget_usd'))

  return {
    ai_enabled: flag('ai_enabled', DEFAULTS.ai_enabled),
    ai_monthly_budget_usd: Number.isFinite(budget) && budget >= 0
      ? Math.round(budget)
      : DEFAULTS.ai_monthly_budget_usd,
    ai_dispute_assistant: flag('ai_dispute_assistant', DEFAULTS.ai_dispute_assistant),
    ai_risk_narrator: flag('ai_risk_narrator', DEFAULTS.ai_risk_narrator),
  }
}

/** Spend against budget, and how much labelled history has accumulated. */
export async function aiUsage(
  db: SupabaseClient,
  tenantId: string,
): Promise<AiUsage> {
  const settings = await loadAiSettings(db, tenantId)

  const { data: spendData } = await db.rpc('ai_monthly_spend', { p_tenant: tenantId })
  const spend = Number(spendData ?? 0)

  const monthStart = new Date()
  monthStart.setUTCDate(1)
  monthStart.setUTCHours(0, 0, 0, 0)

  const { count: suggestions } = await db
    .from('ai_suggestions')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .gte('created_at', monthStart.toISOString())

  const { count: outcomes } = await db
    .from('deal_outcomes')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)

  const configured = aiDbConfigured()

  return {
    ...settings,
    configured,
    demo: !aiConfigured(),
    // "Enabled" to a caller means the whole path works, not just that a switch
    // is on. A tenant with the feature switched on, on a deployment that cannot
    // mint a `payhold_ai` token, is not enabled in any sense a dashboard should
    // show as green.
    enabled: settings.ai_enabled && configured,
    spend_usd: spend,
    budget_usd: settings.ai_monthly_budget_usd,
    over_budget: spend >= settings.ai_monthly_budget_usd,
    suggestions_this_month: suggestions ?? 0,
    labelled_outcomes: outcomes ?? 0,
  }
}

/**
 * The degrade path of §12.5.
 *
 * Note what it does *not* do: it refuses the AI call and nothing else. No money
 * path calls this function, so a tenant with Intelligence switched off — or one
 * that has burned its monthly budget — releases, refunds and pays out exactly
 * as before. That is the whole claim of §12.5, and this is the function that
 * has to keep it.
 */
export async function assertAiAvailable(
  db: SupabaseClient,
  tenantId: string,
  feature?: AiFeature,
): Promise<AiUsage> {
  // A missing model key is *not* checked here any more: `askClaude` answers
  // from the stand-in, which is what makes §12 demonstrable with zero keys. A
  // missing `SUPABASE_JWT_SECRET` still refuses, and always will — there is no
  // stand-in for a Postgres role, and the only fallback on offer would be the
  // service role, which is precisely what invariant 9 exists to deny this path.
  if (!aiDbConfigured()) {
    throw new PayHoldError(
      'policy_violation',
      'Intelligence cannot run on this deployment: SUPABASE_JWT_SECRET is not ' +
        'set, so the read-only AI role cannot be reached. Money paths are unaffected.',
    )
  }

  const usage = await aiUsage(db, tenantId)

  if (!usage.ai_enabled) {
    throw new PayHoldError(
      'policy_violation',
      'Intelligence is switched off for this company. Money paths are unaffected.',
    )
  }

  if (feature && !usage[feature]) {
    throw new PayHoldError(
      'policy_violation',
      'That assistant is switched off for this company. Money paths are unaffected.',
    )
  }

  if (usage.over_budget) {
    throw new PayHoldError(
      'policy_violation',
      "This month's AI budget is spent. Drafts resume next month, or raise the " +
        'budget in Settings. Money paths are unaffected.',
    )
  }

  return usage
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

/**
 * Hash exactly what the model was shown.
 *
 * SHA-256 over the canonical JSON of the case file. Two things depend on it
 * being over the *whole* file and nothing else: a decision an auditor cannot
 * reproduce is not auditable, and the cache below is only safe if an identical
 * hash means an identical question.
 */
export async function inputHash(payload: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(payload))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export interface StoredSuggestion {
  id: string
  tenant_id: string
  deal_id: string
  kind: 'dispute_resolution' | 'risk_summary'
  model: string
  prompt_version: string
  input_hash: string
  output: Record<string, unknown>
  cost_usd: Money
  created_at: Timestamp
  decision: 'approved' | 'rejected' | null
  decided_by: string | null
  decided_at: Timestamp | null
}

export const SUGGESTION_COLUMNS =
  'id, tenant_id, deal_id, kind, model, prompt_version, input_hash, output, ' +
  'cost_usd, created_at, decision, decided_by, decided_at'

/** How long an identical case file may be answered from an existing draft. */
const CACHE_TTL_MINUTES = 30

/**
 * An undecided draft for the same case file, if there is one.
 *
 * Cheap, but that is the smaller half of the reason. Pressing Draft twice
 * should not produce two cards in the queue that a person then has to reconcile
 * — and if the two drafts disagreed, which they can, the queue would be showing
 * a contradiction nobody introduced.
 *
 * Only *undecided* drafts are reused. Once someone has ruled on a draft the
 * next request is a genuinely new question, whatever the inputs say.
 */
export async function cachedSuggestion(
  db: SupabaseClient,
  tenantId: string,
  kind: StoredSuggestion['kind'],
  hash: string,
): Promise<StoredSuggestion | null> {
  const since = new Date(Date.now() - CACHE_TTL_MINUTES * 60_000).toISOString()

  const { data } = await db
    .from('ai_suggestions')
    .select(SUGGESTION_COLUMNS)
    .eq('tenant_id', tenantId)
    .eq('kind', kind)
    .eq('input_hash', hash)
    .is('decision', null)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  return (data as StoredSuggestion | null) ?? null
}

/**
 * Write the draft down.
 *
 * This is the only insert an AI code path performs, and the role it runs as can
 * do nothing else — see `ai-db.ts`. The audit row is written from the same
 * client, with the model as the actor, because "the model drafted this" and "a
 * person approved it" are two different events and the trail should read that
 * way.
 */
export async function recordSuggestion(
  db: SupabaseClient,
  args: {
    tenant_id: string
    deal_id: string
    kind: StoredSuggestion['kind']
    prompt_version: string
    input_hash: string
    output: Record<string, unknown>
    cost_usd: Money
    model?: string
  },
): Promise<StoredSuggestion> {
  const { data, error } = await db
    .from('ai_suggestions')
    .insert({
      tenant_id: args.tenant_id,
      deal_id: args.deal_id,
      kind: args.kind,
      model: args.model ?? MODEL,
      prompt_version: args.prompt_version,
      input_hash: args.input_hash,
      output: args.output,
      cost_usd: args.cost_usd,
    })
    .select(SUGGESTION_COLUMNS)
    .single()

  if (error || !data) {
    throw new PayHoldError(
      'policy_violation',
      `Could not save that draft: ${error?.message ?? 'unknown error'}`,
    )
  }

  await db.from('audit_log').insert({
    tenant_id: args.tenant_id,
    deal_id: args.deal_id,
    actor: `ai:${args.model ?? MODEL}`,
    action: 'ai.suggestion_drafted',
    details: {
      suggestion_id: (data as unknown as StoredSuggestion).id,
      kind: args.kind,
      prompt_version: args.prompt_version,
      input_hash: args.input_hash,
      cost_usd: args.cost_usd,
    },
  })

  return data as unknown as StoredSuggestion
}
