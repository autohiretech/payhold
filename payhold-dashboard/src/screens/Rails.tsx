/**
 * Payment rails.
 *
 * Answers three operational questions in one place:
 *   1. How much money is sitting on each provider right now?
 *   2. Which methods can a buyer in market X actually use?
 *   3. Can we pay a seller in market Y, and on which rail?
 *
 * The third is the one that catches people out — Stripe collects worldwide but
 * cannot send funds to Rwanda or Kenya, so every African payout rides
 * Flutterwave regardless of how the money came in.
 */

import { useQuery } from '@tanstack/react-query'
import { api, type Country, type Provider } from '@/api'
import { ProviderChip, MethodIcon } from '@/components/rails'
import {
  Badge,
  Card,
  CardHeader,
  EmptyState,
  PageHeader,
  Skeleton,
  Table,
  Td,
  Th,
  cx,
} from '@/components/ui'
import { formatMoney, type StatusMeta } from '@/lib/format'
import {
  COUNTRY_LABEL,
  METHOD_LABEL,
  PROVIDER_BLURB,
  PROVIDER_LABEL,
  RAILS,
  payoutCapability,
} from '@/lib/rails'
import { keys, useSellers, useSettings } from '@/lib/queries'

/**
 * Which providers are actually configured. Hardcoded while the backend does
 * not exist — once it does, this comes from `tenant_provider_accounts` and the
 * demo rail disappears the moment real keys are present.
 */
const PROVIDER_STATE: Record<Provider, StatusMeta> = {
  flutterwave: {
    label: 'Sandbox keys',
    tone: 'pending',
    hint: 'Test credentials only. No real money moves.',
  },
  stripe: {
    label: 'Not configured',
    tone: 'neutral',
    hint: 'Add Stripe keys to activate international card collection.',
  },
  fake: {
    label: 'Active',
    tone: 'released',
    hint: 'Demo mode — payments are simulated end to end.',
  },
}

export function RailsPage() {
  const railBalances = useQuery({
    queryKey: [...keys.balance, 'rails'],
    queryFn: () => api.getRailBalances(),
  })
  const sellers = useSellers()
  const settings = useSettings()

  const providers: Provider[] = ['flutterwave', 'stripe']
  const currencies = settings.data?.currencies ?? []

  // The markets that matter to this tenant: everywhere they have a seller,
  // plus international for card-paying visitors.
  const sellerCountries = [...new Set(sellers.data?.map((s) => s.country) ?? [])]
  const markets: Country[] = [...new Set<Country>([...sellerCountries, 'INTL'])]

  return (
    <>
      <PageHeader
        title="Payment rails"
        subtitle="Which provider handles which payment method, where the money sits, and who can be paid."
      />

      {/* --- Provider balances ------------------------------------------- */}
      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        {providers.map((provider) => {
          const rows =
            railBalances.data?.filter((b) => b.provider === provider) ?? []
          const state = PROVIDER_STATE[provider]

          return (
            <Card key={provider} className="p-6">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h2 className="text-base font-semibold text-fg">
                      {PROVIDER_LABEL[provider]}
                    </h2>
                    <Badge meta={state} />
                  </div>
                  <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-fg-muted">
                    {PROVIDER_BLURB[provider]}
                  </p>
                </div>
              </div>

              {railBalances.isPending ? (
                <Skeleton className="mt-5 h-24" />
              ) : rows.length === 0 ? (
                <p className="mt-5 rounded-xl bg-surface-2 px-4 py-3 text-sm text-fg-muted">
                  No money has moved on this rail.
                </p>
              ) : (
                <div className="mt-5 space-y-4">
                  {rows.map((b) => (
                    <div key={b.currency}>
                      <p className="mb-2 text-xs font-semibold tracking-[0.06em] text-fg-muted uppercase">
                        {b.currency}
                      </p>
                      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                        <Row label="Held" value={formatMoney(b.held, b.currency)} />
                        <Row
                          label="Clearing"
                          value={formatMoney(b.pending_clearance, b.currency)}
                        />
                        <Row
                          label="Available"
                          value={formatMoney(b.available, b.currency)}
                        />
                        <Row
                          label="Paid out"
                          value={formatMoney(b.paid_out, b.currency)}
                          muted
                        />
                      </dl>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          )
        })}
      </div>

      <p className="mb-6 text-sm leading-relaxed text-fg-muted">
        These are separate pots. Reconciliation compares each one against that
        provider's reported balance independently — a Flutterwave shortfall says
        nothing about Stripe, and vice versa.
      </p>

      {/* --- Collection coverage ----------------------------------------- */}
      <Card className="mb-6">
        <CardHeader
          title="What buyers can pay with"
          subtitle="Only methods enabled for a currency you accept are offered at checkout."
        />
        {!currencies.length ? (
          <EmptyState title="No currencies enabled" body="Enable one in Settings." />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Market</Th>
                <Th>Method</Th>
                <Th>Currencies</Th>
                <Th>Routes to</Th>
                <Th align="right">Status</Th>
              </tr>
            </thead>
            <tbody>
              {RAILS.filter(
                (r) => r.collect && r.currencies.some((c) => currencies.includes(c)),
              ).map((rail) => (
                <tr
                  key={`${rail.country}-${rail.method}-${rail.provider}`}
                  className="hover:bg-surface-2"
                >
                  <Td className="font-medium">{COUNTRY_LABEL[rail.country]}</Td>
                  <Td>
                    <span className="inline-flex items-center gap-2 text-fg">
                      <span className="text-fg-muted">
                        <MethodIcon method={rail.method} />
                      </span>
                      {METHOD_LABEL[rail.method]}
                    </span>
                    {rail.note && (
                      <p className="mt-1 max-w-sm text-xs leading-relaxed text-fg-muted">
                        {rail.note}
                      </p>
                    )}
                  </Td>
                  <Td className="text-fg-muted">
                    {rail.currencies
                      .filter((c) => currencies.includes(c))
                      .join(' · ')}
                  </Td>
                  <Td>
                    <ProviderChip provider={rail.provider} />
                  </Td>
                  <Td align="right">
                    <span
                      className={cx(
                        'text-xs font-semibold',
                        rail.verified ? 'text-released' : 'text-pending',
                      )}
                    >
                      {rail.verified ? 'Verified' : 'Unverified'}
                    </span>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <div className="border-t border-line bg-pending-soft px-6 py-4 text-sm leading-relaxed text-pending">
          <strong className="font-semibold">Unverified rows are a plan, not a
          guarantee.</strong>{' '}
          Each one must be checked against the provider's own country and method
          documentation, and against your signed account agreement, before it
          carries live money. A wrong row means a charge you cannot collect — or
          money you collect and cannot pay out.
        </div>
      </Card>

      {/* --- Payout coverage ---------------------------------------------- */}
      <Card>
        <CardHeader
          title="Who you can pay"
          subtitle="Collection and payout are separate capabilities. A rail that takes money cannot always send it."
        />
        <Table>
          <thead>
            <tr>
              <Th>Market</Th>
              <Th>Sellers</Th>
              <Th>Payout rail</Th>
              <Th>Why</Th>
            </tr>
          </thead>
          <tbody>
            {markets.map((country) => {
              const capability = payoutCapability(country)
              const count =
                sellers.data?.filter((s) => s.country === country).length ?? 0

              return (
                <tr key={country} className="hover:bg-surface-2">
                  <Td className="font-medium">{COUNTRY_LABEL[country]}</Td>
                  <Td className="text-fg-muted">
                    {count === 0 ? '—' : `${count} registered`}
                  </Td>
                  <Td>
                    {capability.provider ? (
                      <ProviderChip provider={capability.provider} />
                    ) : (
                      <span className="text-xs font-semibold text-danger">
                        None configured
                      </span>
                    )}
                  </Td>
                  <Td className="max-w-md text-sm leading-relaxed text-fg-muted">
                    {capability.reason}
                  </Td>
                </tr>
              )
            })}
          </tbody>
        </Table>
      </Card>
    </>
  )
}

function Row({
  label,
  value,
  muted,
}: {
  label: string
  value: string
  muted?: boolean
}) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-fg-muted">{label}</dt>
      <dd className={cx('tabular font-medium', muted ? 'text-fg-muted' : 'text-fg')}>
        {value}
      </dd>
    </div>
  )
}
