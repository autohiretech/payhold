/**
 * Who is signed in, for the whole app.
 *
 * One piece of state, three things that can be true of it: we have not looked
 * yet, there is nobody, or there is somebody and we know their company. The
 * middle one is not "an empty account" — a session that cannot be resolved to a
 * tenant is signed out, and the dashboard behind it never renders.
 *
 * Signing out clears the React Query cache. Not tidiness: the cache is keyed by
 * query name and not by tenant, so leaving it in place would let the next
 * person to sign in on this machine see the last one's deals in the moment
 * before the first refetch lands.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { auth } from '.'
import type { AuthAccount, SignUpInput } from './types'

interface AuthContextValue {
  account: AuthAccount | null
  /** False once the stored session has been checked, either way. */
  loading: boolean
  signIn(email: string, password: string): Promise<void>
  signUp(input: SignUpInput): Promise<void>
  signOut(): Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()
  const [account, setAccount] = useState<AuthAccount | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let live = true

    auth
      .restore()
      .then((restored) => {
        if (live) setAccount(restored)
      })
      .catch(() => {
        // Restoring is best-effort by definition: the answer to "is this old
        // session still good?" being "no" is not an error to report.
        if (live) setAccount(null)
      })
      .finally(() => {
        if (live) setLoading(false)
      })

    return () => {
      live = false
    }
  }, [])

  const signIn = useCallback(
    async (email: string, password: string) => {
      // Clear before, not after: the incoming person must never be shown a
      // frame of the outgoing one's data.
      queryClient.clear()
      setAccount(await auth.signIn(email, password))
    },
    [queryClient],
  )

  const signUp = useCallback(
    async (input: SignUpInput) => {
      queryClient.clear()
      setAccount(await auth.signUp(input))
    },
    [queryClient],
  )

  const signOut = useCallback(async () => {
    await auth.signOut()
    setAccount(null)
    queryClient.clear()
  }, [queryClient])

  const value = useMemo<AuthContextValue>(
    () => ({ account, loading, signIn, signUp, signOut }),
    [account, loading, signIn, signUp, signOut],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext)
  if (!value) throw new Error('useAuth used outside AuthProvider')
  return value
}

/**
 * The gate. Everything with dashboard chrome sits behind it.
 *
 * The hosted buyer and seller pages (`/pay/:id`, `/status/:id`) deliberately do
 * not: the person opening a payment link from an email has no PayHold account
 * and must never be asked for one.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { account, loading } = useAuth()
  const location = useLocation()

  // Render nothing rather than a flash of the sign-in screen: the stored
  // session usually resolves, and bouncing someone who is signed in through a
  // login page reads as having been signed out.
  if (loading) return <SessionSplash />

  if (!account) {
    return (
      <Navigate
        to="/login"
        replace
        // So a bookmarked deal page survives the detour through sign-in.
        state={{ from: location.pathname + location.search }}
      />
    )
  }

  return <>{children}</>
}

function SessionSplash() {
  return (
    <div className="flex min-h-svh items-center justify-center bg-surface-2">
      <p className="text-sm text-fg-muted">Checking your session…</p>
    </div>
  )
}
