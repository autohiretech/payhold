/**
 * The Routing Center — spec §5.1.
 *
 * Three questions, in the order somebody actually asks them:
 *
 *   1. **What is stopped, and why?** Every payout that is not moving, with the
 *      recorded decision behind it and every route that was considered.
 *   2. **Where can money go at all?** `payout_routes`, which is data rather than
 *      code precisely so a corridor can be closed without a deploy.
 *   3. **Where would it land?** Every destination this account has registered,
 *      and whether it is verified.
 *
 * The screen is **read-only, and that is structural**. Enablement is a row an
 * operator changes deliberately, and a dashboard that could switch its own
 * corridors on would have turned §5's country-launch checklist into a field it
 * sets. Nothing here moves money either: the one button that ends a hold is on
 * Payouts, where the approval is recorded against a person.
 */

import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQueries } from '@tanstack/react-query'
import {
  api,
  type Payout,
  type PayoutRouting,
  type PayoutStatus,
  type RouteCheck,
} from '@/api'
import { ProviderChip } from '@/components/rails'
import {
  Badge,
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
  cx,
} from '@/components/ui'
import {
  PAYOUT_STATUS_META,
  formatDateTime,
  formatMoney,
  formatRelative,
} from '@/lib/format'
import {
  countryFlag,
  countryName,
  PAYOUT_PROVIDER_LABEL,
  routeReasonText,
} from '@/lib/rails'
import {
  keys,
  usePayoutRoutes,
  usePayouts,
  useSellerDestinations,
  useSellers,
} from '@/lib/queries'

/**
 * The payouts worth explaining: everything that is stopped.
 *
 * `scheduled` is absent because a scheduled payout is not stopped — it is
 * waiting for a date, which the deal already says. Putting it here would fill
 * the queue with rows nobody has to do anything about, which is how a queue
 * stops being read.
 */
const STUCK: PayoutStatus[] = [
  'blocked',
  'needs_verification',
  'held_for_review',
  'frozen',
  'failed',
]

export function RoutingPage() {
  const payouts = usePayouts()
  const routes = usePayoutRoutes()
  const sellers = useSellers()
  const destinations = useSellerDestinations()
  const now = new Date()

  const stuck = (payouts.data ?? []).filter((p) => STUCK.includes(p.status))

  // One routing read per stopped payout, which is what the API actually
  // offers — the decision hangs off a payout and there is no bulk endpoint.
  // Scoped to the stopped ones so a busy account does not fetch a decision for
  // every payout it has ever made.
  const routings = useQueries({
    queries: stuck.map((p) => ({
      queryKey: keys.payoutRouting(p.id),
      queryFn: () => api.getPayoutRouting(p.id),
    })),
  })

  const sellerFor = (id: string) => sellers.data?.find((s) => s.id === id)

  const live = (routes.data ?? []).filter((r) => r.enabled && r.supports_payouts)
  const unverifiedDestinations = (destinations.data ?? []).filter((d) => !d.verified_at)

  return (
    <>
      <PageHeader
        title="Routing Center"
        subtitle="Which rail carries a payout, why, and what is stopping the ones that are stopped."
      />

      <div className="mb-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Payouts stopped"
          value={String(stuck.length)}
          hint="Each has a recorded reason below"
          tone={stuck.length > 0 ? 'pending' : 'neutral'}
        />
        <StatTile
          label="Rails on"
          value={`${live.length} of ${routes.data?.length ?? 0}`}
          hint="The rest are declared and switched off"
        />
        <StatTile
          label="Destinations"
          value={String(destinations.data?.length ?? 0)}
          hint={`${unverifiedDestinations.length} not yet verified`}
          tone={unverifiedDestinations.length > 0 ? 'pending' : 'neutral'}
        />
        <StatTile
          label="Sellers"
          value={String(sellers.data?.length ?? 0)}
          hint="Each needs at least one destination to be payable"
        />
      </div>

      {/* -- 1. What is stopped ------------------------------------------------ */}

      <Card className="mb-8">
        <CardHeader
          title="Payouts that are not moving"
          subtitle="The decision behind each one, kept because §5.1 requires a routing choice be auditable after the fact — not re-derived now, which would answer a different question."
        />
        {payouts.isPending ? (
          <div className="space-y-2 p-6">
            {[0, 1].map((i) => (
              <Skeleton key={i} className="h-9" />
            ))}
          </div>
        ) : stuck.length === 0 ? (
          <EmptyState
            title="Nothing is stopped"
            body="Every scheduled payout has a route and nothing is waiting on a person."
          />
        ) : (
          <ul className="divide-y divide-line">
            {stuck.map((p, i) => (
              <StuckPayout
                key={p.id}
                payout={p}
                sellerName={sellerFor(p.seller_id)?.name}
                routing={routings[i]?.data}
                loading={routings[i]?.isPending ?? true}
                now={now}
              />
            ))}
          </ul>
        )}
      </Card>

      {/* -- 2. Where money can go --------------------------------------------- */}

      <Card className="mb-8">
        <CardHeader
          title="The routing table"
          subtitle="Data, not code — §12 requires a country or a rail to be switchable without a redeploy. Read-only here: a client that could switch its own corridors on has turned the country-launch checklist into a field it sets."
        />
        {routes.isPending ? (
          <div className="space-y-2 p-6">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-9" />
            ))}
          </div>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Rail</Th>
                <Th>Adapter</Th>
                <Th>Reaches</Th>
                <Th>Currencies</Th>
                <Th align="right">Rank</Th>
                <Th align="right">Fee</Th>
                <Th align="right">State</Th>
              </tr>
            </thead>
            <tbody>
              {[...(routes.data ?? [])]
                .sort(
                  (a, b) =>
                    Number(b.enabled) - Number(a.enabled) ||
                    a.rank - b.rank ||
                    a.payout_provider.localeCompare(b.payout_provider),
                )
                .map((r) => (
                  <tr key={r.id} className={cx(!r.enabled && 'opacity-70')}>
                    <Td className="font-medium">
                      {PAYOUT_PROVIDER_LABEL[r.payout_provider]}
                      {r.tenant_id !== null && (
                        <span className="ml-2 text-xs text-brand">yours</span>
                      )}
                      {r.note && (
                        <span className="mt-0.5 block max-w-64 text-xs leading-relaxed text-fg-muted">
                          {r.note}
                        </span>
                      )}
                    </Td>
                    <Td>
                      <ProviderChip provider={r.provider} />
                    </Td>
                    <Td className="max-w-56 text-fg-muted">
                      {r.countries.length
                        ? r.countries.map((c) => countryFlag(c)).join(' ')
                        : '—'}
                    </Td>
                    <Td className="tabular text-fg-muted">
                      {r.currencies.join(', ') || '—'}
                    </Td>
                    <Td align="right" className="tabular text-fg-muted">
                      {r.rank}
                    </Td>
                    <Td align="right" className="tabular text-fg-muted">
                      {r.fee_fixed > 0 || r.fee_bps > 0
                        ? [
                            r.fee_fixed > 0 && formatMoney(r.fee_fixed, r.currencies[0] ?? 'USD'),
                            r.fee_bps > 0 && `${r.fee_bps / 100}%`,
                          ]
                            .filter(Boolean)
                            .join(' + ')
                        : 'none'}
                    </Td>
                    <Td align="right">
                      <Badge meta={ROUTE_STATE[routeState(r.enabled, r.supports_payouts, r.risk_status)]} />
                    </Td>
                  </tr>
                ))}
            </tbody>
          </Table>
        )}
        <p className="border-t border-line px-6 py-4 text-xs leading-relaxed text-fg-muted">
          A rail with no adapter built cannot be enabled — the database refuses
          it rather than a reviewer catching it. That is why five of these are
          declared and off: a seller who picks one gets a specific sentence
          instead of “unknown destination type”.
        </p>
      </Card>

      {/* -- 3. Where money would land ----------------------------------------- */}

      <Card>
        <CardHeader
          title="Destinations"
          subtitle="§5.1: a preferred destination and, optionally, one verified backup. A route is never a fallback for another route — the fallback is the seller's second destination, and only after a failed primary."
        />
        {destinations.isPending ? (
          <div className="space-y-2 p-6">
            {[0, 1].map((i) => (
              <Skeleton key={i} className="h-9" />
            ))}
          </div>
        ) : !destinations.data?.length ? (
          <EmptyState
            title="No destinations"
            body="Register a seller and one is created with them."
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Seller</Th>
                <Th>Role</Th>
                <Th>Destination</Th>
                <Th>Method</Th>
                <Th>Market</Th>
                <Th align="right">Verified</Th>
              </tr>
            </thead>
            <tbody>
              {destinations.data.map((d) => {
                const onHold =
                  d.security_hold_until !== null &&
                  new Date(d.security_hold_until) > now
                return (
                  <tr key={d.id} className="hover:bg-surface-2">
                    <Td className="font-medium">
                      <Link
                        className="text-brand hover:underline"
                        to={`/sellers/${d.seller_id}`}
                      >
                        {sellerFor(d.seller_id)?.name ?? d.seller_id}
                      </Link>
                    </Td>
                    <Td className="text-fg-muted">
                      {d.is_primary ? 'Preferred' : d.is_backup ? 'Backup' : 'Other'}
                    </Td>
                    <Td>
                      <Mono>{d.masked_destination}</Mono>
                    </Td>
                    <Td className="text-fg-muted">
                      {PAYOUT_PROVIDER_LABEL[d.payout_provider]} · {d.payout_currency}
                    </Td>
                    <Td className="text-fg-muted">
                      {countryFlag(d.country)} {countryName(d.country)}
                    </Td>
                    <Td align="right" className="text-fg-muted">
                      {d.verified_at ? (
                        formatRelative(d.verified_at, now)
                      ) : (
                        <span className="font-semibold text-danger">Not verified</span>
                      )}
                      {onHold && (
                        <span className="block text-xs text-pending">
                          In its security hold
                        </span>
                      )}
                    </Td>
                  </tr>
                )
              })}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  )
}

// ---------------------------------------------------------------------------

/**
 * One stopped payout, with its decision.
 *
 * The checks expand rather than showing by default. Every route considered is
 * what makes the choice auditable, and it is also eight rows of mostly
 * "does not reach this country" — which is context for the one line above it,
 * not a replacement for it.
 */
function StuckPayout({
  payout,
  sellerName,
  routing,
  loading,
  now,
}: {
  payout: Payout
  sellerName: string | undefined
  routing: PayoutRouting | undefined
  loading: boolean
  now: Date
}) {
  const [open, setOpen] = useState(false)
  const decision = routing?.decision

  return (
    <li className="px-6 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-fg">
            <Link className="text-brand hover:underline" to={`/sellers/${payout.seller_id}`}>
              {sellerName ?? payout.seller_id}
            </Link>
            <span className="ml-2 text-fg-muted">
              {formatMoney(payout.amount, payout.currency)}
            </span>
          </p>
          <p className="mt-1 text-xs text-fg-muted">
            Deal{' '}
            <Link className="hover:underline" to={`/deals/${payout.deal_id}`}>
              <Mono>{payout.deal_id}</Mono>
            </Link>{' '}
            · due {formatRelative(payout.scheduled_for, now)}
          </p>
        </div>
        <Badge meta={PAYOUT_STATUS_META[payout.status]} />
      </div>

      <p className="mt-2 text-sm leading-relaxed text-fg">
        {payout.failure_reason ??
          (decision
            ? routeReasonText(
                decision.reason_code,
                decision.payout_provider ?? 'flutterwave_momo',
                decision.currency ?? '',
                decision.currency ?? '',
              )
            : loading
              ? 'Reading the decision…'
              : 'The routing engine has not looked at this one yet.')}
      </p>

      {/* `review_held_by` is what tells a rule's hold from a person's, wherever
          a hold is read: a name means somebody you can go and ask. */}
      {payout.status === 'held_for_review' && (
        <p className="mt-1 text-xs text-fg-muted">
          {payout.review_held_by
            ? `Held by ${payout.review_held_by}. Ask them.`
            : 'Held by a rule. It can be cleared on the Payouts screen.'}
        </p>
      )}
      {payout.status === 'needs_verification' && (
        <p className="mt-1 text-xs text-fg-muted">
          Nobody approves this one — it ends when somebody attests to what is
          missing, on the seller's page.
        </p>
      )}

      {decision && decision.checks.length > 0 && (
        <>
          <button
            onClick={() => setOpen(!open)}
            className="mt-2 text-xs font-medium text-fg-muted hover:text-fg"
          >
            {open ? 'Hide' : 'Show'} every route considered ({decision.checks.length})
          </button>
          {open && (
            <ul className="mt-2 space-y-1 rounded-xl bg-surface-2 px-4 py-3 text-xs">
              {decision.checks.map((c) => (
                <li key={c.route_id} className="flex flex-wrap gap-x-2">
                  <span
                    className={cx(
                      'font-semibold',
                      c.eligible ? 'text-released' : 'text-fg-muted',
                    )}
                  >
                    {PAYOUT_PROVIDER_LABEL[c.payout_provider]}
                  </span>
                  {c.preferred && <span className="text-brand">the destination's own rail</span>}
                  <span className="text-fg-muted">{describe(c, decision.currency ?? '')}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-xs text-fg-subtle">
            Decided {formatDateTime(decision.created_at)}
            {decision.is_fallback && ' · the seller’s backup destination was used'}
          </p>
        </>
      )}
    </li>
  )
}

function describe(check: RouteCheck, currency: string): string {
  return check.eligible
    ? 'eligible'
    : routeReasonText(check.reason_code, check.payout_provider, '', currency)
}

type RouteState = 'live' | 'off' | 'collect_only' | 'suspended' | 'review'

function routeState(
  enabled: boolean,
  supportsPayouts: boolean,
  risk: 'approved' | 'review' | 'suspended',
): RouteState {
  if (!supportsPayouts) return 'collect_only'
  if (risk === 'suspended') return 'suspended'
  if (risk === 'review') return 'review'
  return enabled ? 'live' : 'off'
}

const ROUTE_STATE = {
  live: { label: 'On', tone: 'released' as const, hint: 'Payouts route here.' },
  off: {
    label: 'Off',
    tone: 'neutral' as const,
    hint: 'Declared and switched off. Nothing routes here.',
  },
  collect_only: {
    label: 'Collect only',
    tone: 'neutral' as const,
    hint: 'This rail can take money and cannot send it.',
  },
  suspended: {
    label: 'Suspended',
    tone: 'danger' as const,
    hint: 'Stopped deliberately. Payouts block rather than reroute.',
  },
  review: {
    label: 'Under review',
    tone: 'pending' as const,
    hint: 'Not eligible until it is approved again.',
  },
}
