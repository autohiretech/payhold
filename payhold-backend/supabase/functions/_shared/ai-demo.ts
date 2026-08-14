/**
 * The stand-in the Intelligence layer answers with when no model key is set.
 *
 * This is `FakeProvider`'s counterpart for §12, and it exists for the same
 * reason: **demo mode with zero keys must work end to end.** A deployment
 * without an `ANTHROPIC_API_KEY` used to refuse every draft, which meant the
 * whole of §12 — the queue, the provenance panel, the approval that is the one
 * bridge from a suggestion to `resolve_dispute` — could not be exercised or
 * demonstrated at all.
 *
 * What it fakes is **the model and nothing else**, exactly as `FakeProvider`
 * fakes the counterparty and nothing else:
 *
 *   * The answer is built from the real case file the endpoint already
 *     assembled, so a demo draft cites this account's own events and quotes
 *     this account's own figures. A canned draft about an invented deal would
 *     demonstrate the screen and not the system.
 *   * It goes through the **same validator** as a model answer, so a demo
 *     citation that did not resolve would be dropped by `resolvable` exactly as
 *     a hallucinated one is, and a demo split that broke §7.1's ceiling would
 *     be refused exactly as the model's would.
 *   * It is written to `ai_suggestions` with `model = 'demo-stand-in'` and
 *     `cost_usd = 0`, so no row ever claims a model produced it. That column is
 *     what keeps §24.4's eventual training set filterable — canned rows mixed
 *     indistinguishably into it would poison a corpus that cannot be rebuilt.
 *   * **Invariant 9 is untouched.** It advises. A named person still approves,
 *     `decide_ai_suggestion` is still the only bridge across, and this module
 *     has no database handle and no execute on anything.
 *
 * The recommendation comes from a stated, mechanical rule and every answer says
 * so in its own headline. A stand-in has no judgement, and a demo draft that
 * read like considered advice would be the one genuinely dangerous thing this
 * file could do.
 */

import type { DisputeCaseFile, RiskCaseFile, TimelineEvent } from './ai-context.ts'

/**
 * Recorded in `ai_suggestions.model`. Deliberately not a model name and
 * deliberately not null: "which model said this" must always have an answer,
 * and for these rows the answer is that none did.
 */
export const DEMO_MODEL = 'demo-stand-in'

/** The sentence every demo answer opens with. Nobody should have to infer it. */
const PREAMBLE =
  'Demo stand-in — no model was consulted. This deployment has no model key, ' +
  'so PayHold answered from a fixed rule over the case file. Treat it as a ' +
  'check that the wiring works, not as advice.'

/** The first few real events, so a demo card's citations resolve. */
function cite(timeline: TimelineEvent[], limit = 3) {
  return timeline.slice(0, limit).map((e) => ({
    ref: e.ref,
    at: e.at,
    label: e.action,
  }))
}

function money(amount: number, currency: string): string {
  return `${currency} ${(amount / 100).toFixed(2)}`
}

/**
 * §8's draft, from a rule an administrator can check in one reading.
 *
 * Evidence is the only input, because it is the only one where "who filed
 * something" is a fact rather than a judgement. Where both sides filed, or
 * neither did, the answer is `escalate` — which is the honest output of a rule
 * that cannot weigh anything, and is what §29's `escalate` means: no split
 * resolves this either.
 *
 * The partial branch respects both ceilings that would otherwise make the draft
 * unapprovable: `validateDisputeDraft` discards a split at or above what the
 * buyer paid, and `resolve_dispute` refuses a full refund when only part was
 * ever in dispute.
 */
export function demoDisputeDraft(file: DisputeCaseFile): Record<string, unknown> {
  const buyerFiled = file.evidence.filter((e) => e.uploaded_by === 'buyer').length
  const sellerFiled = file.evidence.filter((e) => e.uploaded_by === 'seller').length

  const paid = file.deal.presentment_amount
  const disputed = file.dispute.disputed_amount
  const partial =
    typeof disputed === 'number' &&
    Number.isInteger(disputed) &&
    disputed > 0 &&
    disputed < paid

  const lean = buyerFiled > 0 && sellerFiled === 0
    ? 'buyer'
    : sellerFiled > 0 && buyerFiled === 0
    ? 'seller'
    : null

  const recommendation = lean === null
    ? 'escalate'
    : lean === 'seller'
    ? 'release'
    : partial
    ? 'partial_refund'
    : 'refund'

  const rule = lean === null
    ? buyerFiled === 0 && sellerFiled === 0
      ? 'Neither side has filed evidence, so the rule has nothing to go on.'
      : 'Both sides have filed evidence, and weighing them against each other ' +
        'is the judgement a rule cannot make.'
    : lean === 'seller'
    ? 'Only the seller has filed evidence, so the rule leans to releasing the hold.'
    : partial
    ? 'Only the buyer has filed evidence, and only part of the payment was ' +
      'disputed, so the rule leans to refunding exactly that part.'
    : 'Only the buyer has filed evidence, and the whole payment was disputed, ' +
      'so the rule leans to a full refund.'

  return {
    recommendation,
    headline: `${PREAMBLE.split(' — ')[0]}: ${
      recommendation === 'escalate'
        ? 'this one needs a person'
        : `the rule points at ${recommendation.replace('_', ' ')}`
    }`,
    rationale: [
      PREAMBLE,
      rule,
      `Evidence on file: ${buyerFiled} from the buyer, ${sellerFiled} from the seller.`,
      `The buyer paid ${money(paid, file.deal.currency)}${
        partial
          ? `, of which ${money(disputed as number, file.deal.currency)} is disputed.`
          : ', and the whole of it is in dispute.'
      }`,
      `Opened by the ${file.dispute.raised_by} on ${file.dispute.opened_at}, ` +
        `reason code ${file.dispute.reason_code}.`,
      `This seller has ${file.seller_history.deals_on_this_account} deal(s) on ` +
        `this account, ${file.seller_history.prior_disputes} prior dispute(s), ` +
        `${file.seller_history.prior_disputes_lost} of them lost.`,
      'Read the statement and the evidence yourself before deciding. Approving ' +
        'this card is what would move money, and it would be your decision ' +
        'rather than a model\'s.',
    ],
    cited: cite(file.timeline),
    // Zero, not a low number. A stand-in has no confidence to report, and any
    // figure above zero would be read as one.
    confidence: 0,
    ...(recommendation === 'partial_refund' ? { refund_amount: disputed } : {}),
  }
}

/**
 * §12.2's brief, which is the easier of the two: the narrator's job is to
 * restate a file rather than to weigh a contested question, so a rule can do a
 * recognisable version of it. It still holds nothing and decides nothing.
 */
export function demoRiskBrief(file: RiskCaseFile): Record<string, unknown> {
  const seller = file.seller

  const points = [
    PREAMBLE,
    seller
      ? `${seller.name}, registered ${seller.age_days} day(s) before this deal` +
        (seller.country ? ` in ${seller.country}` : '') +
        (seller.masked_destination
          ? `, paid out to ${seller.masked_destination} in ${seller.payout_currency}.`
          : ', with no payout destination on file yet.')
      : 'No seller record is attached to this deal.',
    `${file.history.deals_on_this_account} deal(s) on this account, ` +
      `${file.history.completed} completed, ${file.history.prior_disputes} ` +
      `dispute(s), ${file.history.prior_disputes_lost} lost.`,
    `This deal is ${money(file.size.amount, file.deal.currency)} against an ` +
      `account average of ${money(file.size.tenant_average, file.deal.currency)} ` +
      `— ${file.size.ratio.toFixed(1)}× .`,
    `Largest previous payout: ${money(file.history.largest_previous_payout, file.deal.currency)}.`,
    file.destination_changed_at
      ? `The payout destination last changed on ${file.destination_changed_at}.`
      : 'The payout destination has not changed since registration.',
  ]

  return {
    headline: seller
      ? `Demo stand-in: ${seller.name}, ${file.risk_signals.length} signal(s) on file`
      : `Demo stand-in: ${file.risk_signals.length} signal(s) on file`,
    points,
    // The rules' own findings, restated rather than re-derived. The narrator
    // never invents a flag, and neither does its stand-in.
    flags: file.risk_signals.map((s) =>
      s.explanation ? `${s.signal} (${s.severity}): ${s.explanation}` : `${s.signal} (${s.severity})`
    ),
    cited: cite(file.timeline),
    confidence: 0,
  }
}

/**
 * The support answer. Retrieval already found the passages; without a model
 * there is nothing to compose them with, so the stand-in hands back the
 * passages themselves and says that is what it is doing.
 *
 * It cites only sources it was actually given, which is the same rule the
 * prompt puts on the model and the same one `validate` enforces.
 */
export function demoSupportAnswer(
  question: string,
  passages: { source: string; text: string }[],
): Record<string, unknown> {
  if (passages.length === 0) {
    return {
      text:
        `${PREAMBLE}\n\nNothing in the operations guide matched that question, ` +
        'and without a model there is nothing here to reason from. Ask a ' +
        'narrower question, or set a model key to get a real answer.',
      sources: [],
    }
  }

  return {
    text:
      `${PREAMBLE}\n\nHere are the passages that matched "${question}", ` +
      'verbatim and unsummarised:\n\n' +
      passages.map((p) => `— ${p.text}`).join('\n\n'),
    sources: passages.map((p) => p.source),
  }
}
