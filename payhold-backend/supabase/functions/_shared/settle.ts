/**
 * Settling a charge by asking the rail — §15 phase 2's evidence, without the
 * webhook.
 *
 * Until now `fund_deal` had exactly one caller per rail: the inbound provider
 * webhook. That is correct about *evidence* and wrong about *delivery*, and the
 * two got conflated. What makes a payment true is step 4 — re-fetching the
 * transaction from the provider over our own authenticated connection — not the
 * fact that a POST arrived first. A webhook is a doorbell. It tells us to go and
 * look; it is not itself the thing we look at.
 *
 * Treating the doorbell as the evidence made every payment depend on a delivery
 * we do not control. A webhook URL not yet registered in the provider's
 * dashboard, a tenant whose events point at the wrong path segment, a retry
 * budget exhausted during an outage of ours — each one ends with money sitting
 * at the rail, a buyer who has been debited and shown a spinner, a deal frozen
 * at `payment_pending`, and a seller who never learns they sold anything. That
 * is not a hypothetical: it is the state AutoHire's first live card payment
 * ended in, with `provider_ref` empty and an audit trail that stopped at
 * `checkout.completed`.
 *
 * So this file is the second caller, and it asks the same question of the same
 * API and applies the same transactional write. Nothing here is a shortcut past
 * verification — it *is* the verification, reached by polling instead of by
 * being told. The invariant the spec actually cares about holds exactly as
 * before: a deal reaches `funded_held` only when the provider, asked directly,
 * says the money is theirs and ours.
 *
 * Two callers of its own:
 *
 *   • `checkout`'s `/confirm`, which the buyer's own page calls while it waits.
 *     A payment that lands settles in seconds rather than whenever the doorbell
 *     works.
 *   • `settle-pending`, the sweep, for the buyer who closed the tab. Without it
 *     this would only fix payments somebody stayed to watch.
 */

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { convert } from './fx.ts'
import { loadProvider } from './load-provider.ts'
import { normaliseIp, recordContext } from './request-context.ts'
import { loadSettings } from './settings.ts'
import type { DealStatus, PaymentMethod, Provider } from './types.ts'

/**
 * The deal columns a settlement needs, and no others.
 *
 * Exported as a string beside the interface so the two callers select the same
 * set. A settlement that quietly ran on a partial row would read `undefined`
 * as a currency and book a hold against it.
 */
export const SETTLE_COLUMNS =
  'id, tenant_id, currency, presentment_currency, status, provider, provider_ref'

export interface SettleableDeal {
  id: string
  tenant_id: string
  currency: string
  presentment_currency: string
  status: DealStatus
  provider: Provider
  provider_ref: string | null
}

/**
 * The statuses `fund_deal` accepts, mirrored here.
 *
 * Duplicated from the SQL deliberately rather than discovered by calling it:
 * this is what lets a poll on an already-funded deal cost nothing at all. The
 * function is still the authority — it re-checks under a row lock — and a
 * disagreement between the two lists costs an unnecessary provider call, never
 * a wrong write.
 */
const FUNDABLE: readonly DealStatus[] = [
  'created',
  'checkout_started',
  'payment_pending',
  'payment_failed',
]

/**
 * Why a settlement did not happen. Every one of these is an ordinary answer
 * rather than a failure — a buyer mid-payment produces `pending` on every poll
 * until the moment they do not.
 */
export type SettleReason =
  /** Past funding already: funded, released, refunded, canceled. */
  | 'settled'
  /** Nothing has been charged yet, so there is nothing to ask about. */
  | 'not_started'
  /** A demo rail, or a tenant whose credentials are gone. Cannot be verified. */
  | 'not_connected'
  /** The rail could not be reached, or has never heard of this reference. */
  | 'unreachable'
  /** The rail has the charge and it has not landed. The common answer. */
  | 'pending'
  /** The rail says it failed. The deal is left where it is — see below. */
  | 'failed'
  /** The rail says it landed and `fund_deal` refused it. Always loud. */
  | 'fund_failed'
  /** It landed for the wrong amount. `fund_deal` sent it to a person, not a hold. */
  | 'mismatch'

export interface Settlement {
  /** The deal's status now — after funding, when this call is what funded it. */
  status: DealStatus
  /** True only when this call moved the money into a hold. */
  funded: boolean
  reason: SettleReason | null
}

/**
 * Persist a reusable payment-method reference onto a deal's own metadata —
 * the only place a split deal's later balance charge (`chargeSaved`) can
 * read it back from. Every caller of `fund_deal` reaches this: this file's
 * own poll/sweep path, and both inbound webhooks, which fund deals directly
 * rather than through here.
 *
 * A merge, not an overwrite: `deals.metadata` may already carry other keys a
 * caller set at creation, and clobbering them here would make this a second
 * writer stepping on the first.
 */
export async function persistSavedPaymentMethod(
  db: SupabaseClient,
  dealId: string,
  token: string | null,
): Promise<void> {
  if (!token) return

  const { data } = await db.from('deals').select('metadata').eq('id', dealId).maybeSingle()
  const metadata = (data?.metadata ?? {}) as Record<string, unknown>

  await db
    .from('deals')
    .update({ metadata: { ...metadata, saved_payment_method: token } })
    .eq('id', dealId)
}

/**
 * Ask the rail whether this deal's charge landed, and book the hold if it did.
 *
 * `hint` carries what the checkout session knows and the deal row does not yet.
 * The reference matters most: Flutterwave is asked by `tx_ref`, which is our
 * deal id, but Stripe is asked by the `pi_…` its charge returned, and that lives
 * on the session until funding writes it onto the deal. Passing the wrong one
 * is not dangerous — it produces `unreachable` — but it is the difference
 * between a payment settling now and settling when the sweep next runs.
 */
export async function settleDeal(
  db: SupabaseClient,
  deal: SettleableDeal,
  hint: {
    rail?: Provider | null
    reference?: string | null
    method?: PaymentMethod | null
    network?: string | null
  } = {},
): Promise<Settlement> {
  if (!FUNDABLE.includes(deal.status)) {
    return { status: deal.status, funded: false, reason: 'settled' }
  }

  const rail = hint.rail ?? deal.provider
  const loaded = await loadProvider(db, deal.tenant_id, rail)

  if (!loaded.connected) {
    // The same refusal the webhooks make on an unconnected tenant, and for the
    // same reason: there is no external truth to check against, so anything we
    // wrote would be our own invention. A demo tenant funds through the fake
    // rail's own path, never through this one.
    return { status: deal.status, funded: false, reason: 'not_connected' }
  }

  const reference = hint.reference ?? deal.provider_ref ?? deal.id

  let verified
  try {
    verified = await loaded.provider.verify(reference)
  } catch (err) {
    // A probe that could not be made is not a payment that failed, and this is
    // called on a loop while a buyer watches. The rail 404s a reference it has
    // never seen — which is exactly what a charge that never started looks like
    // — so throwing here would show an error to someone whose payment is fine.
    console.error('settlement probe failed', {
      deal_id: deal.id,
      provider: rail,
      reference,
      message: err instanceof Error ? err.message : String(err),
    })
    return { status: deal.status, funded: false, reason: 'unreachable' }
  }

  if (verified.status !== 'successful') {
    /**
     * A `failed` verdict is reported and not written.
     *
     * It would be easy to move the deal to `payment_failed` here, and wrong:
     * `verify_by_reference` answers about a *reference*, and a buyer whose
     * first card was declined retries against that same reference. Recording
     * the decline would then race the retry that is already in flight. The
     * client already learns what happened from the charge call it made; this
     * one only ever adds a hold.
     */
    return {
      status: deal.status,
      funded: false,
      reason: verified.status === 'failed' ? 'failed' : 'pending',
    }
  }

  const settings = await loadSettings(db, deal.tenant_id)

  // Locked from what actually arrived against what the seller is owed, exactly
  // as the webhooks lock it. Re-deriving it later would move the number under a
  // deal that has already been paid.
  const lockedRate = verified.currency === deal.currency
    ? null
    : convert(1_000_000, deal.currency, verified.currency)?.rate ?? null

  // Said before the write rather than after it, so a deal that funds through
  // the doorbell and a deal that funds through the poll are told apart in the
  // audit trail. `fund_deal` writes `webhook.verified` either way — it cannot
  // see which of its callers reached it — and an operator reading a payment
  // that no webhook ever delivered deserves to know that.
  await db.rpc('write_audit', {
    p_tenant: deal.tenant_id,
    p_deal: deal.id,
    p_actor: 'system',
    p_action: 'charge.verified_by_poll',
    p_details: { provider: rail, reference },
  })

  // One call, and the same one. The amount/currency comparison and the state
  // write share a transaction, which is what makes "mismatch → disputed, never
  // funded_held" a guarantee rather than a hope.
  const { data, error } = await db.rpc('fund_deal', {
    p_deal_id: deal.id,
    p_provider: rail,
    p_provider_ref: verified.provider_ref,
    p_method: verified.method ?? hint.method ?? null,
    p_network: verified.network ?? hint.network ?? null,
    p_verified_amount: verified.amount,
    p_verified_currency: verified.currency,
    p_fx_rate: lockedRate,
    p_auto_release_days: settings.auto_release_days,
    p_provider_fee: verified.fee,
  })

  // §6's request context. Nothing observed here belongs to the buyer — this
  // request came from a poll or a cron, not from them — so the row records the
  // provider's confirmation with no address rather than attributing ours to
  // somebody else.
  await recordContext(db, {
    deal_id: deal.id,
    source: 'provider',
    event: 'charge_confirmed',
    ip: normaliseIp(''),
    ip_country: null,
    user_agent: null,
  })

  if (error) {
    console.error('funding failed', {
      deal_id: deal.id,
      provider: rail,
      message: error.message,
    })
    return { status: deal.status, funded: false, reason: 'fund_failed' }
  }

  // `fund_deal` returns the deal it wrote, so the status is the real one rather
  // than an assumption — `disputed` when the amount did not match, and a caller
  // that assumed `funded_held` would tell the buyer their trip was booked.
  //
  // A redelivery that lost the race reads as funded here too, which is right:
  // the question this answers is "is the money held", not "was it me who held
  // it".
  const written = data as unknown as { status: DealStatus } | null
  const status = written?.status ?? deal.status
  const held = status === 'funded_held'

  if (held) {
    await persistSavedPaymentMethod(db, deal.id, verified.saved_payment_method)
  }

  return { status, funded: held, reason: held ? null : 'mismatch' }
}
