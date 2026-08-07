import { Link, useParams } from 'react-router-dom'
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Mono,
  PageHeader,
  Skeleton,
  StatTile,
  Table,
  Td,
  Th,
} from '@/components/ui'
import { ProviderChip } from '@/components/rails'
import {
  DEAL_STATUS_META,
  PAYOUT_STATUS_META,
  formatDate,
  formatDateTime,
  formatMoney,
  formatRelative,
  type StatusMeta,
} from '@/lib/format'
import {
  COUNTRY_LABEL,
  countryFlag,
  countryName,
  PAYOUT_PROVIDER_LABEL,
  payoutRoute,
} from '@/lib/rails'
import {
  simNow,
  useDeals,
  useDisputes,
  usePayouts,
  useRequestContext,
  useRiskSignals,
  useSellers,
} from '@/lib/queries'
import type { Currency, Money, RiskSeverity } from '@/api'

/**
 * One counterparty, everything this account knows about them.
 *
 * This page exists because the Fraud screen names people and a name is not
 * something anyone can decide on. A payout held for review is a question about
 * a seller — how long they have been here, what they have been paid before,
 * whether a dispute has gone against them — and the answer was previously
 * spread across four screens that each showed a fragment of it.
 *
 * It is a record, not a verdict. Nothing here scores anybody and there is no
 * action on this page: clearing a hold lives on Payouts, where the approval is
 * recorded against the person who made it.
 *
 * The one number worth explaining is **how old the seller was when each deal
 * was created**, shown per deal rather than as a single "registered" date. That
 * is the figure the new-seller rule fires on, and it is measured at the deal's
 * creation for a reason: with a seven-day clearance window every seller is a
 * week old by the time their first payout comes due, so measuring it at payout
 * time would make the rule unfireable.
 */
export function SellerDetailPage() {
  const { id = '' } = useParams()
  const sellers = useSellers()
  const deals = useDeals()
  const payouts = usePayouts()
  const disputes = useDisputes()
  const signals = useRiskSignals()
  const context = useRequestContext()
  const now = simNow()

  if (sellers.isPending) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-32" />
        <Skeleton className="h-60" />
      </div>
    )
  }

  const seller = sellers.data?.find((s) => s.id === id)

  if (!seller) {
    return (
      <Card>
        <EmptyState
          title="Seller not found"
          body="They may belong to another account, or the id is wrong."
          action={
            <Link to="/sellers">
              <Button>Back to sellers</Button>
            </Link>
          }
        />
      </Card>
    )
  }

  const theirDeals = (deals.data ?? []).filter((d) => d.seller_id === seller.id)
  const dealIds = new Set(theirDeals.map((d) => d.id))
  const theirPayouts = (payouts.data ?? []).filter((p) => p.seller_id === seller.id)
  const theirDisputes = (disputes.data ?? []).filter((d) => dealIds.has(d.deal_id))
  const theirSignals = (signals.data ?? []).filter(
    (s) => s.seller_id === seller.id || dealIds.has(s.deal_id),
  )
  const theirOrigins = (context.data ?? []).filter((r) => dealIds.has(r.deal_id))

  const held = theirPayouts.filter((p) => p.status === 'held_for_review')
  const paid = theirPayouts.filter((p) => p.status === 'paid')
  // A dispute that ended in a refund is one the seller lost. `open` is not a
  // mark against anybody yet, and the count above says so separately.
  const lost = theirDisputes.filter((d) => d.status === 'resolved_refunded')

  const paidTotal = sumByCurrency(paid.map((p) => [p.amount, p.currency]))
  const route = payoutRoute(seller.country, seller.payout_currency)
  const registered = new Date(seller.created_at)

  /** How old the seller was when a deal was created — the rule's own measure. */
  const ageAtDeal = (createdAt: string) => {
    const hours = (new Date(createdAt).getTime() - registered.getTime()) / 3_600_000
    if (hours < 0) return '—'
    if (hours < 1) return 'under an hour'
    if (hours < 48) return `${Math.floor(hours)}h`
    return `${Math.floor(hours / 24)}d`
  }

  const buyerOf = (dealId: string) =>
    theirDeals.find((d) => d.id === dealId)?.buyer_ref ?? '—'

  return (
    <>
      <Link to="/sellers" className="mb-3 inline-block text-sm text-fg-muted hover:text-fg">
        ← Sellers
      </Link>

      <PageHeader
        title={seller.name}
        subtitle={`${countryFlag(seller.country)} ${countryName(seller.country)} · registered ${formatDate(seller.created_at)} (${formatRelative(seller.created_at, now)})`}
      />

      <div className="mb-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Deals"
          value={String(theirDeals.length)}
          hint={`${theirDeals.filter((d) => d.status === 'funded_held').length} holding money now`}
        />
        <StatTile
          label="Paid out"
          value={paidTotal.length ? paidTotal.map(([a, c]) => formatMoney(a, c)).join(' · ') : '—'}
          hint={`${paid.length} transfer${paid.length === 1 ? '' : 's'} completed`}
          tone="released"
        />
        <StatTile
          label="Disputes"
          value={String(theirDisputes.length)}
          hint={`${lost.length} resolved against them`}
          tone={lost.length > 0 ? 'pending' : 'neutral'}
        />
        <StatTile
          label="Payouts held"
          value={String(held.length)}
          hint="Waiting on a person, on the Payouts screen"
          tone={held.length > 0 ? 'danger' : 'neutral'}
        />
      </div>

      {/* -- Who they are ----------------------------------------------------- */}

      <Card className="mb-8">
        <CardHeader
          title="Payout destination"
          subtitle="Tokenized by the provider. PayHold never stores the real number."
        />
        <dl className="grid gap-x-8 gap-y-5 px-6 pb-6 sm:grid-cols-2 lg:grid-cols-3">
          <Detail label="Seller id" value={<Mono>{seller.id}</Mono>} />
          <Detail label="Method" value={PAYOUT_PROVIDER_LABEL[seller.payout_provider]} />
          <Detail label="Destination" value={<Mono>{seller.masked_destination}</Mono>} />
          <Detail label="Paid in" value={seller.payout_currency} />
          <Detail
            label="Paid via"
            value={
              route.provider ? (
                <ProviderChip provider={route.provider} />
              ) : (
                <span className="text-xs font-semibold text-danger">No rail</span>
              )
            }
            hint={route.reason}
          />
          <Detail label="Registered" value={formatDateTime(seller.created_at)} />
        </dl>
      </Card>

      {/* -- Deals ------------------------------------------------------------ */}

      <Card className="mb-8">
        <CardHeader
          title="Their deals"
          subtitle="Newest first. “Age at creation” is what the new-seller rule measures — how long they had been registered when the deal was made."
        />
        {theirDeals.length === 0 ? (
          <EmptyState
            title="No deals yet"
            body="This seller is registered but has never been on a deal."
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Deal</Th>
                <Th>Buyer</Th>
                <Th>What</Th>
                <Th>Status</Th>
                <Th align="right">Amount</Th>
                <Th align="right">Age at creation</Th>
                <Th align="right">Created</Th>
              </tr>
            </thead>
            <tbody>
              {[...theirDeals]
                .sort((a, b) => b.created_at.localeCompare(a.created_at))
                .map((d) => (
                  <tr key={d.id} className="hover:bg-surface-2">
                    <Td>
                      <Link className="text-brand hover:underline" to={`/deals/${d.id}`}>
                        <Mono>{d.id}</Mono>
                      </Link>
                    </Td>
                    <Td className="text-fg-muted">
                      <Mono>{d.buyer_ref}</Mono>
                    </Td>
                    <Td className="max-w-56 truncate">{d.description}</Td>
                    <Td>
                      <Badge meta={DEAL_STATUS_META[d.status]} />
                    </Td>
                    <Td align="right" className="tabular font-medium">
                      {formatMoney(d.amount, d.currency)}
                    </Td>
                    <Td align="right" className="tabular text-fg-muted">
                      {ageAtDeal(d.created_at)}
                    </Td>
                    <Td align="right" className="text-fg-muted">
                      {formatDate(d.created_at)}
                    </Td>
                  </tr>
                ))}
            </tbody>
          </Table>
        )}
      </Card>

      {/* -- Payouts ---------------------------------------------------------- */}

      <Card className="mb-8">
        <CardHeader
          title="What they have been paid"
          subtitle="The history a jump-past-3× rule compares against."
        />
        {theirPayouts.length === 0 ? (
          <EmptyState
            title="Never paid"
            body="No payout has been dispatched to this seller. A first payout is one of the things the rules look at."
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Deal</Th>
                <Th>Status</Th>
                <Th align="right">Amount</Th>
                <Th>Cleared by</Th>
                <Th align="right">Due</Th>
              </tr>
            </thead>
            <tbody>
              {[...theirPayouts]
                .sort((a, b) => b.scheduled_for.localeCompare(a.scheduled_for))
                .map((p) => (
                  <tr key={p.id} className="hover:bg-surface-2">
                    <Td>
                      <Link className="text-brand hover:underline" to={`/deals/${p.deal_id}`}>
                        <Mono>{p.deal_id}</Mono>
                      </Link>
                    </Td>
                    <Td>
                      <Badge meta={PAYOUT_STATUS_META[p.status]} />
                      {p.failure_reason && (
                        <p className="mt-1 max-w-56 text-xs text-danger">
                          {p.failure_reason}
                        </p>
                      )}
                    </Td>
                    <Td align="right" className="tabular font-medium">
                      {formatMoney(p.amount, p.currency)}
                    </Td>
                    <Td className="text-fg-muted">
                      {p.review_approved_by ? (
                        <>
                          {p.review_approved_by}
                          <span className="block text-xs text-fg-subtle">
                            {formatDateTime(p.review_approved_at)}
                          </span>
                        </>
                      ) : (
                        '—'
                      )}
                    </Td>
                    <Td align="right" className="text-fg-muted">
                      {formatRelative(p.paid_at ?? p.scheduled_for, now)}
                    </Td>
                  </tr>
                ))}
            </tbody>
          </Table>
        )}
      </Card>

      {/* -- Signals ---------------------------------------------------------- */}

      <Card className="mb-8">
        <CardHeader
          title="Signals on this seller"
          subtitle="Recorded whether or not the rules are switched on. Most of these held nothing."
        />
        {theirSignals.length === 0 ? (
          <EmptyState
            title="Nothing noticed"
            body="No rule has fired on a deal of theirs."
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>What</Th>
                <Th>Deal</Th>
                <Th>When</Th>
              </tr>
            </thead>
            <tbody>
              {theirSignals.map((s) => (
                <tr key={s.id} className="hover:bg-surface-2">
                  <Td>
                    <span className="flex items-start gap-2">
                      <Badge meta={SEVERITY_META[s.severity]} />
                      <span className="text-sm leading-relaxed">{s.explanation}</span>
                    </span>
                  </Td>
                  <Td>
                    <Link className="text-brand hover:underline" to={`/deals/${s.deal_id}`}>
                      <Mono>{s.deal_id}</Mono>
                    </Link>
                  </Td>
                  <Td className="text-fg-muted">{formatDateTime(s.created_at)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {/* -- Origins ---------------------------------------------------------- */}

      <Card>
        <CardHeader
          title="Where their buyers paid from"
          subtitle="Observation only, and the weakest thing on this page. Mobile money runs behind carrier-grade NAT, so a shared address is usually a carrier rather than a person."
        />
        {theirOrigins.length === 0 ? (
          <EmptyState
            title="No origins recorded"
            body="Origins are captured when a payment starts and again when the provider confirms it."
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Address</Th>
                <Th>Deal</Th>
                <Th>Buyer</Th>
                <Th>Event</Th>
                <Th>When</Th>
              </tr>
            </thead>
            <tbody>
              {theirOrigins.map((row) => (
                <tr key={row.id} className="hover:bg-surface-2">
                  <Td>
                    <Mono>{row.ip ?? 'not reported'}</Mono>
                    {row.ip_country && (
                      <span className="ml-2 text-xs text-fg-subtle">
                        {COUNTRY_LABEL[row.ip_country] ?? row.ip_country}
                      </span>
                    )}
                  </Td>
                  <Td>
                    <Link className="text-brand hover:underline" to={`/deals/${row.deal_id}`}>
                      <Mono>{row.deal_id}</Mono>
                    </Link>
                  </Td>
                  <Td className="text-fg-muted">
                    <Mono>{buyerOf(row.deal_id)}</Mono>
                  </Td>
                  <Td className="text-fg-muted">{row.event}</Td>
                  <Td className="text-fg-muted">{formatDateTime(row.created_at)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <p className="mt-6 border-t border-line pt-5 text-xs leading-relaxed text-fg-muted">
        Buyers appear here as the reference your own site sent us. PayHold stores
        no buyer names, numbers or addresses beyond that — which is why the same
        buyer showing up twice is something you can see and we cannot name.
      </p>
    </>
  )
}

/** Same two words the Fraud screen uses, so a signal reads identically here. */
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

function Detail({
  label,
  value,
  hint,
}: {
  label: string
  value: React.ReactNode
  hint?: string
}) {
  return (
    <div>
      <dt className="text-xs font-semibold tracking-[0.06em] text-fg-muted uppercase">
        {label}
      </dt>
      <dd className="mt-1.5 text-sm text-fg">{value}</dd>
      {hint && <dd className="mt-1 text-xs leading-relaxed text-fg-muted">{hint}</dd>}
    </div>
  )
}

/**
 * Totals per currency rather than one number. A seller is paid in one currency
 * today, but adding the two together the day that stops being true would be a
 * figure that means nothing.
 */
function sumByCurrency(rows: [Money, Currency][]): [Money, Currency][] {
  const totals = new Map<Currency, Money>()
  for (const [amount, currency] of rows) {
    totals.set(currency, (totals.get(currency) ?? 0) + amount)
  }
  return [...totals].map(([currency, amount]) => [amount, currency])
}
