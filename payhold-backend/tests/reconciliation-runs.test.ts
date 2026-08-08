/**
 * Reconciliation runs — spec §13, migration `20260807000013`.
 *
 * The alerts table answers "is something wrong now". These tests are about the
 * question it cannot answer: did the pass run, what did it cover, and did
 * anybody ever look at what it found.
 *
 * The one that matters most is the last describe. §13's "any mismatch produces
 * a case rather than silently altering balances" is asserted against the
 * *bodies* of these functions with their comments stripped, the same way the
 * checkout tests assert that a session cannot fund a deal — behaviour proves
 * today's code, the source assertion is what a future edit has to argue with.
 */

import { beforeAll, afterAll, describe, expect, test } from 'vitest'
import { migrated, rejects, type Harness } from './harness'

let h: Harness

beforeAll(async () => {
  h = await migrated()
}, 120_000)

afterAll(async () => {
  await h?.close()
})

const newTenant = async (): Promise<string> => {
  const { rows: [t] } = await h.db.query<{ id: string }>(
    `insert into tenants (name, slug) values ('Acme', 'acme-' || gen_random_uuid())
     returning id`,
  )
  return t.id
}

const startRun = async (tenant: string, provider = 'flutterwave'): Promise<string> => {
  const { rows: [r] } = await h.db.query<{ id: string }>(
    `select id from start_reconciliation_run($1, $2::provider)`,
    [tenant, provider],
  )
  return r.id
}

interface Run {
  status: string
  resolution: string | null
  rails_checked: number
  matched: number
  mismatched: number
  skipped: number
  missing: number
  resolved_by: string | null
  error: string | null
  period_start: Date
  period_end: Date
  finished_at: Date | null
}

const runRow = async (id: string): Promise<Run> => {
  const { rows: [r] } = await h.db.query<Run>(
    `select status::text, resolution::text, rails_checked, matched, mismatched,
            skipped, missing, resolved_by, error, period_start, period_end, finished_at
       from reconciliation_runs where id = $1`,
    [id],
  )
  return r
}

/** The comparison the cron makes, with the run threaded through it. */
const record = (
  tenant: string,
  run: string | null,
  ledger: number,
  provider: number,
  currency = 'RWF',
  rail = 'flutterwave',
) =>
  h.db.query(
    `select record_reconciliation($1, $2::provider, $3::currency_code, $4, $5, $6)`,
    [tenant, rail, currency, ledger, provider, run],
  )

describe('a pass leaves a record of itself', () => {
  test('counts what agreed and what did not, per rail', async () => {
    const tenant = await newTenant()
    const run = await startRun(tenant)

    await record(tenant, run, 100_000, 100_000, 'RWF')
    await record(tenant, run, 5_000, 4_500, 'USD')
    await h.db.query(`select finish_reconciliation_run($1, 0)`, [run])

    const r = await runRow(run)
    expect(r.status).toBe('completed')
    expect(r.rails_checked).toBe(2)
    expect(r.matched).toBe(1)
    expect(r.mismatched).toBe(1)
    expect(r.resolution).toBe('cases_open')
    expect(r.finished_at).not.toBeNull()
  })

  test('a pass where everything agreed is clean', async () => {
    const tenant = await newTenant()
    const run = await startRun(tenant)

    await record(tenant, run, 100_000, 100_000)
    await h.db.query(`select finish_reconciliation_run($1, 0)`, [run])

    expect((await runRow(run)).resolution).toBe('clean')
  })

  test('a rail we could not reach is incomplete, not clean', async () => {
    // A provider outage means we learned nothing. Reading that as a clean set
    // of books is how a week of unreachable rails passes for a week of
    // agreement.
    const tenant = await newTenant()
    const run = await startRun(tenant)

    await h.db.query(`select finish_reconciliation_run($1, 2)`, [run])

    const r = await runRow(run)
    expect(r.skipped).toBe(2)
    expect(r.resolution).toBe('incomplete')
  })

  test('each rail gets its own run', async () => {
    // You cannot ask two providers about one number, which is why balances
    // reconcile per rail — and why one run summing both would be that same
    // mistake a level up.
    const tenant = await newTenant()
    const flutterwave = await startRun(tenant, 'flutterwave')
    const stripe = await startRun(tenant, 'stripe')

    expect(flutterwave).not.toBe(stripe)

    await record(tenant, flutterwave, 100_000, 100_000, 'RWF', 'flutterwave')
    await record(tenant, stripe, 5_000, 4_500, 'USD', 'stripe')
    await h.db.query(`select finish_reconciliation_run($1, 0)`, [flutterwave])
    await h.db.query(`select finish_reconciliation_run($1, 0)`, [stripe])

    expect((await runRow(flutterwave)).resolution).toBe('clean')
    expect((await runRow(stripe)).resolution).toBe('cases_open')
  })

  test('the window picks up where the last completed pass stopped', async () => {
    // An inbound event must not be able to fall between two passes and be
    // counted by neither.
    const tenant = await newTenant()
    const first = await startRun(tenant)
    await h.db.query(`select finish_reconciliation_run($1, 0)`, [first])

    const second = await startRun(tenant)
    const [a, b] = [await runRow(first), await runRow(second)]

    expect(b.period_start.toISOString()).toBe(a.period_end.toISOString())
  })

  test('a pass that never finished is recorded as failed by the next one', async () => {
    const tenant = await newTenant()
    const abandoned = await startRun(tenant)
    const next = await startRun(tenant)

    expect(abandoned).not.toBe(next)
    const r = await runRow(abandoned)
    expect(r.status).toBe('failed')
    expect(r.error).toBe('The pass did not finish')

    // And the unique index only ever allows one open run per rail.
    const { rows } = await h.db.query(
      `select 1 from reconciliation_runs
        where tenant_id = $1 and status = 'running'`, [tenant],
    )
    expect(rows).toHaveLength(1)
  })

  test('a run cannot be finished twice', async () => {
    const tenant = await newTenant()
    const run = await startRun(tenant)
    await h.db.query(`select finish_reconciliation_run($1, 0)`, [run])

    await rejects(
      () => h.db.query(`select finish_reconciliation_run($1, 0)`, [run]),
      /already completed/,
    )
  })
})

describe('missing — what the provider told us and the ledger never posted', () => {
  /** An inbound webhook, recorded exactly as the webhook function records it. */
  const inboundEvent = (
    tenant: string,
    opts: { signatureOk?: boolean; processed?: boolean } = {},
  ) =>
    h.db.query(
      `insert into provider_events (tenant_id, provider, event_id, event_type,
                                    signature_ok, payload, processed_at)
       values ($1, 'flutterwave', 'evt-' || gen_random_uuid(), 'charge.completed',
               $2, '{}'::jsonb, case when $3 then now() else null end)`,
      [tenant, opts.signatureOk ?? true, opts.processed ?? false],
    )

  test('a verified event we never finished processing is arrears', async () => {
    const tenant = await newTenant()
    await inboundEvent(tenant)

    const run = await startRun(tenant)
    await h.db.query(`select finish_reconciliation_run($1, 0)`, [run])

    const r = await runRow(run)
    expect(r.missing).toBe(1)
    // Nothing disagreed and there is still a case, because a payment we were
    // told about and never booked is money we cannot see.
    expect(r.resolution).toBe('cases_open')
  })

  test('a forged event is not arrears', async () => {
    // We refused it on purpose. Counting a rejected forgery as money we owe
    // ourselves would make every probe look like a reconciliation failure.
    const tenant = await newTenant()
    await inboundEvent(tenant, { signatureOk: false })

    const run = await startRun(tenant)
    await h.db.query(`select finish_reconciliation_run($1, 0)`, [run])

    expect((await runRow(run)).missing).toBe(0)
  })

  test('an event that was processed is not arrears', async () => {
    const tenant = await newTenant()
    await inboundEvent(tenant, { processed: true })

    const run = await startRun(tenant)
    await h.db.query(`select finish_reconciliation_run($1, 0)`, [run])

    expect((await runRow(run)).missing).toBe(0)
  })

  test('only this rail, and only this window', async () => {
    const tenant = await newTenant()
    await h.db.query(
      `insert into provider_events (tenant_id, provider, event_id, event_type,
                                    signature_ok, payload)
       values ($1, 'stripe', 'evt-other-rail', 'payment_intent.succeeded', true, '{}'::jsonb)`,
      [tenant],
    )
    await h.db.query(
      `insert into provider_events (tenant_id, provider, event_id, event_type,
                                    signature_ok, payload, created_at)
       values ($1, 'flutterwave', 'evt-last-week', 'charge.completed', true, '{}'::jsonb,
               now() - interval '7 days')`,
      [tenant],
    )

    const run = await startRun(tenant, 'flutterwave')
    await h.db.query(`select finish_reconciliation_run($1, 0)`, [run])

    expect((await runRow(run)).missing).toBe(0)
  })
})

describe('a case is signed off by a person, not by the numbers', () => {
  const drift = async (): Promise<{ tenant: string; run: string }> => {
    const tenant = await newTenant()
    const run = await startRun(tenant)
    await record(tenant, run, 100_000, 125_000)
    await h.db.query(`select finish_reconciliation_run($1, 0)`, [run])
    return { tenant, run }
  }

  test('resolving names the person and closes the alerts it raised', async () => {
    const { tenant, run } = await drift()

    await h.db.query(
      `select resolve_reconciliation_run($1, 'grace@payhold.io', 'A duplicate refund, reversed')`,
      [run],
    )

    const r = await runRow(run)
    expect(r.resolution).toBe('resolved')
    expect(r.resolved_by).toBe('grace@payhold.io')

    const { rows } = await h.db.query<{ resolution_note: string }>(
      `select resolution_note from reconciliation_alerts
        where tenant_id = $1 and resolved_at is not null`, [tenant],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].resolution_note).toBe('A duplicate refund, reversed')
  })

  test('an alert records which pass first raised it', async () => {
    const { tenant, run } = await drift()

    const { rows: [a] } = await h.db.query<{ run_id: string }>(
      `select run_id from reconciliation_alerts where tenant_id = $1`, [tenant],
    )
    expect(a.run_id).toBe(run)
  })

  test('resolving without a name is refused', async () => {
    const { run } = await drift()

    await rejects(
      () => h.db.query(`select resolve_reconciliation_run($1, '  ', 'no idea')`, [run]),
      /needs a name/,
    )
  })

  test('signing the case off does not by itself lift the freeze', async () => {
    // The two are separate claims: "I have written down what happened" and "the
    // money is accounted for and may move again".
    const { tenant, run } = await drift()

    await h.db.query(
      `select resolve_reconciliation_run($1, 'grace@payhold.io', 'Explained')`, [run],
    )

    const { rows: [t] } = await h.db.query<{ status: string }>(
      `select status from tenants where id = $1`, [tenant],
    )
    expect(t.status).toBe('payouts_frozen')
  })

  test('a person can lift it, and it is audited against them', async () => {
    const { tenant, run } = await drift()

    await h.db.query(
      `select resolve_reconciliation_run($1, 'grace@payhold.io', 'Explained', true)`, [run],
    )

    const { rows: [t] } = await h.db.query<{ status: string }>(
      `select status from tenants where id = $1`, [tenant],
    )
    expect(t.status).toBe('active')

    const { rows: [log] } = await h.db.query<{ actor: string }>(
      `select actor from audit_log
        where tenant_id = $1 and action = 'tenant.payouts_resumed'`, [tenant],
    )
    expect(log.actor).toBe('grace@payhold.io')
  })

  test('it cannot be lifted while another case is still open', async () => {
    const { tenant, run } = await drift()
    // A second rail nobody has looked at yet.
    const stripe = await startRun(tenant, 'stripe')
    await record(tenant, stripe, 5_000, 4_500, 'USD', 'stripe')
    await h.db.query(`select finish_reconciliation_run($1, 0)`, [stripe])

    await rejects(
      () =>
        h.db.query(
          `select resolve_reconciliation_run($1, 'grace@payhold.io', 'Explained', true)`,
          [run],
        ),
      /still open/,
    )

    const { rows: [t] } = await h.db.query<{ status: string }>(
      `select status from tenants where id = $1`, [tenant],
    )
    expect(t.status).toBe('payouts_frozen')
  })

  test('a run still in progress cannot be resolved', async () => {
    const tenant = await newTenant()
    const run = await startRun(tenant)

    await rejects(
      () => h.db.query(`select resolve_reconciliation_run($1, 'grace', 'early')`, [run]),
      /not completed/,
    )
  })
})

describe('reconciliation never moves money', () => {
  test('a mismatch writes a case and no ledger entry', async () => {
    const tenant = await newTenant()
    const run = await startRun(tenant)
    await record(tenant, run, 100_000, 125_000)
    await h.db.query(`select finish_reconciliation_run($1, 0)`, [run])
    await h.db.query(
      `select resolve_reconciliation_run($1, 'grace@payhold.io', 'Explained', true)`, [run],
    )

    const { rows } = await h.db.query(
      `select 1 from ledger where tenant_id = $1`, [tenant],
    )
    expect(rows).toHaveLength(0)
  })

  test('no reconciliation function names a ledger write', async () => {
    // §13: "any mismatch produces a case rather than silently altering
    // balances." Asserted against the source, comments stripped — the headers
    // explain this property at length and matching that prose would pass on the
    // promise rather than on the code.
    const { rows } = await h.db.query<{ proname: string; body: string }>(
      `select p.proname,
              regexp_replace(pg_get_functiondef(p.oid), '--[^\n]*', '', 'g') as body
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname in ('start_reconciliation_run', 'record_reconciliation',
                            'finish_reconciliation_run', 'fail_reconciliation_run',
                            'resolve_reconciliation_run')`,
    )

    expect(rows).toHaveLength(5)
    for (const fn of rows) {
      expect(fn.body.includes('write_ledger'), fn.proname).toBe(false)
      expect(fn.body.includes('insert into ledger'), fn.proname).toBe(false)
      expect(fn.body.includes('settle_payout'), fn.proname).toBe(false)
    }
  })

  test('there is exactly one record_reconciliation', async () => {
    // `create or replace` cannot add a parameter — it adds a sibling, and the
    // five-argument call every existing caller makes would then be ambiguous.
    // The old signature is dropped by argument list in `20260807000013`.
    const { rows: [row] } = await h.db.query<{ count: number }>(
      `select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'record_reconciliation'`,
    )
    expect(row.count).toBe(1)
  })

  test('the AI role cannot open, close or resolve a run', async () => {
    // Invariant 9 as a grant. Resolving can lift a payout freeze, which is not
    // model output's to do at any confidence.
    for (
      const fn of [
        'start_reconciliation_run',
        'record_reconciliation',
        'finish_reconciliation_run',
        'fail_reconciliation_run',
        'resolve_reconciliation_run',
      ]
    ) {
      const { rows } = await h.db.query<{ allowed: boolean }>(
        `select bool_or(has_function_privilege('payhold_ai', p.oid, 'execute')) as allowed
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = $1`,
        [fn],
      )
      expect(rows[0].allowed, fn).toBe(false)
    }
  })
})
