/**
 * Chroma key sampler maths (spec 07 §6.6, `VideoEngine.sampleKeyHue`): a 9×9 patch centred on the click, clipped to
 * the image, area-averaged in the encoded (non-linear sRGB) space, converted to HSB, gated at saturation 0.12.
 */

export const SAMPLE_PATCH = 9
export const MIN_KEY_SATURATION = 0.12

export interface PatchRect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * The patch in pixel rows counted from the **top** of the image: centre `(nx·W, ny·H)`, origin at centre − 4,
 * intersected with the image (Core Image's `CGRect(x: c.x − 4, y: c.y − 4, w: 9, h: 9).intersection(extent)`).
 * Returns null when nothing remains.
 */
export function patchRect(nx: number, ny: number, width: number, height: number): PatchRect | null {
  if (!(width > 0 && height > 0 && Number.isFinite(nx) && Number.isFinite(ny))) return null
  const half = (SAMPLE_PATCH - 1) / 2
  const x0 = Math.floor(nx * width - half)
  const y0 = Math.floor(ny * height - half)
  const x = Math.max(0, x0)
  const y = Math.max(0, y0)
  const x1 = Math.min(width, x0 + SAMPLE_PATCH)
  const y1 = Math.min(height, y0 + SAMPLE_PATCH)
  return x1 > x && y1 > y ? { x, y, w: x1 - x, h: y1 - y } : null
}

/** Plain average of RGBA8 pixels → RGB floats in 0…1 (alpha ignored, like `CIAreaAverage` on an opaque frame). */
export function averageRgb(pixels: Uint8Array | Uint8ClampedArray): [number, number, number] | null {
  const n = Math.floor(pixels.length / 4)
  if (!n) return null
  let r = 0
  let g = 0
  let b = 0
  for (let i = 0; i < n; i++) {
    r += pixels[i * 4]
    g += pixels[i * 4 + 1]
    b += pixels[i * 4 + 2]
  }
  return [r / n / 255, g / n / 255, b / n / 255]
}

/** `NSColor.getHue(_:saturation:brightness:alpha:)`: standard HSV, hue in 0…1 (0 for greys). */
export function rgbToHsb(r: number, g: number, b: number): { h: number; s: number; v: number } {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  const s = max > 0 ? d / max : 0
  let h = 0
  if (d > 0) {
    if (max === r) h = (g - b) / d
    else if (max === g) h = 2 + (b - r) / d
    else h = 4 + (r - g) / d
    h /= 6
    if (h < 0) h += 1
  }
  return { h, s, v: max }
}

/** Hue of an RGBA8 patch, or null when the average is too grey (saturation < 0.12) — the UI beeps then. */
export function keyHueFromPixels(pixels: Uint8Array | Uint8ClampedArray): number | null {
  const avg = averageRgb(pixels)
  if (!avg) return null
  const { h, s } = rgbToHsb(avg[0], avg[1], avg[2])
  return s >= MIN_KEY_SATURATION && Number.isFinite(h) ? h : null
}
