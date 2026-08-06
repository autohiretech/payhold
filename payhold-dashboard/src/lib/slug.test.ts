/**
 * The mirror of `payhold-backend/supabase/functions/_shared/slug.test.ts`.
 *
 * Both suites exist so the two copies cannot drift silently: a company that
 * signs up against the mock and then against the real API must get the same
 * slug. If one of these changes, the other changes in the same commit.
 */

import { describe, expect, it } from 'vitest'
import { slugify } from './slug'

describe('slugify', () => {
  it('handles ordinary names', () => {
    expect(slugify('AutoHire')).toBe('autohire')
    expect(slugify('Rwanda Equipment Co')).toBe('rwanda-equipment-co')
    expect(slugify('Kigali  Motors   Ltd.')).toBe('kigali-motors-ltd')
  })

  it('folds accents rather than dropping the letters', () => {
    expect(slugify('Café Céleste')).toBe('cafe-celeste')
  })

  it('never leaves a leading, trailing or doubled separator', () => {
    expect(slugify('  --Hire Co--  ')).toBe('hire-co')
    expect(slugify('A & B')).toBe('a-b')
  })

  it('still yields a slug for a name with nothing sluggable in it', () => {
    // An empty slug would collide with every other empty one, and the second
    // company to hit it would fail for a reason nobody could read.
    expect(slugify('株式会社')).toBe('company')
    expect(slugify('!!!')).toBe('company')
    expect(slugify('')).toBe('company')
  })

  it('cuts a long name without leaving a trailing separator', () => {
    const slug = slugify('The Very Long Equipment Hire Company Of Kigali Rwanda')
    expect(slug.length).toBeLessThanOrEqual(40)
    expect(slug.endsWith('-')).toBe(false)
    expect(slug).toBe('the-very-long-equipment-hire-company-of')
  })
})
