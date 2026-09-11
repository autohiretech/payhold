import { useEffect, useState } from 'react'
import { api, type Country, type Currency } from '@/api'
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
import { countriesByRegion } from '@/lib/countries'
import { SUPPORTED_CURRENCIES } from '@/lib/rails'
import { useMoneyAction, useSettings } from '@/lib/queries'
import { useAuth } from '@/auth/AuthProvider'

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
  const [country, setCountry] = useState<Country | ''>('')
  const [aiEnabled, setAiEnabled] = useState(true)
  const [aiBudget, setAiBudget] = useState('')
  const [riskEnabled, setRiskEnabled] = useState(true)
  const [riskThreshold, setRiskThreshold] = useState('')
  const [autoVerify, setAutoVerify] = useState(false)
  const [relayVerify, setRelayVerify] = useState(true)
  // False, and it must stay false: Save writes every field on this form, so a
  // ticked starting state would switch the dispute relay on for any account
  // that saved anything at all. The backend default is off in both places.
  const [relayDisputes, setRelayDisputes] = useState(false)
  const [holdHours, setHoldHours] = useState('')
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
    setCountry(settings.data.country ?? '')
    setAiEnabled(settings.data.ai_enabled)
    setAiBudget((settings.data.ai_monthly_budget_usd / 100).toString())
    setRiskEnabled(settings.data.risk_rules_enabled)
    setRiskThreshold((settings.data.risk_review_threshold_usd / 100).toString())
    setAutoVerify(settings.data.seller_auto_verify ?? false)
    setRelayVerify(settings.data.seller_verification_relay ?? true)
    setRelayDisputes(settings.data.dispute_decision_relay ?? false)
    setHoldHours((settings.data.destination_hold_hours ?? 24).toString())
  }, [settings.data])

  const save = useMoneyAction(() =>
    api.updateSettings({
      service_fee_rate: Number(feeRate) / 100,
      buyer_fee: Math.round(Number(buyerFee) * 100),
      clearance_days: Number(clearanceDays),
      auto_release_days: Number(autoReleaseDays),
      currencies,
      country,
      ai_enabled: aiEnabled,
      ai_monthly_budget_usd: Math.round(Number(aiBudget) * 100),
      risk_rules_enabled: riskEnabled,
      risk_review_threshold_usd: Math.round(Number(riskThreshold) * 100),
      seller_auto_verify: autoVerify,
      seller_verification_relay: relayVerify,
      dispute_decision_relay: relayDisputes,
      destination_hold_hours: Number(holdHours),
    }),
  )

  // Owner-only, and gated on typing the company's own slug — see the card
  // below for why both. The account is read here rather than inside the card
  // so the mutation can be declared with the others, unconditionally.
  const { account } = useAuth()
  const isOwner = account?.role === 'owner'
  const [confirmSlug, setConfirmSlug] = useState('')
  const reset = useMoneyAction(() => api.resetSandbox(confirmSlug.trim()))

  if (settings.isPending) {
    return (
      <>
        <PageHeader title="Settings" />
        <Skeleton className="h-96" />
      </>
    )
  }

  // RWF has no minor unit — 100,000 RWF *is* 100,000, not "100,000.00" written
  // as `100_000_00`. That literal reads as ten million: `_` is only a visual
  // separator in a JS number, never a decimal point.
  const exampleAmount = 100_000
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
              title="Company country"
              // Named because a transfer carries it: Flutterwave refuses a
              // Kenya M-Pesa payout whose sender has no country, and nothing on
              // the backend guesses one.
              subtitle="Where this company is registered. Sent as the sender country on payouts; some rails refuse a transfer without it."
            />
            <div className="px-6 py-5">
              <Field label="Country">
                <select
                  value={country}
                  onChange={(e) => setCountry(e.target.value as Country | '')}
                  className="w-full rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm text-fg"
                >
                  <option value="">Not set</option>
                  {countriesByRegion().map((group) => (
                    <optgroup key={group.region} label={group.region}>
                      {group.countries.map((c) => (
                        <option key={c.code} value={c.code}>
                          {c.name}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
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
              title="Seller onboarding"
              subtitle="Who checks that a seller is who they say they are, and how long a new payout destination waits before it can be used."
            />
            <div className="space-y-5 px-6 py-5">
              <label className="flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={autoVerify}
                  onChange={(e) => setAutoVerify(e.target.checked)}
                  className="mt-0.5 size-4 rounded border-line-strong text-brand focus:ring-brand/30"
                />
                <span>
                  <span className="block text-sm font-semibold text-fg">
                    My own onboarding verifies sellers
                  </span>
                  <span className="mt-1 block text-xs leading-relaxed text-fg-muted">
                    A new seller and their payout destination are recorded as
                    verified when they are registered, instead of waiting for
                    someone here to check them one at a time. This is your
                    attestation that your own signup checks identity, sanctions
                    and ownership — made once for the account rather than once
                    per seller, and recorded against you. Sellers already
                    registered are unaffected; verify those on their own page.
                  </span>
                </span>
              </label>

              {/*
                The other half of the same question, and deliberately not the
                same switch. The one above verifies a seller when they are
                registered — before anyone has looked at them, which is what a
                company doing its own manual review is precisely not asking
                for. This one changes nothing about a new seller and only says
                whose word we take when the review is finished.
              */}
              <label className="flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={relayVerify}
                  onChange={(e) => setRelayVerify(e.target.checked)}
                  className="mt-0.5 size-4 rounded border-line-strong text-brand focus:ring-brand/30"
                />
                <span>
                  <span className="block text-sm font-semibold text-fg">
                    I review each seller myself and tell PayHold the result
                  </span>
                  <span className="mt-1 block text-xs leading-relaxed text-fg-muted">
                    Your own system can mark a seller verified here the moment
                    you approve them, so nobody has to sign in and make the
                    same decision twice. New sellers still arrive unverified
                    and cannot be paid until you say so, and you can withdraw a
                    verification the same way. This is your attestation that
                    the review really happens — made once for the account and
                    recorded against you. Payout destinations are a separate
                    check and are still verified here.
                  </span>
                </span>
              </label>

              <Field
                label="New destination hold"
                hint="Hours a freshly added payout destination waits before money can be sent to it. This is what stops someone who got into a seller's account from redirecting their earnings, so zero is a real trade rather than a formality."
              >
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    min="0"
                    max="720"
                    value={holdHours}
                    onChange={(e) => setHoldHours(e.target.value)}
                  />
                  <span className="text-sm text-fg-muted">hours</span>
                </div>
              </Field>
            </div>
          </Card>

          <Card>
            <CardHeader
              title="Disputes"
              subtitle="Who decides a dispute: someone signed in here, or your own platform."
            />
            <div className="space-y-5 px-6 py-5">
              {/*
                Owner-only, and the endpoint refuses a change from anyone else.
                Unlike the seller relay above this one moves money: PayHold
                releases or refunds on whatever the platform reports. The
                warning is its own line so it cannot be skimmed past as part of
                the description.
              */}
              <label className="flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={relayDisputes}
                  disabled={!isOwner}
                  onChange={(e) => setRelayDisputes(e.target.checked)}
                  className="mt-0.5 size-4 rounded border-line-strong text-brand focus:ring-brand/30 disabled:opacity-50"
                />
                <span>
                  <span className="block text-sm font-semibold text-fg">
                    My platform decides disputes and tells PayHold the outcome
                  </span>
                  <span className="mt-1 block text-xs leading-relaxed text-fg-muted">
                    Your own system can resolve a dispute with its API key and
                    name the person who decided. That name is shown here as
                    reported by your platform.
                  </span>
                  <span className="mt-1 block text-xs font-semibold leading-relaxed text-fg">
                    PayHold will then release or refund money on your platform's
                    word, without anyone here checking the decision.
                  </span>
                  {!isOwner && (
                    <span className="mt-1 block text-xs text-fg-subtle">
                      Only the account owner can change this.
                    </span>
                  )}
                </span>
              </label>
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

          {/* The backend has had `POST /account/reset-sandbox` since migration
              20260817000001 and this repository's own notes described the
              control that calls it — and no screen ever did. It was reachable
              only by hand-building the request with a session token, which is
              exactly the shape the slug confirmation exists to prevent being
              casual. It is owner-only here for the same reason the endpoint
              refuses staff and viewers: this deletes every deal, seller, payout
              and ledger entry the company has, and the person doing that
              should be the one accountable for the company. The database is
              where the real guard lives — a tenant that ever connected live
              credentials is refused permanently, whatever this sends — so the
              typed slug is a net against a misclick, not the thing standing
              between a company and its history. */}
          {account?.role === 'owner' && (
            <Card>
              <CardHeader
                title="Start over"
                subtitle="Wipe this company's test data — every deal, seller, payout destination, payout, refund, dispute, ledger entry and audit row. Settings, logins and connected payment rails stay."
              />
              <div className="space-y-4 px-6 py-5">
                <p className="text-sm leading-relaxed text-fg-muted">
                  For a sandbox that has accumulated broken or stale test data. Refused
                  permanently once this company has ever connected live payment
                  credentials — real buyer money is what the append-only ledger exists
                  to make unforgettable. Your own app will need to register its sellers
                  again afterwards; anything it stored about them points at nothing.
                </p>
                <Field
                  label={`Type this company's slug to confirm: ${account.tenant_slug}`}
                  hint="Same check as deleting a repository. Nothing happens until it matches exactly."
                >
                  <Input
                    value={confirmSlug}
                    onChange={(e) => setConfirmSlug(e.target.value)}
                    placeholder={account.tenant_slug}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </Field>
                <div className="flex items-center gap-3">
                  <Button
                    variant="primary"
                    disabled={reset.isPending || confirmSlug.trim() !== account.tenant_slug}
                    onClick={async () => {
                      await reset.mutateAsync()
                      // A hard reload, not an invalidation: every query on
                      // every screen is now describing rows that do not
                      // exist, and the honest state is the empty company a
                      // fresh sign-in would show.
                      window.location.assign('/')
                    }}
                  >
                    {reset.isPending ? 'Wiping…' : 'Wipe this company\'s test data'}
                  </Button>
                </div>
                {reset.isError && <ErrorNote message={reset.error.message} />}
              </div>
            </Card>
          )}
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
