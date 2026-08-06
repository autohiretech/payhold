/**
 * Sign in.
 *
 * The wrong-credentials message is the same whether the address is unknown or
 * the password is wrong — the backend answers that way too, and a screen that
 * distinguished them would tell anyone who asked which companies bank here.
 */

import { useState, type FormEvent } from 'react'
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '@/auth/AuthProvider'
import { AuthError } from '@/auth/types'
import { Button, ErrorNote, Field, Input } from '@/components/ui'
import { AuthLayout, SimulationNote } from './AuthLayout'
// Fixture logins, so the demo build is reachable without signing up first.
// This import goes when the mock does.
import { DEMO_LOGINS } from '@/api/mock/seed'

export function LoginPage() {
  const { account, loading, simulated, signIn } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Where they were headed before the gate sent them here.
  const from = (location.state as { from?: string } | null)?.from ?? '/'

  // Already signed in — a bookmarked /login should not be a dead end.
  if (!loading && account) return <Navigate to={from} replace />

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    setBusy(true)

    try {
      await signIn(email, password)
      navigate(from, { replace: true })
    } catch (err) {
      // An AuthError is a refusal we meant, and its message is written to be
      // read. Anything else is a bug or a dead network, and swallowing it
      // leaves someone staring at a sentence about their connection with
      // nothing in the console to contradict it.
      if (!(err instanceof AuthError)) console.error('sign-in failed', err)

      setError(
        err instanceof AuthError
          ? err.message
          : 'Something went wrong signing in. Check your connection and try again.',
      )
      setBusy(false)
    }
  }

  return (
    <AuthLayout
      title="Sign in"
      subtitle="Your company's deals, payouts and payment rails."
      footer={
        <>
          No account yet?{' '}
          <Link to="/signup" className="font-semibold text-brand hover:underline">
            Create one
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4">
        {error && <ErrorNote message={error} />}

        <Field label="Work email">
          <Input
            type="email"
            name="email"
            autoComplete="username"
            required
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
          />
        </Field>

        <Field label="Password">
          <Input
            type="password"
            name="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>

        <Button type="submit" variant="primary" className="w-full" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>

      {simulated && (
        <SimulationNote>
          <p className="mt-2">
            Sign in with a fixture company, or create your own — a new account
            starts empty, the way a real one does.
          </p>
          <ul className="mt-2 space-y-1">
            {DEMO_LOGINS.map((login) => (
              <li key={login.email}>
                <button
                  type="button"
                  className="font-mono text-[0.6875rem] text-brand hover:underline"
                  onClick={() => {
                    setEmail(login.email)
                    setPassword(login.password)
                  }}
                >
                  {login.email}
                </button>{' '}
                <span className="text-fg-subtle">— {login.company}</span>
              </li>
            ))}
          </ul>
        </SimulationNote>
      )}
    </AuthLayout>
  )
}
