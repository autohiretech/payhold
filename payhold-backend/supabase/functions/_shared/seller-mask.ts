/**
 * A seller's `masked_destination` is built by whichever provider tokenized the
 * destination, and a provider only knows what its own API told it back. That is
 * reliable for the trailing digits — every adapter's mask ends `•••• 1234` off
 * the destination itself — and unreliable for the leading word, which is a
 * guess from a field like Flutterwave's `bank_name` that the rail simply does
 * not return for every corridor.
 *
 * Found live: a host who registered a bank account paid through Flutterwave's
 * `MPS` rail (used uniformly for every Rwandan destination, momo or bank,
 * because that is the one rail that reaches Rwanda) got back a `bank_name`-less
 * response and `FlutterwaveProvider.tokenize()`'s own fallback, `'Mobile
 * money'` — regardless of which method they actually picked. The seller page
 * then showed "Payout method: Bank transfer" beside "Destination: Mobile Money
 * •••• 0303", each honest about a different source and contradicting the other.
 *
 * The caller already knows which method the seller chose — it is what built
 * `payout_provider` in the first place — so `withCallerLabel` lets a caller's
 * own label replace the guessed prefix while keeping the provider's own masked
 * digits, which are the part actually worth trusting.
 */
export function withCallerLabel(masked: string, label?: string | null): string {
  const trimmed = label?.trim()
  if (!trimmed) return masked

  const digits = masked.match(/(\s*••••\s*\S+)\s*$/)
  if (!digits) return masked

  return `${trimmed}${digits[1]}`
}
