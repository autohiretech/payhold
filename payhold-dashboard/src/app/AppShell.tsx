import { NavLink, Outlet } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/api'
import { useAuth } from '@/auth/AuthProvider'
import { cx, LogoMark } from '@/components/ui'
import { AssistantProvider } from '@/components/assistant'
import { DevPanel } from './DevPanel'

const NAV = [
  { to: '/', label: 'Overview', end: true, icon: IconHome },
  { to: '/deals', label: 'Deals', icon: IconDeals },
  { to: '/payouts', label: 'Payouts', icon: IconPayouts },
  { to: '/disputes', label: 'Disputes', icon: IconDisputes },
  { to: '/intelligence', label: 'Intelligence', icon: IconIntelligence },
  { to: '/fraud', label: 'Fraud', icon: IconFraud },
  { to: '/sellers', label: 'Sellers', icon: IconSellers },
  { to: '/rails', label: 'Payment rails', icon: IconRails },
]

const NAV_ADMIN = [
  { to: '/settings', label: 'Settings', icon: IconSettings },
  { to: '/api-keys', label: 'API keys', icon: IconKey },
  { to: '/audit', label: 'Audit trail', icon: IconAudit },
]

export function AppShell() {
  const { data: tenant } = useQuery({
    queryKey: ['tenant'],
    queryFn: () => api.getTenant(),
  })
  const { data: disputes } = useQuery({
    queryKey: ['disputes'],
    queryFn: () => api.listDisputes(),
  })

  const openDisputes = disputes?.filter((d) => d.status === 'open').length ?? 0

  return (
    <AssistantProvider>
    <div className="flex min-h-svh flex-col lg:flex-row">
      <Sidebar tenantName={tenant?.name} openDisputes={openDisputes} />

      <main className="min-w-0 flex-1">
        {tenant?.status === 'payouts_frozen' && (
          <div className="flex items-start gap-3 border-b border-danger/20 bg-danger-soft px-6 py-3 text-sm text-danger">
            <svg
              viewBox="0 0 24 24"
              className="mt-0.5 size-4 shrink-0"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <circle cx="12" cy="12" r="9" />
              <path d="M12 8v5M12 16.5v.01" strokeLinecap="round" />
            </svg>
            <p>
              <strong className="font-semibold">Payouts are frozen.</strong> A ledger
              mismatch is under review — no funds will leave this account until it is
              resolved.
            </p>
          </div>
        )}

        <div className="mx-auto max-w-6xl px-5 py-8 sm:px-7 lg:px-10 lg:py-10">
          <Outlet />
        </div>
      </main>

      <DevPanel />
    </div>
    </AssistantProvider>
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
    <aside className="shrink-0 border-b border-line bg-surface lg:sticky lg:top-0 lg:flex lg:h-svh lg:w-64 lg:flex-col lg:border-r lg:border-b-0">
      <div className="flex items-center gap-3 px-5 py-5 lg:px-4">
        <span className="flex size-9 items-center justify-center rounded-xl bg-brand text-brand-fg shadow-[var(--shadow-card)]">
          <LogoMark />
        </span>
        <div className="min-w-0">
          <p className="text-sm leading-tight font-semibold text-fg">PayHold</p>
          <p className="truncate text-xs leading-tight text-fg-muted">
            {tenantName ?? 'Loading…'}
          </p>
        </div>
      </div>

      <nav className="flex gap-1 overflow-x-auto px-3 pb-3 lg:flex-1 lg:flex-col lg:overflow-visible lg:px-3">
        {NAV.map((item) => (
          <NavItem
            key={item.to}
            {...item}
            badge={
              item.label === 'Disputes' && openDisputes > 0 ? openDisputes : undefined
            }
          />
        ))}

        <Divider label="Account" />
        {NAV_ADMIN.map((item) => (
          <NavItem key={item.to} {...item} />
        ))}

        <Divider label="PayHold staff" />
        <NavItem to="/admin" label="Master admin" icon={IconAdmin} />
      </nav>

      <AccountBlock />
    </aside>
  )
}

/**
 * Who you are signed in as, and the way out.
 *
 * The role is shown rather than implied: `viewer` cannot connect a rail or
 * clear a held payout, and finding that out from a disabled button is worse
 * than reading it here.
 */
function AccountBlock() {
  const { account, signOut } = useAuth()
  if (!account) return null

  return (
    <div className="border-t border-line px-4 py-3.5 lg:px-3">
      <div className="flex items-center gap-2.5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-brand-soft text-xs font-semibold text-brand uppercase">
          {(account.full_name ?? account.email).slice(0, 2)}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-semibold text-fg">
            {account.full_name ?? account.email}
          </p>
          <p className="truncate text-[0.6875rem] text-fg-muted">
            {account.tenant_name} · {account.role}
          </p>
        </div>
      </div>

      <button
        type="button"
        onClick={() => void signOut()}
        className="mt-2.5 w-full rounded-lg px-2 py-1.5 text-left text-xs font-medium text-fg-muted transition hover:bg-surface-2 hover:text-fg"
      >
        Sign out
      </button>
    </div>
  )
}

function Divider({ label }: { label: string }) {
  return (
    <div className="hidden px-3 pt-5 pb-1.5 lg:block">
      <span className="text-[0.6875rem] font-semibold tracking-[0.08em] text-fg-subtle uppercase">
        {label}
      </span>
    </div>
  )
}

function NavItem({
  to,
  label,
  end,
  badge,
  icon: Icon,
}: {
  to: string
  label: string
  end?: boolean
  badge?: number
  icon?: () => React.ReactElement
}) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cx(
          'group relative flex shrink-0 items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm font-medium transition',
          isActive
            ? 'bg-brand-soft text-brand'
            : 'text-fg-muted hover:bg-surface-2 hover:text-fg',
        )
      }
    >
      {Icon && (
        <span className="shrink-0 opacity-90">
          <Icon />
        </span>
      )}
      <span className="flex-1 whitespace-nowrap">{label}</span>
      {badge !== undefined && (
        <span className="ml-1 rounded-full bg-danger px-1.5 py-0.5 text-[0.6875rem] leading-none font-bold text-white">
          {badge}
        </span>
      )}
    </NavLink>
  )
}

// ---------------------------------------------------------------------------
// Icons — stroked, 1.7px, so they sit at the same weight as the type.
// ---------------------------------------------------------------------------

function icon(path: React.ReactNode) {
  return (
    <svg
      viewBox="0 0 24 24"
      className="size-[1.125rem]"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {path}
    </svg>
  )
}

function IconHome() {
  return icon(<path d="M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z" />)
}

function IconIntelligence() {
  return icon(
    <>
      <path d="M12 3.5 13.6 8.4 18.5 10 13.6 11.6 12 16.5 10.4 11.6 5.5 10 10.4 8.4z" />
      <path d="M18 16.5l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z" />
    </>,
  )
}

/** A shield: the controls guard, they do not accuse. */
function IconFraud() {
  return icon(
    <>
      <path d="M12 3.5 19 6v5.5c0 4-2.9 7.4-7 8.9-4.1-1.5-7-4.9-7-8.9V6z" />
      <path d="M12 9v3.5" />
      <path d="M12 15.5h.01" />
    </>,
  )
}

function IconDeals() {
  return icon(
    <>
      <rect x="3" y="7" width="18" height="13" rx="2" />
      <path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 12h18" />
    </>,
  )
}

function IconPayouts() {
  return icon(
    <>
      <path d="M12 3v14" />
      <path d="m7 12 5 5 5-5" />
      <path d="M4 21h16" />
    </>,
  )
}

function IconDisputes() {
  return icon(
    <>
      <path d="M10.3 4.3 2.6 17.4A1.6 1.6 0 0 0 4 20h16a1.6 1.6 0 0 0 1.4-2.6L13.7 4.3a1.9 1.9 0 0 0-3.4 0Z" />
      <path d="M12 9.5v4M12 17v.01" />
    </>,
  )
}

function IconSellers() {
  return icon(
    <>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3 20a6 6 0 0 1 12 0" />
      <path d="M16 4.5a3.2 3.2 0 0 1 0 7M18 20a6 6 0 0 0-2-4.5" />
    </>,
  )
}

function IconSettings() {
  return icon(
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
    </>,
  )
}

function IconKey() {
  return icon(
    <>
      <circle cx="8" cy="15" r="4" />
      <path d="m10.8 12.2 8.2-8.2M17 6l2.5 2.5M14.5 8.5 17 11" />
    </>,
  )
}

function IconAudit() {
  return icon(
    <>
      <path d="M8 3h8a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" />
      <path d="M10 8h4M10 12h4M10 16h2" />
    </>,
  )
}

function IconRails() {
  return icon(
    <>
      <rect x="2.5" y="6" width="19" height="12" rx="2.5" />
      <path d="M2.5 10.5h19M6.5 14.5h3M13.5 14.5h4" />
    </>,
  )
}

function IconAdmin() {
  return icon(
    <>
      <path d="M12 3 4 6.2V11c0 4.6 3.2 8.7 8 10 4.8-1.3 8-5.4 8-10V6.2Z" />
      <path d="m9.2 12 2 2 3.6-3.8" />
    </>,
  )
}
