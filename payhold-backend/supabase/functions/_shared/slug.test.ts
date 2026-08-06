import { assertEquals } from 'jsr:@std/assert@1'
import { slugify } from './slug.ts'

Deno.test('slugify: ordinary names', () => {
  assertEquals(slugify('AutoHire'), 'autohire')
  assertEquals(slugify('Rwanda Equipment Co'), 'rwanda-equipment-co')
  assertEquals(slugify('Kigali  Motors   Ltd.'), 'kigali-motors-ltd')
})

Deno.test('slugify: accents are folded, not dropped', () => {
  assertEquals(slugify('Café Céleste'), 'cafe-celeste')
})

Deno.test('slugify: never leading, trailing or doubled separators', () => {
  assertEquals(slugify('  --Hire Co--  '), 'hire-co')
  assertEquals(slugify('A & B'), 'a-b')
})

Deno.test('slugify: a name with nothing sluggable still yields a slug', () => {
  // The unique index would accept '' as a value, so every such company would
  // collide with the first one and the second signup would fail obscurely.
  assertEquals(slugify('株式会社'), 'company')
  assertEquals(slugify('!!!'), 'company')
  assertEquals(slugify(''), 'company')
})

Deno.test('slugify: long names are cut without a trailing separator', () => {
  const slug = slugify('The Very Long Equipment Hire Company Of Kigali Rwanda')
  assertEquals(slug.length <= 40, true)
  assertEquals(slug.endsWith('-'), false)
  assertEquals(slug, 'the-very-long-equipment-hire-company-of')
})
