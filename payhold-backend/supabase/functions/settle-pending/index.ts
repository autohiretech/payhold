/**
 * The settlement sweep — the backstop under every inbound webhook.
 *
 *   POST /settle-pending          x-cron-secret, like every scheduled job
 *
 * A deal sits in `payment_pending` while the money is with the rail and not yet
 * with us. Something has to end that wait, and until now the only thing that
 * could was an inbound provider webhook: the rail POSTs, we re-fetch the
 * transaction, we book the hold. When that POST does not arrive — an endpoint
 * never registered in the provider's dashboard, a signing secret rotated on one
 * side, an outage that outlived the retry budget — the wait never ended. The
 * buyer was debited, the deal stayed pending, no `order.funded_held` was ever
 * queued, and the client's own system went on believing nobody had bought
 * anything. Money at the rail, and every party to it misinformed.
 *
 * So this pass asks. For each deal whose charge actually started and has not
 * landed in our books, it re-fetches the transaction from the provider and
 * funds the deal if the provider says it succeeded — `settleDeal`, the same
 * verification the webhooks perform, reached on a timer instead of on a
 * doorbell. §15 phase 2 is satisfied identically: the evidence is the
 * provider's own answer over our own authenticated connection.
 *
 * `checkout`'s `/confirm` covers the buyer who stays and watches. This covers
 * the one who closed the tab, which is most of them, and it is the reason that
 * route is not sufficient on its own.
 *
 * **A suspended tenant is skipped**, matching `auto-release`: an account we
 * have stopped serving does not get its deals quietly moved while it is locked
 * out and unable to see it happen. The money stays where it is and the next
 * pass after reinstatement picks it up — nothing here is time-critical in a way
 * that would be lost.
 */

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { serviceClient } from '../_shared/auth.ts'
import { requireCronCaller } from '../_shared/cron-auth.ts'
import { finishCronRun, startCronRun } from '../_shared/cron-runs.ts'
import { handler, json } from '../_shared/http.ts'
import { settleDeal, SETTLE_COLUMNS, type SettleableDeal } from '../_shared/settle.ts'
import type { PaymentMethod, Provider } from '../_shared/types.ts'

/** Deals per pass. Each is a provider round trip; the next pass takes more. */
const BATCH = 50

/**
 * The two statuses that mean "a charge is out there".
 *
 * `created` is absent on purpose and it is the important omission: a deal
 * nobody has tried to pay for would otherwise be probed at the rail every pass
 * for as long as the window lasts, which is thousands of calls asking after
 * transactions that were never started. `payment_failed` is absent for the
 * mirror of that reason — the rail already told us, and asking it to repeat
 * itself changes nothing.
 */
const PENDING = ['checkout_started', 'payment_pending']

/**
 * How long a charge is worth chasing.
 *
 * The floor keeps this out of the way of the payment actually in progress: a
 * card authorised ten seconds ago is being polled by the buyer's own page
 * through `/confirm`, and a second probe of the same reference buys nothing.
 * The ceiling is where chasing stops being useful — a rail that has not
 * confirmed a charge in three days is not about to, and a deal that old wants a
 * person rather than another loop.
 */
const MIN_AGE_SECONDS = 90
const MAX_AGE_DAYS = 3

/** What a session knows that the deal row does not yet. */
interface StartedSession {
  deal_id: string
  method: PaymentMethod | null
  network: string | null
  provider: Provider | null
  provider_ref: string | null
}

/**
 * Sessions where the buyer actually chose something, keyed by deal.
 *
 * Read in one query for the whole batch rather than per deal. Newest first so
 * a deal paid twice — a first attempt that failed, a second that did not —
 * resolves to the attempt still in flight rather than the abandoned one.
 */
async function startedSessions(
  db: SupabaseClient,
  dealIds: string[],
): Promise<Map<string, StartedSession>> {
  if (dealIds.length === 0) return new Map()

  const { data } = await db
    .from('checkout_sessions')
    .select('deal_id, method, network, provider, provider_ref')
    .in('deal_id', dealIds)
    .not('method', 'is', null)
    .order('created_at', { ascending: false })

  const byDeal = new Map<string, StartedSession>()
  for (const row of (data ?? []) as unknown as StartedSession[]) {
    if (!byDeal.has(row.deal_id)) byDeal.set(row.deal_id, row)
  }
  return byDeal
}

Deno.serve(handler(async (req) => {
  await requireCronCaller(req)

  const db = serviceClient()
  const runId = await startCronRun(db, 'settle-pending')

  try {
    const result = await runPass(db)
    await finishCronRun(db, runId, 'completed', result)
    return json(req, result)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await finishCronRun(db, runId, 'failed', undefined, message)
    throw err
  }
}))

async function runPass(db: SupabaseClient): Promise<Record<string, number>> {
  const now = Date.now()

  const { data: suspended } = await db
    .from('tenants')
    .select('id')
    .eq('status', 'suspended')

  const { data: pending, error } = await db
    .from('deals')
    .select(SETTLE_COLUMNS)
    .in('status', PENDING)
    .lte('created_at', new Date(now - MIN_AGE_SECONDS * 1_000).toISOString())
    .gte('created_at', new Date(now - MAX_AGE_DAYS * 86_400_000).toISOString())
    .order('created_at', { ascending: true })
    .limit(BATCH)

  if (error) throw new Error(`deal lookup failed: ${error.message}`)

  const deals = (pending ?? []) as unknown as SettleableDeal[]
  const sessions = await startedSessions(db, deals.map((d) => d.id))
  const blocked = new Set((suspended ?? []).map((t) => t.id as string))

  const result = {
    considered: 0,
    /** Held. Each of these queues an `order.funded_held` for the client. */
    funded: 0,
    /** The rail still has not decided. The ordinary answer, and not a problem. */
    still_pending: 0,
    /** No charge to ask about, a suspended tenant, or a rail we cannot reach. */
    skipped: 0,
    errored: 0,
  }

  for (const deal of deals) {
    result.considered += 1

    if (blocked.has(deal.tenant_id)) {
      result.skipped += 1
      continue
    }

    const session = sessions.get(deal.id)

    // Nothing started this deal that we can see: no session with a method, and
    // no reference on the deal from the API `/pay` route either. Asking the
    // rail about it would be asking after a transaction nobody created.
    if (!session && !deal.provider_ref) {
      result.skipped += 1
      continue
    }

    try {
      const settled = await settleDeal(db, deal, {
        rail: session?.provider,
        reference: session?.provider_ref,
        method: session?.method,
        network: session?.network,
      })

      if (settled.funded) result.funded += 1
      else if (settled.reason === 'pending') result.still_pending += 1
      else result.skipped += 1
    } catch (err) {
      // One deal's rail having a bad minute must not end the pass for the rest.
      console.error('settlement failed', {
        deal_id: deal.id,
        tenant_id: deal.tenant_id,
        message: err instanceof Error ? err.message : String(err),
      })
      result.errored += 1
    }
  }

  return result
}