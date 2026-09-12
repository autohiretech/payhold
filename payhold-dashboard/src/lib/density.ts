/**
 * How large the dashboard draws itself, as a choice rather than a guess.
 *
 * The same build looks two sizes on two machines and neither is wrong: Windows
 * ships high-resolution laptops at 125% or 150% display scaling, so the browser
 * hands the page a ~1280px viewport and paints every element half again as
 * large, while an unscaled Linux desktop on the same 1920px panel gets the full
 * width at 100% and draws everything small. Identical CSS, different device
 * pixel ratio.
 *
 * **The app must not try to detect that and compensate.** `devicePixelRatio`
 * cannot tell "this OS is scaled to 150%" from "this is a Retina screen" or
 * "this person cannot read small text and set it deliberately" — and shrinking
 * the UI under the second and third would take an accessibility setting away
 * from the person who chose it. Every Mac and every phone would get a
 * microscopic dashboard to make one Windows laptop match one Linux one.
 *
 * So it is a preference, set by the person looking at the screen. It is stored
 * **per browser** rather than on the tenant: it describes this machine's
 * display, not anything about the company, and the same operator on a laptop
 * and a desktop will reasonably want different answers.
 *
 * The mechanism is the root font size. Tailwind's spacing, radii and type are
 * all `rem`, so one number moves text, padding and gaps together — the app
 * gets smaller, not just its words, which is what browser zoom does and what
 * "make Windows look like Linux" actually means.
 */

export type Density = 'comfortable' | 'compact'

export const DENSITIES: { value: Density; label: string; hint: string }[] = [
  {
    value: 'comfortable',
    label: 'Comfortable',
    hint: 'The default. Right on an unscaled display.',
  },
  {
    value: 'compact',
    label: 'Compact',
    hint: 'About 85% of the size — for a screen already scaled up by Windows or macOS.',
  },
]

const KEY = 'payhold.density'

/**
 * Storage can throw outright — Safari in private mode, a locked-down profile,
 * an embedded webview — and a display preference is never worth a blank screen,
 * so every access is guarded and failure falls back to the default.
 */
export function readDensity(): Density {
  try {
    return localStorage.getItem(KEY) === 'compact' ? 'compact' : 'comfortable'
  } catch {
    return 'comfortable'
  }
}

export function writeDensity(density: Density): void {
  try {
    localStorage.setItem(KEY, density)
  } catch {
    // Preference lost at the end of the session; the screen is still correct.
  }
}

/**
 * Applied to `<html>` as an attribute rather than an inline style, so the sizes
 * live in `index.css` with the rest of the type scale instead of in a number
 * hidden in TypeScript.
 */
export function applyDensity(density: Density): void {
  document.documentElement.setAttribute('data-density', density)
}
