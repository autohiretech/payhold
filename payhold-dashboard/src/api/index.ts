/**
 * The one line that used to swap mock for real. There is nothing to swap now.
 *
 * `HttpClient` is the only implementation of `PayHoldClient`, and it talks to
 * the Edge Functions in `payhold-backend`. The in-browser mock that stood in
 * for them — a full state machine over localStorage — is deleted, along with
 * the flags that chose between them and the dev panel that drove it.
 *
 * Where the backend is comes from `@/config`, which throws when it is unset
 * rather than falling back to a simulation. A misconfigured deploy that
 * rendered invented numbers was indistinguishable from a demo build, and the
 * demo build was the thing worth losing.
 */

import { auth } from '@/auth'
import { SUPABASE_ANON_KEY, SUPABASE_URL } from '@/config'
import type { PayHoldClient } from './client'
import { HttpClient } from './http'

export const api: PayHoldClient = new HttpClient(
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  auth,
)

export * from './client'
export * from './types'
