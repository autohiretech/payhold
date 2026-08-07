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
  recommendation: 'release' | 'refund' | 'partial_refund' | 'escalate'
  headline: string
  rationale: string[]
  cited: Citation[]
  confidence: number
  /**
   * §7.1. Present only on `partial_refund`, in minor units of the currency the
   * buyer was charged. Validated here and again by `resolve_dispute`, which
   * refuses a null or whole-payment amount — a model that names a figure the
   * engine cannot carry out has drafted something nobody can approve.
   */
  refund_amount?: number
}

export interface RiskBrief {
  kind: 'risk_summary'
  headline: string
  points: string[]
  flags: string[]
  cited: Citation[]
  confidence: number
}

const RECOMMENDATIONS = ['release', 'refund', 'partial_refund', 'escalate'] as const

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
  /**
   * What the buyer paid, in presentment minor units. A `partial_refund` naming
   * more than this — or the whole of it — is not a split, and is discarded
   * rather than shown: §24.5 says invalid output is logged and never rendered.
   */
  refundable?: number,
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

  let refundAmount: number | undefined

  if (v.recommendation === 'partial_refund') {
    const amount = v.refund_amount

    if (
      typeof amount !== 'number' ||
      !Number.isInteger(amount) ||
      amount <= 0 ||
      (refundable !== undefined && amount >= refundable)
    ) {
      throw new PayHoldError(
        'policy_violation',
        'The model recommended a split without a usable amount.',
      )
    }
    refundAmount = amount
  }

  return {
    kind: 'dispute_resolution',
    recommendation: v.recommendation!,
    headline: v.headline,
    rationale: strings(v.rationale),
    cited: resolvable(v.cited, validRefs),
    confidence: confidence(v.confidence),
    ...(refundAmount !== undefined ? { refund_amount: refundAmount } : {}),
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
