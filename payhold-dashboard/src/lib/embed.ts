/**
 * Talking to a parent page that has framed us.
 *
 * A tenant may host `/pay/:token` and `/status/:id` inside its own booking
 * page rather than navigating the buyer away. Inside a frame there is no
 * navigation for the parent to observe, so the page has to say what happened.
 *
 * Three rules, and all three are the reason this is one file rather than a
 * `postMessage` at each call site:
 *
 * - **Never `"*"` as the target origin.** A wildcard posts the deal id to
 *   whatever site framed us, which is exactly the thing the `frame-ancestors`
 *   allowlist exists to stop. Every send names its target.
 * - **`ALLOWED_PARENTS` must match `public/_headers`.** They are the same
 *   allowlist written twice — one decides who may frame us, the other who we
 *   will speak to — and a divergence is silent in both directions: an origin
 *   in the header and not here gets a frame that never reports, and one here
 *   and not in the header can never receive anything anyway.
 * - **Nothing here is authorization.** These messages are a UI hint. A frame
 *   saying `payment_succeeded` is a claim by a page, not a signature; the
 *   booking is created by the `order.funded_held` webhook, which checked a
 *   signature and re-fetched the transaction from the provider. A parent that
 *   created an order off one of these messages would have built a way to get
 *   goods without paying.
 */

/**
 * Origins allowed to frame the hosted pages. Mirrors the `frame-ancestors`
 * line in `public/_headers` — see the second rule above.
 *
 * Static for the same reason that header is, and with the same known limit:
 * a second tenant embedding checkout is a redeploy of this site. When one
 * asks, both this and the header become a per-tenant setting.
 */
const ALLOWED_PARENTS = ['https://autohiretech.pages.dev'] as const

export type EmbedEvent =
  | 'payment_succeeded'
  | 'payment_failed'
  | 'payment_cancelled'
  | 'resize'

/** True only when something has actually framed us. */
export function isEmbedded(): boolean {
  try {
    return window.parent !== window
  } catch {
    // A cross-origin parent can throw on access. If we cannot tell, assume we
    // are framed — the worst case is a message nobody is listening for, sent
    // to an origin already on the allowlist.
    return true
  }
}

/**
 * Post one event to every allowlisted parent.
 *
 * Sent to each rather than to the one that framed us because a frame cannot
 * read its parent's origin — that is the same-origin policy doing its job.
 * The list is short and every entry is one we already trust enough to frame
 * this page, so naming them all costs nothing a wildcard would not cost more.
 */
export function postToParent(
  event: EmbedEvent,
  payload: Record<string, unknown> = {},
): void {
  if (!isEmbedded()) return

  const message = { source: 'payhold', event, ...payload }

  for (const origin of ALLOWED_PARENTS) {
    try {
      window.parent.postMessage(message, origin)
    } catch {
      // A parent that has gone away is not this page's problem to report.
    }
  }
}

/**
 * Tell the parent how tall we are, now and whenever that changes.
 *
 * Without it the parent has to guess a height and one of the two scrollbars is
 * wrong. Returns a teardown for the effect that called it.
 */
export function reportHeight(): () => void {
  if (!isEmbedded()) return () => {}

  let last = -1
  const send = () => {
    const height = Math.max(
      document.documentElement.scrollHeight,
      document.body?.scrollHeight ?? 0,
    )
    // Only on a change: a ResizeObserver fires on every layout pass, and a
    // parent re-styling its iframe on each one would be a loop we started.
    if (height === last) return
    last = height
    postToParent('resize', { height })
  }

  const observer = new ResizeObserver(send)
  observer.observe(document.documentElement)
  if (document.body) observer.observe(document.body)
  send()

  return () => observer.disconnect()
}
