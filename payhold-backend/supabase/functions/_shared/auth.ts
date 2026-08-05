/**
 * Who is calling, and which tenant they are allowed to act as.
 *
 * There are two callers and they authenticate differently:
 *
 *   API clients      `X-Api-Key`, hashed at rest, looked up by hash.
 *   Dashboard users  a Supabase Auth JWT, mapped to a tenant via
 *                    `tenant_users`.
 *
 * Every request resolves to exactly one tenant id, and every query downstream
 * filters on it. Nothing in this file trusts a tenant id supplied by the
 * caller — that is the whole point of resolving it here.
 */

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { hashApiKey } from './crypto.ts'
import { PayHoldError } from './types.ts'

/**
 * The service-role client. Bypasses RLS, so this is the only thing in the
 * system that can write money rows — and the reason no client ever receives
 * this key.
 */
export function serviceClient(): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL')
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set')
  }

  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

export interface Caller {
  tenant_id: string
  /** What goes in `audit_log.actor`. */
  actor: string
  kind: 'api_key' | 'dashboard'
  /** Dashboard callers only. */
  role?: 'owner' | 'staff' | 'viewer'
}

/**
 * Resolve an API client from `X-Api-Key`.
 *
 * The key is hashed and matched by hash — the plaintext is never stored, so
 * there is nothing to compare against directly. A revoked key is treated
 * identically to one that never existed.
 */
export async function callerFromApiKey(
  db: SupabaseClient,
  req: Request,
): Promise<Caller> {
  const presented = req.headers.get('x-api-key')
  if (!presented) {
    throw new PayHoldError('unauthorized', 'Missing X-Api-Key header')
  }

  const { data, error } = await db
    .from('api_keys')
    .select('id, tenant_id, label, revoked_at')
    .eq('key_hash', await hashApiKey(presented))
    .maybeSingle()

  // Same message whether the key is unknown, revoked, or malformed. Telling
  // them which would let a caller probe for valid keys.
  if (error || !data || data.revoked_at) {
    throw new PayHoldError('unauthorized', 'Invalid or revoked API key')
  }

  // Fire and forget: a failed last_used_at write must not fail the request.
  db.from('api_keys')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', data.id)
    .then(() => {})

  return {
    tenant_id: data.tenant_id,
    actor: `api_key:${data.label}`,
    kind: 'api_key',
  }
}

/**
 * Resolve a dashboard user from their Supabase Auth JWT.
 *
 * `tenant_id` is optional and only consulted when the user belongs to more
 * than one tenant — it selects among the tenants they already have, and can
 * never grant one they do not.
 */
export async function callerFromJwt(
  db: SupabaseClient,
  req: Request,
  tenantId?: string,
): Promise<Caller> {
  const header = req.headers.get('authorization')
  if (!header?.startsWith('Bearer ')) {
    throw new PayHoldError('unauthorized', 'Missing bearer token')
  }

  const { data: userData, error: userError } = await db.auth.getUser(
    header.slice('Bearer '.length),
  )
  if (userError || !userData.user) {
    throw new PayHoldError('unauthorized', 'Invalid or expired session')
  }

  const { data: memberships, error } = await db
    .from('tenant_users')
    .select('tenant_id, role')
    .eq('auth_user_id', userData.user.id)

  if (error || !memberships || memberships.length === 0) {
    throw new PayHoldError('unauthorized', 'This account is not linked to a company')
  }

  const chosen = tenantId
    ? memberships.find((m) => m.tenant_id === tenantId)
    : memberships[0]

  // Asking for a tenant they are not a member of is indistinguishable from
  // asking for one that does not exist.
  if (!chosen) {
    throw new PayHoldError('not_found', 'No such company')
  }

  return {
    tenant_id: chosen.tenant_id,
    actor: `user:${userData.user.email ?? userData.user.id}`,
    kind: 'dashboard',
    role: chosen.role,
  }
}

/**
 * Reject a caller who may read but not act.
 *
 * Connecting provider credentials and moving money are owner-level actions;
 * `viewer` exists precisely so a finance observer can be given the dashboard
 * without being given the keys.
 */
export function requireRole(caller: Caller, ...allowed: Caller['role'][]): void {
  if (caller.kind === 'api_key') return
  if (!caller.role || !allowed.includes(caller.role)) {
    throw new PayHoldError(
      'unauthorized',
      `This action needs ${allowed.join(' or ')} access`,
    )
  }
}

/** Is this tenant allowed to move money right now? */
export async function assertPayoutsNotFrozen(
  db: SupabaseClient,
  tenantId: string,
): Promise<void> {
  const { data } = await db
    .from('tenants')
    .select('status')
    .eq('id', tenantId)
    .maybeSingle()

  if (data?.status === 'payouts_frozen') {
    throw new PayHoldError(
      'policy_violation',
      'Payouts are frozen for this company pending reconciliation',
    )
  }
  if (data?.status === 'suspended') {
    throw new PayHoldError('unauthorized', 'This company is suspended')
  }
}
