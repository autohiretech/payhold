import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api, type Country, type Currency, type PayoutProvider } from '@/api'
import { ProviderChip } from '@/components/rails'
import {
  COUNTRIES,
  countriesByRegion,
  countryFlag,
  countryName,
  defaultCurrencyFor,
  PAYOUT_PROVIDER_LABEL,
  payoutRoute,
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
import { useMoneyAction, useSellerWallets, useSellers } from '@/lib/queries'

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

/**
 * Payout destinations available in a market, derived from the registry rather
 * than hand-listed — a market with an empty list has no way to receive money,
 * and the form says so instead of offering something that would never pay.
 */
function payoutOptionsFor(country: Country): PayoutProvider[] {
  const info = COUNTRIES.find((c) => c.code === country)
  if (!info) return []

  const options: PayoutProvider[] = []
  if (info.momo && info.flutterwavePayout) options.push('flutterwave_momo')
  if (info.flutterwavePayout) options.push('flutterwave_bank')
  if (info.stripePayout) options.push('stripe_connect')
  return options
}

export function SellersPage() {
  const sellers = useSellers()
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
                // Null until a destination is registered — a seller can exist,
                // and money can accrue against them, before there is a route
                // to evaluate at all.
                const route = s.country && s.payout_currency
                  ? payoutRoute(s.country, s.payout_currency)
                  : null
                return (
                  <tr key={s.id} className="hover:bg-surface-2">
                    <Td className="font-medium">
                      <Link className="text-brand hover:underline" to={`/sellers/${s.id}`}>
                        {s.name}
                      </Link>
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
                          {route?.provider ? (
                            <span title={route.reason}>
                              <ProviderChip provider={route.provider} />
                            </span>
                          ) : (
                            <span
                              className="text-xs font-semibold text-danger"
                              title={route?.reason}
                            >
                              No rail
                            </span>
                          )}
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

  // The market decides which payout methods are even possible, so it drives
  // the method list rather than sitting beside it.
  const available = payoutOptionsFor(country)
  const [provider, setProvider] = useState<PayoutProvider>('flutterwave_momo')
  const effective = available.includes(provider) ? provider : available[0]

  // What the seller wants to be paid in. Local keeps them on the local rail;
  // asking for dollars changes the route entirely, and sometimes removes it.
  const local = defaultCurrencyFor(country)
  const [payoutCurrency, setPayoutCurrency] = useState<Currency>(local)
  const currencyChoices: Currency[] = [...new Set<Currency>([local, 'USD', 'EUR'])]
  const wanted = currencyChoices.includes(payoutCurrency) ? payoutCurrency : local

  const route = payoutRoute(country, wanted)

  const create = useMoneyAction(() => {
    if (!hasDestination) {
      return api.createSeller({
        name,
        external_user_id: externalUserId.trim() || undefined,
      })
    }
    if (!effective) {
      throw new Error(
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
                    const next = e.target.value as Country
                    setCountry(next)
                    setPayoutCurrency(defaultCurrencyFor(next))
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
                  value={wanted}
                  onChange={(e) => setPayoutCurrency(e.target.value as Currency)}
                >
                  {currencyChoices.map((c) => (
                    <option key={c} value={c}>
                      {c}
                      {c === local ? ' (local)' : ''}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field label="Payout method">
                <Select
                  value={effective ?? ''}
                  disabled={available.length === 0}
                  onChange={(e) => setProvider(e.target.value as PayoutProvider)}
                >
                  {available.length === 0 ? (
                    <option value="">No rail available</option>
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
            when the first payout is due. */}
        {hasDestination && (
          <div
            className={cx(
              'rounded-xl px-4 py-3 text-sm leading-relaxed',
              route.blocked
                ? 'bg-danger-soft text-danger'
                : route.provider === 'stripe'
                  ? 'bg-held-soft text-held'
                  : 'bg-surface-2 text-fg-muted',
            )}
          >
            <span className="flex flex-wrap items-center gap-2">
              <strong className="font-semibold">
                {route.blocked ? 'Cannot be paid' : 'Will be paid via'}
              </strong>
              {route.provider && <ProviderChip provider={route.provider} />}
            </span>
            <span className="mt-1.5 block">{route.reason}</span>
          </div>
        )}

        {create.isError && <ErrorNote message={create.error.message} />}

        <div className="flex gap-2">
          <Button
            type="submit"
            variant="primary"
            disabled={create.isPending || (hasDestination && available.length === 0)}
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
