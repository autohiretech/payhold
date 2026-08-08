/**
 * The Resolution Center — spec §8.
 *
 * This screen replaced `Disputes`, which showed a statement and two buttons.
 * The buttons were never the problem; what was missing is everything you need
 * before pressing one. §16's `operator_screens` item is the requirement in one
 * sentence — *an operator can read what they are being asked to decide* — so
 * the requests, the evidence and the ordered timeline are on the page with the
 * decision rather than a query away from it.
 *
 * Four things here are load-bearing and are not simplifications waiting to
 * happen:
 *
 * **A lapsed request is not a declined one.** Silence lapses a request and
 * never accepts it (§8, and invariants 9 and 11 — a clock that refunded a buyer
 * would be a machine deciding). So `expired` reads as "lapsed, nobody
 * answered", `declined` reads as somebody having said no, and the two never
 * share a label. §24.3's labels cannot be backfilled.
 *
 * **`disputed_amount` is a ceiling, and the form enforces it.** A complaint
 * about part of a payment cannot quietly become a full refund, so the full
 * refund option is refused *in the UI* with the reason, rather than offered and
 * rejected by the engine. A disabled control that says why is a smaller
 * surprise than a failed call.
 *
 * **Acting for a party costs you the decision.** §8's conflict-of-interest
 * control is enforced on who *acted* — there is no identity to join to, since
 * PayHold stores no buyer PII and a seller has no login. Recording a request on
 * a party's behalf therefore disqualifies you from ruling on the same dispute,
 * which is a consequence people should meet before they act and not after.
 *
 * **Nothing here is a party.** An operator recording a request is writing down
 * something a buyer or seller said to them somewhere else; the side picker is
 * that, and it is why the actor and the side are separate fields.
 */

import { useState } from 'react'
import { Link } from 'react-router-dom'
import {
  api,
  type ConfirmSide,
  type Deal,
  type Dispute,
  type DisputeOffer,
  type DisputeOfferKind,
  type Money,
} from '@/api'
import { useAuth } from '@/auth/AuthProvider'
import {
  AiSuggestionCard,
  AiUnavailable,
  DisputeStatements,
  DraftButton,
} from '@/components/ai'
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  ErrorNote,
  Field,
  Input,
  Mono,
  PageHeader,
  Select,
  Skeleton,
  Textarea,
  cx,
} from '@/components/ui'
import {
  DISPUTE_OFFER_KIND_META,
  DISPUTE_OFFER_STATUS_META,
  DISPUTE_REASON_LABEL,
  DISPUTE_STATUS_META,
  formatDateTime,
  formatMoney,
  formatRelative,
} from '@/lib/format'
import {
  useAiAction,
  useAiSuggestions,
  useAiUsage,
  useDeals,
  useDisputeOffers,
  useDisputeTimeline,
  useDisputes,
  useMoneyAction,
  useMoneyMutation,
  simNow,
} from '@/lib/queries'

export function ResolutionPage() {
  const disputes = useDisputes()
  const deals = useDeals()

  const open = disputes.data?.filter((d) => d.status === 'open') ?? []
  const closed = disputes.data?.filter((d) => d.status !== 'open') ?? []

  return (
    <>
      <PageHeader
        title="Resolution Center"
        subtitle="Either side can ask for an update, more time, a cancellation or a refund. The other has 48 hours — and while any of it is open the money stays put."
      />

      {disputes.isPending ? (
        <div className="space-y-3">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-48" />
          ))}
        </div>
      ) : !disputes.data?.length ? (
        <Card>
          <EmptyState
            title="Nothing in dispute"
            body="Either side can open one from the deal page while funds are held."
          />
        </Card>
      ) : (
        <div className="space-y-5">
          {open.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-xs font-medium tracking-wide text-fg-muted uppercase">
                Open — {open.length}
              </h2>
              {open.map((d) => (
                <DisputeCard
                  key={d.id}
                  dispute={d}
                  deal={deals.data?.find((x) => x.id === d.deal_id)}
                />
              ))}
            </section>
          )}

          {closed.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-xs font-medium tracking-wide text-fg-muted uppercase">
                Resolved
              </h2>
              {closed.map((d) => (
                <DisputeCard
                  key={d.id}
                  dispute={d}
                  deal={deals.data?.find((x) => x.id === d.deal_id)}
                />
              ))}
            </section>
          )}
        </div>
      )}
    </>
  )
}

type Tab = 'case' | 'requests' | 'timeline'

function DisputeCard({ dispute, deal }: { dispute: Dispute; deal: Deal | undefined }) {
  const [tab, setTab] = useState<Tab>('case')
  const isOpen = dispute.status === 'open'

  const offers = useDisputeOffers(dispute.id)
  const openOffer = offers.data?.find((o) => o.status === 'open')

  return (
    <Card>
      <CardHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            Raised by the {dispute.raised_by}
            <Link to={`/deals/${dispute.deal_id}`} className="hover:underline">
              <Mono>{dispute.deal_id}</Mono>
            </Link>
            <span className="rounded-full bg-surface-2 px-2.5 py-1 text-xs font-semibold text-fg-muted ring-1 ring-line-strong/70 ring-inset">
              {DISPUTE_REASON_LABEL[dispute.reason_code]}
            </span>
          </span>
        }
        subtitle={`Opened ${formatDateTime(dispute.opened_at)}${
          deal ? ` · ${formatMoney(deal.amount, deal.currency)} held` : ''
        }`}
        action={<Badge meta={DISPUTE_STATUS_META[dispute.status]} />}
      />

      <div className="space-y-5 px-6 py-5">
        <ScopeNote dispute={dispute} deal={deal} />

        {/* The open request comes before the tabs, on every tab. It is the one
            thing on this card with a clock running on it. */}
        {openOffer && <OpenRequest offer={openOffer} deal={deal} />}

        <div className="flex gap-1 border-b border-line">
          {(
            [
              ['case', 'The case'],
              ['requests', `Requests${offers.data?.length ? ` (${offers.data.length})` : ''}`],
              ['timeline', 'Timeline'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={cx(
                '-mb-px border-b-2 px-3 py-2 text-sm font-medium transition',
                tab === key
                  ? 'border-brand text-brand'
                  : 'border-transparent text-fg-muted hover:text-fg',
              )}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === 'case' && (
          <>
            <DisputeStatements dispute={dispute} />
            {!isOpen && <Outcome dispute={dispute} />}
            {isOpen && <Decide dispute={dispute} deal={deal} offers={offers.data ?? []} />}
          </>
        )}

        {tab === 'requests' && (
          <Requests
            dispute={dispute}
            deal={deal}
            offers={offers.data ?? []}
            pending={offers.isPending}
          />
        )}

        {tab === 'timeline' && <Timeline disputeId={dispute.id} />}
      </div>
    </Card>
  )
}

/**
 * What is actually in dispute, and what that permits.
 *
 * §8 lets a party dispute part of a payment, and the amount is a ceiling on the
 * resolution rather than a split of the payout — one payout row exists per
 * deal, so paying the undisputed share now would leave nothing to send the rest
 * with if the dispute later went the seller's way. Saying so here is what stops
 * the disabled full-refund button below reading as a bug.
 */
function ScopeNote({ dispute, deal }: { dispute: Dispute; deal: Deal | undefined }) {
  if (dispute.disputed_amount === null || !deal) return null
  if (dispute.disputed_amount >= deal.amount) return null

  return (
    <p className="rounded-xl bg-surface-2 px-4 py-3 text-sm text-fg-muted">
      <span className="font-semibold text-fg">
        {formatMoney(dispute.disputed_amount, deal.currency)} of{' '}
        {formatMoney(deal.amount, deal.currency)} is in dispute.
      </span>{' '}
      Nothing may take more than that from the seller, so this one resolves as a
      partial refund or a release — never a full refund. The payout stays frozen
      whole until it does.
    </p>
  )
}

function Outcome({ dispute }: { dispute: Dispute }) {
  return (
    <div className="space-y-1 rounded-xl bg-surface-2 px-4 py-3 text-sm">
      <p className="text-fg">
        <span className="font-semibold">
          {DISPUTE_STATUS_META[dispute.status].label}
        </span>
        {dispute.resolved_at && ` · ${formatDateTime(dispute.resolved_at)}`}
      </p>
      {dispute.resolution_note && (
        <p className="text-fg-muted">{dispute.resolution_note}</p>
      )}
      <p className="text-fg-subtle">
        {dispute.decided_by === 'both-parties'
          ? 'The two sides agreed with each other.'
          : `Decided by ${dispute.decided_by ?? 'nobody recorded'}.`}
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Requests — §8's offers
// ---------------------------------------------------------------------------

/**
 * The request with the clock on it.
 *
 * The countdown is the whole reason this sits above the tabs: at 48 hours the
 * request lapses, nothing moves, and the dispute stays open. That is §8's
 * "auto-resolved by platform rule" read the only way invariants 9 and 11 allow.
 */
function OpenRequest({
  offer,
  deal,
}: {
  offer: DisputeOffer
  deal: Deal | undefined
}) {
  const now = simNow()
  const { account } = useAuth()
  const actor = account?.full_name ?? account?.email ?? ''
  const meta = DISPUTE_OFFER_KIND_META[offer.kind]
  const other: ConfirmSide = offer.offered_by === 'buyer' ? 'seller' : 'buyer'

  const respond = useMoneyMutation((accept: boolean) =>
    // The **other** party answers: accepting your own request is not agreement,
    // it is a way around the 48 hours. The engine refuses it too.
    api.respondDisputeOffer(offer.id, other, actor, accept),
  )
  const withdraw = useMoneyAction(() => api.withdrawDisputeOffer(offer.id, actor))

  const lapsed = Date.parse(offer.expires_at) <= now.getTime()

  return (
    <div className="space-y-3 rounded-xl bg-pending-soft px-4 py-4 ring-1 ring-pending/25 ring-inset">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-fg">
            The {offer.offered_by} asked: {meta.label.toLowerCase()}
            {offer.amount !== null && deal
              ? ` — ${formatMoney(offer.amount, deal.currency)}`
              : ''}
          </p>
          <p className="mt-1 text-sm text-fg-muted">{meta.hint}</p>
        </div>
        <span className="text-xs font-semibold text-pending">
          {lapsed
            ? 'Window closed — it lapses on the next pass'
            : `Answer due ${formatRelative(offer.expires_at, now)}`}
        </span>
      </div>

      {offer.extend_to && (
        <p className="text-sm text-fg-muted">
          New date asked for: {formatDateTime(offer.extend_to)}
        </p>
      )}
      {offer.note && <p className="text-sm text-fg">“{offer.note}”</p>}

      <p className="text-xs text-fg-muted">
        Recorded against you as the {other}’s answer. Answering makes you
        somebody who acted for a party, and §8 will not let the same person
        decide this dispute afterwards.
      </p>

      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant={meta.moves_money ? 'danger' : 'primary'}
          disabled={lapsed || respond.isPending || !actor}
          onClick={() => respond.mutate(true)}
        >
          {meta.moves_money
            ? `Accept on the ${other}’s behalf — this moves money`
            : `Accept on the ${other}’s behalf`}
        </Button>
        <Button
          size="sm"
          disabled={lapsed || respond.isPending || !actor}
          onClick={() => respond.mutate(false)}
        >
          Decline
        </Button>
        <Button
          size="sm"
          disabled={withdraw.isPending || !actor}
          onClick={() => withdraw.mutate()}
        >
          Withdraw it
        </Button>
      </div>

      {respond.isError && <ErrorNote message={respond.error.message} />}
      {withdraw.isError && <ErrorNote message={withdraw.error.message} />}
    </div>
  )
}

function Requests({
  dispute,
  deal,
  offers,
  pending,
}: {
  dispute: Dispute
  deal: Deal | undefined
  offers: DisputeOffer[]
  pending: boolean
}) {
  const now = simNow()

  if (pending) return <Skeleton className="h-24" />

  return (
    <div className="space-y-5">
      {offers.length === 0 ? (
        <p className="text-sm text-fg-muted">
          Nobody has asked for anything yet.
        </p>
      ) : (
        <ul className="space-y-2">
          {offers.map((offer) => (
            <li
              key={offer.id}
              className="flex flex-wrap items-start justify-between gap-3 rounded-xl bg-surface-2 px-4 py-3"
            >
              <div className="min-w-0">
                <p className="text-sm text-fg">
                  <span className="font-semibold">
                    {DISPUTE_OFFER_KIND_META[offer.kind].label}
                  </span>{' '}
                  by the {offer.offered_by}
                  {offer.amount !== null && deal
                    ? ` — ${formatMoney(offer.amount, deal.currency)}`
                    : ''}
                </p>
                {offer.note && (
                  <p className="mt-1 text-sm text-fg-muted">“{offer.note}”</p>
                )}
                <p className="mt-1 text-xs text-fg-subtle">
                  {formatDateTime(offer.created_at)}
                  {offer.responded_by_actor
                    ? ` · answered by ${offer.responded_by_actor}`
                    : offer.status === 'expired'
                      ? ' · nobody answered'
                      : ''}
                </p>
              </div>
              <Badge meta={DISPUTE_OFFER_STATUS_META[offer.status]} />
            </li>
          ))}
        </ul>
      )}

      {dispute.status === 'open' && (
        <MakeRequest dispute={dispute} deal={deal} offers={offers} now={now} />
      )}
    </div>
  )
}

/**
 * Recording a request one of the parties made.
 *
 * The side and the actor are separate fields on purpose: the side is whose
 * request this is, the actor is who wrote it down, and only the second is a
 * person with a login. Conflating them would put an operator's name on a
 * buyer's request as though the operator were the buyer.
 */
function MakeRequest({
  dispute,
  deal,
  offers,
  now,
}: {
  dispute: Dispute
  deal: Deal | undefined
  offers: DisputeOffer[]
  now: Date
}) {
  const { account } = useAuth()
  const actor = account?.full_name ?? account?.email ?? ''

  const [side, setSide] = useState<ConfirmSide>(dispute.raised_by)
  const [kind, setKind] = useState<DisputeOfferKind>('update')
  const [amount, setAmount] = useState('')
  const [extendTo, setExtendTo] = useState('')
  const [note, setNote] = useState('')

  const make = useMoneyAction(() =>
    api.makeDisputeOffer(dispute.id, side, actor, kind, {
      amount: kind === 'partial_refund' ? toMinor(amount) : undefined,
      extendTo: kind === 'extension' ? new Date(extendTo).toISOString() : undefined,
      note: note || undefined,
    }),
  )

  const alreadyOpen = offers.some((o) => o.status === 'open')
  // §8 allows one open request per **order**, so a second one is refused even
  // when this dispute has none. Say which it is rather than letting the engine.
  if (alreadyOpen) {
    return (
      <p className="text-sm text-fg-muted">
        A request on this order is still open. Only one runs at a time — answer
        or withdraw that one first.
      </p>
    )
  }

  const needsAmount = kind === 'partial_refund'
  const needsDate = kind === 'extension'
  const ready =
    !!actor &&
    (!needsAmount || toMinor(amount) > 0) &&
    (!needsDate || (!!extendTo && Date.parse(extendTo) > now.getTime()))

  return (
    <div className="space-y-4 rounded-xl bg-surface-2 px-4 py-4">
      <p className="text-[0.6875rem] font-semibold tracking-[0.06em] text-fg-subtle uppercase">
        Record a request
      </p>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Who is asking">
          <Select value={side} onChange={(e) => setSide(e.target.value as ConfirmSide)}>
            <option value="buyer">The buyer</option>
            <option value="seller">The seller</option>
          </Select>
        </Field>

        <Field label="What they want">
          <Select
            value={kind}
            onChange={(e) => setKind(e.target.value as DisputeOfferKind)}
          >
            {(Object.keys(DISPUTE_OFFER_KIND_META) as DisputeOfferKind[]).map((k) => (
              <option key={k} value={k}>
                {DISPUTE_OFFER_KIND_META[k].label}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <p className="text-sm text-fg-muted">{DISPUTE_OFFER_KIND_META[kind].hint}</p>

      {needsAmount && (
        <Field
          label={`Amount${deal ? ` (${deal.currency})` : ''}`}
          hint={
            dispute.disputed_amount !== null && deal
              ? `No more than ${formatMoney(dispute.disputed_amount, deal.currency)} — that is what is in dispute.`
              : 'Part of the payment. The rest is released.'
          }
        >
          <Input
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
          />
        </Field>
      )}

      {needsDate && (
        <Field label="New date" hint="Agreeing to it leaves the dispute open.">
          <Input
            type="date"
            value={extendTo}
            onChange={(e) => setExtendTo(e.target.value)}
          />
        </Field>
      )}

      <Field label="Note" hint="What they actually said. Shown to both sides.">
        <Textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Called to say the part arrived damaged and asked for half back…"
        />
      </Field>

      <p className="text-xs text-fg-muted">
        Recorded as {actor || 'nobody — you are not signed in'}. Whoever records
        a request has acted for a party, and §8 will not let them decide this
        dispute afterwards.
      </p>

      <Button
        variant="primary"
        disabled={!ready || make.isPending}
        onClick={() => make.mutate()}
      >
        {make.isPending ? 'Recording…' : 'Record the request'}
      </Button>

      {make.isError && <ErrorNote message={make.error.message} />}
    </div>
  )
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

function Decide({
  dispute,
  deal,
  offers,
}: {
  dispute: Dispute
  deal: Deal | undefined
  offers: DisputeOffer[]
}) {
  const { account } = useAuth()
  const actor = account?.full_name ?? account?.email ?? ''

  const [choice, setChoice] = useState<'release' | 'refund' | 'partial_refund' | null>(
    null,
  )
  const [note, setNote] = useState('')
  const [amount, setAmount] = useState('')

  const resolve = useMoneyAction(() =>
    // §8's decision record. The name comes from the session: a caller that can
    // name its own decider walks straight past the conflict-of-interest check.
    api.resolveDispute(
      dispute.id,
      choice!,
      note,
      actor,
      choice === 'partial_refund' ? toMinor(amount) : undefined,
    ),
  )

  const usage = useAiUsage()
  const suggestions = useAiSuggestions(dispute.deal_id)
  const draft = useAiAction(() => api.draftDisputeSuggestion(dispute.id))
  const decide = useMoneyMutation(
    ({ id, decision }: { id: string; decision: 'approved' | 'rejected' }) =>
      api.decideAiSuggestion(id, decision, actor),
  )

  const aiOff = usage.data && (!usage.data.enabled || usage.data.over_budget)
  const openDraft = suggestions.data?.find(
    (s) => s.decision === null && s.output.kind === 'dispute_resolution',
  )

  // §8's conflict-of-interest control, asked before the buttons rather than
  // after. The rule is on who *acted*: there is no identity to join a deciding
  // administrator to, since we store no buyer PII and a seller has no login.
  const acted =
    dispute.raised_by_actor === actor ||
    offers.some(
      (o) => o.offered_by_actor === actor || o.responded_by_actor === actor,
    )

  // A partial dispute cannot end in a full refund — `disputed_amount` is a
  // ceiling on what may be taken from the seller.
  const partialOnly =
    dispute.disputed_amount !== null && !!deal && dispute.disputed_amount < deal.amount

  const options = [
    { key: 'release', label: 'Release to seller', refused: null as string | null },
    {
      key: 'refund',
      label: 'Refund the buyer',
      refused: partialOnly
        ? 'Only part of this payment is in dispute — resolve it as a partial refund.'
        : null,
    },
    { key: 'partial_refund', label: 'Refund part, release the rest', refused: null },
  ] as const

  const needsAmount = choice === 'partial_refund'
  const ready =
    !!choice &&
    !!note &&
    !!actor &&
    !acted &&
    (!needsAmount || toMinor(amount) > 0)

  return (
    <div className="space-y-4">
      {openDraft ? (
        <AiSuggestionCard
          suggestion={openDraft}
          variant="inline"
          dealLink={false}
          pending={decide.isPending}
          error={decide.isError ? decide.error.message : undefined}
          onDecide={(decision) => decide.mutate({ id: openDraft.id, decision })}
        />
      ) : aiOff && usage.data ? (
        <AiUnavailable usage={usage.data} />
      ) : (
        <DraftButton
          label="Ask the assistant to draft a resolution"
          pending={draft.isPending}
          error={draft.isError ? draft.error.message : undefined}
          onClick={() => draft.mutate()}
        />
      )}

      <p className="text-[0.6875rem] font-semibold tracking-[0.06em] text-fg-subtle uppercase">
        {openDraft ? 'Or decide yourself' : 'Decide'}
      </p>

      {acted ? (
        <p className="rounded-xl bg-surface-2 px-4 py-3 text-sm text-fg-muted">
          <span className="font-semibold text-fg">
            You acted for a party in this dispute.
          </span>{' '}
          Raising it, making a request or answering one disqualifies you from
          ruling on it. Somebody else has to decide this one.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            {options.map((option) => (
              <button
                key={option.key}
                disabled={!!option.refused}
                title={option.refused ?? undefined}
                onClick={() => setChoice(option.key)}
                className={cx(
                  'rounded-lg px-3 py-2 text-sm font-medium ring-1 ring-inset transition',
                  'disabled:pointer-events-none disabled:opacity-45',
                  choice === option.key
                    ? 'bg-brand-soft text-brand ring-brand/30'
                    : 'bg-surface text-fg-muted ring-line hover:text-fg',
                )}
              >
                {option.label}
              </button>
            ))}
          </div>

          {options.find((o) => o.refused) && (
            <p className="text-xs text-fg-muted">
              {options.find((o) => o.refused)!.refused}
            </p>
          )}

          {choice && (
            <div className="space-y-3">
              {needsAmount && (
                <Field
                  label={`Refund the buyer${deal ? ` (${deal.currency})` : ''}`}
                  hint={
                    dispute.disputed_amount !== null && deal
                      ? `No more than ${formatMoney(dispute.disputed_amount, deal.currency)}. The rest is released to the seller.`
                      : 'The rest is released to the seller.'
                  }
                >
                  <Input
                    inputMode="decimal"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="0.00"
                  />
                </Field>
              )}

              <Field
                label="Resolution note"
                hint="Written to the audit trail and sent to both sides."
              >
                <Textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Photos show the damage predates collection…"
                />
              </Field>

              <p className="text-xs text-fg-muted">
                Recorded against {actor || 'nobody — you are not signed in'}.
              </p>

              <Button
                variant={choice === 'release' ? 'primary' : 'danger'}
                disabled={!ready || resolve.isPending}
                onClick={() => resolve.mutate()}
              >
                {resolve.isPending ? 'Resolving…' : 'Confirm the decision'}
              </Button>
            </div>
          )}
        </>
      )}

      {resolve.isError && <ErrorNote message={resolve.error.message} />}
    </div>
  )
}

// ---------------------------------------------------------------------------

/** §8's timeline: one ordered list, derived rather than stored. */
function Timeline({ disputeId }: { disputeId: string }) {
  const timeline = useDisputeTimeline(disputeId)

  if (timeline.isPending) return <Skeleton className="h-32" />
  if (!timeline.data?.length) {
    return <p className="text-sm text-fg-muted">Nothing recorded yet.</p>
  }

  return (
    <ol className="space-y-3">
      {timeline.data.map((event, i) => (
        <li key={`${event.at}-${i}`} className="flex gap-3">
          <div className="flex flex-col items-center pt-1.5">
            <span className="size-1.5 rounded-full bg-fg-subtle" />
            {i < timeline.data.length - 1 && (
              <span className="mt-1 w-px flex-1 bg-line" />
            )}
          </div>
          <div className="min-w-0 pb-1">
            <p className="text-sm text-fg">{event.summary}</p>
            <p className="text-xs text-fg-subtle">
              {formatDateTime(event.at)} · {event.actor}
              {event.side ? ` (${event.side})` : ''}
            </p>
          </div>
        </li>
      ))}
    </ol>
  )
}

/**
 * Major units in the form, minor units on the wire — the boundary conversion
 * every form in this dashboard does. Zero-decimal currencies are stored x100
 * like everything else, so they convert identically.
 */
function toMinor(input: string): Money {
  const value = Number.parseFloat(input)
  return Number.isFinite(value) ? Math.round(value * 100) : 0
}
