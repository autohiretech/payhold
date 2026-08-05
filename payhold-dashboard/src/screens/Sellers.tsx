import { useState } from 'react'
import { api, type Country, type Currency, type PayoutProvider } from '@/api'
import { ProviderChip } from '@/components/rails'
import {
  COUNTRY_FLAG,
  COUNTRY_LABEL,
  defaultCurrencyFor,
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

const PAYOUT_LABEL: Record<PayoutProvider, string> = {
  flutterwave_momo: 'Mobile money (MTN / Airtel)',
  flutterwave_mpesa: 'M-Pesa',
  flutterwave_bank: 'Bank transfer',
  stripe_connect: 'Stripe Connect',
}

/**
 * Which payout methods make sense in each market. A market with an empty list
 * has no way to receive money yet — the form says so rather than offering a
 * destination that would never pay.
 */
const PAYOUT_BY_COUNTRY: Record<Country, PayoutProvider[]> = {
  RW: ['flutterwave_momo', 'flutterwave_bank'],
  KE: ['flutterwave_mpesa', 'flutterwave_bank'],
  UG: ['flutterwave_momo', 'flutterwave_bank'],
  TZ: ['flutterwave_mpesa', 'flutterwave_bank'],
  GH: ['flutterwave_momo', 'flutterwave_bank'],
  NG: ['flutterwave_bank'],
  ZA: [],
  INTL: ['stripe_connect'],
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
                    <Td className="font-medium">{s.name}</Td>
                    <Td className="text-fg-muted">{COUNTRY_LABEL[s.country]}</Td>
                    <Td className="text-fg-muted">
                      {PAYOUT_LABEL[s.payout_provider]}
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
  const available = PAYOUT_BY_COUNTRY[country]
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
        `No payout rail is configured for ${COUNTRY_LABEL[country]} — a seller there cannot be paid yet.`,
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
              {(Object.keys(PAYOUT_BY_COUNTRY) as Country[]).map((c) => (
                <option key={c} value={c}>
                  {COUNTRY_FLAG[c]}  {COUNTRY_LABEL[c]}
                </option>
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
                    {PAYOUT_LABEL[p]}
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
