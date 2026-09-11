/**
 * The two relays' starting states on the Settings screen.
 *
 * Save writes **every** setting this form holds, so a checkbox's initial state is
 * not a display detail: whatever it starts as is stored the first time anybody
 * saves anything. Each relay's default therefore lives in three places — the SQL
 * helper its money function re-checks, `settings.ts`'s fallback, and here — and
 * all three must agree. The backend two are pinned in
 * `payhold-backend/tests/dispute-decision-relay.test.ts` and
 * `_shared/dispute-relay.test.ts`; this pins the third.
 *
 * Read as source rather than mounted, the way the backend pins a refusal's
 * sentence: what matters is the literal default, and a mounted form would only
 * show it after a settings read had already overwritten it.
 */

import { describe, expect, it } from 'vitest'
import source from './Settings.tsx?raw'

describe('dispute_decision_relay starts off', () => {
  it('the checkbox starts unticked', () => {
    expect(source).toMatch(/const \[relayDisputes, setRelayDisputes\] = useState\(false\)/)
  })

  it('an account that never saved it reads as off', () => {
    expect(source).toMatch(/setRelayDisputes\(settings\.data\.dispute_decision_relay \?\? false\)/)
  })

  it('it is saved with the rest of the form', () => {
    expect(source).toMatch(/dispute_decision_relay: relayDisputes/)
  })

  it('only the owner can change it', () => {
    expect(source).toMatch(/disabled=\{!isOwner\}/)
    expect(source).toMatch(/const isOwner = account\?\.role === 'owner'/)
  })
})

describe('seller_verification_relay keeps its own default', () => {
  it('starts ticked, and an account that never saved it reads as on', () => {
    // On since 20260911000001, deliberately the opposite of the dispute relay.
    expect(source).toMatch(/const \[relayVerify, setRelayVerify\] = useState\(true\)/)
    expect(source).toMatch(/setRelayVerify\(settings\.data\.seller_verification_relay \?\? true\)/)
  })
})
