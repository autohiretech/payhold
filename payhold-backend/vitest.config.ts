import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Vitest owns the SQL migration tests only. Everything under
    // `supabase/functions/` is Deno — `Deno.test`, `jsr:` imports, Web Crypto
    // against Deno.env — and runs via `npm run test:functions`.
    include: ['tests/**/*.test.ts'],
    // PGlite boots a WASM Postgres per file; the default 5s timeout expires
    // during the first migration run on a cold cache.
    testTimeout: 30_000,
    hookTimeout: 120_000,
    // One database per file, shared across that file's tests. Running files in
    // parallel would mean several WASM Postgres instances at once, which is
    // slower than it sounds on a laptop.
    fileParallelism: false,
  },
})
