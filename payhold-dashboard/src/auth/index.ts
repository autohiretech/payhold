/**
 * Sessions, and there is only one kind of them now.
 *
 * `SupabaseAuthBackend` is the whole of it: the dashboard exchanges the
 * password with Supabase Auth directly and holds the JWT, and every API call
 * carries it. The simulated sign-in that used to sit behind an environment
 * check is gone with the mock API it belonged to — a session is either real or
 * it is theatre, and theatre in front of a login is the wrong thing to
 * practise on.
 *
 * Where the project is comes from `@/config`, which both seams read and which
 * throws when it is unset. One check rather than two, because a real session in
 * front of an unreachable backend is as broken as no session at all.
 */

import { SUPABASE_ANON_KEY, SUPABASE_URL } from '@/config'
import { SupabaseAuthBackend } from './supabase'
import type { AuthBackend } from './types'

export const auth: AuthBackend = new SupabaseAuthBackend(
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
)

export * from './types'
