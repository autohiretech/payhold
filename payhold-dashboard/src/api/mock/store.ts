/**
 * Mock persistence and the simulated clock.
 *
 * State lives in localStorage so a refresh doesn't wipe a demo mid-flow, and
 * so "advance time by 3 days" survives too. Bump `SCHEMA_VERSION` whenever the
 * shape changes — stale saved state is discarded and re-seeded rather than
 * migrated.
 */

import type { TenantRole } from '@/auth/types'
import type {
  AiChatMessage,
  AiSuggestion,
  ApiKey,
  AuditLogEntry,
  Deal,
  DealOutcome,
  Dispute,
  LedgerEntry,
  Payout,
  ProviderAccount,
  ReconciliationAlert,
  RequestContext,
  RiskSignal,
  Seller,
  Tenant,
  TenantSettings,
  WebhookDelivery,
  WebhookEndpoint,
} from '../types'

// 2: countries widened to all of Africa + US, payment_method simplified to
//    card/mobile_money/bank_transfer, deals gained payment_network.
// 3: deals split settlement from presentment currency for cross-border pricing.
// 4: tenants gained connected provider accounts (bring-your-own-keys).
// 5: intelligence — ai_suggestions, ai_chat, deal_outcomes; disputes gained a
//    counter-statement and evidence; settings gained the AI budget.
// 6: chat messages gained attachments. Any change to a persisted shape needs a
//    bump, including one this small — a saved message without the new field
//    passes the version check and then crashes whatever renders it.
// 7: dispute evidence gained a kind and an image url; the chat starts empty.
// 8: signed outbound webhook deliveries, deterministic risk signals, and
//    reconciliation that compares against a provider balance instead of being
//    handed an answer. Payouts gained review fields, alerts gained a rail.
// 9: accounts. The dashboard is behind a sign-in, so the mock needs the thing
//    a session resolves to — `tenant_users` in Postgres.
export const SCHEMA_VERSION = 10
const STORAGE_KEY = 'payhold.mock.v1'

/**
 * A dashboard login. Stands in for a Supabase Auth user plus its `tenant_users`
 * row — which is why the tenant is on it: signing in is what decides whose
 * deals you are looking at, exactly as an API key does for a client's server.
 *
 * The password digest here is a **simulation**. Real accounts live in Supabase
 * Auth, which hashes with bcrypt and which no browser code ever sees; this
 * exists so a build running against the mock still has a sign-in that can be
 * wrong. Nothing in localStorage is a security boundary.
 */
export interface MockAccount {
  id: string
  email: string
  full_name?: string
  password_hash: string
  password_salt: string
  tenant_id: string
  role: TenantRole
  created_at: string
  last_seen_at: string | null
}

export interface MockDb {
  version: number
  /** Milliseconds the simulated clock runs ahead of the real one. */
  clock_offset_ms: number
  /**
   * The tenant the dashboard is currently acting as.
   *
   * Signing in sets it, so it is a consequence of who is at the keyboard
   * rather than a global the screens choose. The dev panel's tenant switch is
   * the one exception, and it is dev-only.
   */
  current_tenant_id: string
  tenants: Tenant[]
  /** Dashboard logins. See `MockAccount` — the digests are a simulation. */
  accounts: MockAccount[]
  settings: TenantSettings[]
  sellers: Seller[]
  deals: Deal[]
  ledger: LedgerEntry[]
  payouts: Payout[]
  disputes: Dispute[]
  api_keys: ApiKey[]
  /**
   * Connected payment rails, per tenant. Credentials are deliberately absent —
   * the real backend encrypts them and never returns them, so storing them
   * here would let a screen depend on something that will never exist.
   */
  provider_accounts: (ProviderAccount & { tenant_id: string })[]
  /**
   * The signing secret is stored here and nowhere else, because this is the
   * backend's stand-in — `webhook_endpoints.secret_encrypted` in Postgres. It
   * never crosses the client interface: `listWebhookEndpoints` returns the
   * masked form, exactly as the real API will.
   */
  webhook_endpoints: (WebhookEndpoint & { secret: string })[]
  webhook_deliveries: WebhookDelivery[]
  audit: AuditLogEntry[]
  alerts: ReconciliationAlert[]
  /** Deterministic rule output — spec §12.3's `risk_signals`. */
  risk_signals: RiskSignal[]
  /**
   * Where payments were made from — spec §6. Observation only; nothing in the
   * engine reads it, which is exactly the state the real table is in.
   */
  request_context: RequestContext[]
  /**
   * Intelligence. Kept beside the money tables rather than inside them on
   * purpose: a suggestion is a note about a deal, never part of its state, and
   * dropping all three tables would change nothing about what a deal does.
   */
  ai_suggestions: AiSuggestion[]
  ai_chat: AiChatMessage[]
  /** Labelled terminal results — the training set of §12.3. */
  deal_outcomes: DealOutcome[]
  /** Set by the dev panel to make the next payout attempt fail. */
  fail_next_payout: boolean
  /** Same, for the next outbound webhook attempt — exercises the retry path. */
  fail_next_webhook: boolean
  /**
   * What each provider *claims* to be holding, minus what our ledger says.
   *
   * This is the mock's stand-in for calling the provider's balance API. Zero
   * (the normal case) means the two agree. The dev panel's "inject drift" sets
   * it, and the reconciliation pass discovers it — rather than being told the
   * answer, which is what would make the job untestable.
   *
   * Keyed `tenant:provider:currency`.
   */
  provider_drift: Record<string, number>
  /** Monotonic counter behind `nextId`, so ids are stable across a session. */
  id_counter: number
}

let db: MockDb | null = null

/**
 * Every field a loaded store must actually have.
 *
 * Typed as `Record<keyof MockDb, true>` so adding a field to `MockDb` without
 * adding it here is a compile error — which is the point. The version number
 * alone is not a good enough guard: it only works if everyone who changes the
 * shape remembers to bump it, and the failure when someone does not is a
 * `TypeError` deep inside a screen, days later, on one person's machine.
 * Two branches of work that each bump to the same number do it to each other
 * without anyone forgetting anything.
 */
const REQUIRED_KEYS: Record<keyof MockDb, true> = {
  version: true,
  clock_offset_ms: true,
  current_tenant_id: true,
  tenants: true,
  accounts: true,
  settings: true,
  sellers: true,
  deals: true,
  ledger: true,
  payouts: true,
  disputes: true,
  api_keys: true,
  provider_accounts: true,
  webhook_endpoints: true,
  webhook_deliveries: true,
  audit: true,
  alerts: true,
  risk_signals: true,
  request_context: true,
  ai_suggestions: true,
  ai_chat: true,
  deal_outcomes: true,
  fail_next_payout: true,
  fail_next_webhook: true,
  provider_drift: true,
  id_counter: true,
}

function isUsable(parsed: Partial<MockDb>): boolean {
  if (parsed.version !== SCHEMA_VERSION) return false
  return Object.keys(REQUIRED_KEYS).every((key) => key in parsed)
}

export function loadDb(seed: () => MockDb): MockDb {
  if (db) return db

  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as MockDb
      if (isUsable(parsed)) {
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
// Audit
// ---------------------------------------------------------------------------

/**
 * Invariant 6: every state transition writes one of these, whether or not
 * money moved.
 *
 * It lives beside persistence rather than in the engine because the engine is
 * not the only writer — the webhook dispatcher and the reconciliation pass
 * both audit, and importing them from the engine would put a cycle through the
 * module that owns the money paths.
 */
export function audit(
  db: MockDb,
  tenantId: string,
  dealId: string | null,
  actor: string,
  action: string,
  details: Record<string, unknown> = {},
): void {
  db.audit.push({
    id: nextId('aud'),
    tenant_id: tenantId,
    deal_id: dealId,
    actor,
    action,
    details,
    created_at: nowIso(),
  })
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
  return mintId(getDb(), prefix)
}

/**
 * The same counter, against a database handed in rather than the loaded one.
 *
 * The seed needs this: it runs the real risk rules over its own fixtures before
 * the store has a database to look up, and an id minted from a different
 * counter would collide with one minted later from this one.
 */
export function mintId(db: MockDb, prefix: string): string {
  db.id_counter += 1
  return `${prefix}_${db.id_counter.toString(36).padStart(4, '0')}`
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

export function addMinutes(from: Date | string, minutes: number): string {
  const base = typeof from === 'string' ? new Date(from) : from
  return new Date(base.getTime() + minutes * 60_000).toISOString()
}

/** Hours between two instants, positive when `later` is after `earlier`. */
export function hoursBetween(earlier: string, later: string): number {
  return (new Date(later).getTime() - new Date(earlier).getTime()) / 3_600_000
}

/** True when `ts` is in the past relative to the simulated clock. */
export function isDue(ts: string | null): boolean {
  return ts !== null && new Date(ts).getTime() <= now().getTime()
}
