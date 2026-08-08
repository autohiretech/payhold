import { defineConfig } from 'vitest/config'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  test: {
    // The gate test mounts the real route table, which wants a DOM.
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
    // `@/config` throws when these are unset, deliberately — a dashboard with
    // no backend has nothing true to show. So the suite supplies a project that
    // does not exist: every test that reaches the API stubs it, and one that
    // forgot to would fail on a refused connection rather than quietly passing
    // against something real.
    env: {
      VITE_SUPABASE_URL: 'https://test.invalid',
      VITE_SUPABASE_ANON_KEY: 'test-anon-key',
    },
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
})
