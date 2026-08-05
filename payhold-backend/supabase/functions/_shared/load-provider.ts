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

export async function loadProvider(
  db: SupabaseClient,
  tenantId: string,
  rail: Provider,
): Promise<LoadedProvider> {
  if (rail === 'fake') {
    return { provider: new FakeProvider(publicUrl()), mode: 'test', connected: false }
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
      // StripeProvider is not written yet. Falling back to the fake here would
      // be worse than failing: a deal routed to Stripe would silently collect
      // nothing while reporting success.
      throw new PayHoldError(
        'policy_violation',
        'Stripe is connected but the Stripe rail is not implemented yet',
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

  const real: Provider[] = ['flutterwave', 'stripe']
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
