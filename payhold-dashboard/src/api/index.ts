/**
 * The one line that swaps mock for real — now two, because the backend is
 * arriving in slices rather than all at once.
 *
 * `MockClient` still serves the whole v1 contract. `AiHttpClient` overrides the
 * Intelligence half with the real Edge Functions when `VITE_PAYHOLD_AI_LIVE` is
 * set alongside the Supabase environment. When the remaining slices land,
 * `HttpClient` replaces `MockClient` here and the composition below collapses
 * back to the single line it was written as.
 *
 * The AI flag is separate from the Supabase pair on purpose. Real sessions and
 * a real ledger move together; real *drafts* over mock deals do not work at all
 * — the model would be asked about `dsp_0007`, which exists in this browser and
 * in no database — so switching it on is a claim that the backend holds this
 * tenant's data, and only the person deploying knows whether that is true.
 */

import { auth } from '@/auth'
import type { PayHoldClient } from './client'
import { AiHttpClient } from './http-ai'
import { MockClient } from './mock'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY
const aiLive = import.meta.env.VITE_PAYHOLD_AI_LIVE === '1'

const mock = new MockClient()

export const api: PayHoldClient = url && anonKey && aiLive
  ? new AiHttpClient(url, auth, mock)
  : mock

export * from './client'
export * from './types'
