/**
 * How to put PayHold into an app that already exists.
 *
 * Every other screen in this dashboard answers "what happened". This one
 * answers "what do I type", which is a different job and is why it reads like
 * documentation rather than a console.
 *
 * **It is generated from this deployment, not written about it.** The base URL
 * is the project this build points at, and the checklist reads the account's
 * real keys, endpoints and rails. A setup guide that hardcoded either would go
 * stale the first time somebody deployed it somewhere else, and the reader
 * would have no way to tell — which is exactly the failure mode a copyable code
 * sample has, because it is copied and then it is gone.
 *
 * Nothing here mutates. Every fix is a link to the screen that owns it: keys
 * are issued on API keys, endpoints registered on the same screen that shows
 * their deliveries, rails connected on Payment rails. A second place to do any
 * of those is a second place to get them wrong.
 */

import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/api'
import { SUPABASE_URL } from '@/config'
import { keys } from '@/lib/queries'
import { Card, CardHeader, PageHeader, cx } from '@/components/ui'

/** The base every call in this guide is relative to, for *this* deployment. */
const API_BASE = `${SUPABASE_URL.replace(/\/+$/, '')}/functions/v1`

// ---------------------------------------------------------------------------
// Copyable code
// ---------------------------------------------------------------------------

function CodeBlock({ code, label }: { code: string; label?: string }) {
  const [copied, setCopied] = useState(false)

  return (
    <div className="relative">
      {label && (
        <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-fg-subtle">
          {label}
        </p>
      )}
      <div className="relative overflow-hidden rounded-lg border border-line bg-surface-2">
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(code)
            setCopied(true)
            window.setTimeout(() => setCopied(false), 1500)
          }}
          className={cx(
            'absolute right-2 top-2 rounded-md px-2 py-1 text-xs font-medium',
            'ring-1 ring-inset transition',
            copied
              ? 'bg-released-soft text-released ring-released/30'
              : 'bg-surface text-fg-muted ring-line hover:text-fg',
          )}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
        {/* Wide samples scroll in their own box; the page never scrolls sideways. */}
        <pre className="overflow-x-auto px-4 py-3 pr-16 text-xs leading-relaxed text-fg">
          <code className="font-mono">{code}</code>
        </pre>
      </div>
    </div>
  )
}

/**
 * One row of the endpoint reference.
 *
 * The method is a chip rather than part of the path string because scanning
 * for "the POST that resolves a dispute" is how this table is actually read.
 */
function Endpoint({
  method,
  path,
  children,
}: {
  method: 'GET' | 'POST'
  path: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t border-line px-6 py-3 first:border-t-0">
      <span
        className={cx(
          'w-11 shrink-0 rounded px-1.5 py-0.5 text-center text-[0.625rem] font-bold tracking-wide',
          method === 'GET'
            ? 'bg-held-soft text-held'
            : 'bg-brand-soft text-brand',
        )}
      >
        {method}
      </span>
      <code className="font-mono text-xs text-fg">{path}</code>
      <span className="w-full text-sm leading-relaxed text-fg-muted sm:w-auto sm:flex-1">
        {children}
      </span>
    </div>
  )
}

function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="border-t border-line bg-surface-2 px-6 py-2 text-[0.6875rem] font-semibold uppercase tracking-[0.08em] text-fg-subtle">
      {children}
    </p>
  )
}

function Step({
  n,
  title,
  children,
}: {
  n: number
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="flex gap-4 px-6 py-5">
      <div
        className={cx(
          'flex h-7 w-7 shrink-0 items-center justify-center rounded-full',
          'bg-brand-soft text-sm font-semibold text-brand',
        )}
      >
        {n}
      </div>
      <div className="min-w-0 flex-1 space-y-3">
        <h3 className="text-sm font-semibold text-fg">{title}</h3>
        {children}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// What this account has actually done
// ---------------------------------------------------------------------------

function ReadinessRow({
  done,
  label,
  detail,
  fix,
  fixLabel,
}: {
  done: boolean | undefined
  label: string
  detail: string
  fix: string
  fixLabel: string
}) {
  return (
    <div className="flex flex-wrap items-start gap-3 border-t border-line px-6 py-4 first:border-t-0">
      <span
        className={cx(
          'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold',
          done === undefined
            ? 'bg-surface-2 text-fg-subtle'
            : done
            ? 'bg-released-soft text-released'
            : 'bg-pending-soft text-pending',
        )}
        aria-hidden
      >
        {done === undefined ? '·' : done ? '✓' : '!'}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-fg">{label}</p>
        <p className="mt-0.5 text-sm leading-relaxed text-fg-muted">{detail}</p>
      </div>
      <Link
        to={fix}
        className="shrink-0 text-sm font-medium text-brand hover:underline"
      >
        {fixLabel}
      </Link>
    </div>
  )
}

export function HelpPage() {
  const apiKeys = useQuery({ queryKey: keys.apiKeys, queryFn: () => api.listApiKeys() })
  const endpoints = useQuery({
    queryKey: ['webhook-endpoints'],
    queryFn: () => api.listWebhookEndpoints(),
  })
  const rails = useQuery({ queryKey: keys.railStatus, queryFn: () => api.listRailStatus() })

  const liveKeys = apiKeys.data?.filter((k) => !k.revoked_at)
  const liveEndpoints = endpoints.data?.filter((e) => !e.disabled_at)
  // `fake` is demo mode rather than a connected rail, and counting it would
  // report an account as ready to take money when nothing can.
  const connectedRails = rails.data?.filter((r) => r.connected && r.provider !== 'fake')

  return (
    <>
      <PageHeader
        title="Integrate PayHold"
        subtitle="Put a payment hold into an app you already have. Four calls and one webhook."
      />

      {/* --- Where this account actually is ------------------------------- */}
      <Card className="mb-6">
        <CardHeader
          title="Your setup"
          subtitle="Read from this account, not a checklist to tick by hand."
        />
        <ReadinessRow
          done={liveKeys && liveKeys.length > 0}
          label="An API key"
          detail={
            liveKeys === undefined
              ? 'Checking…'
              : liveKeys.length > 0
              ? `${liveKeys.length} active. Your server sends it as X-Api-Key.`
              : 'None yet. Your server needs one to create a deal.'
          }
          fix="/api-keys"
          fixLabel="API keys"
        />
        <ReadinessRow
          done={liveEndpoints && liveEndpoints.length > 0}
          label="A webhook endpoint"
          detail={
            liveEndpoints === undefined
              ? 'Checking…'
              : liveEndpoints.length > 0
              ? `${liveEndpoints.length} registered. This is how you learn a buyer paid.`
              : 'None yet. Without one you never find out a payment arrived.'
          }
          fix="/api-keys"
          fixLabel="Webhooks"
        />
        <ReadinessRow
          done={connectedRails && connectedRails.length > 0}
          label="A connected payment rail"
          detail={
            connectedRails === undefined
              ? 'Checking…'
              : connectedRails.length > 0
              ? `${connectedRails.length} connected. Buyers can be charged for real.`
              : 'None. Deals still work end to end on demo mode, and move no money.'
          }
          fix="/rails"
          fixLabel="Payment rails"
        />
      </Card>

      {/* --- Quickstart --------------------------------------------------- */}
      <Card className="mb-6">
        <CardHeader
          title="Quickstart"
          subtitle="Your app keeps its own accounts, bookings and UI. PayHold holds the money."
        />

        <div className="divide-y divide-line">
          <Step n={1} title="Point your server at this project">
            <p className="text-sm leading-relaxed text-fg-muted">
              Two environment variables, on your <strong>server</strong>. An API
              key is a server credential: it can create deals, read every deal
              and issue refunds for your whole company, so it must never reach a
              browser bundle. Buyers never need one — the payment link carries
              its own scoped token.
            </p>
            <CodeBlock
              label="Environment"
              code={`PAYHOLD_BASE_URL=${API_BASE}\nPAYHOLD_API_KEY=ph_live_…   # API keys screen, shown once`}
            />
          </Step>

          <Step n={2} title="Create a deal when an order is placed">
            <p className="text-sm leading-relaxed text-fg-muted">
              Store the returned id against your own order row, and send the
              buyer to <code className="font-mono text-xs">payment_link</code>.
              Amounts are integer minor units. <code className="font-mono text-xs">buyer_ref</code>{' '}
              is your own identifier for the buyer and is the only buyer-side
              handle PayHold keeps — we store no buyer personal data.
            </p>
            <CodeBlock
              label="POST /deals"
              code={`const res = await fetch(\`\${process.env.PAYHOLD_BASE_URL}/deals\`, {
  method: 'POST',
  headers: {
    'X-Api-Key': process.env.PAYHOLD_API_KEY,
    'content-type': 'application/json',
  },
  body: JSON.stringify({
    buyer_ref: order.customer_id,
    seller_id: seller.payhold_seller_id,
    description: 'Order #1042',
    amount: 50000,          // minor units
    currency: 'RWF',
    metadata: { order_id: order.id },
  }),
})

const { deal, payment_link } = await res.json()`}
            />
          </Step>

          <Step n={3} title="Let the webhook tell you money arrived">
            <p className="text-sm leading-relaxed text-fg-muted">
              <strong className="text-fg">
                A buyer landing back on your success page is not proof of
                payment
              </strong>{' '}
              — it proves they came back from the provider. Only{' '}
              <code className="font-mono text-xs">order.funded_held</code> means
              the money is held. Verify the signature and bound its age, or a
              captured delivery can be replayed at you forever.
            </p>
            <CodeBlock
              label="Your endpoint"
              code={`const raw = await req.text()            // raw body — not re-serialised
const header = req.headers.get('PayHold-Signature')  // t=…,v1=…
const { t, v1 } = Object.fromEntries(
  header.split(',').map((p) => p.split('=')),
)

if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return new Response('stale', { status: 401 })

const key = await crypto.subtle.importKey(
  'raw', new TextEncoder().encode(process.env.PAYHOLD_WEBHOOK_SECRET),
  { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
)
const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(\`\${t}.\${raw}\`))
const expected = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('')

if (expected !== v1) return new Response('bad signature', { status: 401 })

const event = JSON.parse(raw)
if (event.event === 'order.funded_held') markOrderPaid(event.data.metadata.order_id)`}
            />
          </Step>

          <Step n={4} title="Confirm from both sides to release">
            <p className="text-sm leading-relaxed text-fg-muted">
              The money leaves the hold when <em>both</em> sides confirm, or
              when the auto-release timer fires. Releasing is not paying: the
              second confirmation starts the clearance window, and the payout
              goes out at the end of it.
            </p>
            <CodeBlock
              label="POST /deals/:id/confirm"
              code={`await fetch(\`\${base}/deals/\${dealId}/confirm\`, {
  method: 'POST',
  headers: { 'X-Api-Key': key, 'content-type': 'application/json' },
  body: JSON.stringify({ side: 'seller' }),   // then 'buyer'
})`}
            />
          </Step>
        </div>
      </Card>

      {/* --- Disputes ------------------------------------------------------ */}
      <Card className="mb-6">
        <CardHeader
          title="Disputes — the Resolution Center"
          subtitle="Either side can ask for something. The other has 48 hours. Nothing moves on a clock."
        />

        <div className="space-y-4 px-6 py-5">
          <p className="text-sm leading-relaxed text-fg-muted">
            Opening a dispute <strong className="text-fg">freezes the payout</strong>{' '}
            for that order. Either party may then request an update, an
            extension, a cancellation, a partial refund or a full refund — one
            open request per order at a time — and the other side accepts or
            declines it.
          </p>

          <div className="rounded-lg bg-surface-2 px-4 py-3">
            <p className="text-sm font-semibold text-fg">
              Silence lapses a request. It never accepts one.
            </p>
            <p className="mt-1 text-sm leading-relaxed text-fg-muted">
              At 48 hours the offer becomes <code className="font-mono text-xs">expired</code>{' '}
              and the dispute stays open. Nothing is refunded and nobody is paid,
              because a clock deciding either would be a machine deciding. Handle{' '}
              <code className="font-mono text-xs">dispute.offer_expired</code> as
              distinct from <code className="font-mono text-xs">offer_declined</code> —
              declining is somebody's act, and reconciling your own records needs
              to tell an answer from a silence.
            </p>
          </div>

          <CodeBlock
            label="Open a dispute, then request a partial refund"
            code={`// Freezes the payout on this deal.
const { dispute } = await post('/disputes', {
  deal_id: dealId,
  reason_code: 'not_as_described',
  statement: buyerMessage,
  disputed_amount: 20000,       // optional — bounds any resolution
  raised_by: 'buyer',
})

// Either side may ask for something. The other has 48 hours.
await post(\`/disputes/\${dispute.id}/offers\`, {
  kind: 'partial_refund',       // update | extension | cancellation |
  amount: 20000,                //   partial_refund | full_refund
  side: 'seller',
  message: 'Offering 200.00 back for the scratch.',
})

// Evidence is a description and a reference — never the file itself.
await post(\`/disputes/\${dispute.id}/evidence\`, {
  kind: 'photo',
  description: 'Front bumper at handover',
  url: 'https://yoursite.com/evidence/1042-a.jpg',
  captured_at: '2026-08-09T08:15:00Z',
})`}
          />

          <div className="rounded-lg bg-pending-soft px-4 py-3">
            <p className="text-sm font-semibold text-pending">
              Resolving refuses an API key, and refuses anyone who acted.
            </p>
            <p className="mt-1 text-sm leading-relaxed text-pending">
              A decision needs a named person, so{' '}
              <code className="font-mono text-xs">POST /disputes/:id/resolve</code>{' '}
              is a dashboard action rather than something your server calls.
              Whoever raised the dispute, made a request or answered one cannot
              be its decider — which means the operator who writes down a
              request a party made over the phone has just disqualified
              themselves from ruling on it. Decide these on{' '}
              <Link to="/disputes" className="font-semibold underline">
                Resolution
              </Link>
              .
            </p>
          </div>

          <p className="text-sm leading-relaxed text-fg-muted">
            <code className="font-mono text-xs">GET /disputes/:id/export</code>{' '}
            returns the whole case as one ordered timeline — statements, offers,
            responses and evidence — which is what a chargeback response or a
            regulator asks for.
          </p>
        </div>
      </Card>

      {/* --- Full reference ------------------------------------------------- */}
      <Card className="mb-6">
        <CardHeader
          title="Every endpoint"
          subtitle={`All relative to ${API_BASE}. Authenticate with X-Api-Key unless a row says otherwise.`}
        />

        <GroupLabel>Deals</GroupLabel>
        <Endpoint method="POST" path="/deals">
          Create the hold. Returns the deal and a payment link.
        </Endpoint>
        <Endpoint method="GET" path="/deals">
          List, this company only.
        </Endpoint>
        <Endpoint method="GET" path="/deals/:id">
          Status, timestamps, and the amount breakdown.
        </Endpoint>
        <Endpoint method="GET" path="/deals/:id/refunds">
          The refund records. A refund has a lifetime, not a moment.
        </Endpoint>
        <Endpoint method="POST" path="/deals/:id/pay">
          Start the charge on the rail the buyer's method implies.
        </Endpoint>
        <Endpoint method="POST" path="/deals/:id/confirm">
          <code className="font-mono text-xs">side=buyer|seller</code>. Both → release.
        </Endpoint>
        <Endpoint method="POST" path="/deals/:id/refund">
          Full, partial or line-item. Policy-checked.
        </Endpoint>
        <Endpoint method="POST" path="/deals/:id/deposit">
          Open a card pre-authorisation for a security deposit.
        </Endpoint>
        <Endpoint method="POST" path="/deals/:id/capture">
          Take some or all of that deposit.
        </Endpoint>
        <Endpoint method="POST" path="/deals/:id/release-deposit">
          Give all of it back.
        </Endpoint>

        <GroupLabel>Hosted checkout</GroupLabel>
        <Endpoint method="POST" path="/checkout/sessions">
          Issue a payment link. Idempotent — one live session per deal.
        </Endpoint>
        <Endpoint method="GET" path="/checkout/sessions/:id">
          Its status.
        </Endpoint>
        <Endpoint method="POST" path="/checkout/sessions/:id/cancel">
          Withdraw the link.
        </Endpoint>
        <Endpoint method="GET" path="/checkout/public/:token">
          What the buyer sees. <strong>No credential</strong> — the token is the credential.
        </Endpoint>
        <Endpoint method="POST" path="/checkout/public/:token/pay">
          The buyer picks a method and is handed to the provider.
        </Endpoint>

        <GroupLabel>Sellers</GroupLabel>
        <Endpoint method="POST" path="/sellers">
          Register a payout destination. Tokenized immediately; we never store the number.
        </Endpoint>
        <Endpoint method="GET" path="/sellers">
          List, with each one's state.{' '}
          <code className="font-mono text-xs">?external_user_id=</code> finds the one
          registered against your own identifier for that person — no match is an
          empty list, not an error.
        </Endpoint>
        <Endpoint method="GET" path="/sellers/:id/capabilities">
          Can this seller be paid, and if not, <em>every</em> reason.
        </Endpoint>
        <Endpoint method="GET" path="/sellers/:id/destinations">
          Preferred destination and verified backup.
        </Endpoint>
        <Endpoint method="GET" path="/sellers/:id/balance">
          Their wallet — buckets, and every reason something is stuck.
        </Endpoint>
        <Endpoint method="GET" path="/sellers/wallets">
          Every seller's wallet in one query.
        </Endpoint>
        <Endpoint method="POST" path="/sellers/:id/withdraw">
          Ask for cleared money. Screens and routes exactly as the nightly job does.
        </Endpoint>
        <Endpoint method="POST" path="/sellers/:id/verify">
          Record the KYC attestation. <strong>Refuses an API key</strong> — a person's decision.
        </Endpoint>

        <GroupLabel>Payouts</GroupLabel>
        <Endpoint method="GET" path="/payouts">
          List, newest first.
        </Endpoint>
        <Endpoint method="GET" path="/payouts/:id">
          One, with the signals that stopped it and the routing decision.
        </Endpoint>
        <Endpoint method="POST" path="/payouts/:id/hold">
          Stop one, with a reason. <strong>Person only</strong>, audited against them.
        </Endpoint>
        <Endpoint method="POST" path="/payouts/:id/approve-review">
          Clear a hold. <strong>Person only.</strong>
        </Endpoint>
        <Endpoint method="POST" path="/payouts/:id/retry">
          One more attempt after a provider refused it.
        </Endpoint>
        <Endpoint method="GET" path="/payout-routes">
          Which rails reach where, and which are switched on.
        </Endpoint>

        <GroupLabel>Disputes</GroupLabel>
        <Endpoint method="POST" path="/disputes">
          Open one. Freezes the payout.
        </Endpoint>
        <Endpoint method="GET" path="/disputes">
          List, newest first.
        </Endpoint>
        <Endpoint method="GET" path="/disputes/:id">
          One, with its offers, evidence and timeline.
        </Endpoint>
        <Endpoint method="POST" path="/disputes/:id/offers">
          Request an update, extension, cancellation or refund.
        </Endpoint>
        <Endpoint method="POST" path="/disputes/:id/offers/:offer/respond">
          Accept or decline. The other side only, inside 48 hours.
        </Endpoint>
        <Endpoint method="POST" path="/disputes/:id/offers/:offer/withdraw">
          Take a request back.
        </Endpoint>
        <Endpoint method="POST" path="/disputes/:id/evidence">
          A description and a reference — never the file.
        </Endpoint>
        <Endpoint method="GET" path="/disputes/:id/export">
          The whole case, for a chargeback response or a regulator.
        </Endpoint>
        <Endpoint method="POST" path="/disputes/:id/resolve">
          Decide it. <strong>Refuses an API key</strong>, and refuses anyone who acted for a side.
        </Endpoint>

        <GroupLabel>Money reads</GroupLabel>
        <Endpoint method="GET" path="/balance">
          Held, pending clearance, available, paid out. Add{' '}
          <code className="font-mono text-xs">?by=rail</code> to split per provider.
        </Endpoint>
        <Endpoint method="GET" path="/ledger">
          The entries behind those buckets. No writer, on any method.
        </Endpoint>
        <Endpoint method="GET" path="/audit-log">
          Who did what, including every act that moved no money.
        </Endpoint>
        <Endpoint method="GET" path="/risk-signals">
          What the deterministic rules noticed.
        </Endpoint>

        <GroupLabel>Catalogue and notifications</GroupLabel>
        <Endpoint method="GET" path="/payment-options">
          What a buyer in a market can pay with. <strong>Never hardcode this</strong> —
          coverage changes and a site with it baked in is wrong the day it does.
        </Endpoint>
        <Endpoint method="POST" path="/webhook-endpoints">
          Register a URL. The signing secret is returned exactly once.
        </Endpoint>
        <Endpoint method="GET" path="/webhook-endpoints?deliveries=1">
          Every attempt, with status and signature — the answer to "did you tell us?"
        </Endpoint>

        <GroupLabel>Settings and credentials</GroupLabel>
        <Endpoint method="GET" path="/settings">
          Fee rate, clearance days, currencies, risk and payout policy.
        </Endpoint>
        <Endpoint method="POST" path="/provider-accounts">
          Connect your own provider keys. Validated before stored, and the one
          door live credentials come through.
        </Endpoint>
      </Card>

      {/* --- Events -------------------------------------------------------- */}
      <Card className="mb-6">
        <CardHeader
          title="Every event"
          subtitle="One per transition. Every registered endpoint gets all of them — there is no per-event subscription."
        />
        <div className="px-6 py-5">
          {[
            ['Order', [
              ['order.payment_pending', 'A charge was started. Not money.'],
              ['order.funded_held', 'Money is held. The only proof a buyer paid.'],
              ['order.delivered', 'The seller says the work is done.'],
              ['order.accepted', 'The buyer agrees. Both sides in — the hold releases.'],
              ['order.clearing_started', 'Released, inside the clearance window.'],
              ['order.released', 'Past the window. The payout may now go.'],
              ['order.canceled', 'Called off before it was funded.'],
              ['order.expired', 'Nobody paid in time.'],
            ]],
            ['Checkout', [
              ['checkout.opened', 'A payment link was issued.'],
              ['checkout.completed', 'The buyer finished with our page. Not the funding event.'],
              ['checkout.canceled', 'The link was withdrawn.'],
            ]],
            ['Refunds', [
              ['refund.succeeded', 'A refund completed.'],
              ['refund.receivable_raised', 'Refunded after payout — the seller now owes it back.'],
            ]],
            ['Payouts', [
              ['payout.pending', 'Scheduled.'],
              ['payout.eligible', 'Cleared every check.'],
              ['payout.processing', 'With the provider, not yet settled.'],
              ['payout.paid', 'The seller has been sent their money.'],
              ['payout.failed', 'The rail refused it. It will be retried.'],
              ['payout.retry_requested', 'A person asked for one more attempt.'],
              ['payout.retries_exhausted', 'The budget is spent. No machine will try again.'],
              ['payout.blocked', 'No route, or the deal is disputed.'],
              ['payout.held_for_review', 'A risk rule stopped it.'],
              ['payout.held_by_person', 'Somebody stopped it, with a reason.'],
              ['payout.needs_verification', 'The seller has not been verified.'],
              ['payout.review_approved', 'A named person cleared the hold.'],
              ['payout.route_changed', 'It moved to the verified backup destination.'],
              ['payout.frozen', 'The whole account is stopped by reconciliation.'],
            ]],
            ['Disputes', [
              ['dispute.opened', 'A case was raised. The payout is frozen.'],
              ['dispute.offer_made', 'Somebody requested something.'],
              ['dispute.offer_accepted', 'The other side agreed.'],
              ['dispute.offer_declined', 'The other side said no. An act.'],
              ['dispute.offer_expired', '48 hours passed. A silence, not an answer.'],
              ['dispute.offer_withdrawn', 'The asker took it back.'],
              ['dispute.evidence_added', 'A photo, document or check-in was filed.'],
              ['dispute.resolved', 'A named person decided it.'],
            ]],
          ].map(([group, rows]) => (
            <div key={group as string} className="mb-5 last:mb-0">
              <p className="mb-2 text-[0.6875rem] font-semibold uppercase tracking-[0.08em] text-fg-subtle">
                {group as string}
              </p>
              <div className="space-y-1.5">
                {(rows as string[][]).map(([name, what]) => (
                  <div key={name} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                    <code className="font-mono text-xs text-brand">{name}</code>
                    <span className="text-sm leading-relaxed text-fg-muted">{what}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </Card>

      {/* --- The things that catch people ---------------------------------- */}
      <Card>
        <CardHeader
          title="Four things that catch people"
          subtitle="Each of these is deliberate, and each looks like a bug the first time."
        />
        <div className="divide-y divide-line">
          {[
            [
              'A registered seller cannot be paid yet',
              'Sellers start pending. Somebody has to attest that the identity check, the sanctions screen and the ownership check came back — and that call refuses an API key on purpose, because turning KYC into a field your server sets is not KYC. Until then their payouts sit in needs_verification. Verify them on the seller’s page.',
            ],
            [
              'Money is integer minor units, everywhere',
              'A 500.00 charge is 50000. Convert at your own display boundary and never in between — a float that has been through a division is a number that no longer sums.',
            ],
            [
              'A partial refund does not change the deal’s status',
              'A deal refunded by a third still has to be delivered, cleared and paid out for the other two thirds. Read what has gone back from the deal’s amounts, not from its status.',
            ],
            [
              'Nothing here is live until the launch checklist is signed',
              'Live provider credentials are refused while any required item is outstanding, so the whole integration is built and tested against test keys first. That is the gate working, not a misconfiguration.',
            ],
          ].map(([title, body]) => (
            <div key={title} className="px-6 py-4">
              <p className="text-sm font-semibold text-fg">{title}</p>
              <p className="mt-1 text-sm leading-relaxed text-fg-muted">{body}</p>
            </div>
          ))}
        </div>
      </Card>
    </>
  )
}
