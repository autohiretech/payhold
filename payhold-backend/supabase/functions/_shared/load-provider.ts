/**
 * Turn a tenant + rail into a live `PaymentProvider`.
 *
 * This is the ONLY place credentials are decrypted. Everything that moves
 * money asks here and gets an interface back, never a key — so no other file
 * needs `decryptCredentials` imported, and a credential cannot end up in a log
 * line by accident.
 *
 * A tenant with no row for a rail falls back to `FakeProvider`. That is the
 * spec's demo mode (§12): a company can run a complete deal lifecycle before
 * they have any provider account at all, and the fake fakes only the
 * counterparty — every guard still applies.
 */

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { decryptCredentials } from './crypto.ts'
import { FlutterwaveProvider, type FlutterwaveCredentials } from './flutterwave.ts'
import { FakeProvider, type PaymentProvider } from './provider.ts'
import { PayPalProvider, type PayPalCredentials } from './paypal.ts'
import { StripeProvider, type StripeCredentials } from './stripe.ts'
import { PayHoldError, type Provider } from './types.ts'

export interface LoadedProvider {
  provider: PaymentProvider
  mode: 'test' | 'live'
  /** False when this is the demo rail rather than a connected account. */
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

export async function loadProvider(
  db: SupabaseClient,
  tenantId: string,
  rail: Provider,
): Promise<LoadedProvider> {
  if (rail === 'fake') {
    return { provider: new FakeProvider(publicUrl()), mode: 'test', connected: false }
  }

  // §9's declared-but-unbuilt adapters, and any rail an operator has switched
  // off. Both fail here and neither falls back to the fake, for the reason
  // Stripe used to: a deal routed to an adapter that silently collected nothing
  // while reporting success is worse than a visible failure.
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
    // No account connected. Demo mode rather than an error, so a fresh tenant
    // is never blocked from seeing the product work end to end.
    return { provider: new FakeProvider(publicUrl()), mode: 'test', connected: false }
  }

  const credentials = await decryptCredentials(data.encrypted_credentials)

  switch (rail) {
    case 'flutterwave':
      return {
        provider: new FlutterwaveProvider(
          credentials as unknown as FlutterwaveCredentials,
          publicUrl(),
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
    case 'paypal':
      return {
        provider: new PayPalProvider(
          // The mode is carried on the credentials rather than read from the
          // row inside the adapter, because sandbox and live are different
          // *hosts* on this rail — not a flag on a request, the way they are
          // on the other two.
          { ...(credentials as unknown as PayPalCredentials), mode: data.mode },
          publicUrl(),
        ),
        mode: data.mode,
        connected: true,
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
 * The dashboard's Rails screen reads this instead of the hardcoded placeholder
 * it shows today. `fake` is reported as active only when nothing real is
 * connected — the demo rail disappears the moment real keys arrive.
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

  rows.push({
    provider: 'fake',
    mode: 'test',
    // Demo mode is "active" precisely when no real rail is connected.
    connected: !rows.some((r) => r.connected),
  })

  return rows.sort((a, b) => a.provider.localeCompare(b.provider))
}
