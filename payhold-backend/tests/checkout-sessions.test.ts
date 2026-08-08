/**
 * Spec §10.1 — hosted checkout sessions.
 *
 * The first suite is §15 phase 2's acceptance criterion, and it is the reason
 * this file exists: *"test payments cannot be marked successful without
 * verified provider events."* That already held before sessions; the whole risk
 * of the phase is that a session object becomes the way around it, so the
 * property is tested against the session functions rather than assumed.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { migrated, rejects, type Harness } from './harness'

let h: Harness
let tenant: string
let seller: string

beforeAll(async () => {
  h = await migrated()
  const { rows: [t] } = await h.db.query<{ id: string }>(
    `insert into tenants (name, slug) values ('Checkout Co', 'checkout-co') returning id`,
  )
  tenant = t.id

  const { rows: [s] } = await h.db.query<{ id: string }>(
    `insert into sellers (tenant_id, name, country, payout_currency, payout_provider,
                          beneficiary_token, masked_destination)
     values ($1, 'Kigali Rentals', 'RW', 'RWF', 'flutterwave_momo',
             'tok_checkout', 'MTN •••• 1234')
     returning id`,
    [tenant],
  )
  seller = s.id
})

afterAll(() => h.close())

beforeEach(async () => {
  await h.db.query(`delete from checkout_sessions`)
})

async function newDeal(status = 'created'): Promise<string> {
  const { rows: [d] } = await h.db.query<{ id: string }>(
    `insert into deals (tenant_id, buyer_ref, seller_id, description, amount, currency,
                        presentment_currency, presentment_amount, buyer_country,
                        provider, fee_amount, status)
     values ($1, 'buyer_1', $2, 'A rental', 100000, 'RWF', 'RWF', 100000, 'RW',
             'flutterwave', 10000, $3::deal_status)
     returning id`,
    [tenant, seller, status],
  )
  return d.id
}

interface Session {
  id: string
  deal_id: string
  token: string
  status: string
  expires_at: string
  completed_at: string | null
  method: string | null
  provider: string | null
}

async function open(deal: string, hours = 24): Promise<Session> {
  // `select * from fn(...)`, never `select (fn(...)).*`. The second form
  // re-evaluates the function **once per output column** — a dozen calls
  // wearing the shape of one, which for a non-idempotent function means the
  // test is not testing what it appears to.
  const { rows: [s] } = await h.db.query<Session>(
    `select * from open_checkout_session($1, $2, null)`, [deal, hours],
  )
  return s
}

async function complete(session: string): Promise<Session> {
  const { rows: [s] } = await h.db.query<Session>(
    `select * from complete_checkout_session($1, 'card', 'Visa', 'flutterwave',
                                             'flw_ref_1', 'https://pay/x')`,
    [session],
  )
  return s
}

async function dealStatus(deal: string): Promise<string> {
  const { rows: [d] } = await h.db.query<{ status: string }>(
    `select status::text from deals where id = $1`, [deal],
  )
  return d.status
}

// ---------------------------------------------------------------------------
// §15 phase 2 — the acceptance criterion
// ---------------------------------------------------------------------------

describe('§15 phase 2 — a session cannot mark a payment successful', () => {
  test('completing one leaves the deal at payment_pending, never funded', async () => {
    const deal = await newDeal()
    const session = await open(deal)

    expect(await dealStatus(deal)).toBe('checkout_started')

    await complete(session.id)

    // The furthest a session goes. `funded_held` is the provider webhook's, and
    // only after it checks a signature *and* re-fetches the transaction.
    expect(await dealStatus(deal)).toBe('payment_pending')
  })

  test('and writes no ledger entry at all', async () => {
    const deal = await newDeal()
    await complete((await open(deal)).id)

    const { rows: [c] } = await h.db.query<{ n: string }>(
      `select count(*) as n from ledger where deal_id = $1`, [deal],
    )
    expect(Number(c.n)).toBe(0)
  })

  test('no checkout function can reach funded_held', async () => {
    // Belt to the braces above: the *text* of these functions never names the
    // state. A future edit that tried would have to change this test, which is
    // the point of asserting on the source rather than only on behaviour.
    // Comments stripped first: these functions explain at length why they do
    // not fund a deal, and matching that prose would fail on the sentence
    // promising the behaviour rather than on the behaviour.
    const { rows } = await h.db.query<{ proname: string; body: string }>(
      `select p.proname,
              regexp_replace(pg_get_functiondef(p.oid), '--[^\n]*', '', 'g') as body
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname in ('open_checkout_session', 'complete_checkout_session',
                            'cancel_checkout_session')`,
    )

    expect(rows).toHaveLength(3)
    for (const fn of rows) {
      expect(fn.body.includes('funded_held'), fn.proname).toBe(false)
      expect(fn.body.includes('write_ledger'), fn.proname).toBe(false)
    }
  })

  test('the AI role cannot open or complete a checkout', async () => {
    // Invariant 9, as a grant. None of these moves money, and that is exactly
    // why they belong on the list — the argument for an exception would be "it
    // is only a checkout", and the list is what stops that being had one
    // function at a time.
    for (
      const fn of
        ['open_checkout_session', 'complete_checkout_session', 'cancel_checkout_session']
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

// ---------------------------------------------------------------------------
// Opening
// ---------------------------------------------------------------------------

describe('opening a session', () => {
  test('gives checkout_started its first writer', async () => {
    // Declared in Phase 1 and unreachable since. §6 keeps it separate from
    // `payment_pending` so "the buyer has somewhere to pay" and "the buyer's
    // card is being charged" are not the same fact.
    const deal = await newDeal()
    expect(await dealStatus(deal)).toBe('created')

    await open(deal)
    expect(await dealStatus(deal)).toBe('checkout_started')
  })

  test('a second call returns the same session rather than a second link', async () => {
    // Two open sessions would be two live payment links against one hold, and a
    // buyer following the older one would start a second charge for the same
    // booking. This also makes a client retrying the call idempotent.
    const deal = await newDeal()
    const first = await open(deal)
    const second = await open(deal)

    expect(second.id).toBe(first.id)
    expect(second.token).toBe(first.token)

    const { rows: [c] } = await h.db.query<{ n: string }>(
      `select count(*) as n from checkout_sessions where deal_id = $1`, [deal],
    )
    expect(Number(c.n)).toBe(1)
  })

  test('a declined card gets a fresh link without a new deal', async () => {
    const deal = await newDeal('payment_failed')
    const session = await open(deal)

    expect(session.status).toBe('open')
    expect(await dealStatus(deal)).toBe('checkout_started')
  })

  test('a deal already mid-payment is refused', async () => {
    // A buyer mid-payment on one rail must not be handed a second link, or two
    // charges race for one hold.
    const deal = await newDeal('payment_pending')

    await rejects(() => open(deal), /is payment_pending, so a checkout cannot be opened/)
  })

  test('a funded deal is refused', async () => {
    const deal = await newDeal('funded_held')
    await rejects(() => open(deal), /cannot be opened/)
  })

  test('tokens are unguessable and unique', async () => {
    const tokens = new Set<string>()

    for (let i = 0; i < 5; i++) {
      const session = await open(await newDeal())
      // 32 bytes base64url. A uuid would be 122 bits wearing a recognisable
      // shape, and this is the only thing between a stranger and a payment page.
      expect(session.token.length).toBeGreaterThanOrEqual(40)
      expect(session.token).toMatch(/^[A-Za-z0-9_-]+$/)
      tokens.add(session.token)
    }

    expect(tokens.size).toBe(5)
  })

  test('an expired session is replaced rather than blocking a new one', async () => {
    const deal = await newDeal()
    const stale = await open(deal)

    await h.db.query(
      `update checkout_sessions set expires_at = now() - interval '1 hour' where id = $1`,
      [stale.id],
    )

    const fresh = await open(deal)
    expect(fresh.id).not.toBe(stale.id)

    // The old one is closed on the way past — otherwise the partial unique
    // index would refuse the replacement.
    const { rows: [old] } = await h.db.query<{ status: string }>(
      `select status::text from checkout_sessions where id = $1`, [stale.id],
    )
    expect(old.status).toBe('canceled')
  })
})

// ---------------------------------------------------------------------------
// The derived state
// ---------------------------------------------------------------------------

describe('expiry is derived, not stored', () => {
  test('a session past its expiry reads as expired without anything running', async () => {
    // The same reasoning as §5.1's `clearing` and `available`: a stored value
    // needs a writer, and the writer would be a sweep that has not run yet.
    // Deriving it means the refusal starts the instant it expires.
    const session = await open(await newDeal())

    const state = async () => {
      const { rows: [r] } = await h.db.query<{ s: string }>(
        `select checkout_session_state(c) as s from checkout_sessions c where c.id = $1`,
        [session.id],
      )
      return r.s
    }

    expect(await state()).toBe('open')

    await h.db.query(
      `update checkout_sessions set expires_at = now() - interval '1 second' where id = $1`,
      [session.id],
    )

    expect(await state()).toBe('expired')

    // And the stored column is untouched, which is what "derived" means.
    const { rows: [row] } = await h.db.query<{ status: string }>(
      `select status::text from checkout_sessions where id = $1`, [session.id],
    )
    expect(row.status).toBe('open')
  })

  test('an expired session cannot be completed', async () => {
    const session = await open(await newDeal())
    await h.db.query(
      `update checkout_sessions set expires_at = now() - interval '1 second' where id = $1`,
      [session.id],
    )

    await rejects(() => complete(session.id), /this checkout session is expired/)
  })

  test('the shortest a link can live is an hour', async () => {
    // `greatest(p_hours, 1)`. A zero or negative value would mint a link that
    // was expired before it was sent, which is a support ticket rather than a
    // security improvement.
    const session = await open(await newDeal(), 0)
    expect(new Date(session.expires_at).getTime()).toBeGreaterThan(Date.now())
  })
})

// ---------------------------------------------------------------------------
// Completing
// ---------------------------------------------------------------------------

describe('completing a session', () => {
  test('records what the buyer chose, on the session and on the deal', async () => {
    const deal = await newDeal()
    const session = await complete((await open(deal)).id)

    expect(session.status).toBe('completed')
    expect(session.completed_at).not.toBeNull()
    expect(session.method).toBe('card')
    expect(session.provider).toBe('flutterwave')

    // The rail is on the deal too, so an operator sees where the payment went
    // while it is still pending.
    const { rows: [d] } = await h.db.query<{ provider: string; method: string }>(
      `select provider::text, payment_method::text as method from deals where id = $1`,
      [deal],
    )
    expect(d.provider).toBe('flutterwave')
    expect(d.method).toBe('card')
  })

  test('the provisional rail is replaced by the one the buyer actually used', async () => {
    // A deal routed to Flutterwave at creation becomes a Stripe deal if the
    // buyer pays by international card, and the ledger follows the rail that
    // holds the money.
    const deal = await newDeal()
    const session = await open(deal)

    await h.db.query(
      `select complete_checkout_session($1, 'card', 'Visa', 'stripe', 'cs_1', 'https://pay/y')`,
      [session.id],
    )

    const { rows: [d] } = await h.db.query<{ provider: string }>(
      `select provider::text from deals where id = $1`, [deal],
    )
    expect(d.provider).toBe('stripe')
  })

  test('a session cannot be used twice', async () => {
    const session = await open(await newDeal())
    await complete(session.id)

    await rejects(() => complete(session.id), /this checkout session is completed/)
  })

  test('checkout.completed is queued, and is not the funding event', async () => {
    // §10.2. Distinct from `order.funded_held` on purpose: one says the buyer is
    // done with our page, the other says money arrived, and a client that
    // conflated them would ship goods against a card that has not settled.
    await h.db.query(
      `insert into webhook_endpoints (tenant_id, url, secret_encrypted, masked_secret)
       values ($1, 'https://client.example/hooks', 'x', 'whsec_••••1234')`,
      [tenant],
    )

    const deal = await newDeal()
    await complete((await open(deal)).id)

    const { rows } = await h.db.query<{ event: string }>(
      `select event from webhook_deliveries where deal_id = $1 order by created_at`,
      [deal],
    )

    expect(rows.map((r) => r.event)).toContain('checkout.completed')
    expect(rows.map((r) => r.event)).not.toContain('order.funded_held')

    await h.db.query(`delete from webhook_endpoints where tenant_id = $1`, [tenant])
    await h.db.query(`delete from webhook_deliveries where deal_id = $1`, [deal])
  })
})

// ---------------------------------------------------------------------------
// Cancelling
// ---------------------------------------------------------------------------

describe('cancelling a session', () => {
  test('withdraws the link and puts the deal back', async () => {
    const deal = await newDeal()
    const session = await open(deal)

    await h.db.query(`select cancel_checkout_session($1, 'ops@payhold')`, [session.id])

    expect(await dealStatus(deal)).toBe('created')

    const { rows: [row] } = await h.db.query<{ status: string }>(
      `select status::text from checkout_sessions where id = $1`, [session.id],
    )
    expect(row.status).toBe('canceled')
  })

  test('a used session cannot be withdrawn', async () => {
    const session = await open(await newDeal())
    await complete(session.id)

    await rejects(
      () => h.db.query(`select cancel_checkout_session($1, 'ops@payhold')`, [session.id]),
      /already been used/,
    )
  })

  test('a deal that has moved on keeps its own status', async () => {
    // A withdrawn payment link is not a statement about a deal that has been
    // funded, disputed or canceled since.
    const deal = await newDeal()
    const session = await open(deal)
    await h.db.query(`update deals set status = 'canceled' where id = $1`, [deal])

    await h.db.query(`select cancel_checkout_session($1, 'ops@payhold')`, [session.id])

    expect(await dealStatus(deal)).toBe('canceled')
  })

  test('cancelling frees the deal for a new session', async () => {
    const deal = await newDeal()
    const first = await open(deal)
    await h.db.query(`select cancel_checkout_session($1, 'ops@payhold')`, [first.id])

    const second = await open(deal)
    expect(second.id).not.toBe(first.id)
  })
})

// ---------------------------------------------------------------------------
// Reachability
// ---------------------------------------------------------------------------

describe('sessions are readable by their tenant and writable by nobody', () => {
  test('only the service role may open, complete or cancel one', async () => {
    for (
      const fn of
        ['open_checkout_session', 'complete_checkout_session', 'cancel_checkout_session']
    ) {
      for (const role of ['anon', 'authenticated']) {
        const { rows } = await h.db.query<{ allowed: boolean }>(
          `select bool_or(has_function_privilege($1, p.oid, 'execute')) as allowed
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = $2`,
          [role, fn],
        )
        expect(rows[0].allowed, `${role} on ${fn}`).toBe(false)
      }
    }
  })

  test('a dashboard session reads its own and writes none', async () => {
    const { rows: [read] } = await h.db.query<{ allowed: boolean }>(
      `select has_table_privilege('authenticated', 'checkout_sessions', 'select') as allowed`,
    )
    expect(read.allowed).toBe(true)

    for (const verb of ['insert', 'update', 'delete']) {
      const { rows } = await h.db.query<{ allowed: boolean }>(
        `select has_table_privilege('authenticated', 'checkout_sessions', $1) as allowed`,
        [verb],
      )
      expect(rows[0].allowed, verb).toBe(false)
    }
  })
})
