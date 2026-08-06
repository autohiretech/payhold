/**
 * The first slice of `HttpClient` — Intelligence against the real backend.
 *
 * `PayHoldClient` is one interface with, today, one implementation. This is a
 * **decorator**: it takes a client (the mock) and overrides the eight AI
 * methods with calls to the real Edge Functions, leaving everything else
 * untouched. When the remaining slices land they replace the wrapped client and
 * this file stops being a decorator without changing its methods.
 *
 * Why the AI half first: it is the part of the product whose output cannot be
 * simulated convincingly. A fake ledger entry and a real one look identical on
 * screen; a real model's reading of a dispute and `ai.ts`'s deterministic
 * stand-in do not, and the difference is the whole reason for §12.
 *
 * **This is opt-in, and the reason matters.** Pointed at a backend that does
 * not hold this tenant's deals, every call 404s — the mock's `dsp_0007` is not
 * a row in anybody's Postgres. So it is gated behind its own flag rather than
 * riding on the Supabase environment: turning it on is a statement that the
 * backend has your data, which is not something the dashboard can check for
 * you. Default off keeps the demo build honest.
 *
 * What it never does is carry a secret. Every call goes out with the session's
 * bearer token and nothing else; the model key lives in Supabase's function
 * secrets, and the browser could not reach Claude if it wanted to.
 */

import type { AuthBackend } from '@/auth'
import type { PayHoldClient } from './client'
import {
  PayHoldError,
  type AiChatMessage,
  type AiDecision,
  type AiSuggestion,
  type AiUsage,
  type DealOutcome,
} from './types'

/**
 * Map an Edge Function's error envelope back onto the error type every screen
 * already handles. `{ error: { code, message } }` is the shape `http.ts`
 * returns for every failure, so the codes line up with `PayHoldError`'s.
 */
async function toError(response: Response): Promise<PayHoldError> {
  let code = 'policy_violation'
  let message = `Request failed (${response.status})`

  try {
    const body = await response.json()
    if (body?.error?.code) code = body.error.code
    if (body?.error?.message) message = body.error.message
  } catch {
    // A non-JSON body means something upstream of the function answered — a
    // gateway, a cold start that timed out. The status is all there is to say.
  }

  return new PayHoldError(code as PayHoldError['code'], message)
}

export class AiHttpClient implements PayHoldClient {
  #base: string
  #auth: AuthBackend

  constructor(base: string, auth: AuthBackend, inner: PayHoldClient) {
    // Supabase serves functions from `<project>/functions/v1/<name>`.
    this.#base = `${base.replace(/\/+$/, '')}/functions/v1`
    this.#auth = auth

    // Everything this class does not override falls through to the wrapped
    // client — including `admin`, and including `sim`, so `isSimulated(api)`
    // still finds the dev panel's levers. Those levers still drive the mock,
    // which is exactly right: the ledger under this composition is the mock's.
    return new Proxy(this, {
      get: (target, prop, receiver) => {
        if (Reflect.has(target, prop)) return Reflect.get(target, prop, receiver)
        const inherited = Reflect.get(inner as object, prop)
        return typeof inherited === 'function' ? inherited.bind(inner) : inherited
      },
      has: (target, prop) => Reflect.has(target, prop) || Reflect.has(inner as object, prop),
    })
  }

  async #call<T>(path: string, init?: RequestInit): Promise<T> {
    const token = await this.#auth.accessToken()
    if (!token) {
      throw new PayHoldError('unauthorized', 'Your session has expired. Sign in again.')
    }

    const response = await fetch(`${this.#base}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        ...init?.headers,
      },
    })

    if (!response.ok) throw await toError(response)
    return await response.json() as T
  }

  #post<T>(path: string, body: unknown): Promise<T> {
    return this.#call<T>(path, { method: 'POST', body: JSON.stringify(body) })
  }

  // -- Intelligence ---------------------------------------------------------

  async listAiSuggestions(dealId?: string): Promise<AiSuggestion[]> {
    const query = dealId ? `?deal_id=${encodeURIComponent(dealId)}` : ''
    const { suggestions } = await this.#call<{ suggestions: AiSuggestion[] }>(
      `/ai-decisions${query}`,
    )
    return suggestions
  }

  async draftDisputeSuggestion(disputeId: string): Promise<AiSuggestion> {
    const { suggestion } = await this.#post<{ suggestion: AiSuggestion }>(
      '/ai-dispute',
      { dispute_id: disputeId },
    )
    return suggestion
  }

  async draftRiskSummary(dealId: string): Promise<AiSuggestion> {
    const { suggestion } = await this.#post<{ suggestion: AiSuggestion }>(
      '/ai-risk-narrator',
      { deal_id: dealId },
    )
    return suggestion
  }

  /**
   * `decidedBy` is deliberately not sent.
   *
   * The screen passes it because the mock needs to be told who is acting; the
   * real endpoint takes it from the session instead. A client that can name its
   * own approver can forge an approval, and the audit row here is the record of
   * a person's decision — so the one place it may come from is the token that
   * proves who they are.
   */
  async decideAiSuggestion(
    id: string,
    decision: AiDecision,
    _decidedBy: string,
  ): Promise<AiSuggestion> {
    const { suggestion } = await this.#post<{ suggestion: AiSuggestion }>(
      '/ai-decisions',
      { suggestion_id: id, decision },
    )
    return suggestion
  }

  async askAssistant(question: string): Promise<AiChatMessage> {
    const { message } = await this.#post<{ message: AiChatMessage }>(
      '/ai-support',
      { question },
    )
    return message
  }

  async listAiChat(): Promise<AiChatMessage[]> {
    const { messages } = await this.#call<{ messages: AiChatMessage[] }>('/ai-support')
    return messages
  }

  async listDealOutcomes(): Promise<DealOutcome[]> {
    const { outcomes } = await this.#call<{ outcomes: DealOutcome[] }>(
      '/ai-decisions?outcomes=1',
    )
    return outcomes
  }

  async getAiUsage(): Promise<AiUsage> {
    const { usage } = await this.#call<{ usage: AiUsage }>('/ai-decisions?usage=1')
    return usage
  }
}

/*
 * The remaining methods of `PayHoldClient` are served by the wrapped client via
 * the proxy in the constructor. Declaring them here as pass-throughs would be
 * forty lines saying nothing, and each one would be a line to delete when its
 * real slice lands.
 */
export interface AiHttpClient extends PayHoldClient {}
