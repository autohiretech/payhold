/**
 * Sign-in against the mock — the browser-side stand-in for Supabase Auth plus
 * `tenant_users`.
 *
 * It exists for the same reason `FakeProvider` does in the backend: the whole
 * product has to run end to end with zero keys. A build pointed at the mock API
 * still puts a real gate in front of the dashboard, still refuses a wrong
 * password, and still resolves a session to exactly one company — because
 * "which tenant am I?" is answered by *signing in*, not by a constant.
 *
 * Two things it is careful not to fake:
 *
 *   - **Signing up creates an empty company.** Not a copy of the fixtures.
 *     A new tenant with no deals, no sellers and no connected rails is what
 *     `POST /account/signup` produces against the real backend, and a demo that
 *     handed over someone else's data would be teaching the wrong lesson about
 *     tenant isolation.
 *   - **Only `account.created` is audited.** The real backend cannot audit a
 *     sign-in — GoTrue handles it and never tells us — so neither does this.
 */

import { findAccount, makeAccount, normalizeEmail } from '@/api/mock/accounts'
import { seedDb } from '@/api/mock/seed'
import {
  audit,
  loadDb,
  mutate,
  nextId,
  nowIso,
  type MockAccount,
  type MockDb,
} from '@/api/mock/store'
import type { Tenant, TenantSettings } from '@/api/types'
import { slugify } from '@/lib/slug'
import { verifyPassword } from './password'
import {
  AuthError,
  MIN_PASSWORD_LENGTH,
  type AuthAccount,
  type AuthBackend,
  type SignUpInput,
} from './types'

/**
 * The session, kept out of `MockDb` on purpose: resetting the fixtures is a
 * data operation, and it should not be able to leave a session pointing at an
 * account that no longer exists. `restore` treats that as signed out anyway.
 */
const SESSION_KEY = 'payhold.session.v1'

/** Enough to reject a typo, not enough to argue with a valid address. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * What a company gets on day one.
 *
 * The real backend stores nothing at signup — a tenant with no `settings` rows
 * behaves as the documented defaults, and an empty `currencies` list means "no
 * restriction recorded". The mock's engine requires an explicit row and an
 * explicit list, so these are the same defaults written down.
 */
function defaultSettings(tenantId: string): TenantSettings {
  return {
    tenant_id: tenantId,
    service_fee_rate: 0.1,
    buyer_fee: 0,
    // §6.1 / §29.7 — 14 calendar days, matching the published marketplace
    // standard. V1 defaulted to 7. The backend's `setting_num` default moved
    // with it; a tenant that has chosen its own value is unaffected, and so is
    // every in-flight deal (§27).
    clearance_days: 14,
    auto_release_days: 3,
    currencies: ['RWF', 'USD', 'KES'],
    ai_enabled: true,
    ai_monthly_budget_usd: 25_00,
    risk_rules_enabled: true,
    risk_review_threshold_usd: 1_000_00,
  }
}

/** Unique across tenants, the way the `tenants.slug` index requires. */
function uniqueSlug(db: MockDb, name: string): string {
  const base = slugify(name)
  let slug = base
  let n = 2
  while (db.tenants.some((t) => t.slug === slug)) {
    slug = `${base}-${n}`
    n += 1
  }
  return slug
}

function toAuthAccount(db: MockDb, account: MockAccount): AuthAccount {
  const tenant = db.tenants.find((t) => t.id === account.tenant_id)
  return {
    id: account.id,
    email: account.email,
    ...(account.full_name ? { full_name: account.full_name } : {}),
    tenant_id: account.tenant_id,
    tenant_name: tenant?.name ?? 'Unknown company',
    role: account.role,
  }
}

export class MockAuthBackend implements AuthBackend {
  readonly simulated = true

  constructor() {
    loadDb(seedDb)
  }

  async restore(): Promise<AuthAccount | null> {
    const id = readSession()
    if (!id) return null

    const db = loadDb(seedDb)
    const account = db.accounts.find((a) => a.id === id)

    // The fixtures were reset under the session, or the storage was edited.
    // Either way there is nobody to be.
    if (!account) {
      writeSession(null)
      return null
    }

    // A reload has to land on the same company the session belongs to, not on
    // whichever tenant the store happened to be saved with.
    mutate((d) => {
      d.current_tenant_id = account.tenant_id
    })

    return toAuthAccount(db, account)
  }

  async signIn(email: string, password: string): Promise<AuthAccount> {
    const db = loadDb(seedDb)
    const account = findAccount(db, email)

    // One message for "no such account" and for "wrong password". Telling them
    // apart tells anyone who asks which addresses have accounts here.
    if (!account || !verifyPassword(password, account.password_salt, account.password_hash)) {
      throw new AuthError('That email and password do not match an account')
    }

    mutate((d) => {
      d.current_tenant_id = account.tenant_id
      const stored = d.accounts.find((a) => a.id === account.id)
      if (stored) stored.last_seen_at = nowIso()
    })

    writeSession(account.id)
    return toAuthAccount(db, account)
  }

  async signUp(input: SignUpInput): Promise<AuthAccount> {
    const db = loadDb(seedDb)
    const email = normalizeEmail(input.email)
    const companyName = input.company_name.trim()

    if (!EMAIL_RE.test(email)) {
      throw new AuthError('That does not look like an email address')
    }
    if (companyName.length < 2) {
      throw new AuthError('Company name is too short')
    }
    if (input.password.length < MIN_PASSWORD_LENGTH) {
      throw new AuthError(
        `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
      )
    }
    if (findAccount(db, email)) {
      throw new AuthError('An account with that email already exists — sign in instead')
    }

    const account = mutate((d) => {
      const createdAt = nowIso()

      const tenant: Tenant = {
        id: nextId('ten'),
        name: companyName,
        slug: uniqueSlug(d, companyName),
        status: 'active',
        created_at: createdAt,
      }
      d.tenants.push(tenant)
      d.settings.push(defaultSettings(tenant.id))

      // The first person in is the owner: someone has to be able to connect
      // the payment rails and approve a held payout, and there is nobody else.
      const created = makeAccount(
        nextId('acct'),
        email,
        input.password,
        tenant.id,
        createdAt,
        input.full_name?.trim(),
      )
      d.accounts.push(created)

      audit(d, tenant.id, null, `user:${email}`, 'account.created', {
        company_name: tenant.name,
        slug: tenant.slug,
        role: 'owner',
      })

      d.current_tenant_id = tenant.id
      return created
    })

    writeSession(account.id)
    return toAuthAccount(loadDb(seedDb), account)
  }

  async signOut(): Promise<void> {
    writeSession(null)
  }

  /** There is no backend to authenticate to. See `AuthBackend.accessToken`. */
  async accessToken(): Promise<string | null> {
    return null
  }
}

// ---------------------------------------------------------------------------
// Session storage
// ---------------------------------------------------------------------------

function readSession(): string | null {
  try {
    return localStorage.getItem(SESSION_KEY)
  } catch {
    return null
  }
}

function writeSession(id: string | null): void {
  try {
    if (id === null) localStorage.removeItem(SESSION_KEY)
    else localStorage.setItem(SESSION_KEY, id)
  } catch {
    // Private mode: the session lives as long as the tab does, which is the
    // same failure the mock store already accepts for its own writes.
  }
}
