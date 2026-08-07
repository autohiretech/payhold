/**
 * The already-converted figures the money functions take.
 *
 * SQL owns atomicity and the ledger; this side owns FX. So `release_deal` and
 * `settle_payout` are handed numbers rather than deriving them — see
 * payhold-backend/CLAUDE.md. Both callers of each figure live here so the two
 * paths into a release (a second confirmation, and the auto-release timer)
 * cannot drift apart.
 */

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { convertOrThrow } from './fx.ts'
import { PayHoldError, type Deal, type Money } from './types.ts'

export interface ReleaseFigures {
  p_payout_amount: number
  p_payout_currency: string
  p_fee_presentment: number
}

/**
 * What `confirm_deal` / `release_deal` need in order to release.
 *
 * Computed up front rather than the database calling out mid-transaction.
 */
export async function releaseFigures(
  db: SupabaseClient,
  deal: Deal,
): Promise<ReleaseFigures> {
  const { data: seller } = await db
    .from('sellers')
    .select('payout_currency')
    .eq('id', deal.seller_id)
    .maybeSingle()

  const payoutCurrency = seller?.payout_currency ?? deal.currency
  const net = deal.amount - deal.fee_amount

  return {
    // The seller is owed the settlement currency, whatever the buyer paid in.
    p_payout_amount: convertOrThrow(net, deal.currency, payoutCurrency).amount,
    p_payout_currency: payoutCurrency,
    // The fee leaves the balance we actually hold, so it is expressed in what
    // was collected.
    p_fee_presentment: convertOrThrow(
      deal.fee_amount,
      deal.currency,
      deal.presentment_currency,
    ).amount,
  }
}

/**
 * What actually departs the provider balance when this payout is sent.
 *
 * **This is not a conversion of `payouts.amount`, and the difference is the
 * whole reason this function exists.** The seller receives `payouts.amount` in
 * their own currency; what leaves our vault is whatever is still sitting in
 * this deal's clearing pool, and the two are only the same number when no
 * currency conversion happened.
 *
 * `rail_balances()` derives that pool over the deal's entries. A payout entry
 * of any other size leaves a residue there forever: not large, but permanent,
 * and `available` never returning to zero is exactly what the reconciliation
 * pass reports as drift — which freezes the tenant's payouts over a rounding
 * error nobody can explain. Reading the pool back and sending precisely that is
 * self-correcting, and it stays correct when the FX rate has moved between
 * funding and clearance.
 *
 * **This list must match `rail_balances`' `clearing` expression exactly.** A
 * deduction type present there and missing here would send the seller money the
 * pool says is not theirs — a tax we owe onward, or a reserve still carved out.
 * V2 §7 added four of them at once, which is precisely how such a list drifts.
 */
const POOL_ENTRY_TYPES = [
  'release',
  'fee',
  'provider_fee',
  'tax',
  'reserve',
  'reserve_release',
  'payout',
] as const

export async function amountLeaving(
  db: SupabaseClient,
  deal: Deal,
): Promise<Money> {
  const { data, error } = await db
    .from('ledger')
    .select('entry_type, amount')
    .eq('deal_id', deal.id)
    .in('entry_type', POOL_ENTRY_TYPES)

  if (error) throw new Error(`ledger read failed: ${error.message}`)

  // The sign convention from `rail_balances`: entries are stored negative, so a
  // release credits the pool and everything else debits it. `reserve_release`
  // is the one credit among the deductions — it is stored positive, so adding
  // it works out on its own.
  let clearing = 0
  for (const entry of data ?? []) {
    clearing += entry.entry_type === 'release' ? -entry.amount : entry.amount
  }

  if (clearing <= 0) {
    // Either the deal never released, or a payout already drained the pool.
    // Sending a non-positive amount is meaningless and `settle_payout`'s
    // balance guard would refuse it anyway; failing here says why.
    throw new PayHoldError(
      'invalid_state',
      `Deal ${deal.id} has nothing left to pay out`,
    )
  }

  return clearing
}
