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
import { loadSettings } from './settings.ts'
import { closedMarkets, liveProviders } from './matrix.ts'
import { collectionRails, countryInfo, METHOD_LABEL, METHOD_SUPPORTS_REUSE } from './rails.ts'
import type { ChargeNextAction, ChargeRequest } from './provider.ts'
import { PayHoldError, type Deal, type PaymentMethod, type Provider } from './types.ts'

export interface StartedCharge {
  /** The rail that actually took it — the deal's provisional one may not survive. */
  rail: Provider
  /**
   * Sandbox or live, as the charge actually ran. Persisted onto the deal so a
   * later refund or deposit capture routes back to the same host instead of
   * whatever the tenant's provider account happens to be connected as by
   * then — see `_shared/load-provider.ts`'s `explicitMode`.
   */
  mode: 'test' | 'live'
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

export interface AvailableMethod {
  method: PaymentMethod
  label: string
  provider: Provider
  networks: string[]
  /**
   * What choosing this method charges right now, in the deal's presentment
   * currency — not always `deal.presentment_amount`. See below.
   */
  amount: number
}

/**
 * Which rails this buyer may actually choose right now, and what each one
 * charges today.
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
): Promise<AvailableMethod[]> {
  const [closed, live] = await Promise.all([
    closedMarkets(db, tenantId),
    liveProviders(db),
  ])

  const closure = closed.get(deal.buyer_country)
  if (closure && !closure.collect) return []

  // A split deal's second installment collects automatically the moment
  // both sides confirm, on whatever the buyer paid with — and a method with
  // no reusable credential can never produce one for it to collect against.
  // Rather than dropping such a method from the list, it is offered at the
  // deal's FULL price instead of the first installment: nothing is left
  // owing later, so there is nothing for the missing credential to strand.
  // `startCharge` is what actually commits to that (`collapse_deal_split`)
  // once the buyer picks one; this only prices the choice.
  //
  // `overage_rate` alone does not trigger this: overage only fires on a late
  // return, so it is still a legitimate, ordinary-priced choice for the
  // (possibly only) charge that is certain to happen.
  const isSplit = deal.split_percent != null && deal.split_percent > 0
  const fullAmount = deal.presentment_amount + (deal.balance_amount ?? 0)

  return collectionRails(deal.buyer_country, deal.presentment_currency)
    .filter((rail) => live.has(rail.provider))
    .map((rail) => ({
      method: rail.method,
      label: METHOD_LABEL[rail.method],
      provider: rail.provider,
      networks: rail.networks,
      amount: isSplit && !METHOD_SUPPORTS_REUSE[rail.method] ? fullAmount : deal.presentment_amount,
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
    /**
     * The rail the buyer picked, when the checkout offered more than one for
     * the same method (e.g. Card on both Stripe and Flutterwave). When given it
     * must be one of the rails `availableMethods` returned for this method, or
     * the charge is refused — a buyer cannot name a rail that is not actually
     * on in their market.
     */
    provider?: Provider
    network?: string
    /**
     * The buyer's wallet number, when they typed one into the client's page.
     *
     * Its presence is what turns a mobile money charge from a handoff into a
     * direct one, so it is genuinely optional: a client that does not collect
     * it still gets the hosted page it always got.
     */
    phone?: string
    /**
     * Card details the tenant collected itself, and the extra factor the rail
     * asked for afterwards. Refused unless that tenant has switched
     * `raw_card_relay` on — see `Settings.raw_card_relay`.
     */
    card?: NonNullable<ChargeRequest['card']>
    authorization?: NonNullable<ChargeRequest['authorization']>
    attempt?: number
    returnUrl?: string | null
  },
): Promise<StartedCharge> {
  const available = await availableMethods(db, tenantId, deal)
  const chosen = available.find(
    (m) =>
      m.method === choice.method &&
      (!choice.provider || m.provider === choice.provider),
  )

  if (!chosen) {
    if (choice.provider) {
      throw new PayHoldError(
        'policy_violation',
        `${choice.provider} is not available for ${choice.method} in ` +
          `${countryInfo(deal.buyer_country).name}`,
      )
    }
    throw new PayHoldError(
      'policy_violation',
      `${choice.method} is not available for ${deal.presentment_currency} in ` +
        `${countryInfo(deal.buyer_country).name}`,
    )
  }

  // §6's exception, checked here rather than in an adapter so every rail is
  // covered by one gate. A tenant that has not switched this on cannot send us
  // a card at all, whatever they put in the body.
  if (choice.card) {
    const settings = await loadSettings(db, tenantId)
    if (!settings.raw_card_relay) {
      throw new PayHoldError(
        'policy_violation',
        'This account is not set up to send card details to PayHold. ' +
          'Use the payment element or the hosted checkout instead.',
      )
    }
  }

  // `chosen.amount` is the full price rather than a first installment
  // whenever this method cannot fund a split's second charge — see
  // `availableMethods`. `deal.presentment_amount` has to say the same thing
  // *before* the provider is asked to take it: `fund_deal` disputes a webhook
  // whose amount does not match that column, and a charge for the full
  // amount landing next to a deal still describing a first installment would
  // be exactly that mismatch. `collapse_deal_split` is the one write, under
  // the deal's row lock, and it is a no-op on every call that does not need it
  // — including the second `startCharge` call a rail's extra-factor step makes
  // against the same deal.
  let funding = deal
  if (chosen.amount !== deal.presentment_amount) {
    const { data, error } = await db.rpc('collapse_deal_split', { p_deal_id: deal.id })
    if (error) {
      throw new PayHoldError('policy_violation', error.message)
    }
    funding = data as Deal
  }

  const { provider, mode } = await loadProvider(db, tenantId, chosen.provider)
  const publicUrl = Deno.env.get('PUBLIC_URL') ?? 'https://app.payhold.local'

  const charge = await provider.charge({
    // Our deal id goes across as their reference, which is what lets the
    // webhook find its way back to the right deal.
    deal_id: funding.id,
    amount: funding.presentment_amount,
    currency: funding.presentment_currency,
    method: choice.method,
    network: choice.network,
    phone: choice.method === 'mobile_money' ? choice.phone : undefined,
    card: choice.card,
    authorization: choice.authorization,
    attempt: choice.attempt,
    return_url: choice.returnUrl ?? `${publicUrl}/deals/${deal.id}`,
    // §6: requested on every card charge, never silently downgraded.
    three_d_secure: choice.method === 'card',
    idempotency_key: `charge:${deal.id}`,
  })

  return {
    rail: chosen.provider,
    mode,
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
