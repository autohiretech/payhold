/**
 * The launch gate, read — §16 and §15 phase 8.
 *
 * §16 says the production release begins in test mode and §15 phase 8 says live
 * keys stay disabled until the checklist is signed off. Both are sentences about
 * a moment nobody is in the room for, so the gate is a query rather than a
 * decision somebody remembers to make: `assertLiveAllowed` is called by the one
 * endpoint that can put live credentials into the system, and there is no other
 * way in.
 *
 * The items themselves and why they are shaped this way are in migration
 * `20260807000013`. What matters here is that this module only ever *reads* —
 * signing an item is `sign_off_launch_item`, which takes a person's name.
 */

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { PayHoldError, type Country } from './types.ts'

export interface LaunchBlocker {
  code: string
  title: string
  /** The unbuilt work standing in the way, or null when it is an attestation. */
  blocked_by: string | null
}

/** Every required item nobody has signed off yet. Empty means the gate is open. */
export async function launchBlockers(
  db: SupabaseClient,
): Promise<LaunchBlocker[]> {
  const { data, error } = await db.rpc('launch_blockers')

  // A gate that fails open is not a gate. If we cannot read the checklist we do
  // not know whether we are allowed to be live, and "we do not know" has to
  // resolve the same way as "no".
  if (error) {
    throw new PayHoldError(
      'policy_violation',
      'Could not read the launch checklist, so live mode cannot be allowed',
    )
  }

  return (data ?? []) as LaunchBlocker[]
}

/**
 * Refuse live credentials while §16 is outstanding.
 *
 * The message names the count and the first few items rather than the whole
 * list: the caller is a tenant owner and the checklist is PayHold's own
 * compliance posture, so they are told the system is in test mode and roughly
 * why, not handed our legal to-do list. The full list is
 * `GET /launch-checklist`, which only a platform admin can read.
 */
export async function assertLiveAllowed(db: SupabaseClient): Promise<void> {
  const blockers = await launchBlockers(db)
  if (blockers.length === 0) return

  const named = blockers.slice(0, 3).map((b) => b.title).join(', ')
  const rest = blockers.length - Math.min(3, blockers.length)

  throw new PayHoldError(
    'policy_violation',
    `PayHold is in test mode: ${blockers.length} launch checklist ` +
      `item${blockers.length === 1 ? ' is' : 's are'} outstanding (${named}` +
      `${rest > 0 ? `, and ${rest} more` : ''}). Connect test keys for now.`,
  )
}

/**
 * Has a provider confirmed in writing that we may run marketplace payouts here?
 *
 * This is what `rails_verified` means on `/v1/payment-options`, and a client
 * should read a false as "probably" rather than "yes". It was a constant until
 * Phase 11; a market with no confirmation item is unverified, which is the
 * correct answer for every country outside §16's four.
 */
export async function marketVerified(
  db: SupabaseClient,
  country: Country,
): Promise<boolean> {
  const { data, error } = await db.rpc('market_launch_verified', {
    p_country: country,
  })
  return !error && data === true
}

/**
 * Are all four launch markets confirmed?
 *
 * The catalogue response covers every market at once and cannot answer per
 * country, so it answers for the set: anything short of all four is not
 * "verified rails" for a client reading one flag.
 */
export async function allMarketsVerified(db: SupabaseClient): Promise<boolean> {
  const { data, error } = await db.rpc('launch_status')
  if (error) return false

  const rows = (data ?? []) as { kind: string; signed: boolean }[]
  const markets = rows.filter((r) => r.kind === 'provider')

  return markets.length > 0 && markets.every((r) => r.signed)
}
