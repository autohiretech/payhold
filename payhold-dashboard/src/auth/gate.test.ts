/**
 * Does the gate actually gate?
 *
 * `mock.test.ts` covers what a session *is*; this covers what the app does
 * about one. It mounts the real route table rather than a stand-in, because
 * the claim is about `routes.tsx`: everything with dashboard chrome sits behind
 * `RequireAuth`, and the two hosted pages a buyer sees deliberately do not.
 *
 * Written with `createElement` rather than JSX because Vitest is scoped to
 * `*.test.ts` here, and one file's syntax is not worth widening that for.
 */

import { beforeEach, expect, it } from 'vitest'
import { StrictMode, act, createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider, createMemoryRouter } from 'react-router-dom'
import { AuthProvider } from './AuthProvider'
import { MockAuthBackend } from './mock'
import { routes } from '@/app/routes'
import { DEMO_LOGINS, seedDb } from '@/api/mock/seed'
import { resetDb } from '@/api/mock/store'

const DEMO = DEMO_LOGINS[0]!

/**
 * A memory router per mount. The exported `router` is a browser one built once
 * at import, so its history would carry from one test into the next.
 */
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

beforeEach(() => {
  localStorage.clear()
  resetDb(seedDb)
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
  await new MockAuthBackend().signIn(DEMO.email, DEMO.password)

  const { el, router } = await mount('/deals')

  expect(router.state.location.pathname).toBe('/deals')
  expect(el.textContent).toContain('Payment rails')
  expect(el.textContent).toContain('Sign out')
})

it('does not ask a buyer to sign in', async () => {
  // Someone opening a payment link from an email has no PayHold account. A
  // gate in front of this page is a gate in front of getting paid.
  const { router } = await mount('/pay/deal_0001')

  expect(router.state.location.pathname).toBe('/pay/deal_0001')
})
