/**
 * The launch checklist — §16, §15 phase 8.
 *
 *   GET  /launch                     every item and its current state
 *   POST /launch/:code/sign-off      record that one is done, or withdraw it
 *
 * §16 is the list of things that must be true before PayHold takes live money,
 * and the gate it feeds is in `functions/provider-accounts/`: live credentials
 * are refused while a required item is outstanding. This function is how the
 * list is read and how an item stops being outstanding.
 *
 * **PayHold staff only, and never an API key.** The items are about the
 * platform — our legal entity, our provider contracts, our incident-response
 * plan — so a tenant `owner`, however senior inside their own company, is not
 * the person who signs them. `platformAdminFromJwt` is the separate axis, and
 * it refuses a key outright for the same reason `/sellers/:id/verify` does: a
 * key is a server credential and an attestation is a person's.
 *
 * There is no create, no delete and no edit. The items are seeded by migration
 * `20260807000015` and changed by migration, because a checklist whose rows can
 * be removed by whoever finds them inconvenient is not a checklist. The one
 * mutation is a sign-off, and that is an append.
 */

import { platformAdminFromJwt, serviceClient } from '../_shared/auth.ts'
import { handler, json, readJson, required } from '../_shared/http.ts'
import { PayHoldError } from '../_shared/types.ts'
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'

interface SignOffBody {
  evidence: string
  /** Omitted means signing. `false` withdraws a sign-off already given. */
  signed?: boolean
}

async function readChecklist(
  req: Request,
  db: SupabaseClient,
): Promise<Response> {
  const { data, error } = await db.rpc('launch_status')
  if (error) {
    throw new PayHoldError('not_found', 'Could not read the launch checklist')
  }

  const items = (data ?? []) as {
    code: string
    required: boolean
    signed: boolean
    blocked_by: string | null
  }[]

  const outstanding = items.filter((i) => i.required && !i.signed)

  return json(req, {
    // The gate itself, first, because it is the question being asked. Derived
    // from the same rows rather than fetched separately — two round trips that
    // could disagree would be two answers to one question.
    live_mode_allowed: outstanding.length === 0,
    outstanding: outstanding.length,
    // Of the outstanding items, how many nobody *can* sign yet. The difference
    // between "we are waiting on a lawyer" and "we are waiting on a build" is
    // the first thing anyone reading this page wants.
    blocked: outstanding.filter((i) => i.blocked_by !== null).length,
    items,
  })
}

async function signOff(
  req: Request,
  db: SupabaseClient,
  code: string,
  actor: string,
): Promise<Response> {
  const body = await readJson<SignOffBody>(req)
  required(body as unknown as Record<string, unknown>, 'evidence')

  const signed = body.signed !== false

  // The actor comes from the session, never from the body. A caller who can
  // name their own approver can forge one — the same rule `ai-decisions`
  // follows for the same reason.
  const { error } = await db.rpc('sign_off_launch_item', {
    p_code: code,
    p_actor: actor,
    p_evidence: body.evidence,
    p_signed: signed,
  })

  if (error) {
    // The function raises `not_found:` for an unknown code and
    // `policy_violation:` for a blocked item, and both messages are written to
    // be read by the person holding the pen.
    const message = error.message ?? 'Could not record that sign-off'
    throw new PayHoldError(
      message.startsWith('not_found') ? 'not_found' : 'policy_violation',
      message.replace(/^(not_found|policy_violation):\s*/, ''),
    )
  }

  return await readChecklist(req, db)
}

Deno.serve(handler(async (req) => {
  const db = serviceClient()
  const admin = await platformAdminFromJwt(db, req)

  // Supabase serves this at /functions/v1/launch/…, so the segments after the
  // function name are the route — same shape as `deals` and `sellers`.
  const segments = new URL(req.url).pathname.split('/').filter(Boolean)
  const base = segments.indexOf('launch')
  const code = segments[base + 1]
  const action = segments[base + 2]

  if (req.method === 'GET' && !code) {
    return await readChecklist(req, db)
  }

  if (req.method === 'POST' && code && action === 'sign-off') {
    return await signOff(req, db, code, admin.actor)
  }

  throw new PayHoldError('not_found', `No such route`)
}))
