/**
 * Request and response shaping, shared by every Edge Function.
 *
 * Two rules the spec makes that show up here:
 *
 *   §4  "all responses exclude other tenants' existence entirely" — so a row
 *       belonging to another tenant is a 404, never a 403. A 403 confirms the
 *       resource exists, which is exactly the leak the rule forbids.
 *   §6  CORS: the dashboard origin only. The API itself is origin-free but
 *       key-authenticated, so a browser is not the caller we design for.
 */

import { ERROR_STATUS, PayHoldError, type PayHoldErrorCode } from './types.ts'

/**
 * Origins allowed to call this API from a browser.
 *
 * Set `DASHBOARD_ORIGIN` in Supabase secrets. A missing value means no browser
 * origin is permitted, which is the safe failure: server-to-server clients
 * with an API key are unaffected by CORS.
 */
function allowedOrigins(): string[] {
  return (Deno.env.get('DASHBOARD_ORIGIN') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('origin')
  if (!origin || !allowedOrigins().includes(origin)) return {}

  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers':
      'authorization, x-api-key, content-type, x-client-info, apikey',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    // Echoing a single origin means caches must vary on it, or one tenant's
    // CORS decision gets served to another origin.
    'Vary': 'Origin',
  }
}

export function json(
  req: Request,
  body: unknown,
  status = 200,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...corsHeaders(req) },
  })
}

export function preflight(req: Request): Response | null {
  if (req.method !== 'OPTIONS') return null
  return new Response(null, { status: 204, headers: corsHeaders(req) })
}

/** The wire shape of every failure. */
export function errorResponse(
  req: Request,
  code: PayHoldErrorCode,
  message: string,
): Response {
  return json(req, { error: { code, message } }, ERROR_STATUS[code])
}

/**
 * Wrap a handler so no unexpected throw ever reaches the client verbatim.
 *
 * A `PayHoldError` is intentional and its message is safe to show. Anything
 * else is a bug or a provider failure, and its message may carry a key, a
 * stack path or a provider's internal detail — so it is logged and replaced.
 */
export function handler(
  fn: (req: Request) => Promise<Response>,
): (req: Request) => Promise<Response> {
  return async (req) => {
    const pre = preflight(req)
    if (pre) return pre

    try {
      return await fn(req)
    } catch (err) {
      if (err instanceof PayHoldError) {
        return errorResponse(req, err.code, err.message)
      }

      console.error('unhandled error', {
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      })

      return json(
        req,
        { error: { code: 'internal', message: 'Something went wrong on our side.' } },
        500,
      )
    }
  }
}

/** Parse a JSON body, failing as a client error rather than a 500. */
export async function readJson<T>(req: Request): Promise<T> {
  try {
    return await req.json() as T
  } catch {
    throw new PayHoldError('policy_violation', 'Request body must be valid JSON')
  }
}

/** Require a field to be present and non-empty. */
export function required<T extends Record<string, unknown>>(
  body: T,
  ...fields: (keyof T)[]
): void {
  const missing = fields.filter((f) => {
    const v = body[f]
    return v === undefined || v === null || v === ''
  })

  if (missing.length > 0) {
    throw new PayHoldError(
      'policy_violation',
      `Missing required field${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`,
    )
  }
}
