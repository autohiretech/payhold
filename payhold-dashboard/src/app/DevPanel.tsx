/**
 * The simulation console.
 *
 * Everything that would normally arrive from a provider webhook or a cron job
 * is a button here: fund a deal, jump the clock forward, force a payout
 * failure, create a ledger drift. This is how we exercise timer and failure
 * paths without a backend — and once the backend exists, these same scenarios
 * become its test cases.
 *
 * Not shipped to production. Rendered only when `import.meta.env.DEV`.
 */

import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { api, isSimulated } from '@/api'
import { useAuth } from '@/auth/AuthProvider'
import { Button, Card, cx } from '@/components/ui'
import { formatDateTime } from '@/lib/format'
import { MockClient } from '@/api/mock'

export function DevPanel() {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const qc = useQueryClient()
  const { signOut } = useAuth()

  if (!import.meta.env.DEV || !isSimulated(api)) return null
  const sim = api.sim

  const run = async (id: string, label: string, fn: () => Promise<unknown>) => {
    setBusy(id)
    try {
      await fn()
      await qc.invalidateQueries()
      setNote(label)
      setTimeout(() => setNote(null), 2600)
    } finally {
      setBusy(null)
    }
  }

  const fundOldest = async () => {
    const deals = await api.listDeals({ status: ['created'] })
    const target = deals.at(-1)
    if (!target) {
      setNote('No unpaid deals to fund')
      return
    }
    await sim.simulateFunding(target.id)
  }

  return (
    <div className="fixed right-4 bottom-20 z-50 print:hidden">
      {open && (
        <Card className="mb-2 w-80 p-4">
          <div className="flex items-baseline justify-between">
            <h3 className="text-sm font-semibold text-fg">Simulation</h3>
            <span className="text-xs text-fg-muted">mock backend</span>
          </div>

          <p className="mt-1 text-xs text-fg-muted">
            Simulated now:{' '}
            <span className="tabular text-fg">{formatDateTime(sim.now().toISOString())}</span>
          </p>

          <div className="mt-3 space-y-3">
            <Section title="Provider events">
              <Button
                size="sm"
                disabled={busy !== null}
                onClick={() => run('fund', 'Payment received — funds now held', fundOldest)}
              >
                Simulate payment received
              </Button>
            </Section>

            <Section title="Time">
              {[
                { label: '+1 hour', hours: 1 },
                { label: '+1 day', hours: 24 },
                { label: '+8 days', hours: 24 * 8 },
              ].map((step) => (
                <Button
                  key={step.label}
                  size="sm"
                  disabled={busy !== null}
                  onClick={() =>
                    run(step.label, `Clock advanced ${step.label}`, () =>
                      sim.advanceTime(step.hours),
                    )
                  }
                >
                  {step.label}
                </Button>
              ))}
              <Button
                size="sm"
                disabled={busy !== null}
                onClick={() => run('cron', 'Cron pass complete', () => sim.runCron())}
              >
                Run cron now
              </Button>
            </Section>

            <Section title="Failure paths">
              <Button
                size="sm"
                disabled={busy !== null}
                onClick={() =>
                  run('fail', 'Next payout attempt will fail', async () =>
                    sim.failNextPayout(),
                  )
                }
              >
                Fail next payout
              </Button>
              <Button
                size="sm"
                disabled={busy !== null}
                onClick={() =>
                  run('webhook', 'Next webhook attempt will fail', async () =>
                    sim.failNextWebhook(),
                  )
                }
              >
                Fail next webhook
              </Button>
              <Button
                size="sm"
                disabled={busy !== null}
                onClick={() =>
                  // Sets the provider's balance at odds with ours, then runs the
                  // real reconciliation pass — which is what finds it and
                  // freezes payouts.
                  run('drift', 'Provider balance now disagrees — payouts frozen', () =>
                    sim.injectDrift('ten_0001', 250_00),
                  )
                }
              >
                Inject ledger drift
              </Button>
            </Section>

            <Section title="Tenant">
              {[
                { id: 'ten_0001', label: 'AutoHire' },
                { id: 'ten_0002', label: 'Equipment Co' },
              ].map((t) => (
                <Button
                  key={t.id}
                  size="sm"
                  disabled={busy !== null}
                  onClick={() =>
                    run(t.id, `Acting as ${t.label}`, async () => {
                      ;(api as MockClient).switchTenant(t.id)
                    })
                  }
                >
                  {t.label}
                </Button>
              ))}
            </Section>

            <Section title="Reset">
              <Button
                size="sm"
                variant="danger"
                disabled={busy !== null}
                onClick={() =>
                  // Signing out is part of the reset: an account created by
                  // signing up does not survive a re-seed, and leaving the
                  // session in place would leave the app showing a company
                  // that no longer exists.
                  run('reset', 'Fixtures reloaded', async () => {
                    await sim.reset()
                    await signOut()
                  })
                }
              >
                Reset all mock data
              </Button>
            </Section>
          </div>

          {note && (
            <p className="mt-3 rounded-md bg-brand-soft px-2.5 py-1.5 text-xs text-fg">
              {note}
            </p>
          )}
        </Card>
      )}

      <button
        onClick={() => setOpen((v) => !v)}
        className={cx(
          'rounded-full px-4 py-2.5 text-xs font-semibold shadow-[var(--shadow-pop)] transition',
          open
            ? 'bg-surface text-fg ring-1 ring-line-strong ring-inset hover:bg-surface-2'
            : 'bg-brand text-brand-fg hover:bg-brand-deep',
        )}
      >
        {open ? 'Close' : 'Simulate'}
      </button>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1.5 text-xs font-medium tracking-wide text-fg-subtle uppercase">
        {title}
      </p>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  )
}
