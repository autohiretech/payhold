/**
 * The one line that swaps a simulated sign-in for a real one.
 *
 * Mirrors `src/api/index.ts`, and is governed by the same environment: when
 * `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are set, the dashboard is
 * pointed at the real backend and sessions are real. Unset, it is running
 * against `MockClient`, and the sign-in is a simulation that says so.
 *
 * The two must move together. A real session in front of a browser-side ledger
 * would be a lie about which one you are looking at, so `HttpClient` lands with
 * the same environment check and neither ships alone.
 */

import { MockAuthBackend } from './mock'
import { SupabaseAuthBackend } from './supabase'
import type { AuthBackend } from './types'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

export const auth: AuthBackend =
  url && anonKey ? new SupabaseAuthBackend(url, anonKey) : new MockAuthBackend()

export * from './types'
