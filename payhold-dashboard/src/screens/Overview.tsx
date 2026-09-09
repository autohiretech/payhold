import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api, type Currency, type Provider } from '@/api'
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
  Table,
  Td,
  Th,
  StatTile,
} from '@/components/ui'
import { PROVIDER_LABEL, SUPPORTED_CURRENCIES } from '@/lib/rails'
import {
  DEAL_STATUS_META,
  formatMoney,
  formatMoneyShort,
  formatPercent,
  formatRelative,
} from '@/lib/format'
import {
  useBalance,
  useDeals,
  useDisputes,
  useMoneyAction,
  usePayouts,
  useSettings,
} from '@/lib/queries'

export function OverviewPage() {
  const balance = useBalance()
  const deals = useDeals({ limit: 8 })
  const payouts = usePayouts()
  const disputes = useDisputes()
  const settings = useSettings()

  const now = new Date()
  const openDisputes = disputes.data?.filter((d) => d.status === 'open') ?? []
  const failedPayouts = payouts.data?.filter((p) => p.status === 'failed') ?? []

  return (
    <>
      <PageHeader
        title="Overview"
        subtitle="Where every shilling currently sits, and what needs attention."
      />

      {/* Balances, one row per currency — a tenant can hold more than one. */}
      {balance.isPending ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-32" />
          ))}
        </div>
      ) : (
        <div className="space-y-8">
          {balance.data?.map((b) => (
            <section key={b.currency}>
              <h2 className="mb-3 flex items-center gap-2 text-xs font-semibold tracking-[0.06em] text-fg-muted uppercase">
                {b.currency} balance
                <span className="h-px flex-1 bg-line" />
              </h2>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <StatTile
                  label="Held"
                  tone="held"
                  value={formatMoneyShort(b.held, b.currency)}
                  hint="Buyer money in the vault against open deals"
                />
                <StatTile
                  label="Clearing"
                  tone="pending"
                  value={formatMoneyShort(b.pending_clearance, b.currency)}
                  hint="Released, waiting out the clearance window"
                />
                <StatTile
                  label="Available"
                  tone="released"
                  value={formatMoneyShort(b.available, b.currency)}
                  hint="Cleared and payable to sellers now"
                />
                <StatTile
                  label="Paid out"
                  value={formatMoneyShort(b.paid_out, b.currency)}
                  hint="Lifetime total sent to sellers"
                />
              </div>

              {/* Deliberately separate from the four tiles above, not a fifth
                  one in the same row: those are money moving toward a seller,
                  this is money that already stopped being theirs — the same
                  reason a seller's own wallet never shows fees_retained at
                  all. It is still sitting in the provider balance rather than
                  anywhere PayHold can pay it out to — there is no sweep, and
                  no button here changes that. */}
              <div className="mt-3 grid max-w-xl gap-3 sm:grid-cols-2">
                <StatTile
                  label="Your revenue"
                  tone="confirmed"
                  value={formatMoneyShort(b.fees_retained, b.currency)}
                  hint={
                    settings.data
                      ? `${formatPercent(settings.data.service_fee_rate)} service fee, plus any tax collected — still at the provider, not swept out anywhere`
                      : 'Service fee plus any tax collected — still at the provider, not swept out anywhere'
                  }
                />

                {/* Shown only when there is any, because most accounts never
                    have any: it appears when a deal is collected on one rail
                    and paid out on another, which leaves what the buyer paid
                    sitting where it was collected while the seller was paid
                    from a different balance.

                    **Both signs are meaningful and they are different jobs.**
                    Positive is money sitting in one of your balances that no
                    seller is owed — yours to sweep. Negative means you have
                    paid more out of that currency than you have funded it
                    with, which is the shortfall to cover before the next
                    payout in it fails. Labelling it one way would make the
                    other read as a bug. */}
                {b.tenant_funds !== 0 && (
                  <StatTile
                    label={b.tenant_funds > 0 ? 'Yours to move' : 'To top up'}
                    tone={b.tenant_funds > 0 ? undefined : 'held'}
                    value={formatMoneyShort(Math.abs(b.tenant_funds), b.currency)}
                    hint={
                      b.tenant_funds > 0
                        ? 'Collected here but paid out from another rail — no seller is owed it'
                        : 'Paid out of this currency beyond what you have funded it with'
                    }
                  />
                )}
              </div>
            </section>
          ))}
        </div>
      )}

      <ExternalTransferCard />

      {(openDisputes.length > 0 || failedPayouts.length > 0) && (
        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          {openDisputes.length > 0 && (
            <AttentionCard
              to="/disputes"
              tone="danger"
              title={`${openDisputes.length} open dispute${openDisputes.length > 1 ? 's' : ''}`}
              body="Funds are held and both release and refund are blocked until resolved."
            />
          )}
          {failedPayouts.length > 0 && (
            <AttentionCard
              to="/payouts"
              tone="danger"
              title={`${failedPayouts.length} failed payout${failedPayouts.length > 1 ? 's' : ''}`}
              body="The provider rejected these transfers. Fix the destination and retry."
            />
          )}
        </div>
      )}

      <Card className="mt-8">
        <CardHeader
          title="Recent deals"
          subtitle="The eight most recent, newest first."
          action={
            <Link
              to="/deals"
              className="rounded-lg px-2.5 py-1.5 text-sm font-semibold text-brand transition hover:bg-brand-soft"
            >
              View all →
            </Link>
          }
        />
        {deals.isPending ? (
          <div className="space-y-2 p-6">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-9" />
            ))}
          </div>
        ) : !deals.data?.length ? (
          <EmptyState
            title="No deals yet"
            body="Deals appear here as soon as a client site creates one through the API."
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Deal</Th>
                <Th>Status</Th>
                <Th align="right">Amount</Th>
                <Th align="right">Created</Th>
              </tr>
            </thead>
            <tbody>
              {deals.data.map((deal) => (
                <tr key={deal.id} className="hover:bg-surface-2">
                  <Td>
                    <Link to={`/deals/${deal.id}`} className="block hover:underline">
                      <span className="font-medium">{deal.description}</span>
                      <br />
                      <Mono>{deal.id}</Mono>
                    </Link>
                  </Td>
                  <Td>
                    <Badge meta={DEAL_STATUS_META[deal.status]} />
                  </Td>
                  <Td align="right" className="tabular font-medium">
                    {formatMoney(deal.amount, deal.currency)}
                  </Td>
                  <Td align="right" className="text-fg-muted">
                    {formatRelative(deal.created_at, now)}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  )
}

/**
 * Record money you moved between your own provider accounts.
 *
 * PayHold orchestrates and never custodies, so an account collecting on Stripe
 * and paying African sellers on Flutterwave tops the second up from the first
 * themselves — bank transfer, a few days, somewhere PayHold cannot observe. The
 * ledger still has to be able to explain the balance that results, or the
 * nightly reconciliation reads the top-up as drift and freezes payouts.
 *
 * **This screen is the only way to file one**, and that is deliberate rather
 * than an omission: the endpoint refuses an API key, for
 * `paid_needs_a_provider_reference`'s reason — a claim that money moved
 * somewhere we cannot check is how a difference gets papered over instead of
 * explained, so it wants a person and a reference.
 *
 * It is also the one mutation on an otherwise read-only screen. It earns that
 * by being a statement about the account's own bank activity rather than
 * anything PayHold does: no money moves when you press this, and none of the
 * seller-facing buckets change.
 */
function ExternalTransferCard() {
  const [open, setOpen] = useState(false)
  const [provider, setProvider] = useState<Provider>('flutterwave')
  const [currency, setCurrency] = useState<Currency>('RWF')
  const [amount, setAmount] = useState('')
  const [reference, setReference] = useState('')
  const [done, setDone] = useState(false)

  const record = useMoneyAction(() =>
    api.recordExternalTransfer({
      provider,
      currency,
      // Major units in the form, minor on the wire — the boundary this
      // codebase converts at, and the only place it is allowed to happen.
      amount: Math.round(Number(amount) * 100),
      reference: reference.trim(),
    }),
  )

  const ready = Number(amount) !== 0 && reference.trim().length > 0

  if (!open) {
    return (
      <div className="mt-4">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="text-sm font-medium text-brand underline underline-offset-2"
        >
          Record a transfer between your own accounts
        </button>
      </div>
    )
  }

  return (
    <Card className="mt-4">
      <CardHeader
        title="Transfer between your own accounts"
        subtitle="Money you moved yourself — a Stripe payout swept into Flutterwave, say. Nothing moves when you save this; it records what already happened so reconciliation can explain the balance."
      />
      <div className="grid gap-5 px-6 py-5 sm:grid-cols-2">
        <Field label="Rail" hint="Whose balance changed.">
          <Select value={provider} onChange={(e) => setProvider(e.target.value as Provider)}>
            {(['flutterwave', 'stripe', 'paypal'] as Provider[]).map((p) => (
              <option key={p} value={p}>{PROVIDER_LABEL[p]}</option>
            ))}
          </Select>
        </Field>

        <Field label="Currency" hint="The currency of that balance.">
          <Select
            value={currency}
            onChange={(e) => setCurrency(e.target.value as Currency)}
          >
            {SUPPORTED_CURRENCIES.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </Select>
        </Field>

        <Field
          label="Amount"
          hint="Positive for money arriving on that rail, negative for money you took out."
        >
          <Input
            type="number"
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </Field>

        <Field label="Reference" hint="The bank or provider reference. Required — it is what makes this checkable later.">
          <Input
            value={reference}
            placeholder="BK-2026-0918-441"
            onChange={(e) => setReference(e.target.value)}
          />
        </Field>
      </div>

      <div className="flex items-center gap-3 px-6 pb-5">
        <Button
          variant="primary"
          disabled={!ready || record.isPending}
          onClick={async () => {
            await record.mutateAsync()
            setAmount('')
            setReference('')
            setDone(true)
            setTimeout(() => setDone(false), 2500)
          }}
        >
          {record.isPending ? 'Recording…' : 'Record it'}
        </Button>
        <Button onClick={() => setOpen(false)}>Cancel</Button>
        {done && <span className="text-sm text-released">Recorded.</span>}
      </div>

      {record.isError && (
        <div className="px-6 pb-5">
          <ErrorNote message={record.error.message} />
        </div>
      )}
    </Card>
  )
}

function AttentionCard({
  to,
  title,
  body,
}: {
  to: string
  tone: 'danger' | 'pending'
  title: string
  body: string
}) {
  return (
    <Link to={to} className="group block">
      <Card className="flex items-start gap-3.5 border-danger/20 bg-danger-soft p-5 transition group-hover:shadow-[var(--shadow-lift)]">
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-danger/12 text-danger">
          <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 8v5M12 16.5v.01" strokeLinecap="round" />
          </svg>
        </span>
        <span className="min-w-0">
          <span className="block text-sm font-semibold text-danger">{title}</span>
          <span className="mt-1 block text-sm leading-relaxed text-fg-muted">{body}</span>
        </span>
      </Card>
    </Link>
  )
}
