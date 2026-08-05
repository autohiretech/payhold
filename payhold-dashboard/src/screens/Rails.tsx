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

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type Country, type Provider } from '@/api'
import { ProviderChip, MethodIcon } from '@/components/rails'
import {
  Badge,
  Card,
  CardHeader,
  EmptyState,
  PageHeader,
  Select,
  Skeleton,
  Table,
  Td,
  Th,
  cx,
} from '@/components/ui'
import { formatMoney, type StatusMeta } from '@/lib/format'
import {
  COUNTRIES,
  METHOD_LABEL,
  PROVIDER_BLURB,
  PROVIDER_LABEL,
  RAILS,
  RAILS_VERIFIED,
  SCHEME_LABEL,
  countriesByRegion,
  countryFlag,
  countryName,
  marketSummary,
  payoutCapability,
  settlementNote,
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
  // The first configured currency is the tenant's home currency — everything
  // else is a foreign balance with its own settlement rules.
  const homeCurrency = currencies[0] ?? 'RWF'

  // The markets that matter to this tenant: everywhere they have a seller,
  // plus international for card-paying visitors.
  const markets: Country[] = [...new Set(sellers.data?.map((s) => s.country) ?? [])]

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
                  {rows.map((b) => {
                    // Each collected currency is its own balance at the
                    // provider, and getting a foreign one out has conditions
                    // the home currency does not.
                    const settlement = settlementNote(b.currency, homeCurrency)

                    return (
                      <div key={b.currency}>
                        <p className="mb-2 text-xs font-semibold tracking-[0.06em] text-fg-muted uppercase">
                          {b.currency} balance
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

                        {settlement && (
                          <p
                            className={cx(
                              'mt-2.5 rounded-lg px-3 py-2 text-xs leading-relaxed',
                              settlement.minimum !== null &&
                                b.available < settlement.minimum
                                ? 'bg-pending-soft text-pending'
                                : 'bg-surface-2 text-fg-muted',
                            )}
                          >
                            {settlement.minimum !== null &&
                              b.available < settlement.minimum && (
                                <strong className="font-semibold">
                                  Below the settlement minimum.{' '}
                                </strong>
                              )}
                            {settlement.detail}
                          </p>
                        )}
                      </div>
                    )
                  })}
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

      {/* --- Country-first explorer --------------------------------------- */}
      <MarketExplorer />

      {/* --- Collection coverage ----------------------------------------- */}
      <Card className="mb-6">
        <CardHeader
          title="Full coverage table"
          subtitle="Every configured rail, filtered to the currencies you accept."
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
                  <Td className="font-medium">
                    {countryFlag(rail.country)} {countryName(rail.country)}
                  </Td>
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
                        RAILS_VERIFIED ? 'text-released' : 'text-pending',
                      )}
                    >
                      {RAILS_VERIFIED ? 'Verified' : 'Unverified'}
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
                  <Td className="font-medium">
                    {countryFlag(country)} {countryName(country)}
                  </Td>
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

/**
 * Pick a country, see exactly what a buyer there gets. This is the view people
 * actually reach for — "if someone chooses Rwanda, what happens?" — so it
 * leads with the answer rather than making you read a table.
 */
function MarketExplorer() {
  const [country, setCountry] = useState<Country>('RW')
  const market = marketSummary(country)

  return (
    <Card className="mb-6">
      <CardHeader
        title="What happens in each market"
        subtitle="Pick a country to see the rail, the currencies, and every method a buyer there can use."
      />

      <div className="border-b border-line px-6 py-4">
        <div className="flex flex-wrap items-end gap-4">
          <label className="block w-full sm:w-72">
            <span className="mb-2 block text-sm font-semibold text-fg">Country</span>
            <Select
              value={country}
              onChange={(e) => setCountry(e.target.value as Country)}
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
          </label>

          <p className="text-sm text-fg-muted">
            {COUNTRIES.length} markets configured ·{' '}
            {COUNTRIES.filter((c) => c.momo).length} with mobile money ·{' '}
            {COUNTRIES.filter((c) => c.flutterwavePayout || c.stripePayout).length}{' '}
            we can pay into
          </p>
        </div>
      </div>

      {!market.hasLocalRails ? (
        <div className="px-6 py-6">
          <p className="rounded-xl bg-pending-soft px-4 py-3 text-sm leading-relaxed text-pending">
            <strong className="font-semibold">
              No local rail in {market.name} — cards only.
            </strong>{' '}
            A buyer there can still pay, by international card in{' '}
            {market.currencies.join(' or ')}. There is no local wallet or bank
            rail, and {market.payout.provider ? 'payouts go via Stripe' : 'no way to pay a seller based there'}.
          </p>
        </div>
      ) : (
        <div className="grid gap-6 px-6 py-6 md:grid-cols-2">
          <div>
            <p className="text-xs font-semibold tracking-[0.06em] text-fg-muted uppercase">
              Collected by
            </p>
            <div className="mt-2">
              <ProviderChip provider={market.provider ?? 'stripe'} />
            </div>

            <p className="mt-5 text-xs font-semibold tracking-[0.06em] text-fg-muted uppercase">
              Buyers pay in
            </p>
            <p className="mt-2 text-sm text-fg">
              <span className="font-semibold">{market.currency}</span>
              {market.currencies.length > 1 && (
                <span className="text-fg-muted">
                  {' '}
                  · also {market.currencies.filter((c) => c !== market.currency).join(', ')}
                </span>
              )}
            </p>

            {market.networks.length > 0 && (
              <>
                <p className="mt-5 text-xs font-semibold tracking-[0.06em] text-fg-muted uppercase">
                  Wallets
                </p>
                <p className="mt-2 text-sm text-fg">{market.networks.join(', ')}</p>
              </>
            )}

            <p className="mt-5 text-xs font-semibold tracking-[0.06em] text-fg-muted uppercase">
              Cards accepted
            </p>
            <p className="mt-2 text-sm text-fg">
              {market.schemes.map((s) => SCHEME_LABEL[s]).join(', ')}
            </p>

            <p className="mt-5 text-xs font-semibold tracking-[0.06em] text-fg-muted uppercase">
              Sellers paid via
            </p>
            <div className="mt-2">
              {market.payout.provider ? (
                <ProviderChip provider={market.payout.provider} />
              ) : (
                <span className="text-sm font-semibold text-danger">
                  Cannot pay sellers here
                </span>
              )}
            </div>
            <p className="mt-2 text-sm leading-relaxed text-fg-muted">
              {market.payout.reason}
            </p>
          </div>

          <div>
            <p className="text-xs font-semibold tracking-[0.06em] text-fg-muted uppercase">
              Local methods
            </p>
            {market.localMethods.length === 0 ? (
              <p className="mt-2 text-sm text-fg-muted">
                None — cards only in this market.
              </p>
            ) : (
              <ul className="mt-2 space-y-2">
                {market.localMethods.map((rail) => (
                  <li
                    key={rail.method}
                    className="flex items-center justify-between gap-3 rounded-xl bg-surface-2 px-3.5 py-2.5"
                  >
                    <span className="flex items-center gap-2.5 text-sm font-medium text-fg">
                      <span className="text-fg-muted">
                        <MethodIcon method={rail.method} />
                      </span>
                      {METHOD_LABEL[rail.method]}
                    </span>
                    <span className="text-xs font-semibold text-fg-muted">
                      {rail.payout ? 'in + out' : 'in only'}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {market.notes.length > 0 && (
              <ul className="mt-4 space-y-2">
                {market.notes.map((note) => (
                  <li
                    key={note}
                    className="rounded-xl bg-pending-soft px-3.5 py-2.5 text-xs leading-relaxed text-pending"
                  >
                    {note}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </Card>
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
