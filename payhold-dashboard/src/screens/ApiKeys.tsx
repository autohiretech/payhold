import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/api'
import {
  Button,
  Card,
  CardHeader,
  EmptyState,
  ErrorNote,
  Field,
  Input,
  Mono,
  PageHeader,
  Skeleton,
  Table,
  Td,
  Th,
} from '@/components/ui'
import { formatDate, formatDateTime } from '@/lib/format'
import { keys, useMoneyAction, useMoneyMutation } from '@/lib/queries'

export function ApiKeysPage() {
  const apiKeys = useQuery({ queryKey: keys.apiKeys, queryFn: () => api.listApiKeys() })
  const endpoints = useQuery({
    queryKey: keys.webhooks,
    queryFn: () => api.listWebhookEndpoints(),
  })

  const [label, setLabel] = useState('')
  const [url, setUrl] = useState('')
  const [revealedKey, setRevealedKey] = useState<string | null>(null)
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null)

  const createKey = useMoneyAction(() => api.createApiKey(label))
  const revokeKey = useMoneyMutation((id: string) => api.revokeApiKey(id))
  const createEndpoint = useMoneyAction(() => api.createWebhookEndpoint(url))

  return (
    <>
      <PageHeader
        title="API keys"
        subtitle="How your site authenticates to PayHold. Keys are hashed — we cannot show one twice."
      />

      {revealedKey && (
        <RevealBox
          title="Copy this key now"
          body="This is the only time it will ever be shown. If you lose it, revoke and create another."
          secret={revealedKey}
          onDismiss={() => setRevealedKey(null)}
        />
      )}

      <Card className="mb-5">
        <CardHeader title="Keys" />
        {apiKeys.isPending ? (
          <div className="space-y-2 p-6">
            {[0, 1].map((i) => (
              <Skeleton key={i} className="h-9" />
            ))}
          </div>
        ) : !apiKeys.data?.length ? (
          <EmptyState title="No keys" body="Create one to start calling the API." />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Label</Th>
                <Th>Key</Th>
                <Th>Created</Th>
                <Th>Last used</Th>
                <Th align="right" />
              </tr>
            </thead>
            <tbody>
              {apiKeys.data.map((k) => (
                <tr key={k.id} className={k.revoked_at ? 'opacity-50' : undefined}>
                  <Td className="font-medium">
                    {k.label}
                    {k.revoked_at && (
                      <span className="ml-2 text-xs text-danger">revoked</span>
                    )}
                  </Td>
                  <Td>
                    <Mono>{k.masked_key}</Mono>
                  </Td>
                  <Td className="text-fg-muted">{formatDate(k.created_at)}</Td>
                  <Td className="text-fg-muted">
                    {k.last_used_at ? formatDateTime(k.last_used_at) : 'never'}
                  </Td>
                  <Td align="right">
                    {!k.revoked_at && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={revokeKey.isPending}
                        onClick={() => revokeKey.mutate(k.id)}
                      >
                        Revoke
                      </Button>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}

        <div className="border-t border-line px-6 py-5">
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={async (e) => {
              e.preventDefault()
              const result = await createKey.mutateAsync()
              setRevealedKey(result.plaintext)
              setLabel('')
            }}
          >
            <div className="min-w-48 flex-1">
              <Field label="New key label">
                <Input
                  required
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="autohire-prod"
                />
              </Field>
            </div>
            <Button type="submit" variant="primary" disabled={createKey.isPending}>
              Create key
            </Button>
          </form>
          {createKey.isError && (
            <div className="mt-3">
              <ErrorNote message={createKey.error.message} />
            </div>
          )}
        </div>
      </Card>

      {revealedSecret && (
        <RevealBox
          title="Copy this signing secret"
          body="Use it to verify the HMAC signature on every webhook we send you, so you know the call really came from PayHold."
          secret={revealedSecret}
          onDismiss={() => setRevealedSecret(null)}
        />
      )}

      <Card>
        <CardHeader
          title="Webhook endpoints"
          subtitle="Where we notify you on every status change. Each delivery is HMAC-signed."
        />
        {endpoints.isPending ? (
          <div className="p-6">
            <Skeleton className="h-9" />
          </div>
        ) : !endpoints.data?.length ? (
          <EmptyState
            title="No endpoints"
            body="Without one, your site has to poll for status instead."
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>URL</Th>
                <Th>Signing secret</Th>
                <Th align="right">Added</Th>
              </tr>
            </thead>
            <tbody>
              {endpoints.data.map((w) => (
                <tr key={w.id}>
                  <Td>
                    <Mono>{w.url}</Mono>
                  </Td>
                  <Td>
                    <Mono>{w.masked_secret}</Mono>
                  </Td>
                  <Td align="right" className="text-fg-muted">
                    {formatDate(w.created_at)}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}

        <div className="border-t border-line px-6 py-5">
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={async (e) => {
              e.preventDefault()
              const result = await createEndpoint.mutateAsync()
              setRevealedSecret(result.secret)
              setUrl('')
            }}
          >
            <div className="min-w-64 flex-1">
              <Field label="Endpoint URL">
                <Input
                  required
                  type="url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://yoursite.com/api/payhold-events"
                />
              </Field>
            </div>
            <Button type="submit" variant="primary" disabled={createEndpoint.isPending}>
              Add endpoint
            </Button>
          </form>
        </div>
      </Card>
    </>
  )
}

function RevealBox({
  title,
  body,
  secret,
  onDismiss,
}: {
  title: string
  body: string
  secret: string
  onDismiss: () => void
}) {
  const [copied, setCopied] = useState(false)

  return (
    <Card className="mb-5 border-brand/30 bg-brand-soft p-6">
      <h2 className="text-sm font-semibold text-fg">{title}</h2>
      <p className="mt-1 text-sm text-fg-muted">{body}</p>
      <div className="mt-3 overflow-x-auto rounded-lg bg-surface px-3 py-2">
        <code className="font-mono text-sm break-all text-fg">{secret}</code>
      </div>
      <div className="mt-3 flex gap-2">
        <Button
          variant="primary"
          size="sm"
          onClick={async () => {
            await navigator.clipboard.writeText(secret)
            setCopied(true)
            setTimeout(() => setCopied(false), 2000)
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          I've saved it
        </Button>
      </div>
    </Card>
  )
}
