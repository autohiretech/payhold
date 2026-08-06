/**
 * A URL-safe name for a company.
 *
 * It lives beside the other shared helpers rather than inside `account/`
 * because the function tests only run over `_shared/`, and a slug that can come
 * out empty is a bug the unique index would happily accept as a real value —
 * every company called "…" would collide with the first one, and the second
 * signup would fail for a reason nobody could read.
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
