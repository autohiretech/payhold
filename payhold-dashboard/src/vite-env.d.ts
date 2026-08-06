/// <reference types="vite/client" />

/**
 * The dashboard's whole configuration surface, and all of it is public by
 * design: it holds no secrets, has no direct database access, and everything
 * here ends up readable in the built bundle.
 *
 * The anon key belongs in that list. It identifies the Supabase project to the
 * auth server; it authorises nothing on its own, and every real check is the
 * session JWT or a client's API key. The service-role key is what must never
 * appear here, and there is no `VITE_` name it could hide behind.
 */
interface ImportMetaEnv {
  /** e.g. `https://mwnbjjlilqrwdmwutbxr.supabase.co`. Unset → the mock. */
  readonly VITE_SUPABASE_URL?: string
  readonly VITE_SUPABASE_ANON_KEY?: string
  /** `'1'` points the Intelligence screens at the real Edge Functions. */
  readonly VITE_PAYHOLD_AI_LIVE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
