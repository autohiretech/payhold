import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from 'react-router-dom'
import { AuthProvider } from './auth/AuthProvider'
import { router } from './app/routes'
import './index.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Nothing here is cached across a mutation: a cron pass, a provider
      // webhook or another operator can move money underneath a screen at any
      // moment, and a stale balance is the one number that must not be shown
      // with confidence. `retry: false` because a failed money read should
      // surface rather than be retried quietly into looking fine.
      staleTime: 0,
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/*
      Auth sits inside the query client and outside the router: signing out
      clears the cache, and the route guard reads the session from context.
    */}
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>,
)
