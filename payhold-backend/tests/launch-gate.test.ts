/**
 * Spec §16 and §17 — the launch gate.
 *
 * Two halves, and they are enforced differently on purpose.
 *
 * **§16 is a list of attestations.** Legal entities, provider contracts, a
 * sanctions process, written payout confirmation per market. No test can check
 * whether a lawyer incorporated a company, so what is testable is the *gate*:
 * that it is closed until somebody signs, that a blocked item cannot be signed
 * at all, and that live provider credentials are refused while anything is
 * outstanding.
 *
 * **§17 is a list of prohibitions**, and this is where they are audited. Each
 * one below asserts against something structural — a constraint, a grant, an
 * enum with no such value, an adapter that cannot be enabled — rather than
 * against a promise in a comment. Where the only available evidence is the
 * source itself, the test reads the source.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { migrated, rejects, type Harness } from './harness'

let h: Harness
let tenant: string
/** The blockers as the migration seeded them, so tests can put them back. */
let seededBlockers: { code: string; blocked_by: string | null }[]

const FUNCTIONS = join(import.meta.dirname, '..', 'supabase', 'functions')

beforeAll(async () => {
  h = await migrated()
  const { rows } = await h.db.query<{ id: string }>(
    `insert into tenants (name, slug) values ('Launch Co', 'launch-co') returning id`,
  )
  tenant = rows[0].id

  const seeded = await h.db.query<{ code: string; blocked_by: string | null }>(
    `select code, blocked_by from launch_checklist`,
  )
  seededBlockers = seeded.rows
})

afterAll(() => h.close())

beforeEach(async () => {
  // The append-only trigger has to be stood down to reset the fixture, and
  // saying so out loud is the point: there is no delete path, so a test that
  // wants one has to switch off the control and switch it back. Anything
  // quieter would be a way round it that outlived the test file.
  await h.db.query(`alter table launch_sign_offs disable trigger launch_sign_offs_no_update`)
  await h.db.query(`delete from launch_sign_offs`)
  await h.db.query(`alter table launch_sign_offs enable trigger launch_sign_offs_no_update`)

  // Two tests clear a blocker to see the gate open. Put them back.
  for (const item of seededBlockers) {
    await h.db.query(`update launch_checklist set blocked_by = $2 where code = $1`, [
      item.code,
      item.blocked_by,
    ])
  }
})

/** Sign off everything the gate waits for, blocked items aside. */
async function signEverythingSignable(): Promise<void> {
  await h.db.query(
    `select sign_off_launch_item(code, 'Amina (compliance)', 'ticket LAUNCH-1')
       from launch_checklist where required and blocked_by is null`,
  )
}

async function gateOpen(): Promise<boolean> {
  const { rows: [g] } = await h.db.query<{ open: boolean }>(
    `select launch_gate_open() as open`,
  )
  return g.open
}

async function blockerCodes(): Promise<string[]> {
  const { rows } = await h.db.query<{ code: string }>(
    `select code from launch_blockers() order by code`,
  )
  return rows.map((r) => r.code)
}

/** Every `.ts` file under `supabase/functions`, comments stripped. */
function functionSources(): { path: string; code: string }[] {
  const out: { path: string; code: string }[] = []

  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      // Resolved dependencies, not our code.
      if (entry === 'node_modules') continue
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) {
        walk(full)
      } else if (entry.endsWith('.ts')) {
        out.push({
          path: full.slice(FUNCTIONS.length + 1),
          code: readFileSync(full, 'utf8')
            // Comments go first. Half of this codebase's comments explain what
            // it deliberately does *not* do, and matching that prose would fail
            // on the sentence promising the behaviour rather than on the code.
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/^\s*\/\/.*$/gm, ''),
        })
      }
    }
  }

  walk(FUNCTIONS)
  return out
}

// ---------------------------------------------------------------------------
// §16 — the gate
// ---------------------------------------------------------------------------

describe('§16 — the gate is closed until somebody closes it', () => {
  test('a fresh database is not allowed to take live money', async () => {
    // The state this migration ships in, and the state it must ship in: §16's
    // list is a list of things nobody has done yet.
    expect(await gateOpen()).toBe(false)
  })

  test('every item §16 names is on the list', async () => {
    const { rows } = await h.db.query<{ code: string }>(
      `select code from launch_checklist order by code`,
    )
    const codes = new Set(rows.map((r) => r.code))

    // §16's own sentence, item by item. A list that quietly loses one is the
    // failure mode of every checklist ever written.
    for (
      const required of [
        'legal_entities',
        'provider_contracts',
        'merchant_accounts',
        'seller_terms',
        'buyer_terms',
        'privacy_notices',
        'refund_policy',
        'kyc_aml_procedures',
        'sanctions_process',
        'tax_treatment',
        'support_escalation',
        'chargeback_process',
        'data_retention',
        'incident_response',
      ]
    ) {
      expect(codes.has(required), required).toBe(true)
    }
  })

  test('each of the four launch markets needs its own written confirmation', async () => {
    // §16: "written provider confirmation for marketplace payouts in Rwanda,
    // the UAE, Mainland China and the United States." Four conversations, four
    // outcomes, four rows.
    const { rows } = await h.db.query<{ market: string }>(
      `select market from launch_checklist where kind = 'provider' order by market`,
    )
    expect(rows.map((r) => r.market)).toEqual(['AE', 'CN', 'RW', 'US'])
  })

  test('signing everything signable still leaves the gate shut', async () => {
    // The reason this phase was safe to run before phase 10 finished. Nothing
    // an attestation can say makes unbuilt work exist.
    //
    // `operator_screens` used to be the second name here. Phase 10 built the
    // four screens it asks for and cleared its blocker in `20260808000001`, so
    // it is now merely unsigned rather than unsignable — which is the contract
    // `20260807000015` states and `20260807000017` already followed once.
    await signEverythingSignable()

    expect(await gateOpen()).toBe(false)
    expect(await blockerCodes()).toEqual(['email_confirmation'])
  })

  test('a blocked item cannot be signed off, by anybody', async () => {
    await rejects(
      () =>
        h.db.query(
          `select sign_off_launch_item('email_confirmation', 'The CTO', 'I say so')`,
        ),
      /cannot be signed off while it is blocked by no SMTP sender/,
    )
  })

  test('but a blocked item can always be un-signed', async () => {
    // "I no longer stand behind this" must never be the harder direction. There
    // is nothing to withdraw here, and the call is still accepted.
    await h.db.query(
      `select sign_off_launch_item('email_confirmation', 'The CTO', 'withdrawing', false)`,
    )

    const { rows: [s] } = await h.db.query<{ signed: boolean }>(
      `select signed from launch_status() where code = 'email_confirmation'`,
    )
    expect(s.signed).toBe(false)
  })

  test('clearing the last blocker opens the gate', async () => {
    await signEverythingSignable()

    // What phase 10 and an SMTP sender will do in their own migrations.
    await h.db.query(
      `update launch_checklist set blocked_by = null
        where code in ('operator_screens', 'email_confirmation')`,
    )
    expect(await gateOpen()).toBe(false)

    await h.db.query(
      `select sign_off_launch_item(code, 'Amina (compliance)', 'ticket LAUNCH-2')
         from launch_checklist where required and blocked_by is null`,
    )
    expect(await gateOpen()).toBe(true)
  })

  test('withdrawing one sign-off closes it again', async () => {
    await h.db.query(`update launch_checklist set blocked_by = null`)
    await signEverythingSignable()
    expect(await gateOpen()).toBe(true)

    await h.db.query(
      `select sign_off_launch_item('sanctions_process', 'Amina (compliance)',
                                   'the screening vendor contract lapsed', false)`,
    )

    expect(await gateOpen()).toBe(false)
    expect(await blockerCodes()).toEqual(['sanctions_process'])
  })

  test('a withdrawal is a new row, not an edit', async () => {
    // Same reasoning as the ledger: "who said this was fine, and when did they
    // stop saying it" is exactly the question asked after something goes wrong,
    // and an update erases the first half of the answer.
    await h.db.query(
      `select sign_off_launch_item('seller_terms', 'Amina', 'contract v3')`,
    )
    await h.db.query(
      `select sign_off_launch_item('seller_terms', 'Ben', 'superseded by v4', false)`,
    )

    const { rows } = await h.db.query<{ signed: boolean; actor: string }>(
      `select signed, actor from launch_sign_offs
        where code = 'seller_terms' order by created_at`,
    )
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.actor)).toEqual(['Amina', 'Ben'])
  })

  test('and the history cannot be rewritten', async () => {
    await h.db.query(
      `select sign_off_launch_item('buyer_terms', 'Amina', 'terms v2')`,
    )

    await rejects(
      () => h.db.query(`update launch_sign_offs set actor = 'somebody else'`),
      /append-only/,
    )
    await rejects(
      () => h.db.query(`delete from launch_sign_offs`),
      /append-only/,
    )
  })

  test('a sign-off needs a person and a pointer to the evidence', async () => {
    // `verify_seller` takes a name for the same reason: the row is about
    // somebody's statement, and an attestation with no evidence is their memory
    // of a Tuesday.
    await rejects(
      () => h.db.query(`select sign_off_launch_item('buyer_terms', '  ', 'v2')`),
      /sign_off_needs_an_actor/,
    )
    await rejects(
      () => h.db.query(`select sign_off_launch_item('buyer_terms', 'Amina', '')`),
      /sign_off_needs_evidence/,
    )
  })

  test('an item nobody has heard of is refused rather than created', async () => {
    await rejects(
      () => h.db.query(`select sign_off_launch_item('looks_fine', 'Amina', 'ok')`),
      /no launch checklist item called looks_fine/,
    )
  })

  test('an item that is on the list without holding the gate', async () => {
    // §26's reminders job. Named because the spec names it, not required
    // because `auto_release_at` is what actually protects a seller whose buyer
    // went quiet.
    await h.db.query(`update launch_checklist set blocked_by = null`)
    await signEverythingSignable()

    const { rows: [r] } = await h.db.query<{ signed: boolean }>(
      `select signed from launch_status() where code = 'reminders_cron'`,
    )
    expect(r.signed).toBe(false)
    expect(await gateOpen()).toBe(true)
  })
})

describe('§16 — rails_verified follows the market it is about', () => {
  test('no market is verified before anyone confirms one', async () => {
    for (const market of ['RW', 'AE', 'CN', 'US']) {
      const { rows: [v] } = await h.db.query<{ verified: boolean }>(
        `select market_launch_verified($1) as verified`, [market],
      )
      expect(v.verified, market).toBe(false)
    }
  })

  test('confirming Rwanda does not confirm the United States', async () => {
    // The reason the flag is asked per market: telling a seller in Kigali that
    // their corridor is confirmed because a different one was is the wrong
    // answer confidently given.
    await h.db.query(
      `select sign_off_launch_item('payout_confirmation_rw', 'Amina',
                                   'Flutterwave marketplace payout letter, 2026-08')`,
    )

    const { rows: [rw] } = await h.db.query<{ verified: boolean }>(
      `select market_launch_verified('RW') as verified`,
    )
    const { rows: [us] } = await h.db.query<{ verified: boolean }>(
      `select market_launch_verified('US') as verified`,
    )
    expect(rw.verified).toBe(true)
    expect(us.verified).toBe(false)
  })

  test('a market nobody promised anything about is unverified', async () => {
    // Every country outside §16's four. The same answer, arrived at by there
    // being no row rather than by a hardcoded false.
    const { rows: [ke] } = await h.db.query<{ verified: boolean }>(
      `select market_launch_verified('KE') as verified`,
    )
    expect(ke.verified).toBe(false)
  })
})

describe('§16 — the checklist is PayHold\'s, and it is not editable', () => {
  test('only a platform admin may read it', async () => {
    // Our own compliance posture, not tenant data. A tenant is told the gate is
    // closed by the refusal on the connect call, and does not get our legal
    // to-do list.
    const { rows } = await h.db.query<{ qual: string }>(
      `select qual::text from pg_policies
        where tablename = 'launch_checklist' and policyname = 'launch_checklist_read'`,
    )
    expect(rows[0].qual).toContain('is_platform_admin')
  })

  test('nobody signed in can write either table', async () => {
    for (const table of ['launch_checklist', 'launch_sign_offs']) {
      for (const verb of ['insert', 'update', 'delete']) {
        const { rows } = await h.db.query<{ allowed: boolean }>(
          `select has_table_privilege('authenticated', $1, $2) as allowed`,
          [table, verb],
        )
        expect(rows[0].allowed, `${verb} on ${table}`).toBe(false)
      }
    }
  })

  test('the AI role cannot sign anything off', async () => {
    // Invariant 9 as a grant, again. An attestation that opens the gate on live
    // credentials is one step from every money function there is.
    const { rows } = await h.db.query<{ allowed: boolean }>(
      `select has_function_privilege('payhold_ai',
        'sign_off_launch_item(text, text, text, boolean)', 'execute') as allowed`,
    )
    expect(rows[0].allowed).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// §17 — the explicit non-goals, audited
// ---------------------------------------------------------------------------

describe('§17 — no cryptocurrency', () => {
  test('no rail, adapter or route names one', async () => {
    // Checked against the enum labels rather than against a list of rows: a
    // crypto rail would need a value in one of these before it could be a row
    // at all, so this is the narrowest place the prohibition binds.
    const { rows } = await h.db.query<{ label: string }>(
      `select enumlabel as label from pg_enum e
         join pg_type t on t.oid = e.enumtypid
        where t.typname in ('provider', 'payout_provider', 'payment_method',
                            'payout_method')`,
    )

    const crypto = /crypto|bitcoin|btc|ethereum|eth|usdt|usdc|stablecoin|wallet_chain/i
    for (const row of rows) {
      expect(crypto.test(row.label), row.label).toBe(false)
    }
  })

  test('no route quotes a crypto currency', async () => {
    // `currency_code` is a three-letter domain, so `BTC` would satisfy it. What
    // stops one is that no route carries it and no market is denominated in it.
    const { rows } = await h.db.query<{ currency: string }>(
      `select distinct unnest(currencies)::text as currency from payout_routes`,
    )
    for (const row of rows) {
      expect(['BTC', 'ETH', 'USDT', 'USDC', 'XBT', 'XMR']).not.toContain(row.currency)
    }
  })
})

describe('§17 — no anonymous seller payouts', () => {
  test('an unverified seller is held, not paid', async () => {
    // §12's sentence, and the audit item that makes it §17's too: a seller must
    // not be paid because a payment webhook said "success". The eligibility
    // gate runs whatever `risk_rules_enabled` says.
    const { rows: [s] } = await h.db.query<{ id: string }>(
      `insert into sellers (tenant_id, name, country, payout_currency,
                            payout_provider, beneficiary_token, masked_destination)
       values ($1, 'Anonymous Ltd', 'RW', 'RWF', 'flutterwave_momo', 'tok_x', '••••1234')
       returning id`,
      [tenant],
    )

    const { rows: [k] } = await h.db.query<{ kyc_status: string }>(
      `select kyc_status from sellers where id = $1`, [s.id],
    )
    // Nobody has attested to anything, so nobody may be paid.
    expect(k.kyc_status).toBe('pending')

    const { rows: [c] } = await h.db.query<{ reasons: string[] }>(
      `select reasons from seller_capabilities($1)`, [s.id],
    )
    expect(c.reasons.length).toBeGreaterThan(0)
  })

  test('and no operator can approve their way past it', async () => {
    // The hole Phase 5 closed, pinned here because §17 is where somebody will
    // look for it. `needs_verification` is not on the approve button; the way
    // out is an attestation with a name on it.
    const bodies = await h.db.query<{ body: string }>(
      `select pg_get_functiondef(p.oid) as body
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'approve_payout_review'`,
    )
    expect(bodies.rows[0].body).toContain('held_for_review')
    expect(bodies.rows[0].body).not.toContain("= 'needs_verification'")
  })
})

describe('§17 — no personal-account Venmo or Cash App transfers', () => {
  test('both rails are declared, disabled, and cannot be switched on', async () => {
    const { rows } = await h.db.query<{ enabled: boolean }>(
      `select enabled from payout_routes
        where tenant_id is null and payout_provider in ('venmo', 'cash_app_pay')`,
    )
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) expect(row.enabled).toBe(false)

    // Not "nobody has turned them on" — they cannot be turned on, because the
    // adapter behind them is unbuilt and a trigger reads that. §29.3.
    await rejects(
      () =>
        h.db.query(
          `update payout_routes set enabled = true
            where tenant_id is null and payout_provider = 'venmo'`,
        ),
      /has no live adapter/,
    )
  })
})

describe('§17 — no manual "mark as paid" control anywhere', () => {
  test('a payout cannot be marked paid without the rail\'s reference', async () => {
    const { rows: [seed] } = await h.db.query<{ deal: string; seller: string }>(
      `with s as (
         insert into sellers (tenant_id, name, country, payout_currency,
                              payout_provider, beneficiary_token, masked_destination)
         values ($1, 'Paid Co', 'RW', 'RWF', 'flutterwave_momo', 'tok_p', '••••9999')
         returning id
       ), d as (
         insert into deals (tenant_id, buyer_ref, seller_id, description, amount,
                            currency, presentment_currency, presentment_amount,
                            buyer_country, provider, fee_amount, status, released_at)
         select $1, 'buyer_1', s.id, 'A rental', 100000, 'RWF', 'RWF', 100000, 'RW',
                'fake', 10000, 'released', now()
           from s returning id, seller_id
       )
       select d.id as deal, d.seller_id as seller from d`,
      [tenant],
    )

    await rejects(
      () =>
        h.db.query(
          `insert into payouts (tenant_id, deal_id, seller_id, amount, currency,
                                status, scheduled_for, paid_at)
           values ($1, $2, $3, 90000, 'RWF', 'paid', now(), now())`,
          [tenant, seed.deal, seed.seller],
        ),
      /paid_needs_a_provider_reference/,
    )
  })

  test('and an existing payout cannot be walked into paid by hand', async () => {
    // The 2am correction. A guard inside `settle_payout` would not have bound
    // this, which is why §17's "anywhere" is a constraint.
    const { rows: [seed] } = await h.db.query<{ deal: string; seller: string }>(
      `with s as (
         insert into sellers (tenant_id, name, country, payout_currency,
                              payout_provider, beneficiary_token, masked_destination)
         values ($1, 'Hand Co', 'RW', 'RWF', 'flutterwave_momo', 'tok_h', '••••8888')
         returning id
       ), d as (
         insert into deals (tenant_id, buyer_ref, seller_id, description, amount,
                            currency, presentment_currency, presentment_amount,
                            buyer_country, provider, fee_amount, status, released_at)
         select $1, 'buyer_1', s.id, 'A rental', 100000, 'RWF', 'RWF', 100000, 'RW',
                'fake', 10000, 'released', now()
           from s returning id, seller_id
       )
       select d.id as deal, d.seller_id as seller from d`,
      [tenant],
    )

    const { rows: [p] } = await h.db.query<{ id: string }>(
      `insert into payouts (tenant_id, deal_id, seller_id, amount, currency,
                            status, scheduled_for)
       values ($1, $2, $3, 90000, 'RWF', 'scheduled', now()) returning id`,
      [tenant, seed.deal, seed.seller],
    )

    await rejects(
      () =>
        h.db.query(
          `update payouts set status = 'paid', paid_at = now() where id = $1`,
          [p.id],
        ),
      /paid_needs_a_provider_reference/,
    )
  })

  test('only the dispatch path settles a payout', async () => {
    // "Anywhere" includes the API surface. `settle_payout` is reachable from
    // exactly one module, the one that has just heard back from a provider —
    // and no endpoint offers it to a caller.
    const callers = functionSources()
      .filter((f) => f.code.includes('settle_payout'))
      .map((f) => f.path)

    expect(callers).toEqual(['_shared/dispatch.ts'])
  })
})

describe('§17 — no unverified destinations', () => {
  test('a destination nobody verified holds the payout', async () => {
    const { rows: [s] } = await h.db.query<{ id: string }>(
      `insert into sellers (tenant_id, name, country, payout_currency,
                            payout_provider, beneficiary_token, masked_destination)
       values ($1, 'Fresh Co', 'RW', 'RWF', 'flutterwave_momo', 'tok_f', '••••7777')
       returning id`,
      [tenant],
    )

    const { rows: [d] } = await h.db.query<{ verified_at: string | null }>(
      `select verified_at from seller_destinations where seller_id = $1 and is_primary`,
      [s.id],
    )
    // A destination arrives unverified and stays that way until somebody says
    // otherwise. §5.1's change protection is the same fact on a timer.
    expect(d.verified_at).toBeNull()

    const { rows: [c] } = await h.db.query<{ reasons: string[] }>(
      `select reasons from seller_capabilities($1)`, [s.id],
    )
    expect(c.reasons.join(' ')).toMatch(/destination/i)
  })
})

describe('§17 — no pooled company funds represented as customer holdings', () => {
  test('every provider credential belongs to a tenant', async () => {
    // Bring-your-own-keys is the structural half of this: buyer money lands in
    // that company's own provider balance, so there is no PayHold-owned pot for
    // anything to be pooled in. A nullable tenant here is what a pool would
    // look like.
    const { rows: [c] } = await h.db.query<{ nullable: string }>(
      `select is_nullable as nullable from information_schema.columns
        where table_name = 'tenant_provider_accounts' and column_name = 'tenant_id'`,
    )
    expect(c.nullable).toBe('NO')
  })

  test('and every ledger entry does too', async () => {
    const { rows: [c] } = await h.db.query<{ nullable: string }>(
      `select is_nullable as nullable from information_schema.columns
        where table_name = 'ledger' and column_name = 'tenant_id'`,
    )
    expect(c.nullable).toBe('NO')
  })

  test('a balance is derived from the ledger and is never a column', async () => {
    // §5's rule, checked where it would be broken: the moment somebody adds a
    // cached balance, the number can disagree with the entries behind it and a
    // pool becomes representable.
    const { rows } = await h.db.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_name = 'tenants' and column_name like '%balance%'`,
    )
    expect(rows).toEqual([])
  })
})

describe('§17 — no promise that every method works everywhere', () => {
  test('the unbuilt adapters are named and refused rather than absent', async () => {
    // §29.3. The point of declaring them is that a seller who picks one gets a
    // specific sentence; the point of `implemented = false` is that the
    // sentence is a refusal.
    const { rows } = await h.db.query<{ provider: string }>(
      `select provider::text from provider_capabilities
        where not implemented order by provider::text`,
    )
    expect(rows.map((r) => r.provider)).toEqual([
      'cash_app_pay',
      'china_wallet_partner',
      'paypal',
    ])
  })

  test('loadProvider throws for them rather than reaching for the fake', async () => {
    // A deal routed to an adapter that silently collected nothing would be
    // worse than a loud failure. Note what the loader does *not* do: it never
    // names the three, it reads `implemented` off the capability row — which is
    // why a fourth unbuilt adapter needs no code here at all.
    const loader = functionSources().find((f) => f.path === '_shared/load-provider.ts')!

    expect(loader.code).toContain('implemented')

    // There are two routes to the demo rail and both are §12's: `rail ===
    // 'fake'`, and a tenant who has connected nothing. What matters is that the
    // refusal sits *between* them — an unbuilt adapter is thrown out before
    // anything can fall back to a charge that collects nothing and says it
    // worked.
    expect(loader.code.indexOf('declared but not built'))
      .toBeLessThan(loader.code.lastIndexOf('new FakeProvider('))
  })
})

// ---------------------------------------------------------------------------
// The gate, from the outside
// ---------------------------------------------------------------------------

describe('live credentials are refused while the gate is shut', () => {
  test('the only writer of provider credentials asks first', async () => {
    // The gate is one call in one endpoint, and that is defensible only because
    // there is exactly one way live credentials enter the system. If a second
    // writer of `tenant_provider_accounts` ever appears, this fails.
    const writers = functionSources()
      .filter((f) => /from\('tenant_provider_accounts'\)[\s\S]{0,200}(upsert|insert|update)\(/.test(f.code))
      .map((f) => f.path)

    expect(writers).toEqual(['provider-accounts/index.ts'])

    const connect = functionSources().find((f) => f.path === 'provider-accounts/index.ts')
    expect(connect!.code).toContain('assertLiveAllowed')
  })

  test('and it is asked before the credentials are used', async () => {
    // Refusing after we have sent a live secret key to the provider would have
    // already used it.
    const connect = functionSources().find((f) => f.path === 'provider-accounts/index.ts')!
    expect(connect.code.indexOf('assertLiveAllowed'))
      .toBeLessThan(connect.code.indexOf('validateFlutterwaveCredentials('))
  })
})
