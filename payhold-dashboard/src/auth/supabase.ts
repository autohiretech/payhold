/**
 * Sign-in against the real thing: Supabase Auth for the credential, the
 * `account` Edge Function for what a credential means here.
 *
 * Written against the HTTP endpoints rather than `@supabase/supabase-js`. Two
 * reasons, in order of how much they matter:
 *
 *   1. The dashboard holds no secrets and has **no direct database access**.
 *      Pulling in the client library puts a configured Postgres client on the
 *      page, one `.from('deals')` away from bypassing the API the whole design
 *      routes through. What is needed here is three POSTs.
 *   2. It is ~60 lines and no dependency.
 *
 * The anon key is not a credential. It identifies the project to the auth
 * server and nothing more — every real check is the JWT, or the API key a
 * client's server holds. It is in the built bundle because it is meant to be.
 *
 * **Two halves of the session, deliberately:**
 *
 *   the token   Supabase Auth's. Proves an email and password matched.
 *   the account `/account/me`. Proves that user is linked to a company, and
 *               says which one and in what role.
 *
 * A user who authenticates but has no `tenant_users` row is not a PayHold user,
 * so a failed `/me` signs the session straight back out rather than leaving
 * someone inside a dashboard with no tenant to fill it.
 */

import {
  AuthError,
  type AuthAccount,
  type AuthBackend,
  type SignUpInput,
} from './types'

const STORAGE_KEY = 'payhold.auth.v1'

/** Refresh this far before expiry, so a request in flight cannot age out. */
const REFRESH_MARGIN_SECONDS = 60

interface StoredSession {
  access_token: string
  refresh_token: string
  /** Unix seconds. */
  expires_at: number
}

interface TokenResponse {
  access_token: string
  refresh_token: string
  expires_in: number
  user: { id: string; email?: string; user_metadata?: { full_name?: string } }
}

export class SupabaseAuthBackend implements AuthBackend {
  readonly simulated = false

  #url: string
  #anonKey: string
  #session: StoredSession | null = null

  constructor(url: string, anonKey: string) {
    this.#url = url.replace(/\/+$/, '')
    this.#anonKey = anonKey
    this.#session = readStored()
  }

  async restore(): Promise<AuthAccount | null> {
    if (!this.#session) return null

    try {
      const token = await this.accessToken()
      if (!token) return null
      return await this.#loadAccount(token)
    } catch {
      // An expired refresh token, a revoked user, a tenant link that has been
      // removed. All of them mean the same thing to the person at the screen.
      await this.signOut()
      return null
    }
  }

  async signIn(email: string, password: string): Promise<AuthAccount> {
    const res = await fetch(`${this.#url}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: this.#anonKey, 'content-type': 'application/json' },
      body: JSON.stringify({ email: email.trim().toLowerCase(), password }),
    })

    if (!res.ok) {
      // GoTrue distinguishes "no such user" from "wrong password" in some
      // configurations. The dashboard does not repeat that.
      throw new AuthError('That email and password do not match an account')
    }

    const token = (await res.json()) as TokenResponse
    this.#store(token)

    try {
      return await this.#loadAccount(token.access_token)
    } catch (err) {
      // Authenticated but not linked to a company: hold nothing.
      await this.signOut()
      throw err
    }
  }

  async signUp(input: SignUpInput): Promise<AuthAccount> {
    const res = await fetch(`${this.#url}/functions/v1/account/signup`, {
      method: 'POST',
      headers: { apikey: this.#anonKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        company_name: input.company_name.trim(),
        email: input.email.trim().toLowerCase(),
        password: input.password,
        ...(input.full_name ? { full_name: input.full_name.trim() } : {}),
      }),
    })

    if (!res.ok) {
      throw new AuthError(await errorMessage(res, 'Could not create the account'))
    }

    // Signing up does not mint a session — the backend creates the user, it
    // does not hold their password afterwards. So sign in the ordinary way,
    // which also proves the credential they just chose actually works.
    return await this.signIn(input.email, input.password)
  }

  async signOut(): Promise<void> {
    const session = this.#session
    this.#session = null
    writeStored(null)

    if (!session) return

    // Best effort: revoke the refresh token server-side. A failure here means
    // a token that expires on its own schedule, not a session still open in
    // this browser.
    try {
      await fetch(`${this.#url}/auth/v1/logout`, {
        method: 'POST',
        headers: {
          apikey: this.#anonKey,
          authorization: `Bearer ${session.access_token}`,
        },
      })
    } catch {
      // Offline. Nothing to do and nothing to tell the person.
    }
  }

  async accessToken(): Promise<string | null> {
    const session = this.#session
    if (!session) return null

    const secondsLeft = session.expires_at - Math.floor(Date.now() / 1000)
    if (secondsLeft > REFRESH_MARGIN_SECONDS) return session.access_token

    const res = await fetch(`${this.#url}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { apikey: this.#anonKey, 'content-type': 'application/json' },
      body: JSON.stringify({ refresh_token: session.refresh_token }),
    })

    if (!res.ok) {
      this.#session = null
      writeStored(null)
      return null
    }

    const token = (await res.json()) as TokenResponse
    this.#store(token)
    return token.access_token
  }

  /** `GET /account/me` — the half of the session that is ours rather than GoTrue's. */
  async #loadAccount(token: string): Promise<AuthAccount> {
    const res = await fetch(`${this.#url}/functions/v1/account/me`, {
      headers: { apikey: this.#anonKey, authorization: `Bearer ${token}` },
    })

    if (!res.ok) {
      throw new AuthError(
        await errorMessage(res, 'This account is not linked to a company'),
      )
    }

    const body = (await res.json()) as {
      user: { id?: string; email: string; full_name?: string }
      tenant: { id: string; name: string }
      role: AuthAccount['role']
    }

    return {
      id: body.user.id ?? body.user.email,
      email: body.user.email,
      ...(body.user.full_name ? { full_name: body.user.full_name } : {}),
      tenant_id: body.tenant.id,
      tenant_name: body.tenant.name,
      role: body.role,
    }
  }

  #store(token: TokenResponse): void {
    this.#session = {
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      expires_at: Math.floor(Date.now() / 1000) + token.expires_in,
    }
    writeStored(this.#session)
  }
}

/** The API's error shape is `{ error: { code, message } }` — show the message. */
async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string } }
    return body.error?.message ?? fallback
  } catch {
    return fallback
  }
}

function readStored(): StoredSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as StoredSession) : null
  } catch {
    return null
  }
}

function writeStored(session: StoredSession | null): void {
  try {
    if (session === null) localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(session))
  } catch {
    // Private mode. The session lasts as long as the tab.
  }
}
