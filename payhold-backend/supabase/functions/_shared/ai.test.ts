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
import { HOUSE_RULES } from './anthropic.ts'
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

Deno.test('an unconfigured deployment refuses cleanly rather than throwing', async () => {
  const key = Deno.env.get('ANTHROPIC_API_KEY')
  Deno.env.delete('ANTHROPIC_API_KEY')

  try {
    const { assertAiAvailable } = await import('./ai.ts')
    await assertRejects(
      // The database handle is never reached: the configuration check comes
      // first, which is what keeps a missing key a 422 rather than a 500.
      () => assertAiAvailable(null as never, 'tenant-1'),
      PayHoldError,
      'not configured',
    )
  } finally {
    if (key) Deno.env.set('ANTHROPIC_API_KEY', key)
  }
})
