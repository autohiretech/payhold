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
        'rounded-2xl border border-line bg-surface shadow-[var(--shadow-card)]',
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
    <div className="flex flex-wrap items-start justify-between gap-4 border-b border-line px-6 py-5">
      <div className="min-w-0">
        <h2 className="text-base font-semibold text-fg">{title}</h2>
        {subtitle && (
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-fg-muted">
            {subtitle}
          </p>
        )}
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
        'inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold whitespace-nowrap ring-1 ring-inset',
        TONE_CLASS[meta.tone],
        className,
      )}
    >
      <span className="size-1.5 rounded-full bg-current opacity-70" />
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
  primary:
    'bg-brand text-brand-fg shadow-[var(--shadow-card)] hover:bg-brand-deep active:scale-[0.985]',
  secondary:
    'bg-surface text-fg ring-1 ring-inset ring-line-strong hover:bg-surface-2 hover:ring-fg-subtle/40 active:scale-[0.985]',
  ghost: 'text-fg-muted hover:bg-surface-2 hover:text-fg',
  danger: 'bg-danger text-white shadow-[var(--shadow-card)] hover:brightness-110 active:scale-[0.985]',
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
        'inline-flex items-center justify-center gap-2 rounded-xl font-semibold transition duration-150',
        'disabled:pointer-events-none disabled:opacity-45',
        size === 'sm' ? 'px-3 py-1.5 text-xs' : 'px-4 py-2.5 text-sm',
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
      <span className="mb-2 block text-sm font-semibold text-fg">{label}</span>
      {children}
      {hint && (
        <span className="mt-2 block text-xs leading-relaxed text-fg-muted">{hint}</span>
      )}
    </label>
  )
}

// Form controls carry the strong border: a field you cannot see the edge of is
// a field people miss.
const CONTROL =
  'w-full rounded-xl border border-line-strong bg-surface px-3.5 py-2.5 text-sm text-fg transition ' +
  'placeholder:text-fg-subtle hover:border-fg-subtle ' +
  'focus:border-brand focus:ring-4 focus:ring-brand/15 focus:outline-none'

export function Input(props: React.ComponentProps<'input'>) {
  return <input {...props} className={cx(CONTROL, props.className)} />
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={cx(CONTROL, 'pr-9', props.className)} />
}

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cx(CONTROL, 'min-h-24', props.className)} />
}

// ---------------------------------------------------------------------------

const TILE_ACCENT: Record<Tone, string> = {
  neutral: 'from-fg-subtle/0 to-fg-subtle/0',
  held: 'from-held/[0.07] to-held/0',
  confirmed: 'from-confirmed/[0.07] to-confirmed/0',
  released: 'from-released/[0.07] to-released/0',
  pending: 'from-pending/[0.08] to-pending/0',
  danger: 'from-danger/[0.07] to-danger/0',
}

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
    <Card
      className={cx(
        'relative overflow-hidden bg-gradient-to-br p-5 transition hover:shadow-[var(--shadow-lift)]',
        TILE_ACCENT[tone],
      )}
    >
      <div className="flex items-center gap-2">
        <Dot tone={tone} />
        <span className="text-xs font-semibold tracking-[0.06em] text-fg-muted uppercase">
          {label}
        </span>
      </div>
      <div className="tabular mt-3 text-3xl leading-none font-semibold text-fg">
        {value}
      </div>
      {hint && <div className="mt-2.5 text-xs leading-relaxed text-fg-muted">{hint}</div>}
    </Card>
  )
}

// ---------------------------------------------------------------------------

export function Table({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[44rem] border-collapse text-sm">{children}</table>
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
        'border-b border-line bg-surface-2/60 px-6 py-3 text-xs font-semibold tracking-[0.06em] text-fg-muted uppercase',
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
  colSpan,
}: {
  children?: ReactNode
  align?: 'left' | 'right'
  className?: string
  /** For a panel that belongs to the table rather than to one column. */
  colSpan?: number
}) {
  return (
    <td
      colSpan={colSpan}
      className={cx(
        'border-b border-line px-6 py-3.5 text-fg',
        align === 'right' ? 'text-right' : 'text-left',
        className,
      )}
    >
      {children}
    </td>
  )
}

/** Table row with the standard hover tint. */
export function Tr({ children }: { children: ReactNode }) {
  return <tr className="transition-colors hover:bg-surface-2/70">{children}</tr>
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
    <div className="px-6 py-16 text-center">
      <div className="mx-auto mb-4 flex size-11 items-center justify-center rounded-full bg-surface-2 text-fg-subtle">
        <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.7">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" strokeLinecap="round" />
        </svg>
      </div>
      <p className="text-base font-semibold text-fg">{title}</p>
      {body && (
        <p className="mx-auto mt-1.5 max-w-sm text-sm leading-relaxed text-fg-muted">
          {body}
        </p>
      )}
      {action && <div className="mt-5 flex justify-center">{action}</div>}
    </div>
  )
}

/**
 * A page whose data the signed-in session is not entitled to at all —
 * distinct from `EmptyState`, which means the data exists and there is
 * genuinely none of it yet. Reading the two the same way is exactly the bug
 * this exists to prevent: PayHold staff-only endpoints 404 a tenant session
 * identically to a resource that does not exist, and `!data?.length` cannot
 * tell "nothing happened" from "you cannot see this" apart.
 */
export function RestrictedState({ title, body }: { title: string; body?: string }) {
  return (
    <div className="px-6 py-16 text-center">
      <div className="mx-auto mb-4 flex size-11 items-center justify-center rounded-full bg-pending-soft text-pending">
        <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.7">
          <rect x="5" y="10.5" width="14" height="9" rx="2" />
          <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" strokeLinecap="round" />
        </svg>
      </div>
      <p className="text-base font-semibold text-fg">{title}</p>
      {body && (
        <p className="mx-auto mt-1.5 max-w-sm text-sm leading-relaxed text-fg-muted">
          {body}
        </p>
      )}
    </div>
  )
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('animate-pulse rounded-xl bg-surface-2', className)} />
}

export function ErrorNote({ message }: { message: string }) {
  return (
    <div className="flex gap-2.5 rounded-xl bg-danger-soft px-4 py-3 text-sm font-medium text-danger ring-1 ring-danger/20 ring-inset">
      <svg viewBox="0 0 24 24" className="mt-0.5 size-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8v5M12 16.5v.01" strokeLinecap="round" />
      </svg>
      <span>{message}</span>
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
    <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold text-fg">{title}</h1>
        {subtitle && (
          <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-fg-muted">
            {subtitle}
          </p>
        )}
      </div>
      {action}
    </div>
  )
}

export function Mono({ children }: { children: ReactNode }) {
  return <span className="font-mono text-xs text-fg-muted">{children}</span>
}

/**
 * The padlock mark. Defined once here because it now appears in two places
 * that never see each other — the sidebar of the signed-in app, and the
 * sign-in screen in front of it.
 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cx('size-5', className)} aria-hidden="true">
      <rect
        x="3.5"
        y="10"
        width="17"
        height="10.5"
        rx="2.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
      />
      <path
        d="M7.75 10V7.25a4.25 4.25 0 0 1 8.5 0V10"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
      />
      <circle cx="12" cy="15.25" r="1.55" fill="currentColor" />
    </svg>
  )
}
