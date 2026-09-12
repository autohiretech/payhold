/**
 * Balance — held, pending clearance, available, paid out.
 *
 *   GET  /balance                     per currency
 *   GET  /balance?by=rail             per provider and currency
 *   GET  /balance?live=1              adds `atRail`, live from each provider
 *
 * Every number in `balances` is derived from the ledger by `tenant_balances()`
 * and `rail_balances()`. There is no stored balance column anywhere in the
 * system, which is what makes "the ledger is the truth" a fact about the
 * schema rather than a habit people have to keep. `?live=1` does not change
 * that — it adds a second, opt-in array asking each connected rail what it
 * actually holds *right now*, so the dashboard can show the ledger figure next
 * to the provider's own answer rather than only trusting they agree.
 *
 * The rail view is the operationally honest one: "held" is never one pot. It is
 * a Flutterwave balance and a Stripe balance, reconciled against different
 * APIs, and only one of them can pay an African seller.
 *
 * **`live=1` is opt-in and the default path is untouched.** A provider API
 * call on every balance read would be slow — this rail's or that rail's — and
 * rate-limited on top of it, so an unmodified caller sees exactly the response
 * it always has: the `by=rail` switch, and nothing else, decide `balances`.
 * `atRail` is only ever added, never substituted for it.
 *
 * **Live path, one call per rail.** `connectedRails` says which of
 * flutterwave/stripe/paypal this tenant has a stored account for; each
 * connected one gets exactly one `provider.balances()` call, never one per
 * currency — the same shape `reconciliation.ts`'s nightly pass already uses,
 * because this is the same question asked on demand instead of on a clock.
 *
 * **A rail with no stored account is not a failure.** `connectedRails` never
 * offers it to the live loop in the first place, but a tenant can disconnect a
 * rail between that check and the call, and `loadProvider` throws the same
 * `railNotConnected` refusal for it that the nightly pass already knows how to
 * tell apart from a real outage (`isRailNotConnected`, `_shared/load-provider.ts`).
 * That case is skipped — no `atRail` row, no `error` string, no log line — for
 * the identical reason `reconcileRail` skips it: a company that simply hasn't
 * connected Stripe is an ordinary state, not a fault, and reporting it as one
 * would read as an outage on a rail nobody is using.
 *
 * **A live call that fails or times out degrades to the last thing
 * reconciliation actually recorded**, per rail *and* currency, with
 * `stale: true` and the failure named in `error`. That fallback reads
 * `last_rail_readings` (migration `20260912000005`) rather than
 * `reconciliation_alerts`: the alerts table is a case log — a row opens or
 * refreshes on drift and resolves when drift clears — so a rail that has
 * reconciled clean every night forever had *no row at all*, ever, for that
 * currency, and a perfectly healthy rail with no history of drift showed
 * `amount: null, stale: true` here exactly as an actually-broken one with no
 * history would. `last_rail_readings` is `record_reconciliation`'s upsert of
 * the latest reading per (tenant, provider, currency), written on *every*
 * pass regardless of drift, so a checked-and-agreed rail now falls back to a
 * real figure and only a rail with no reconciliation history at all —
 * connected moments ago, or never reconciled — still answers `amount: null`.
 * The dashboard still cannot tell those two apart from this endpoint alone —
 * that is what `reconciliation_runs` is for, and this endpoint does not read
 * it — but "never disagreed" no longer looks like "never checked".
 */

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { resolveCaller, serviceClient } from '../_shared/auth.ts'
import { handler, json } from '../_shared/http.ts'
import { connectedRails, isRailNotConnected, loadProvider } from '../_shared/load-provider.ts'
import { PayHoldError, type Currency, type Money, type Provider } from '../_shared/types.ts'

/**
 * `POST /balance/external-transfers` was removed 2026-09-12, at the account
 * owner's request.
 *
 * It let a person file a claim that they had moved money between their own
 * provider accounts — a top-up PayHold cannot observe, since under
 * bring-your-own-keys it orchestrates and never custodies. The intent was
 * sound: `reconciliation.ts` adds `tenant_funds` into what it expects to find
 * on a rail, so an unexplained top-up reads as drift and
 * `record_reconciliation` freezes the tenant's payouts.
 *
 * What made it worse than the problem it solved is that `record_external_transfer`
 * validated the actor, the reference and a non-zero amount — and nothing about
 * the money. It never asked the rail registry whether that provider can hold
 * that currency, so the only two entries ever filed included a **GHS balance on
 * PayPal**, a rail that carries USD and EUR alone (`_shared/rails.ts`). A
 * mistyped claim does not just mislead a tile: it lands in `expected()` and
 * arms the same payout freeze the feature existed to prevent.
 *
 * If this comes back, it needs `(provider, currency)` checked against the rail
 * registry before the insert, and the form needs `toMinorUnits(amount, currency)`
 * rather than a hardcoded x100 — RWF is zero-decimal, so that multiply filed a
 * 100x overstatement for the currency the form defaulted to.
 *
 * The ledger keeps `external_transfer` as an entry type: `rail_balances` still
 * reads it, the two historical rows still exist (the ledger is append-only),
 * and `cross_rail_offset` / `cross_rail_payout` — which the system writes for
 * itself and can verify — are untouched.
 */

/** One row of `rail_balances()` — only the two columns `atRail` needs. */
interface RailBalanceRow {
  provider: Provider
  currency: Currency
}

/** One row of `atRail`, the wire shape a parallel dashboard build depends on. */
interface AtRailBalance {
  provider: Provider
  currency: Currency
  amount: Money | null
  as_of: string | null
  stale: boolean
  error: string | null
  /**
   * Which account answered. A rail connected in `test` mode returns its
   * SANDBOX balance, and sandbox money is not money — showing it beside a
   * ledger figure without saying so is the one way this endpoint could lie
   * while every number in it is technically what the provider reported.
   * `null` when no live call was made and the stored reading did not record
   * a mode.
   */
  mode: 'test' | 'live' | null
  /**
   * The provider's own clearing split on `amount`, straight off
   * `PaymentProvider.balances()` — see that interface for what each field
   * means and why every one of them is independently nullable rather than
   * derived here. All three are `null` on the stored-reading fallback path:
   * `last_rail_readings` only ever kept `amount`, so there is nothing to
   * degrade to for a live call that failed.
   */
  available: Money | null
  pending: Money | null
  available_on: string | null
}

/**
 * A provider call is not allowed to hang the whole request. §5.1's proxy note
 * on Flutterwave already says egress here can be slow or unreachable; a
 * dashboard tile is not worth blocking a request on a rail having a bad
 * minute, so a slow call fails exactly like a thrown one and falls back the
 * same way.
 */
const LIVE_CALL_TIMEOUT_MS = 8_000

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (err) => { clearTimeout(timer); reject(err) },
    )
  })
}

/**
 * The most recent provider balance `record_reconciliation` actually stored
 * for this rail, per currency — the fallback for a live call that failed.
 *
 * `last_rail_readings` (migration `20260912000005`) is one row per
 * (tenant, provider, currency), upserted on every reconciliation pass
 * regardless of drift — unlike `reconciliation_alerts`, there is nothing to
 * coalesce here: no open/resolved distinction and no history to pick the
 * newest of, because the table only ever holds the newest.
 */
async function lastRecordedBalances(
  db: SupabaseClient,
  tenantId: string,
  provider: Provider,
  currencies: Currency[],
): Promise<Map<Currency, { amount: Money; as_of: string }>> {
  const latest = new Map<Currency, { amount: Money; as_of: string }>()
  if (currencies.length === 0) return latest

  const { data, error } = await db
    .from('last_rail_readings')
    .select('currency, provider_balance, read_at')
    .eq('tenant_id', tenantId)
    .eq('provider', provider)
    .in('currency', currencies)

  if (error || !data) return latest

  for (const row of data as {
    currency: Currency
    provider_balance: Money
    read_at: string
  }[]) {
    latest.set(row.currency, { amount: row.provider_balance, as_of: row.read_at })
  }

  return latest
}

/**
 * `atRail` for one connected rail: a live call on success, the last recorded
 * reconciliation figure — marked stale, with a reason — on failure or timeout.
 *
 * `knownCurrencies` anchors the fallback case: a failed live call has no
 * currency list of its own, so which `(provider, currency)` rows to even ask
 * `reconciliation_alerts` about comes from `rail_balances()`, the same ledger
 * read `balances` is already built from. A connected rail with no ledger
 * activity and a failing live call has nothing to anchor a row to and
 * contributes none — there is no currency to be honestly wrong about.
 */
async function atRailForRail(
  db: SupabaseClient,
  tenantId: string,
  rail: Provider,
  knownCurrencies: Currency[],
): Promise<AtRailBalance[]> {
  try {
    const { provider, mode } = await loadProvider(db, tenantId, rail)
    const live = await withTimeout(provider.balances(), LIVE_CALL_TIMEOUT_MS, `${rail} balances()`)
    const now = new Date().toISOString()
    return live.map((b) => ({
      provider: rail,
      currency: b.currency,
      amount: b.amount,
      as_of: now,
      stale: false,
      error: null,
      mode,
      // `?? null` rather than a bare pass-through: an adapter that has not
      // been taught one of these (or omits the field entirely) must still
      // answer `null` here, never `undefined` sailing into the JSON response.
      available: b.available ?? null,
      pending: b.pending ?? null,
      available_on: b.available_on ?? null,
    }))
  } catch (err) {
    // A rail this tenant has never connected — or disconnected between the
    // `connectedRails` check and this call — is an ordinary state, not an
    // outage, exactly as `reconcileRail` treats it. It gets no row at all
    // rather than one dressed up as a failure.
    if (isRailNotConnected(err)) return []

    const reason = err instanceof Error ? err.message : String(err)
    console.error('live rail balance call failed', { tenant_id: tenantId, provider: rail, message: reason })

    const stored = await lastRecordedBalances(db, tenantId, rail, knownCurrencies)
    return knownCurrencies.map((currency) => {
      const found = stored.get(currency)
      return {
        provider: rail,
        currency,
        amount: found?.amount ?? null,
        as_of: found?.as_of ?? null,
        stale: true,
        error: reason,
        // The rail could not be reached, so nothing answered and there is no
        // account to attribute the stored figure to.
        mode: null,
        // `last_rail_readings` only ever stored `amount` — the reconciliation
        // pass that writes it compares that figure alone. There is no split
        // to fall back to, so this path is null across the board rather than
        // reusing whatever the last live call happened to see.
        available: null,
        pending: null,
        available_on: null,
      }
    })
  }
}

/**
 * `atRail` for the whole tenant: one `provider.balances()` call per connected
 * rail, run concurrently — a slow Flutterwave must not delay a fast Stripe.
 */
async function liveAtRail(
  db: SupabaseClient,
  tenantId: string,
  railRows: RailBalanceRow[],
): Promise<AtRailBalance[]> {
  const currenciesByProvider = new Map<Provider, Currency[]>()
  for (const row of railRows) {
    const list = currenciesByProvider.get(row.provider) ?? []
    if (!list.includes(row.currency)) list.push(row.currency)
    currenciesByProvider.set(row.provider, list)
  }

  const rails = await connectedRails(db, tenantId)
  const results = await Promise.all(
    rails
      .filter((r) => r.connected)
      .map((r) => atRailForRail(db, tenantId, r.provider, currenciesByProvider.get(r.provider) ?? [])),
  )

  return results.flat()
}

Deno.serve(handler(async (req) => {
  const db = serviceClient()
  const caller = await resolveCaller(db, req)

  // Read-only again, now that the external-transfer POST is gone: there is no
  // sub-path left to route on, so the method is the whole decision.
  if (req.method !== 'GET') {
    throw new PayHoldError('policy_violation', `${req.method} is not supported here`)
  }

  const params = new URL(req.url).searchParams
  const byRail = params.get('by') === 'rail'
  const live = params.get('live') === '1'

  const { data, error } = await db.rpc(
    byRail ? 'rail_balances' : 'tenant_balances',
    { p_tenant: caller.tenant_id },
  )

  if (error) {
    console.error('balance lookup failed', { message: error.message })
    throw new PayHoldError('policy_violation', 'Could not read the balance')
  }

  // Unmodified callers stop here — byte-identical to before `live` existed.
  if (!live) {
    return json(req, { balances: data ?? [] })
  }

  // `atRail` needs the per-(provider, currency) shape regardless of `by`.
  // When the caller already asked `by=rail` this *is* that shape; otherwise
  // it costs one more read of the same derived view `record_reconciliation`
  // already compares against nightly.
  let railRows: RailBalanceRow[]
  if (byRail) {
    railRows = (data ?? []) as RailBalanceRow[]
  } else {
    const { data: rb, error: rbError } = await db.rpc('rail_balances', { p_tenant: caller.tenant_id })
    if (rbError) {
      // The ledger figures already resolved above are still good; losing the
      // per-rail currency list only narrows what `atRail` can anchor a
      // fallback row to. Degrade rather than fail the whole request over the
      // one extra read `live=1` added.
      console.error('rail balance lookup for atRail failed', { message: rbError.message })
      railRows = []
    } else {
      railRows = (rb ?? []) as RailBalanceRow[]
    }
  }

  const atRail = await liveAtRail(db, caller.tenant_id, railRows)

  return json(req, { balances: data ?? [], atRail })
}))
