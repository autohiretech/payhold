import { assertEquals } from 'jsr:@std/assert@1'
import { routeNotFound } from './http.ts'
import { ERROR_STATUS } from './types.ts'

/**
 * The bug this pins is a 404 that named a path nobody had called. It is worth a
 * test rather than a careful reading because the failure is invisible from the
 * router: every route still worked, and the only symptom was a support thread
 * about a `/connect` handler that was never the thing missing.
 */

Deno.test('a two-deep route is quoted whole, not truncated at the first segment', () => {
  // `POST /v1/sellers/:id/connect/session` — the call that found this. The old
  // message stopped after `connect`, which is a prefix the client never sent
  // and which does exist as part of three real routes.
  const segments = ['v1', 'sellers', 'sel_123', 'connect', 'session']
  assertEquals(
    routeNotFound('POST', segments, 1).message,
    'POST /sellers/sel_123/connect/session is not a route',
  )
})

Deno.test('deeper than the router parses is still quoted whole', () => {
  // `sellers` names four segments past its own; a fifth would have to be added
  // to the message by hand under the old shape, which is exactly the thing that
  // does not happen. Slicing means it cannot be forgotten.
  const segments = ['v1', 'sellers', 'sel_123', 'destinations', 'dst_9', 'end-hold', 'extra']
  assertEquals(
    routeNotFound('POST', segments, 1).message,
    'POST /sellers/sel_123/destinations/dst_9/end-hold/extra is not a route',
  )
})

Deno.test('a bare one-segment path reads as the client sent it', () => {
  assertEquals(
    routeNotFound('GET', ['v1', 'sellers', 'sel_123'], 1).message,
    'GET /sellers/sel_123 is not a route',
  )
})

Deno.test('the prefixes ahead of the function name are ours and stay out of it', () => {
  // Supabase serves these under `/functions/v1/<name>`, and a client quoting a
  // gateway path back at itself is being told to fix something it did not
  // write. `from` is the index of the function's own name.
  const segments = ['functions', 'v1', 'sellers', 'sel_123', 'nope']
  assertEquals(
    routeNotFound('GET', segments, 2).message,
    'GET /sellers/sel_123/nope is not a route',
  )
})

Deno.test('it is a 404, not a policy refusal', () => {
  // The code is what decides the status, and a route that does not exist
  // still answers 404 — a 422 would say the request was understood and
  // refused. It is `unknown_route` rather than `not_found` so a client can
  // tell "no such endpoint" from "no such seller" without reading the prose;
  // both map to 404 in `ERROR_STATUS`.
  assertEquals(ERROR_STATUS[routeNotFound('GET', ['sellers', 'x'], 0).code], 404)
})

Deno.test('a missing route is its own code, not the one for a missing thing', () => {
  // Both are 404s and were the same code until 2026-09-10, which forced
  // clients to tell them apart by reading the message. Four AutoHire functions
  // did exactly that — any PayHold 404 meant "this seller is gone", so they
  // cleared the link and re-registered — and the router's path echo turned
  // `POST /sellers/<uuid>/connect is not a route` into a 404 containing the
  // word "sellers". A renamed endpoint would have silently unlinked a host.
  //
  // A code is the fix. String-matching an error is a contract nobody wrote
  // down, and changing an error's shape is an API change even when the wording
  // is an improvement.
  const err = routeNotFound('POST', ['functions', 'v1', 'sellers', 'abc', 'connect'], 2)
  assertEquals(err.code, 'unknown_route')
  assertEquals(err.message, 'POST /sellers/abc/connect is not a route')
})
