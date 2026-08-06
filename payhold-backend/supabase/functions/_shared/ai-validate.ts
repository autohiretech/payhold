/**
 * Checking the model's answer before anything is written down.
 *
 * Structured outputs already constrain the shape, so the schema is not what
 * these functions are for. They exist for the one thing a schema cannot check:
 * whether the citations point at events that actually happened.
 *
 * A fabricated reference is the failure that most resembles grounding while
 * being its opposite — a card that looks checkable, with a link that goes
 * nowhere. So every citation is intersected with the timeline the model was
 * given, and anything that does not match is dropped rather than shown. An
 * uncited rationale is honest. An uncheckable one is not.
 *
 * Separated from the Edge Functions so they can be tested without standing up
 * a server, because this is the logic most worth a test.
 */

import { PayHoldError } from './types.ts'

export interface Citation {
  ref: string
  at: string
  label: string
}

export interface DisputeDraft {
  kind: 'dispute_resolution'
  recommendation: 'release' | 'refund' | 'escalate'
  headline: string
  rationale: string[]
  cited: Citation[]
  confidence: number
}

export interface RiskBrief {
  kind: 'risk_summary'
  headline: string
  points: string[]
  flags: string[]
  cited: Citation[]
  confidence: number
}

const RECOMMENDATIONS = ['release', 'refund', 'escalate'] as const

function strings(value: unknown): string[] {
  return (Array.isArray(value) ? value : []).filter(
    (v): v is string => typeof v === 'string',
  )
}

/** Keep only citations that resolve to an event the model was actually shown. */
function resolvable(value: unknown, validRefs: Set<string>): Citation[] {
  return (Array.isArray(value) ? value : []).filter(
    (c): c is Citation =>
      Boolean(c) &&
      typeof c.ref === 'string' &&
      typeof c.at === 'string' &&
      typeof c.label === 'string' &&
      validRefs.has(c.ref),
  )
}

/** 0–1. Advisory, and deliberately not a threshold anything acts on. */
function confidence(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : 0.5
}

export function validateDisputeDraft(
  value: unknown,
  validRefs: Set<string>,
): DisputeDraft {
  const v = value as Partial<DisputeDraft>

  if (
    !RECOMMENDATIONS.includes(v.recommendation as typeof RECOMMENDATIONS[number]) ||
    typeof v.headline !== 'string' ||
    v.headline.trim() === '' ||
    !Array.isArray(v.rationale)
  ) {
    throw new PayHoldError('policy_violation', 'The model returned an unusable draft.')
  }

  return {
    kind: 'dispute_resolution',
    recommendation: v.recommendation!,
    headline: v.headline,
    rationale: strings(v.rationale),
    cited: resolvable(v.cited, validRefs),
    confidence: confidence(v.confidence),
  }
}

export function validateRiskBrief(value: unknown, validRefs: Set<string>): RiskBrief {
  const v = value as Partial<RiskBrief>

  if (
    typeof v.headline !== 'string' ||
    v.headline.trim() === '' ||
    !Array.isArray(v.points)
  ) {
    throw new PayHoldError('policy_violation', 'The model returned an unusable brief.')
  }

  return {
    kind: 'risk_summary',
    headline: v.headline,
    points: strings(v.points),
    flags: strings(v.flags),
    cited: resolvable(v.cited, validRefs),
    confidence: confidence(v.confidence),
  }
}
