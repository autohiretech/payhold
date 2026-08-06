/**
 * The support assistant — spec §12.2.
 *
 *   POST /ai-support  { question }  → an answer, with the sources it came from
 *   GET  /ai-support                → this company's transcript
 *
 * Retrieval only. It is handed passages from PayHold's operations guide plus a
 * small snapshot of this company's own account, and it answers from those or
 * says it does not know. **No tools are bound to it at all** — there is nothing
 * for it to call, so "the assistant did something" is not a sentence that can
 * be true here. It runs on the same read-only role as the other two.
 *
 * An answer with no source is a guess, and a guess about where somebody's money
 * is would be worse than silence. So the prompt requires sources and the
 * validator drops any the assistant did not actually receive.
 */

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { resolveCaller, serviceClient } from '../_shared/auth.ts'
import { aiReadClient } from '../_shared/ai-db.ts'
import { assertAiAvailable, inputHash } from '../_shared/ai.ts'
import { retrieve } from '../_shared/ai-docs.ts'
import { askClaude, trusted, untrusted } from '../_shared/anthropic.ts'
import { handler, json, readJson, required } from '../_shared/http.ts'
import { PayHoldError } from '../_shared/types.ts'

const PROMPT_VERSION = 'support-assistant@1'

const SYSTEM = `
You answer questions from staff at a company that uses PayHold, about how
PayHold works and about the state of their own account.

Answer from the reference passages and the account snapshot you were given, and
from nothing else. If they do not cover the question, say so plainly and suggest
what the person could look at instead. "I don't have anything on that" is a
correct answer and a short one.

You cannot do anything. You have no tools and no write access. If someone asks
you to release, refund, pay out, approve or freeze something, say that you only
read, that a person presses the button, and that this is deliberate — nothing
you get wrong can cost them money. Then tell them where in the dashboard the
button is.

List in "sources" the exact "source" string of every passage you actually used.
Do not list a passage you did not use, and do not invent one. If your answer
came only from the account snapshot, use the source "This company's account".

Keep it short. Two or three sentences unless the question genuinely needs more.
Plain language, no jargon, no status codes.
`.trim()

const SCHEMA = {
  type: 'object',
  properties: {
    text: { type: 'string' },
    sources: { type: 'array', items: { type: 'string' } },
  },
  required: ['text', 'sources'],
  additionalProperties: false,
}

const ACCOUNT_SOURCE = "This company's account"

/**
 * A small, current picture of the account.
 *
 * Counts and a handful of rows rather than the whole database: enough for
 * "what is waiting on me?" and "how much is held?", not so much that a routine
 * question drags a thousand deals through a prompt. Every figure here is
 * already visible to the person asking, on a screen they have open.
 */
async function accountSnapshot(db: SupabaseClient, tenantId: string) {
  const head = { count: 'exact' as const, head: true }

  const [openDisputes, pendingDrafts, heldDeals, heldPayouts, balances] = await Promise
    .all([
      db.from('disputes').select('id', head)
        .eq('tenant_id', tenantId).eq('status', 'open'),
      db.from('ai_suggestions').select('id', head)
        .eq('tenant_id', tenantId).is('decision', null),
      db.from('deals').select('id', head)
        .eq('tenant_id', tenantId)
        .in('status', ['funded_held', 'confirmed_buyer', 'confirmed_seller']),
      db.from('payouts').select('id', head)
        .eq('tenant_id', tenantId).eq('status', 'frozen'),
      db.rpc('tenant_balances', { p_tenant: tenantId }),
    ])

  return {
    open_disputes: openDisputes.count ?? 0,
    drafts_waiting_on_a_decision: pendingDrafts.count ?? 0,
    deals_currently_holding_money: heldDeals.count ?? 0,
    payouts_held_for_review: heldPayouts.count ?? 0,
    balances: balances.data ?? [],
  }
}

interface Answer {
  text: string
  sources: string[]
}

function validate(value: unknown, offered: Set<string>): Answer {
  const v = value as Partial<Answer>
  if (typeof v.text !== 'string' || v.text.trim() === '') {
    throw new PayHoldError('policy_violation', 'The assistant returned nothing.')
  }

  return {
    text: v.text,
    // A source it was not given is a source it invented. Dropping it leaves an
    // answer that visibly cites nothing, which is the honest presentation.
    sources: (Array.isArray(v.sources) ? v.sources : []).filter(
      (s): s is string => typeof s === 'string' && offered.has(s),
    ),
  }
}

Deno.serve(handler(async (req) => {
  const auth = serviceClient()
  const caller = await resolveCaller(auth, req)
  const url = new URL(req.url)

  if (req.method === 'GET') {
    const { data } = await auth
      .from('ai_chat')
      .select('id, tenant_id, role, text, sources, attachments, created_at')
      .eq('tenant_id', caller.tenant_id)
      .order('created_at', { ascending: true })
      .limit(Math.min(Number(url.searchParams.get('limit') ?? 200), 500))

    return json(req, { messages: data ?? [] })
  }

  if (req.method !== 'POST') {
    throw new PayHoldError('policy_violation', `${req.method} is not supported here`)
  }

  const body = await readJson<{ question: string }>(req)
  required(body as unknown as Record<string, unknown>, 'question')

  const question = body.question.trim().slice(0, 2_000)
  await assertAiAvailable(auth, caller.tenant_id)

  const db = await aiReadClient(caller.tenant_id)
  const passages = retrieve(question)
  const snapshot = await accountSnapshot(db, caller.tenant_id)
  const offered = new Set([...passages.map((p) => p.source), ACCOUNT_SOURCE])

  const { value, model, cost_usd } = await askClaude(
    {
      system: SYSTEM,
      schema: SCHEMA,
      // A short answer over four passages. Reaching for more thinking here buys
      // nothing and shows up as latency in a chat panel someone is watching.
      effort: 'low',
      maxTokens: 2_000,
      user: [
        trusted(
          passages.length
            ? 'Reference passages:\n\n' +
              passages
                .map((p) => `[source: ${p.source}]\n${p.text}`)
                .join('\n\n')
            : 'No reference passage matched this question.',
        ),
        trusted(
          `Account snapshot [source: ${ACCOUNT_SOURCE}]:\n\n` +
            JSON.stringify(snapshot, null, 2),
        ),
        // The question is typed by a person, and the assistant's own transcript
        // is a place an injected instruction could be parked for later. Framed
        // as data for the same reason a dispute statement is.
        untrusted('Question from the user', question),
      ],
    },
    (raw) => validate(raw, offered),
  )

  const created = new Date().toISOString()

  // Both turns, written together. A transcript missing the question it answered
  // is unreadable a week later.
  const { data: rows, error } = await db
    .from('ai_chat')
    .insert([
      {
        tenant_id: caller.tenant_id,
        role: 'user',
        text: question,
        sources: [],
        attachments: [],
        cost_usd: 0,
        created_at: created,
      },
      {
        tenant_id: caller.tenant_id,
        role: 'assistant',
        text: value.text,
        sources: value.sources,
        attachments: [],
        // The whole exchange's cost sits on the answer, where the budget query
        // reads it.
        cost_usd,
        // A millisecond later, so `order by created_at` cannot put the answer
        // before the question.
        created_at: new Date(Date.parse(created) + 1).toISOString(),
      },
    ])
    .select('id, tenant_id, role, text, sources, attachments, created_at')

  if (error || !rows) {
    throw new PayHoldError(
      'policy_violation',
      `Could not save that answer: ${error?.message ?? 'unknown error'}`,
    )
  }

  await db.from('audit_log').insert({
    tenant_id: caller.tenant_id,
    deal_id: null,
    actor: `ai:${model}`,
    action: 'ai.chat_answered',
    details: {
      prompt_version: PROMPT_VERSION,
      input_hash: await inputHash({ v: PROMPT_VERSION, question }),
      sources: value.sources,
    },
  })

  const reply = rows.find((r) => r.role === 'assistant') ?? rows[rows.length - 1]
  return json(req, { message: reply }, 201)
}))
