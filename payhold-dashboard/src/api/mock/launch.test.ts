/**
 * §16's launch gate, and §17's non-goals as they bind this engine.
 *
 * The counterpart of `payhold-backend/tests/launch-gate.test.ts`, case for case
 * where a case makes sense on both sides. What is different is what each can
 * see: the backend audits §17 against constraints, grants and enum labels,
 * while this file audits it against the client interface — which is the surface
 * a screen could reach for, and therefore the one where "no manual mark as paid
 * control" is a claim about *methods that do not exist*.
 */

import { beforeEach, describe, expect, test } from 'vitest'
import { MockClient } from '.'
import { seedDb } from './seed'
import { getDb, resetDb } from './store'
import {
  launchBlockers,
  launchGateOpen,
  marketLaunchVerified,
  signOffLaunchItem,
} from './launch'
import { PayHoldError } from '../types'

let api: MockClient

beforeEach(() => {
  localStorage.clear()
  resetDb(seedDb)
  api = new MockClient()
})

/**
 * Sign off everything the gate waits for, blocked items aside.
 *
 * Straight through the engine rather than the client: twenty-odd calls through
 * `delay()` is five seconds of simulated latency, and the latency is not what
 * any of these tests are about. The cases that *are* about the client call it.
 */
function signEverythingSignable(): void {
  const db = getDb()
  for (const item of db.launch_checklist) {
    if (item.required && !item.blocked_by) {
      signOffLaunchItem(db, item.code, 'Amina (compliance)', 'ticket LAUNCH-1', true)
    }
  }
}

describe('§16 — the gate', () => {
  test('ships shut, with nothing signed', async () => {
    const list = await api.getLaunchChecklist()

    expect(list.live_mode_allowed).toBe(false)
    expect(list.outstanding).toBeGreaterThan(0)
    expect(list.items.every((i) => !i.signed)).toBe(true)
  })

  test('names every item §16 does', async () => {
    const { items } = await api.getLaunchChecklist()
    const codes = new Set(items.map((i) => i.code))

    for (
      const required of [
        'legal_entities', 'provider_contracts', 'merchant_accounts',
        'seller_terms', 'buyer_terms', 'privacy_notices', 'refund_policy',
        'kyc_aml_procedures', 'sanctions_process', 'tax_treatment',
        'support_escalation', 'chargeback_process', 'data_retention',
        'incident_response',
      ]
    ) {
      expect(codes.has(required), required).toBe(true)
    }
  })

  test('one written confirmation per launch market', async () => {
    const { items } = await api.getLaunchChecklist()
    const markets = items.filter((i) => i.kind === 'provider').map((i) => i.market)

    expect(markets.sort()).toEqual(['AE', 'CN', 'RW', 'US'])
  })

  test('signing everything signable still leaves it shut', async () => {
    // The reason Phase 11 is safe to run out of order: nothing an attestation
    // says makes unbuilt work exist.
    signEverythingSignable()

    const list = await api.getLaunchChecklist()
    expect(list.live_mode_allowed).toBe(false)
    expect(list.blocked).toBe(list.outstanding)
    expect(list.items.filter((i) => i.required && !i.signed).map((i) => i.code).sort())
      .toEqual(['email_confirmation', 'operator_screens'])
  })

  test('a blocked item cannot be signed, by anybody', async () => {
    await expect(
      api.signOffLaunchItem('operator_screens', 'The CTO', 'I say so'),
    ).rejects.toThrow(/blocked by phase-10/)
  })

  test('but can always be un-signed', async () => {
    // "I no longer stand behind this" is never the harder direction.
    await api.signOffLaunchItem('operator_screens', 'The CTO', 'withdrawing', false)

    const { items } = await api.getLaunchChecklist()
    expect(items.find((i) => i.code === 'operator_screens')!.signed).toBe(false)
  })

  test('clearing the last blocker opens it', async () => {
    signEverythingSignable()

    // What phase 10 and an SMTP sender do in their own migrations.
    const db = getDb()
    for (const item of db.launch_checklist) item.blocked_by = null

    await api.signOffLaunchItem('operator_screens', 'Amina', 'phase 10 shipped')
    await api.signOffLaunchItem('email_confirmation', 'Amina', 'SMTP configured')

    expect((await api.getLaunchChecklist()).live_mode_allowed).toBe(true)
  })

  test('withdrawing one closes it again, and both rows survive', async () => {
    const db = getDb()
    for (const item of db.launch_checklist) item.blocked_by = null
    signEverythingSignable()
    await api.signOffLaunchItem('operator_screens', 'Amina', 'shipped')
    await api.signOffLaunchItem('email_confirmation', 'Amina', 'configured')
    expect((await api.getLaunchChecklist()).live_mode_allowed).toBe(true)

    await api.signOffLaunchItem(
      'sanctions_process', 'Ben', 'the screening vendor contract lapsed', false,
    )

    expect((await api.getLaunchChecklist()).live_mode_allowed).toBe(false)

    // Appended, not edited — "who said this was fine, and when did they stop
    // saying it" is exactly the question asked afterwards.
    const history = getDb().launch_sign_offs.filter((s) => s.code === 'sanctions_process')
    expect(history.map((s) => s.actor)).toEqual(['Amina (compliance)', 'Ben'])
    expect(history.map((s) => s.signed)).toEqual([true, false])
  })

  test('a sign-off needs a person and a pointer to the evidence', async () => {
    await expect(api.signOffLaunchItem('buyer_terms', '  ', 'v2'))
      .rejects.toThrow(PayHoldError)
    await expect(api.signOffLaunchItem('buyer_terms', 'Amina', ''))
      .rejects.toThrow(PayHoldError)
  })

  test('an unknown item is refused rather than created', async () => {
    await expect(api.signOffLaunchItem('looks_fine', 'Amina', 'ok'))
      .rejects.toThrow(/No launch checklist item/)
  })

  test('an item on the list that does not hold the gate', async () => {
    const db = getDb()
    for (const item of db.launch_checklist) item.blocked_by = null
    signEverythingSignable()
    await api.signOffLaunchItem('operator_screens', 'Amina', 'shipped')
    await api.signOffLaunchItem('email_confirmation', 'Amina', 'configured')

    const { items, live_mode_allowed } = await api.getLaunchChecklist()
    expect(items.find((i) => i.code === 'reminders_cron')!.signed).toBe(false)
    expect(live_mode_allowed).toBe(true)
  })

  test('every sign-off is audited against the person who made it', async () => {
    await api.signOffLaunchItem('buyer_terms', 'Amina', 'terms v2')

    const entry = getDb().audit.find((a) => a.action === 'launch.signed_off')
    expect(entry?.actor).toBe('Amina')
  })
})

describe('§16 — rails_verified follows the market it is about', () => {
  test('nothing is verified before anyone confirms anything', () => {
    for (const market of ['RW', 'AE', 'CN', 'US'] as const) {
      expect(marketLaunchVerified(getDb(), market), market).toBe(false)
    }
  })

  test('confirming Rwanda does not confirm the United States', async () => {
    await api.signOffLaunchItem(
      'payout_confirmation_rw', 'Amina', 'Flutterwave payout letter, 2026-08',
    )

    expect(marketLaunchVerified(getDb(), 'RW')).toBe(true)
    expect(marketLaunchVerified(getDb(), 'US')).toBe(false)
  })

  test('a market nobody promised anything about is unverified', () => {
    // The same answer as before, arrived at by there being no item rather than
    // by a hardcoded false.
    expect(marketLaunchVerified(getDb(), 'KE')).toBe(false)
  })
})

describe('§16 — live credentials are refused while it is shut', () => {
  const LIVE_FLUTTERWAVE = {
    provider: 'flutterwave' as const,
    mode: 'live' as const,
    credentials: {
      secret_key: 'FLWSECK-live-abc',
      public_key: 'FLWPUBK-live-abc',
      encryption_key: 'abc',
      webhook_hash: 'abc',
    },
  }

  test('connecting a live account is refused, and says why', async () => {
    await expect(api.connectProvider(LIVE_FLUTTERWAVE))
      .rejects.toThrow(/test mode/)
  })

  test('and refused before the credentials are even shaped', async () => {
    // Refusing after we would have used a live secret key is refusing too late.
    // A live request with *missing* fields still fails on the gate, not on the
    // fields, which is what says the check came first.
    await expect(
      api.connectProvider({ ...LIVE_FLUTTERWAVE, credentials: {} }),
    ).rejects.toThrow(/test mode/)
  })

  test('test mode is unaffected', async () => {
    const account = await api.connectProvider({
      provider: 'flutterwave',
      mode: 'test',
      credentials: {
        secret_key: 'FLWSECK_TEST-abc',
        public_key: 'FLWPUBK_TEST-abc',
        encryption_key: 'abc',
        webhook_hash: 'abc',
      },
    })
    expect(account.mode).toBe('test')
  })

  test('and once the gate opens, live is accepted', async () => {
    const db = getDb()
    for (const item of db.launch_checklist) item.blocked_by = null
    signEverythingSignable()
    await api.signOffLaunchItem('operator_screens', 'Amina', 'shipped')
    await api.signOffLaunchItem('email_confirmation', 'Amina', 'configured')
    expect(launchGateOpen(getDb())).toBe(true)

    const account = await api.connectProvider(LIVE_FLUTTERWAVE)
    expect(account.mode).toBe('live')
  })

  test('the gate is the blockers and nothing else', () => {
    // One question, one answer. A second source for "may we go live" is how the
    // banner and the button end up disagreeing.
    expect(launchGateOpen(getDb())).toBe(launchBlockers(getDb()).length === 0)
  })
})

// ---------------------------------------------------------------------------
// §17 — the non-goals, as this engine can see them
// ---------------------------------------------------------------------------

describe('§17 — the client interface offers no way round the money path', () => {
  test('there is no "mark as paid"', () => {
    // The strongest form of the claim available here: a screen cannot call what
    // does not exist. Settling is `runCron`'s, after a simulated provider
    // answers — the same shape as `dispatchPayout` waiting on a real one.
    const methods = new Set(
      Object.getOwnPropertyNames(MockClient.prototype)
        .concat(Object.keys(api as unknown as Record<string, unknown>)),
    )

    for (const forbidden of ['markPayoutPaid', 'settlePayout', 'payPayout', 'markAsPaid']) {
      expect(methods.has(forbidden), forbidden).toBe(false)
    }
  })

  test('and no way to write a ledger entry directly', () => {
    const methods = new Set(Object.getOwnPropertyNames(MockClient.prototype))
    for (const forbidden of ['writeLedger', 'createLedgerEntry', 'adjustBalance']) {
      expect(methods.has(forbidden), forbidden).toBe(false)
    }
  })

  test('no seller is payable before somebody verifies them', async () => {
    const seller = await api.createSeller({
      name: 'Anonymous Ltd',
      country: 'RW',
      payout_currency: 'RWF',
      payout_provider: 'flutterwave_momo',
      destination: '+250788000111',
    })

    const capabilities = await api.getSellerCapabilities(seller.id)
    expect(capabilities.can_receive_payouts).toBe(false)
    expect(capabilities.reasons.length).toBeGreaterThan(0)
  })

  test('the unbuilt adapters are declared, and cannot be switched on', async () => {
    const db = getDb()
    const unbuilt = db.provider_capabilities.filter((c) => !c.implemented)

    expect(unbuilt.map((c) => c.provider).sort())
      .toEqual(['cash_app_pay', 'china_wallet_partner', 'paypal'])
    // Nothing unbuilt is ever on — the structural half of "declared but
    // disabled", §29.3.
    expect(unbuilt.every((c) => !c.enabled)).toBe(true)
  })
})
