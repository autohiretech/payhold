/**
 * Does the payout-method picker offer what the *backend* says is registerable?
 *
 * The registry (`lib/countries.ts`, `lib/rails.ts`) says which corridors are
 * possible; `payout.methods` on `GET /v1/payment-options?payout_country=` says
 * which are on today (§29.11), and only the backend can read the second. This
 * form used to derive its own list, so it offered pairs registration then
 * refuses: Kenya's bank corridor sits behind a Flutterwave request, and
 * Kenya + KES + PayPal is `currency_not_supported` because PayPal's route row
 * carries KE without carrying KES. A destination registered against one of
 * those is a tokenized beneficiary no payout can ever reach.
 *
 * So the assertions are about what the picker *does not* offer for a market the
 * registry is more optimistic about than the routing table is, and that the
 * currency is part of the question rather than a filter applied afterwards.
 *
 * Both seams are stubbed the way `auth/gate.test.ts` stubs them — a session
 * that is present, and an API that answers this one call with a fixed answer
 * and everything else with nothing. Written with `createElement` rather than
 * JSX because Vitest is scoped to `*.test.ts` here.
 */

import { beforeEach, expect, it, vi } from 'vitest'
import { StrictMode, act, createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider, createMemoryRouter } from 'react-router-dom'
import type { PayoutOptions } from '@/api/types'
import type { AuthAccount } from '@/auth/types'

const SIGNED_IN: AuthAccount = {
  id: 'usr_test',
  email: 'grace@autohire.rw',
  full_name: 'Grace Uwase',
  tenant_id: 'ten_test',
  tenant_name: 'AutoHire',
  tenant_slug: 'autohire',
  role: 'owner',
}

/** Every `getPayoutOptions` call, in order — the pair matters, not just the country. */
const asked: [string, string | undefined][] = []

/**
 * Kenya as the routing table actually has it on 2026-09-10.
 *
 * The registry would offer a wallet, a bank account *and* PayPal here. The
 * table carries the wallet in KES and PayPal only in USD, which is the whole
 * point of asking per pair.
 */
function kenya(currency: string | undefined): PayoutOptions {
  const inUsd = currency === 'USD'
  return {
    country: { code: 'KE', name: 'Kenya', flag: '🇰🇪' },
    payout: {
      provider: inUsd ? 'paypal' : 'flutterwave',
      kind: inUsd ? 'paypal' : 'momo',
      currency: (inUsd ? 'USD' : 'KES') as PayoutOptions['payout']['currency'],
      blocked: false,
      reason: inUsd
        ? 'Paid in USD to a PayPal account in Kenya.'
        : 'Paid in KES via Flutterwave, to a mobile money wallet in Kenya.',
      verified: false,
      methods: inUsd ? ['paypal'] : ['momo'],
      currencies: [
        { currency: 'KES', methods: ['momo'], default: true },
        { currency: 'USD', methods: ['paypal'], default: false },
      ],
    },
    networks: ['M-Pesa'],
    banks: null,
    rails_verified: false,
  }
}

vi.mock('@/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/auth/index')>()
  return {
    ...actual,
    auth: {
      restore: async () => SIGNED_IN,
      signIn: async () => SIGNED_IN,
      signUp: async () => SIGNED_IN,
      signOut: async () => {},
      accessToken: async () => 'test-token',
    },
  }
})

vi.mock('@/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api')>()

  const client = new Proxy(
    {},
    {
      get: (_target, prop: string) => {
        if (prop === 'admin') return {}
        if (prop === 'getPayoutOptions') {
          return async (country: string, currency?: string) => {
            asked.push([country, currency])
            return kenya(currency)
          }
        }
        return async () => (prop.startsWith('list') ? [] : null)
      },
    },
  )

  return { ...actual, api: client }
})

const { routes } = await import('@/app/routes')
const { AuthProvider } = await import('@/auth/AuthProvider')

/** Long enough for the session to restore and the queries behind it to settle. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 60))
  })
}

async function mountSellers() {
  const router = createMemoryRouter(routes, { initialEntries: ['/sellers'] })
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
  await settle()

  return el
}

/** `Field` renders `<label><span>Payout method</span><select/></label>`. */
function field(el: HTMLElement, label: string): HTMLSelectElement {
  const found = [...el.querySelectorAll('label')].find(
    (l) => l.querySelector('span')?.textContent === label,
  )
  if (!found) throw new Error(`no field labelled "${label}"`)
  const select = found.querySelector('select')
  if (!select) throw new Error(`field "${label}" has no select`)
  return select
}

const optionsOf = (select: HTMLSelectElement) =>
  [...select.options].map((o) => o.textContent)

async function choose(select: HTMLSelectElement, value: string) {
  await act(async () => {
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await settle()
}

/** Opens the registration form, and moves it to a Kenyan seller. */
async function openFormInKenya() {
  const el = await mountSellers()

  const add = [...el.querySelectorAll('button')].find(
    (b) => b.textContent === 'Add seller',
  )
  if (!add) throw new Error('no "Add seller" button')
  await act(async () => {
    add.click()
  })
  await settle()

  await choose(field(el, 'Market'), 'KE')
  return el
}

beforeEach(() => {
  localStorage.clear()
  asked.length = 0
  document.body.innerHTML = ''
})

it('offers only the rails the backend says reach this pair', async () => {
  const el = await openFormInKenya()

  // The registry has Kenya as `momoPayout` **and** `flutterwavePayout` **and**
  // `paypalPayout`, so the old derivation offered three. The table carries one.
  expect(optionsOf(field(el, 'Payout method'))).toEqual(['Mobile money'])
  expect(optionsOf(field(el, 'Payout method'))).not.toContain('PayPal')
  expect(optionsOf(field(el, 'Payout method'))).not.toContain('Bank transfer')
})

it('offers only the currencies the backend says this market can be paid in', async () => {
  const el = await openFormInKenya()

  // Not `[local, 'USD', 'EUR']` — a set this form used to assume, and which put
  // a Kenyan seller one click from a currency with no route at all.
  expect(optionsOf(field(el, 'Wants to be paid in'))).toEqual(['KES (local)', 'USD'])
})

it('asks per (country, currency), because eligibility is per pair', async () => {
  const el = await openFormInKenya()

  // The market's own currency is the backend's default, so the first ask names
  // no currency rather than guessing at one.
  expect(asked).toContainEqual(['KE', undefined])

  await choose(field(el, 'Wants to be paid in'), 'USD')

  expect(asked).toContainEqual(['KE', 'USD'])
  // KE + USD is where PayPal actually reaches, and the picker follows the
  // answer rather than the country.
  expect(optionsOf(field(el, 'Payout method'))).toEqual(['PayPal'])
})
