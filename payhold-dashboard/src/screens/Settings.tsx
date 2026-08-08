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
import { SUPPORTED_CURRENCIES } from '@/lib/rails'
import { useMoneyAction, useSettings } from '@/lib/queries'

// Derived from the rail table: a currency no rail can collect would only
// create deals nobody can pay.
const ALL_CURRENCIES: Currency[] = SUPPORTED_CURRENCIES

export function SettingsPage() {
  const settings = useSettings()

  const [feeRate, setFeeRate] = useState('')
  const [buyerFee, setBuyerFee] = useState('')
  const [clearanceDays, setClearanceDays] = useState('')
  const [autoReleaseDays, setAutoReleaseDays] = useState('')
  const [currencies, setCurrencies] = useState<Currency[]>([])
  const [aiEnabled, setAiEnabled] = useState(true)
  const [aiBudget, setAiBudget] = useState('')
  const [riskEnabled, setRiskEnabled] = useState(true)
  const [riskThreshold, setRiskThreshold] = useState('')
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
    setAiEnabled(settings.data.ai_enabled)
    setAiBudget((settings.data.ai_monthly_budget_usd / 100).toString())
    setRiskEnabled(settings.data.risk_rules_enabled)
    setRiskThreshold((settings.data.risk_review_threshold_usd / 100).toString())
  }, [settings.data])

  const save = useMoneyAction(() =>
    api.updateSettings({
      service_fee_rate: Number(feeRate) / 100,
      buyer_fee: Math.round(Number(buyerFee) * 100),
      clearance_days: Number(clearanceDays),
      auto_release_days: Number(autoReleaseDays),
      currencies,
      ai_enabled: aiEnabled,
      ai_monthly_budget_usd: Math.round(Number(aiBudget) * 100),
      risk_rules_enabled: riskEnabled,
      risk_review_threshold_usd: Math.round(Number(riskThreshold) * 100),
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
              // Selecting none is not "none allowed" — the deals endpoint only
              // filters when the list is non-empty, so an empty selection is
              // the absence of a restriction rather than the strictest one.
              // Saying "only a currency enabled here" was false in exactly the
              // state every new company starts in.
              subtitle={
                currencies.length
                  ? 'A deal can only be created in a currency enabled here.'
                  : 'Nothing selected means no restriction — a deal may be created in any currency. Select some to narrow that.'
              }
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

          <Card>
            <CardHeader
              title="Risk rules"
              subtitle="Fixed rules, checked before every payout leaves. Not the AI — these are arithmetic on your own history, and the same facts always give the same answer."
            />
            <div className="space-y-5 px-6 py-5">
              <label className="flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={riskEnabled}
                  onChange={(e) => setRiskEnabled(e.target.checked)}
                  className="mt-0.5 size-4 rounded border-line-strong text-brand focus:ring-brand/30"
                />
                <span>
                  <span className="block text-sm font-semibold text-fg">
                    Hold unusual payouts for review
                  </span>
                  <span className="mt-1 block text-xs leading-relaxed text-fg-muted">
                    A first payout to a seller who registered just before the
                    booking, a jump well past anything they have been paid
                    before, or a seller who recently lost a dispute. A held
                    payout waits for a person — nothing is cancelled, and
                    nothing sends itself. With this off we still record what we
                    noticed; we just do not stop anything.
                  </span>
                </span>
              </label>

              <Field
                label="Review threshold"
                hint="Payouts at or above this get the closer look. Set in USD and converted to whatever the seller banks in."
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm text-fg-muted">USD</span>
                  <Input
                    type="number"
                    min="0"
                    step="1"
                    value={riskThreshold}
                    disabled={!riskEnabled}
                    onChange={(e) => setRiskThreshold(e.target.value)}
                  />
                </div>
              </Field>
            </div>
          </Card>

          <Card>
            <CardHeader
              title="Intelligence"
              subtitle="Drafted dispute resolutions, risk summaries before a payout, and the dashboard assistant."
            />
            <div className="space-y-5 px-6 py-5">
              <label className="flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={aiEnabled}
                  onChange={(e) => setAiEnabled(e.target.checked)}
                  className="mt-0.5 size-4 rounded border-line-strong text-brand focus:ring-brand/30"
                />
                <span>
                  <span className="block text-sm font-semibold text-fg">
                    Draft suggestions and answer questions
                  </span>
                  <span className="mt-1 block text-xs leading-relaxed text-fg-muted">
                    Suggestions are advisory. Approving one is your decision and
                    is recorded as such. Turning this off removes the drafts and
                    nothing else — deals, releases, refunds and payouts do not
                    depend on it.
                  </span>
                </span>
              </label>

              <Field
                label="Monthly budget"
                hint="When the month's spend reaches this, drafts and chat switch off until next month. Money paths are never affected."
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm text-fg-muted">USD</span>
                  <Input
                    type="number"
                    min="0"
                    step="1"
                    value={aiBudget}
                    disabled={!aiEnabled}
                    onChange={(e) => setAiBudget(e.target.value)}
                  />
                </div>
              </Field>
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
