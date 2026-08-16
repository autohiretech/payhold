import { assertEquals } from 'jsr:@std/assert@1'
import { withCallerLabel } from './seller-mask.ts'

Deno.test('replaces the provider-guessed prefix with the caller-supplied label', () => {
  assertEquals(withCallerLabel('Mobile money •••• 0303', 'Bank transfer'), 'Bank transfer •••• 0303')
})

Deno.test('leaves the masked digits untouched, only the label changes', () => {
  assertEquals(withCallerLabel('Mobile money •••• 4821', 'Mobile Money'), 'Mobile Money •••• 4821')
})

Deno.test('no label supplied — the provider guess is kept exactly as returned', () => {
  assertEquals(withCallerLabel('Mobile money •••• 0303', undefined), 'Mobile money •••• 0303')
  assertEquals(withCallerLabel('Mobile money •••• 0303', null), 'Mobile money •••• 0303')
})

Deno.test('a blank label is treated as no label — the guess is not replaced with nothing', () => {
  assertEquals(withCallerLabel('Mobile money •••• 0303', '   '), 'Mobile money •••• 0303')
})

Deno.test('a mask with no trailing •••• digits — unrecognised shape, returned unchanged', () => {
  // PayPal's wallet mask (`us•••@example.com`) does not carry the `•••• 1234`
  // suffix every bank/card mask does, so there is nothing here to graft a
  // label onto safely — better to leave it than guess wrong a second way.
  assertEquals(withCallerLabel('us•••@example.com', 'PayPal'), 'us•••@example.com')
})

Deno.test('label with surrounding whitespace is trimmed before it replaces the guess', () => {
  assertEquals(withCallerLabel('Mobile money •••• 0303', '  Bank transfer  '), 'Bank transfer •••• 0303')
})
