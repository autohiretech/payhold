/**
 * Where a payment was made from — the capture half of spec §6.
 *
 * Three sources reach this module and they are not equally believable, which
 * is why `source` is stored on every row rather than flattened away:
 *
 *   provider          Flutterwave or Stripe reported it on the charge. Their
 *                     observation, tied to a verified transaction.
 *   hosted_page       our own /pay/:id page saw the connection.
 *   client_attested   the client's server passed `buyer_ip`. Unverifiable —
 *                     a compromised integration can send anything.
 *
 * Two rules this file exists to keep:
 *
 *   1. **Recording never fails a payment.** Every function here swallows its
 *      own errors. A buyer whose money reached the provider must not see a 500
 *      because a telemetry insert had a bad day, and a charge that succeeded
 *      with no context row is a gap in a report rather than a lost payment.
 *   2. **An unparseable address is dropped, not stored.** `inet` would reject
 *      it at the column and take the whole row with it, including the event and
 *      the user agent, which are still worth having.
 */

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'

export type ContextSource = 'provider' | 'hosted_page' | 'client_attested'

/** What was happening when the address was seen. */
export type ContextEvent = 'pay_started' | 'charge_confirmed' | 'confirmation'

/**
 * The caller's address, as far as the edge can tell.
 *
 * Supabase terminates TLS in front of the function, so the socket peer is
 * always theirs — `x-forwarded-for` is the only thing that carries the client.
 * The **leftmost** entry is the original client and every hop after it is a
 * proxy, so that is the one taken.
 *
 * Worth being honest about what this is worth: `x-forwarded-for` is a header,
 * and a header can be set by whoever sent the request. It is trustworthy when
 * the connection came straight from a browser to our own hosted page, and it is
 * a claim when a client's server called us. That distinction is exactly what
 * `source` records, and it is why nothing here decides anything.
 */
export function clientIp(req: Request): string | null {
  const forwarded = req.headers.get('x-forwarded-for')
  if (!forwarded) return null

  const first = forwarded.split(',')[0]?.trim()
  return first ? normaliseIp(first) : null
}

/**
 * Accept an address only if Postgres would.
 *
 * Deliberately conservative — this is the front of a fraud report, and a
 * half-parsed string that lands in the column is worse than an absent one.
 * Ports are stripped (`1.2.3.4:5678` and the bracketed v6 form both appear in
 * the wild); anything else that does not look like an address is dropped.
 */
export function normaliseIp(raw: string): string | null {
  let value = raw.trim()
  if (!value) return null

  // [2001:db8::1]:443 — bracketed v6 with a port.
  const bracketed = value.match(/^\[([0-9a-fA-F:.]+)\](?::\d+)?$/)
  if (bracketed) value = bracketed[1]

  // 1.2.3.4:5678 — v4 with a port. A bare v6 also contains colons, so this only
  // strips one when what precedes it is a complete dotted quad.
  const withPort = value.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/)
  if (withPort) value = withPort[1]

  const v4 = value.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) {
    return v4.slice(1).every((octet) => Number(octet) <= 255) ? value : null
  }

  // v6, including the ::-compressed and v4-mapped forms. Length-bounded so a
  // pathological header cannot make this expensive.
  if (value.length <= 45 && /^[0-9a-fA-F:]+(\.\d{1,3}){0,3}$/.test(value) && value.includes(':')) {
    return value
  }

  return null
}

export interface ContextRecord {
  deal_id: string
  source: ContextSource
  event: ContextEvent
  ip?: string | null
  /** Provider-reported only. Nothing here infers a country from an address. */
  ip_country?: string | null
  user_agent?: string | null
}

/**
 * File one observation against a deal.
 *
 * The tenant is not a parameter: `record_request_context` derives it from the
 * deal, so a caller cannot file a buyer's address under the wrong account.
 */
export async function recordContext(
  db: SupabaseClient,
  record: ContextRecord,
): Promise<void> {
  try {
    await db.rpc('record_request_context', {
      p_deal_id: record.deal_id,
      p_source: record.source,
      p_event: record.event,
      p_ip: record.ip ?? null,
      p_ip_country: record.ip_country?.toUpperCase() ?? null,
      p_user_agent: record.user_agent ?? null,
    })
  } catch (err) {
    // Logged and swallowed — see the header. This runs beside a payment.
    console.error('request context not recorded', {
      deal_id: record.deal_id,
      event: record.event,
      message: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * What the client told us about the buyer, from a `/pay` request.
 *
 * Returns the attested address separately from the observed one because they
 * are different claims and get different `source` values. A client's server
 * calling us produces an observed address that is *their* server — which is
 * worth recording anyway, since a charge suddenly starting from a new hosting
 * provider is itself a thing an operator would want to see.
 */
export function payContext(
  req: Request,
  body: { buyer_ip?: string },
): { observed: string | null; attested: string | null; userAgent: string | null } {
  return {
    observed: clientIp(req),
    attested: body.buyer_ip ? normaliseIp(body.buyer_ip) : null,
    userAgent: req.headers.get('user-agent'),
  }
}
