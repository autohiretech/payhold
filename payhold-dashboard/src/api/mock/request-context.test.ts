/**
 * Where payments came from — spec §6, the mock's half.
 *
 * Two claims, and they are the two the Fraud screen rests on:
 *
 *   the observation is scoped to one tenant, like every other read; and
 *
 *   **nothing writes it from here.** There is no client method and no engine
 *   path that records an origin, because in the real system the only writers
 *   are the `/pay` handler and the provider webhook. A mock that let a screen
 *   invent an address would be teaching a capability the backend does not have.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { MockClient } from './index'
import { seedDb } from './seed'
import { loadDb, resetDb, type MockDb } from './store'

const AUTOHIRE = 'ten_0001'
const EQUIPCO = 'ten_0002'

let db: MockDb
let api: MockClient

beforeEach(() => {
  db = resetDb(seedDb)
  api = new MockClient()
})

describe('reading payment origins', () => {
  it('returns only the current tenant’s rows', async () => {
    const rows = await api.listRequestContext()

    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => r.tenant_id === AUTOHIRE)).toBe(true)
  })

  it('shows a different company nothing of this one’s', async () => {
    db.current_tenant_id = EQUIPCO
    const rows = await api.listRequestContext()

    // Same rule as every other read: the response must not reveal that another
    // tenant's rows exist at all.
    expect(rows.every((r) => r.tenant_id === EQUIPCO)).toBe(true)
    expect(rows.some((r) => r.tenant_id === AUTOHIRE)).toBe(false)
  })

  it('filters to one deal when asked', async () => {
    const all = await api.listRequestContext()
    const dealId = all[0].deal_id

    const forDeal = await api.listRequestContext(dealId)
    expect(forDeal.length).toBeGreaterThan(0)
    expect(forDeal.every((r) => r.deal_id === dealId)).toBe(true)
  })

  it('records the provenance of every address', async () => {
    const rows = await api.listRequestContext()

    // A client can tell us anything; a provider is reporting what it saw. Every
    // row has to say which it is, or the screen cannot weigh them apart.
    expect(
      rows.every((r) =>
        ['provider', 'hosted_page', 'client_attested'].includes(r.source)
      ),
    ).toBe(true)
  })

  it('leaves some deals with nothing recorded, which is normal', async () => {
    const rows = await api.listRequestContext()
    const withContext = new Set(rows.map((r) => r.deal_id))
    const funded = db.deals.filter(
      (d) => d.tenant_id === AUTOHIRE && d.status !== 'created',
    )

    // An older integration that sends nothing is a gap in a report, not a flag.
    expect(funded.some((d) => !withContext.has(d.id))).toBe(true)
  })

  it('only the provider reports a country, and never guesses one', async () => {
    const rows = await api.listRequestContext()

    for (const row of rows) {
      if (row.ip_country !== null) {
        expect(row.source).toBe('provider')
      }
    }
  })
})

describe('the mock cannot write one', () => {
  it('exposes no method that records an origin', () => {
    const methods = Object.getOwnPropertyNames(MockClient.prototype)

    // The real writers are the /pay handler and the provider webhook. If a
    // recording method ever appears on the client, the dashboard has been
    // handed a capability the backend deliberately withheld.
    expect(methods.filter((m) => /recordRequestContext|createRequestContext/.test(m)))
      .toEqual([])
  })

  it('reading an origin changes no money state', async () => {
    const before = JSON.stringify({
      ledger: db.ledger,
      deals: db.deals.map((d) => d.status),
      payouts: db.payouts.map((p) => p.status),
    })

    await api.listRequestContext()

    const after = loadDb()
    expect(
      JSON.stringify({
        ledger: after.ledger,
        deals: after.deals.map((d) => d.status),
        payouts: after.payouts.map((p) => p.status),
      }),
    ).toBe(before)
  })
})
