/**
 * `platform_owns_verification` (spec §29.18) — who may say a seller, or a
 * seller's payout account, has been checked, and the refusals a caller reads.
 *
 * With the setting on — the default — seller and destination verification
 * arrive only from the tenant's own platform, over its API key, naming the
 * person there who decided. Nobody signed in to PayHold can make either
 * attestation, and `seller_auto_verify` writes nothing verified.
 *
 * Pure on purpose, for `dispute-relay.ts`'s reason: `functions/sellers` and
 * `functions/settings` start a server on import, so the refusals worth pinning —
 * their codes, their statuses and what a relayed body must look like — live
 * where a test can call them. **None of this is the rule.** `verify_seller` and
 * `verify_seller_destination` re-read the settings under their row locks and
 * refuse the same things; `auto_verify_seller`, `seed_primary_destination` and
 * `add_seller_destination` ask the setting at insert.
 */

import type { Caller } from './auth.ts'
import { PayHoldError } from './types.ts'

/** A name and an address, not a document — the dispute relay's limit. */
export const VERIFIED_BY_MAX_LENGTH = 200

/** A relayed verification, validated. `verified_by` is the platform's claim. */
export interface RelayedVerification {
  verified: boolean
  verified_by: string
}

function invalid(message: string): PayHoldError {
  return new PayHoldError('invalid_request', message)
}

/**
 * The body a platform sends to `POST /v1/sellers/:id/verify` or
 * `…/destinations/:id/verify` over its API key.
 *
 * Stricter than the person path, which reads a missing `verified` as true: a
 * person is looking at a button, a server is sending a decision, and a decision
 * that did not say which way it went is not one to guess. `verified_by` must
 * name a person — a credential or the system reports nobody.
 */
export function parseRelayedVerification(raw: unknown): RelayedVerification {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw invalid('Request body must be a JSON object')
  }
  const body = raw as Record<string, unknown>

  if (typeof body.verified !== 'boolean') {
    throw invalid('verified is required, as true or false')
  }

  const verifiedBy = typeof body.verified_by === 'string' ? body.verified_by.trim() : ''
  if (!verifiedBy) {
    throw invalid('verified_by is required — name the person on your platform who checked this')
  }
  if (verifiedBy.length > VERIFIED_BY_MAX_LENGTH) {
    throw invalid(`verified_by must be ${VERIFIED_BY_MAX_LENGTH} characters or fewer`)
  }
  const lower = verifiedBy.toLowerCase()
  if (lower.startsWith('api_key:') || lower.startsWith('system')) {
    throw invalid(`verified_by must name the person who checked this, not "${verifiedBy}"`)
  }

  return { verified: body.verified, verified_by: verifiedBy }
}

/**
 * A seller write from a dashboard session needs owner or staff. A viewer
 * watches; it does not attest, move a destination or end a hold. An API key is
 * not a role and passes — what it may do is decided per route.
 *
 * 403, not the 401 `requireRole` answers with: the caller is signed in and
 * known, and signing in again would not change the answer.
 */
export function requireSellerWriter(caller: Pick<Caller, 'kind' | 'role'>): void {
  if (caller.kind === 'api_key') return
  requireSignedInWriter(caller)
}

/**
 * A signed-in person with owner or staff access, and nothing else. Explicit
 * about the caller's kind rather than leaning on `requireRole`, which returns
 * early for every API key and so keeps no key out.
 */
function requireSignedInWriter(caller: Pick<Caller, 'kind' | 'role'>): void {
  if (caller.kind === 'dashboard' && (caller.role === 'owner' || caller.role === 'staff')) return
  throw new PayHoldError(
    'forbidden',
    'Changing a seller needs owner or staff access to this account',
  )
}

/**
 * Which door a verification call may use, decided from the caller's kind and
 * the account's settings — or the refusal.
 *
 *   * an API key takes the relayed path: for a seller while the platform owns
 *     verification or the relay is on (else 422 `verification_relay_off`), for a
 *     destination only while the platform owns verification (else 422
 *     `destination_relay_off`)
 *   * a signed-in owner or staff member takes the person path, unless the
 *     platform owns verification (409 `verification_owned_by_platform`)
 *   * anyone else — a viewer, or a caller that is neither — is 403 `forbidden`
 */
export function verificationPath(
  caller: Pick<Caller, 'kind' | 'role'>,
  opts: { owned: boolean; relaying: boolean; target: 'seller' | 'destination' },
): 'relayed' | 'person' {
  if (caller.kind === 'api_key') {
    if (opts.target === 'seller') assertSellerRelayAllowed(opts.owned, opts.relaying)
    else assertDestinationRelayAllowed(opts.owned)
    return 'relayed'
  }
  requireSignedInWriter(caller)
  refusePersonWhilePlatformOwns(opts.owned)
  return 'person'
}

/**
 * `end-hold` is a person's step-up and is never relayed. Any caller that is not
 * a signed-in dashboard session is refused — in the sentence the endpoint has
 * always used — and a viewer is 403.
 */
export function assertEndHoldCaller(caller: Pick<Caller, 'kind' | 'role'>): void {
  if (caller.kind !== 'dashboard') {
    throw new PayHoldError(
      'policy_violation',
      "Ending a destination's security hold is a person's decision and cannot " +
        'be done with an API key',
    )
  }
  requireSignedInWriter(caller)
}

/** A person signed in here, while the platform owns verification. Both directions. */
export function refusePersonWhilePlatformOwns(owned: boolean): void {
  if (!owned) return
  throw new PayHoldError(
    'verification_owned_by_platform',
    'Your platform verifies sellers and their payout accounts for this account, so ' +
      'neither can be verified or un-verified in PayHold. The account owner can ' +
      'change that under Settings.',
  )
}

/**
 * A seller verification over an API key with ownership off and the relay off.
 * Ownership on supersedes a stored relay of 0.
 */
export function assertSellerRelayAllowed(owned: boolean, relaying: boolean): void {
  if (owned || relaying) return
  throw new PayHoldError(
    'verification_relay_off',
    'This account has not turned on "I review each seller myself and tell PayHold ' +
      'the result", so a seller can only be verified by a signed-in person in PayHold.',
  )
}

/** A destination verification over an API key is accepted only while ownership is on. */
export function assertDestinationRelayAllowed(owned: boolean): void {
  if (owned) return
  throw new PayHoldError(
    'destination_relay_off',
    'This account verifies payout destinations in PayHold, so an API key cannot. ' +
      'The account owner can hand verification to your platform under Settings.',
  )
}

/**
 * `seller_auto_verify` writes a seller verified before anybody has looked, which
 * is the opposite of the platform owning the decision. So while ownership is on
 * (as it will be after this patch), turning auto-verify on is refused. Sending
 * it false, or not at all, is fine — a stored 1 is inert while ownership is on.
 */
export function assertAutoVerifyAllowed(
  patch: Record<string, unknown>,
  current: { platform_owns_verification: boolean },
): void {
  const owned = typeof patch.platform_owns_verification === 'boolean'
    ? patch.platform_owns_verification
    : current.platform_owns_verification
  if (!owned || patch.seller_auto_verify !== true) return
  throw new PayHoldError(
    'auto_verify_owned_by_platform',
    'Sellers cannot be verified automatically while your platform verifies them. ' +
      'Turn off "your platform verifies sellers" first, or leave auto-verify off.',
  )
}

/**
 * A refusal raised by `verify_seller` or `verify_seller_destination`, as the error
 * the edge answers with — or null when it is none of these.
 */
export function verificationRefusal(message: string): PayHoldError | null {
  const match =
    /^(verification_owned_by_platform|verification_relay_off|destination_relay_off|invalid_request):\s*(.*)$/s
      .exec(message.trim())
  if (!match) return null
  const [, code, text] = match
  return new PayHoldError(
    code as
      | 'verification_owned_by_platform'
      | 'verification_relay_off'
      | 'destination_relay_off'
      | 'invalid_request',
    text,
  )
}
