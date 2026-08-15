/**
 * The database handle the AI layer runs on — invariant 9, made mechanical.
 *
 * Every other Edge Function reaches for `serviceClient()`, which bypasses RLS
 * and can call any money function. The drafting functions must not, and
 * "must not" is worth very little as a convention: it survives exactly until
 * someone adds a line to a file they have not read the top of.
 *
 * So this returns a client authenticated as `payhold_ai` — a Postgres role that
 * holds `select` on the case-file tables, `insert` on `ai_suggestions` and
 * `ai_chat`, and execute on nothing that moves money (see the grant list in
 * `20260806000004_intelligence.sql`). If a future AI code path tries to call
 * `release_deal`, Postgres refuses it. That is a guarantee; a comment is not.
 *
 * The tenant is pinned into the token rather than passed as a filter, and the
 * role's RLS policies read it from there. A query that forgets its
 * `.eq('tenant_id', …)` therefore returns nothing rather than everything —
 * which is the failure mode you want on the one code path that assembles free
 * text for a model.
 */

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { PayHoldError } from './types.ts'

/** Short: the token is minted per request and never stored anywhere. */
const TOKEN_TTL_SECONDS = 60

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function encodeSegment(value: unknown): string {
  return base64url(new TextEncoder().encode(JSON.stringify(value)))
}

/**
 * Mint an HS256 token claiming the `payhold_ai` role for one tenant.
 *
 * Signed with the project's JWT secret, which is what PostgREST verifies
 * against before it switches roles. The `tenant_id` claim is not a Supabase
 * convention — it is ours, read by `current_ai_tenant_id()` in the policies.
 *
 * The secret lives in `AI_JWT_SECRET`, not `SUPABASE_JWT_SECRET` — the
 * Supabase CLI refuses to let a function secret start with `SUPABASE_`, that
 * prefix being reserved for the values it auto-injects (`SUPABASE_URL`,
 * `SUPABASE_ANON_KEY`, …). Its *value* must still be the project's real JWT
 * secret, copied from the dashboard — this is a rename of the env var name,
 * not a new secret.
 */
async function mintAiToken(tenantId: string): Promise<string> {
  const secret = Deno.env.get('AI_JWT_SECRET')
  if (!secret) {
    // Nothing falls back to the service role here. A missing secret means the
    // AI layer is unconfigured, and the safe reading of "unconfigured" is
    // "off" — not "run with the keys to the ledger".
    throw new PayHoldError(
      'policy_violation',
      'Intelligence is not configured on this deployment. Money paths are unaffected.',
    )
  }

  const issued = Math.floor(Date.now() / 1000)
  const header = encodeSegment({ alg: 'HS256', typ: 'JWT' })
  const payload = encodeSegment({
    role: 'payhold_ai',
    tenant_id: tenantId,
    iss: 'payhold-intelligence',
    iat: issued,
    exp: issued + TOKEN_TTL_SECONDS,
  })

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${header}.${payload}`),
  )

  return `${header}.${payload}.${base64url(new Uint8Array(signature))}`
}

/**
 * A Supabase client that can read this tenant's case file and write a
 * suggestion, and can do nothing else.
 *
 * Pass the tenant resolved by `resolveCaller` — never one supplied by the
 * caller. The token is the tenant scope, so getting this argument wrong is the
 * one way to cross tenants from here.
 */
export async function aiReadClient(tenantId: string): Promise<SupabaseClient> {
  const url = Deno.env.get('SUPABASE_URL')
  if (!url) throw new Error('SUPABASE_URL must be set')

  const token = await mintAiToken(tenantId)

  // The minted token serves as both the apikey and the bearer: PostgREST reads
  // the role claim from it either way, and there is deliberately no anon key
  // here to fall back to a wider role by accident.
  return createClient(url, token, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  })
}

/** Is the AI layer's database access configured? */
export function aiDbConfigured(): boolean {
  return Boolean(Deno.env.get('AI_JWT_SECRET'))
}
