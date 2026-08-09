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

      {/* --- Events -------------------------------------------------------- */}
      <Card className="mb-6">
        <CardHeader
          title="The events worth handling"
          subtitle="Every registered endpoint gets every event — there is no per-event subscription."
        />
        <div className="space-y-3 px-6 py-5 text-sm leading-relaxed">
          {[
            ['order.funded_held', 'Money is held. The only proof a buyer paid.'],
            ['order.delivered', 'The seller says the work is done.'],
            ['order.accepted', 'The buyer agrees. Both sides in — the hold releases.'],
            ['order.clearing_started', 'Released, inside the clearance window.'],
            ['order.released', 'Past the window. The payout may now go.'],
            ['payout.paid', 'The seller has been sent their money.'],
            ['refund.succeeded', 'A refund completed.'],
            ['dispute.opened', 'Somebody raised a case. The payout is frozen.'],
          ].map(([name, what]) => (
            <div key={name} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <code className="font-mono text-xs text-brand">{name}</code>
              <span className="text-fg-muted">{what}</span>
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
