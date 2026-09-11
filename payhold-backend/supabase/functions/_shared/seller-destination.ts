/**
 * One live payout destination per seller (spec §29.17) — the refusals a caller
 * reads at the edge.
 *
 * Pure on purpose, for `dispute-relay.ts`'s reason: `functions/sellers` starts a
 * server when imported, so the parts worth pinning — which status each refusal
 * answers with, and which request shapes are accepted — live here where a test
 * can call them. **None of this is the rule.** `add_seller_destination`,
 * `request_withdrawal`, `verify_seller_destination` and `end_destination_hold`
 * refuse the same things under the seller's or the destination's lock; this file
 * turns what they raise into a code and a status instead of a 500.
 */

import { PayHoldError } from './types.ts'

/** Word for word what `add_seller_destination` raises, and what a client reads. */
export const ONE_DESTINATION_MESSAGE =
  'A seller has one payout destination; adding one replaces the current one.'

/**
 * `role` on `POST /v1/sellers/:id/destinations`.
 *
 * Absent and `'primary'` are the same request and both are accepted silently —
 * live AutoHire sends `role: 'primary'` on every save. Anything else, `'backup'`
 * included, is a 400: there is no second destination for it to be.
 */
export function assertDestinationRole(role: unknown): void {
  if (role === undefined || role === null || role === 'primary') return
  throw new PayHoldError('backup_destination_removed', ONE_DESTINATION_MESSAGE)
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * `destination_id` on `POST /v1/sellers/:id/withdraw`, before it reaches SQL.
 *
 * Absent (or null) is valid and means the seller's live destination — that is
 * what AutoHire sends. A value that is not a uuid can never be the live row, and
 * letting Postgres reject its syntax would answer with that parser's words.
 */
export function withdrawalDestination(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value === 'string' && UUID.test(value.trim())) return value.trim()
  throw notLive(String(value))
}

function notLive(id: string): PayHoldError {
  return new PayHoldError(
    'destination_not_live',
    `Destination ${id} is not this seller's current payout destination. ` +
      'Leave destination_id out to withdraw to the current one.',
  )
}

/**
 * A refusal raised by one of the destination functions, as the error the edge
 * should answer with — or null when it is none of these, so the caller keeps its
 * own mapping for everything else.
 *
 * The SQL message leads with the code (`destination_archived: …`), the same
 * convention every function here uses; the prefix is stripped so the client
 * reads a sentence.
 */
export function destinationRefusal(message: string): PayHoldError | null {
  const match = /^(backup_destination_removed|destination_archived|destination_not_live):\s*(.*)$/s
    .exec(message.trim())
  if (!match) return null
  const [, code, text] = match
  return new PayHoldError(
    code as 'backup_destination_removed' | 'destination_archived' | 'destination_not_live',
    text,
  )
}
