/**
 * The dispute assistant — spec §12.2.
 *
 *   POST /ai-dispute        { dispute_id }  → draft a suggested resolution
 *   GET  /ai-dispute?deal_id=…              → drafts already on record
 *
 * It reads both sides of an open dispute and the deal's whole history, and
 * writes one row to `ai_suggestions`. That row changes nothing. A person on the
 * customer's team reads it and either approves it — which is what executes, via
 * `ai-decisions` — or does not.
 *
 * There are four recommendations. `partial_refund` used to be the missing one:
 * v1 had no partial-refund primitive, so a case the evidence genuinely divided
 * came back `escalate` rather than as a split the engine could not carry out.
 * §7.1 built the primitive, so the split is now a resolution somebody can
 * actually approve — and `escalate` goes back to meaning what it says, which is
 * that no split resolves this either.
 *
 * This function runs as `payhold_ai`, not the service role. Postgres, not this
 * file, is what stops it releasing anything.
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
import { disputeCaseFile } from '../_shared/ai-context.ts'
import { askClaude, trusted, untrusted } from '../_shared/anthropic.ts'
import { validateDisputeDraft } from '../_shared/ai-validate.ts'
import { handler, json, readJson, required } from '../_shared/http.ts'
import { PayHoldError } from '../_shared/types.ts'

const PROMPT_VERSION = 'dispute-assistant@1'

const SYSTEM = `
You are drafting a suggested resolution for one disputed deal, for an
administrator at the company that runs the deal. They will read your draft and
then decide. Write for them.

Recommend exactly one of:

- "release" — the seller should be paid.
- "refund"  — the buyer should get their money back.
- "partial_refund" — some of it goes back to the buyer and the rest to the
  seller. Give "refund_amount" in minor units, in the currency the buyer paid.
- "escalate" — a person needs to look at this properly.

Choose "partial_refund" when the file supports a split you can name a figure
for and say why — a rental returned two days early, damage covering part of the
deposit. Do not use it to average two positions you cannot choose between.

Choose "escalate" when the file does not settle the question at all, including
when it is clear something is wrong but not what. An honest "escalate" is a
good answer, not a failure.

Weigh, at minimum: who raised the dispute and when, relative to the
confirmations and the expected completion date; what the deal was for; and the
seller's record on this account. A buyer who confirmed the deal was complete
before opening a dispute has said something significant. So has a seller with
prior disputes resolved against them.

Write "rationale" as one factor per line, each a complete sentence a person
could check against the file. Put the strongest factor first.

Cite events by their exact "ref" from the timeline. Cite only refs that appear
there; if a factor rests on something with no timeline entry, state it in the
rationale without a citation rather than inventing one.

"confidence" is advisory and nothing acts on it. Be honest: a case you have
called "escalate" should not be at 0.9.
`.trim()

const SCHEMA = {
  type: 'object',
  properties: {
    recommendation: {
      type: 'string',
      enum: ['release', 'refund', 'partial_refund', 'escalate'],
    },
    refund_amount: {
      type: 'integer',
      description:
        'Required for partial_refund and ignored otherwise. Minor units, in ' +
        'the currency the buyer was charged. Must be less than what they paid.',
    },
    headline: {
      type: 'string',
      description:
        'One line, the way a colleague would open: what you would do and why.',
    },
    rationale: {
      type: 'array',
      items: { type: 'string' },
      description: 'One factor per entry, strongest first.',
    },
    cited: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'An exact timeline ref.' },
          at: { type: 'string' },
          label: { type: 'string' },
        },
        required: ['ref', 'at', 'label'],
        additionalProperties: false,
      },
    },
    confidence: { type: 'number', description: '0 to 1. Advisory only.' },
  },
  required: ['recommendation', 'headline', 'rationale', 'cited', 'confidence'],
  additionalProperties: false,
}

Deno.serve(handler(async (req) => {
  // Auth and the tenant lookup run on the service role, because reading an API
  // key hash is exactly the thing the AI role must not be able to do. From the
  // resolved tenant onward, everything uses the restricted client.
  const auth = serviceClient()
  const caller = await resolveCaller(auth, req)
  const url = new URL(req.url)

  if (req.method === 'GET') {
    const dealId = url.searchParams.get('deal_id')
    let query = auth
      .from('ai_suggestions')
      .select(SUGGESTION_COLUMNS)
      .eq('tenant_id', caller.tenant_id)
      .eq('kind', 'dispute_resolution')
      .order('created_at', { ascending: false })
      .limit(Math.min(Number(url.searchParams.get('limit') ?? 50), 200))

    if (dealId) query = query.eq('deal_id', dealId)

    const { data } = await query
    return json(req, { suggestions: data ?? [] })
  }

  if (req.method !== 'POST') {
    throw new PayHoldError('policy_violation', `${req.method} is not supported here`)
  }

  const body = await readJson<{ dispute_id: string }>(req)
  required(body as unknown as Record<string, unknown>, 'dispute_id')

  await assertAiAvailable(auth, caller.tenant_id, 'ai_dispute_assistant')

  const db = await aiReadClient(caller.tenant_id)
  const { file, deal_id } = await disputeCaseFile(db, caller.tenant_id, body.dispute_id)
  const hash = await inputHash({ v: PROMPT_VERSION, file })

  // Pressing Draft twice should not put two cards in the queue — still less two
  // that disagree.
  const existing = await cachedSuggestion(db, caller.tenant_id, 'dispute_resolution', hash)
  if (existing) return json(req, { suggestion: existing, cached: true })

  const validRefs = new Set(file.timeline.map((e) => e.ref))

  const { value, cost_usd, model } = await askClaude(
    {
      system: SYSTEM,
      schema: SCHEMA,
      user: [
        trusted(
          'Case file for this dispute, from PayHold\'s own records:\n\n' +
            JSON.stringify({ ...file, dispute: { ...file.dispute, reason: undefined } }, null, 2),
        ),
        // The one field written by a member of the public, handed over framed
        // as evidence rather than as instructions. See `untrusted`.
        untrusted(
          `Statement from the ${file.dispute.raised_by}, opened ${file.dispute.opened_at}`,
          file.dispute.reason,
        ),
        trusted('Draft a suggested resolution.'),
      ],
    },
    (raw) => validateDisputeDraft(raw, validRefs, file.deal.presentment_amount),
  )

  const suggestion = await recordSuggestion(db, {
    tenant_id: caller.tenant_id,
    deal_id,
    kind: 'dispute_resolution',
    prompt_version: PROMPT_VERSION,
    input_hash: hash,
    output: value as unknown as Record<string, unknown>,
    cost_usd,
    model,
  })

  return json(req, { suggestion, cached: false }, 201)
}))
