import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  ErrorNote,
  Mono,
  PageHeader,
  Skeleton,
  StatTile,
  Table,
  Td,
  Th,
} from '@/components/ui'
import { ProviderChip } from '@/components/rails'
import { useAuth } from '@/auth/AuthProvider'
import {
  DEAL_STATUS_META,
  KYC_STATUS_META,
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
  useDeals,
  useDisputes,
  useMoneyMutation,
  usePayouts,
  useRequestContext,
  useRiskSignals,
  useSellerCapabilities,
  useSellerDestinations,
  useSellers,
} from '@/lib/queries'
import { api, type Currency, type Money, type RiskSeverity, type Seller } from '@/api'

/**
 * One counterparty, everything this account knows about them.
 *
 * This page exists because the Fraud screen names people and a name is not
 * something anyone can decide on. A payout held for review is a question about
 * a seller — how long they have been here, what they have been paid before,
 * whether a dispute has gone against them — and the answer was previously
 * spread across four screens that each showed a fragment of it.
 *
 * It is a record, not a verdict. Nothing here scores anybody, and the one
 * action it carries is **not** a payout decision: clearing a hold still lives on
 * Payouts, because a hold is a question about one payment. Attesting that a
 * seller's identity, sanctions screen and ownership came back is a fact about
 * this seller and has nowhere else it could live — §12 says a person must
 * record it, and this is the page that person is looking at.
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
  const now = new Date()

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

      {/* -- Onboarding ------------------------------------------------------- */}

      <Onboarding seller={seller} now={now} />

      {/* -- Who they are ----------------------------------------------------- */}

      <Card className="mb-8">
        <CardHeader
          title="Payout destinations"
          subtitle="Tokenized by the provider. PayHold never stores the real number. §5.1 gives a seller a preferred destination and, optionally, one verified backup."
        />
        <dl className="grid gap-x-8 gap-y-5 px-6 pb-6 sm:grid-cols-2 lg:grid-cols-3">
          <Detail label="Seller id" value={<Mono>{seller.id}</Mono>} />
          <Detail label="Method" value={PAYOUT_PROVIDER_LABEL[seller.payout_provider]} />
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

        <Destinations sellerId={seller.id} now={now} />
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

/**
 * §12's gate, from the seller's side of it.
 *
 * `getSellerCapabilities` returns **every** reason rather than the first,
 * because a seller told to fix one thing at a time discovers the next one three
 * weeks later as a held payout. The two lists stay apart on screen for the same
 * reason they are apart in the API: one is work for them, the other is work for
 * us, and a routing gap put in the first column would send a verified seller
 * back to verify themselves again.
 */
function Onboarding({ seller, now }: { seller: Seller; now: Date }) {
  const { account } = useAuth()
  const capabilities = useSellerCapabilities(seller.id)
  const [confirming, setConfirming] = useState(false)

  // Recorded against whoever is signed in, never a name from a form: a caller
  // that can name its own verifier can forge one.
  const actor = account?.full_name ?? account?.email ?? ''
  const verify = useMoneyMutation((verified: boolean) =>
    api.verifySeller(seller.id, verified),
  )

  const cap = capabilities.data

  return (
    <Card className="mb-8">
      <CardHeader
        title="Onboarding"
        subtitle="§12: a seller must not be paid because a payment webhook said “success”. Somebody has to say the checks came back."
        action={<Badge meta={KYC_STATUS_META[seller.kyc_status]} />}
      />

      <div className="grid gap-x-8 gap-y-5 px-6 pb-6 sm:grid-cols-2">
        <div>
          <dl className="space-y-5">
            <Detail
              label="Sanctions screened"
              value={
                seller.sanctions_checked_at
                  ? `${formatDate(seller.sanctions_checked_at)} (${formatRelative(seller.sanctions_checked_at, now)})`
                  : 'Never'
              }
              hint="Not a boolean — the question is “recently enough”, not “ever”."
            />
            <Detail
              label="Destination last changed"
              value={
                seller.destination_changed_at
                  ? formatRelative(seller.destination_changed_at, now)
                  : 'Never moved'
              }
              hint="§5.1's change protection: a destination that just moved holds the next payout, so a stolen session cannot redirect money and have it leave before anyone notices."
            />
          </dl>
        </div>

        <div>
          {capabilities.isPending ? (
            <Skeleton className="h-24" />
          ) : cap?.can_receive_payouts ? (
            <p className="rounded-xl bg-released-soft px-4 py-3 text-sm leading-relaxed text-released">
              This seller can be paid. Nothing is outstanding and a route reaches
              them.
            </p>
          ) : (
            <div className="space-y-3">
              {cap && cap.reasons.length > 0 && (
                <div className="rounded-xl bg-pending-soft px-4 py-3">
                  <p className="text-xs font-semibold tracking-[0.06em] text-pending uppercase">
                    Outstanding — holds their payouts
                  </p>
                  <ul className="mt-2 space-y-1 text-sm leading-relaxed text-fg">
                    {cap.reasons.map((reason) => (
                      <li key={reason}>{reason}</li>
                    ))}
                  </ul>
                </div>
              )}
              {cap && cap.route_reasons.length > 0 && (
                <div className="rounded-xl bg-surface-2 px-4 py-3">
                  <p className="text-xs font-semibold tracking-[0.06em] text-fg-muted uppercase">
                    PayHold cannot reach them
                  </p>
                  <ul className="mt-2 space-y-1 text-sm leading-relaxed text-fg">
                    {cap.route_reasons.map((reason) => (
                      <li key={reason}>{reason}</li>
                    ))}
                  </ul>
                  <p className="mt-2 text-xs leading-relaxed text-fg-muted">
                    Nothing here is theirs to fix, and none of it asks them to verify
                    anything again. It blocks the payout rather than holding it for
                    verification.
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="border-t border-line px-6 py-4">
        {seller.kyc_status === 'verified' ? (
          <div className="flex flex-wrap items-center gap-3">
            <p className="flex-1 text-xs leading-relaxed text-fg-muted">
              Verified. Withdrawing it moves them to “needs review” and holds their
              payouts again — it does not stop a transfer already with the provider.
            </p>
            <Button
              size="sm"
              variant="ghost"
              disabled={verify.isPending || !actor}
              onClick={() => verify.mutate(false)}
            >
              Withdraw verification
            </Button>
          </div>
        ) : confirming ? (
          <div className="space-y-3">
            <p className="text-sm leading-relaxed text-fg">
              You are recording that the identity check, the sanctions screen and the
              ownership check came back for {seller.name}. It is written against{' '}
              <strong className="font-semibold">{actor}</strong> and it is what makes
              their payouts payable.
            </p>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="primary"
                disabled={verify.isPending || !actor}
                onClick={() => verify.mutate(true)}
              >
                {verify.isPending ? 'Recording…' : 'Yes, they came back'}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <p className="flex-1 text-xs leading-relaxed text-fg-muted">
              PayHold does not run these checks. Verifying records that you did, and
              your name goes on it.
            </p>
            <Button size="sm" variant="primary" onClick={() => setConfirming(true)}>
              Verify this seller
            </Button>
          </div>
        )}

        {verify.isError && (
          <div className="mt-3">
            <ErrorNote message={verify.error.message} />
          </div>
        )}
      </div>
    </Card>
  )
}

/**
 * §5.1's `seller_destinations`. The primary is the record;
 * `Seller.beneficiary_token` and `masked_destination` are its copy, kept in
 * step by a trigger with exactly one writer.
 *
 * The backup is read-only here and deliberately so: it is used only after a
 * failed primary, `payout_primary_attempts` attempts, an explicit policy check,
 * and its own verification and security hold. A button that could pick it would
 * be the silent redirection §5.1 forbids.
 */
function Destinations({ sellerId, now }: { sellerId: string; now: Date }) {
  const destinations = useSellerDestinations(sellerId)

  if (destinations.isPending) {
    return (
      <div className="px-6 pb-6">
        <Skeleton className="h-16" />
      </div>
    )
  }

  if (!destinations.data?.length) {
    return (
      <EmptyState
        title="No destination registered"
        body="A seller without one is unpayable for a reason nobody chose."
      />
    )
  }

  return (
    <Table>
      <thead>
        <tr>
          <Th>Role</Th>
          <Th>Destination</Th>
          <Th>Method</Th>
          <Th>Market</Th>
          <Th>Paid in</Th>
          <Th align="right">Verified</Th>
        </tr>
      </thead>
      <tbody>
        {destinations.data.map((d) => {
          const onHold =
            d.security_hold_until !== null && new Date(d.security_hold_until) > now
          return (
            <tr key={d.id}>
              <Td className="font-medium">
                {d.is_primary ? 'Preferred' : d.is_backup ? 'Backup' : 'Other'}
                {d.label && (
                  <span className="block text-xs text-fg-muted">{d.label}</span>
                )}
              </Td>
              <Td>
                <Mono>{d.masked_destination}</Mono>
              </Td>
              <Td className="text-fg-muted">
                {PAYOUT_PROVIDER_LABEL[d.payout_provider]}
              </Td>
              <Td className="text-fg-muted">
                {countryFlag(d.country)} {countryName(d.country)}
              </Td>
              <Td className="tabular text-fg-muted">{d.payout_currency}</Td>
              <Td align="right" className="text-fg-muted">
                {d.verified_at ? (
                  formatDate(d.verified_at)
                ) : (
                  <span className="font-semibold text-danger">Not verified</span>
                )}
                {onHold && (
                  <span className="block text-xs text-pending">
                    In its security hold until {formatDateTime(d.security_hold_until)}
                  </span>
                )}
              </Td>
            </tr>
          )
        })}
      </tbody>
    </Table>
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
