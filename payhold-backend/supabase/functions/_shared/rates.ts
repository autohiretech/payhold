/**
 * Where the rate that prices a live charge comes from.
 *
 * `fx.ts`'s header says in capitals that its `PER_USD` table MUST NOT price a
 * live charge, and until this file existed it did exactly that: `POST /v1/deals`
 * converted a seller's settlement amount into the buyer's presentment currency
 * against a snapshot labelled "Indicative, August 2026". Every point that
 * snapshot had drifted from the real rate was money somebody absorbed on every
 * international booking — the tenant when the table was generous to the buyer,
 * the buyer when it was not. Neither is a position anybody agreed to take, and
 * a table nobody updates only ever gets further from the truth.
 *
 * So the rate is **asked for**. `GET /v3/transfers/rates` on Flutterwave, with
 * the tenant's own credentials, is the quote: it is the rail that actually
 * settles the RWF corridor PayHold was built for, so its rate is the one the
 * money will really move at rather than a market mid-price we would then have
 * to explain the difference from.
 *
 * **This is not a caller branching on `provider.name`.** That rule
 * (`provider.ts`) is about routing a *payment* by capability rather than by
 * identity, and nothing here routes anything. Flutterwave is named because it
 * is the FX quote source, the way `ANTHROPIC_API_KEY` names one model vendor —
 * a second source would be a second implementation behind this function's own
 * signature, not a branch at the call site.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ONLY PLACE `PER_USD` MAY STILL PRICE ANYTHING IS DEMO MODE.
 *
 * "Demo mode with zero keys must work end to end" is a product rule this file
 * does not get to break: a tenant with no connected rail has no credentials to
 * ask a rate with, and refusing would make a fresh account unable to create its
 * first cross-border deal — the exact demonstration `FakeProvider` and
 * `ai-demo.ts` exist to protect. So a demo tenant gets the indicative table and
 * is told so in `source`.
 *
 * A tenant operating on real credentials gets a live rate or a refusal. There
 * is no third case, and in particular there is no quiet fall-through to the
 * table: an invented rate that moves real money is worse than a deal that
 * could not be created, because the first one is only discovered at
 * reconciliation and the second one is discovered immediately.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { tableRate } from './fx.ts'
import { connectedRails, loadProvider } from './load-provider.ts'
import { PayHoldError, type Currency } from './types.ts'


/**
 * How long a quoted rate may be reused.
 *
 * Fifteen minutes is short enough that a moving corridor is repriced within
 * the life of a checkout and long enough that a burst of bookings does not
 * become a burst of provider calls.
 *
 * **This is best-effort and nothing may depend on it.** An Edge Function
 * instance is short-lived and there are many of them, so this map is neither
 * shared between concurrent invocations nor guaranteed to survive to the next
 * one — a cold instance simply asks again, which is the correct behaviour and
 * the reason a miss is not an error. It exists to spare the rail a call, not
 * to make a rate stable: the rate that is actually *stable* is `deals.fx_rate`,
 * locked onto the deal at funding, and that is unchanged by any of this.
 */
const TTL_MS = 15 * 60 * 1000

/**
 * Where a rate came from, so a caller (and a reader of a log line) can tell a
 * quote from a placeholder. `payhold_indicative` is the name
 * `payout_decisions.fx_source` already uses for the table — one fact, one
 * spelling.
 */
export type RateSource = 'flutterwave' | 'payhold_indicative' | 'identity'

export interface Rate {
  /**
   * Units of `to` per 1 unit of `from`, **major units** — the same shape and
   * direction `fx.ts`'s own `.rate` carries, so `atLockedRate` applies it
   * without any further thought about minor units or zero-decimal currencies.
   */
  rate: number
  source: RateSource
}

interface CachedRate {
  rate: number
  expiresAt: number
}

/**
 * Keyed by corridor and not by tenant, because a market rate is a fact about
 * two currencies rather than about whose key fetched it.
 *
 * **Only live rates are ever cached.** A cached table rate would be
 * indistinguishable from a quote on the way back out, and the tenant it was
 * served to next might be the one operating on real credentials — which is
 * precisely the silent fallback this file exists to prevent. Demo mode reads
 * the table every time; it is a lookup in a constant and costs nothing.
 */
const cache = new Map<string, CachedRate>()

/**
 * Drop every cached rate.
 *
 * A test seam, and named as one: a rate cached by one test would otherwise
 * decide the next, and the failure would be an ordering-dependent pass rather
 * than a visible error. Nothing in the request path calls this — a rate is
 * expired by its own clock, never invalidated by a caller.
 */
export function clearRateCache(): void {
  cache.clear()
}

/**
 * The rate to price a charge at, live wherever real money is involved.
 *
 * Refuses rather than guessing. The refusal is a `policy_violation` because it
 * is a statement about what PayHold is willing to do — price a deal against a
 * number nobody quoted — and not a transport failure the caller could retry
 * into a different answer.
 */
export async function liveRate(
  db: SupabaseClient,
  tenantId: string,
  from: Currency,
  to: Currency,
): Promise<Rate> {
  // No conversion happened, so naming a source would be claiming a quote we
  // never asked for.
  if (from === to) return { rate: 1, source: 'identity' }

  const key = `${from}->${to}`
  const hit = cache.get(key)
  if (hit && hit.expiresAt > Date.now()) {
    return { rate: hit.rate, source: 'flutterwave' }
  }

  if (await isDemoTenant(db, tenantId)) {
    const indicative = tableRate(from, to)
    if (indicative === null) {
      throw new PayHoldError(
        'policy_violation',
        `No exchange rate is available between ${from} and ${to}`,
      )
    }
    return { rate: indicative, source: 'payhold_indicative' }
  }

  const rate = await flutterwaveRate(db, tenantId, from, to)
  cache.set(key, { rate, expiresAt: Date.now() + TTL_MS })
  return { rate, source: 'flutterwave' }
}

/**
 * Is this tenant still running on the demo rail?
 *
 * The question is "has this account connected **anything** real", not "has it
 * connected Flutterwave". A tenant collecting through Stripe alone is
 * operating on real credentials and real money, and handing it the indicative
 * table because the rate rail specifically is absent would reintroduce the
 * silent fallback under a narrower condition — the hardest kind to notice,
 * since it would only bite the accounts that had connected the *other* rail.
 * Such a tenant is refused below with a message that says what to do about it.
 *
 * `connectedRails` already answers exactly this and reports `fake` as active
 * precisely when nothing real is, so the demo rail disappearing is one fact
 * with one reader rather than a second derivation to keep in step.
 */
async function isDemoTenant(db: SupabaseClient, tenantId: string): Promise<boolean> {
  const rails = await connectedRails(db, tenantId)
  return !rails.some((r) => r.provider !== 'fake' && r.connected)
}

/**
 * Quote the corridor with the tenant's own Flutterwave account.
 *
 * Through `loadProvider`, so the decryption stays where `load-provider.ts`'s
 * header says it is — one site, handing back a `PaymentProvider` and never a
 * key. `transferRate` sits on `FlutterwaveProvider` next to `balances()` for
 * the same reason `banks()` does: it is a real capability of that rail rather
 * than something every adapter could answer, so it is declared optional on the
 * interface and absent from the ones that cannot.
 */
async function flutterwaveRate(
  db: SupabaseClient,
  tenantId: string,
  from: Currency,
  to: Currency,
): Promise<number> {
  const { provider, connected } = await loadProvider(db, tenantId, 'flutterwave')

  if (!connected || !provider.transferRate) {
    throw new PayHoldError(
      'policy_violation',
      `No live ${from}\u2192${to} rate can be quoted: this account is operating on real ` +
        'credentials but has not connected Flutterwave, which is the rail PayHold ' +
        'quotes rates from. Connect it, or price the deal in a currency the buyer ' +
        'can already be charged so that no conversion is needed.',
    )
  }

  try {
    return await provider.transferRate(from, to)
  } catch (err) {
    // Anything that stopped us asking \u2014 a refusal, a timeout, their IP
    // whitelist, malformed JSON \u2014 lands here, and all of it means the same
    // thing: we do not know the rate. Saying so is the whole point of the file.
    throw new PayHoldError(
      'policy_violation',
      `Could not get a live ${from}\u2192${to} rate from Flutterwave: ` +
        `${err instanceof Error ? err.message : String(err)}. PayHold will not ` +
        'price a charge against an indicative table.',
    )
  }
}

