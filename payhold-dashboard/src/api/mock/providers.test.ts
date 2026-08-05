/**
 * Connecting a company's own payment rails (bring-your-own-keys).
 *
 * These mirror the guards in the backend's `provider-accounts` function. Where
 * the two disagree, the dashboard would appear to accept something the real API
 * rejects — so these tests are as much about the contract as the mock.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { MockClient } from './index'
import { resetDb } from './store'
import { seedDb } from './seed'
import { PayHoldError } from '../types'

const FLW_TEST = {
  secret_key: 'FLWSECK_TEST-abc123-X',
  public_key: 'FLWPUBK_TEST-def456-X',
  encryption_key: 'FLWSECK_TESTe1a2b3',
  webhook_hash: 'verif-hash-value',
}

const FLW_LIVE = { ...FLW_TEST, secret_key: 'FLWSECK-live0987-X' }

let api: MockClient

beforeEach(() => {
  resetDb(seedDb)
  api = new MockClient()
})

describe('rail status', () => {
  it('starts with nothing connected and the demo rail active', async () => {
    const rails = await api.listRailStatus()

    expect(rails.find((r) => r.provider === 'flutterwave')?.connected).toBe(false)
    expect(rails.find((r) => r.provider === 'stripe')?.connected).toBe(false)
    // Demo mode is what a brand-new company actually runs on — §12.
    expect(rails.find((r) => r.provider === 'fake')?.connected).toBe(true)
  })

  it('turns the demo rail off as soon as a real one is connected', async () => {
    await api.connectProvider({
      provider: 'flutterwave',
      mode: 'test',
      credentials: FLW_TEST,
    })

    const rails = await api.listRailStatus()
    expect(rails.find((r) => r.provider === 'flutterwave')?.connected).toBe(true)
    expect(rails.find((r) => r.provider === 'fake')?.connected).toBe(false)
  })
})

describe('connecting', () => {
  it('records the rail and its mode', async () => {
    const account = await api.connectProvider({
      provider: 'flutterwave',
      mode: 'test',
      credentials: FLW_TEST,
    })

    expect(account.provider).toBe('flutterwave')
    expect(account.mode).toBe('test')

    const accounts = await api.listProviderAccounts()
    expect(accounts).toHaveLength(1)
  })

  it('never returns the credentials it was given', async () => {
    await api.connectProvider({
      provider: 'flutterwave',
      mode: 'test',
      credentials: FLW_TEST,
    })

    // The whole security posture rests on this: credentials go in and never
    // come out, in any shape, to any caller.
    const serialised = JSON.stringify(await api.listProviderAccounts())
    for (const value of Object.values(FLW_TEST)) {
      expect(serialised).not.toContain(value)
    }
  })

  it('rejects a missing credential field with a pointer to where to find it', async () => {
    await expect(
      api.connectProvider({
        provider: 'flutterwave',
        mode: 'test',
        credentials: { secret_key: FLW_TEST.secret_key },
      }),
    ).rejects.toThrow(/public_key/)
  })

  it('refuses a live key connected as test', async () => {
    // The dangerous direction: a live key in "test" mode would move real money
    // during the sandbox walkthrough.
    await expect(
      api.connectProvider({
        provider: 'flutterwave',
        mode: 'test',
        credentials: FLW_LIVE,
      }),
    ).rejects.toThrow(/live secret key/)
  })

  it('refuses a test key connected as live', async () => {
    await expect(
      api.connectProvider({
        provider: 'flutterwave',
        mode: 'live',
        credentials: FLW_TEST,
      }),
    ).rejects.toThrow(/test secret key/)
  })

  it('replaces keys rather than creating a second account for the rail', async () => {
    await api.connectProvider({
      provider: 'flutterwave',
      mode: 'test',
      credentials: FLW_TEST,
    })
    await api.connectProvider({
      provider: 'flutterwave',
      mode: 'live',
      credentials: FLW_LIVE,
    })

    const accounts = await api.listProviderAccounts()
    expect(accounts).toHaveLength(1)
    expect(accounts[0]?.mode).toBe('live')
  })

  it('writes an audit entry without the credentials in it', async () => {
    await api.connectProvider({
      provider: 'flutterwave',
      mode: 'test',
      credentials: FLW_TEST,
    })

    const log = await api.listAuditLog()
    const entry = log.find((e) => e.action === 'provider.connected')
    expect(entry).toBeDefined()

    const serialised = JSON.stringify(entry)
    for (const value of Object.values(FLW_TEST)) {
      expect(serialised).not.toContain(value)
    }
  })
})

describe('disconnecting', () => {
  it('removes a rail once its money has settled', async () => {
    await api.connectProvider({
      provider: 'stripe',
      mode: 'test',
      credentials: { secret_key: 'sk_test_x', webhook_secret: 'whsec_x' },
    })

    // The seeded tenant has live Stripe deals, so clear them the way a real
    // company would: refund what is still held, and let the clearance timer
    // pay out what has already been released.
    for (const deal of await api.listDeals()) {
      if (deal.provider !== 'stripe') continue
      if (['funded_held', 'confirmed_buyer', 'confirmed_seller'].includes(deal.status)) {
        await api.refundDeal(deal.id, 'Closing this rail')
      }
    }
    await api.sim.advanceTime(24 * 30)
    await api.sim.runCron()

    await api.disconnectProvider('stripe')
    expect(await api.listProviderAccounts()).toHaveLength(0)
  })

  it('is blocked while deals still hold money on that rail', async () => {
    // The seeded tenant has live deals on Flutterwave. Disconnecting would
    // strand them: no payout could be sent and no refund issued, because the
    // credentials to do either would be gone.
    await api.connectProvider({
      provider: 'flutterwave',
      mode: 'test',
      credentials: FLW_TEST,
    })

    await expect(api.disconnectProvider('flutterwave')).rejects.toThrow(
      PayHoldError,
    )
    await expect(api.disconnectProvider('flutterwave')).rejects.toThrow(
      /still holds? money/,
    )
  })
})

describe('requirements', () => {
  it('describes what each rail needs and where to get it', async () => {
    const reqs = await api.listProviderRequirements()

    const flw = reqs.find((r) => r.provider === 'flutterwave')
    expect(flw?.fields).toContain('secret_key')
    expect(flw?.fields).toContain('webhook_hash')
    expect(flw?.where).toMatch(/Flutterwave/)

    const stripe = reqs.find((r) => r.provider === 'stripe')
    expect(stripe?.fields).toContain('webhook_secret')
  })
})
