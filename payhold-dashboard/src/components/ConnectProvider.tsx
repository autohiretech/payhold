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
  encryption_key: 'Encryption key',
  webhook_hash: 'Webhook secret hash',
  webhook_secret: 'Webhook signing secret',
}

/** What a correct value looks like, so a mispaste is obvious before submitting. */
const FIELD_HINT: Record<string, string> = {
  secret_key: 'Starts FLWSECK_TEST- for test, FLWSECK- for live',
  public_key: 'Starts FLWPUBK',
  encryption_key: 'Shown next to your API keys',
  webhook_hash: 'The value you set as the secret hash on the webhook page',
  webhook_secret: 'Starts whsec_',
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
              ? 'Live keys move real money on the first charge.'
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
            hint={FIELD_HINT[field]}
          >
            <Input
              // `password` so keys are not shoulder-read, and browsers do not
              // offer to remember them.
              type="password"
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
