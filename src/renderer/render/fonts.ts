/**
 * Font resolution for text rendering (spec 04 §9.4): the fonts macOS bundles are registered with FontFace in
 * every renderer (preview, render host); PostScript/family names map onto them; other names fall back to
 * system fonts, Helvetica to a metric-compatible substitute and anything unknown to Inter.
 */
import type { TextStyle } from '@core/model'
import { mediaUrl } from '../../shared/api'

interface BundledFace {
  url: string
  weight: [number, number]
  italic: boolean
}

interface BundledFamily {
  family: string
  faces: BundledFace[]
  /** Weight of the face the bare family name selects. */
  base: number
}

const face = (url: string, lo: number, hi = lo, italic = false): BundledFace => ({ url, weight: [lo, hi], italic })

const BUNDLED: BundledFamily[] = [
  { family: 'Inter', base: 400, faces: [face(new URL('../../../resources/fonts/Inter/Inter-Variable.ttf', import.meta.url).href, 100, 900)] },
  { family: 'DM Sans', base: 400, faces: [face(new URL('../../../resources/fonts/DMSans/DMSans-Variable.ttf', import.meta.url).href, 100, 1000)] },
  {
    family: 'Geist',
    base: 400,
    faces: [
      face(new URL('../../../resources/fonts/Geist/Geist-Variable.ttf', import.meta.url).href, 100, 900),
      face(new URL('../../../resources/fonts/Geist/Geist-Italic-Variable.ttf', import.meta.url).href, 100, 900, true),
    ],
  },
  {
    family: 'Geist Mono',
    base: 400,
    faces: [
      face(new URL('../../../resources/fonts/GeistMono/GeistMono-Variable.ttf', import.meta.url).href, 100, 900),
      face(new URL('../../../resources/fonts/GeistMono/GeistMono-Italic-Variable.ttf', import.meta.url).href, 100, 900, true),
    ],
  },
  { family: 'Playfair Display', base: 400, faces: [face(new URL('../../../resources/fonts/PlayfairDisplay/PlayfairDisplay-Variable.ttf', import.meta.url).href, 400, 900)] },
  {
    family: 'Poppins',
    base: 400,
    faces: [
      face(new URL('../../../resources/fonts/Poppins/Poppins-Regular.ttf', import.meta.url).href, 400),
      face(new URL('../../../resources/fonts/Poppins/Poppins-Bold.ttf', import.meta.url).href, 700),
      face(new URL('../../../resources/fonts/Poppins/Poppins-Italic.ttf', import.meta.url).href, 400, 400, true),
      face(new URL('../../../resources/fonts/Poppins/Poppins-BoldItalic.ttf', import.meta.url).href, 700, 700, true),
    ],
  },
  { family: 'Space Grotesk', base: 400, faces: [face(new URL('../../../resources/fonts/SpaceGrotesk/SpaceGrotesk-Variable.ttf', import.meta.url).href, 300, 700)] },
  { family: 'Caveat', base: 400, faces: [face(new URL('../../../resources/fonts/Caveat/Caveat-Variable.ttf', import.meta.url).href, 400, 700)] },
  { family: 'Shrikhand', base: 400, faces: [face(new URL('../../../resources/fonts/Shrikhand/Shrikhand-Regular.ttf', import.meta.url).href, 400)] },
  { family: 'Bebas Neue', base: 400, faces: [face(new URL('../../../resources/fonts/BebasNeue/BebasNeue-Regular.ttf', import.meta.url).href, 400)] },
  { family: 'Anton', base: 400, faces: [face(new URL('../../../resources/fonts/Anton/Anton-Regular.ttf', import.meta.url).href, 400)] },
  { family: 'Permanent Marker', base: 400, faces: [face(new URL('../../../resources/fonts/PermanentMarker/PermanentMarker-Regular.ttf', import.meta.url).href, 400)] },
  { family: 'Basement Grotesque', base: 900, faces: [face(new URL('../../../resources/fonts/BasementGrotesque/BasementGrotesque-Black.ttf', import.meta.url).href, 900)] },
]

/** Families the font picker can offer. */
export const BUNDLED_FAMILIES: readonly string[] = BUNDLED.map((f) => f.family)

const STYLE_WEIGHTS: [string, number][] = [
  ['thin', 100], ['hairline', 100], ['extralight', 200], ['ultralight', 200], ['light', 300], ['regular', 400], ['book', 400], ['normal', 400],
  ['medium', 500], ['semibold', 600], ['demibold', 600], ['bold', 700], ['extrabold', 800], ['ultrabold', 800], ['black', 900], ['heavy', 900],
]

const norm = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, '')

/** Splits a PostScript-style suffix ("Bold", "SemiBoldItalic") into weight/italic. */
function parseStyle(suffix: string): { weight: number; italic: boolean } | null {
  let s = norm(suffix)
  let italic = false
  for (const it of ['italic', 'oblique']) {
    if (s.endsWith(it)) {
      italic = true
      s = s.slice(0, -it.length)
    }
  }
  if (!s) return { weight: 400, italic }
  const hit = STYLE_WEIGHTS.find(([n]) => n === s)
  return hit ? { weight: hit[1], italic } : null
}

const SANS_SUBSTITUTES = ['Liberation Sans', 'Arimo', 'Nimbus Sans', 'Nimbus Sans L', 'Helvetica', 'Arial']
const HELVETICA = new Set(['helvetica', 'helveticaneue', 'arial', 'arialmt', 'sfpro', 'sfprotext', 'sfprodisplay', 'sfns', 'systemfont', '.applesystemuifont'])

export interface FontMetrics {
  /** Per em, positive. */
  ascent: number
  descent: number
  lineGap: number
  underlinePosition: number
  underlineThickness: number
  strikeoutPosition: number
  strikeoutSize: number
}

export interface ResolvedFont {
  /** CSS font-family list. */
  family: string
  weight: number
  italic: boolean
  /** null = measure from the canvas (system fonts). */
  metrics: FontMetrics | null
  key: string
}

const metricsByFamily = new Map<string, FontMetrics>()
const quote = (f: string) => `"${f.replace(/"/g, '')}"`

function pickFace(fam: BundledFamily, weight: number, italic: boolean): { weight: number; italic: boolean } {
  const pool = fam.faces.filter((f) => f.italic === italic)
  const faces = pool.length ? pool : fam.faces
  let best = faces[0]
  let bestD = Infinity
  for (const f of faces) {
    const d = weight < f.weight[0] ? f.weight[0] - weight : weight > f.weight[1] ? weight - f.weight[1] : 0
    if (d < bestD) {
      best = f
      bestD = d
    }
  }
  return { weight: Math.min(best.weight[1], Math.max(best.weight[0], weight)), italic: best.italic }
}

/** Bold/italic swap within the family; never synthesised (§9.4). */
function traitWeight(base: number, bold: boolean): number {
  if (bold) return Math.max(base, 700)
  return base >= 700 ? 400 : base
}

const resolvedCache = new Map<string, ResolvedFont>()

export function resolveFont(style: Pick<TextStyle, 'fontName' | 'isBold' | 'isItalic'>): ResolvedFont {
  const cacheKey = `${style.fontName}|${style.isBold}|${style.isItalic}|${metricsByFamily.size}`
  const hit = resolvedCache.get(cacheKey)
  if (hit) return hit
  const r = resolveUncached(style)
  if (resolvedCache.size > 512) resolvedCache.clear()
  resolvedCache.set(cacheKey, r)
  return r
}

function resolveUncached(style: Pick<TextStyle, 'fontName' | 'isBold' | 'isItalic'>): ResolvedFont {
  const name = style.fontName.trim()
  const n = norm(name)
  const fallback = BUNDLED[0]
  let fam: BundledFamily | undefined = BUNDLED.find((f) => norm(f.family) === n)
  let base = fam?.base ?? 400
  if (!fam) {
    for (const f of BUNDLED) {
      const fn = norm(f.family)
      if (n.startsWith(fn)) {
        const st = parseStyle(n.slice(fn.length))
        if (st) {
          fam = f
          base = st.weight
          break
        }
      }
    }
  }
  if (fam) {
    const want = pickFace(fam, traitWeight(base, style.isBold), style.isItalic)
    return { family: quote(fam.family), weight: want.weight, italic: want.italic, metrics: metricsByFamily.get(fam.family) ?? null, key: `${fam.family}|${want.weight}|${want.italic}` }
  }
  const dash = name.indexOf('-')
  const familyPart = dash > 0 ? name.slice(0, dash) : name
  const st = dash > 0 ? parseStyle(name.slice(dash + 1)) : null
  const baseWeight = st?.weight ?? 400
  const weight = traitWeight(baseWeight, style.isBold)
  // System faces cannot be enumerated here, so Chromium may synthesise a missing bold/italic [APPROX].
  const italic = style.isItalic
  if (HELVETICA.has(norm(familyPart))) {
    const family = [...SANS_SUBSTITUTES.map(quote), quote(fallback.family)].join(', ')
    return { family, weight, italic, metrics: null, key: `helvetica|${weight}|${italic}` }
  }
  const family = [...new Set([name, familyPart])].map(quote).concat(quote(fallback.family)).join(', ')
  return { family, weight, italic, metrics: null, key: `${name}|${weight}|${italic}` }
}

export function cssFont(f: ResolvedFont, px: number): string {
  return `${f.italic ? 'italic ' : ''}${f.weight} ${px}px ${f.family}`
}

/** Reads hhea/head/post/OS-2 metrics from an sfnt (TrueType/OpenType) file. */
export function readFontMetrics(buf: ArrayBuffer): FontMetrics | null {
  try {
    const v = new DataView(buf)
    const numTables = v.getUint16(4)
    const tables = new Map<string, number>()
    for (let i = 0; i < numTables; i++) {
      const rec = 12 + i * 16
      const tag = String.fromCharCode(v.getUint8(rec), v.getUint8(rec + 1), v.getUint8(rec + 2), v.getUint8(rec + 3))
      tables.set(tag, v.getUint32(rec + 8))
    }
    const head = tables.get('head')
    const hhea = tables.get('hhea')
    if (head === undefined || hhea === undefined) return null
    const upm = v.getUint16(head + 18) || 1000
    const post = tables.get('post')
    const os2 = tables.get('OS/2')
    const ascent = v.getInt16(hhea + 4) / upm
    const descent = -v.getInt16(hhea + 6) / upm
    const lineGap = v.getInt16(hhea + 8) / upm
    const underlinePosition = post !== undefined ? v.getInt16(post + 8) / upm : -0.1
    const underlineThickness = post !== undefined ? v.getInt16(post + 10) / upm : 0.05
    const strikeoutSize = os2 !== undefined ? v.getInt16(os2 + 26) / upm : 0.05
    const strikeoutPosition = os2 !== undefined ? v.getInt16(os2 + 28) / upm : 0.3
    return { ascent, descent, lineGap, underlinePosition, underlineThickness, strikeoutPosition, strikeoutSize }
  } catch {
    return null
  }
}

type NodeRequire = (id: string) => unknown

async function readBytes(url: string): Promise<ArrayBuffer> {
  const req = (globalThis as { require?: NodeRequire }).require
  if (url.startsWith('file:') && typeof req === 'function') {
    const fs = req('fs/promises') as { readFile(p: string): Promise<Uint8Array> }
    const { fileURLToPath } = req('url') as { fileURLToPath(u: string): string }
    const b = await fs.readFile(fileURLToPath(url))
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
  }
  const fetchable = url.startsWith('file:') ? mediaUrl(decodeURIComponent(new URL(url).pathname)) : url
  const res = await fetch(fetchable)
  if (!res.ok) throw new Error(`Font fetch failed: ${res.status}`)
  return res.arrayBuffer()
}

let loading: Promise<void> | null = null
const listeners = new Set<() => void>()

/** Registers the bundled fonts once per document; resolves when all have loaded (failures are skipped). */
export function loadBundledFonts(): Promise<void> {
  if (loading) return loading
  if (typeof FontFace === 'undefined') return (loading = Promise.resolve())
  const fontSet = (globalThis as { document?: Document }).document?.fonts ?? (globalThis as unknown as { fonts?: FontFaceSet }).fonts
  loading = Promise.all(
    BUNDLED.flatMap((fam) =>
      fam.faces.map(async (f) => {
        try {
          const bytes = await readBytes(f.url)
          if (!f.italic && !metricsByFamily.has(fam.family)) {
            const m = readFontMetrics(bytes)
            if (m) metricsByFamily.set(fam.family, m)
          }
          const ff = new FontFace(fam.family, bytes, {
            weight: f.weight[0] === f.weight[1] ? String(f.weight[0]) : `${f.weight[0]} ${f.weight[1]}`,
            style: f.italic ? 'italic' : 'normal',
          })
          await ff.load()
          fontSet?.add(ff)
        } catch (e) {
          console.warn(`Font ${fam.family} failed to load`, e)
        }
      }),
    ),
  ).then(() => {
    resolvedCache.clear()
    for (const l of listeners) l()
  })
  return loading
}

/** Called once bundled fonts finish loading (text caches must be invalidated). */
export function onFontsLoaded(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** Waits until the system fonts a set of styles needs are available to canvas text. */
export async function ensureFonts(styles: Iterable<Pick<TextStyle, 'fontName' | 'isBold' | 'isItalic'>>): Promise<void> {
  await loadBundledFonts()
  const fontSet = (globalThis as { document?: Document }).document?.fonts ?? (globalThis as unknown as { fonts?: FontFaceSet }).fonts
  if (!fontSet) return
  const seen = new Set<string>()
  const pending: Promise<unknown>[] = []
  for (const s of styles) {
    const f = resolveFont(s)
    if (seen.has(f.key)) continue
    seen.add(f.key)
    pending.push(fontSet.load(cssFont(f, 32)).catch(() => undefined))
  }
  await Promise.all(pending)
}
