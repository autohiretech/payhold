/**
 * The Resolution Center — spec §8.
 *
 *   POST /disputes                                   open one
 *   GET  /disputes                                   this tenant's, newest first
 *   GET  /disputes/:id                               one, with offers, evidence
 *                                                    and the timeline
 *   GET  /disputes/:id/export                        §8's communication export
 *   POST /disputes/:id/offers                        request an update, extension,
 *                                                    cancellation or refund
 *   POST /disputes/:id/offers/:offer/respond         accept or decline. 48 hours
 *   POST /disputes/:id/offers/:offer/withdraw        take a request back
 *   POST /disputes/:id/evidence                      photos, documents, check-ins
 *   POST /disputes/:id/resolve                       decide it. A person only
 *
 * **Everything except `resolve` is a party action**, and a client's server may
 * make it on a buyer's or seller's behalf with its API key — the same
 * arrangement `/deals/:id/confirm` runs under until §4's end-user tokens exist.
 *
 * `resolve` is not, and refuses a key. It is the administrator's judgement, and
 * §8 asks for a conflict-of-interest control over exactly that: a client able to
 * resolve its own disputes from its own server has turned the Resolution Center
 * into a formality, the same argument `approve-review` and `sellers/:id/verify`
 * both make. The check itself lives in `resolve_dispute`, where it runs under
 * the row lock — this function's job is to make sure a real name reaches it.
 */

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { requireRole, resolveCaller, serviceClient, type Caller } from '../_shared/auth.ts'
import { releaseFigures } from '../_shared/figures.ts'
import { handler, json } from '../_shared/http.ts'
import { PayHoldError, type ConfirmSide, type Deal } from '../_shared/types.ts'

const DISPUTE_COLUMNS =
  'id, tenant_id, deal_id, raised_by, raised_by_actor, reason, reason_code, ' +
  'disputed_amount, status, opened_at, resolved_at, resolution_note, decided_by'

const OFFER_COLUMNS =
  'id, dispute_id, deal_id, offered_by, offered_by_actor, kind, amount, ' +
  'extend_to, note, status, expires_at, created_at, responded_at, responded_by_actor'

const EVIDENCE_COLUMNS =
  'id, dispute_id, deal_id, uploaded_by, uploaded_by_actor, kind, description, ' +
  'storage_ref, captured_at, created_at'

const SIDES: ConfirmSide[] = ['buyer', 'seller']

const OFFER_KINDS = [
  'update',
  'extension',
  'cancellation',
  'partial_refund',
  'full_refund',
] as const

const REASON_CODES = [
  'not_delivered',
  'not_as_described',
  'damaged',
  'late_delivery',
  'quality',
  'incomplete',
  'unauthorized_charge',
  'duplicate_charge',
  'cancellation_requested',
  'other',
] as const

const EVIDENCE_KINDS = [
  'photo',
  'inspection_photo',
  'document',
  'message',
  'checkin',
  'other',
] as const

/** Another tenant's dispute is a 404, never a 403 — spec §4. */
async function getDispute(
  db: SupabaseClient,
  caller: Caller,
  id: string,
): Promise<Record<string, unknown>> {
  const { data } = await db
    .from('disputes')
    .select(DISPUTE_COLUMNS)
    .eq('id', id)
    .eq('tenant_id', caller.tenant_id)
    .maybeSingle()

  if (!data) throw new PayHoldError('not_found', `Dispute ${id} not found`)
  return data as unknown as Record<string, unknown>
}

function requireSide(value: unknown, field = 'side'): ConfirmSide {
  if (typeof value !== 'string' || !SIDES.includes(value as ConfirmSide)) {
    throw new PayHoldError('policy_violation', `${field} must be "buyer" or "seller"`)
  }
  return value as ConfirmSide
}

function requireOneOf<T extends readonly string[]>(
  value: unknown,
  allowed: T,
  field: string,
): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new PayHoldError(
      'policy_violation',
      `${field} must be one of: ${allowed.join(', ')}`,
    )
  }
  return value
}

/**
 * The full case, which is what §8's timeline view and the dispute assistant both
 * read. One call rather than four, because a person opening a dispute wants all
 * of it and a client that has to know to ask three more times will not.
 */
async function withCase(
  db: SupabaseClient,
  dispute: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const id = dispute.id as string

  const [{ data: offers }, { data: evidence }, { data: timeline }] = await Promise.all([
    db.from('dispute_offers').select(OFFER_COLUMNS).eq('dispute_id', id)
      .order('created_at', { ascending: true }),
    db.from('dispute_evidence').select(EVIDENCE_COLUMNS).eq('dispute_id', id)
      .order('created_at', { ascending: true }),
    db.rpc('dispute_timeline', { p_dispute_id: id }),
  ])

  const rows = (offers ?? []) as unknown as { status: string; expires_at: string }[]
  const open = rows.find((o) => o.status === 'open')

  return {
    ...dispute,
    offers: offers ?? [],
    evidence: evidence ?? [],
    timeline: timeline ?? [],
    // §8 allows one live request per order, so "the" open one is a real thing
    // rather than a list a client has to filter. Its deadline is the 48 hours.
    open_offer: open ?? null,
    responds_by: open ? open.expires_at : null,
  }
}

async function loadDeal(db: SupabaseClient, dealId: string): Promise<Deal> {
  const { data } = await db.from('deals').select('*').eq('id', dealId).maybeSingle()
  if (!data) throw new PayHoldError('not_found', `Deal ${dealId} not found`)
  return data as unknown as Deal
}

async function open(
  req: Request,
  db: SupabaseClient,
  caller: Caller,
): Promise<Response> {
  requireRole(caller, 'owner', 'staff')

  const body = await req.json().catch(() => ({})) as Record<string, unknown>

  const dealId = typeof body.deal_id === 'string' ? body.deal_id : ''
  if (!dealId) throw new PayHoldError('policy_violation', 'deal_id is required')

  const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
  if (!reason) {
    throw new PayHoldError('policy_violation', 'A dispute must say what is wrong')
  }

  // Resolved through the tenant filter first, so another tenant's deal is a 404
  // here rather than an error out of the money function.
  const { data: deal } = await db
    .from('deals')
    .select('id')
    .eq('id', dealId)
    .eq('tenant_id', caller.tenant_id)
    .maybeSingle()

  if (!deal) throw new PayHoldError('not_found', `Deal ${dealId} not found`)

  const { data, error } = await db.rpc('open_dispute', {
    p_deal_id: dealId,
    p_raised_by: requireSide(body.raised_by, 'raised_by'),
    p_reason: reason,
    p_reason_code: body.reason_code === undefined
      ? 'other'
      : requireOneOf(body.reason_code, REASON_CODES, 'reason_code'),
    p_actor: caller.actor,
    p_amount: body.disputed_amount === undefined || body.disputed_amount === null
      ? null
      : Number(body.disputed_amount),
  })

  if (error) throw rpcError(error, 'open this dispute')

  return json(req, await withCase(db, data as Record<string, unknown>), 201)
}

async function makeOffer(
  req: Request,
  db: SupabaseClient,
  caller: Caller,
  id: string,
): Promise<Response> {
  requireRole(caller, 'owner', 'staff')

  const dispute = await getDispute(db, caller, id)
  const body = await req.json().catch(() => ({})) as Record<string, unknown>

  const kind = requireOneOf(body.kind, OFFER_KINDS, 'kind')

  const { error } = await db.rpc('make_dispute_offer', {
    p_dispute_id: dispute.id,
    p_offered_by: requireSide(body.offered_by, 'offered_by'),
    p_actor: caller.actor,
    p_kind: kind,
    p_amount: kind === 'partial_refund' && body.amount !== undefined
      ? Number(body.amount)
      : null,
    p_extend_to: kind === 'extension' && typeof body.extend_to === 'string'
      ? body.extend_to
      : null,
    p_note: typeof body.note === 'string' ? body.note : null,
  })

  if (error) throw rpcError(error, 'make this request')

  return json(req, await withCase(db, await getDispute(db, caller, id)), 201)
}

/**
 * Accept or decline, within the 48 hours.
 *
 * Accepting a cancellation or a refund settles the deal, so the converted
 * figures travel with the call for the reason every money path does: FX and fees
 * are TypeScript's, and the write has to be atomic. `respond_dispute_offer`
 * calls `resolve_dispute` inside its own transaction rather than leaving this
 * function to make a second call that could fail on its own.
 */
async function respondOffer(
  req: Request,
  db: SupabaseClient,
  caller: Caller,
  id: string,
  offerId: string,
): Promise<Response> {
  requireRole(caller, 'owner', 'staff')

  const dispute = await getDispute(db, caller, id)
  const body = await req.json().catch(() => ({})) as Record<string, unknown>

  if (typeof body.accept !== 'boolean') {
    throw new PayHoldError('policy_violation', 'accept must be true or false')
  }

  const deal = await loadDeal(db, dispute.deal_id as string)
  const figures = await releaseFigures(db, deal)

  const { error } = await db.rpc('respond_dispute_offer', {
    p_offer_id: offerId,
    p_side: requireSide(body.side, 'side'),
    p_actor: caller.actor,
    p_accept: body.accept,
    ...figures,
  })

  if (error) throw rpcError(error, 'answer this request')

  return json(req, await withCase(db, await getDispute(db, caller, id)))
}

async function withdrawOffer(
  req: Request,
  db: SupabaseClient,
  caller: Caller,
  id: string,
  offerId: string,
): Promise<Response> {
  requireRole(caller, 'owner', 'staff')
  await getDispute(db, caller, id)

  const { error } = await db.rpc('withdraw_dispute_offer', {
    p_offer_id: offerId,
    p_actor: caller.actor,
  })

  if (error) throw rpcError(error, 'withdraw this request')

  return json(req, await withCase(db, await getDispute(db, caller, id)))
}

async function addEvidence(
  req: Request,
  db: SupabaseClient,
  caller: Caller,
  id: string,
): Promise<Response> {
  requireRole(caller, 'owner', 'staff')

  const dispute = await getDispute(db, caller, id)
  const body = await req.json().catch(() => ({})) as Record<string, unknown>

  const description = typeof body.description === 'string' ? body.description.trim() : ''
  if (!description) {
    throw new PayHoldError(
      'policy_violation',
      'Evidence needs a description — it is what a person and the assistant read',
    )
  }

  const { error } = await db.rpc('add_dispute_evidence', {
    p_dispute_id: dispute.id,
    p_uploaded_by: requireSide(body.uploaded_by, 'uploaded_by'),
    p_actor: caller.actor,
    p_kind: requireOneOf(body.kind, EVIDENCE_KINDS, 'kind'),
    p_description: description,
    // A reference to wherever the file lives. PayHold stores no bytes.
    p_storage_ref: typeof body.storage_ref === 'string' ? body.storage_ref : null,
    p_captured_at: typeof body.captured_at === 'string' ? body.captured_at : null,
  })

  if (error) throw rpcError(error, 'file this evidence')

  return json(req, await withCase(db, await getDispute(db, caller, id)), 201)
}

/**
 * §8's final decision record.
 *
 * A person only, and the name is taken from the session rather than the body —
 * a caller who can name their own decider can name somebody else and walk past
 * the conflict-of-interest check.
 */
async function resolve(
  req: Request,
  db: SupabaseClient,
  caller: Caller,
  id: string,
): Promise<Response> {
  if (caller.kind !== 'dashboard') {
    throw new PayHoldError(
      'unauthorized',
      'A dispute can only be decided by a signed-in person, not by an API key',
    )
  }
  requireRole(caller, 'owner', 'staff')

  const dispute = await getDispute(db, caller, id)
  const body = await req.json().catch(() => ({})) as Record<string, unknown>

  const resolution = requireOneOf(
    body.resolution,
    ['release', 'refund', 'partial_refund'] as const,
    'resolution',
  )

  const note = typeof body.note === 'string' ? body.note.trim() : ''
  if (!note) {
    throw new PayHoldError(
      'policy_violation',
      'A resolution must say why — it is what both parties are told',
    )
  }

  const deal = await loadDeal(db, dispute.deal_id as string)
  const figures = await releaseFigures(db, deal)

  const { error } = await db.rpc('resolve_dispute', {
    p_dispute_id: dispute.id,
    p_resolution: resolution,
    p_note: note,
    ...figures,
    p_refund_amount: resolution === 'partial_refund' && body.refund_amount !== undefined
      ? Number(body.refund_amount)
      : null,
    p_decided_by: caller.actor,
  })

  if (error) throw rpcError(error, 'resolve this dispute')

  return json(req, await withCase(db, await getDispute(db, caller, id)))
}

/**
 * §8's communication export.
 *
 * The timeline, flattened to one row per event with the deal and the parties
 * alongside — the thing somebody attaches to a chargeback response or hands to a
 * regulator. It is a read of what already exists, so it stays a projection
 * rather than a stored document that could drift from the case it describes.
 */
async function exportCase(
  req: Request,
  db: SupabaseClient,
  caller: Caller,
  id: string,
): Promise<Response> {
  const dispute = await getDispute(db, caller, id)
  const full = await withCase(db, dispute)
  const deal = await loadDeal(db, dispute.deal_id as string)

  return json(req, {
    exported_at: new Date().toISOString(),
    dispute: {
      id: dispute.id,
      status: dispute.status,
      reason: dispute.reason,
      reason_code: dispute.reason_code,
      disputed_amount: dispute.disputed_amount,
      raised_by: dispute.raised_by,
      opened_at: dispute.opened_at,
      resolved_at: dispute.resolved_at,
      resolution_note: dispute.resolution_note,
      decided_by: dispute.decided_by,
    },
    deal: {
      id: deal.id,
      description: deal.description,
      buyer_ref: deal.buyer_ref,
      seller_id: deal.seller_id,
      presentment_amount: deal.presentment_amount,
      presentment_currency: deal.presentment_currency,
      status: deal.status,
    },
    timeline: full.timeline,
  })
}

/** Same mechanical mapping the payouts and deals functions use. */
function rpcError(error: { message: string }, what: string): PayHoldError {
  const message = error.message

  for (
    const code of
      ['not_found', 'invalid_state', 'policy_violation', 'insufficient_balance'] as const
  ) {
    if (message.startsWith(code)) {
      return new PayHoldError(code, message.slice(code.length + 2).trim())
    }
  }

  console.error(`unmapped ${what} failure`, { message })
  return new PayHoldError('policy_violation', `Could not ${what}`)
}

Deno.serve(handler(async (req) => {
  const db = serviceClient()
  const caller = await resolveCaller(db, req)

  const segments = new URL(req.url).pathname.split('/').filter(Boolean)
  const base = segments.indexOf('disputes')
  const id = segments[base + 1]
  const action = segments[base + 2]
  const offerId = segments[base + 3]
  const offerAction = segments[base + 4]

  if (!id) {
    if (req.method === 'POST') return await open(req, db, caller)

    if (req.method === 'GET') {
      const url = new URL(req.url)
      let query = db
        .from('disputes')
        .select(DISPUTE_COLUMNS)
        .eq('tenant_id', caller.tenant_id)
        .order('opened_at', { ascending: false })
        .limit(Math.min(Number(url.searchParams.get('limit') ?? 100), 500))

      const status = url.searchParams.get('status')
      if (status) query = query.in('status', status.split(','))

      const dealId = url.searchParams.get('deal_id')
      if (dealId) query = query.eq('deal_id', dealId)

      const { data } = await query
      return json(req, { disputes: data ?? [] })
    }

    throw new PayHoldError('policy_violation', `${req.method} is not supported here`)
  }

  if (req.method === 'GET') {
    if (!action) return json(req, await withCase(db, await getDispute(db, caller, id)))
    if (action === 'export') return await exportCase(req, db, caller, id)
    throw new PayHoldError('not_found', `No such view "${action}"`)
  }

  if (req.method !== 'POST') {
    throw new PayHoldError('policy_violation', `${req.method} is not supported here`)
  }

  if (action === 'offers' && offerId) {
    switch (offerAction) {
      case 'respond':
        return await respondOffer(req, db, caller, id, offerId)
      case 'withdraw':
        return await withdrawOffer(req, db, caller, id, offerId)
      default:
        throw new PayHoldError('not_found', `No such action "${offerAction ?? ''}"`)
    }
  }

  switch (action) {
    case 'offers':
      return await makeOffer(req, db, caller, id)
    case 'evidence':
      return await addEvidence(req, db, caller, id)
    case 'resolve':
      return await resolve(req, db, caller, id)
    default:
      throw new PayHoldError('not_found', `No such action "${action ?? ''}"`)
  }
}))
