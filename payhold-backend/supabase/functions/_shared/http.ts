/**
 * Request and response shaping, shared by every Edge Function.
 *
 * Two rules the spec makes that show up here:
 *
 *   §4  "all responses exclude other tenants' existence entirely" — so a row
 *       belonging to another tenant is a 404, never a 403. A 403 confirms the
 *       resource exists, which is exactly the leak the rule forbids.
 *   §6  CORS: the dashboard origin only, everywhere a credential is read. The
 *       API itself is origin-free but key-authenticated, so a browser is not
 *       the caller we design for — with one deliberate exception below.
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

/**
 * `/checkout/public/:token/*` — the buyer's own routes, and the only ones any
 * origin may call.
 *
 * An allowlist cannot work here and the reason is structural rather than a
 * convenience. These routes exist so a *client's* checkout can run in the
 * client's own page, and PayHold does not know that page's origin: AutoHire
 * serves from `autohire.pages.dev` today and could serve from anywhere
 * tomorrow, and every tenant added later brings another origin nobody has told
 * us about. Naming them in `DASHBOARD_ORIGIN` makes each new tenant a PayHold
 * redeploy — the same one-tenant exception `frame-ancestors` already is, and
 * the reason the hosted page cannot be embedded today.
 *
 * What makes the wildcard safe is that these routes read no ambient authority.
 * The session token in the path is the whole credential; there is no cookie, no
 * `Authorization` header and no API key in play, so a hostile page calling this
 * can only reach a payment it already holds the token for — and if it holds the
 * token it could equally well have opened the hosted page. CORS is protecting
 * nothing here that the token is not already protecting better.
 *
 * Credentials are explicitly NOT allowed (no `Allow-Credentials`), so the
 * wildcard cannot be widened into a session-riding request later.
 */
function isPublicBuyerRoute(req: Request): boolean {
  const segments = new URL(req.url).pathname.split('/').filter(Boolean)
  const base = segments.indexOf('checkout')
  return base !== -1 && segments[base + 1] === 'public'
}

export function corsHeaders(req: Request): Record<string, string> {
  const headers = {
    'Access-Control-Allow-Headers':
      'authorization, x-api-key, content-type, x-client-info, apikey',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  }

  if (isPublicBuyerRoute(req)) {
    // No `Vary: Origin` — the answer is the same for every origin, so varying
    // on it would only stop a cache from ever serving twice.
    return { ...headers, 'Access-Control-Allow-Origin': '*' }
  }

  const origin = req.headers.get('origin')
  if (!origin || !allowedOrigins().includes(origin)) return {}

  return {
    ...headers,
    'Access-Control-Allow-Origin': origin,
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
