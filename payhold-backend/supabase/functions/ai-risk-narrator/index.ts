/**
 * The risk narrator — spec §12.2.
 *
 *   POST /ai-risk-narrator  { deal_id }  → a plain-language brief
 *   GET  /ai-risk-narrator?deal_id=…     → briefs already on record
 *
 * Before a large payout, or on a flag, this summarises what is known about the
 * counterparties: how old the seller is, how many deals they have completed,
 * whether a prior dispute went against them, whether the payout destination
 * moved recently.
 *
 * **It never holds anything.** That distinction is the load-bearing part of
 * §6's fraud controls and it is worth stating plainly, because the two things
 * are easy to confuse: the *deterministic risk rules* in `screen_payout` are
 * what can stop a payout, they are arithmetic over our own tables, and they run
 * whether this function is called or not. This is a different thing standing
 * next to them — it explains the situation to whoever is deciding. If the model
 * is wrong, a person reads a poor summary. If it is unavailable, the rules hold
 * exactly the same payouts they would have held anyway.
 *
 * So the output carries facts and flags and no action: nothing downstream
 * branches on it, and `ai_suggestions` rows of this kind never reach a money
 * function even when approved — see `decide_ai_suggestion`.
 *
 * The output shape mirrors `RiskSummaryOutput` in
 * payhold-dashboard/src/api/types.ts field for field. That file is the contract;
 * a field added on only one side is a screen that renders nothing.
 */

import { resolveCaller, serviceClient } from '../_shared/auth.ts'
import { aiReadClient } from '../_shared/ai-db.ts'
import {
  assertAiAvailable,
  cachedSuggestion,
  inputHash,
  recordSuggestion,
  SUGGESTION_COLUMNS,
} from '../_shared/ai.ts'
import { riskCaseFile } from '../_shared/ai-context.ts'
import { askClaude, trusted } from '../_shared/anthropic.ts'
import { validateRiskBrief } from '../_shared/ai-validate.ts'
import { handler, json, readJson, required } from '../_shared/http.ts'
import { PayHoldError } from '../_shared/types.ts'

const PROMPT_VERSION = 'risk-narrator@1'

const SYSTEM = `
You are briefing an administrator who is about to decide whether a payout
should go out. Summarise what is known about the counterparties. You are not
deciding anything and nothing you write is acted on automatically — a
deterministic rule engine, not you, is what can hold a payout.

Write the way a colleague would say it out loud: "new seller, three deals, one
prior dispute, payout destination changed yesterday". Short factual sentences.
No hedging, no advice about what to do, no recommendation.

"points" are the facts, most decision-relevant first. "flags" are the subset
worth a second look. If the case file contains findings from the deterministic
rules, explain what each means in plain language rather than restating its code.

An empty "flags" list is the answer when nothing stands out, and a good one. The
reader is deciding; a manufactured concern costs them more than a short brief
does.

Cite events by their exact "ref" from the timeline, and only those.
`.trim()

const SCHEMA = {
  type: 'object',
  properties: {
    headline: { type: 'string', description: 'One line a reader could skim.' },
    points: { type: 'array', items: { type: 'string' } },
    flags: {
      type: 'array',
      items: { type: 'string' },
      description: 'Things worth a second look. Empty is a real answer.',
    },
    cited: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          ref: { type: 'string' },
          at: { type: 'string' },
          label: { type: 'string' },
        },
        required: ['ref', 'at', 'label'],
        additionalProperties: false,
      },
    },
    confidence: { type: 'number' },
  },
  required: ['headline', 'points', 'flags', 'cited', 'confidence'],
  additionalProperties: false,
}

Deno.serve(handler(async (req) => {
  const auth = serviceClient()
  const caller = await resolveCaller(auth, req)
  const url = new URL(req.url)

  if (req.method === 'GET') {
    const dealId = url.searchParams.get('deal_id')
    let query = auth
      .from('ai_suggestions')
      .select(SUGGESTION_COLUMNS)
      .eq('tenant_id', caller.tenant_id)
      .eq('kind', 'risk_summary')
      .order('created_at', { ascending: false })
      .limit(Math.min(Number(url.searchParams.get('limit') ?? 50), 200))

    if (dealId) query = query.eq('deal_id', dealId)

    const { data } = await query
    return json(req, { suggestions: data ?? [] })
  }

  if (req.method !== 'POST') {
    throw new PayHoldError('policy_violation', `${req.method} is not supported here`)
  }

  const body = await readJson<{ deal_id: string }>(req)
  required(body as unknown as Record<string, unknown>, 'deal_id')

  await assertAiAvailable(auth, caller.tenant_id, 'ai_risk_narrator')

  const db = await aiReadClient(caller.tenant_id)
  const { file, deal_id } = await riskCaseFile(db, caller.tenant_id, body.deal_id)
  const hash = await inputHash({ v: PROMPT_VERSION, file })

  const existing = await cachedSuggestion(db, caller.tenant_id, 'risk_summary', hash)
  if (existing) return json(req, { suggestion: existing, cached: true })

  const validRefs = new Set(file.timeline.map((e) => e.ref))

  // No untrusted block here: every field in this case file comes from PayHold's
  // own tables. The seller's name is the one piece of free text, and it was
  // typed by the client's staff rather than by a member of the public.
  const { value, cost_usd, model } = await askClaude(
    {
      system: SYSTEM,
      schema: SCHEMA,
      // Cheaper and quicker than the dispute draft, and rightly so: this is
      // summarising a file, not weighing a contested question.
      effort: 'low',
      maxTokens: 4_000,
      user: [
        trusted(
          'Counterparty case file for this deal:\n\n' + JSON.stringify(file, null, 2),
        ),
        trusted('Brief the administrator.'),
      ],
    },
    (raw) => validateRiskBrief(raw, validRefs),
  )

  const suggestion = await recordSuggestion(db, {
    tenant_id: caller.tenant_id,
    deal_id,
    kind: 'risk_summary',
    prompt_version: PROMPT_VERSION,
    input_hash: hash,
    output: value as unknown as Record<string, unknown>,
    cost_usd,
    model,
  })

  return json(req, { suggestion, cached: false }, 201)
}))
