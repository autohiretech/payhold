import { useState } from 'react'
import { Link } from 'react-router-dom'
import { DEAL_STATUSES, type Country, type Currency, type DealStatus } from '@/api'
import {
  Badge,
  Button,
  Card,
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
  cx,
} from '@/components/ui'
import { MethodChip, ProviderChip } from '@/components/rails'
import { DEAL_STATUS_META, formatMoney, formatRelative } from '@/lib/format'
import { COUNTRY_LABEL, collectionRails } from '@/lib/rails'
import { simNow, useDeals, useMoneyAction, useSellers, useSettings } from '@/lib/queries'
import { api } from '@/api'

/** Coarse groupings, because "show me what's live" beats picking eight statuses. */
const FILTERS: { label: string; statuses: DealStatus[] }[] = [
  { label: 'All', statuses: [] },
  { label: 'Awaiting payment', statuses: ['created'] },
  {
    label: 'Holding',
    statuses: ['funded_held', 'confirmed_buyer', 'confirmed_seller'],
  },
  { label: 'Released', statuses: ['released', 'paid_out'] },
  { label: 'Needs attention', statuses: ['disputed'] },
  { label: 'Refunded', statuses: ['refunded'] },
]

export function DealsPage() {
  const [filterIndex, setFilterIndex] = useState(0)
  const [search, setSearch] = useState('')
  const [creating, setCreating] = useState(false)

  const active = FILTERS[filterIndex] ?? FILTERS[0]!
  const deals = useDeals({
    status: active.statuses.length ? active.statuses : undefined,
    search: search || undefined,
  })
  const sellers = useSellers()
  const now = simNow()

  const sellerName = (id: string) =>
    sellers.data?.find((s) => s.id === id)?.name ?? id

  return (
    <>
      <PageHeader
        title="Deals"
        subtitle="Every payment hold, from creation through payout."
        action={
          <Button variant="primary" onClick={() => setCreating(true)}>
            New deal
          </Button>
        }
      />

      {creating && <CreateDealForm onClose={() => setCreating(false)} />}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {FILTERS.map((f, i) => (
          <button
            key={f.label}
            onClick={() => setFilterIndex(i)}
            className={cx(
              'rounded-full px-3.5 py-1.5 text-sm font-semibold transition',
              i === filterIndex
                ? 'bg-brand text-brand-fg shadow-[var(--shadow-card)]'
                : 'bg-surface text-fg-muted ring-1 ring-line ring-inset hover:bg-surface-2 hover:text-fg',
            )}
          >
            {f.label}
          </button>
        ))}
        <div className="ml-auto w-full sm:w-64">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search id, booking ref, description…"
          />
        </div>
      </div>

      <Card>
        {deals.isPending ? (
          <div className="space-y-2 p-6">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-9" />
            ))}
          </div>
        ) : !deals.data?.length ? (
          <EmptyState
            title="Nothing here"
            body={
              search
                ? `No deals match "${search}".`
                : 'No deals in this state right now.'
            }
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Deal</Th>
                <Th>Seller</Th>
                <Th>Paid with</Th>
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
                      <Mono>
                        {deal.id} · {deal.buyer_ref}
                      </Mono>
                    </Link>
                  </Td>
                  <Td className="text-fg-muted">{sellerName(deal.seller_id)}</Td>
                  <Td>
                    {deal.payment_method ? (
                      <div className="flex flex-col gap-1">
                        <MethodChip method={deal.payment_method} />
                        <ProviderChip provider={deal.provider} className="self-start" />
                      </div>
                    ) : (
                      <span className="text-sm text-fg-subtle">Not paid yet</span>
                    )}
                  </Td>
                  <Td>
                    <Badge meta={DEAL_STATUS_META[deal.status]} />
                  </Td>
                  <Td align="right" className="tabular font-medium">
                    {formatMoney(deal.amount, deal.currency)}
                    <span className="mt-0.5 block text-xs font-normal text-fg-muted">
                      fee {formatMoney(deal.fee_amount, deal.currency)}
                    </span>
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

      <p className="mt-3 text-xs text-fg-muted">
        Showing {deals.data?.length ?? 0} deal{deals.data?.length === 1 ? '' : 's'}.
        Statuses map to the v1 API exactly:{' '}
        <Mono>{DEAL_STATUSES.join(' · ')}</Mono>
      </p>
    </>
  )
}

// ---------------------------------------------------------------------------

function CreateDealForm({ onClose }: { onClose: () => void }) {
  const sellers = useSellers()
  const settings = useSettings()

  const [sellerId, setSellerId] = useState('')
  const [buyerRef, setBuyerRef] = useState('')
  const [description, setDescription] = useState('')
  const [amount, setAmount] = useState('')
  const [currency, setCurrency] = useState<Currency>('RWF')
  const [country, setCountry] = useState<Country>('RW')
  const [deposit, setDeposit] = useState('')
  const [link, setLink] = useState<string | null>(null)

  // What the buyer will actually be offered at checkout, shown here so a deal
  // is never created into a market we cannot collect from.
  const rails = collectionRails(country, currency)

  const create = useMoneyAction(() =>
    api.createDeal({
      seller_id: sellerId,
      buyer_ref: buyerRef,
      description,
      // The form takes major units; the API is minor units everywhere.
      amount: Math.round(Number(amount) * 100),
      currency,
      buyer_country: country,
      deposit_amount: deposit ? Math.round(Number(deposit) * 100) : undefined,
    }),
  )

  const feePreview =
    settings.data && amount
      ? Math.round(Number(amount) * 100 * settings.data.service_fee_rate)
      : 0

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const result = await create.mutateAsync()
    setLink(result.payment_link)
  }

  if (link) {
    return (
      <Card className="mb-5 p-6">
        <h2 className="text-sm font-semibold text-fg">Deal created</h2>
        <p className="mt-1 text-sm text-fg-muted">
          Send the buyer here to pay. Funds are held the moment the payment clears.
        </p>
        <div className="mt-3 rounded-lg bg-surface-2 px-3 py-2">
          <Mono>{link}</Mono>
        </div>
        <div className="mt-4 flex gap-2">
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
          <Button
            onClick={() => {
              setLink(null)
              setBuyerRef('')
              setDescription('')
              setAmount('')
              setDeposit('')
            }}
          >
            Create another
          </Button>
        </div>
      </Card>
    )
  }

  return (
    <Card className="mb-5 p-6">
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Seller">
            <Select
              required
              value={sellerId}
              onChange={(e) => setSellerId(e.target.value)}
            >
              <option value="">Choose a seller…</option>
              {sellers.data?.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} — {s.masked_destination}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Buyer reference" hint="Your own id for this buyer or booking.">
            <Input
              required
              value={buyerRef}
              onChange={(e) => setBuyerRef(e.target.value)}
              placeholder="bk_1234"
            />
          </Field>
        </div>

        <Field label="Description">
          <Input
            required
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Toyota RAV4 — 3 days, Kigali"
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field
            label="Amount"
            hint={
              feePreview > 0
                ? `Your fee: ${formatMoney(feePreview, currency)}`
                : undefined
            }
          >
            <Input
              required
              type="number"
              min="1"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="13500"
            />
          </Field>

          <Field label="Currency">
            <Select
              value={currency}
              onChange={(e) => setCurrency(e.target.value as Currency)}
            >
              {settings.data?.currencies.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Security deposit" hint="Optional card pre-auth.">
            <Input
              type="number"
              min="0"
              step="0.01"
              value={deposit}
              onChange={(e) => setDeposit(e.target.value)}
              placeholder="0"
            />
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Buyer is paying from"
            hint="Decides which payment methods appear at checkout."
          >
            <Select
              value={country}
              onChange={(e) => setCountry(e.target.value as Country)}
            >
              {(['RW', 'KE', 'UG', 'INTL'] as Country[]).map((c) => (
                <option key={c} value={c}>
                  {COUNTRY_LABEL[c]}
                </option>
              ))}
            </Select>
          </Field>

          <div className="rounded-xl bg-surface-2 px-4 py-3">
            <p className="text-xs font-semibold tracking-[0.06em] text-fg-muted uppercase">
              They will be offered
            </p>
            {rails.length === 0 ? (
              <p className="mt-2 text-sm font-medium text-danger">
                Nothing — we cannot collect {currency} from{' '}
                {COUNTRY_LABEL[country]}.
              </p>
            ) : (
              <ul className="mt-2 space-y-1.5">
                {rails.map((rail) => (
                  <li
                    key={`${rail.method}-${rail.provider}`}
                    className="flex items-center justify-between gap-2 text-sm"
                  >
                    <MethodChip method={rail.method} />
                    <ProviderChip provider={rail.provider} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {create.isError && <ErrorNote message={(create.error as Error).message} />}

        <div className="flex gap-2">
          <Button type="submit" variant="primary" disabled={create.isPending}>
            {create.isPending ? 'Creating…' : 'Create deal'}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  )
}
