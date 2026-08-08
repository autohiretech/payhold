/**
 * The second seam.
 *
 * `src/api/` is where the dashboard talks about deals; this is where it talks
 * about who is asking. They are deliberately separate: the API contract is the
 * public v1 one every client codes against, and signing in is a dashboard
 * concern that no API client has.
 *
 * One interface, one implementation — `SupabaseAuthBackend`, real Supabase Auth
 * plus the `account` Edge Function for the half a browser is not allowed to
 * write. The simulated backend that used to sit beside it went with the mock
 * API it belonged to.
 */

/** What a person is allowed to do inside their company. Mirrors `tenant_role`. */
export type TenantRole = 'owner' | 'staff' | 'viewer'

/**
 * Pinned to `MIN_PASSWORD_LENGTH` in the backend's `account` function and to
 * `minimum_password_length` in `config.toml`. Checked here so the refusal
 * happens next to the field rather than after a round trip — never *instead*
 * of there, since a browser check is a courtesy and not a control.
 */
export const MIN_PASSWORD_LENGTH = 12

/**
 * A signed-in person, resolved to exactly one company.
 *
 * There is no "account with no tenant" state. A Supabase Auth user that is not
 * in `tenant_users` is not a PayHold user, and the backend's `/account/me`
 * refuses it rather than returning a session with nothing in it.
 */
export interface AuthAccount {
  id: string
  email: string
  full_name?: string
  tenant_id: string
  tenant_name: string
  role: TenantRole
}

/**
 * The string the backend records for this session — `user:<email>`, exactly as
 * `resolveCaller` builds it for `audit_log.actor`.
 *
 * Screens display a person's name; this is for comparing against an actor that
 * was **recorded**, and §8's conflict-of-interest control is the case that
 * matters. An operator who already spoke for a side cannot decide the dispute,
 * and the screen has to say so before they reach for the button — comparing a
 * display name against a stored actor would quietly never match, and the
 * warning would simply never appear.
 */
export function actorId(account: AuthAccount | null): string {
  return account?.email ? `user:${account.email}` : ''
}

export interface SignUpInput {
  company_name: string
  email: string
  password: string
  full_name?: string
}

export interface AuthBackend {
  /** The session left over from last time, if it is still good. */
  restore(): Promise<AuthAccount | null>
  signIn(email: string, password: string): Promise<AuthAccount>
  /** Creates the company and its first owner, then signs them in. */
  signUp(input: SignUpInput): Promise<AuthAccount>
  signOut(): Promise<void>
  /**
   * The bearer token for API calls, refreshed if it is about to expire.
   * `null` on the mock, which has no backend to authenticate to — which is
   * also why `HttpClient` cannot ship before the real backend does.
   */
  accessToken(): Promise<string | null>
}

/**
 * A failure a person can act on: wrong password, email already taken, company
 * name too short. Anything else is a bug and says so instead of guessing.
 */
export class AuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AuthError'
  }
}
