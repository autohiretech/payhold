/**
 * The corpus the support assistant answers from — spec §12.2.
 *
 * Retrieval, not recall. The assistant is given passages and told to answer
 * from them or say it does not know; it is never asked what it remembers about
 * how PayHold works. That is the difference between an answer a tenant can act
 * on and a plausible sentence about a product the model has never seen.
 *
 * Held as data in this repo rather than fetched from a docs site because these
 * passages are the operations guide of spec §11, and §11 is kept accurate in
 * the same commit as any behaviour change. A corpus that lives somewhere else
 * is a corpus that describes last quarter's product.
 *
 * Every passage carries the `source` string the assistant cites. Changing the
 * wording of a passage is a product-documentation change; changing a `source`
 * breaks the citation a tenant read yesterday.
 */

export interface DocPassage {
  id: string
  source: string
  /** Cheap first-pass retrieval. The model does the actual answering. */
  keys: RegExp
  text: string
}

export const DOCS: DocPassage[] = [
  {
    id: 'hold',
    source: 'Operations guide — how a payment hold works',
    keys: /\bhold|held|holding|where is the money|vault|custody\b/i,
    text:
      'When a buyer pays, the money lands in the payment provider\'s balance and ' +
      'is marked held against that deal. It is not the company\'s to spend yet ' +
      'and it is not the seller\'s either — it sits there until both sides ' +
      'confirm, the release timer fires, or the deal is refunded. PayHold ' +
      'orchestrates the hold; the funds sit in the company\'s own provider ' +
      'account, not in a PayHold-owned one.',
  },
  {
    id: 'release',
    source: 'Operations guide — release',
    keys: /releas|both confirm|confirmation|atomic/i,
    text:
      'Money is released when both the buyer and the seller confirm, and at no ' +
      'other time. The one exception is the timer: if a party stays silent past ' +
      'the auto-release date, the system confirms on their behalf and releases. ' +
      'Either way the release is a single atomic step — it cannot half-happen ' +
      'and it cannot happen twice.',
  },
  {
    id: 'timer',
    source: 'Settings — auto_release_days',
    keys: /timer|auto.?release|silent|no response|deadline/i,
    text:
      'The auto-release timer starts from the expected completion date and runs ' +
      'for auto_release_days, which is 3 by default. Reminders go out before it ' +
      'fires. A deal with an open dispute is skipped: the timer never overrides ' +
      'a dispute.',
  },
  {
    id: 'clearance',
    source: 'Operations guide — clearance and payouts',
    keys: /clearance|payout|paid out|when.*seller.*get|settle/i,
    text:
      'Release and payout are different events. Released money waits out the ' +
      'clearance window, 7 days by default, before it becomes available, and ' +
      'then the payout job sends it to the seller\'s registered destination. ' +
      'Before any payout leaves, deterministic risk rules screen it and may hold ' +
      'it for review. A held payout waits for a person to clear it.',
  },
  {
    id: 'refund',
    source: 'Operations guide — refunds',
    keys: /refund|cancel|money back|chargeback/i,
    text:
      'A refund can be made any time before release and returns the buyer\'s ' +
      'money by the route it arrived on. Refunds are all-or-nothing: there is no ' +
      'partial refund in v1. After release the money has left the hold, so a ' +
      'refund is no longer a one-click operation — which is what the clearance ' +
      'window exists to give room for. Security deposits are the separate case: ' +
      'a card pre-authorisation can be partly captured.',
  },
  {
    id: 'dispute',
    source: 'Operations guide — disputes',
    keys: /dispute|disagree|complain|damage|argument|escalat/i,
    text:
      'Either side can open a dispute while funds are held. The money freezes ' +
      'where it is — it can neither release nor refund — until an administrator ' +
      'resolves it in favour of one side. The assistant can draft a suggested ' +
      'resolution with its reasoning and citations, but a person always makes ' +
      'the call, and their approval is what executes.',
  },
  {
    id: 'fees',
    source: 'Settings — fees',
    keys: /fee|commission|charge|rate|pricing|cost/i,
    text:
      'The service fee is a percentage of the deal amount, taken at release, ' +
      '10 per cent by default. An optional flat buyer fee can sit on top. Both ' +
      'live in Settings, and a change applies only to deals created afterwards: ' +
      'in-flight deals keep the terms they were created with.',
  },
  {
    id: 'rails',
    source: 'Payment rails',
    keys: /rail|flutterwave|stripe|momo|mobile money|m-?pesa|card|provider|3ds/i,
    text:
      'Flutterwave is the launch rail for cards and mobile money across Africa, ' +
      'and it is the only rail that can pay out to Rwandan and Kenyan sellers. ' +
      'Stripe collects international cards but cannot send money to those ' +
      'markets, so a deal can be collected on Stripe and paid out on ' +
      'Flutterwave. That is why held balances are reported per rail. 3D Secure ' +
      'is requested on every card charge.',
  },
  {
    id: 'keys',
    source: 'API keys and integration',
    keys: /api key|integrat|webhook|endpoint|token|signature|hmac/i,
    text:
      'A client\'s site calls the API with an X-Api-Key header. Keys are hashed ' +
      'at rest, so the full value is shown once at creation and never again — if ' +
      'it is lost, revoke it and make another. Registered webhook endpoints are ' +
      'notified on every status change, signed with PayHold-Signature as ' +
      't=<unix seconds>,v1=<hmac-sha256> over "<t>.<raw body>". Verify the ' +
      'digest and bound the age of t, or a captured delivery can be replayed.',
  },
  {
    id: 'reconciliation',
    source: 'Operations guide — reconciliation',
    keys: /reconcil|drift|frozen|freeze|balance.*match|mismatch/i,
    text:
      'A scheduled pass compares the ledger against what each provider reports, ' +
      'per rail rather than per currency, because two providers cannot be asked ' +
      'about one number. Any drift freezes that company\'s payouts ' +
      'automatically. Nothing unfreezes automatically: the numbers agreeing ' +
      'again is not the same as someone having understood why they did not.',
  },
  {
    id: 'ai',
    source: 'Operations guide §12 — PayHold Intelligence',
    keys: /\bai\b|assistant|model|claude|suggestion|automat|intelligence/i,
    text:
      'The assistant reads a company\'s own data and drafts suggestions; a person ' +
      'on their team approves or rejects them, and that approval is what ' +
      'actually does anything. It runs on a read-only database role and is on no ' +
      'money path — if it were unavailable, every deal, release, refund and ' +
      'payout would behave exactly the same. Its monthly spend is capped per ' +
      'company, and reaching the cap stops drafts and nothing else.',
  },
  {
    id: 'risk',
    source: 'Operations guide §6 — fraud controls',
    keys: /risk|fraud|review|hold.*payout|suspicious|screen/i,
    text:
      'Four fraud controls, and only one of them stops anything: 3D Secure on ' +
      'card charges, tokenisation so no raw card or full mobile-money number is ' +
      'ever stored, Radar on Stripe card charges, and deterministic risk rules ' +
      'checked before a payout leaves. A rule can hold a payout for review and ' +
      'do nothing else — it cannot release, refund or send — so a wrong rule ' +
      'costs a seller a wait rather than money. Only a person clears a hold, and ' +
      'the approval is recorded against them.',
  },
]

/**
 * Pick the passages worth showing for this question.
 *
 * Deliberately blunt keyword matching. The retrieval step only has to avoid
 * putting the entire corpus in every prompt; the model does the judging, and a
 * clever ranker here would be a second thing that can be subtly wrong.
 */
export function retrieve(question: string, limit = 4): DocPassage[] {
  const scored = DOCS.map((doc) => ({
    doc,
    score: (question.match(new RegExp(doc.keys.source, 'gi')) ?? []).length,
  }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)

  return scored.slice(0, limit).map((s) => s.doc)
}
