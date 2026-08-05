import { useEffect, useState } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/api'
import { cx } from '@/components/ui'
import { DevPanel } from './DevPanel'

const NAV = [
  { to: '/', label: 'Overview', end: true },
  { to: '/deals', label: 'Deals' },
  { to: '/payouts', label: 'Payouts' },
  { to: '/disputes', label: 'Disputes' },
  { to: '/sellers', label: 'Sellers' },
]

const NAV_ADMIN = [
  { to: '/settings', label: 'Settings' },
  { to: '/api-keys', label: 'API keys' },
  { to: '/audit', label: 'Audit trail' },
]

export function AppShell() {
  const { data: tenant } = useQuery({ queryKey: ['tenant'], queryFn: () => api.getTenant() })
  const { data: disputes } = useQuery({
    queryKey: ['disputes'],
    queryFn: () => api.listDisputes(),
  })

  const openDisputes = disputes?.filter((d) => d.status === 'open').length ?? 0

  return (
    <div className="flex min-h-svh flex-col lg:flex-row">
      <Sidebar tenantName={tenant?.name} openDisputes={openDisputes} />

      <main className="min-w-0 flex-1">
        {tenant?.status === 'payouts_frozen' && (
          <div className="border-b border-danger/20 bg-danger-soft px-6 py-2.5 text-sm text-danger">
            <strong className="font-semibold">Payouts are frozen.</strong> A ledger
            mismatch is under review — no funds will leave this account until it is
            resolved.
          </div>
        )}
        <div className="mx-auto max-w-6xl px-5 py-8 lg:px-8">
          <Outlet />
        </div>
      </main>

      <DevPanel />
    </div>
  )
}

function Sidebar({
  tenantName,
  openDisputes,
}: {
  tenantName?: string
  openDisputes: number
}) {
  return (
    <aside className="shrink-0 border-b border-line bg-surface lg:sticky lg:top-0 lg:h-svh lg:w-60 lg:border-r lg:border-b-0">
      <div className="flex items-center justify-between gap-3 px-5 py-4 lg:block">
        <div>
          <div className="flex items-center gap-2">
            <Logo />
            <span className="text-sm font-semibold tracking-tight text-fg">PayHold</span>
          </div>
          <p className="mt-1 truncate text-xs text-fg-muted lg:mt-2">
            {tenantName ?? '…'}
          </p>
        </div>
        <ThemeToggle />
      </div>

      <nav className="flex gap-1 overflow-x-auto px-3 pb-3 lg:flex-col lg:overflow-visible">
        {NAV.map((item) => (
          <NavItem
            key={item.to}
            {...item}
            badge={item.label === 'Disputes' && openDisputes > 0 ? openDisputes : undefined}
          />
        ))}

        <div className="my-2 hidden border-t border-line lg:block" />

        {NAV_ADMIN.map((item) => (
          <NavItem key={item.to} {...item} />
        ))}

        <div className="my-2 hidden border-t border-line lg:block" />

        <NavItem to="/admin" label="Master admin" />
      </nav>
    </aside>
  )
}

function NavItem({
  to,
  label,
  end,
  badge,
}: {
  to: string
  label: string
  end?: boolean
  badge?: number
}) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cx(
          'flex shrink-0 items-center justify-between gap-2 rounded-lg px-3 py-2 text-sm font-medium transition',
          isActive
            ? 'bg-brand-soft text-fg'
            : 'text-fg-muted hover:bg-surface-2 hover:text-fg',
        )
      }
    >
      {label}
      {badge !== undefined && (
        <span className="rounded-full bg-danger px-1.5 text-xs font-semibold text-white">
          {badge}
        </span>
      )}
    </NavLink>
  )
}

function Logo() {
  return (
    <svg viewBox="0 0 24 24" className="size-5 text-brand" aria-hidden="true">
      <rect
        x="3.5"
        y="9.5"
        width="17"
        height="11"
        rx="2.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <path
        d="M7.5 9.5V7a4.5 4.5 0 0 1 9 0v2.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <circle cx="12" cy="15" r="1.6" fill="currentColor" />
    </svg>
  )
}

function ThemeToggle() {
  const [dark, setDark] = useState(
    () =>
      localStorage.getItem('payhold.theme') === 'dark' ||
      (localStorage.getItem('payhold.theme') === null &&
        window.matchMedia('(prefers-color-scheme: dark)').matches),
  )

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
    localStorage.setItem('payhold.theme', dark ? 'dark' : 'light')
  }, [dark])

  return (
    <button
      onClick={() => setDark((v) => !v)}
      aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
      className="rounded-lg p-2 text-fg-muted transition hover:bg-surface-2 hover:text-fg lg:absolute lg:top-4 lg:right-3"
    >
      {dark ? <SunIcon /> : <MoonIcon />}
    </button>
  )
}

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" strokeLinecap="round" />
    </svg>
  )
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" strokeLinejoin="round" />
    </svg>
  )
}
