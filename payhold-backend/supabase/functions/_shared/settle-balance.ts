/**
 * Collecting a split deal's balance, or a flat deal's overage, before it
 * releases.
 *
 * A deal funded with `split_percent` set owes the rest of its price — plus
 * any overage, if it comes back late — the moment it is confirmed returned.
 * A deal with no split at all can still owe overage on its own, if
 * `overage_rate` is set: a daily rental pays 100% up front and nothing more
 * unless it comes back late. Both places a confirmation can complete the
 * pair (`POST /deals/:id/confirm` and the `auto-release` cron) go through
 * `collectBalanceThenConfirm` here instead of calling `confirm_deal`
 * directly, so a deal with money still owed can never release before that
 * money is actually collected — release would pay the seller before the
 * balance exists to cover it.
 *
 * The charge itself is not transactional with anything: `provider.chargeSaved`
 * is a real network call, and `settle_deal_balance` books it only after it
 * succeeds — the same order `dispatchPayout` sends a transfer before booking
 * it. A retry after a crash between the two is safe: `chargeSaved`'s
 * idempotency key is scoped to the deal, and `settle_deal_balance` is a
 * no-op once `balance_amount` reads zero.
 */

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { balanceFigures, type ReleaseFigures } from './figures.ts'
import { loadProvider } from './load-provider.ts'
import { PayHoldError, type ConfirmSide, type Deal } from './types.ts'

/**
 * Charge the balance (+ overage) via the saved payment method and book it.
 * Never called for a deal with nothing owed at all (no split and no overage
 * terms) — see `collectBalanceThenConfirm`.
 *
 * Failure is not thrown here: a MoMo-funded deal or a declined off-session
 * charge is an ordinary outcome this system has to name, not a 500. The
 * reason is recorded (audit + webhook) and returned to the caller, which
 * refuses the confirmation rather than silently dropping it.
 */
async function collectBalance(
  db: SupabaseClient,
  deal: Deal,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const figures = await balanceFigures(db, deal, new Date())

  // A deal with overage terms but returned on time, or a split deal already
  // settled by a prior pass, genuinely owes nothing this call. Checked
  // before the saved-method lookup below, or a MoMo-funded daily deal that
  // came back on time would be refused over a capability it never needed.
  if (figures.chargeAmount <= 0) {
    return { ok: true }
  }

  const { provider } = await loadProvider(db, deal.tenant_id, deal.provider)
  const token = deal.metadata?.saved_payment_method as string | undefined

  if (!provider.capabilities.supportsSavedPaymentMethod || !provider.chargeSaved || !token) {
    const reason = !provider.capabilities.supportsSavedPaymentMethod
      ? `${deal.provider} has no saved payment method capability — this renter cannot be charged automatically`
      : 'This deal has no saved payment method on file — the renter paid by a method that cannot be charged again'

    await recordBalanceChargeFailure(db, deal, reason)
    return { ok: false, reason }
  }

  let providerRef: string
  try {
    const charged = await provider.chargeSaved({
      token,
      amount: figures.chargeAmount,
      currency: deal.presentment_currency,
      idempotency_key: `balance:${deal.id}`,
    })
    providerRef = charged.provider_ref
  } catch (err) {
    const message = err instanceof PayHoldError ? err.message : 'The balance charge was refused'
    await recordBalanceChargeFailure(db, deal, message)
    return { ok: false, reason: message }
  }

  const { error } = await db.rpc('settle_deal_balance', {
    p_deal_id: deal.id,
    p_overage: figures.p_overage,
    p_overage_fee: figures.p_overage_fee,
    p_provider_ref: providerRef,
  })

  if (error) {
    // The charge genuinely succeeded and the booking failed — surfaced
    // loudly rather than proceeding to release against a ledger that does
    // not yet reflect the money. A retry re-runs `settle_deal_balance`
    // idempotently without charging again, since `providerRef` is stable
    // per deal and `chargeSaved`'s idempotency key would replay it.
    return {
      ok: false,
      reason: `Charged ${providerRef} but could not record it: ${error.message}`,
    }
  }

  return { ok: true }
}

async function recordBalanceChargeFailure(
  db: SupabaseClient,
  deal: Deal,
  reason: string,
): Promise<void> {
  await db.rpc('write_audit', {
    p_tenant: deal.tenant_id,
    p_deal: deal.id,
    p_actor: 'system',
    p_action: 'deal.balance_charge_failed',
    p_details: { reason },
  })
  await db.rpc('enqueue_webhooks', {
    p_tenant: deal.tenant_id,
    p_deal: deal.id,
    p_event: 'order.balance_charge_failed',
    p_data: { reason },
  })
}

/**
 * Confirm one side, collecting a split deal's balance and/or overage first
 * if — and only if — this confirmation would complete the pair.
 *
 * `owesSomething` covers two shapes deliberately: a split deal
 * (`balance_amount` still positive) and a flat, non-split deal that simply
 * has overage terms (`overage_rate` set) — a daily rental owes nothing
 * up front but can still owe a late charge, and `balance_amount` stays null
 * for it the whole time. `collectBalance` itself is what decides whether
 * anything is actually owed *right now*; this only decides whether it is
 * worth asking. A first confirmation, or one on a deal that opted into
 * neither, goes straight to `confirm_deal` exactly as before this feature
 * existed.
 *
 * Returns the same `{ data, error }` shape `db.rpc('confirm_deal', ...)`
 * does, so both callers' existing error handling (`rpcError` in
 * `deals/index.ts`, the try/catch in `auto-release`) needs no other change.
 * A collection failure comes back prefixed `policy_violation:`, the same
 * convention every other money-adjacent refusal in this codebase uses.
 */
export async function collectBalanceThenConfirm(
  db: SupabaseClient,
  deal: Deal,
  side: ConfirmSide,
  actor: 'user' | 'auto',
  figures: ReleaseFigures,
): Promise<{ data: Deal | null; error: { message: string } | null }> {
  const owesSomething = (deal.balance_amount != null && deal.balance_amount > 0) ||
    (deal.overage_rate != null && deal.overage_unit_seconds != null)

  if (owesSomething) {
    const { data: existing } = await db
      .from('confirmations')
      .select('side')
      .eq('deal_id', deal.id)

    const sides = new Set((existing ?? []).map((c: { side: string }) => c.side))
    sides.add(side)
    const completesThePair = sides.has('buyer') && sides.has('seller')

    if (completesThePair) {
      const collected = await collectBalance(db, deal)
      if (!collected.ok) {
        return { data: null, error: { message: `policy_violation: ${collected.reason}` } }
      }
    }
  }

  const { data, error } = await db.rpc('confirm_deal', {
    p_deal_id: deal.id,
    p_side: side,
    p_actor: actor,
    ...figures,
  })

  return { data: data as Deal | null, error }
}

/**
 * Lets the seller reduce or waive the overage before it is charged — the
 * one point of human judgement this feature has. Persisted on the deal
 * rather than passed through only the call that sets it, because the
 * confirmation that actually completes the pair (and triggers the charge)
 * may be the *other* side's, arriving after this one. `balanceFigures`
 * reads it back and clamps: it can only lower what `overageFor` would
 * otherwise charge, never raise it.
 *
 * Refuses a deal with no overage terms at all, the same way a blank
 * provider reference is refused elsewhere — accepting a number with no
 * effect would be a silent no-op dressed up as an action.
 */
export async function setOverageOverride(
  db: SupabaseClient,
  deal: Deal,
  amount: number,
): Promise<Deal> {
  if (deal.overage_rate == null) {
    throw new PayHoldError('policy_violation', 'this deal has no overage rate to adjust')
  }
  if (!Number.isInteger(amount) || amount < 0) {
    throw new PayHoldError('policy_violation', 'overage_override must be a non-negative integer')
  }

  const metadata = { ...(deal.metadata ?? {}), overage_override: amount }
  const { error } = await db.from('deals').update({ metadata }).eq('id', deal.id)
  if (error) {
    throw new PayHoldError('policy_violation', `could not record the override: ${error.message}`)
  }

  await db.rpc('write_audit', {
    p_tenant: deal.tenant_id,
    p_deal: deal.id,
    p_actor: 'user',
    p_action: 'deal.overage_overridden',
    p_details: { amount },
  })

  return { ...deal, metadata }
}
