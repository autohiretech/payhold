/**
 * Stand-in evidence images for the fixtures.
 *
 * The real thing is a URL on the client's own site — PayHold stores the
 * reference, never the file, so a dispute can be reviewed with the photos in
 * front of you without us holding anyone's images. The mock has no server to
 * serve from, so these are drawn as inline SVG data URIs: no network, no
 * assets to ship, and they survive `localStorage` like any other string.
 *
 * They are deliberately schematic. A fake photograph that looked real would
 * invite someone to treat a fixture as a record of something that happened.
 */

function dataUri(svg: string): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg.replace(/\s+/g, ' ').trim())}`
}

/** A camera-stamped frame, in the palette of the thing being photographed. */
function photo(body: string, stamp: string, bg: string): string {
  return dataUri(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 360" width="480" height="360">
      <rect width="480" height="360" fill="${bg}"/>
      ${body}
      <rect x="0" y="318" width="480" height="42" fill="rgba(0,0,0,0.45)"/>
      <text x="16" y="345" font-family="monospace" font-size="18" fill="#fff">${stamp}</text>
    </svg>
  `)
}

/** A sheet of paper with ruled lines — a quote, a checklist, an invoice. */
function document_(title: string, lines: string[], accent: string): string {
  const rows = lines
    .map(
      (l, i) =>
        `<text x="48" y="${132 + i * 34}" font-family="sans-serif" font-size="17" fill="#3d4451">${l}</text>`,
    )
    .join('')
  return dataUri(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 360" width="480" height="360">
      <rect width="480" height="360" fill="#eceef1"/>
      <rect x="36" y="26" width="408" height="308" rx="6" fill="#fff"/>
      <rect x="36" y="26" width="408" height="10" fill="${accent}"/>
      <text x="48" y="82" font-family="sans-serif" font-size="22" font-weight="600" fill="#1f2430">${title}</text>
      <line x1="48" y1="98" x2="432" y2="98" stroke="#d7dbe0" stroke-width="2"/>
      ${rows}
    </svg>
  `)
}

/** Rear bumper at return: a cracked panel with a scratch across the tailgate. */
export const BUMPER_AT_RETURN = photo(
  `<rect x="0" y="120" width="480" height="200" fill="#4a5a70"/>
   <rect x="40" y="150" width="400" height="120" rx="14" fill="#5b6d86"/>
   <rect x="40" y="252" width="400" height="36" rx="8" fill="#3f4d60"/>
   <path d="M96 196 L300 232" stroke="#d9dee6" stroke-width="7" stroke-linecap="round"/>
   <path d="M300 232 L352 214" stroke="#c3cad4" stroke-width="5" stroke-linecap="round"/>
   <path d="M330 250 l26 -6 l10 22 l-28 6 z" fill="#2b3543"/>
   <circle cx="392" cy="212" r="16" fill="#c0392b" opacity="0.85"/>`,
  '02 Aug 07:37  ·  rear bumper',
  '#2f3947',
)

/** The same panel, closer: the crack itself. */
export const BUMPER_CLOSE_UP = photo(
  `<rect x="0" y="80" width="480" height="240" fill="#54657d"/>
   <path d="M60 300 Q240 120 430 250" stroke="#46566c" stroke-width="60" fill="none"/>
   <path d="M150 232 l70 26 l-24 34 l-62 -30 z" fill="#232c38"/>
   <path d="M150 232 l70 26" stroke="#e6eaf0" stroke-width="4"/>
   <path d="M196 292 l62 30" stroke="#98a3b3" stroke-width="3"/>`,
  '02 Aug 07:41  ·  crack, close',
  '#2f3947',
)

/** The buyer's pickup photo — wrong angle, bumper barely in frame. */
export const PICKUP_WIDE = photo(
  `<rect x="0" y="0" width="480" height="230" fill="#8fb3d9"/>
   <rect x="0" y="230" width="480" height="130" fill="#8d8677"/>
   <rect x="60" y="120" width="300" height="110" rx="16" fill="#5b6d86"/>
   <rect x="86" y="132" width="120" height="52" rx="8" fill="#9fb6cf"/>
   <circle cx="120" cy="238" r="26" fill="#232c38"/>
   <circle cx="316" cy="238" r="26" fill="#232c38"/>
   <rect x="360" y="150" width="40" height="80" rx="8" fill="#4a5a70" opacity="0.6"/>`,
  '01 Aug 09:12  ·  at pickup',
  '#6f7f92',
)

export const PANEL_BEATER_QUOTE = document_(
  'Kigali Panel Works — quote',
  [
    'Rear bumper — replace and respray',
    'Tailgate — sand, fill, respray',
    'Labour, 6 hours',
    '',
    'Total   RWF 180,000',
  ],
  '#b0642a',
)

export const PRE_HIRE_CHECKLIST = document_(
  'Pre-hire checklist',
  [
    'Coolant   topped up',
    'Tyres     4/4 ok',
    'Body      no damage noted',
    '',
    'Signed at collection',
  ],
  '#2f7d6b',
)

export const MECHANIC_INVOICE = document_(
  'Nakuru Auto — invoice',
  ['Roadside call-out', 'Coolant system flush', 'Thermostat replaced', '', 'Total   KES 8,400'],
  '#8a5a2b',
)

export const CANCELLATION_MESSAGE = photo(
  `<rect x="40" y="40" width="400" height="240" rx="18" fill="#f2f4f7"/>
   <rect x="64" y="76" width="250" height="54" rx="14" fill="#dfe4ea"/>
   <rect x="80" y="94" width="200" height="8" rx="4" fill="#9aa3af"/>
   <rect x="80" y="112" width="150" height="8" rx="4" fill="#9aa3af"/>
   <rect x="166" y="150" width="250" height="76" rx="14" fill="#c9d3e0"/>
   <rect x="184" y="170" width="210" height="8" rx="4" fill="#7b8798"/>
   <rect x="184" y="190" width="180" height="8" rx="4" fill="#7b8798"/>
   <rect x="184" y="210" width="120" height="8" rx="4" fill="#7b8798"/>`,
  '26 Jul 06:58  ·  screenshot',
  '#dfe3e8',
)

export const DEPOT_GATE_LOG = document_(
  'Depot gate log — 30 Jul',
  ['06:00  gate opened', '08:15  two vans in', '11:40  no pickup recorded', '17:00  gate closed'],
  '#4a5a70',
)
