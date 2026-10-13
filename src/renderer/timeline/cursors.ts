/** Custom trim/slip cursors (§6.11): red bracket/arrows with black and white outlines, hotspot centered. */
function svgCursor(body: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="-12 -12 24 24">${body}</svg>`
  return `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}") 12 12, ew-resize`
}

const RED = '#E54F4F'

function bracket(side: -1 | 1): string {
  const x = -2 * side
  const cap = 6 * side
  const path = `M ${x + cap} -8 H ${x} V 8 H ${x + cap}`
  const arrow = side === -1 ? 'M 10 0 L 4 -6 V 6 Z' : 'M -10 0 L -4 -6 V 6 Z'
  return `<path d="${path}" fill="none" stroke="black" stroke-width="4" stroke-linejoin="round"/><path d="${path}" fill="none" stroke="${RED}" stroke-width="2"/><path d="${arrow}" fill="${RED}" stroke="white" stroke-width="2" stroke-linejoin="round" paint-order="stroke"/>`
}

export const CURSOR_TRIM_LEFT = svgCursor(bracket(-1))
export const CURSOR_TRIM_RIGHT = svgCursor(bracket(1))
export const CURSOR_SLIP = svgCursor(
  `<path d="M -10 -8 V 8 M 10 -8 V 8" stroke="black" stroke-width="4"/><path d="M -10 -8 V 8 M 10 -8 V 8" stroke="${RED}" stroke-width="2"/>` +
    `<path d="M -8 0 L -3 -5 V 5 Z M 8 0 L 3 -5 V 5 Z" fill="${RED}" stroke="white" stroke-width="1.5" stroke-linejoin="round" paint-order="stroke"/>`,
)
