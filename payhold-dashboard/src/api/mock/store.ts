/**
 * Mock persistence and the simulated clock.
 *
 * State lives in localStorage so a refresh doesn't wipe a demo mid-flow, and
 * so "advance time by 3 days" survives too. Bump `SCHEMA_VERSION` whenever the
 * shape changes — stale saved state is discarded and re-seeded rather than
 * migrated.
 */

import type {
  ApiKey,
  AuditLogEntry,
  Deal,
  Dispute,
  LedgerEntry,
  Payout,
  ReconciliationAlert,
  Seller,
  Tenant,
  TenantSettings,
  WebhookEndpoint,
} from '../types'

// 2: countries widened to all of Africa + US, payment_method simplified to
//    card/mobile_money/bank_transfer, deals gained payment_network.
export const SCHEMA_VERSION = 2
const STORAGE_KEY = 'payhold.mock.v1'

export interface MockDb {
  version: number
  /** Milliseconds the simulated clock runs ahead of the real one. */
  clock_offset_ms: number
  /** The tenant the dashboard is currently acting as. */
  current_tenant_id: string
  tenants: Tenant[]
  settings: TenantSettings[]
  sellers: Seller[]
  deals: Deal[]
  ledger: LedgerEntry[]
  payouts: Payout[]
  disputes: Dispute[]
  api_keys: ApiKey[]
  webhook_endpoints: WebhookEndpoint[]
  audit: AuditLogEntry[]
  alerts: ReconciliationAlert[]
  /** Set by the dev panel to make the next payout attempt fail. */
  fail_next_payout: boolean
  /** Monotonic counter behind `nextId`, so ids are stable across a session. */
  id_counter: number
}

let db: MockDb | null = null

export function loadDb(seed: () => MockDb): MockDb {
  if (db) return db

  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as MockDb
      if (parsed.version === SCHEMA_VERSION) {
        db = parsed
        return db
      }
    }
  } catch {
    // Corrupt or unreadable state is not worth recovering — re-seed.
  }

  db = seed()
  persist()
  return db
}

export function getDb(): MockDb {
  if (!db) throw new Error('Mock DB accessed before load')
  return db
}

export function persist(): void {
  if (!db) return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(db))
  } catch {
    // Over quota or private mode — the session still works, just not durably.
  }
}

export function resetDb(seed: () => MockDb): MockDb {
  localStorage.removeItem(STORAGE_KEY)
  db = seed()
  persist()
  return db
}

/**
 * A write that persists. Every mutation goes through here so no code path can
 * change state and forget to save it.
 */
export function mutate<T>(fn: (db: MockDb) => T): T {
  const result = fn(getDb())
  persist()
  return result
}

// ---------------------------------------------------------------------------
// Simulated clock
// ---------------------------------------------------------------------------

export function now(): Date {
  return new Date(Date.now() + (db?.clock_offset_ms ?? 0))
}

export function nowIso(): string {
  return now().toISOString()
}

export function advanceClock(hours: number): void {
  mutate((d) => {
    d.clock_offset_ms += hours * 3_600_000
  })
}

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

/** Readable, prefixed, stable ids — `deal_a3f`, `po_120`. */
export function nextId(prefix: string): string {
  const d = getDb()
  d.id_counter += 1
  return `${prefix}_${d.id_counter.toString(36).padStart(4, '0')}`
}

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

export function addDays(from: Date | string, days: number): string {
  const base = typeof from === 'string' ? new Date(from) : from
  return new Date(base.getTime() + days * 86_400_000).toISOString()
}

export function addHours(from: Date | string, hours: number): string {
  const base = typeof from === 'string' ? new Date(from) : from
  return new Date(base.getTime() + hours * 3_600_000).toISOString()
}

/** True when `ts` is in the past relative to the simulated clock. */
export function isDue(ts: string | null): boolean {
  return ts !== null && new Date(ts).getTime() <= now().getTime()
}
