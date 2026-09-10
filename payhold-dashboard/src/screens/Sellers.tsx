import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQueries, type UseQueryResult } from '@tanstack/react-query'
import {
  api,
  type Country,
  type Currency,
  type PayoutOptions,
  type PayoutProvider,
  type Seller,
} from '@/api'
import { ProviderChip } from '@/components/rails'
import {
  countriesByRegion,
  countryFlag,
  countryName,
  PAYOUT_PROVIDER_LABEL,
  railsForPayoutKinds,
} from '@/lib/rails'
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
  cx,
} from '@/components/ui'
import { formatDate, formatMoneyShort, KYC_STATUS_META } from '@/lib/format'
import {
  keys,
  useMoneyAction,
  usePayoutOptions,
  useSellerWallets,
  useSellers,
} from '@/lib/queries'

/**
 * Who this account is holding money for, and how much of it is theirs to take.
 *
 * The same six buckets as the Overview, split by seller instead of by rail —
 * and summed, these rows *are* the Overview's figures less `fees_retained`,
 * which is our commission and never appears on a seller's wallet.
 *
 * Two columns carry the distinction that matters and the copy says it out loud:
 * **In progress** is buyer money in the hold, gross, with nothing struck off it
 * yet — the fee comes out at release, so it is not the seller's and must not be
 * labelled as though it were. **Available** is theirs and payable now.
 *
 * Read-only, like the Routing Center and for the same reason: this is a
 * statement of where the money is, and every button that moves any of it lives
 * on Payouts where the decision is recorded against a person.
 */
function WalletsCard() {
  const wallets = useSellerWallets()

  return (
    <Card>
      <CardHeader
        title="Seller wallets"
        subtitle="What this account holds for each seller. Sellers have no PayHold login — your own app reads these figures over the API and shows them its own way."
      />
      {wallets.isPending ? (
        <div className="space-y-2 p-6">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-9" />
          ))}
        </div>
      ) : !wallets.data?.length ? (
        <EmptyState
          title="Nothing held yet"
          body="A seller appears here once a deal of theirs has been funded."
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Seller</Th>
              <Th>Currency</Th>
              <Th align="right">In progress</Th>
              <Th align="right">Clearing</Th>
              <Th align="right">Available</Th>
              <Th align="right">Reserved</Th>
              <Th align="right">Paid out</Th>
            </tr>
          </thead>
          <tbody>
            {wallets.data.map((w) => (
              <tr key={`${w.seller_id}:${w.currency}`}>
                <Td>
                  <Link
                    to={`/sellers/${w.seller_id}`}
                    className="font-medium text-brand hover:underline"
                  >
                    {w.seller_name}
                  </Link>
                  <div className="text-xs text-fg-muted">
                    {countryFlag(w.seller_country)} {countryName(w.seller_country)}
                  </div>
                </Td>
                <Td>
                  <Mono>{w.currency}</Mono>
                </Td>
                {/* Gross, and not theirs yet — hence "in progress" rather than
                    a figure that reads like a balance they could draw on. */}
                <Td align="right" className="text-fg-muted">
                  {formatMoneyShort(w.held, w.currency)}
                </Td>
                <Td align="right" className="text-fg-muted">
                  {formatMoneyShort(w.pending_clearance, w.currency)}
                </Td>
                <Td align="right" className="font-medium text-released">
                  {formatMoneyShort(w.available, w.currency)}
                </Td>
                <Td align="right" className="text-fg-muted">
                  {w.reserved === 0 ? '—' : formatMoneyShort(w.reserved, w.currency)}
                </Td>
                <Td align="right" className="text-fg-muted">
                  {formatMoneyShort(w.paid_out, w.currency)}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <p className="border-t border-line px-6 py-3 text-xs text-fg-muted">
        <strong className="font-medium text-fg">In progress</strong> is buyer money
        still in the hold — gross, with our fee not yet struck off, so it is not
        the seller's to draw on.{' '}
        <strong className="font-medium text-fg">Available</strong> has cleared its
        window and is payable now.
      </p>
    </Card>
  )
}

/** One cache entry per corridor, not per seller. */
const pairKey = (country: Country, currency: Currency) => `${country}:${currency}`

/**
 * Which rail each registered seller's money would actually leave on.
 *
 * This used to be `payoutRoute()`, which reads the generated registry — what is
 * *possible*. `payout_routes` / `route_evaluation` is what is *on* (§29.11) and
 * only the backend can read it, so a seller already registered against a
 * corridor the table does not carry was shown a rail the routing engine would
 * never pick. The picker on this screen was moved to `GET /v1/payment-options`
 * for that reason; this is the same read, for the rows.
 *
 * **One read per distinct (country, payout_currency), never one per row.** A
 * table has many sellers and few corridors, and eligibility is per pair rather
 * than per country — Kenya answers `momo` in KES and reaches PayPal in
 * USD — so the pair is both the question and the cache key. `useQueries` is the
 * shape the Routing Center already uses for the same reason.
 *
 * A seller with no country or no destination currency has no pair to ask about
 * and gets no entry: there is nothing to look up, which is different from a
 * corridor that answered.
 */
function usePayoutOptionsByPair(
  sellers: Seller[],
): Map<string, UseQueryResult<PayoutOptions, Error>> {
  const pairs = [
    ...new Map(
      sellers.flatMap((s) =>
        s.country && s.payout_currency
          ? [[pairKey(s.country, s.payout_currency), [s.country, s.payout_currency] as const]]
          : [],
      ),
    ).values(),
  ]

  const reads = useQueries({
    queries: pairs.map(([country, currency]) => ({
      queryKey: keys.payoutOptions(country, currency),
      queryFn: () => api.getPayoutOptions(country, currency),
    })),
  })

  return new Map(
    pairs.flatMap(([country, currency], i) => {
      const read = reads[i]
      return read ? [[pairKey(country, currency), read] as const] : []
    }),
  )
}

/**
 * The routing table's answer for one seller's corridor, and nothing else.
 *
 * In flight it says so; failed it says the rail is unknown. Neither falls back
 * to the registry, because falling back is the bug this column had: a
 * plausible rail rendered from a source that cannot see whether the corridor is
 * switched on reads exactly like a checked one.
 */
function PaidViaCell({ read }: { read?: UseQueryResult<PayoutOptions, Error> }) {
  if (!read) {
    return (
      <span className="text-fg-muted" title="No payout currency on file — there is no corridor to ask about.">
        —
      </span>
    )
  }

  if (read.isPending) return <Skeleton className="h-4 w-24" />

  if (read.isError) {
    return (
      <span className="text-xs font-semibold text-fg-muted" title={read.error.message}>
        Unknown
      </span>
    )
  }

  const payout = read.data.payout
  return payout?.provider && !payout.blocked ? (
    <span title={payout.reason}>
      <ProviderChip provider={payout.provider} />
    </span>
  ) : (
    <span className="text-xs font-semibold text-danger" title={payout?.reason}>
      No rail
    </span>
  )
}

export function SellersPage() {
  const sellers = useSellers()
  const routes = usePayoutOptionsByPair(sellers.data ?? [])
  const [adding, setAdding] = useState(false)

  return (
    <>
      <PageHeader
        title="Sellers"
        subtitle="Payout destinations. Registered once, then referenced by every deal."
        action={
          <Button variant="primary" onClick={() => setAdding(true)}>
            Add seller
          </Button>
        }
      />

      {adding && <AddSellerForm onClose={() => setAdding(false)} />}

      <WalletsCard />

      <Card>
        <CardHeader
          title="Registered sellers"
          subtitle="Destinations are tokenized by the provider. PayHold never stores the real number. A new seller starts unverified and cannot be paid until somebody attests — open them to do it."
        />
        {sellers.isPending ? (
          <div className="space-y-2 p-6">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-9" />
            ))}
          </div>
        ) : !sellers.data?.length ? (
          <EmptyState
            title="No sellers yet"
            body="Add one before creating a deal — money needs somewhere to land."
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Onboarding</Th>
                <Th>Market</Th>
                <Th>Payout method</Th>
                <Th>Destination</Th>
                <Th>Paid in</Th>
                <Th>Paid via</Th>
                <Th align="right">Added</Th>
              </tr>
            </thead>
            <tbody>
              {sellers.data.map((s) => {
                // Undefined until a destination is registered — a seller can
                // exist, and money can accrue against them, before there is a
                // corridor to ask the routing table about at all.
                const route =
                  s.country && s.payout_currency
                    ? routes.get(pairKey(s.country, s.payout_currency))
                    : undefined
                return (
                  <tr key={s.id} className="hover:bg-surface-2">
                    <Td className="font-medium">
                      <Link className="text-brand hover:underline" to={`/sellers/${s.id}`}>
                        {s.name}
                      </Link>
                      {/* Status only, not shown for the common case — a seller
                          is presumed active until the client says otherwise. */}
                      {!s.active && (
                        <span className="ml-2 rounded-full bg-surface-2 px-2 py-0.5 text-xs font-medium text-fg-muted">
                          Inactive
                        </span>
                      )}
                    </Td>
                    <Td>
                      <Badge meta={KYC_STATUS_META[s.kyc_status]} />
                    </Td>
                    {s.country ? (
                      <>
                        <Td className="text-fg-muted">
                          {countryFlag(s.country)} {countryName(s.country)}
                        </Td>
                        <Td className="text-fg-muted">
                          {s.payout_provider ? PAYOUT_PROVIDER_LABEL[s.payout_provider] : '—'}
                        </Td>
                        <Td>
                          <Mono>{s.masked_destination}</Mono>
                        </Td>
                        <Td className="tabular text-fg-muted">{s.payout_currency}</Td>
                        <Td>
                          <PaidViaCell read={route} />
                        </Td>
                      </>
                    ) : (
                      <Td className="text-fg-muted" colSpan={4}>
                        No payout destination on file yet
                      </Td>
                    )}
                    <Td align="right" className="text-fg-muted">
                      {formatDate(s.created_at)}
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

function AddSellerForm({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('')
  const [country, setCountry] = useState<Country>('RW')
  const [destination, setDestination] = useState('')
  // A destination is optional at registration — a seller can exist, and money
  // can accrue against them, before anyone knows how to pay them. Checked by
  // default because most registrations here know both at once; unchecking it
  // is for onboarding someone before their payout details are collected.
  const [hasDestination, setHasDestination] = useState(true)
  // The client's own id for this person. Optional here because somebody
  // registering by hand has nothing to put in it; a server integration should
  // always send one, or it cannot find this seller again.
  const [externalUserId, setExternalUserId] = useState('')

  // **The backend decides what can be registered here, and nothing else does.**
  //
  // The generated registry says which corridors are *possible*; the routing
  // table says which are *on* (§29.11), and only the backend can read the
  // second. Deriving this list from `countries.ts` offered pairs that
  // registration then refuses — Kenya's bank corridor sits behind a Flutterwave
  // request, and Kenya + KES + PayPal is `currency_not_supported` because
  // PayPal's route row carries KE without carrying KES.
  //
  // Eligibility is per **(country, currency)**, not per country, so the pair is
  // what is asked: a market's answer in its own money is a different answer
  // from its answer in dollars, and the same read fills both pickers.
  const [payoutCurrency, setPayoutCurrency] = useState<Currency | null>(null)
  const options = usePayoutOptions(country, payoutCurrency ?? undefined)
  const payout = options.data?.payout

  // Null until the answer lands, deliberately: the market's own currency is the
  // backend's default and this form does not guess at it. Nothing is offered
  // while the read is in flight and nothing is offered if it fails — an empty
  // picker is the honest shape of "we have not been told", and the alternative
  // is falling back to the registry, which is the bug.
  const currencyChoices = payout?.currencies ?? []
  const wanted =
    currencyChoices.find((c) => c.currency === payoutCurrency)?.currency ??
    // Sorted default-first by the backend, so the head is the currency a seller
    // here gets today. Preselecting anything else would move them off it.
    currencyChoices[0]?.currency ??
    null

  const available = railsForPayoutKinds(payout?.methods ?? [])
  const [provider, setProvider] = useState<PayoutProvider | null>(null)
  const effective = provider && available.includes(provider) ? provider : available[0]

  const create = useMoneyAction(() => {
    if (!hasDestination) {
      return api.createSeller({
        name,
        external_user_id: externalUserId.trim() || undefined,
      })
    }
    if (!effective || !wanted) {
      // The backend's own sentence where there is one — it is written for
      // somebody to read, and a second wording here would be a second answer.
      throw new Error(
        payout?.reason ??
          `PayHold cannot send money to ${countryName(country)} yet — a seller there cannot be paid.`,
      )
    }
    return api.createSeller({
      name,
      country,
      payout_currency: wanted,
      payout_provider: effective,
      destination,
      external_user_id: externalUserId.trim() || undefined,
    })
  })

  return (
    <Card className="mb-5 p-6">
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault()
          await create.mutateAsync()
          onClose()
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Name">
            <Input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Jean-Paul Habimana"
            />
          </Field>

          {hasDestination && (
            <>
              <Field label="Market">
                <Select
                  value={country}
                  onChange={(e) => {
                    setCountry(e.target.value as Country)
                    // Both choices belong to the old market. Cleared rather
                    // than carried, so the next answer is asked for in the
                    // backend's default currency instead of one this form
                    // assumed, and no rail is preselected before we are told
                    // which rails exist.
                    setPayoutCurrency(null)
                    setProvider(null)
                  }}
                >
                  {countriesByRegion().map((group) => (
                    <optgroup key={group.region} label={group.region}>
                      {group.countries.map((info) => (
                        <option key={info.code} value={info.code}>
                          {countryFlag(info.code)}  {info.name}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </Select>
              </Field>

              <Field label="Wants to be paid in">
                <Select
                  value={wanted ?? ''}
                  disabled={currencyChoices.length === 0}
                  onChange={(e) => setPayoutCurrency(e.target.value as Currency)}
                >
                  {currencyChoices.length === 0 ? (
                    <option value="">
                      {options.isPending ? 'Checking…' : 'Not payable here'}
                    </option>
                  ) : (
                    currencyChoices.map((c) => (
                      <option key={c.currency} value={c.currency}>
                        {c.currency}
                        {c.default ? ' (local)' : ''}
                      </option>
                    ))
                  )}
                </Select>
              </Field>

              <Field label="Payout method">
                <Select
                  value={effective ?? ''}
                  disabled={available.length === 0}
                  onChange={(e) => setProvider(e.target.value as PayoutProvider)}
                >
                  {available.length === 0 ? (
                    <option value="">
                      {options.isPending ? 'Checking…' : 'No rail available'}
                    </option>
                  ) : (
                    available.map((p) => (
                      <option key={p} value={p}>
                        {PAYOUT_PROVIDER_LABEL[p]}
                      </option>
                    ))
                  )}
                </Select>
              </Field>

              <Field
                label="Destination"
                hint="Tokenized immediately. Only the last four digits are kept."
              >
                <Input
                  required
                  value={destination}
                  onChange={(e) => setDestination(e.target.value)}
                  placeholder="0788 123 456"
                />
              </Field>
            </>
          )}

          <Field
            label="Your id for them"
            hint="Optional. The id this person has in your own system, so you can find them again."
          >
            <Input
              value={externalUserId}
              onChange={(e) => setExternalUserId(e.target.value)}
              placeholder="host_4821"
            />
          </Field>
        </div>

        <label className="flex items-center gap-2 text-sm text-fg-muted">
          <input
            type="checkbox"
            checked={!hasDestination}
            onChange={(e) => setHasDestination(!e.target.checked)}
          />
          I don't have their payout details yet — register them anyway. Money
          will still accrue; nothing can be paid out until a destination is
          added.
        </label>

        {/* The resulting route, stated before you save rather than discovered
            when the first payout is due — and it is the routing engine's own
            answer for this pair, not a second one derived here. A read that has
            not landed says so; a read that failed says nothing about the route,
            because the alternative is guessing. */}
        {hasDestination &&
          (options.isPending ? (
            <div className="rounded-xl bg-surface-2 px-4 py-3 text-sm leading-relaxed text-fg-muted">
              Checking which rails reach {countryName(country)}…
            </div>
          ) : options.isError ? (
            <ErrorNote message={options.error.message} />
          ) : payout ? (
            <div
              className={cx(
                'rounded-xl px-4 py-3 text-sm leading-relaxed',
                payout.blocked
                  ? 'bg-danger-soft text-danger'
                  : payout.provider === 'stripe'
                    ? 'bg-held-soft text-held'
                    : 'bg-surface-2 text-fg-muted',
              )}
            >
              <span className="flex flex-wrap items-center gap-2">
                <strong className="font-semibold">
                  {payout.blocked ? 'Cannot be paid' : 'Will be paid via'}
                </strong>
                {payout.provider && <ProviderChip provider={payout.provider} />}
              </span>
              <span className="mt-1.5 block">{payout.reason}</span>
            </div>
          ) : null)}

        {create.isError && <ErrorNote message={create.error.message} />}

        <div className="flex gap-2">
          <Button
            type="submit"
            variant="primary"
            disabled={
              create.isPending ||
              // Nothing to register against until the backend has answered, and
              // nothing to register at all when it answers with no rail.
              (hasDestination && (options.isPending || !effective || !wanted))
            }
          >
            {create.isPending ? 'Registering…' : 'Register seller'}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  )
}
