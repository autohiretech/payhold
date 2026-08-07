/**
 * Ledger against provider balance, per rail — the reconciliation cron.
 *
 * The comparison is the whole feature. A job that reported what our own ledger
 * says would always agree with itself; this one asks each provider what it is
 * actually holding and insists the two match.
 *
 * What "should be there" means: everything still with the provider — held
 * funds, plus released money inside its clearance window, plus cleared money
 * not yet sent. Paid-out money has left. Release is a movement between our own
 * buckets, not a movement of funds, which is why this cannot be read off the
 * ledger's signs directly and comes from `rail_balances()` instead.
 *
 * Drift freezes that tenant's payouts, inside `record_reconciliation`. Nothing
 * unfreezes automatically: the numbers agreeing again is not the same as
 * someone having understood why they did not, and only a person can say that.
 */

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { serviceClient } from '../_shared/auth.ts'
import { requireCronCaller } from '../_shared/cron-auth.ts'
import { handler, json } from '../_shared/http.ts'
import { loadProvider } from '../_shared/load-provider.ts'
import type { Currency, Money, Provider } from '../_shared/types.ts'

interface RailBalance {
  provider: Provider
  currency: Currency
  held: number
  pending_clearance: number
  available: number
  reserved: number
  fees_retained: number
  paid_out: number
}

/**
 * What the provider should still be holding for us on this rail.
 *
 * Five buckets, not three, and the two added in V2 §7 are the difference
 * between this pass being right and it freezing every tenant that ever
 * released a deal:
 *
 * `fees_retained` — our commission and collected tax have stopped being the
 * seller's, but nothing sweeps them out of the tenant's provider balance. Under
 * bring-your-own-keys there is no such transfer. Leaving them out made a
 * released deal expect the amount *minus* the fee while the provider reported
 * the whole thing, and drift freezes payouts automatically.
 *
 * `reserved` — carved out of the clearing pool so it cannot be paid, but it
 * never left the vault.
 *
 * `paid_out` is still excluded, because that money genuinely went. So is the
 * provider's own fee, which is why it is booked as a debit and given no
 * retained bucket: the rail took it and it is not coming back.
 */
function expected(rail: RailBalance): Money {
  return (
    rail.held +
    rail.pending_clearance +
    rail.available +
    rail.reserved +
    rail.fees_retained
  )
}

async function reconcileTenant(
  db: SupabaseClient,
  tenantId: string,
): Promise<{ checked: number; drifted: number; skipped: number }> {
  const stats = { checked: 0, drifted: 0, skipped: 0 }

  const { data: rails, error } = await db.rpc('rail_balances', { p_tenant: tenantId })
  if (error) throw new Error(`rail_balances failed: ${error.message}`)

  // One provider call per rail, not per row: a tenant holding four currencies
  // on Flutterwave gets one `/balances` request.
  const reported = new Map<Provider, Map<string, Money>>()

  for (const rail of (rails ?? []) as RailBalance[]) {
    if (!reported.has(rail.provider)) {
      try {
        const { provider, connected } = await loadProvider(db, tenantId, rail.provider)

        if (!connected) {
          // Demo rail. There is no external truth to compare against, and
          // treating an empty list as "the provider holds nothing" would freeze
          // every demo tenant on the first pass.
          reported.set(rail.provider, new Map())
        } else {
          const balances = await provider.balances()
          reported.set(
            rail.provider,
            new Map(balances.map((b) => [b.currency, b.amount])),
          )
        }
      } catch (err) {
        // A provider being unreachable is not drift. Freezing payouts because
        // their API had a bad minute would be an outage of our own making, so
        // this rail is skipped and the next pass tries again.
        console.error('provider balance lookup failed', {
          tenant_id: tenantId,
          provider: rail.provider,
          message: err instanceof Error ? err.message : String(err),
        })
        reported.set(rail.provider, new Map())
      }
    }

    const providerBalance = reported.get(rail.provider)?.get(rail.currency)
    if (providerBalance === undefined) {
      stats.skipped += 1
      continue
    }

    stats.checked += 1
    if (providerBalance !== expected(rail)) stats.drifted += 1

    const { error: recordError } = await db.rpc('record_reconciliation', {
      p_tenant: tenantId,
      p_provider: rail.provider,
      p_currency: rail.currency,
      p_ledger_balance: expected(rail),
      p_provider_balance: providerBalance,
    })
    if (recordError) {
      throw new Error(`record_reconciliation failed: ${recordError.message}`)
    }
  }

  return stats
}

Deno.serve(handler(async (req) => {
  await requireCronCaller(req)

  const db = serviceClient()
  const { data: tenants, error } = await db
    .from('tenants')
    .select('id')
    .neq('status', 'suspended')

  if (error) throw new Error(`tenant lookup failed: ${error.message}`)

  const totals = { tenants: 0, checked: 0, drifted: 0, skipped: 0 }

  for (const tenant of tenants ?? []) {
    // One tenant's provider outage must not stop the rest of the pass.
    try {
      const stats = await reconcileTenant(db, tenant.id)
      totals.tenants += 1
      totals.checked += stats.checked
      totals.drifted += stats.drifted
      totals.skipped += stats.skipped
    } catch (err) {
      console.error('reconciliation failed for tenant', {
        tenant_id: tenant.id,
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return json(req, totals)
}))
