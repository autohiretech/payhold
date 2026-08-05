import { useEffect, useState } from 'react'
import { api, type Currency } from '@/api'
import {
  Button,
  Card,
  CardHeader,
  ErrorNote,
  Field,
  Input,
  PageHeader,
  Skeleton,
  cx,
} from '@/components/ui'
import { formatMoney, formatPercent } from '@/lib/format'
import { useMoneyAction, useSettings } from '@/lib/queries'

// Ordered to match the markets in lib/rails.ts, local currencies first.
const ALL_CURRENCIES: Currency[] = [
  'RWF',
  'KES',
  'UGX',
  'TZS',
  'GHS',
  'NGN',
  'USD',
  'EUR',
]

export function SettingsPage() {
  const settings = useSettings()

  const [feeRate, setFeeRate] = useState('')
  const [buyerFee, setBuyerFee] = useState('')
  const [clearanceDays, setClearanceDays] = useState('')
  const [autoReleaseDays, setAutoReleaseDays] = useState('')
  const [currencies, setCurrencies] = useState<Currency[]>([])
  const [saved, setSaved] = useState(false)

  // Seed the form once the real values arrive, then leave it alone so typing
  // is never clobbered by a refetch.
  useEffect(() => {
    if (!settings.data) return
    setFeeRate((settings.data.service_fee_rate * 100).toString())
    setBuyerFee((settings.data.buyer_fee / 100).toString())
    setClearanceDays(settings.data.clearance_days.toString())
    setAutoReleaseDays(settings.data.auto_release_days.toString())
    setCurrencies(settings.data.currencies)
  }, [settings.data])

  const save = useMoneyAction(() =>
    api.updateSettings({
      service_fee_rate: Number(feeRate) / 100,
      buyer_fee: Math.round(Number(buyerFee) * 100),
      clearance_days: Number(clearanceDays),
      auto_release_days: Number(autoReleaseDays),
      currencies,
    }),
  )

  if (settings.isPending) {
    return (
      <>
        <PageHeader title="Settings" />
        <Skeleton className="h-96" />
      </>
    )
  }

  const exampleAmount = 100_000_00
  const exampleFee = Math.round(exampleAmount * (Number(feeRate) / 100))

  return (
    <>
      <PageHeader
        title="Settings"
        subtitle="Fees and timers for this account. Changes apply to new deals only."
      />

      <div className="grid gap-5 lg:grid-cols-[1fr_18rem]">
        <div className="space-y-5">
          <Card>
            <CardHeader title="Fees" />
            <div className="grid gap-5 px-6 py-5 sm:grid-cols-2">
              <Field
                label="Service fee"
                hint={`Taken from each deal at release. Currently ${formatPercent(
                  Number(feeRate) / 100 || 0,
                )}.`}
              >
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    min="0"
                    max="50"
                    step="0.1"
                    value={feeRate}
                    onChange={(e) => setFeeRate(e.target.value)}
                  />
                  <span className="text-sm text-fg-muted">%</span>
                </div>
              </Field>

              <Field
                label="Buyer fee"
                hint="Optional flat amount added to what the buyer pays."
              >
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  value={buyerFee}
                  onChange={(e) => setBuyerFee(e.target.value)}
                />
              </Field>
            </div>
          </Card>

          <Card>
            <CardHeader
              title="Timers"
              subtitle="How long money waits before it moves on its own."
            />
            <div className="grid gap-5 px-6 py-5 sm:grid-cols-2">
              <Field
                label="Auto-release"
                hint="Days after the expected completion date before a silent buyer is treated as confirming."
              >
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    min="0"
                    max="90"
                    value={autoReleaseDays}
                    onChange={(e) => setAutoReleaseDays(e.target.value)}
                  />
                  <span className="text-sm text-fg-muted">days</span>
                </div>
              </Field>

              <Field
                label="Clearance"
                hint="Days between release and the payout being sent."
              >
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    min="0"
                    max="90"
                    value={clearanceDays}
                    onChange={(e) => setClearanceDays(e.target.value)}
                  />
                  <span className="text-sm text-fg-muted">days</span>
                </div>
              </Field>
            </div>
          </Card>

          <Card>
            <CardHeader
              title="Currencies"
              subtitle="A deal can only be created in a currency enabled here."
            />
            <div className="flex flex-wrap gap-2 px-6 py-5">
              {ALL_CURRENCIES.map((c) => {
                const on = currencies.includes(c)
                return (
                  <button
                    key={c}
                    type="button"
                    onClick={() =>
                      setCurrencies((prev) =>
                        on ? prev.filter((x) => x !== c) : [...prev, c],
                      )
                    }
                    className={cx(
                      'rounded-lg px-3 py-1.5 text-sm font-medium ring-1 ring-inset transition',
                      on
                        ? 'bg-brand-soft text-brand ring-brand/30'
                        : 'bg-surface text-fg-muted ring-line hover:text-fg',
                    )}
                  >
                    {c}
                  </button>
                )
              })}
            </div>
          </Card>

          {save.isError && <ErrorNote message={save.error.message} />}

          <div className="flex items-center gap-3">
            <Button
              variant="primary"
              disabled={save.isPending}
              onClick={async () => {
                await save.mutateAsync()
                setSaved(true)
                setTimeout(() => setSaved(false), 2500)
              }}
            >
              {save.isPending ? 'Saving…' : 'Save settings'}
            </Button>
            {saved && <span className="text-sm text-released">Saved.</span>}
          </div>
        </div>

        {/* A worked example, because percentages and day counts are abstract
            until you see them applied to real money. */}
        <Card className="h-fit p-6">
          <h2 className="text-sm font-semibold text-fg">On a 100,000 RWF deal</h2>
          <dl className="mt-3 space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-fg-muted">Buyer pays</dt>
              <dd className="tabular">
                {formatMoney(exampleAmount + Math.round(Number(buyerFee) * 100), 'RWF')}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-fg-muted">You keep</dt>
              <dd className="tabular">{formatMoney(exampleFee, 'RWF')}</dd>
            </div>
            <div className="flex justify-between border-t border-line pt-2">
              <dt className="text-fg-muted">Seller receives</dt>
              <dd className="tabular font-semibold">
                {formatMoney(exampleAmount - exampleFee, 'RWF')}
              </dd>
            </div>
          </dl>
          <p className="mt-4 text-xs text-fg-muted">
            Released automatically {autoReleaseDays || '—'} days after completion if the
            buyer stays silent, then paid out {clearanceDays || '—'} days later.
          </p>
        </Card>
      </div>
    </>
  )
}
