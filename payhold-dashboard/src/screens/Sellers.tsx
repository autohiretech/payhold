import { useState } from 'react'
import { api, type PayoutProvider } from '@/api'
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
} from '@/components/ui'
import { formatDate } from '@/lib/format'
import { useMoneyAction, useSellers } from '@/lib/queries'

const PROVIDER_LABEL: Record<PayoutProvider, string> = {
  flutterwave_momo: 'Mobile money (MTN / Airtel)',
  flutterwave_bank: 'Bank transfer',
  stripe_connect: 'Stripe Connect',
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
                <Th>Method</Th>
                <Th>Destination</Th>
                <Th>Token</Th>
                <Th align="right">Added</Th>
              </tr>
            </thead>
            <tbody>
              {sellers.data.map((s) => (
                <tr key={s.id} className="hover:bg-surface-2">
                  <Td className="font-medium">{s.name}</Td>
                  <Td className="text-fg-muted">
                    {PROVIDER_LABEL[s.payout_provider]}
                  </Td>
                  <Td>
                    <Mono>{s.masked_destination}</Mono>
                  </Td>
                  <Td>
                    <Mono>{s.beneficiary_token}</Mono>
                  </Td>
                  <Td align="right" className="text-fg-muted">
                    {formatDate(s.created_at)}
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

function AddSellerForm({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('')
  const [provider, setProvider] = useState<PayoutProvider>('flutterwave_momo')
  const [destination, setDestination] = useState('')

  const create = useMoneyAction(() =>
    api.createSeller({ name, payout_provider: provider, destination }),
  )

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
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Name">
            <Input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Jean-Paul Habimana"
            />
          </Field>

          <Field label="Payout method">
            <Select
              value={provider}
              onChange={(e) => setProvider(e.target.value as PayoutProvider)}
            >
              {(Object.keys(PROVIDER_LABEL) as PayoutProvider[]).map((p) => (
                <option key={p} value={p}>
                  {PROVIDER_LABEL[p]}
                </option>
              ))}
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

        {create.isError && <ErrorNote message={create.error.message} />}

        <div className="flex gap-2">
          <Button type="submit" variant="primary" disabled={create.isPending}>
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
