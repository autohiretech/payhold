/**
 * Starting a charge — the one implementation, shared by both ways in.
 *
 * Two callers: `POST /v1/deals/:id/pay`, where the client's server picks the
 * method with their API key, and `POST /v1/checkout/public/:token/pay`, where
 * the buyer picks it themselves on the hosted page. Keeping one implementation
 * is the same argument `_shared/dispatch.ts` makes about payouts — a second
 * entrance is how one of them quietly stops making a check the other makes.
 *
 * What it does **not** do is move the deal. Both callers own that, and they
 * move it differently: `/pay` writes `payment_pending` directly, the session
 * route goes through `complete_checkout_session` so the session and the deal
 * change together. Neither can reach `funded_held` — that is the provider
 * webhook's, after it re-fetches the transaction (§15 phase 2).
 */

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { loadProvider } from './load-provider.ts'
import { closedMarkets, liveProviders } from './matrix.ts'
import { collectionRails, countryInfo, METHOD_LABEL } from './rails.ts'
import type { ChargeNextAction } from './provider.ts'
import { PayHoldError, type Deal, type PaymentMethod, type Provider } from './types.ts'

export interface StartedCharge {
  /** The rail that actually took it — the deal's provisional one may not survive. */
  rail: Provider
  provider_ref: string
  payment_link: string
  /**
   * What the buyer does next, in a form a client's own checkout can act on.
   *
   * Never absent from here even though an adapter may omit it: an adapter that
   * only knows how to return a link meant `redirect` and always did, so this
   * normalises rather than makes the caller ask twice.
   */
  next_action: ChargeNextAction
}

/**
 * Which rails this buyer may actually choose right now.
 *
 * The generated registry says what is *possible* in that market;
 * `payment_markets` and `provider_capabilities` say what is *on* (§29.11). A
 * method offered from the first without the second is a button that fails at
 * the provider, in front of a buyer.
 */
export async function availableMethods(
  db: SupabaseClient,
  tenantId: string,
  deal: Deal,
): Promise<{ method: PaymentMethod; label: string; provider: Provider; networks: string[] }[]> {
  const [closed, live] = await Promise.all([
    closedMarkets(db, tenantId),
    liveProviders(db),
  ])

  const closure = closed.get(deal.buyer_country)
  if (closure && !closure.collect) return []

  return collectionRails(deal.buyer_country, deal.presentment_currency)
    .filter((rail) => live.has(rail.provider))
    .map((rail) => ({
      method: rail.method,
      label: METHOD_LABEL[rail.method],
      provider: rail.provider,
      networks: rail.networks,
    }))
}

/**
 * Call the provider and get somewhere to send the buyer.
 *
 * The method is re-checked against the live matrix here rather than trusted
 * from the request, because on the hosted route the request comes from a
 * browser: a buyer who edited the form must not be able to start a charge on a
 * rail we have switched off.
 */
export async function startCharge(
  db: SupabaseClient,
  tenantId: string,
  deal: Deal,
  choice: {
    method: PaymentMethod
    network?: string
    /**
     * The buyer's wallet number, when they typed one into the client's page.
     *
     * Its presence is what turns a mobile money charge from a handoff into a
     * direct one, so it is genuinely optional: a client that does not collect
     * it still gets the hosted page it always got.
     */
    phone?: string
    returnUrl?: string | null
  },
): Promise<StartedCharge> {
  const available = await availableMethods(db, tenantId, deal)
  const chosen = available.find((m) => m.method === choice.method)

  if (!chosen) {
    throw new PayHoldError(
      'policy_violation',
      `${choice.method} is not available for ${deal.presentment_currency} in ` +
        `${countryInfo(deal.buyer_country).name}`,
    )
  }

  const { provider } = await loadProvider(db, tenantId, chosen.provider)
  const publicUrl = Deno.env.get('PUBLIC_URL') ?? 'https://app.payhold.local'

  const charge = await provider.charge({
    // Our deal id goes across as their reference, which is what lets the
    // webhook find its way back to the right deal.
    deal_id: deal.id,
    amount: deal.presentment_amount,
    currency: deal.presentment_currency,
    method: choice.method,
    network: choice.network,
    phone: choice.method === 'mobile_money' ? choice.phone : undefined,
    return_url: choice.returnUrl ?? `${publicUrl}/deals/${deal.id}`,
    // §6: requested on every card charge, never silently downgraded.
    three_d_secure: choice.method === 'card',
    idempotency_key: `charge:${deal.id}`,
  })

  return {
    rail: chosen.provider,
    provider_ref: charge.provider_ref,
    payment_link: charge.payment_link,
    next_action: charge.next_action ?? { type: 'redirect', url: charge.payment_link },
  }
}

/**
 * Answer a code the rail asked the buyer for.
 *
 * Separate from `startCharge` and not a branch inside it, because it is a
 * different question: that one asks a rail to begin, this one continues one
 * that already exists. Sharing an entrance would mean a single function whose
 * arguments contradict each other in half its calls.
 *
 * The rail is passed in rather than re-derived. It was decided when the charge
 * started and written onto the session; re-running the routing here could pick
 * a different one if the matrix moved in between, and the code the buyer is
 * holding belongs to the rail that issued it.
 */
export async function validateCharge(
  db: SupabaseClient,
  tenantId: string,
  rail: Provider,
  input: { reference: string; otp: string; method: PaymentMethod },
): Promise<{ next_action: ChargeNextAction }> {
  const { provider } = await loadProvider(db, tenantId, rail)

  if (!provider.validate) {
    throw new PayHoldError(
      'policy_violation',
      `${rail} does not ask for a verification code`,
    )
  }

  const result = await provider.validate({
    reference: input.reference,
    otp: input.otp,
    method: input.method,
  })

  return {
    next_action: result.next_action ?? { type: 'redirect', url: result.payment_link },
  }
}
