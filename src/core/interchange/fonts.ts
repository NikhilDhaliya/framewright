/**
 * Family/face names for FCPXML titles. Mirrors the bundled-font table the renderer registers
 * (src/renderer/render/fonts.ts, spec 05 §12.1) without its asset URLs, so main-process exports name the same
 * family and weight the preview draws. System fonts are resolved in the main process (fc-match).
 */
import type { TextStyle } from '../model'
import type { FontInfo } from './types'

interface BundledFamily {
  family: string
  /** Weight the bare family name selects. */
  base: number
  faces: { weight: [number, number]; italic: boolean }[]
}

const upright = (lo: number, hi = lo) => ({ weight: [lo, hi] as [number, number], italic: false })
const italic = (lo: number, hi = lo) => ({ weight: [lo, hi] as [number, number], italic: true })

export const BUNDLED_FONT_FAMILIES: readonly BundledFamily[] = [
  { family: 'Inter', base: 400, faces: [upright(100, 900)] },
  { family: 'DM Sans', base: 400, faces: [upright(100, 1000)] },
  { family: 'Geist', base: 400, faces: [upright(100, 900), italic(100, 900)] },
  { family: 'Geist Mono', base: 400, faces: [upright(100, 900), italic(100, 900)] },
  { family: 'Playfair Display', base: 400, faces: [upright(400, 900)] },
  { family: 'Poppins', base: 400, faces: [upright(400), upright(700), italic(400), italic(700)] },
  { family: 'Space Grotesk', base: 400, faces: [upright(300, 700)] },
  { family: 'Caveat', base: 400, faces: [upright(400, 700)] },
  { family: 'Shrikhand', base: 400, faces: [upright(400)] },
  { family: 'Bebas Neue', base: 400, faces: [upright(400)] },
  { family: 'Anton', base: 400, faces: [upright(400)] },
  { family: 'Permanent Marker', base: 400, faces: [upright(400)] },
  { family: 'Basement Grotesque', base: 900, faces: [upright(900)] },
]

const STYLE_WEIGHTS: [string, number][] = [
  ['thin', 100], ['hairline', 100], ['extralight', 200], ['ultralight', 200], ['light', 300], ['regular', 400], ['book', 400], ['normal', 400],
  ['medium', 500], ['semibold', 600], ['demibold', 600], ['bold', 700], ['extrabold', 800], ['ultrabold', 800], ['black', 900], ['heavy', 900],
]

const FACE_NAMES: [number, string][] = [
  [100, 'Thin'], [200, 'ExtraLight'], [300, 'Light'], [400, 'Regular'], [500, 'Medium'], [600, 'SemiBold'], [700, 'Bold'], [800, 'ExtraBold'], [900, 'Black'],
]

export const normalizeFontName = (s: string): string => s.toLowerCase().replace(/[\s_-]+/g, '')

/** PostScript-style suffix ("Bold", "SemiBoldItalic") → weight/italic. */
export function parseFontStyle(suffix: string): { weight: number; italic: boolean } | null {
  let s = normalizeFontName(suffix)
  let isItalic = false
  for (const it of ['italic', 'oblique']) {
    if (s.endsWith(it)) {
      isItalic = true
      s = s.slice(0, -it.length)
    }
  }
  if (!s) return { weight: 400, italic: isItalic }
  const hit = STYLE_WEIGHTS.find(([n]) => n === s)
  return hit ? { weight: hit[1], italic: isItalic } : null
}

/** Bold/italic swap within a family, never synthesised. */
export const traitWeight = (base: number, bold: boolean): number => (bold ? Math.max(base, 700) : base >= 700 ? 400 : base)

/** Conventional face name for a weight ("Bold", "SemiBold Italic", "Italic"). */
export function faceName(weight: number, isItalic: boolean): string {
  let name = FACE_NAMES[0][1]
  let best = Infinity
  for (const [w, n] of FACE_NAMES) {
    if (Math.abs(w - weight) < best) {
      best = Math.abs(w - weight)
      name = n
    }
  }
  if (!isItalic) return name
  return name === 'Regular' ? 'Italic' : `${name} Italic`
}

/** Bundled family + face for a style, or undefined when the name is not a bundled font. */
export function bundledFontInfo(style: Pick<TextStyle, 'fontName' | 'isBold' | 'isItalic'>): FontInfo | undefined {
  const n = normalizeFontName(style.fontName.trim())
  let fam = BUNDLED_FONT_FAMILIES.find((f) => normalizeFontName(f.family) === n)
  let base = fam?.base ?? 400
  if (!fam) {
    for (const f of BUNDLED_FONT_FAMILIES) {
      const fn = normalizeFontName(f.family)
      if (!n.startsWith(fn)) continue
      const st = parseFontStyle(n.slice(fn.length))
      if (st) {
        fam = f
        base = st.weight
        break
      }
    }
  }
  if (!fam) return undefined
  const want = traitWeight(base, style.isBold)
  const pool = fam.faces.filter((f) => f.italic === style.isItalic)
  const faces = pool.length ? pool : fam.faces
  let best = faces[0]
  let bestD = Infinity
  for (const f of faces) {
    const d = want < f.weight[0] ? f.weight[0] - want : want > f.weight[1] ? want - f.weight[1] : 0
    if (d < bestD) {
      best = f
      bestD = d
    }
  }
  const weight = Math.min(best.weight[1], Math.max(best.weight[0], want))
  return { family: fam.family, face: faceName(weight, best.italic), bold: weight >= 700, italic: best.italic }
}

/** Mac fallback family: the PostScript name before its first dash. */
export function fallbackFontFamily(fontName: string): string {
  return fontName.split('-').find((s) => s.length > 0) ?? fontName
}

/** Mac fallback face when the resolved font lacks the requested traits. */
export function fallbackFontFace(isBold: boolean, isItalic: boolean): string {
  if (isBold && isItalic) return 'Bold Italic'
  if (isBold) return 'Bold'
  if (isItalic) return 'Italic'
  return 'Regular'
}
