/**
 * Turn a tenant + rail into a live `PaymentProvider`.
 *
 * This is the ONLY place credentials are decrypted. Everything that moves
 * money asks here and gets an interface back, never a key — so no other file
 * needs `decryptCredentials` imported, and a credential cannot end up in a log
 * line by accident.
 *
 * A tenant with no row for a rail is refused here. There is no simulated
 * counterparty any more: §12's demo mode existed so a company could see the
 * product work before connecting anything, and it is gone because a payment
 * path that answers "succeeded" without touching a provider is indisputably
 * worse than one that says "connect a rail first" — the same reasoning §9's
 * unbuilt adapters already followed one branch below.
 */

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { decryptCredentials } from './crypto.ts'
import { FlutterwaveProvider, type FlutterwaveCredentials } from './flutterwave.ts'
import { type PaymentProvider } from './provider.ts'
import { PayPalProvider, type PayPalCredentials } from './paypal.ts'
import { StripeProvider, type StripeCredentials } from './stripe.ts'
import { PayHoldError, type Provider } from './types.ts'

export interface LoadedProvider {
  provider: PaymentProvider
  mode: 'test' | 'live'
  /** Always true now that a provider is only ever a connected account. Kept
   * because callers and the dashboard read it to say which rail took the
   * money. */
  connected: boolean
}

function publicUrl(): string {
  return Deno.env.get('PUBLIC_URL') ?? 'https://app.payhold.local'
}

/**
 * §9's capability row for one adapter, or null if it has none.
 *
 * `provider_capabilities` is the database half of `ProviderCapabilities`, and
 * the two must agree — the flags are declared in both because one side is what
 * the code can do and the other is what an operator may switch off.
 */
export async function providerCapability(
  db: SupabaseClient,
  rail: Provider,
): Promise<{ implemented: boolean; enabled: boolean; note: string | null } | null> {
  const { data } = await db
    .from('provider_capabilities')
    .select('implemented, enabled, note')
    .eq('provider', rail)
    .maybeSingle()

  return data as { implemented: boolean; enabled: boolean; note: string | null } | null
}

const NOT_CONNECTED = 'is not connected — connect it in Rails before taking payments'

/** The refusal for a rail this tenant has no stored account on. One spelling,
 * because `rates.ts` recognises it (below) and a second copy could drift. */
export function railNotConnected(rail: Provider): PayHoldError {
  return new PayHoldError('policy_violation', `${rail} ${NOT_CONNECTED}`)
}

/**
 * Was that refusal "no stored account", rather than an unbuilt or switched-off
 * rail?
 *
 * `rates.ts` asks because the FX path has a better sentence than this one: it
 * knows *why* Flutterwave is being loaded — it is the rail rates are quoted
 * from, not the rail the buyer is being charged on — so it can say what to do
 * instead of converting. An unbuilt or disabled rail keeps its own message,
 * which already names a different next action.
 */
export function isRailNotConnected(err: unknown): boolean {
  return err instanceof PayHoldError && err.message.endsWith(NOT_CONNECTED)
}

export async function loadProvider(
  db: SupabaseClient,
  tenantId: string,
  rail: Provider,
  /**
   * The mode a specific deal actually charged under, when the caller has one
   * (`deals.provider_mode`). Every PayPal call is a routing decision — sandbox
   * and live are different hosts — and `tenant_provider_accounts.mode` is the
   * tenant's *current* setting, which can drift after a reconnect. A refund or
   * a deposit capture against an old deal must follow that deal's own history,
   * not today's setting, or it 404s at PayPal against an id that only exists
   * on the other host.
   *
   * This does not fully repair a mode change: `tenant_provider_accounts` keeps
   * one credential row per provider, so a reconnect overwrites the old mode's
   * client id/secret along with the mode itself. Passed here, a stale mode at
   * least routes to the right host and fails with an honest 401 ("PayPal
   * rejected these credentials") instead of a misleading 404 ("does not
   * exist") when the credentials underneath have since moved on too.
   */
  explicitMode?: 'test' | 'live',
): Promise<LoadedProvider> {
  // §9's declared-but-unbuilt adapters, the retired demo rail, and any rail an
  // operator has switched off. All of them fail here, for the reason Stripe
  // used to: a deal routed to an adapter that silently collected nothing while
  // reporting success is worse than a visible failure.
  //
  // The two are separate messages because they need different next actions —
  // one is a roadmap item, the other is an outage or a commercial decision.
  const capability = await providerCapability(db, rail)

  if (capability && !capability.implemented) {
    throw new PayHoldError(
      'policy_violation',
      `${rail} is declared but not built${capability.note ? ` — ${capability.note}` : ''}`,
    )
  }
  if (capability && !capability.enabled) {
    throw new PayHoldError(
      'policy_violation',
      `${rail} is switched off${capability.note ? ` — ${capability.note}` : ''}`,
    )
  }

  const { data } = await db
    .from('tenant_provider_accounts')
    .select('encrypted_credentials, mode')
    .eq('tenant_id', tenantId)
    .eq('provider', rail)
    .maybeSingle()

  if (!data) {
    // Nothing to charge against. This used to answer with the demo provider,
    // which meant a tenant who had connected nothing still saw deals fund and
    // settle — money that never moved, reported as money that had.
    throw railNotConnected(rail)
  }

  const credentials = await decryptCredentials(data.encrypted_credentials)

  switch (rail) {
    case 'flutterwave':
      return {
        provider: new FlutterwaveProvider(
          credentials as unknown as FlutterwaveCredentials,
          publicUrl(),
          // The adapter needs to know this for one reason: a sandbox transfer
          // only settles if its reference says so. This row is where the mode
          // is recorded, so it is read here once rather than re-derived from
          // the key inside the adapter.
          data.mode,
        ),
        mode: data.mode,
        connected: true,
      }
    case 'stripe':
      return {
        provider: new StripeProvider(
          credentials as unknown as StripeCredentials,
          publicUrl(),
        ),
        mode: data.mode,
        connected: true,
      }
    case 'paypal': {
      const mode = explicitMode ?? data.mode
      return {
        provider: new PayPalProvider(
          // The mode is carried on the credentials rather than read from the
          // row inside the adapter, because sandbox and live are different
          // *hosts* on this rail — not a flag on a request, the way they are
          // on the other two.
          { ...(credentials as unknown as PayPalCredentials), mode },
          publicUrl(),
        ),
        mode,
        connected: true,
      }
    }
    default:
      // An adapter with an enum value, a live capability row and no class here.
      // Unreachable while the two stay in step, and a loud failure if they do
      // not — which is the direction to fail in.
      throw new PayHoldError(
        'policy_violation',
        `${rail} has no adapter in this deployment`,
      )
  }
}

/**
 * Which rails this tenant has actually connected.
 *
 * The dashboard's Rails screen reads this. Every row is a real adapter: a
 * tenant with nothing connected gets three unconnected rails and no fourth
 * one offering to pretend.
 */
export async function connectedRails(
  db: SupabaseClient,
  tenantId: string,
): Promise<{ provider: Provider; mode: 'test' | 'live'; connected: boolean }[]> {
  const { data } = await db
    .from('tenant_provider_accounts')
    .select('provider, mode')
    .eq('tenant_id', tenantId)

  const rows = (data ?? []).map((r) => ({
    provider: r.provider as Provider,
    mode: r.mode as 'test' | 'live',
    connected: true,
  }))

  // The rails a tenant can actually connect today. The declared-but-unbuilt
  // adapters are deliberately absent: offering a "connect" button for something
  // `loadProvider` throws on would be an invitation to a dead end.
  const real: Provider[] = ['flutterwave', 'stripe', 'paypal']
  for (const rail of real) {
    if (!rows.some((r) => r.provider === rail)) {
      rows.push({ provider: rail, mode: 'test', connected: false })
    }
  }

  return rows.sort((a, b) => a.provider.localeCompare(b.provider))
}
