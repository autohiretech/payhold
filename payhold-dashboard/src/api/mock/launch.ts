/**
 * §16's launch checklist and the gate it feeds.
 *
 * The mirror of `20260807000015_launch_gate.sql` — the same items in the same
 * order, the same blocked-cannot-be-signed rule, the same append-only history.
 * A change to either is a change to both.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * §16 says the production release begins in test mode and §15 phase 8 says live
 * keys stay disabled until the checklist is signed off. Both are sentences
 * about a moment nobody is in the room for, so the gate is a query rather than
 * a decision somebody remembers to make: `connectProvider` asks it, and there
 * is no other way live credentials enter the system.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * §17's non-goals are deliberately **not** items here. They are prohibitions
 * rather than tasks, nothing about them gets signed, and each is refused by
 * something structural elsewhere in this engine. `launch.test.ts` audits them.
 */

import type {
  Country,
  LaunchChecklist,
  LaunchChecklistItem,
  LaunchItem,
  LaunchItemKind,
  LaunchSignOff,
} from '../types'
import { PayHoldError } from '../types'
import { mintId, nowIso, type MockDb } from './store'

function item(
  code: string,
  title: string,
  detail: string,
  kind: LaunchItemKind,
  opts: { market?: Country; required?: boolean; blocked_by?: string } = {},
): LaunchChecklistItem {
  return {
    code,
    title,
    detail,
    kind,
    market: opts.market ?? null,
    required: opts.required ?? true,
    blocked_by: opts.blocked_by ?? null,
  }
}

/**
 * §16's list, in the order the section writes it.
 *
 * The wording of each title tracks the spec's own sentence so the list can be
 * diffed against it by eye; `detail` is what the person signing is claiming,
 * which is the part that stops a checklist becoming a row of ticks somebody
 * clicked through.
 */
export function platformLaunchChecklist(): LaunchChecklistItem[] {
  return [
    // --- Legal and commercial ---------------------------------------------
    item('legal_entities', 'Legal entities',
      'The operating company exists in each jurisdiction where PayHold contracts with a tenant or a provider, and its registration numbers are on file.',
      'legal'),
    item('provider_contracts', 'Provider contracts',
      'Signed agreements with Flutterwave and Stripe covering marketplace payments, held by the company rather than by an individual.',
      'legal'),
    item('merchant_accounts', 'Merchant accounts',
      'Live merchant accounts exist on every rail we intend to enable, and the test and live key pairs are distinct and separately stored.',
      'legal'),
    item('seller_terms', 'Seller terms',
      'Terms sellers accept before a payout destination is registered, covering the clearance window, reserves, refunds and how a dispute is decided.',
      'legal'),
    item('buyer_terms', 'Buyer terms',
      'Terms a buyer sees before paying, describing the hold, when money is released, and how to open a dispute. The language rule binds this text.',
      'legal'),
    item('privacy_notices', 'Privacy notices',
      'A published notice naming what we store, why, and for how long — including the payment origins §23 keeps indefinitely by decision.',
      'legal'),
    item('refund_policy', 'Refund and cancellation rules',
      'The published rules a tenant’s buyers rely on, consistent with §7.1’s four lifecycle positions and with the asynchronous refund timing §7.1.6 warns about.',
      'legal'),
    item('tax_treatment', 'Tax treatment',
      'How collected tax is accounted for and remitted in each launch market. Booking it as `fees_retained` is a ledger position, not an answer to this.',
      'legal'),

    // --- Operational -------------------------------------------------------
    item('kyc_aml_procedures', 'KYC/AML procedures',
      'The written procedure behind seller verification — what is checked, by whom, what is kept, and how often it is refreshed.',
      'operational'),
    item('sanctions_process', 'Sanctions process',
      'Who runs the screen, against which list, how a hit is escalated, and how the screening date is kept from going stale.',
      'operational'),
    item('support_escalation', 'Support escalation path',
      'A named route from a stuck buyer or seller to a person who can act, including out of hours. A post-payout refund escalates to exactly this.',
      'operational'),
    item('chargeback_process', 'Chargeback response process',
      'Who answers a chargeback, within what deadline, with what evidence. One arriving during clearing lands on a deal with a payout already scheduled.',
      'operational'),
    item('data_retention', 'Data-retention policy',
      'What is deleted when. Payment origins are kept indefinitely so a fraud model has history to train on, which makes the stated purpose and the deletion path obligations rather than options.',
      'operational'),
    item('incident_response', 'Incident-response plan',
      'The runbook for a leaked key, a provider outage and a reconciliation freeze, naming who is called.',
      'operational'),
    item('penetration_test', 'Penetration test',
      'An external test against the deployed project, with findings closed or accepted in writing.',
      'operational'),
    item('secrets_review', 'Secrets review',
      'Every secret is set, held only where it belongs, and rotatable. The credentials key is not in CI, in a build log, or on a laptop.',
      'operational'),
    item('compliance_sign_off', 'Compliance sign-off',
      'A named person has read this whole list and the §17 non-goals and agrees PayHold may take live money. Signed last, on purpose.',
      'operational'),
    item('cron_scheduled', 'Scheduled jobs are running',
      'The cron schedules have been applied to this environment and the jobs are returning 200. A deployed function nothing invokes is a job that silently never runs.',
      'operational'),

    // --- §16's written provider confirmation, one per launch market --------
    //
    // Four rows because they are four conversations with four outcomes, and
    // because `rails_verified` answers per market: telling a seller in Kigali
    // that their corridor is confirmed because a different one was is the wrong
    // answer confidently given.
    item('payout_confirmation_rw', 'Written payout confirmation — Rwanda',
      'Flutterwave has confirmed in writing that we may run marketplace payouts to Rwandan recipients under this account. Stripe cannot, which is why the corridor rides Flutterwave.',
      'provider', { market: 'RW' }),
    item('payout_confirmation_ae', 'Written payout confirmation — United Arab Emirates',
      'A provider has confirmed in writing that we may run marketplace payouts to recipients in the UAE.',
      'provider', { market: 'AE' }),
    item('payout_confirmation_cn', 'Written payout confirmation — Mainland China',
      'An approved local structure exists for Mainland China payouts. §5 forbids promising the corridor before one does, which is why both wallet rails ship disabled.',
      'provider', { market: 'CN' }),
    item('payout_confirmation_us', 'Written payout confirmation — United States',
      'Stripe has confirmed in writing that we may run Connect marketplace payouts to United States recipients under this account.',
      'provider', { market: 'US' }),

    // --- §28's testing gate ------------------------------------------------
    //
    // Attestations, not tests. Every suite in this repository runs in a browser
    // against a simulation; none of it is the deployed project.
    item('walkthrough_money_path', 'Sandbox walkthrough — the money path',
      'Against the real project: pay with a test card and test mobile money, held, confirm twice, release, clearance, payout. Plus the refund path and the timer path.',
      'operational'),
    item('walkthrough_forged_webhook', 'Sandbox walkthrough — a forged webhook returns 401',
      'An inbound webhook with a wrong signature is refused on every rail, and nothing about the deal moves.',
      'operational'),
    item('walkthrough_tenancy', 'Sandbox walkthrough — the way in',
      'Sign up, land in an empty company, sign out, sign back in. A call with no token returns 401; one carrying another company’s session returns that company’s nothing.',
      'operational'),
    item('walkthrough_v2_paths', 'Sandbox walkthrough — the V2 paths',
      'A partial refund at each of §7.1’s four positions; a routing failure that falls back to a verified backup; a payout to an unverified seller that is refused; a country closed in data that disappears from checkout with no redeploy.',
      'operational'),

    // --- Engineering: acceptance is code ----------------------------------
    //
    // The first three are unblocked because the work landed — phases 8 and 9.
    // In the backend that is a `to_regclass` check at seed time plus one
    // migration clearing `dispute_window`; here it is simply the absence of a
    // `blocked_by`, because a browser has no catalogue to introspect. Either
    // way somebody still signs them, with evidence: existence is what rules out
    // signing something that cannot work, not what says it does.
    item('dispute_window', 'A dispute resolves inside its window without a person',
      '§8’s 48-hour offer window expires into the platform rule, and a dispute freezes release and payout for the disputed amount only. Note that the resolution is bounded by the disputed amount rather than splitting the payout.',
      'engineering'),
    item('reconciliation_runs', 'Every reconciliation pass leaves a run record',
      '§13’s run record — provider, period, matched, missing, mismatched, resolution — alongside the alert. A mismatch produces a case and never silently alters a balance.',
      'engineering'),
    item('payout_retry', 'A failed payout retries with backoff, then waits for a person',
      '§13: capped exponential backoff, then blocked for an operator. A retry that is only ever a person pressing a button is safe, and is not what §13 describes.',
      'engineering'),

    // Unblocked by phase 10, which built the last two of the four screens it
    // names — the Resolution Center and the reconciliation Passes card.
    // Mirrors `20260808000001_operator_screens.sql`. Still unsigned: that the
    // screens exist is a fact, and whether a case can be read from them is the
    // judgement the checklist is for.
    item('operator_screens', 'An operator can read what they are being asked to decide',
      'A held payout shows its routing decision and reason codes, the seller’s KYC state, the dispute behind it and the reconciliation run that froze the tenant. Invariant 11 puts a person on the button; they need the case in front of them.',
      'engineering'),

    // --- Engineering, blocked by work that is not done ---------------------
    item('email_confirmation', 'A signed-up address is proven',
      'Email confirmation is on with a real sender. Today addresses are confirmed on creation because there is no way to send anything, so a dashboard login’s address is unproven — and that session reads every deal a company has.',
      'engineering', { blocked_by: 'no SMTP sender configured' }),

    // On the list because §26 names it, and not worth holding a launch for:
    // `auto_release_at` is what actually protects a seller whose buyer went
    // quiet.
    item('reminders_cron', 'Reminders',
      '§26’s fifth job. It needs a channel to remind people on before it can be a function, and the auto-release timer already covers the money.',
      'engineering', { required: false, blocked_by: 'no notification channel decided' }),
  ]
}

/** The latest statement about an item, or none. */
function latestSignOff(db: MockDb, code: string): LaunchSignOff | undefined {
  return db.launch_sign_offs
    .filter((s) => s.code === code)
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0]
}

/**
 * Every item with its current state.
 *
 * The state is the latest sign-off rather than a stored flag, the same reasoning
 * as `payoutDisplayStatus` and `checkoutSessionState`: a stored value needs a
 * writer, and the writer would be the thing that already wrote the event.
 */
export function launchStatus(db: MockDb): LaunchItem[] {
  return db.launch_checklist.map((seed) => {
    const last = latestSignOff(db, seed.code)
    return {
      ...seed,
      signed: last?.signed ?? false,
      signed_by: last?.actor ?? null,
      signed_at: last?.created_at ?? null,
      evidence: last?.evidence ?? null,
    }
  })
}

/** What is still standing between us and live money. Required items only. */
export function launchBlockers(db: MockDb): LaunchItem[] {
  return launchStatus(db).filter((i) => i.required && !i.signed)
}

export function launchGateOpen(db: MockDb): boolean {
  return launchBlockers(db).length === 0
}

export function launchChecklist(db: MockDb): LaunchChecklist {
  const items = launchStatus(db)
  const outstanding = items.filter((i) => i.required && !i.signed)

  return {
    live_mode_allowed: outstanding.length === 0,
    outstanding: outstanding.length,
    blocked: outstanding.filter((i) => i.blocked_by !== null).length,
    items,
  }
}

/**
 * Has a provider confirmed in writing that we may run marketplace payouts here?
 *
 * What `rails_verified` means. A market with no confirmation item is
 * unverified, which is the right answer for every country outside §16's four.
 */
export function marketLaunchVerified(db: MockDb, country: Country): boolean {
  return launchStatus(db)
    .some((i) => i.kind === 'provider' && i.market === country && i.signed)
}

/** All four, for the answers that cover every market at once. */
export function allMarketsLaunchVerified(db: MockDb): boolean {
  const markets = launchStatus(db).filter((i) => i.kind === 'provider')
  return markets.length > 0 && markets.every((i) => i.signed)
}

/**
 * Record that an item is done, or withdraw that.
 *
 * A blocked item is refused **whatever the caller's authority** — the point of
 * `blocked_by` is that no amount of seniority makes an unbuilt screen exist.
 * Withdrawing is always allowed: "I no longer stand behind this" must never be
 * the harder direction.
 */
export function signOffLaunchItem(
  db: MockDb,
  code: string,
  actor: string,
  evidence: string,
  signed: boolean,
): void {
  const seed = db.launch_checklist.find((i) => i.code === code)
  if (!seed) {
    throw new PayHoldError('not_found', `No launch checklist item called ${code}`)
  }
  if (!actor.trim()) {
    throw new PayHoldError('policy_violation', 'A sign-off needs a person’s name')
  }
  if (!evidence.trim()) {
    throw new PayHoldError(
      'policy_violation',
      'A sign-off needs a pointer to the evidence',
    )
  }
  if (signed && seed.blocked_by) {
    throw new PayHoldError(
      'policy_violation',
      `${code} cannot be signed off while it is blocked by ${seed.blocked_by}`,
    )
  }

  db.launch_sign_offs.push({
    id: mintId(db, 'lso'),
    code,
    signed,
    actor,
    evidence,
    created_at: nowIso(),
  })
}
