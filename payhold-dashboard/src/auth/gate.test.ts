/**
 * Does the gate actually gate?
 *
 * The claim is about `routes.tsx`: everything with dashboard chrome sits behind
 * `RequireAuth`, and the two hosted pages a buyer sees deliberately do not. So
 * it mounts the real route table rather than a stand-in.
 *
 * **Both seams are stubbed, and neither stub is a mock backend.** `@/auth` is
 * replaced by a session that is present or absent — which is the only input the
 * gate reads — and `@/api` by a client that answers every call with nothing, so
 * the screens behind the gate render without a network. The in-browser mock
 * that used to stand in for the API is deleted; a test that reintroduced one
 * would be maintaining the thing this repository just stopped shipping.
 *
 * Written with `createElement` rather than JSX because Vitest is scoped to
 * `*.test.ts` here, and one file's syntax is not worth widening that for.
 */

import { beforeEach, expect, it, vi } from 'vitest'
import { StrictMode, act, createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider, createMemoryRouter } from 'react-router-dom'
import type { AuthAccount } from './types'

const SIGNED_IN: AuthAccount = {
  id: 'usr_test',
  email: 'grace@autohire.rw',
  full_name: 'Grace Uwase',
  tenant_id: 'ten_test',
  tenant_name: 'AutoHire',
  role: 'owner',
}

/** Flipped per test, before the mount. */
let session: AuthAccount | null = null

vi.mock('@/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./index')>()
  return {
    ...actual,
    auth: {
      restore: async () => session,
      signIn: async () => SIGNED_IN,
      signUp: async () => SIGNED_IN,
      signOut: async () => {
        session = null
      },
      accessToken: async () => (session ? 'test-token' : null),
    },
  }
})

/**
 * Every read answers empty.
 *
 * The screens behind the gate are not what is being asserted — that they
 * *rendered at all* is — so a client that returns nothing for everything is
 * exactly enough. It is also the honest shape of a brand new account.
 */
vi.mock('@/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api')>()

  const empty = new Proxy(
    {},
    {
      get: (_target, prop: string) => {
        if (prop === 'admin') return {}
        return async () => (prop.startsWith('list') ? [] : null)
      },
    },
  )

  return { ...actual, api: empty }
})

const { routes } = await import('@/app/routes')

async function mount(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] })
  const el = document.createElement('div')
  document.body.appendChild(el)

  await act(async () => {
    createRoot(el).render(
      h(
        StrictMode,
        null,
        h(
          QueryClientProvider,
          { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
          h(AuthProvider, null, h(RouterProvider, { router })),
        ),
      ),
    )
  })

  // Restoring the session is a promise, and so is every query behind it.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 60))
  })

  return { el, router }
}

const { AuthProvider } = await import('./AuthProvider')

beforeEach(() => {
  localStorage.clear()
  session = null
})

it('sends someone with no session to the sign-in screen', async () => {
  const { el, router } = await mount('/deals')

  expect(router.state.location.pathname).toBe('/login')
  expect(el.textContent).toContain('Sign in')
  // And none of the dashboard rendered on the way past.
  expect(el.textContent).not.toContain('Payment rails')
})

it('remembers where they were going', async () => {
  const { router } = await mount('/payouts')

  expect(router.state.location.state).toMatchObject({ from: '/payouts' })
})

it('lets a signed-in person through', async () => {
  session = SIGNED_IN

  const { el, router } = await mount('/deals')

  expect(router.state.location.pathname).toBe('/deals')
  expect(el.textContent).toContain('Payment rails')
  expect(el.textContent).toContain('Sign out')
})

it('does not ask a buyer to sign in', async () => {
  // Someone opening a payment link from an email has no PayHold account. A
  // gate in front of this page is a gate in front of getting paid.
  const { router } = await mount('/pay/chk_live_token')

  expect(router.state.location.pathname).toBe('/pay/chk_live_token')
})
