/**
 * The one line that swaps mock for real.
 *
 * When payhold-backend exists, add `HttpClient` implementing `PayHoldClient`
 * and pick it here based on an env flag. Nothing else in the app changes.
 */

import type { PayHoldClient } from './client'
import { MockClient } from './mock'

export const api: PayHoldClient = new MockClient()

export * from './client'
export * from './types'
