/**
 * Sending one payout — the path money actually leaves by.
 *
 * Two callers share it: the clearance cron, which sends everything whose
 * window has closed, and the approve-review endpoint, so a person who clears a
 * hold does not then wait an hour for the next pass. Keeping one implementation
 * is what stops "approve" quietly becoming a route that skips a check the cron
 * makes.
 *
 * The order below is the whole safety argument and none of it is arbitrary:
 *
 *   1. a frozen tenant stops here — drift means money we cannot account for,
 *      and it must stop moving before anything else is considered
 *   2. the deterministic rules screen it (invariant 11). They may hold it and
 *      may do nothing else
 *   3. the routing engine picks a destination and a rail, or blocks it (§5.1).
 *      It may also do nothing else
 *   4. the rail is asked whether the amount is withdrawable, and the payout is
 *      blocked rather than attempted if it plainly is not (`payout-funding.ts`)
 *   5. the provider is called
 *   6. only then is it booked
 *
 * Step 5 before step 6 is deliberate and is the direction to fail in. If the
 * transfer succeeds and the booking does not, the next pass re-sends with the
 * same `idempotency_key`, the provider returns the same transfer, and it books
 * then. The reverse — booking a transfer that never left — would report a
 * seller paid who was not.
 *
 * Step 4 is the one step that may be skipped, and skipping it is the safe
 * direction. It asks the rail a question the rail may decline to answer, and
 * an unanswered question proceeds to step 5 exactly as before — a preflight
 * that blocked on silence would stop every payout on every rail that does not
 * report a withdrawable figure. It never fails a payout either: what it does
 * is `blocked`, which keeps §13's clock and is re-asked next pass, because
 * nothing refused us here and the condition comes good on its own.
 *
 * Step 2 before step 3 also matters, and is a dependency rather than a
 * preference: `screen_payout` is what blocks a payout whose deal is disputed,
 * and `route_payout` un-blocks a payout it can route. Routing first would let a
 * disputed payout out of `blocked` and into the queue. The booking guard in
 * `settle_payout` still refuses it under the row lock — this ordering is what
 * keeps the *status* honest in between.
 */

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { amountLeaving } from './figures.ts'
import { loadProvider } from './load-provider.ts'
import { railFunding, shortfallReason } from './payout-funding.ts'
import { loadSettings } from './settings.ts'
import {
  type Country,
  type Deal,
  PayHoldError,
  type Payout,
  type PayoutProvider,
  type Provider,
} from './types.ts'

export type DispatchOutcome =
  /** Sent and booked. */
  | 'paid'
  /** Accepted by the provider, settling asynchronously. */
  | 'processing'
  /** A discretionary rule, or a person, stopped it. Only a person moves it. */
  | 'held_for_review'
  /** §12: something about the seller is outstanding. `verify_seller` is the way out. */
  | 'needs_verification'
  /** §5.1: no eligible route, or a dispute. Money kept, nothing rerouted. */
  | 'blocked'
  /** The tenant's payouts are frozen pending reconciliation. */
  | 'frozen'
  /** The provider refused. Retried on a later pass. */
  | 'failed'
  /** Not ours to send right now — a suspended tenant. */
  | 'skipped'

/**
 * Payout states a machine may send.
 *
 * `held_for_review` is deliberately absent and must stay absent: cron may never
 * be the thing that lets a payout past a rule or a person (invariant 11).
 *
 * `blocked` and `needs_verification` are present, and that is the difference
 * between them and a hold. Neither is waiting on a decision — one is waiting
 * for a route to exist, the other for somebody to attest to a fact — so a pass
 * that re-asks and finds the reason gone is not overruling anyone. It is the
 * same shape as `frozen` clearing once reconciliation is resolved.
 *
 * `failed` joined the list in phase 9, and it is the one entry with a second
 * gate: §13's capped backoff lives in `payouts.next_attempt_at`, which the cron
 * filters on, so a refused transfer is re-sent on a ladder rather than on every
 * pass. When that budget is spent `fail_payout` writes `blocked` and clears the
 * clock, and only a person moves it after that.
 */
export const DISPATCHABLE = [
  'scheduled',
  'frozen',
  'processing',
  'blocked',
  'needs_verification',
  'failed',
] as const

/**
 * Deal states a payout may still be sent against.
 *
 * `disputed` is absent and so is every terminal one: a refunded, canceled or
 * expired deal owes nobody anything, and a payout row left `failed` on one —
 * which is exactly how `refund_deal` cancels a scheduled payout — became
 * reachable again the moment `failed` joined `DISPATCHABLE`.
 *
 * `settle_payout` would refuse to book it anyway, because a refunded deal has
 * no available balance left to draw on. That is the guarantee; this is the
 * check made early, so we never ask a provider to send money we are about to
 * refuse to book.
 */
const PAYABLE_DEAL_STATUSES = ['clearing', 'released', 'payout_pending'] as const

/** One row of `payout_decisions` — §5.1's auditable choice. */
interface RouteDecision {
  id: string
  route_id: string | null
  destination_id: string | null
  provider: Provider | null
  reason_code: string
  is_fallback: boolean
}

/**
 * The rail's own answer on whether this payout is withdrawable today.
 *
 * Returns `null` for every case that is not a plain, reported shortfall — a
 * rail with no adapter, a rail that cannot be loaded, a `balances()` call that
 * threw, a currency it said nothing about, a rail that reports no withdrawable
 * figure at all. All of those mean "we did not learn anything", and the caller
 * proceeds to the transfer exactly as it did before this check existed.
 *
 * Swallowing the failures is the point rather than an oversight: the transfer
 * is the next thing that would have failed anyway, and it fails with the
 * rail's own sentence recorded against the payout, which is more use to an
 * operator than our guess about why we could not ask.
 */
async function askRailForFunding(
  db: SupabaseClient,
  payout: Payout,
  rail: Provider | null,
): Promise<
  (Extract<ReturnType<typeof railFunding>, { verdict: 'short' }> & {
    rail: string
    mode: 'test' | 'live'
  }) | null
> {
  if (!rail) return null

  try {
    const { provider, mode } = await loadProvider(db, payout.tenant_id, rail)
    const verdict = railFunding(await provider.balances(), payout.currency, payout.amount)

    return verdict.verdict === 'short' ? { ...verdict, rail, mode } : null
  } catch (err) {
    console.error('payout funding preflight skipped', {
      payout_id: payout.id,
      tenant_id: payout.tenant_id,
      rail,
      message: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

export async function dispatchPayout(
  db: SupabaseClient,
  payout: Payout,
): Promise<DispatchOutcome> {
  // `name` is read here as well because it is the sender on a transfer: some
  // corridors (Flutterwave's Kenya M-Pesa) refuse a payout that does not say
  // who is sending it.
  const { data: tenant } = await db
    .from('tenants')
    .select('status, name')
    .eq('id', payout.tenant_id)
    .maybeSingle()

  if (tenant?.status === 'suspended') return 'skipped'

  if (tenant?.status === 'payouts_frozen') {
    const { error } = await db.rpc('freeze_payout', { p_payout_id: payout.id })
    if (error) throw new Error(`freeze_payout failed: ${error.message}`)
    return 'frozen'
  }

  const { data: dealRow } = await db
    .from('deals')
    .select('id, tenant_id, seller_id, amount, currency, fee_amount, ' +
      'presentment_currency, presentment_amount, provider, status')
    .eq('id', payout.deal_id)
    .maybeSingle()

  if (!dealRow) throw new PayHoldError('not_found', `Deal ${payout.deal_id} not found`)
  const deal = dealRow as unknown as Deal

  // §8: a dispute freezes payout. `settle_payout` refuses a disputed deal under
  // the row lock, which is the guarantee; this is the same check made early so
  // the cron reports it as skipped rather than as an error, and so we do not
  // ask a provider to send money we are about to refuse to book. A deal that is
  // over — refunded, canceled, expired — is the same argument; see
  // `PAYABLE_DEAL_STATUSES`.
  //
  // This has to run before `screen_payout` below, not after it — it used to
  // run after, which meant a dead deal's payout could still be held by a risk
  // rule and shown to an operator as "needs review" or "approve and send".
  // Found live: `refund_deal`'s own cleanup missed a payout once (see
  // migration `20260816000001`), a person's "Retry" put it back in front of
  // `screen_payout`, a rule held it for review, and the same person's
  // "Approve and send" set it back to `scheduled` — for a deal that had been
  // fully refunded days earlier. Nothing was ever actually sent (this check
  // still ran, just too late to stop the round trip through review), but nor
  // should a human ever have been asked to clear a hold on money that could
  // never move.
  if (!(PAYABLE_DEAL_STATUSES as readonly string[]).includes(deal.status)) {
    return 'skipped'
  }

  // A payout already with the provider has been screened and routed once, and
  // the money is in flight. Re-running the rules could only hold something we
  // can no longer stop, which would misreport it to an operator as prevented;
  // re-routing it would be the silent redirection §5.1 forbids.
  let decision: RouteDecision

  if (payout.status === 'processing') {
    const { data } = await db
      .from('payout_decisions')
      .select('id, route_id, destination_id, provider, reason_code, is_fallback')
      .eq('payout_id', payout.id)
      .eq('reason_code', 'routed')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (!data) {
      throw new PayHoldError(
        'invalid_state',
        `Payout ${payout.id} is processing with no routing decision behind it`,
      )
    }
    decision = data as unknown as RouteDecision
  } else {
    const { data: held, error } = await db.rpc('screen_payout', {
      p_payout_id: payout.id,
    })
    if (error) throw new Error(`screen_payout failed: ${error.message}`)

    if (held) {
      // Which of the three stops it was is on the row. Read back rather than
      // returned, so `screen_payout` keeps the signature every existing caller
      // and test uses — a return type is the one thing `create or replace`
      // cannot change, and this is not worth a drop.
      const { data: stopped } = await db
        .from('payouts')
        .select('status')
        .eq('id', payout.id)
        .maybeSingle()

      return stopped?.status === 'needs_verification'
        ? 'needs_verification'
        : stopped?.status === 'blocked'
        ? 'blocked'
        : 'held_for_review'
    }

    // §5.1's routing engine. Deterministic, and it records what it decided
    // whether or not it found anything — `payout_decisions` is the audit.
    const { data: routed, error: routeError } = await db.rpc('route_payout', {
      p_payout: payout.id,
    })
    if (routeError) throw new Error(`route_payout failed: ${routeError.message}`)

    decision = routed as unknown as RouteDecision
    // Nothing eligible. The amount stays where it is and the reason is on the
    // payout — §5.1 is emphatic that funds are never discarded or rerouted.
    if (decision.reason_code !== 'routed') return 'blocked'
  }

  // The destination the routing engine chose — §5.1's record of where this
  // money went, read from `seller_destinations` rather than from the seller's
  // copy of it. That copy exists because Phase 4 could not move fifty call
  // sites at once; this is the one that had to move, because only the decision
  // knows which row was picked — and since §29.17 that row may have been
  // replaced (archived, never deleted) while the payout was in flight.
  //
  // The rail and country ride along with the token: an adapter cannot tell a
  // wallet from a bank account by its token, and Flutterwave's Kenya M-Pesa
  // corridor wants facts on the transfer that a Rwandan wallet transfer must
  // not carry. Still the mask and never the number — the number stays with
  // the rail, and the adapter that needs it asks the rail for it.
  const { data: destinationRow } = await db
    .from('seller_destinations')
    .select('beneficiary_token, masked_destination, payout_provider, country')
    .eq('id', decision.destination_id ?? '')
    .maybeSingle()

  if (!destinationRow) {
    throw new PayHoldError(
      'not_found',
      `Destination ${decision.destination_id} for payout ${payout.id} not found`,
    )
  }
  const destination = destinationRow as unknown as {
    beneficiary_token: string
    masked_destination: string
    payout_provider: PayoutProvider
    country: Country
  }

  // Who the money is going to, by name — the same value `tokenize` was given
  // at registration, wanted again on the transfer by the corridor above.
  const { data: sellerRow } = await db
    .from('sellers')
    .select('name')
    .eq('id', deal.seller_id)
    .maybeSingle()

  // What departs our balance, read back off the ledger rather than converted —
  // see `amountLeaving`. Computed before the transfer so a figure we cannot
  // derive stops the payout instead of stranding one that has already gone.
  const leaving = await amountLeaving(db, deal)

  // And asked again, under the payout's row lock, as late as we can ask it.
  //
  // `settle_payout` refuses a payout larger than the rail's available balance,
  // but it runs *after* the transfer — that ordering is deliberate and is what
  // makes a sent-but-unbooked payout safe to re-send. The cost of it is a
  // window: a partial refund landing between the figure above and the transfer
  // below shrinks the pool, the money goes anyway, and booking then fails on a
  // transfer that cannot be recalled. A full refund never reaches here
  // (`PAYABLE_DEAL_STATUSES` is checked early), which is precisely why the
  // partial case is the one left — §29.8 leaves the deal's status untouched,
  // so nothing upstream notices it happened.
  //
  // This narrows that window to the gap between two adjacent statements rather
  // than closing it: the lock cannot be held across the provider's HTTP call
  // without holding one across somebody else's outage. `assert_payout_funded`
  // writes nothing and moves nothing — it asks `settle_payout`'s own question
  // early enough for the answer to still be worth having.
  const { error: fundedError } = await db.rpc('assert_payout_funded', {
    p_payout_id: payout.id,
    p_leaving: leaving,
  })
  if (fundedError) {
    await db.rpc('fail_payout', {
      p_payout_id: payout.id,
      p_reason: `Not sent: ${fundedError.message}`,
    })
    return 'failed'
  }

  // Step 4: ask the rail before asking it to send.
  //
  // Its own error domain, deliberately outside the `try` below, and loading the
  // provider a second time to get it. That costs a row read and a decrypt per
  // payout and buys the one property that matters: a preflight cannot fail a
  // payout. Inside that block every throw becomes `fail_payout`, which spends
  // §13's retry budget — and a question we could not ask must never cost a
  // seller one of their five attempts.
  //
  // `unknown` proceeds. See `payout-funding.ts` for why silence from a rail is
  // not a balance of zero, and why this asks about `available` rather than the
  // total the reconciliation pass compares.
  const funding = await askRailForFunding(db, payout, decision.provider)

  if (funding?.verdict === 'short') {
    const { error } = await db.rpc('hold_payout_unfunded', {
      p_payout_id: payout.id,
      p_reason: shortfallReason(funding, funding.rail, funding.mode),
    })
    if (error) throw new Error(`hold_payout_unfunded failed: ${error.message}`)
    return 'blocked'
  }

  // The rail comes from the decision, not from the seller's country: which
  // provider can pay where is `payout_routes` now, so a corridor can be
  // switched off without a deploy (§5.2 case 8). It still has to match the rail
  // the destination was tokenized against, which is exactly what the routing
  // engine's `preferred` filter guarantees — a beneficiary token minted by one
  // provider means nothing to another.
  //
  // Note the funding question this leaves open: `settle_payout` debits the
  // collecting rail's vault, so a tenant who collects on Stripe and pays out on
  // Flutterwave has to keep the Flutterwave balance topped up themselves. The
  // ledger is right either way; the provider balance is theirs to manage.
  let outcome: {
    provider_ref: string
    status: 'pending' | 'paid'
    /**
     * What the rail's own response says, when it says so — never what
     * `settle_payout` books. See `recordConfirmedPayoutFigures` below for why
     * this stays a read, not a write.
     */
    amount?: number
    currency?: string
    fee?: number | null
  }

  try {
    if (!decision.provider) {
      throw new PayHoldError(
        'policy_violation',
        'The chosen route has no provider behind it',
      )
    }
    const { provider } = await loadProvider(db, payout.tenant_id, decision.provider)

    // A transfer the rail already has is **asked about**, never re-sent.
    //
    // This used to re-POST `release` with the same idempotency key and read
    // the reply as a poll, which assumes the rail replays the original
    // response for a repeated key. Flutterwave documents that for charges and
    // not for transfers, so the second POST either comes back refused as a
    // duplicate reference — booked as a failure, on money that had already
    // gone — or sends the seller a second payment. `transferStatus` is the
    // question actually being asked.
    //
    // A rail with no `transferStatus` is synchronous and never lands here:
    // it answered `paid` in the call that sent the money.
    if (payout.status === 'processing' && payout.provider_ref && provider.transferStatus) {
      const settled = await provider.transferStatus(payout.provider_ref)

      if (settled.status === 'pending') {
        // Still with the rail. Nothing to book, and nothing has gone wrong —
        // this is not an outcome the caller should count as an attempt.
        return 'processing'
      }
      if (settled.status === 'failed') {
        const { error } = await db.rpc('fail_payout', {
          p_payout_id: payout.id,
          p_reason: 'The rail reported this transfer as failed',
        })
        if (error) throw new Error(`fail_payout failed: ${error.message}`)
        return 'failed'
      }

      outcome = {
        provider_ref: payout.provider_ref,
        status: 'paid',
        amount: settled.amount,
        currency: settled.currency,
        fee: settled.fee,
      }
    } else {
      outcome = await provider.release({
        payout_id: payout.id,
        beneficiary_token: destination.beneficiary_token,
        amount: payout.amount,
        currency: payout.currency,
        // Stable across retries, which is what makes step 4 safe to repeat.
        idempotency_key: `payout:${payout.id}`,
        rail: destination.payout_provider,
        country: destination.country,
        beneficiary_name: (sellerRow as { name?: string } | null)?.name ?? undefined,
        sender_name: (tenant as { name?: string } | null)?.name ?? undefined,
        // The owner's own answer on the Settings screen, or nothing. The
        // adapter that needs it (Flutterwave, Kenya M-Pesa) refuses with the
        // gap named, `fail_payout` records that sentence on the payout, and the
        // next pass retries once the country has been set.
        sender_country: (await loadSettings(db, payout.tenant_id)).country || undefined,
      })
    }
  } catch (err) {
    // A corridor we cannot pay, a rail with no implementation, a refused
    // transfer. All of them are the same thing to the seller — nothing arrived
    // — so all of them record a reason and wait for the next pass.
    const reason = err instanceof PayHoldError
      ? err.message
      : err instanceof Error
      ? err.message
      : String(err)

    const { error } = await db.rpc('fail_payout', {
      p_payout_id: payout.id,
      p_reason: reason,
    })
    if (error) throw new Error(`fail_payout failed: ${error.message}`)
    return 'failed'
  }

  // Visible, never booked. `settle_payout(p_payout_id, p_leaving,
  // p_provider_ref, p_rail)` has no parameter for a confirmed transfer
  // amount or fee — it books `p_leaving` (the deal's own clearing pool,
  // computed above) and reads `payouts.amount` (fixed by `release_deal`,
  // adjusted only by `refund_deal` under the payout's row lock) for
  // everything else. Writing a confirmed figure into `payouts.amount` from
  // here, outside that lock and its invariants, is exactly the kind of write
  // CLAUDE.md reserves for a security-definer SQL function — and whether a
  // discrepancy comes out of the seller's net or the platform's own margin is
  // a policy decision, not a plumbing one. See this change's accompanying
  // report for what booking it safely would need.
  await recordConfirmedPayoutFigures(db, payout, decision.provider, outcome)

  if (outcome.status === 'pending') {
    const { error } = await db.rpc('mark_payout_processing', {
      p_payout_id: payout.id,
      p_provider_ref: outcome.provider_ref,
    })
    if (error) throw new Error(`mark_payout_processing failed: ${error.message}`)
    return 'processing'
  }

  // The rail that actually sent it, which is not always the one that collected
  // — a Stripe-funded deal is paid out on Flutterwave for any African seller.
  // `settle_payout` books the offsetting pair off this, and cross-checks it
  // against the routing decision rather than taking our word for it.
  const { error } = await db.rpc('settle_payout', {
    p_payout_id: payout.id,
    p_leaving: leaving,
    p_provider_ref: outcome.provider_ref,
    p_rail: decision.provider,
  })
  if (error) throw new Error(`settle_payout failed: ${error.message}`)

  return 'paid'
}

/**
 * Makes a rail's confirmed transfer figures visible without booking them.
 *
 * `payouts.amount` is fixed by `release_deal` and is the only figure this
 * money engine has ever sent a rail or shown a seller — it is asked for, not
 * confirmed. `PaymentProvider.release`/`transferStatus` now read the rail's
 * own answer, and asking is not evidence the answer matches: this is the
 * write that keeps a difference from disappearing silently into whichever
 * number `settle_payout` happens to book.
 *
 * Deliberately audit-only. Two separate reasons stack here, not one:
 *   - `settle_payout` has no parameter to receive a confirmed amount, and
 *     `payouts.amount` is written only under that function's own row lock
 *     (`release_deal`, and later `refund_deal` when a partial refund shrinks
 *     it) — writing it from here would be exactly the kind of read-decide-write
 *     over several round trips CLAUDE.md warns is a race, on a row this
 *     function does not hold locked.
 *   - Whether a rail's transfer fee comes out of the seller's net or the
 *     platform's own margin is a policy decision this plumbing change does
 *     not make. Recording it is what lets a person make that call instead of
 *     it being made by accident, silently, inside an adapter.
 */
async function recordConfirmedPayoutFigures(
  db: SupabaseClient,
  payout: Payout,
  rail: Provider | null,
  outcome: { provider_ref: string; amount?: number; currency?: string; fee?: number | null },
): Promise<void> {
  if (outcome.amount === undefined && outcome.fee == null) return

  const amountMismatch = outcome.amount !== undefined && outcome.amount !== payout.amount
  const currencyMismatch = outcome.currency !== undefined && outcome.currency !== payout.currency

  if (amountMismatch || currencyMismatch) {
    await db.rpc('write_audit', {
      p_tenant: payout.tenant_id,
      p_deal: payout.deal_id,
      p_actor: 'system',
      p_action: 'payout.provider_amount_mismatch',
      p_details: {
        payout_id: payout.id,
        booked_amount: payout.amount,
        booked_currency: payout.currency,
        confirmed_amount: outcome.amount,
        confirmed_currency: outcome.currency ?? payout.currency,
        rail,
        provider_ref: outcome.provider_ref,
        note: 'The rail reported a different figure for this transfer than ' +
          'payouts.amount records. Not re-booked — see recordConfirmedPayoutFigures.',
      },
    })
  }

  if (outcome.fee != null) {
    await db.rpc('write_audit', {
      p_tenant: payout.tenant_id,
      p_deal: payout.deal_id,
      p_actor: 'system',
      p_action: 'payout.provider_fee',
      p_details: {
        payout_id: payout.id,
        fee: outcome.fee,
        currency: outcome.currency ?? payout.currency,
        rail,
        provider_ref: outcome.provider_ref,
        note: 'What the rail charged to send this transfer. Not booked to ' +
          "the ledger and not netted against the seller's payout.",
      },
    })
  }
}
