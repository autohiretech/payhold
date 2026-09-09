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

  // The gateway's admission ticket, and nothing more. It has to be one of the
  // project's *issued* keys: once the project moved to asymmetric JWT signing
  // keys, a self-signed token in this slot is refused at the edge with
  // "Invalid API key" before PostgREST ever sees it. The minted token used to
  // serve as both headers, and that is precisely what stopped working — every
  // AI write failed while the money paths, which use the issued service key,
  // carried on fine.
  const apiKey = Deno.env.get('SUPABASE_ANON_KEY')
  if (!apiKey) throw new Error('SUPABASE_ANON_KEY must be set')

  const token = await mintAiToken(tenantId)

  // **The role still comes from the bearer.** PostgREST switches roles on the
  // `Authorization` token's `role` claim, so this connects as `payhold_ai`
  // exactly as before — the anon key beside it is not a fallback and cannot
  // widen anything, and anon holds no grant on these tables regardless. A
  // token that fails to verify fails the request; it does not quietly demote
  // to the anon role.
  return createClient(url, apiKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  })
}

/** Is the AI layer's database access configured? */
export function aiDbConfigured(): boolean {
  return Boolean(Deno.env.get('AI_JWT_SECRET'))
}
