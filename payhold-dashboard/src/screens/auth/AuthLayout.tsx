/**
 * The frame around signing in and signing up.
 *
 * No sidebar, no tenant, no data — this is the only chrome in the app that
 * renders without knowing who is looking at it.
 */

import type { ReactNode } from 'react'
import { LogoMark } from '@/components/ui'

export function AuthLayout({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string
  subtitle: string
  children: ReactNode
  footer: ReactNode
}) {
  return (
    <div className="flex min-h-svh flex-col items-center justify-center bg-surface-2 px-5 py-12">
      <div className="w-full max-w-md">
        <div className="mb-7 flex items-center gap-3">
          <span className="flex size-10 items-center justify-center rounded-xl bg-brand text-brand-fg shadow-[var(--shadow-card)]">
            <LogoMark />
          </span>
          <div>
            <p className="text-base leading-tight font-semibold text-fg">PayHold</p>
            <p className="text-xs leading-tight text-fg-muted">
              Buyer protection for marketplaces
            </p>
          </div>
        </div>

        <div className="rounded-2xl bg-surface p-6 shadow-[var(--shadow-card)] ring-1 ring-line ring-inset sm:p-7">
          <h1 className="text-xl font-semibold text-fg">{title}</h1>
          <p className="mt-1.5 text-sm leading-relaxed text-fg-muted">{subtitle}</p>

          <div className="mt-6">{children}</div>
        </div>

        <div className="mt-5 text-center text-sm text-fg-muted">{footer}</div>
      </div>
    </div>
  )
}
