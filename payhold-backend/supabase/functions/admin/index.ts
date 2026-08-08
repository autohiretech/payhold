/**
 * The master-admin console — PayHold staff, across every tenant.
 *
 *   GET  /admin/tenants                          every company, and its status
 *   GET  /admin/reconciliation-alerts            open and closed drift cases
 *   GET  /admin/reconciliation-runs              §13's record of the passes
 *   POST /admin/reconciliation-runs              run the pass now
 *   POST /admin/reconciliation-runs/:id/resolve  sign a case off, and maybe unfreeze
 *   POST /admin/tenants/:id/freeze               stop one company's payouts
 *   POST /admin/tenants/:id/unfreeze             let them go again
 *
 * **Every route here is `platformAdminFromJwt`, and none of them is tenant
 * scoped** — which is exactly why it is a function of its own rather than a few
 * more routes on `balance` or `payouts`. Everything else in the v1 API resolves
 * a caller to one tenant and filters on it; this reads across all of them, and
 * a cross-tenant read sitting in a file whose other handlers are scoped is the
 * shape a leak takes. `platform_admins` is the separate axis, an API key is
 * refused outright, and a tenant `owner` gets the same 404 as a stranger.
 *
 * **Freezing is arithmetic; unfreezing is a judgement.** `record_reconciliation`
 * freezes on any drift, automatically and without asking. Nothing lifts that
 * automatically, and the two ways out both need a named person: signing the run
 * off with `unfreeze`, or the manual unfreeze below — which refuses while any
 * case on the tenant is still open, the same condition
 * `resolve_reconciliation_run` enforces. The numbers agreeing again is not the
 * same as somebody having understood why they did not.
 */

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { platformAdminFromJwt, serviceClient } from '../_shared/auth.ts'
import { handler, json, readJson } from '../_shared/http.ts'
import { reconcileAll } from '../_shared/reconciliation.ts'
import { PayHoldError } from '../_shared/types.ts'

const ALERT_COLUMNS =
  'id, tenant_id, provider, currency, ledger_balance, provider_balance, drift, ' +
  'detected_at, last_seen_at, resolved_at, resolution_note, run_id'

const RUN_COLUMNS =
  'id, tenant_id, provider, period_start, period_end, started_at, finished_at, ' +
  'rails_checked, matched, mismatched, skipped, missing, status, resolution, ' +
  'resolved_by, resolved_at, resolution_note, error'

const TENANT_COLUMNS = 'id, name, slug, status, created_at'

function limitOf(url: URL, fallback: number, ceiling: number): number {
  return Math.min(Number(url.searchParams.get('limit') ?? fallback), ceiling)
}

async function listAlerts(req: Request, db: SupabaseClient): Promise<Response> {
  const url = new URL(req.url)

  let query = db
    .from('reconciliation_alerts')
    .select(ALERT_COLUMNS)
    .order('detected_at', { ascending: false })
    .limit(limitOf(url, 200, 1_000))

  const tenantId = url.searchParams.get('tenant_id')
  if (tenantId) query = query.eq('tenant_id', tenantId)
  if (url.searchParams.get('open')) query = query.is('resolved_at', null)

  const { data, error } = await query
  if (error) throw new Error(`alert lookup failed: ${error.message}`)

  return json(req, { alerts: data ?? [] })
}

async function listRuns(req: Request, db: SupabaseClient): Promise<Response> {
  const url = new URL(req.url)

  let query = db
    .from('reconciliation_runs')
    .select(RUN_COLUMNS)
    .order('started_at', { ascending: false })
    .limit(limitOf(url, 100, 500))

  const tenantId = url.searchParams.get('tenant_id')
  if (tenantId) query = query.eq('tenant_id', tenantId)

  const { data, error } = await query
  if (error) throw new Error(`reconciliation run lookup failed: ${error.message}`)

  return json(req, { runs: data ?? [] })
}

/**
 * Run the pass now, then hand back the cases.
 *
 * The same `reconcileAll` the nightly cron calls, with no shortened version for
 * somebody in a hurry. It returns the alerts rather than the counters because
 * the question being asked is "what is wrong", and the pass having checked
 * eleven currencies is not an answer to it.
 */
async function runNow(
  req: Request,
  db: SupabaseClient,
  actor: string,
): Promise<Response> {
  const body = await readJson<{ tenant_id?: string }>(req)
    .catch(() => ({} as { tenant_id?: string }))
  const totals = await reconcileAll(db, body.tenant_id)

  const { data } = await db
    .from('reconciliation_alerts')
    .select(ALERT_COLUMNS)
    .order('detected_at', { ascending: false })
    .limit(200)

  console.info('reconciliation run on request', { actor, ...totals })

  return json(req, { alerts: data ?? [], totals })
}

async function resolveRun(
  req: Request,
  db: SupabaseClient,
  runId: string,
  actor: string,
): Promise<Response> {
  const body = await readJson<{ note?: string; unfreeze?: boolean }>(req)
  const note = (body.note ?? '').trim()

  if (!note) {
    throw new PayHoldError(
      'policy_violation',
      'Signing a reconciliation case off needs an explanation of what happened',
    )
  }

  // The actor comes from the session, never from the body — the same rule
  // `verify_seller` and `sign_off_launch_item` follow. A caller who can name
  // their own signatory can name somebody who was not there.
  const { data, error } = await db.rpc('resolve_reconciliation_run', {
    p_run: runId,
    p_actor: actor,
    p_note: note,
    p_unfreeze: body.unfreeze === true,
  })

  if (error) {
    const message = error.message ?? 'Could not resolve that run'
    throw new PayHoldError(
      message.startsWith('not_found') ? 'not_found' : 'policy_violation',
      message.replace(/^(not_found|policy_violation|invalid_state):\s*/, ''),
    )
  }

  return json(req, { run: data })
}

async function setPayoutFreeze(
  req: Request,
  db: SupabaseClient,
  tenantId: string,
  freeze: boolean,
  actor: string,
): Promise<Response> {
  const { data: tenant } = await db
    .from('tenants')
    .select(TENANT_COLUMNS)
    .eq('id', tenantId)
    .maybeSingle()

  if (!tenant) throw new PayHoldError('not_found', `Tenant ${tenantId} not found`)

  const current = (tenant as { status: string }).status
  if (current === 'suspended') {
    throw new PayHoldError(
      'policy_violation',
      'This company is suspended — its payouts are stopped by something wider than a freeze',
    )
  }

  if (!freeze) {
    // The same condition `resolve_reconciliation_run` enforces before it lifts
    // one. A freeze released over an open case is a case nobody is looking at
    // and money moving as though somebody had.
    const { count } = await db
      .from('reconciliation_alerts')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .is('resolved_at', null)

    if ((count ?? 0) > 0) {
      throw new PayHoldError(
        'policy_violation',
        `${count} reconciliation case${count === 1 ? ' is' : 's are'} still open on ` +
          'this company. Resolve the run that raised them — that is where a freeze is lifted.',
      )
    }
  }

  const { data, error } = await db
    .from('tenants')
    .update({ status: freeze ? 'payouts_frozen' : 'active' })
    .eq('id', tenantId)
    .select(TENANT_COLUMNS)
    .single()

  if (error) throw new Error(`tenant status update failed: ${error.message}`)

  await db.rpc('write_audit', {
    p_tenant: tenantId,
    p_deal: null,
    p_actor: actor,
    p_action: freeze ? 'tenant.payouts_frozen' : 'tenant.payouts_resumed',
    p_details: { by: 'platform_admin', previous_status: current },
  })

  return json(req, { tenant: data })
}

Deno.serve(handler(async (req) => {
  const db = serviceClient()
  const admin = await platformAdminFromJwt(db, req)

  const segments = new URL(req.url).pathname.split('/').filter(Boolean)
  const base = segments.indexOf('admin')
  const resource = segments[base + 1]
  const id = segments[base + 2]
  const action = segments[base + 3]

  if (req.method === 'GET') {
    switch (resource) {
      case 'tenants': {
        const { data, error } = await db
          .from('tenants')
          .select(TENANT_COLUMNS)
          .order('created_at', { ascending: true })

        if (error) throw new Error(`tenant lookup failed: ${error.message}`)
        return json(req, { tenants: data ?? [] })
      }
      case 'reconciliation-alerts':
        return await listAlerts(req, db)
      case 'reconciliation-runs':
        return await listRuns(req, db)
      default:
        throw new PayHoldError('not_found', `No such view "${resource ?? ''}"`)
    }
  }

  if (req.method === 'POST') {
    if (resource === 'reconciliation-runs' && !id) {
      return await runNow(req, db, admin.actor)
    }
    if (resource === 'reconciliation-runs' && id && action === 'resolve') {
      return await resolveRun(req, db, id, admin.actor)
    }
    if (resource === 'tenants' && id && (action === 'freeze' || action === 'unfreeze')) {
      return await setPayoutFreeze(req, db, id, action === 'freeze', admin.actor)
    }

    throw new PayHoldError('not_found', 'No such action')
  }

  throw new PayHoldError('policy_violation', `${req.method} is not supported here`)
}))
