/**
 * The second seam.
 *
 * `src/api/` is where the dashboard talks about deals; this is where it talks
 * about who is asking. They are deliberately separate: the API contract is the
 * public v1 one every client codes against, and signing in is a dashboard
 * concern that no API client has.
 *
 * The shape mirrors `PayHoldClient` — one interface, two implementations, one
 * line in `index.ts` that picks between them:
 *
 *   `MockAuthBackend`      accounts simulated in the browser, for the build
 *                          that runs against the mock API
 *   `SupabaseAuthBackend`  real Supabase Auth, and the `account` Edge Function
 *                          for the half a browser is not allowed to write
 *
 * Both must land together with `HttpClient`: an app holding a real session and
 * a simulated ledger would be lying about which one it is.
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

export interface SignUpInput {
  company_name: string
  email: string
  password: string
  full_name?: string
}

export interface AuthBackend {
  /**
   * True when accounts here are a browser simulation rather than real ones.
   * The sign-in screen says so out loud — a page that asks for a password
   * without saying where it goes has told the person something false.
   */
  readonly simulated: boolean

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
