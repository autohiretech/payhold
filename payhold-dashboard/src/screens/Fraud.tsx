import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '@/api'
import { AiSuggestionCard, SparkIcon } from '@/components/ai'
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  ErrorNote,
  Input,
  Mono,
  PageHeader,
  Skeleton,
  StatTile,
  Table,
  Td,
  Th,
} from '@/components/ui'
import { formatDateTime, formatMoney, type StatusMeta } from '@/lib/format'
import { COUNTRY_LABEL } from '@/lib/rails'
import {
  useAiMutation,
  useAiSuggestions,
  useAiUsage,
  useDeals,
  usePayouts,
  useRequestContext,
  useRiskSignals,
  useSellers,
  useTenant,
} from '@/lib/queries'
import type { RequestContextSource, RiskSeverity } from '@/api'

/**
 * What the fraud controls noticed — spec §6.
 *
 * The page is arranged around one claim it has to keep honest: **only one of
 * the four layers stops anything, and it can only make somebody wait.** 3D
 * Secure, tokenisation and Radar are prevention that happens before we see a
 * transaction. The deterministic rules are the only thing that acts, and all
 * they may do is hold a payout for review. Nothing on this screen is a verdict,
 * and the copy says so where a reader would otherwise assume otherwise.
 *
 * Held payouts come first because they are the only rows with a person waiting
 * on the other end. Signals come next — what the rules noticed, whether or not
 * they held anything. Payment origins come last, and deliberately so: they are
 * the newest and weakest evidence, and putting an IP table at the top of a
 * fraud screen invites people to read addresses as accusations.
 *
 * The AI on this page is the **risk narrator** and it is on the reading side of
 * the line, not the acting side. It summarises who is about to be paid so a
 * reviewer starts from a briefing rather than from a rule name; it cannot hold,
 * clear, release or send, which is invariant 9 and also why it is safe to have
 * here at all. The four controls in the footer are still four — the narrator is
 * not a fifth.
 *
 * Every name on this page is a link, because a hold is about a counterparty and
 * a screen that names one without letting you look at them is asking for a
 * decision on a string.
 */
export function FraudPage() {
  const signals = useRiskSignals()
  const context = useRequestContext()
  const payouts = usePayouts()
  const deals = useDeals()
  const sellers = useSellers()
  const tenant = useTenant()
  const [search, setSearch] = useState('')

  // `held_for_review` is one payout stopped by a rule and waiting on a person.
  // `frozen` is the whole account stopped by reconciliation — a different thing
  // with a different remedy, surfaced as the banner above rather than as rows.
  const held = payouts.data?.filter((p) => p.status === 'held_for_review') ?? []
  const review = signals.data?.filter((s) => s.severity === 'review') ?? []

  const seller = (id: string | null) => sellers.data?.find((s) => s.id === id)

  const dealOf = (id: string) => deals.data?.find((d) => d.id === id)

  /**
   * The nearest thing to a buyer's name that PayHold holds. We store no buyer
   * PII — `buyer_ref` is the client's own identifier — so it is shown as what
   * it is, and it is still what tells a reviewer whether two held payouts are
   * the same person twice.
   */
  const buyerRef = (id: string) => dealOf(id)?.buyer_ref ?? null

  // The risk narrator, in the place a hold is actually read. It drafts a
  // summary of the counterparties and writes a suggestion; it has no say in
  // whether the payout goes, and clearing the hold stays on Payouts where the
  // approval is recorded against a person.
  const usage = useAiUsage()
  const suggestions = useAiSuggestions()
  const [briefing, setBriefing] = useState<string | null>(null)
  const summarise = useAiMutation((dealId: string) => api.draftRiskSummary(dealId))
  const aiReady = usage.data?.enabled && !usage.data.over_budget

  const summaryFor = (dealId: string) =>
    suggestions.data?.find(
      (s) => s.deal_id === dealId && s.output.kind === 'risk_summary',
    )

  // An address seen on more than one deal. Counted here rather than flagged,
  // for the reason in the note below the table: in these markets it is usually
  // a carrier, not a person.
  const seenOn = new Map<string, number>()
  for (const row of context.data ?? []) {
    if (!row.ip) continue
    seenOn.set(row.ip, (seenOn.get(row.ip) ?? 0) + 1)
  }

  const term = search.trim().toLowerCase()
  const origins = (context.data ?? []).filter(
    (row) =>
      !term ||
      (row.ip ?? '').includes(term) ||
      row.deal_id.toLowerCase().includes(term) ||
      (buyerRef(row.deal_id) ?? '').toLowerCase().includes(term) ||
      row.event.toLowerCase().includes(term),
  )

  return (
    <>
      <PageHeader
        title="Fraud"
        subtitle="What the controls noticed. Rules can hold a payout for review and nothing else — no rule here refuses a payment or moves money."
      />

      {tenant.data?.status === 'payouts_frozen' && (
        <div className="mb-4">
          <ErrorNote message="Payouts are frozen for this whole account pending a reconciliation review. That is separate from the holds below — it stops every transfer, not one." />
        </div>
      )}

      {summarise.isError && (
        <div className="mb-4">
          <ErrorNote message={summarise.error.message} />
        </div>
      )}

      <div className="mb-8 grid gap-3 sm:grid-cols-3">
        <StatTile
          label="Payouts held for review"
          value={String(held.length)}
          hint="Waiting on a person, not on a timer"
        />
        <StatTile
          label="Signals that held something"
          value={String(review.length)}
          hint={`${signals.data?.length ?? 0} recorded in total`}
        />
        <StatTile
          label="Payments with a recorded origin"
          value={String(context.data?.length ?? 0)}
          hint="Observation only — nothing reads it yet"
        />
      </div>

      {/* -- Held payouts ---------------------------------------------------- */}

      <Card className="mb-8">
        <CardHeader
          title="Held for review"
          subtitle="A rule stopped these. Clearing one is a person's decision and is recorded against them, on the Payouts screen."
        />
        {payouts.isPending ? (
          <Skeleton className="h-24" />
        ) : held.length === 0 ? (
          <EmptyState
            title="Nothing held"
            body="No payout is waiting on a review. Rules that fired without holding anything are in the signals below."
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Seller</Th>
                <Th>Buyer</Th>
                <Th>Deal</Th>
                <Th align="right">Amount</Th>
                <Th>Scheduled</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {held.flatMap((p) => {
                const s = seller(p.seller_id)
                const summary = summaryFor(p.deal_id)
                const showSummary = briefing === p.deal_id && summary
                const why = signals.data?.filter(
                  (sig) => sig.deal_id === p.deal_id && sig.severity === 'review',
                ) ?? []

                return [
                  <tr key={p.id} className="hover:bg-surface-2">
                    <Td className="font-medium">
                      <SellerLink seller={s} fallback={p.seller_id} />
                    </Td>
                    <Td className="text-fg-muted">
                      <Mono>{buyerRef(p.deal_id) ?? '—'}</Mono>
                    </Td>
                    <Td>
                      <Link className="text-brand hover:underline" to={`/deals/${p.deal_id}`}>
                        <Mono>{p.deal_id}</Mono>
                      </Link>
                    </Td>
                    <Td align="right" className="tabular font-medium">
                      {formatMoney(p.amount, p.currency)}
                    </Td>
                    <Td className="text-fg-muted">{formatDateTime(p.scheduled_for)}</Td>
                    <Td align="right">
                      {aiReady && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={summarise.isPending}
                          onClick={() => {
                            setBriefing(showSummary ? null : p.deal_id)
                            if (!summary) summarise.mutate(p.deal_id)
                          }}
                        >
                          <SparkIcon className="size-3.5" />
                          {showSummary ? 'Hide' : 'Brief me'}
                        </Button>
                      )}
                    </Td>
                  </tr>,

                  // Why it stopped. Not behind a toggle: a hold with an
                  // unstated reason is one an operator can only rubber-stamp.
                  // A person's hold comes with a sentence, a rule's with the
                  // arithmetic it fired on, and which it was matters more than
                  // either — one of them is somebody you can go and ask.
                  (p.review_held_by || why.length > 0) && (
                    <tr key={`${p.id}-why`}>
                      <td colSpan={6} className="border-b border-line bg-pending-soft/40 px-6 py-4">
                        {p.review_held_by ? (
                          <>
                            <p className="text-sm font-medium text-fg">
                              Held by {p.review_held_by}
                            </p>
                            <p className="mt-2 text-sm text-fg-muted">
                              {p.review_hold_reason}
                            </p>
                          </>
                        ) : (
                          <>
                            <p className="text-sm font-medium text-fg">
                              Held by {why.length === 1 ? 'a rule' : `${why.length} rules`}
                            </p>
                            <ul className="mt-2 space-y-1">
                              {why.map((sig) => (
                                <li key={sig.id} className="text-sm text-fg-muted">
                                  {sig.explanation}
                                </li>
                              ))}
                            </ul>
                          </>
                        )}
                      </td>
                    </tr>
                  ),

                  showSummary && (
                    <tr key={`${p.id}-brief`}>
                      <td colSpan={6} className="border-b border-line bg-surface-2/30 px-6 py-4">
                        <AiSuggestionCard
                          suggestion={summary}
                          variant="inline"
                          dealLink={false}
                        />
                      </td>
                    </tr>
                  ),
                ]
              })}
            </tbody>
          </Table>
        )}
      </Card>

      {/* -- Signals --------------------------------------------------------- */}

      <Card className="mb-8">
        <CardHeader
          title="What the rules noticed"
          subtitle="Recorded whether or not the rules are switched on — the setting governs holding, not noticing."
        />
        {signals.isPending ? (
          <Skeleton className="h-24" />
        ) : (signals.data?.length ?? 0) === 0 ? (
          <EmptyState
            title="Nothing noticed yet"
            body="Signals are written when a payout is screened. None of this account's payouts have come due since the rules last ran."
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>What</Th>
                <Th>Deal</Th>
                <Th>Seller</Th>
                <Th>Buyer</Th>
                <Th>When</Th>
              </tr>
            </thead>
            <tbody>
              {signals.data!.map((s) => (
                <tr key={s.id} className="hover:bg-surface-2">
                  <Td>
                    <div className="flex items-start gap-2">
                      <Badge meta={SEVERITY_META[s.severity]} />
                      <span className="text-sm leading-relaxed">{s.explanation}</span>
                    </div>
                  </Td>
                  <Td>
                    <Link className="text-brand hover:underline" to={`/deals/${s.deal_id}`}>
                      <Mono>{s.deal_id}</Mono>
                    </Link>
                  </Td>
                  <Td>
                    <SellerLink seller={seller(s.seller_id)} fallback="—" />
                  </Td>
                  <Td className="text-fg-muted">
                    <Mono>{buyerRef(s.deal_id) ?? '—'}</Mono>
                  </Td>
                  <Td className="text-fg-muted">{formatDateTime(s.created_at)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {/* -- Payment origins -------------------------------------------------- */}

      <Card>
        <CardHeader
          title="Where payments came from"
          subtitle="Observation only. No rule reads this yet, and an address on its own has never been evidence of anything."
        />

        <div className="mb-4 sm:max-w-xs">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter by address, deal, buyer, or event…"
          />
        </div>

        {context.isPending ? (
          <Skeleton className="h-24" />
        ) : origins.length === 0 ? (
          <EmptyState
            title={term ? 'Nothing matches that' : 'No origins recorded'}
            body={
              term
                ? 'Try a different address or deal reference.'
                : 'Origins are recorded when a payment starts and again when the provider confirms the charge. Older integrations send nothing, which is normal.'
            }
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Address</Th>
                <Th>How we know</Th>
                <Th>Deal</Th>
                <Th>Buyer</Th>
                <Th>Event</Th>
                <Th>When</Th>
              </tr>
            </thead>
            <tbody>
              {origins.map((row) => (
                <tr key={row.id}>
                  <Td>
                    <Mono>{row.ip ?? 'not reported'}</Mono>
                    {row.ip_country && (
                      <span className="ml-2 text-xs text-fg-subtle">
                        {COUNTRY_LABEL[row.ip_country] ?? row.ip_country}
                      </span>
                    )}
                    {row.ip && (seenOn.get(row.ip) ?? 0) > 1 && (
                      <span className="ml-2 text-xs text-fg-subtle">
                        seen on {seenOn.get(row.ip)} payments
                      </span>
                    )}
                  </Td>
                  <Td>
                    <SourceBadge source={row.source} />
                  </Td>
                  <Td>
                    <Link className="text-brand hover:underline" to={`/deals/${row.deal_id}`}>
                      <Mono>{row.deal_id}</Mono>
                    </Link>
                  </Td>
                  <Td className="text-fg-muted">
                    <Mono>{buyerRef(row.deal_id) ?? '—'}</Mono>
                  </Td>
                  <Td>{EVENT_LABEL[row.event] ?? row.event}</Td>
                  <Td className="text-fg-muted">{formatDateTime(row.created_at)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <div className="mt-6 space-y-2 border-t border-line pt-5 text-xs leading-relaxed text-fg-muted">
        <p>
          <span className="font-semibold text-fg">
            A repeated address is usually not a person.
          </span>{' '}
          Mobile money in Rwanda and Kenya runs behind carrier-grade NAT, so
          thousands of unrelated MTN and Airtel customers share a handful of
          addresses. Treat a shared address as a question, never an answer.
        </p>
        <p>
          Three of the four fraud controls never appear here, because they act
          before a transaction reaches us: 3D Secure is requested on every card
          charge, no raw card or full mobile-money number is ever stored, and
          Radar screens Stripe card payments. This screen is the fourth — the
          only one that can stop anything, and all it can do is make a seller
          wait while a person looks.
        </p>
        <p>
          <span className="font-semibold text-fg">
            The assistant reads this screen and cannot act on it.
          </span>{' '}
          “Brief me” asks it to summarise who is about to be paid — how long the
          seller has been registered, what they have been paid before, whether a
          dispute has gone against them. It is the only kind of help a model is
          allowed to give here: a hold is arithmetic over this account's own
          tables, which is what lets a rule stop something at all, and a summary
          you can check beats a score you cannot. Nothing the assistant writes
          holds, clears, releases or sends.
        </p>
        <p>
          Payment origins are personal data, kept indefinitely so a fraud model
          trained on this account's own history has something to learn from.
        </p>
      </div>
    </>
  )
}

/**
 * A named counterparty, opened rather than read.
 *
 * A fraud screen's whole job is to put a person in front of somebody, so a name
 * here is never plain text: it goes to that seller's record — their market,
 * their destination, every deal and payout they have had, and every signal
 * their name is on.
 */
function SellerLink({
  seller,
  fallback,
}: {
  seller: { id: string; name: string } | undefined
  fallback: string
}) {
  if (!seller) return <span className="text-fg-muted">{fallback}</span>
  return (
    <Link className="text-brand hover:underline" to={`/sellers/${seller.id}`}>
      {seller.name}
    </Link>
  )
}

/**
 * How much an address is worth believing.
 *
 * Shown as words rather than a colour, because the distinction is the whole
 * point and a reader should not have to learn a palette to notice that one of
 * these three is something a client typed.
 */
function SourceBadge({ source }: { source: RequestContextSource }) {
  return <Badge meta={SOURCE_META[source]} />
}

/**
 * Vocabulary defined once, as the conventions require. The `hint` is what a
 * reader gets on hover, and for `client_attested` it is the most important
 * sentence on the page.
 */
const SOURCE_META: Record<RequestContextSource, StatusMeta> = {
  provider: {
    label: 'Provider saw it',
    tone: 'confirmed',
    hint: 'Reported by Flutterwave or Stripe against a transaction we re-verified.',
  },
  hosted_page: {
    label: 'Our page saw it',
    tone: 'confirmed',
    hint: 'The buyer connected to PayHold’s own payment page.',
  },
  client_attested: {
    label: 'Client told us',
    tone: 'pending',
    hint:
      'Passed by the client’s server and unverifiable — a compromised integration can send anything. It may inform a question, never a conclusion.',
  },
}

const SEVERITY_META: Record<RiskSeverity, StatusMeta> = {
  review: {
    label: 'Held',
    tone: 'danger',
    hint: 'This one stopped a payout until a person clears it.',
  },
  info: {
    label: 'Noted',
    tone: 'neutral',
    hint: 'Recorded and acted on by nothing. History for later.',
  },
}

const EVENT_LABEL: Record<string, string> = {
  pay_started: 'Payment started',
  charge_confirmed: 'Charge confirmed',
  confirmation: 'Confirmation',
}
