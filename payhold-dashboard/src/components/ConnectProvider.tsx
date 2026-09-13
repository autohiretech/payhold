/**
 * Connecting a company's own payment account.
 *
 * Bring-your-own-keys: the buyer's money lands in *this company's* Flutterwave
 * or Stripe balance. PayHold orchestrates and never holds the funds itself.
 *
 * Three things this form does deliberately:
 *
 *   1. **Never renders a stored credential.** The API does not return them, in
 *      any form, so there is nothing to prefill. Rotating is re-entering, and
 *      that is the honest interaction rather than a limitation to apologise for.
 *   2. **Warns before live.** Live keys move real money on the first charge.
 *      The mode picker is not a quiet dropdown.
 *   3. **Shows the provider's own error verbatim.** "Those credentials were
 *      refused by Flutterwave: …" is far more useful than "Invalid input", and
 *      the backend validates against the provider before storing.
 */

import { useState } from 'react'
import type { Provider, ProviderRequirement } from '@/api'
import { api } from '@/api'
import { PROVIDER_LABEL } from '@/lib/rails'
import { useMoneyMutation } from '@/lib/queries'
import { Button, Card, Field, Input, Select, cx } from './ui'

/** Human labels for the credential fields each rail asks for. */
const FIELD_LABEL: Record<string, string> = {
  secret_key: 'Secret key',
  public_key: 'Public key',
  publishable_key: 'Publishable key',
  encryption_key: 'Encryption key',
  webhook_hash: 'Webhook secret hash',
  webhook_secret: 'Webhook signing secret',
  client_id: 'Client ID',
  client_secret: 'Client secret',
  webhook_id: 'Webhook ID',
}

/**
 * What a correct value looks like, so a mispaste is obvious before submitting.
 *
 * **Keyed by rail, because `secret_key` means different things on each.** This
 * map used to be flat, which showed Flutterwave's `FLWSECK_TEST-` hint to
 * somebody pasting a Stripe key — a hint that is wrong is worse than none,
 * since it tells you to go back and find a value that does not exist.
 */
const FIELD_HINT: Record<string, Record<string, string>> = {
  flutterwave: {
    secret_key: 'Starts FLWSECK_TEST- for test, FLWSECK- for live',
    public_key: 'Starts FLWPUBK',
    encryption_key: 'Shown next to your API keys',
    webhook_hash: 'The value you set as the secret hash on the webhook page',
  },
  stripe: {
    secret_key: 'Starts sk_test_ for test, sk_live_ for live',
    publishable_key: 'Starts pk_test_ or pk_live_',
    webhook_secret: 'Starts whsec_ — the signing secret for the endpoint, not its URL',
  },
  paypal: {
    client_id: 'Sandbox and Live are separate apps with separate credentials',
    client_secret: 'Shown once when the app is created. Generate a new one if you no longer have it',
    webhook_id: 'Starts WH-. From the same app’s Webhooks section — the id, not the URL',
  },
}

/**
 * Which values are actually secret, and therefore masked.
 *
 * The rest are public by design — a publishable key is printed in a checkout
 * page's own JavaScript, and a webhook id names a resource rather than
 * authorising anything. Masking them would be theatre with a cost: you cannot
 * check a long pasted string against the provider's dashboard through dots, and
 * treating everything as dangerous is how the one field that *is* dangerous
 * stops standing out.
 */
const SECRET_FIELDS = new Set([
  'secret_key',
  'encryption_key',
  'webhook_hash',
  'webhook_secret',
  'client_secret',
])

/**
 * The address the provider has to be told about, and the one part of connecting
 * a rail that happens on *their* dashboard rather than this one.
 *
 * Every inbound webhook is `<provider>-webhook/<tenant>` on this deployment,
 * and until this was rendered nobody could read that off any screen — the
 * first Flutterwave-funded deals on the linked project were settled by the
 * buyer's page polling `/confirm`, because no webhook had ever been registered.
 * The poll and the five-minute settlement sweep keep a payment from being lost,
 * but the webhook is what makes it land in seconds, and a transfer settling on
 * the payout side is reported by nothing else in real time.
 *
 * Shown with the connected rail's buttons and again inside the form, next to
 * the secret-hash field it pairs with: the provider's page asks for this URL
 * and hands back that secret in the same breath.
 */
function WebhookAddress({
  provider,
  url,
  inForm,
}: {
  provider: Provider
  url: string
  inForm?: boolean
}) {
  const [copied, setCopied] = useState(false)

  return (
    <div className={cx('w-full', inForm ? '' : 'mt-3')}>
      <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-fg-subtle">
        Webhook address
      </p>
      <div className="relative overflow-hidden rounded-lg border border-line bg-surface-2">
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(url)
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
        <pre className="overflow-x-auto px-3 py-2.5 pr-16 text-xs leading-relaxed text-fg">
          <code className="font-mono">{url}</code>
        </pre>
      </div>
      <p className="mt-1.5 text-xs leading-relaxed text-fg-muted">
        Register this in {PROVIDER_LABEL[provider]}’s dashboard as the webhook
        URL
        {provider === 'flutterwave'
          ? ', with the same secret hash you enter here. Without it a payment ' +
            'still settles — the buyer’s page asks, and a sweep re-checks every ' +
            'five minutes — but only this reports a payout landing.'
          : provider === 'stripe'
          ? ', and paste the signing secret it shows you above.'
          : ', and enter the webhook ID it is given above.'}
      </p>
    </div>
  )
}

export function ConnectProvider({
  provider,
  requirement,
  connected,
  mode,
  onDone,
}: {
  provider: Provider
  requirement: ProviderRequirement
  connected: boolean
  mode: 'test' | 'live'
  onDone?: () => void
}) {
  const [open, setOpen] = useState(false)
  const [selectedMode, setSelectedMode] = useState<'test' | 'live'>(mode)
  const [values, setValues] = useState<Record<string, string>>({})

  const connect = useMoneyMutation(() =>
    api.connectProvider({ provider, mode: selectedMode, credentials: values }),
  )

  const disconnect = useMoneyMutation(() => api.disconnectProvider(provider))

  function submit(e: React.FormEvent) {
    e.preventDefault()
    connect.mutate(undefined as never, {
      onSuccess: () => {
        // Clear the form the moment it succeeds. Keys should not sit in React
        // state, or in a component tree a screenshot might capture, any longer
        // than the request needs them.
        setValues({})
        setOpen(false)
        onDone?.()
      },
    })
  }

  if (!open) {
    return (
      <div className="mt-5 flex flex-wrap items-center gap-2">
        <Button variant="secondary" onClick={() => setOpen(true)}>
          {connected ? 'Replace keys' : `Connect ${PROVIDER_LABEL[provider]}`}
        </Button>

        {connected && (
          <Button
            variant="ghost"
            onClick={() => disconnect.mutate(undefined as never)}
            disabled={disconnect.isPending}
          >
            {disconnect.isPending ? 'Disconnecting…' : 'Disconnect'}
          </Button>
        )}

        {disconnect.error && (
          <p className="w-full text-sm text-refunded">{disconnect.error.message}</p>
        )}

        {connected && requirement.webhook_url && (
          <WebhookAddress provider={provider} url={requirement.webhook_url} />
        )}
      </div>
    )
  }

  return (
    <Card className="mt-5 bg-surface-2 p-5">
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm leading-relaxed text-fg-muted">
          Money from your buyers goes into your own {PROVIDER_LABEL[provider]}{' '}
          balance. PayHold holds the release, never the funds.
        </p>

        <Field
          label="Mode"
          hint={
            selectedMode === 'live'
              // Live is refused outright until §16's checklist is signed off,
              // and saying so here is friendlier than the rejection that
              // follows — the operator finds out before fetching a live key
              // rather than after pasting one into a form.
              ? 'Live keys move real money on the first charge, and are refused ' +
                'until the launch checklist is signed off.'
              : provider === 'paypal'
              ? 'Sandbox credentials, from your sandbox app. PayPal keeps sandbox ' +
                'and live as separate accounts, so these are not your live ones.'
              : 'Test keys move no real money. Use these for the sandbox walkthrough.'
          }
        >
          <Select
            value={selectedMode}
            onChange={(e) => setSelectedMode(e.target.value as 'test' | 'live')}
          >
            <option value="test">Test</option>
            <option value="live">Live</option>
          </Select>
        </Field>

        {requirement.fields.map((field) => (
          <Field
            key={field}
            label={FIELD_LABEL[field] ?? field}
            hint={FIELD_HINT[provider]?.[field]}
          >
            <Input
              // `password` on the values that are genuinely secret, so they are
              // not shoulder-read and browsers do not offer to remember them.
              // See SECRET_FIELDS for why the others are deliberately legible.
              type={SECRET_FIELDS.has(field) ? 'password' : 'text'}
              autoComplete="off"
              spellCheck={false}
              value={values[field] ?? ''}
              onChange={(e) =>
                setValues((v) => ({ ...v, [field]: e.target.value }))
              }
            />
          </Field>
        ))}

        <p className="rounded-lg bg-surface px-3 py-2 text-xs leading-relaxed text-fg-muted">
          Find these at {requirement.where}.
        </p>

        {requirement.webhook_url && (
          <WebhookAddress provider={provider} url={requirement.webhook_url} inForm />
        )}

        {connect.error && (
          <p
            className={cx(
              'rounded-lg bg-refunded-soft px-3 py-2 text-sm leading-relaxed',
              'text-refunded',
            )}
          >
            {connect.error.message}
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={connect.isPending}>
            {connect.isPending ? 'Checking with provider…' : 'Connect'}
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setValues({})
              setOpen(false)
            }}
          >
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  )
}
