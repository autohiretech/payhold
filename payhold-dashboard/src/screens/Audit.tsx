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
          <div className="space-y-2 p-5">
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
                    <Mono>
                      {Object.keys(e.details).length
                        ? JSON.stringify(e.details)
                        : '—'}
                    </Mono>
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
