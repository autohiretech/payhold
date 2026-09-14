import { useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Card,
  CardHeader,
  EmptyState,
  Input,
  Mono,
  PageHeader,
  Skeleton,
  Table,
  Td,
  Th,
} from '@/components/ui'
import { formatDateTime } from '@/lib/format'
import { useAudit } from '@/lib/queries'

export function AuditPage() {
  const audit = useAudit()
  const [search, setSearch] = useState('')

  const term = search.trim().toLowerCase()
  const entries =
    audit.data?.filter(
      (e) =>
        !term ||
        e.action.toLowerCase().includes(term) ||
        e.actor.toLowerCase().includes(term) ||
        (e.deal_id ?? '').toLowerCase().includes(term),
    ) ?? []

  return (
    <>
      <PageHeader
        title="Audit trail"
        subtitle="Append-only record of every state change and provider call. Nothing here can be edited or deleted."
      />

      <div className="mb-4 sm:max-w-xs">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter by action, actor, or deal id…"
        />
      </div>

      <Card>
        <CardHeader title={`${entries.length} entries`} />
        {audit.isPending ? (
          <div className="space-y-2 p-6">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-8" />
            ))}
          </div>
        ) : !entries.length ? (
          <EmptyState
            title="Nothing recorded"
            body={term ? `No entries match "${search}".` : undefined}
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>When</Th>
                <Th>Action</Th>
                <Th>Actor</Th>
                <Th>Deal</Th>
                <Th>Details</Th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id} className="hover:bg-surface-2">
                  <Td className="whitespace-nowrap text-fg-muted">
                    {formatDateTime(e.created_at)}
                  </Td>
                  <Td className="font-medium">{e.action}</Td>
                  <Td className="text-fg-muted">{e.actor}</Td>
                  <Td>
                    {e.deal_id ? (
                      <Link to={`/deals/${e.deal_id}`} className="hover:underline">
                        <Mono>{e.deal_id}</Mono>
                      </Link>
                    ) : (
                      <span className="text-fg-subtle">—</span>
                    )}
                  </Td>
                  <Td>
                    <DetailsCell details={e.details} />
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  )
}


/**
 * The audit row's details, as pairs a person can read rather than one JSON
 * string a table cell cut off. A reconciliation run's row used to read
 * `{"run_id":"ef9f5eb…","matched":0,"missing":0,"skipped":0,"provider":"stri`
 * and stop — the cell width decided what the reader was allowed to know, and
 * nothing offered the rest. Ids and references keep the mono face because
 * they are compared by eye against another screen; everything else is text.
 * Past four pairs the rest fold behind a toggle, so a busy row does not push
 * the table apart, and nothing is ever silently dropped.
 */
function DetailsCell({ details }: { details: Record<string, unknown> }) {
  // Object order is write order, and a run's details are written run-id first
  // — so the fold hid `provider`, the one pair that says which rail the row is
  // about. The pairs a reader scans for come first; everything else keeps the
  // order it was written in.
  const FIRST = ['provider', 'rail', 'currency', 'amount', 'status', 'reason', 'action', 'seller_id', 'deal_id']
  const rank = (k: string) => { const i = FIRST.indexOf(k); return i === -1 ? FIRST.length : i }
  const entries = Object.entries(details).sort(([a], [b]) => rank(a) - rank(b))
  if (entries.length === 0) return <span className="text-fg-subtle">—</span>
  const shown = entries.slice(0, 4)
  const rest = entries.slice(4)
  const render = (v: unknown): string =>
    v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v)
  const isRef = (k: string, v: unknown) =>
    typeof v === 'string' && (/(_id|_ref|^id$|^run$)/.test(k) || /^[0-9a-f-]{20,}$/.test(v))
  const pair = ([k, v]: [string, unknown]) => (
    <div key={k} className="flex gap-1.5 whitespace-nowrap">
      <span className="text-fg-subtle">{k.replace(/_/g, ' ')}</span>
      {isRef(k, v) ? (
        <Mono>{render(v)}</Mono>
      ) : (
        <span className="text-fg">{render(v)}</span>
      )}
    </div>
  )
  return (
    <div className="flex flex-col gap-0.5 text-xs">
      {shown.map(pair)}
      {rest.length > 0 && (
        <details className="mt-0.5">
          <summary className="cursor-pointer text-[11px] font-medium text-brand hover:underline">
            {rest.length} more
          </summary>
          <div className="mt-1 flex flex-col gap-0.5">{rest.map(pair)}</div>
        </details>
      )}
    </div>
  )
}
