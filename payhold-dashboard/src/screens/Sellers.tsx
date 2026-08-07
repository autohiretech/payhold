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
import { formatDate } from '@/lib/format'
import { useMoneyAction, useSellers } from '@/lib/queries'

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

      <Card>
        <CardHeader
          title="Registered sellers"
          subtitle="Destinations are tokenized by the provider. PayHold never stores the real number."
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
                const route = payoutRoute(s.country, s.payout_currency)
                return (
                  <tr key={s.id} className="hover:bg-surface-2">
                    <Td className="font-medium">
                      <Link className="text-brand hover:underline" to={`/sellers/${s.id}`}>
                        {s.name}
                      </Link>
                    </Td>
                    <Td className="text-fg-muted">
                      {countryFlag(s.country)} {countryName(s.country)}
                    </Td>
                    <Td className="text-fg-muted">
                      {PAYOUT_PROVIDER_LABEL[s.payout_provider]}
                    </Td>
                    <Td>
                      <Mono>{s.masked_destination}</Mono>
                    </Td>
                    <Td className="tabular text-fg-muted">{s.payout_currency}</Td>
                    <Td>
                      {route.provider ? (
                        <span title={route.reason}>
                          <ProviderChip provider={route.provider} />
                        </span>
                      ) : (
                        <span
                          className="text-xs font-semibold text-danger"
                          title={route.reason}
                        >
                          No rail
                        </span>
                      )}
                    </Td>
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
        </div>

        {/* The resulting route, stated before you save rather than discovered
            when the first payout is due. */}
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

        {create.isError && <ErrorNote message={create.error.message} />}

        <div className="flex gap-2">
          <Button
            type="submit"
            variant="primary"
            disabled={create.isPending || available.length === 0}
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
