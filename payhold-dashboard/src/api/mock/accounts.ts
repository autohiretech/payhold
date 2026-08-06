/**
 * Making and finding a `MockAccount`.
 *
 * Its own module because both sides need it and neither may import the other:
 * `seed.ts` builds one owner per fixture company, and `@/auth/mock` builds one
 * per signup. Putting the constructor in either would put a cycle between them.
 */

import { hashPassword, newSalt } from '@/auth/password'
import type { MockAccount, MockDb } from './store'

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

export function findAccount(db: MockDb, email: string): MockAccount | undefined {
  const wanted = normalizeEmail(email)
  return db.accounts.find((a) => a.email === wanted)
}

/**
 * A new owner of an existing tenant.
 *
 * Owner because both callers create the *first* person in a company: someone
 * has to be able to connect the payment rails and clear a payout a rule held,
 * and there is nobody else yet. Second and later members arrive by invitation,
 * which is a backend feature and not a mock one.
 */
export function makeAccount(
  id: string,
  email: string,
  password: string,
  tenantId: string,
  createdAt: string,
  fullName?: string,
): MockAccount {
  const salt = newSalt()
  return {
    id,
    email: normalizeEmail(email),
    ...(fullName ? { full_name: fullName } : {}),
    password_hash: hashPassword(password, salt),
    password_salt: salt,
    tenant_id: tenantId,
    role: 'owner',
    created_at: createdAt,
    last_seen_at: null,
  }
}
