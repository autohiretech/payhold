import { createBrowserRouter, type RouteObject } from 'react-router-dom'
import { AppShell } from './AppShell'
import { RequireAuth } from '@/auth/AuthProvider'
import { LoginPage } from '@/screens/auth/Login'
import { SignupPage } from '@/screens/auth/Signup'
import { OverviewPage } from '@/screens/Overview'
import { DealsPage } from '@/screens/Deals'
import { DealDetailPage } from '@/screens/DealDetail'
import { PayoutsPage } from '@/screens/Payouts'
import { ResolutionPage } from '@/screens/Resolution'
import { FraudPage } from '@/screens/Fraud'
import { IntelligencePage } from '@/screens/Intelligence'
import { SellersPage } from '@/screens/Sellers'
import { SellerDetailPage } from '@/screens/SellerDetail'
import { RailsPage } from '@/screens/Rails'
import { RoutingPage } from '@/screens/Routing'
import { SettingsPage } from '@/screens/Settings'
import { ApiKeysPage } from '@/screens/ApiKeys'
import { AuditPage } from '@/screens/Audit'
import { HelpPage } from '@/screens/Help'
import { AdminPage } from '@/screens/Admin'
import { CronPage } from '@/screens/Cron'
import { CheckoutPage } from '@/screens/public/Checkout'
import { DealStatusPage } from '@/screens/public/DealStatus'

/**
 * The route table, separately from the browser router built out of it.
 *
 * Exported so a test can mount the same tree on a memory router: the gate is
 * the one piece of routing worth asserting on, and a module-level browser
 * router is a singleton whose history survives between mounts.
 */
export const routes: RouteObject[] = [
  // Everything with dashboard chrome is behind a session. The gate is one
  // wrapper around one route rather than a check per screen, so a new screen
  // added under it cannot forget to be protected.
  {
    path: '/',
    element: (
      <RequireAuth>
        <AppShell />
      </RequireAuth>
    ),
    children: [
      { index: true, element: <OverviewPage /> },
      { path: 'deals', element: <DealsPage /> },
      { path: 'deals/:id', element: <DealDetailPage /> },
      { path: 'payouts', element: <PayoutsPage /> },
      { path: 'routing', element: <RoutingPage /> },
      { path: 'disputes', element: <ResolutionPage /> },
      { path: 'intelligence', element: <IntelligencePage /> },
      { path: 'fraud', element: <FraudPage /> },
      { path: 'sellers', element: <SellersPage /> },
      { path: 'sellers/:id', element: <SellerDetailPage /> },
      { path: 'rails', element: <RailsPage /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: 'api-keys', element: <ApiKeysPage /> },
      { path: 'audit', element: <AuditPage /> },
      // Inside the gate, deliberately. It reads the account's own keys,
      // endpoints and rails to say where the integration actually stands, and
      // the base URL it prints is this deployment's — none of which a logged-out
      // reader has. Public documentation is a different artefact.
      { path: 'help', element: <HelpPage /> },
      { path: 'admin', element: <AdminPage /> },
      { path: 'cron', element: <CronPage /> },
    ],
  },
  // Getting in. Outside the gate for the obvious reason.
  { path: '/login', element: <LoginPage /> },
  { path: '/signup', element: <SignupPage /> },

  // Hosted pages a client site links to. No dashboard chrome, no auth — these
  // are what the buyer and seller actually see. A buyer opening a payment link
  // from an email has no PayHold account and must never be asked for one.
  //
  // `/pay` takes a **checkout session token** rather than a deal id (§10.1).
  // The token is the credential: reading a deal needs an API key, and whoever
  // opens this has none.
  { path: '/pay/:token', element: <CheckoutPage /> },
  { path: '/status/:id', element: <DealStatusPage /> },
]

export const router = createBrowserRouter(routes)
