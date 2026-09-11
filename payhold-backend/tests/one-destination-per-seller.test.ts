/**
 * Spec §29.17 — one live payout destination per seller, migration
 * `20260911000003`.
 *
 * `add_seller_destination` used to demote and insert beside, forever, so one
 * host's four re-saves read as five destinations. Now adding one replaces it:
 * the live row is archived — never deleted, because payouts still say where
 * they went — and an archived row cannot be verified, released, withdrawn to or
 * routed to. The backup destination and the move back are gone.
 *
 * Two halves. The first runs against a fully migrated database and pins the
 * rule. The second stops one migration short, writes the old shape — five live
 * rows, a backup, a seller with no primary — and applies the migration to it,
 * because a backfill only means something against rows that existed before it
 * ran, and the one-live index refuses to let a migrated database hold them.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { applyMigrations, migrated, migrationFiles, rejects, type Harness } from './harness'

const MIGRATION = '20260911000003_one_destination_per_seller.sql'
const ROOT = join(import.meta.dirname, '..', 'supabase')

interface Destination {
  id: string
  is_primary: boolean
  is_backup: boolean
  verified_at: Date | null
  security_hold_until: Date | null
  archived_at: Date | null
  replaced_by: string | null
}

async function newTenant(db: PGlite, slug: string): Promise<string> {
  const { rows: [t] } = await db.query<{ id: string }>(
    `insert into tenants (name, slug) values ($1, $1) returning id`, [slug],
  )
  return t.id
}

/** A seller as `POST /v1/sellers` creates one, with or without a destination. */
async function newSeller(
  db: PGlite,
  tenant: string,
  name: string,
  withDestination = true,
): Promise<string> {
  const { rows: [s] } = await db.query<{ id: string }>(
    withDestination
      ? `insert into sellers (tenant_id, name, country, payout_currency, payout_provider,
                              beneficiary_token, masked_destination, created_at)
         values ($1, $2, 'RW', 'RWF', 'flutterwave_momo', 'tok_' || gen_random_uuid(),
                 'MTN •••• 4821', now() - interval '400 days')
         returning id`
      : `insert into sellers (tenant_id, name, created_at)
         values ($1, $2, now() - interval '400 days')
         returning id`,
    [tenant, name],
  )
  return s.id
}

/** `POST /v1/sellers/:id/destinations` with the token already minted. */
function addDestination(
  db: PGlite,
  seller: string,
  tenant: string,
  token: string,
  opts: { provider?: string; masked?: string; role?: string } = {},
) {
  return db.query<Destination>(
    `select * from add_seller_destination($1, $2, 'RW', 'RWF', $3, $4, $5, null, $6, 'api')`,
    [
      seller,
      tenant,
      opts.provider ?? 'flutterwave_momo',
      token,
      opts.masked ?? 'MTN •••• 7788',
      opts.role ?? 'primary',
    ],
  )
}

/** A released deal with a scheduled payout, ready to route. */
async function payoutFor(db: PGlite, tenant: string, seller: string): Promise<string> {
  const { rows: [d] } = await db.query<{ id: string }>(
    `insert into deals (tenant_id, buyer_ref, seller_id, description, amount, currency,
                        presentment_currency, presentment_amount, buyer_country,
                        provider, fee_amount, status, released_at)
     values ($1, 'buyer_1', $2, 'A rental', 100000, 'RWF', 'RWF', 100000, 'RW',
             'fake', 10000, 'released', now())
     returning id`,
    [tenant, seller],
  )
  const { rows: [p] } = await db.query<{ id: string }>(
    `insert into payouts (tenant_id, deal_id, seller_id, amount, currency, status, scheduled_for)
     values ($1, $2, $3, 90000, 'RWF', 'scheduled', now())
     returning id`,
    [tenant, d.id, seller],
  )
  return p.id
}

async function route(db: PGlite, payout: string) {
  const { rows: [r] } = await db.query<{ destination_id: string | null; reason_code: string }>(
    `select destination_id, reason_code from route_payout($1)`, [payout],
  )
  return r
}

async function destinationsOf(db: PGlite, seller: string) {
  const { rows } = await db.query<Destination & { token: string }>(
    `select id, beneficiary_token as token, is_primary, is_backup, verified_at,
            security_hold_until, archived_at, replaced_by
       from seller_destinations where seller_id = $1
      order by created_at, id`,
    [seller],
  )
  return rows
}

/** Source with comments stripped, so prose about deleting cannot pass or fail a scan. */
function sqlCode(text: string): string {
  return text.replace(/--.*$/gm, '')
}
function tsCode(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

function filesUnder(dir: string, ext: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules') return []
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return filesUnder(path, ext)
    return path.endsWith(ext) ? [path] : []
  })
}

// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------

describe('§29.17 — one live destination per seller', () => {
  let h: Harness
  let tenant: string

  beforeAll(async () => {
    h = await migrated()
    tenant = await newTenant(h.db, 'one-destination-co')
  }, 120_000)

  afterAll(() => h.close())

  const seller = (name: string, withDestination = true) =>
    newSeller(h.db, tenant, name, withDestination)
  const add = (s: string, token: string, opts: Parameters<typeof addDestination>[4] = {}) =>
    addDestination(h.db, s, tenant, token, opts)

  describe('adding replaces', () => {
    test('a second add archives the first, leaving one live primary the seller row follows', async () => {
      const s = await seller('Second add')
      const [seeded] = await destinationsOf(h.db, s)

      const { rows: [added] } = await add(s, 'tok_second', {
        provider: 'flutterwave_bank',
        masked: 'BK •••• 7788',
      })

      const rows = await destinationsOf(h.db, s)
      expect(rows).toHaveLength(2)

      const live = rows.filter((r) => r.archived_at === null)
      expect(live.map((r) => r.id)).toEqual([added.id])
      expect(live[0].is_primary).toBe(true)

      const old = rows.find((r) => r.id === seeded.id)!
      expect(old.archived_at).not.toBeNull()
      expect(old).toMatchObject({ is_primary: false, is_backup: false, replaced_by: added.id })

      // Through the sync trigger, from the new primary — and the archive step,
      // which wrote `is_primary = false`, did not clear anything first.
      const { rows: [row] } = await h.db.query(
        `select beneficiary_token as token, masked_destination as masked,
                payout_provider::text as provider, country::text as country
           from sellers where id = $1`,
        [s],
      )
      expect(row).toEqual({
        token: 'tok_second',
        masked: 'BK •••• 7788',
        provider: 'flutterwave_bank',
        country: 'RW',
      })
    })

    test('five saves leave one live destination, not five', async () => {
      // The case that asked for this: a host re-entering their number.
      const s = await seller('Saved five times')
      for (const n of [1, 2, 3, 4]) await add(s, `tok_save_${n}`)

      const rows = await destinationsOf(h.db, s)
      expect(rows).toHaveLength(5)
      expect(rows.filter((r) => r.archived_at === null).map((r) => r.token)).toEqual([
        'tok_save_4',
      ])
      // Each archived row names the one that replaced it, so the chain reads back.
      for (let i = 0; i < 4; i++) {
        expect(rows[i].replaced_by).toBe(rows[i + 1].id)
      }
    })

    test('a first destination for a seller registered without one is simply live', async () => {
      const s = await seller('No destination yet', false)
      const { rows: [added] } = await add(s, 'tok_first')
      expect(added.is_primary).toBe(true)
      expect(added.archived_at).toBeNull()

      const { rows: [entry] } = await h.db.query<{ details: Record<string, unknown> }>(
        `select details from audit_log
          where action = 'seller.destination_added' and details ->> 'destination_id' = $1`,
        [added.id],
      )
      expect(entry.details.archived_destination_ids).toEqual([])
    })

    test('the security hold is still applied on replace', async () => {
      // One row is not a reason to relax change protection: replacing is exactly
      // "get in, move the destination, withdraw".
      const s = await seller('Held on replace')
      await h.db.query(`select verify_seller($1, 'compliance@payhold')`, [s])
      await h.db.query(
        `update seller_destinations set security_hold_until = now() where seller_id = $1`, [s],
      )
      await h.db.query(`update sellers set destination_changed_at = null where id = $1`, [s])

      const caps = async () => {
        const { rows: [c] } = await h.db.query<{ can: boolean; reasons: string[] | null }>(
          `select can_receive_payouts as can, reasons from seller_capabilities($1)`, [s],
        )
        return { can: c.can, reasons: (c.reasons ?? []).join(' ') }
      }
      expect((await caps()).can).toBe(true)

      await add(s, 'tok_held')

      const { rows: [live] } = await h.db.query<{ verified: boolean; hours: number }>(
        `select verified_at is not null as verified,
                extract(epoch from security_hold_until - now()) / 3600 as hours
           from seller_destinations where seller_id = $1 and archived_at is null`,
        [s],
      )
      expect(live.verified).toBe(false)
      expect(Number(live.hours)).toBeGreaterThan(23)
      expect(Number(live.hours)).toBeLessThanOrEqual(24)

      const after = await caps()
      expect(after.can).toBe(false)
      expect(after.reasons).toMatch(/not been verified/)
      expect(after.reasons).toMatch(/security hold/)
    })

    test('no role and primary are the same request; backup is refused and writes nothing', async () => {
      const s = await seller('Role compatibility')

      // As PostgREST calls it with no `p_role` — the functions after this change.
      const { rows: [bare] } = await h.db.query<Destination>(
        `select * from add_seller_destination(
           p_seller => $1, p_tenant => $2, p_country => 'RW', p_currency => 'RWF',
           p_provider => 'flutterwave_momo', p_token => 'tok_bare',
           p_masked => 'MTN •••• 1111', p_actor => 'api')`,
        [s, tenant],
      )
      expect(bare.is_primary).toBe(true)

      const count = async () => {
        const { rows: [n] } = await h.db.query<{ rows: number; audits: number }>(
          `select (select count(*)::int from seller_destinations where seller_id = $1::uuid) as rows,
                  (select count(*)::int from audit_log
                    where details ->> 'seller_id' = $1::text) as audits`,
          [s],
        )
        return n
      }
      const before = await count()

      await rejects(
        () => add(s, 'tok_backup', { role: 'backup' }),
        /backup_destination_removed: A seller has one payout destination; adding one replaces the current one\./,
      )
      expect(await count()).toEqual(before)
    })
  })

  describe('an archived destination is history', () => {
    /** A seller whose verified, out-of-hold destination has been replaced. */
    async function replaced(name: string) {
      const s = await seller(name)
      const [seeded] = await destinationsOf(h.db, s)
      await h.db.query(
        `update seller_destinations set verified_at = now(), security_hold_until = now()
          where id = $1`,
        [seeded.id],
      )
      const { rows: [fresh] } = await add(s, `tok_${crypto.randomUUID()}`)
      return { seller: s, old: seeded.id, fresh: fresh.id }
    }

    test('it cannot be verified, in either direction, and no name is recorded', async () => {
      const { old } = await replaced('Verify the old one')

      for (const verified of [true, false]) {
        await rejects(
          () => h.db.query(
            `select verify_seller_destination($1, $2, 'grace@autohire.rw', $3)`,
            [old, tenant, verified],
          ),
          /destination_archived/,
        )
      }

      const { rows: [n] } = await h.db.query<{ n: number }>(
        `select count(*)::int as n from audit_log
          where action like 'seller.destination_verif%' and details ->> 'destination_id' = $1`,
        [old],
      )
      expect(n.n).toBe(0)
    })

    test('its hold cannot be ended', async () => {
      const { old } = await replaced('End the old hold')
      await h.db.query(
        `update seller_destinations set security_hold_until = now() + interval '5 hours'
          where id = $1`,
        [old],
      )

      await rejects(
        () => h.db.query(`select end_destination_hold($1, $2, 'ops@payhold.test')`, [old, tenant]),
        /destination_archived/,
      )

      const { rows: [d] } = await h.db.query<{ held: boolean }>(
        `select security_hold_until > now() as held from seller_destinations where id = $1`,
        [old],
      )
      expect(d.held).toBe(true)
    })

    test('it is never routed to, even when a payout asked for it', async () => {
      const { seller: s, old, fresh } = await replaced('Asked for the old one')

      // The old row is verified and out of hold — everything the requested-
      // destination read used to need. Only being archived stops it.
      const payout = await payoutFor(h.db, tenant, s)
      await h.db.query(
        `update payouts set requested_destination_id = $2 where id = $1`, [payout, old],
      )

      const unverified = await route(h.db, payout)
      expect(unverified.destination_id).toBe(fresh)
      expect(unverified.reason_code).toBe('destination_not_verified')

      await h.db.query(
        `update seller_destinations set verified_at = now(), security_hold_until = now()
          where id = $1`,
        [fresh],
      )
      expect((await route(h.db, payout)).destination_id).toBe(fresh)
    })

    test('a withdrawal cannot name it', async () => {
      const { seller: s, old } = await replaced('Withdraw to the old one')
      await rejects(
        () => h.db.query(`select * from request_withdrawal($1, 'seller-app', $2)`, [s, old]),
        /destination_not_live/,
      )
    })

    test('a paid payout that went to it keeps its destination_id', async () => {
      const s = await seller('Paid, then moved')
      const [seeded] = await destinationsOf(h.db, s)

      const payout = await payoutFor(h.db, tenant, s)
      // The decision row, recorded while the seeded destination was live.
      expect((await route(h.db, payout)).destination_id).toBe(seeded.id)
      await h.db.query(
        `update payouts
            set destination_id = $2, status = 'paid', paid_at = now(),
                provider_ref = 'FLW-PAID-1'
          where id = $1`,
        [payout, seeded.id],
      )

      await add(s, 'tok_after_payout')

      const { rows: [p] } = await h.db.query<{ destination_id: string; decision: string }>(
        `select p.destination_id,
                (select d.destination_id from payout_decisions d
                  where d.payout_id = p.id order by d.created_at desc limit 1) as decision
           from payouts p where p.id = $1`,
        [payout],
      )
      expect(p).toEqual({ destination_id: seeded.id, decision: seeded.id })

      // And the row it points at is still there to be read — `dispatchPayout`
      // throws when it is not.
      const { rows: [row] } = await h.db.query<{ archived: boolean; mask: string }>(
        `select archived_at is not null as archived, masked_destination as mask
           from seller_destinations where id = $1`,
        [seeded.id],
      )
      expect(row).toEqual({ archived: true, mask: 'MTN •••• 4821' })
    })
  })

  describe('the shape is enforced by Postgres, not by a writer remembering', () => {
    test('two live rows for one seller are impossible', async () => {
      const s = await seller('Two live')
      await rejects(
        () => h.db.query(
          `insert into seller_destinations (tenant_id, seller_id, country, payout_currency,
                                            payout_provider, beneficiary_token, masked_destination)
           values ($1, $2, 'RW', 'RWF', 'flutterwave_bank', 'tok_two', 'BK •••• 2222')`,
          [tenant, s],
        ),
        /seller_destinations_one_live/,
      )
    })

    test('an archived row cannot come back while another is live', async () => {
      const s = await seller('Un-archive')
      const [seeded] = await destinationsOf(h.db, s)
      await add(s, 'tok_newer')

      await rejects(
        () => h.db.query(
          `update seller_destinations set archived_at = null where id = $1`, [seeded.id],
        ),
        /seller_destinations_one_live/,
      )
    })

    test('an archived row is never primary', async () => {
      const s = await seller('Archived primary')
      const [seeded] = await destinationsOf(h.db, s)
      await add(s, 'tok_live')
      await h.db.query(
        `update seller_destinations set is_primary = false
          where seller_id = $1 and archived_at is null`,
        [s],
      )

      await rejects(
        () => h.db.query(
          `update seller_destinations set is_primary = true where id = $1`, [seeded.id],
        ),
        /seller_destinations_archived_not_primary/,
      )
    })
  })

  describe('Stripe Connect replaces too', () => {
    const code = tsCode(readFileSync(join(ROOT, 'functions', 'sellers', 'index.ts'), 'utf8'))

    test('the promotion connectStatus makes archives the destination it replaces', async () => {
      const s = await seller('Moved to Stripe')
      const [momo] = await destinationsOf(h.db, s)

      // Exactly the call `connectStatus` makes, argument for argument.
      const { rows: [stripe] } = await h.db.query<Destination>(
        `select * from add_seller_destination(
           p_seller => $1, p_tenant => $2, p_country => 'RW', p_currency => 'RWF',
           p_provider => 'stripe_connect', p_token => 'acct_1TEST',
           p_masked => 'Stripe •••• TEST', p_label => 'Stripe',
           p_actor => 'stripe_connect_onboarding')`,
        [s, tenant],
      )

      const rows = await destinationsOf(h.db, s)
      expect(rows.filter((r) => r.archived_at === null).map((r) => r.id)).toEqual([stripe.id])
      expect(rows.find((r) => r.id === momo.id)!.replaced_by).toBe(stripe.id)

      const { rows: [row] } = await h.db.query<{ provider: string }>(
        `select payout_provider::text as provider from sellers where id = $1`, [s],
      )
      expect(row.provider).toBe('stripe_connect')
    })

    test('only a finished onboarding writes a destination', () => {
      // Replace-at-add would archive a working destination for a half-finished
      // onboarding if anything wrote one before Stripe says the account is
      // payable. Two callers in the whole function, and the Connect one is
      // behind `payoutsEnabled`.
      expect(code.match(/rpc\('add_seller_destination'/g)).toHaveLength(2)

      const status = code.slice(
        code.indexOf('async function connectStatus('),
        code.indexOf('Deno.serve('),
      )
      const gate = status.indexOf('if (!payoutsEnabled)')
      expect(gate).toBeGreaterThan(-1)
      expect(status.indexOf("rpc('add_seller_destination'")).toBeGreaterThan(gate)

      const onboarding = code.slice(
        code.indexOf('async function connectAccountFor('),
        code.indexOf('async function connectStatus('),
      )
      expect(onboarding).not.toMatch(/add_seller_destination|seller_destinations/)
    })

    test('no caller sends a role', () => {
      expect(code).not.toMatch(/p_role/)
    })
  })

  describe('nothing deletes a destination', () => {
    test('no function in the database deletes from seller_destinations', async () => {
      const { rows } = await h.db.query<{ proname: string }>(
        `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public'
            and p.prosrc ~* 'delete\\s+from\\s+(public\\.)?seller_destinations'`,
      )
      expect(rows).toEqual([])
    })

    test('no migration deletes from it or drops it', () => {
      const dir = join(ROOT, 'migrations')
      for (const file of migrationFiles()) {
        const sql = sqlCode(readFileSync(join(dir, file), 'utf8'))
        expect(sql, file).not.toMatch(/delete\s+from\s+(public\.)?seller_destinations/i)
        expect(sql, file).not.toMatch(/(drop|truncate)\s+table[^;]*seller_destinations/i)
      }
    })

    test('no Edge Function deletes from it', () => {
      // `reset_tenant_sandbox` deleting a tenant's own test sellers cascades to
      // their destinations; that is a sandbox wipe refused once a tenant goes
      // live, not a destination change, and it names `sellers`, not this table.
      for (const file of filesUnder(join(ROOT, 'functions'), '.ts')) {
        const ts = tsCode(readFileSync(file, 'utf8'))
        expect(ts, file).not.toMatch(/from\(\s*'seller_destinations'\s*\)\s*\.delete\(/)
      }
    })
  })

  describe('the grants survived the rewrite', () => {
    const FUNCTIONS = [
      'add_seller_destination',
      'verify_seller_destination',
      'end_destination_hold',
      'request_withdrawal',
      'route_payout',
    ]

    test.each(FUNCTIONS)('%s is one function, and only the service role may call it', async (fn) => {
      const { rows: [n] } = await h.db.query<{ n: number }>(
        `select count(*)::int as n from pg_proc where proname = $1`, [fn],
      )
      expect(n.n).toBe(1)

      for (const role of ['anon', 'authenticated', 'payhold_ai']) {
        const { rows: [r] } = await h.db.query<{ allowed: boolean }>(
          `select has_function_privilege($1, p.oid, 'execute') as allowed
             from pg_proc p where p.proname = $2`,
          [role, fn],
        )
        expect(r.allowed, `${role} on ${fn}`).toBe(false)
      }
    })

    test('promote_seller_destination is gone', async () => {
      const { rows: [n] } = await h.db.query<{ n: number }>(
        `select count(*)::int as n from pg_proc where proname = 'promote_seller_destination'`,
      )
      expect(n.n).toBe(0)
    })

    test('route_payout reads no backup and no backup setting', async () => {
      const { rows: [r] } = await h.db.query<{ src: string }>(
        `select prosrc as src from pg_proc where proname = 'route_payout'`,
      )
      expect(r.src).not.toMatch(/is_backup|payout_primary_attempts|payout_backup_enabled/)
      expect(r.src).toMatch(/archived_at is null/)
    })
  })
})

// ---------------------------------------------------------------------------
// The backfill
// ---------------------------------------------------------------------------

describe('§29.17 backfill — where money goes does not change', () => {
  let h: Harness
  let tenant: string

  // Seller A: five live rows — the primary, three demoted "Other" rows, a backup.
  let a: string
  let aPrimary: string
  let aBackup: string
  let aPrimaryBefore: { verified: string; hold: string }
  let aDecisionBefore: { destination_id: string | null; reason_code: string }
  // Seller B: no primary. Two live rows, and the newer one is not the backup.
  let b: string
  let bNewer: string
  let bOlderBackup: string
  // Seller C: one destination. Seller D: none.
  let c: string
  let d: string

  let rowsBefore: number
  let sellersBefore: unknown[]

  const sellersSnapshot = async () => {
    const { rows } = await h.db.query(
      `select id, beneficiary_token, masked_destination, country::text, payout_currency::text,
              payout_provider::text, destination_changed_at::text
         from sellers order by id`,
    )
    return rows
  }

  const archivedAudits = async () => {
    const { rows } = await h.db.query<{
      actor: string
      details: Record<string, unknown>
    }>(`select actor, details from audit_log where action = 'seller.destination_archived'`)
    return rows
  }

  beforeAll(async () => {
    h = await migrated({ stopBefore: MIGRATION })
    tenant = await newTenant(h.db, 'backfill-co')
    const addOld = (s: string, token: string, role: string, provider = 'flutterwave_momo') =>
      addDestination(h.db, s, tenant, token, { role, provider, masked: `Old •••• ${token.slice(-4)}` })

    // -- A: the old writer's shape, one save at a time ---------------------
    a = await newSeller(h.db, tenant, 'Five destinations')
    await h.db.query(`select verify_seller($1, 'compliance@payhold')`, [a])
    await addOld(a, 'tok_a_one', 'primary', 'flutterwave_bank')
    await addOld(a, 'tok_a_two', 'primary')
    await addOld(a, 'tok_a_three', 'primary')
    const { rows: [backup] } = await addOld(a, 'tok_a_back', 'backup', 'flutterwave_bank')
    aBackup = backup.id

    // The primary is verified and has served its hold, and the backup is
    // verified too — the strongest case the old engine could have used.
    const { rows: [primary] } = await h.db.query<{ id: string; verified: string; hold: string }>(
      `update seller_destinations
          set verified_at = now() - interval '1 day',
              security_hold_until = now() - interval '1 hour'
        where seller_id = $1 and is_primary
        returning id, verified_at::text as verified, security_hold_until::text as hold`,
      [a],
    )
    aPrimary = primary.id
    aPrimaryBefore = { verified: primary.verified, hold: primary.hold }
    await h.db.query(`update seller_destinations set verified_at = now() where id = $1`, [aBackup])
    aDecisionBefore = await route(h.db, await payoutFor(h.db, tenant, a))

    // -- B: backups added to a seller registered with no destination -------
    b = await newSeller(h.db, tenant, 'No primary', false)
    const { rows: [b1] } = await addOld(b, 'tok_b_one', 'backup')
    const { rows: [b2] } = await addOld(b, 'tok_b_two', 'backup')
    // The second backup demoted the first to no role. Make that one the newer,
    // so what is kept is decided by age and not by having been a backup.
    bNewer = b1.id
    bOlderBackup = b2.id
    await h.db.query(
      `update seller_destinations set created_at = now() - interval '1 day' where id = $1`,
      [bNewer],
    )
    await h.db.query(
      `update seller_destinations set created_at = now() - interval '2 days' where id = $1`,
      [bOlderBackup],
    )

    // -- C and D ------------------------------------------------------------
    c = await newSeller(h.db, tenant, 'One destination')
    d = await newSeller(h.db, tenant, 'No destination', false)

    const { rows: [n] } = await h.db.query<{ n: number }>(
      `select count(*)::int as n from seller_destinations`,
    )
    rowsBefore = n.n
    sellersBefore = await sellersSnapshot()

    const files = migrationFiles()
    await applyMigrations(h.db, files.slice(files.indexOf(MIGRATION)))
  }, 180_000)

  afterAll(() => h.close())

  test('the old shape really was five live rows, one of them a backup', async () => {
    // Guarding the fixture: a backfill test whose "before" was already tidy
    // proves nothing.
    const { rows: [r] } = await h.db.query<{ n: number }>(
      `select count(*)::int as n from seller_destinations where seller_id = $1`, [a],
    )
    expect(r.n).toBe(5)
    expect(aDecisionBefore.destination_id).toBe(aPrimary)
  })

  test('five live rows with one primary: the primary stays live and untouched, four are archived', async () => {
    const rows = await destinationsOf(h.db, a)
    expect(rows.filter((r) => r.archived_at === null).map((r) => r.id)).toEqual([aPrimary])

    const { rows: [kept] } = await h.db.query<{ primary: boolean; verified: string; hold: string }>(
      `select is_primary as primary, verified_at::text as verified,
              security_hold_until::text as hold
         from seller_destinations where id = $1`,
      [aPrimary],
    )
    expect(kept).toEqual({ primary: true, ...aPrimaryBefore })

    const archived = rows.filter((r) => r.archived_at !== null)
    expect(archived).toHaveLength(4)
    for (const row of archived) {
      expect(row).toMatchObject({ is_primary: false, is_backup: false, replaced_by: null })
    }
  })

  test('payouts still route to the same destination', async () => {
    const after = await route(h.db, await payoutFor(h.db, tenant, a))
    expect(after).toEqual(aDecisionBefore)
  })

  test('a backup is archived', async () => {
    const { rows: [row] } = await h.db.query<{ archived: boolean; is_backup: boolean }>(
      `select archived_at is not null as archived, is_backup from seller_destinations where id = $1`,
      [aBackup],
    )
    expect(row).toEqual({ archived: true, is_backup: false })
  })

  test('no primary and two rows: the newest stays live and is not promoted', async () => {
    const rows = await destinationsOf(h.db, b)
    const live = rows.filter((r) => r.archived_at === null)
    expect(live.map((r) => r.id)).toEqual([bNewer])
    // Promoting it would start paying a destination nothing was paying.
    expect(live[0]).toMatchObject({ is_primary: false, is_backup: false })
    expect(rows.find((r) => r.id === bOlderBackup)!.archived_at).not.toBeNull()

    // So the seller reads exactly as before: nothing registered to pay.
    const { rows: [caps] } = await h.db.query<{ reasons: string[] }>(
      `select reasons from seller_capabilities($1)`, [b],
    )
    expect(caps.reasons.join(' ')).toMatch(/No payout destination has been registered/)
  })

  test('a seller with one destination, or none, is untouched', async () => {
    const rows = await destinationsOf(h.db, c)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ is_primary: true, archived_at: null })
    expect(await destinationsOf(h.db, d)).toEqual([])

    const audits = await archivedAudits()
    expect(audits.filter((x) => x.details.seller_id === c || x.details.seller_id === d)).toEqual([])
  })

  test('one audit row per archived destination, as the system, with the mask and no token', async () => {
    const audits = await archivedAudits()
    const { rows } = await h.db.query<{ id: string }>(
      `select id from seller_destinations where archived_at is not null`,
    )
    expect(audits.map((x) => x.details.destination_id).sort()).toEqual(
      rows.map((r) => r.id).sort(),
    )
    expect(audits).toHaveLength(5)

    for (const x of audits) {
      expect(x.actor).toBe('system')
      expect(x.details.reason).toBe('one_destination_per_seller')
      expect(String(x.details.masked_destination)).toMatch(/••••/)
      expect(JSON.stringify(x.details)).not.toMatch(/tok_/)
    }
    const forA = audits.filter((x) => x.details.seller_id === a)
    expect(forA.every((x) => x.details.kept_destination_id === aPrimary)).toBe(true)
  })

  test('no rows are deleted', async () => {
    const { rows: [n] } = await h.db.query<{ n: number }>(
      `select count(*)::int as n from seller_destinations`,
    )
    expect(n.n).toBe(rowsBefore)
  })

  test('the sellers table is untouched', async () => {
    expect(await sellersSnapshot()).toEqual(sellersBefore)
  })

  test('running it again changes nothing', async () => {
    const audits = (await archivedAudits()).length
    const snapshot = await h.db.query(`select * from seller_destinations order by id`)

    await applyMigrations(h.db, [MIGRATION])

    expect((await archivedAudits()).length).toBe(audits)
    expect((await h.db.query(`select * from seller_destinations order by id`)).rows)
      .toEqual(snapshot.rows)
    expect(await sellersSnapshot()).toEqual(sellersBefore)
  })

  test('the one-live index holds afterwards', async () => {
    const { rows: [most] } = await h.db.query<{ n: number }>(
      `select coalesce(max(n), 0)::int as n from (
         select count(*) as n from seller_destinations
          where archived_at is null group by seller_id) live`,
    )
    expect(most.n).toBe(1)

    await rejects(
      () => h.db.query(
        `insert into seller_destinations (tenant_id, seller_id, country, payout_currency,
                                          payout_provider, beneficiary_token, masked_destination)
         values ($1, $2, 'RW', 'RWF', 'flutterwave_bank', 'tok_c_two', 'BK •••• 0002')`,
        [tenant, c],
      ),
      /seller_destinations_one_live/,
    )
  })
})
