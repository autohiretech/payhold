/**
 * What signing in has to be true of, whichever backend is behind it.
 *
 * These run against `MockAuthBackend`, but every assertion below is a claim
 * about the *product* — a wrong password is refused, a new company starts
 * empty, a session resolves to exactly one tenant — and so they are the
 * acceptance spec for the `account` Edge Function in the same way
 * `engine.test.ts` is for the money paths.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MockAuthBackend } from './mock'
import { AuthError } from './types'
import { DEMO_LOGINS, seedDb } from '@/api/mock/seed'
import { getDb, resetDb } from '@/api/mock/store'
import { MockClient } from '@/api/mock'

const DEMO = DEMO_LOGINS[0]!
const SECOND = DEMO_LOGINS[1]!

function newBackend(): MockAuthBackend {
  return new MockAuthBackend()
}

beforeEach(() => {
  localStorage.clear()
  resetDb(seedDb)
})

describe('signing in', () => {
  it('accepts a seeded account and resolves it to one company', async () => {
    const account = await newBackend().signIn(DEMO.email, DEMO.password)

    expect(account.email).toBe(DEMO.email)
    expect(account.tenant_name).toBe(DEMO.company)
    expect(account.role).toBe('owner')
  })

  it('refuses a wrong password', async () => {
    await expect(newBackend().signIn(DEMO.email, 'not-the-password')).rejects.toThrow(
      AuthError,
    )
  })

  it('says the same thing about an unknown address as about a wrong password', async () => {
    const auth = newBackend()

    const unknown = await auth.signIn('nobody@example.com', 'whatever-1234').catch(
      (e: Error) => e.message,
    )
    const wrong = await auth.signIn(DEMO.email, 'wrong-password').catch(
      (e: Error) => e.message,
    )

    // Different messages would answer "does this company bank here?" for
    // anyone who asked.
    expect(unknown).toBe(wrong)
  })

  it('is case- and whitespace-insensitive about the address', async () => {
    const account = await newBackend().signIn(
      `  ${DEMO.email.toUpperCase()} `,
      DEMO.password,
    )
    expect(account.email).toBe(DEMO.email)
  })

  it('sets which tenant the API reads — signing in is what scopes the app', async () => {
    await newBackend().signIn(SECOND.email, SECOND.password)
    expect(getDb().current_tenant_id).toBe(SECOND.tenant_id)

    await newBackend().signIn(DEMO.email, DEMO.password)
    expect(getDb().current_tenant_id).toBe(DEMO.tenant_id)
  })
})

describe('the session', () => {
  it('survives a reload', async () => {
    await newBackend().signIn(DEMO.email, DEMO.password)

    const restored = await newBackend().restore()
    expect(restored?.email).toBe(DEMO.email)
  })

  it('restores the tenant it belongs to, not whatever was last saved', async () => {
    await newBackend().signIn(SECOND.email, SECOND.password)

    // Something else moved the store's idea of "current" — the dev panel's
    // tenant switch does exactly this.
    getDb().current_tenant_id = DEMO.tenant_id

    await newBackend().restore()
    expect(getDb().current_tenant_id).toBe(SECOND.tenant_id)
  })

  it('is gone after signing out', async () => {
    const auth = newBackend()
    await auth.signIn(DEMO.email, DEMO.password)
    await auth.signOut()

    expect(await newBackend().restore()).toBeNull()
  })

  it('is not a session when the account behind it has gone', async () => {
    await newBackend().signIn(DEMO.email, DEMO.password)
    resetDb(() => ({ ...seedDb(), accounts: [] }))

    expect(await newBackend().restore()).toBeNull()
  })
})

describe('creating an account', () => {
  const NEW = {
    company_name: 'Kigali Machinery',
    email: 'ops@kigali-machinery.example',
    password: 'a-long-enough-password',
  }

  it('creates the company, signs them in, and makes them its owner', async () => {
    const account = await newBackend().signUp(NEW)

    expect(account.tenant_name).toBe('Kigali Machinery')
    expect(account.role).toBe('owner')
    expect(getDb().current_tenant_id).toBe(account.tenant_id)
    expect(await newBackend().restore()).not.toBeNull()
  })

  it('starts the company empty — no fixtures, no other tenant’s data', async () => {
    await newBackend().signUp(NEW)
    const api = new MockClient()

    expect(await api.listDeals()).toEqual([])
    expect(await api.listSellers()).toEqual([])
    expect(await api.listPayouts()).toEqual([])
    expect(await api.listDisputes()).toEqual([])
  })

  it('gives the company workable settings, so a deal can be created on day one', async () => {
    await newBackend().signUp(NEW)
    const settings = await new MockClient().getSettings()

    expect(settings.service_fee_rate).toBe(0.1)
    // §6.1 / §29.7 — 14 calendar days for a new company. V1 defaulted to 7.
    expect(settings.clearance_days).toBe(14)
    expect(settings.auto_release_days).toBe(3)
    expect(settings.currencies.length).toBeGreaterThan(0)
  })

  it('writes one audit row, against the person, in the new company', async () => {
    const account = await newBackend().signUp(NEW)

    const audit = getDb().audit.filter((a) => a.tenant_id === account.tenant_id)
    expect(audit).toHaveLength(1)
    expect(audit[0]?.action).toBe('account.created')
    expect(audit[0]?.actor).toBe(`user:${NEW.email}`)
  })

  it('refuses an address that already has an account', async () => {
    await expect(
      newBackend().signUp({ ...NEW, email: DEMO.email }),
    ).rejects.toThrow(AuthError)
  })

  it('refuses a short password — the same floor the backend enforces', async () => {
    await expect(
      newBackend().signUp({ ...NEW, password: 'short' }),
    ).rejects.toThrow(/at least 12/)
  })

  it('refuses something that is not an email address', async () => {
    await expect(
      newBackend().signUp({ ...NEW, email: 'not-an-address' }),
    ).rejects.toThrow(AuthError)
  })

  it('gives two companies with the same name different slugs', async () => {
    await newBackend().signUp(NEW)
    await newBackend().signUp({ ...NEW, email: 'second@example.com' })

    const slugs = getDb()
      .tenants.filter((t) => t.name === NEW.company_name)
      .map((t) => t.slug)

    expect(slugs).toHaveLength(2)
    expect(new Set(slugs).size).toBe(2)
  })

  it('lets the new owner sign back in afterwards', async () => {
    await newBackend().signUp(NEW)
    await newBackend().signOut()

    const back = await newBackend().signIn(NEW.email, NEW.password)
    expect(back.email).toBe(NEW.email)
  })
})

describe('a stored mock db that does not match this code', () => {
  it('is discarded rather than half-used, whatever its version says', async () => {
    // The failure this guards against: two branches that each bump
    // SCHEMA_VERSION to the same number. The stored state passes the version
    // check and then explodes on the field it does not have — as a `TypeError`
    // inside a screen, on one person's machine, days later.
    const stale: Record<string, unknown> = { ...seedDb() }
    delete stale.accounts
    localStorage.setItem('payhold.mock.v1', JSON.stringify(stale))

    // A fresh module registry, because `loadDb` caches the store the moment
    // anything touches it — so only a re-import reads localStorage again, the
    // way a page load does.
    vi.resetModules()
    const { MockAuthBackend: Fresh } = await import('./mock')

    const account = await new Fresh().signIn(DEMO.email, DEMO.password)
    expect(account.email).toBe(DEMO.email)
  })
})
