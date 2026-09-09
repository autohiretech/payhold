/**
 * Accounts — how a person gets into the dashboard at all.
 *
 *   POST /account/signup          create a company and its first owner
 *   GET  /account/me              who am I, and which company am I acting for
 *   POST /account/reset-sandbox   wipe this company's test data and start over
 *
 * **Signing in does not come here.** The dashboard exchanges an email and
 * password with Supabase Auth directly (`/auth/v1/token`) and holds the JWT it
 * gets back; every other endpoint then authenticates it with `resolveCaller`.
 * Putting a sign-in proxy in front of that would mean routing every password in
 * the system through code we maintain, for no check GoTrue does not already do.
 *
 * Signup is the exception, and only because two things have to happen together:
 * an auth user exists (Supabase Auth's table), and it is linked to a tenant
 * (ours). A browser cannot do the second — `tenant_users` has no insert policy,
 * deliberately — so the service role does both here. The password is passed
 * straight to Supabase Auth and is never stored, logged, or read back.
 *
 * The two halves are not one transaction and cannot be: they are different
 * schemas behind different APIs. So the tenant side is written first-fails-last
 * and the auth user is deleted if the link cannot be made, leaving a failed
 * signup retryable rather than half-done.
 */

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { callerFromJwt, requireRole, serviceClient } from '../_shared/auth.ts'
import { handler, json, readJson, required } from '../_shared/http.ts'
import { slugify } from '../_shared/slug.ts'
import { PayHoldError } from '../_shared/types.ts'

/**
 * A dashboard session can read every deal, payout and ledger entry a company
 * has. Supabase Auth's floor is six characters, which is not a boundary worth
 * putting in front of that — so this endpoint sets its own, higher one.
 * `minimum_password_length` in `config.toml` is set to match, so the two
 * cannot disagree about what was accepted.
 */
const MIN_PASSWORD_LENGTH = 12

/** Enough to reject a typo, not enough to argue with a valid address. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

interface SignupBody {
  company_name: string
  email: string
  password: string
  full_name?: string
}

/**
 * Insert the tenant, working around a slug someone else already has.
 *
 * The uniqueness is the database's — checking first and then inserting would
 * race two people signing up the same company name at once — so this inserts,
 * catches the conflict, and tries the next candidate.
 */
async function createTenant(
  db: SupabaseClient,
  name: string,
): Promise<{ id: string; name: string; slug: string; status: string; created_at: string }> {
  const base = slugify(name)

  for (let attempt = 0; attempt < 6; attempt++) {
    const slug = attempt === 0
      ? base
      : `${base}-${crypto.randomUUID().slice(0, 6)}`

    const { data, error } = await db
      .from('tenants')
      .insert({ name, slug })
      .select('id, name, slug, status, created_at')
      .single()

    if (!error && data) return data

    // 23505 is unique_violation. Anything else is not a name collision and
    // retrying with a different suffix would only hide it.
    if (error?.code !== '23505') {
      console.error('tenant insert failed', { message: error?.message })
      throw new PayHoldError('policy_violation', 'Could not create the company')
    }
  }

  throw new PayHoldError('policy_violation', 'Could not create the company')
}

async function signup(req: Request, db: SupabaseClient): Promise<Response> {
  const body = await readJson<SignupBody>(req)
  required(
    body as unknown as Record<string, unknown>,
    'company_name',
    'email',
    'password',
  )

  const email = body.email.trim().toLowerCase()
  const companyName = body.company_name.trim()

  if (!EMAIL_RE.test(email)) {
    throw new PayHoldError('policy_violation', 'That does not look like an email address')
  }
  if (companyName.length < 2) {
    throw new PayHoldError('policy_violation', 'Company name is too short')
  }
  if (body.password.length < MIN_PASSWORD_LENGTH) {
    throw new PayHoldError(
      'policy_violation',
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
    )
  }

  // Confirmed on creation because this project has no SMTP sender configured,
  // and an unconfirmed user cannot sign in — so requiring confirmation without
  // a way to send it would lock out every account it created. Turning on
  // `auth.email.enable_confirmations` is a one-line change here and an SMTP
  // block in config.toml; until then, say plainly that the address is unproven.
  const { data: created, error: createError } = await db.auth.admin.createUser({
    email,
    password: body.password,
    email_confirm: true,
    user_metadata: body.full_name ? { full_name: body.full_name.trim() } : {},
  })

  if (createError || !created.user) {
    // Signup is the one place address enumeration cannot be designed away: the
    // person has to be told the difference between "created" and "sign in
    // instead", or they cannot proceed. Every *other* endpoint stays silent
    // about which accounts exist.
    const already = /registered|exists|duplicate/i.test(createError?.message ?? '')
    if (already) {
      throw new PayHoldError(
        'policy_violation',
        'An account with that email already exists — sign in instead',
      )
    }

    console.error('auth user creation failed', { message: createError?.message })
    throw new PayHoldError('policy_violation', 'Could not create the account')
  }

  const authUserId = created.user.id

  try {
    const tenant = await createTenant(db, companyName)

    // The first person in is the owner: someone has to be able to connect the
    // payment rails and approve a held payout, and there is nobody else yet.
    const { error: linkError } = await db
      .from('tenant_users')
      .insert({ tenant_id: tenant.id, auth_user_id: authUserId, role: 'owner' })

    if (linkError) {
      console.error('tenant_users insert failed', { message: linkError.message })
      throw new PayHoldError('policy_violation', 'Could not link the account to the company')
    }

    await db.rpc('write_audit', {
      p_tenant: tenant.id,
      p_deal: null,
      p_actor: `user:${email}`,
      p_action: 'account.created',
      p_details: { company_name: tenant.name, slug: tenant.slug, role: 'owner' },
    })

    return json(
      req,
      {
        tenant,
        user: { id: authUserId, email, role: 'owner' },
      },
      201,
    )
  } catch (err) {
    // Compensate: an auth user with no company can sign in and see nothing,
    // and — worse — holds the email address hostage against a retry.
    await db.auth.admin.deleteUser(authUserId).catch(() => {})
    throw err
  }
}

/**
 * The session's own account.
 *
 * The dashboard calls this straight after signing in, for two reasons: it is
 * what turns a JWT into a tenant and a role, and it is the check that an
 * account which authenticated is actually linked to a company. A user that
 * exists in Supabase Auth but has no `tenant_users` row is not a PayHold user.
 */
async function me(req: Request, db: SupabaseClient): Promise<Response> {
  const url = new URL(req.url)
  const caller = await callerFromJwt(db, req, url.searchParams.get('tenant') ?? undefined)

  const { data: tenant, error } = await db
    .from('tenants')
    .select('id, name, slug, status, created_at')
    .eq('id', caller.tenant_id)
    .maybeSingle()

  if (error || !tenant) {
    throw new PayHoldError('not_found', 'No such company')
  }

  return json(req, {
    user: { email: caller.actor.replace(/^user:/, '') },
    tenant,
    role: caller.role,
  })
}

/**
 * Wipe this company's own test data and start over — `reset_tenant_sandbox`
 * in the database, spec'd in `20260817000001_tenant_sandbox_reset.sql`.
 *
 * **Owner, dashboard session only.** The same reasoning `/settings` PATCH and
 * `/sellers/:id/verify` use: this is a decision for a named person inside the
 * company, not something a client's server should be able to trigger with
 * its own API key, and `staff`/`viewer` are deliberately not senior enough —
 * this deletes every deal, seller, payout and ledger entry the company has.
 *
 * **Requires typing the company's own slug** as `confirm`, so a misclick
 * cannot fire it — the dashboard shows the same confirmation GitHub uses
 * before it deletes a repository. The database is where the *real* guard
 * lives (a tenant that ever connected live credentials is refused
 * permanently, regardless of what this endpoint checks), so this is a UX
 * safety net on top of an enforced one, not instead of it.
 */
async function resetSandbox(req: Request, db: SupabaseClient): Promise<Response> {
  if (req.headers.get('x-api-key')) {
    throw new PayHoldError(
      'policy_violation',
      'Resetting a company\'s data is a person\'s decision and cannot be done with an API key',
    )
  }

  const caller = await callerFromJwt(db, req)
  requireRole(caller, 'owner')

  const body = await readJson<{ confirm?: string }>(req)

  const { data: tenant, error: tenantError } = await db
    .from('tenants')
    .select('id, slug')
    .eq('id', caller.tenant_id)
    .maybeSingle()

  if (tenantError || !tenant) {
    throw new PayHoldError('not_found', 'No such company')
  }

  if (body.confirm !== tenant.slug) {
    throw new PayHoldError(
      'policy_violation',
      `Type this company's slug ("${tenant.slug}") in "confirm" to reset it`,
    )
  }

  const { error } = await db.rpc('reset_tenant_sandbox', {
    p_tenant: caller.tenant_id,
    p_actor: caller.actor,
  })

  if (error) throw rpcError(error, 'reset this company\'s data')

  return json(req, { reset: true })
}

/** Same mechanical mapping every other function wrapping a SQL RPC uses. */
function rpcError(error: { message: string }, what: string): PayHoldError {
  const message = error.message

  for (const code of ['not_found', 'invalid_state', 'policy_violation'] as const) {
    if (message.startsWith(code)) {
      return new PayHoldError(code, message.slice(code.length + 2).trim())
    }
  }

  console.error(`unmapped ${what} failure`, { message })
  return new PayHoldError('policy_violation', `Could not ${what}`)
}

Deno.serve(handler(async (req) => {
  const db = serviceClient()
  const segments = new URL(req.url).pathname.split('/').filter(Boolean)
  const action = segments[segments.indexOf('account') + 1]

  if (req.method === 'POST' && action === 'signup') return await signup(req, db)
  if (req.method === 'GET' && action === 'me') return await me(req, db)
  if (req.method === 'POST' && action === 'reset-sandbox') return await resetSandbox(req, db)

  throw new PayHoldError('not_found', 'No such endpoint')
}))
