/**
 * Create a company and its first owner.
 *
 * Signing up produces an **empty** company: no deals, no sellers, no connected
 * payment rails. That is the honest starting state — a new tenant runs on the
 * demo rail until it brings its own keys, which is exactly what the backend
 * does with a tenant that has no `tenant_provider_accounts` row.
 *
 * The password rule is checked here and enforced again server-side. This copy
 * is a courtesy so the refusal appears next to the field; it is not the check.
 */

import { useState, type FormEvent } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import { useAuth } from '@/auth/AuthProvider'
import { AuthError, MIN_PASSWORD_LENGTH } from '@/auth/types'
import { Button, ErrorNote, Field, Input } from '@/components/ui'
import { AuthLayout, SimulationNote } from './AuthLayout'

export function SignupPage() {
  const { account, loading, simulated, signUp } = useAuth()
  const navigate = useNavigate()

  const [companyName, setCompanyName] = useState('')
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (!loading && account) return <Navigate to="/" replace />

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    setError(null)

    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`)
      return
    }

    setBusy(true)
    try {
      await signUp({
        company_name: companyName,
        email,
        password,
        ...(fullName.trim() ? { full_name: fullName } : {}),
      })
      navigate('/', { replace: true })
    } catch (err) {
      // See the note in Login.tsx: an unexpected failure has to leave a trace.
      if (!(err instanceof AuthError)) console.error('signup failed', err)

      setError(
        err instanceof AuthError
          ? err.message
          : 'Something went wrong creating the account. Check your connection and try again.',
      )
      setBusy(false)
    }
  }

  return (
    <AuthLayout
      title="Create an account"
      subtitle="Hold a buyer's payment until both sides confirm. You can run a whole deal on the demo rail before connecting a payment provider."
      footer={
        <>
          Already have one?{' '}
          <Link to="/login" className="font-semibold text-brand hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4">
        {error && <ErrorNote message={error} />}

        <Field
          label="Company name"
          hint="What your buyers and sellers will see on a payment page."
        >
          <Input
            name="company"
            required
            autoFocus
            value={companyName}
            onChange={(e) => setCompanyName(e.target.value)}
            placeholder="AutoHire"
          />
        </Field>

        <Field label="Your name">
          <Input
            name="name"
            autoComplete="name"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            placeholder="Optional"
          />
        </Field>

        <Field label="Work email">
          <Input
            type="email"
            name="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
          />
        </Field>

        <Field
          label="Password"
          hint={`At least ${MIN_PASSWORD_LENGTH} characters. This account can see every deal and payout your company has.`}
        >
          <Input
            type="password"
            name="password"
            autoComplete="new-password"
            required
            minLength={MIN_PASSWORD_LENGTH}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>

        <Button type="submit" variant="primary" className="w-full" disabled={busy}>
          {busy ? 'Creating your account…' : 'Create account'}
        </Button>

        <p className="text-xs leading-relaxed text-fg-muted">
          You will be the owner of this company — the role that can connect
          payment rails and clear a payout a risk rule has held.
        </p>
      </form>

      {simulated && <SimulationNote />}
    </AuthLayout>
  )
}
