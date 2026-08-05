/**
 * A real Postgres to test the migrations against, with no Docker.
 *
 * PGlite is Postgres 17 compiled to WASM. It runs the actual planner, the
 * actual constraint machinery and the actual plpgsql — so a migration that
 * passes here is a migration that parses, and a `FOR UPDATE` guard that holds
 * here holds in Supabase.
 *
 * What it is NOT: Supabase. The `auth` schema, the `anon`/`authenticated`/
 * `service_role` roles and `auth.uid()` are platform-provided, so the shim
 * below stands them up. RLS policies referencing `auth.uid()` are therefore
 * *parsed and planned* here but their end-to-end behaviour still needs a real
 * Supabase instance — see the note in CLAUDE.md.
 */

import { PGlite } from '@electric-sql/pglite'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const MIGRATIONS = join(import.meta.dirname, '..', 'supabase', 'migrations')

/**
 * Stand in for what Supabase provides before any migration runs.
 *
 * `auth.uid()` reads a session GUC here instead of a JWT claim. That is the
 * one deliberate difference, and it is what lets a test say "now I am this
 * user" without minting tokens.
 */
const AUTH_SHIM = `
  create schema if not exists auth;

  create table auth.users (
    id    uuid primary key default gen_random_uuid(),
    email text unique
  );

  create or replace function auth.uid() returns uuid
  language sql stable
  as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
  $$;

  do $$
  begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then
      create role anon nologin noinherit;
    end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then
      create role authenticated nologin noinherit;
    end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then
      create role service_role nologin noinherit bypassrls;
    end if;
  end;
  $$;

  grant usage on schema public to anon, authenticated, service_role;
`

export interface Harness {
  db: PGlite
  /** Run as a signed-in dashboard user, subject to RLS. */
  asUser<T>(authUserId: string, fn: () => Promise<T>): Promise<T>
  close(): Promise<void>
}

export async function migrated(): Promise<Harness> {
  // pgcrypto is a contrib extension: Supabase ships it, PGlite needs it loaded
  // explicitly. `gen_random_uuid()` is every table's primary key default, so
  // nothing applies without it.
  const db = new PGlite({ extensions: { pgcrypto } })
  await db.exec('create extension if not exists pgcrypto;')
  await db.exec(AUTH_SHIM)

  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS, file), 'utf8')
    try {
      await db.exec(sql)
    } catch (err) {
      throw new Error(`migration ${file} failed: ${(err as Error).message}`)
    }
  }

  return {
    db,
    async asUser(authUserId, fn) {
      // `set local` would need an explicit transaction; a plain set with an
      // explicit reset keeps each test's identity from leaking into the next.
      await db.exec(`set role authenticated;
                     select set_config('request.jwt.claim.sub', '${authUserId}', false);`)
      try {
        return await fn()
      } finally {
        await db.exec(`reset role;
                       select set_config('request.jwt.claim.sub', '', false);`)
      }
    },
    close: () => db.close(),
  }
}

/** Assert a query rejects, and that it rejects for the stated reason. */
export async function rejects(
  fn: () => Promise<unknown>,
  matching: RegExp,
): Promise<string> {
  try {
    await fn()
  } catch (err) {
    const message = (err as Error).message
    if (!matching.test(message)) {
      throw new Error(`rejected, but not as expected.\n  want: ${matching}\n  got:  ${message}`)
    }
    return message
  }
  throw new Error(`expected a rejection matching ${matching}, but the call succeeded`)
}
