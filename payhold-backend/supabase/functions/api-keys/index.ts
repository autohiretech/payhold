/**
 * A tenant's API keys — the credential their *server* holds.
 *
 *   GET    /api-keys           list, masked
 *   POST   /api-keys           mint one; the plaintext is in this response only
 *   DELETE /api-keys?id=…      revoke
 *
 * **The plaintext is returned exactly once and is never recoverable.** Only the
 * SHA-256 hash is stored, and `key_hash` is revoked at the column level so even
 * the owning tenant's session cannot read it back — `callerFromApiKey` compares
 * by hash, so there is nothing here that ever needs the original. A key that
 * could be re-read would be a key a support screenshot leaks.
 *
 * **A session mints it, an API key may not.** A key that could mint another is
 * a key whose revocation means nothing: whoever holds the leaked one issues a
 * replacement before anybody notices the first is gone. So this is dashboard
 * callers only, `owner` or `staff`.
 *
 * Revoking is not deleting. `revoked_at` keeps the label and the last-used
 * stamp, which is what answers "was this the key that was still being used from
 * that address on Tuesday" after it has been turned off.
 */

import { requireRole, resolveCaller, serviceClient } from '../_shared/auth.ts'
import { generateApiKey } from '../_shared/crypto.ts'
import { handler, json, readJson } from '../_shared/http.ts'
import { PayHoldError } from '../_shared/types.ts'

/** Everything but `key_hash`, which no response may carry in any shape. */
const KEY_COLUMNS =
  'id, tenant_id, label, masked_key, created_at, revoked_at, last_used_at'

Deno.serve(handler(async (req) => {
  const db = serviceClient()
  const caller = await resolveCaller(db, req)

  if (req.method === 'GET') {
    const { data, error } = await db
      .from('api_keys')
      .select(KEY_COLUMNS)
      .eq('tenant_id', caller.tenant_id)
      .order('created_at', { ascending: false })

    if (error) throw new Error(`api key lookup failed: ${error.message}`)
    return json(req, { keys: data ?? [] })
  }

  if (caller.kind !== 'dashboard') {
    throw new PayHoldError(
      'unauthorized',
      'API keys are issued to a signed-in person, not to another API key',
    )
  }
  requireRole(caller, 'owner', 'staff')

  if (req.method === 'POST') {
    const body = await readJson<{ label?: string; mode?: 'test' | 'live' }>(req)
    const label = (body.label ?? '').trim()
    if (!label) {
      throw new PayHoldError(
        'policy_violation',
        'A key needs a label — it is the only way to tell two of them apart later',
      )
    }

    // The prefix is what a secret scanner matches and what identifies a key
    // found in a log. It says nothing about what the key may do: authority is
    // the tenant it belongs to, and `mode` here is a label, not a capability.
    const mode = body.mode === 'test' ? 'test' : 'live'
    const generated = await generateApiKey(mode)

    const { data, error } = await db
      .from('api_keys')
      .insert({
        tenant_id: caller.tenant_id,
        key_hash: generated.hash,
        masked_key: generated.masked,
        label,
      })
      .select(KEY_COLUMNS)
      .single()

    if (error) throw new Error(`api key insert failed: ${error.message}`)

    await db.rpc('write_audit', {
      p_tenant: caller.tenant_id,
      p_deal: null,
      p_actor: caller.actor,
      p_action: 'api_key.created',
      p_details: { label, masked_key: generated.masked },
    })

    return json(req, { key: data, plaintext: generated.plaintext }, 201)
  }

  if (req.method === 'DELETE') {
    const id = new URL(req.url).searchParams.get('id')
    if (!id) throw new PayHoldError('policy_violation', 'Specify ?id=')

    const { data, error } = await db
      .from('api_keys')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', id)
      .eq('tenant_id', caller.tenant_id)
      // Revoking twice must not move the stamp — the first refusal is when the
      // key stopped working, and that is the date an incident is written from.
      .is('revoked_at', null)
      .select(KEY_COLUMNS)
      .maybeSingle()

    if (error) throw new Error(`api key revoke failed: ${error.message}`)

    if (!data) {
      // Already revoked, or somebody else's. Both are read back rather than
      // guessed at: another tenant's key must 404, and a second revoke is a
      // no-op that should still return the row it was aimed at.
      const { data: existing } = await db
        .from('api_keys')
        .select(KEY_COLUMNS)
        .eq('id', id)
        .eq('tenant_id', caller.tenant_id)
        .maybeSingle()

      if (!existing) throw new PayHoldError('not_found', `Key ${id} not found`)
      return json(req, { key: existing })
    }

    await db.rpc('write_audit', {
      p_tenant: caller.tenant_id,
      p_deal: null,
      p_actor: caller.actor,
      p_action: 'api_key.revoked',
      p_details: { label: (data as { label: string }).label },
    })

    return json(req, { key: data })
  }

  throw new PayHoldError('policy_violation', `${req.method} is not supported here`)
}))
