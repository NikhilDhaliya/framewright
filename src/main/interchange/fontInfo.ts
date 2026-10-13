/**
 * Font family/face for FCPXML titles (Mac `TextStyle.resolvedFont` + symbolic traits): bundled fonts map through the
 * shared table; system fonts resolve with fontconfig. A name fontconfig only substitutes (e.g. Helvetica → Nimbus
 * Sans) resolves to nothing, so the exporter writes the requested family for the editing app to match.
 */
import { execFile } from 'node:child_process'
import { bundledFontInfo, fallbackFontFace, normalizeFontName, type FontInfo, type FontInfoResolver } from '../../core/interchange'
import type { TextStyle } from '../../core/model'

export type FcMatchRunner = (args: string[]) => Promise<string>

type FontStyle = Pick<TextStyle, 'fontName' | 'isBold' | 'isItalic'>

const FC_REGULAR = 80
const FC_BOLD = 200

export const fcMatch: FcMatchRunner = (args) =>
  new Promise((resolve, reject) => {
    execFile('fc-match', args, { timeout: 5000, maxBuffer: 64 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)))
  })

/** fontconfig pattern value escaping. */
const fcEscape = (s: string) => s.replace(/[\\:,=\-]/g, (c) => `\\${c}`)

const families = (field: string) => field.split(',').map((f) => f.trim()).filter(Boolean)

/** The installed family a PostScript or family name denotes, with the named face's weight. */
async function systemFamily(name: string, run: FcMatchRunner): Promise<{ family: string; weight: number } | undefined> {
  const byPostScript = (await run(['-f', '%{family}\n%{postscriptname}\n%{weight}', `:postscriptname=${fcEscape(name)}`])).split('\n')
  if (byPostScript.length >= 3 && byPostScript[1].trim().toLowerCase() === name.toLowerCase()) {
    return { family: families(byPostScript[0])[0], weight: Number(byPostScript[2]) || FC_REGULAR }
  }
  const byFamily = (await run(['-f', '%{family}\n%{weight}', `:family=${fcEscape(name)}`])).split('\n')
  const hit = families(byFamily[0] ?? '').find((f) => normalizeFontName(f) === normalizeFontName(name))
  return hit ? { family: hit, weight: FC_REGULAR } : undefined
}

export async function resolveFontInfo(style: FontStyle, run: FcMatchRunner = fcMatch): Promise<FontInfo | undefined> {
  const bundled = bundledFontInfo(style)
  if (bundled) return bundled
  const name = style.fontName.trim()
  if (!name) return undefined
  try {
    const base = await systemFamily(name, run)
    if (!base) return undefined
    const weight = style.isBold ? Math.max(FC_BOLD, base.weight) : base.weight >= FC_BOLD ? FC_REGULAR : base.weight
    const out = (await run(['-f', '%{family}\n%{style[0]}\n%{weight}', `:family=${fcEscape(base.family)}:weight=${weight}:slant=${style.isItalic ? 100 : 0}`])).split('\n')
    if (out.length < 3 || !families(out[0]).includes(base.family)) return { family: base.family, face: fallbackFontFace(style.isBold, style.isItalic), bold: style.isBold, italic: style.isItalic }
    // fontconfig reports a synthesized oblique in %{slant}; the face name tells whether the font really is italic.
    const face = out[1].trim()
    return { family: base.family, face, bold: Number(out[2]) >= FC_BOLD, italic: /italic|oblique/i.test(face) }
  } catch {
    return undefined
  }
}

/** Resolves every distinct style once (fc-match is a process spawn) and serves the results synchronously. */
export async function fontInfoResolver(styles: Iterable<FontStyle>, run: FcMatchRunner = fcMatch): Promise<FontInfoResolver> {
  const key = (s: FontStyle) => `${s.fontName}\u0000${s.isBold}\u0000${s.isItalic}`
  const resolved = new Map<string, FontInfo | undefined>()
  for (const s of styles) {
    const k = key(s)
    if (!resolved.has(k)) resolved.set(k, await resolveFontInfo(s, run))
  }
  return (s) => resolved.get(key(s))
}

