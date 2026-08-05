/**
 * The primitive vocabulary every screen is built from. Kept deliberately small
 * — if a screen needs a one-off, it composes these rather than inventing a new
 * look.
 */

import type { ReactNode } from 'react'
import { TONE_CLASS, type StatusMeta, type Tone } from '@/lib/format'

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ')
}

// ---------------------------------------------------------------------------

export function Card({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <div
      className={cx(
        'rounded-xl border border-line bg-surface shadow-sm shadow-black/[0.02]',
        className,
      )}
    >
      {children}
    </div>
  )
}

export function CardHeader({
  title,
  subtitle,
  action,
}: {
  title: ReactNode
  subtitle?: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-fg">{title}</h2>
        {subtitle && <p className="mt-0.5 text-sm text-fg-muted">{subtitle}</p>}
      </div>
      {action}
    </div>
  )
}

// ---------------------------------------------------------------------------

export function Badge({
  meta,
  className,
}: {
  meta: StatusMeta
  className?: string
}) {
  return (
    <span
      title={meta.hint}
      className={cx(
        'inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
        TONE_CLASS[meta.tone],
        className,
      )}
    >
      {meta.label}
    </span>
  )
}

export function Dot({ tone }: { tone: Tone }) {
  const color: Record<Tone, string> = {
    neutral: 'bg-fg-subtle',
    held: 'bg-held',
    confirmed: 'bg-confirmed',
    released: 'bg-released',
    pending: 'bg-pending',
    danger: 'bg-danger',
  }
  return <span className={cx('size-2 shrink-0 rounded-full', color[tone])} />
}

// ---------------------------------------------------------------------------

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

const BUTTON_CLASS: Record<ButtonVariant, string> = {
  primary: 'bg-brand text-brand-fg hover:opacity-90',
  secondary: 'bg-surface text-fg ring-1 ring-inset ring-line-strong hover:bg-surface-2',
  ghost: 'text-fg-muted hover:bg-surface-2 hover:text-fg',
  danger: 'bg-danger text-white hover:opacity-90',
}

export function Button({
  variant = 'secondary',
  size = 'md',
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant
  size?: 'sm' | 'md'
}) {
  return (
    <button
      {...props}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition',
        'focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-canvas focus-visible:outline-none',
        'disabled:cursor-not-allowed disabled:opacity-45',
        size === 'sm' ? 'px-2.5 py-1.5 text-xs' : 'px-3.5 py-2 text-sm',
        BUTTON_CLASS[variant],
        className,
      )}
    />
  )
}

// ---------------------------------------------------------------------------

export function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: ReactNode
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-fg">{label}</span>
      {children}
      {hint && <span className="mt-1.5 block text-xs text-fg-muted">{hint}</span>}
    </label>
  )
}

const CONTROL =
  'w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg ' +
  'placeholder:text-fg-subtle focus:border-brand focus:ring-2 focus:ring-brand/25 focus:outline-none'

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx(CONTROL, props.className)} />
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={cx(CONTROL, 'pr-8', props.className)} />
}

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cx(CONTROL, 'min-h-20', props.className)} />
}

// ---------------------------------------------------------------------------

export function StatTile({
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  label: string
  value: ReactNode
  hint?: ReactNode
  tone?: Tone
}) {
  return (
    <Card className="p-4">
      <div className="flex items-center gap-2">
        <Dot tone={tone} />
        <span className="text-xs font-medium tracking-wide text-fg-muted uppercase">
          {label}
        </span>
      </div>
      <div className="tabular mt-2 text-2xl font-semibold text-fg">{value}</div>
      {hint && <div className="mt-1 text-xs text-fg-muted">{hint}</div>}
    </Card>
  )
}

// ---------------------------------------------------------------------------

export function Table({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[42rem] border-collapse text-sm">{children}</table>
    </div>
  )
}

export function Th({
  children,
  align = 'left',
}: {
  children?: ReactNode
  align?: 'left' | 'right'
}) {
  return (
    <th
      className={cx(
        'border-b border-line px-4 py-2.5 text-xs font-medium tracking-wide text-fg-muted uppercase',
        align === 'right' ? 'text-right' : 'text-left',
      )}
    >
      {children}
    </th>
  )
}

export function Td({
  children,
  align = 'left',
  className,
}: {
  children?: ReactNode
  align?: 'left' | 'right'
  className?: string
}) {
  return (
    <td
      className={cx(
        'border-b border-line px-4 py-3 text-fg',
        align === 'right' ? 'text-right' : 'text-left',
        className,
      )}
    >
      {children}
    </td>
  )
}

// ---------------------------------------------------------------------------

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string
  body?: string
  action?: ReactNode
}) {
  return (
    <div className="px-6 py-14 text-center">
      <p className="text-sm font-medium text-fg">{title}</p>
      {body && <p className="mx-auto mt-1 max-w-sm text-sm text-fg-muted">{body}</p>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  )
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('animate-pulse rounded-md bg-surface-2', className)} />
}

export function ErrorNote({ message }: { message: string }) {
  return (
    <div className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger ring-1 ring-danger/20 ring-inset">
      {message}
    </div>
  )
}

export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: string
  subtitle?: string
  action?: ReactNode
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-fg">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-fg-muted">{subtitle}</p>}
      </div>
      {action}
    </div>
  )
}

export function Mono({ children }: { children: ReactNode }) {
  return <span className="font-mono text-xs text-fg-muted">{children}</span>
}
