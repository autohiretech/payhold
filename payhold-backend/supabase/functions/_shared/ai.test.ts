/**
 * The AI layer's pure parts, tested without a model and without a database.
 *
 * The guarantees that need Postgres — the read-only role, the human gate, the
 * outcome labels — live in `tests/intelligence.test.ts`. What is here is the
 * logic between the model's reply and the row we write, plus the one product
 * rule that binds model output as tightly as it binds ours.
 */

import { assertEquals, assertRejects, assertThrows } from 'jsr:@std/assert@1'
import { inputHash } from './ai.ts'
import { validateDisputeDraft, validateRiskBrief } from './ai-validate.ts'
import { askClaude, HOUSE_RULES } from './anthropic.ts'
import { demoDisputeDraft, demoSupportAnswer } from './ai-demo.ts'
import type { DisputeCaseFile } from './ai-context.ts'
import { DOCS, retrieve } from './ai-docs.ts'
import { PayHoldError } from './types.ts'

const REFS = new Set(['aud_1', 'aud_2'])

// ---------------------------------------------------------------------------
// The language rule binds the model too
// ---------------------------------------------------------------------------

Deno.test('the house rules forbid the regulated word, and do not contain it loose', () => {
  // The prompt has to *name* the banned term in order to ban it, so the check
  // is that it appears exactly once and inside the prohibition.
  const occurrences = HOUSE_RULES.toLowerCase().match(/escrow/g) ?? []
  assertEquals(occurrences.length, 1)
  const line = HOUSE_RULES.split('\n').find((l) => /escrow/i.test(l)) ?? ''
  assertEquals(/never use the word/i.test(line), true)
})

Deno.test('no document passage uses the regulated word', () => {
  for (const doc of DOCS) {
    assertEquals(/escrow/i.test(doc.text), false, `${doc.id} mentions it`)
    assertEquals(/escrow/i.test(doc.source), false, `${doc.id} source mentions it`)
  }
})

Deno.test('the house rules state the advisory posture and the PII rule', () => {
  assertEquals(/a person .* decides/i.test(HOUSE_RULES), true)
  assertEquals(/never ask for, infer, or invent/i.test(HOUSE_RULES), true)
})

// ---------------------------------------------------------------------------
// Citations
// ---------------------------------------------------------------------------

Deno.test('a citation the model invented is dropped, not shown', () => {
  const draft = validateDisputeDraft({
    recommendation: 'refund',
    headline: 'Refund the buyer.',
    rationale: ['Nothing was delivered.'],
    cited: [
      { ref: 'aud_1', at: '2026-08-01T00:00:00Z', label: 'Funds held' },
      { ref: 'aud_999', at: '2026-08-02T00:00:00Z', label: 'Invented' },
    ],
    confidence: 0.7,
  }, REFS)

  assertEquals(draft.cited.map((c) => c.ref), ['aud_1'])
  // The rationale survives whole: an uncited factor is honest, and dropping it
  // would hide the reasoning rather than the bad reference.
  assertEquals(draft.rationale.length, 1)
})

Deno.test('a malformed citation is dropped even when its ref is real', () => {
  const draft = validateDisputeDraft({
    recommendation: 'release',
    headline: 'Release.',
    rationale: [],
    cited: [{ ref: 'aud_1' }],
    confidence: 0.5,
  }, REFS)

  assertEquals(draft.cited, [])
})

// ---------------------------------------------------------------------------
// Refusing an unusable answer rather than storing it
// ---------------------------------------------------------------------------

Deno.test('a draft with no recommendation is refused, not stored', () => {
  assertThrows(
    () => validateDisputeDraft({ headline: 'Hmm', rationale: [] }, REFS),
    PayHoldError,
    'unusable draft',
  )
})

Deno.test('a recommendation outside the three is refused', () => {
  // Notably `split`: v1 has no partial refund, so a split is a resolution the
  // engine could not carry out.
  assertThrows(
    () =>
      validateDisputeDraft(
        { recommendation: 'split', headline: 'Half each', rationale: [] },
        REFS,
      ),
    PayHoldError,
  )
})

Deno.test('an empty headline is refused', () => {
  assertThrows(
    () =>
      validateDisputeDraft(
        { recommendation: 'release', headline: '   ', rationale: [] },
        REFS,
      ),
    PayHoldError,
  )
})

Deno.test('confidence is clamped and never trusted', () => {
  const high = validateDisputeDraft({
    recommendation: 'release',
    headline: 'Release.',
    rationale: [],
    confidence: 4.2,
  }, REFS)
  assertEquals(high.confidence, 1)

  const missing = validateDisputeDraft({
    recommendation: 'release',
    headline: 'Release.',
    rationale: [],
  }, REFS)
  assertEquals(missing.confidence, 0.5)
})

// ---------------------------------------------------------------------------
// Risk briefs
// ---------------------------------------------------------------------------

Deno.test('a brief carries exactly the fields the dashboard renders', () => {
  const brief = validateRiskBrief({
    headline: 'New seller.',
    points: ['Registered 2 days ago.'],
    flags: ['This would be their first payout.'],
    cited: [{ ref: 'aud_2', at: '2026-08-01T00:00:00Z', label: 'Funds held' }],
    confidence: 0.6,
  }, REFS)

  // `RiskSummaryOutput` in payhold-dashboard/src/api/types.ts. A field on only
  // one side of that contract is a screen that renders nothing.
  assertEquals(Object.keys(brief).sort(), [
    'cited',
    'confidence',
    'flags',
    'headline',
    'kind',
    'points',
  ])
})

Deno.test('an empty flags list survives as a real answer', () => {
  const brief = validateRiskBrief({
    headline: 'Nothing unusual.',
    points: ['Nine completed deals.'],
    flags: [],
  }, REFS)

  assertEquals(brief.flags, [])
  assertEquals(brief.kind, 'risk_summary')
})

Deno.test('a brief with no points is refused', () => {
  assertThrows(
    () => validateRiskBrief({ headline: 'Fine' }, REFS),
    PayHoldError,
    'unusable brief',
  )
})

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

Deno.test('the same case file hashes the same way twice', async () => {
  const file = { deal: 'd1', amount: 1000, timeline: ['a', 'b'] }
  assertEquals(await inputHash(file), await inputHash({ ...file }))
})

Deno.test('a changed case file hashes differently', async () => {
  const before = await inputHash({ deal: 'd1', amount: 1000 })
  const after = await inputHash({ deal: 'd1', amount: 1001 })
  assertEquals(before === after, false)
})

Deno.test('the hash is a full sha-256, not a short digest', async () => {
  const hash = await inputHash({ any: 'thing' })
  assertEquals(hash.length, 64)
  assertEquals(/^[0-9a-f]+$/.test(hash), true)
})

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

Deno.test('retrieval finds the passage a question is about', () => {
  const hits = retrieve('when does the seller actually get paid out?')
  assertEquals(hits.length > 0, true)
  assertEquals(hits.some((d) => d.id === 'clearance'), true)
})

Deno.test('retrieval returns nothing for a question the corpus does not cover', () => {
  // Which is what makes "I don't have anything on that" the honest answer
  // rather than an invented one.
  assertEquals(retrieve('what is the capital of Peru'), [])
})

Deno.test('retrieval is bounded so one question cannot drag in the whole corpus', () => {
  const hits = retrieve(
    'hold release timer clearance payout refund dispute fee rail api key ' +
      'reconciliation risk assistant',
  )
  assertEquals(hits.length <= 4, true)
})

// ---------------------------------------------------------------------------
// The degrade path
// ---------------------------------------------------------------------------

Deno.test('a deployment that cannot reach the read-only role refuses cleanly', async () => {
  const secret = Deno.env.get('SUPABASE_JWT_SECRET')
  Deno.env.delete('SUPABASE_JWT_SECRET')

  try {
    const { assertAiAvailable } = await import('./ai.ts')
    await assertRejects(
      // The database handle is never reached: the configuration check comes
      // first, which is what keeps this a 422 rather than a 500.
      () => assertAiAvailable(null as never, 'tenant-1'),
      PayHoldError,
      'SUPABASE_JWT_SECRET',
    )
  } finally {
    if (secret) Deno.env.set('SUPABASE_JWT_SECRET', secret)
  }
})

// ---------------------------------------------------------------------------
// Demo mode — §12 with zero keys
// ---------------------------------------------------------------------------

function disputeFile(over: Record<string, unknown> = {}): DisputeCaseFile {
  return {
    deal: {
      id: 'deal_1',
      description: 'Excavator hire, 3 days',
      amount: 100_000_00,
      currency: 'RWF',
      status: 'disputed',
      created_at: '2026-08-01T00:00:00Z',
      expected_complete_at: null,
      presentment_amount: 100_000_00,
    },
    seller: { name: 'Kigali Plant Ltd', country: 'RW', registered_at: '2026-07-01T00:00:00Z' },
    dispute: {
      id: 'dis_1',
      raised_by: 'buyer',
      opened_at: '2026-08-05T00:00:00Z',
      reason: 'The machine arrived with a cracked bucket.',
      reason_code: 'not_as_described',
      disputed_amount: null,
    },
    evidence: [],
    offers: [],
    confirmations: [],
    timeline: [
      { ref: 'aud_1', at: '2026-08-01T00:00:00Z', action: 'deal.created', actor: 'api' },
      { ref: 'aud_2', at: '2026-08-05T00:00:00Z', action: 'dispute.opened', actor: 'api' },
    ],
    seller_history: {
      deals_on_this_account: 4,
      completed: 3,
      prior_disputes: 1,
      prior_disputes_lost: 0,
    },
    ...over,
  } as DisputeCaseFile
}

const ALL_REFS = new Set(['aud_1', 'aud_2'])

function evidenceFrom(side: 'buyer' | 'seller') {
  return {
    uploaded_by: side,
    kind: 'photo',
    description: 'A photograph of the bucket.',
    captured_at: null,
    created_at: '2026-08-05T00:00:00Z',
  }
}

Deno.test('a missing model key answers from the stand-in instead of refusing', async () => {
  const key = Deno.env.get('ANTHROPIC_API_KEY')
  Deno.env.delete('ANTHROPIC_API_KEY')

  try {
    const result = await askClaude(
      {
        system: 'unused',
        schema: {},
        demo: () => demoDisputeDraft(disputeFile()),
        user: [],
      },
      (raw) => validateDisputeDraft(raw, ALL_REFS, 100_000_00),
    )

    // No model was asked, and the row that records this must not imply one was.
    assertEquals(result.model, 'demo-stand-in')
    assertEquals(result.cost_usd, 0)
    assertEquals(result.value.kind, 'dispute_resolution')
  } finally {
    if (key) Deno.env.set('ANTHROPIC_API_KEY', key)
  }
})

Deno.test('the stand-in leans to the only side that filed evidence', () => {
  const buyerOnly = validateDisputeDraft(
    demoDisputeDraft(disputeFile({ evidence: [evidenceFrom('buyer')] })),
    ALL_REFS,
    100_000_00,
  )
  assertEquals(buyerOnly.recommendation, 'refund')

  const sellerOnly = validateDisputeDraft(
    demoDisputeDraft(disputeFile({ evidence: [evidenceFrom('seller')] })),
    ALL_REFS,
    100_000_00,
  )
  assertEquals(sellerOnly.recommendation, 'release')
})

Deno.test('the stand-in escalates when it has nothing to separate the sides', () => {
  const neither = validateDisputeDraft(demoDisputeDraft(disputeFile()), ALL_REFS, 100_000_00)
  assertEquals(neither.recommendation, 'escalate')

  const both = validateDisputeDraft(
    demoDisputeDraft(
      disputeFile({ evidence: [evidenceFrom('buyer'), evidenceFrom('seller')] }),
    ),
    ALL_REFS,
    100_000_00,
  )
  assertEquals(both.recommendation, 'escalate')
})

Deno.test('a partly disputed payment gets a split the engine could actually carry out', () => {
  const draft = validateDisputeDraft(
    demoDisputeDraft(
      disputeFile({
        evidence: [evidenceFrom('buyer')],
        dispute: { ...disputeFile().dispute, disputed_amount: 40_000_00 },
      }),
    ),
    ALL_REFS,
    100_000_00,
  )

  // Not a full refund: `resolve_dispute` refuses one when only part was
  // disputed, so a stand-in recommending it would draft something unapprovable.
  assertEquals(draft.recommendation, 'partial_refund')
  assertEquals(draft.refund_amount, 40_000_00)
})

Deno.test('the stand-in reports no confidence, and cites only real events', () => {
  const draft = validateDisputeDraft(
    demoDisputeDraft(disputeFile({ evidence: [evidenceFrom('buyer')] })),
    // Only one of the two timeline refs is resolvable here, so an unchecked
    // citation would survive into the card if `askClaude` skipped the validator.
    new Set(['aud_1']),
    100_000_00,
  )

  assertEquals(draft.confidence, 0)
  assertEquals(draft.cited.map((c) => c.ref), ['aud_1'])
})

Deno.test('every demo answer says it is one, and none of them uses the regulated word', () => {
  const draft = demoDisputeDraft(disputeFile({ evidence: [evidenceFrom('buyer')] }))
  const support = demoSupportAnswer('how does a hold work', [
    { source: 'ops guide', text: 'Money leaves a hold when both sides confirm.' },
  ])

  for (const answer of [draft, support]) {
    const text = JSON.stringify(answer)
    assertEquals(/escrow/i.test(text), false)
    assertEquals(/demo stand-in/i.test(text), true)
  }

  // The support stand-in cites only what retrieval actually handed it.
  assertEquals((support.sources as string[]), ['ops guide'])
  assertEquals(demoSupportAnswer('nothing matches', []).sources, [])
})
