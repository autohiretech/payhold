/**
 * Connect, inspect and disconnect a company's payment provider account.
 *
 * This is the bring-your-own-keys path: each tenant's buyers pay into that
 * tenant's OWN Flutterwave or Stripe balance. PayHold orchestrates and never
 * custodies, which keeps the money out of a PayHold-owned account.
 *
 *   GET     /provider-accounts              which rails are connected
 *   POST    /provider-accounts              connect (validated, then encrypted)
 *   DELETE  /provider-accounts?provider=…   disconnect
 *
 * Credentials go in and never come out. There is no endpoint that returns
 * them, in any form, to any caller — the only reader is the money code, via
 * `loadProvider`. Rotation is a fresh POST, not a read-modify-write.
 */

import {
  callerFromJwt,
  requireRole,
  serviceClient,
  type Caller,
} from '../_shared/auth.ts'
import { encryptCredentials } from '../_shared/crypto.ts'
import { assertLiveAllowed } from '../_shared/launch.ts'
import {
  validateFlutterwaveCredentials,
  type FlutterwaveCredentials,
} from '../_shared/flutterwave.ts'
import {
  validateStripeCredentials,
  type StripeCredentials,
} from '../_shared/stripe.ts'
import { handler, json, readJson, required } from '../_shared/http.ts'
import {
  HOLDING_STATUSES,
  PAST_HOLD_STATUSES,
  PayHoldError,
  type Provider,
} from '../_shared/types.ts'
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'

interface ConnectBody {
  provider: Provider
  mode: 'test' | 'live'
  credentials: Record<string, string>
}

/**
 * What each rail needs, and what a tenant is told to go and fetch.
 *
 * Naming the fields here rather than accepting a free-form blob means a typo'd
 * key name fails at connect time with a readable message, instead of at the
 * first charge with a 401 from the provider.
 */
const REQUIRED_FIELDS: Record<string, { fields: string[]; where: string }> = {
  flutterwave: {
    fields: ['secret_key', 'public_key', 'encryption_key', 'webhook_hash'],
    where: 'Flutterwave dashboard → Settings → API Keys (webhook_hash is the ' +
      'secret hash on Settings → Webhooks)',
  },
  stripe: {
    fields: ['secret_key', 'publishable_key', 'webhook_secret'],
    where: 'Stripe dashboard → Developers → API keys, and Developers → Webhooks ' +
      'for the signing secret',
  },
  // `webhook_id` rather than a signing secret, because PayPal verifies a
  // signature by API call and that call names the webhook being checked. A
  // connection without it can take money and cannot prove an inbound event
  // came from them, which invariant 2 does not allow.
  paypal: {
    fields: ['client_id', 'client_secret', 'webhook_id'],
    where: 'PayPal Developer dashboard → Apps & Credentials for the client id ' +
      'and secret, and the same app\'s Webhooks section for the webhook id',
  },
}

async function listAccounts(
  req: Request,
  db: SupabaseClient,
  caller: Caller,
): Promise<Response> {
  // Note what is NOT selected. `encrypted_credentials` never leaves the
  // database, so it is never in a response object that could be logged.
  const { data, error } = await db
    .from('tenant_provider_accounts')
    .select('provider, mode, created_at')
    .eq('tenant_id', caller.tenant_id)
    .order('provider')

  if (error) throw new PayHoldError('not_found', 'Could not read provider accounts')

  return json(
    req,
    {
      accounts: data ?? [],
      // What the dashboard needs to render a connect form without hardcoding
      // provider knowledge in the UI.
      available: Object.entries(REQUIRED_FIELDS).map(([provider, meta]) => ({
        provider,
        fields: meta.fields,
        where: meta.where,
      })),
    },
  )
}

async function connect(
  req: Request,
  db: SupabaseClient,
  caller: Caller,
): Promise<Response> {
  const body = await readJson<ConnectBody>(req)
  required(body as unknown as Record<string, unknown>, 'provider', 'mode', 'credentials')

  const spec = REQUIRED_FIELDS[body.provider]
  if (!spec) {
    throw new PayHoldError(
      'policy_violation',
      `Unknown provider "${body.provider}". Supported: ${Object.keys(REQUIRED_FIELDS).join(', ')}`,
    )
  }
  if (body.mode !== 'test' && body.mode !== 'live') {
    throw new PayHoldError('policy_violation', 'mode must be "test" or "live"')
  }

  // §16: the production release begins in test mode, and §15 phase 8 keeps live
  // keys disabled until the checklist is signed off. This is the only door live
  // credentials can come through — a rail with no stored account falls back to
  // `FakeProvider`, and there is no other writer of
  // `tenant_provider_accounts` — so one check here is the whole gate.
  //
  // Deliberately before the credential validation below: refusing after we have
  // sent a live secret key to the provider would have already used it.
  if (body.mode === 'live') {
    await assertLiveAllowed(db)
  }

  const missing = spec.fields.filter((f) => !body.credentials?.[f]?.trim())
  if (missing.length > 0) {
    throw new PayHoldError(
      'policy_violation',
      `Missing ${body.provider} credential${missing.length > 1 ? 's' : ''}: ` +
        `${missing.join(', ')}. Find them at ${spec.where}.`,
    )
  }

  // Keep only the fields the rail declares. A pasted blob carrying extra
  // values would otherwise be encrypted and stored forever.
  const credentials = Object.fromEntries(
    spec.fields.map((f) => [f, body.credentials[f].trim()]),
  )

  // A live secret key connected as "test" would move real money on the
  // sandbox walkthrough. Flutterwave marks test keys explicitly, so this is
  // checkable rather than a matter of trust.
  const isTestKey = body.provider === 'flutterwave'
    ? credentials.secret_key.includes('_TEST-')
    // Stripe marks the mode in the key prefix, `sk_test_` against `sk_live_`,
    // which makes this checkable on both rails rather than a matter of trust.
    : credentials.secret_key.startsWith('sk_test_')

  if (isTestKey !== (body.mode === 'test')) {
    throw new PayHoldError(
      'policy_violation',
      isTestKey
        ? 'That is a test secret key, but you selected live mode.'
        : 'That is a live secret key, but you selected test mode. ' +
          'Live keys move real money.',
    )
  }

  // Prove the keys work BEFORE storing them. Storing unvalidated credentials
  // moves the failure to the first real charge, in front of a buyer.
  const check = body.provider === 'flutterwave'
    ? await validateFlutterwaveCredentials(
      credentials as unknown as FlutterwaveCredentials,
    )
    : await validateStripeCredentials(credentials as unknown as StripeCredentials)

  if (!check.ok) {
    throw new PayHoldError(
      'policy_violation',
      `Those credentials were refused by ${body.provider}: ${check.reason}`,
    )
  }

  const { error } = await db
    .from('tenant_provider_accounts')
    .upsert(
      {
        tenant_id: caller.tenant_id,
        provider: body.provider,
        encrypted_credentials: await encryptCredentials(credentials),
        mode: body.mode,
      },
      { onConflict: 'tenant_id,provider' },
    )

  if (error) {
    throw new PayHoldError('policy_violation', 'Could not store those credentials')
  }

  // Audited, never with the credentials themselves — only that a connection
  // happened, by whom, on which rail.
  await db.rpc('write_audit', {
    p_tenant: caller.tenant_id,
    p_deal: null,
    p_actor: caller.actor,
    p_action: 'provider.connected',
    p_details: { provider: body.provider, mode: body.mode },
  })

  return json(req, { provider: body.provider, mode: body.mode, connected: true }, 201)
}

async function disconnect(
  req: Request,
  db: SupabaseClient,
  caller: Caller,
): Promise<Response> {
  const provider = new URL(req.url).searchParams.get('provider')
  if (!provider) {
    throw new PayHoldError('policy_violation', 'Specify ?provider=')
  }

  // Money in flight on this rail would be unreachable without its credentials:
  // no payout could be sent, no refund issued. Disconnecting is blocked until
  // those deals settle.
  const { count } = await db
    .from('deals')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', caller.tenant_id)
    .eq('provider', provider)
    // Everything still holding money, plus everything past the hold that has
    // not yet been paid out. Without credentials none of these could be paid
    // or refunded, so the deals would be stranded.
    .in('status', [
      ...HOLDING_STATUSES,
      ...PAST_HOLD_STATUSES.filter((s) => s !== 'paid_out'),
    ])

  if ((count ?? 0) > 0) {
    throw new PayHoldError(
      'policy_violation',
      `${count} deal${count === 1 ? ' still holds' : 's still hold'} money on ` +
        `${provider}. Settle or refund ${count === 1 ? 'it' : 'them'} before disconnecting.`,
    )
  }

  await db
    .from('tenant_provider_accounts')
    .delete()
    .eq('tenant_id', caller.tenant_id)
    .eq('provider', provider)

  await db.rpc('write_audit', {
    p_tenant: caller.tenant_id,
    p_deal: null,
    p_actor: caller.actor,
    p_action: 'provider.disconnected',
    p_details: { provider },
  })

  return json(req, { provider, connected: false })
}

Deno.serve(handler(async (req) => {
  const db = serviceClient()
  const tenantId = new URL(req.url).searchParams.get('tenant_id') ?? undefined
  const caller = await callerFromJwt(db, req, tenantId)

  switch (req.method) {
    case 'GET':
      return await listAccounts(req, db, caller)
    case 'POST':
      // Connecting a payment account is an owner action. `viewer` exists so a
      // finance observer can watch the money without holding the keys.
      requireRole(caller, 'owner')
      return await connect(req, db, caller)
    case 'DELETE':
      requireRole(caller, 'owner')
      return await disconnect(req, db, caller)
    default:
      throw new PayHoldError('policy_violation', `${req.method} is not supported here`)
  }
}))
