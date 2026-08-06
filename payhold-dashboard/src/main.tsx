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
      // The mock is local, so refetching costs nothing — and it keeps every
      // screen honest after a simulated cron run moves money underneath it.
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
