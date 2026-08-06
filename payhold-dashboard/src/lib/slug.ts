/**
 * A URL-safe name for a company.
 *
 * The deliberate mirror of `payhold-backend/supabase/functions/_shared/slug.ts`
 * — same rule as `rails.ts` and `types.ts`, a change to either is a change to
 * both in the same commit. A company that signs up against the mock and then
 * against the real API must get the same slug, or the demo and the product
 * disagree about what the company is called in a URL.
 */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    // Strip combining marks so "Café" becomes "cafe" rather than "caf".
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    // Trimming again: the slice can land on a separator.
    .replace(/-+$/g, '')

  return slug || 'company'
}
