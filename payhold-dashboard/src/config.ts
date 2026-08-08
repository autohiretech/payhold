/**
 * Where the backend is, checked once.
 *
 * Both seams need it — `@/api` to reach the Edge Functions, `@/auth` to reach
 * Supabase Auth — and they have always had to move together: a real session in
 * front of an unreachable backend is as broken as no session at all. So the
 * check lives here rather than in either of them, and it **throws** rather than
 * falling back.
 *
 * There used to be a fallback. Unset meant "run the in-browser mock", which
 * made a misconfigured deploy indistinguishable from a demo build: every screen
 * rendered, every number was invented, and nothing said so. Failing at import
 * is the only failure an operator cannot mistake for an empty account.
 *
 * Neither value is a secret, and calling them one would teach the wrong lesson
 * about which of these is dangerous. The anon key identifies the project to the
 * auth server and authorises nothing on its own — RLS and the session JWT are
 * what stand behind it. The service-role key has no `VITE_` name it could hide
 * behind and must never appear in this repository.
 */

function required(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(
      `${name} must be set at build time. The dashboard is a client of the ` +
        'PayHold API and has no offline mode — see .env.example.',
    )
  }
  return value
}

export const SUPABASE_URL = required(
  'VITE_SUPABASE_URL',
  import.meta.env.VITE_SUPABASE_URL,
)

export const SUPABASE_ANON_KEY = required(
  'VITE_SUPABASE_ANON_KEY',
  import.meta.env.VITE_SUPABASE_ANON_KEY,
)
