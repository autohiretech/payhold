import { createBrowserRouter } from 'react-router-dom'
import { AppShell } from './AppShell'
import { OverviewPage } from '@/screens/Overview'
import { DealsPage } from '@/screens/Deals'
import { DealDetailPage } from '@/screens/DealDetail'
import { PayoutsPage } from '@/screens/Payouts'
import { DisputesPage } from '@/screens/Disputes'
import { SellersPage } from '@/screens/Sellers'
import { RailsPage } from '@/screens/Rails'
import { SettingsPage } from '@/screens/Settings'
import { ApiKeysPage } from '@/screens/ApiKeys'
import { AuditPage } from '@/screens/Audit'
import { AdminPage } from '@/screens/Admin'
import { CheckoutPage } from '@/screens/public/Checkout'
import { DealStatusPage } from '@/screens/public/DealStatus'

export const router = createBrowserRouter([
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <OverviewPage /> },
      { path: 'deals', element: <DealsPage /> },
      { path: 'deals/:id', element: <DealDetailPage /> },
      { path: 'payouts', element: <PayoutsPage /> },
      { path: 'disputes', element: <DisputesPage /> },
      { path: 'sellers', element: <SellersPage /> },
      { path: 'rails', element: <RailsPage /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: 'api-keys', element: <ApiKeysPage /> },
      { path: 'audit', element: <AuditPage /> },
      { path: 'admin', element: <AdminPage /> },
    ],
  },
  // Hosted pages a client site links to. No dashboard chrome, no auth — these
  // are what the buyer and seller actually see.
  { path: '/pay/:id', element: <CheckoutPage /> },
  { path: '/status/:id', element: <DealStatusPage /> },
])
