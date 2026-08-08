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
import { MoneyHttpClient } from './http-money'
import { MockClient } from './mock'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY
const aiLive = import.meta.env.VITE_PAYHOLD_AI_LIVE === '1'
const moneyLive = import.meta.env.VITE_PAYHOLD_MONEY_LIVE === '1'

const mock = new MockClient()

/**
 * The slices compose innermost-first: the mock answers anything nobody has
 * replaced yet, `MoneyHttpClient` takes the deals, balances, payouts and
 * sellers, and `AiHttpClient` takes Intelligence on top.
 *
 * **Each slice has its own flag, and that is not timidity.** Turning one on is
 * a claim that the backend holds *this account's* data — the mock's `dsp_0007`
 * is not a row in anybody's Postgres — and the dashboard cannot check that for
 * you. A half-pointed build is the honest intermediate state while the cut-over
 * happens, and the alternative is one flag that has to be right about
 * everything at once.
 */
let client: PayHoldClient = mock
if (url && anonKey) {
  if (moneyLive) client = new MoneyHttpClient(url, anonKey, auth, client)
  if (aiLive) client = new AiHttpClient(url, auth, client)
}

export const api: PayHoldClient = client

export * from './client'
export * from './types'
