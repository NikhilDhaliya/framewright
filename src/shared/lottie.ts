/**
 * Lottie format helpers shared by the main process, the renderer and the render host (spec 07 §4).
 * Pure: no Node or DOM APIs beyond TextDecoder/TextEncoder, so every bundle (and the unit tests) can use it.
 */
import { strFromU8, unzipSync } from 'fflate'

/** `LottieVideoGenerator.jsonSniffByteLimit`. */
export const LOTTIE_SNIFF_BYTES = 256 * 1024
/** Longest side of the rendered animation (`maxEncoderDimension`). */
export const LOTTIE_MAX_SIDE = 4096
/** Library thumbnails and inspect_media frames are rendered fit-within this many px. */
export const LOTTIE_THUMBNAIL_SIDE = 512

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]
const SIGNATURE_KEYS = ['layers', 'v', 'w', 'h', 'op']
const SIGNATURE_RES = SIGNATURE_KEYS.map((k) => new RegExp(`"${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*:`))
const isJsonWhitespace = (b: number) => b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d

/**
 * `LottieVideoGenerator.isLottie` on a file's leading bytes: a `.lottie` must start with the ZIP magic; anything else
 * must start with `{` (after JSON whitespace) and carry the keys layers, v, w, h, op within the first 256 KiB.
 * `ext` is the file extension without the dot, any case.
 */
export function sniffLottie(ext: string, head: Uint8Array): boolean {
  if (ext.toLowerCase() === 'lottie') return head.length >= 4 && ZIP_MAGIC.every((b, i) => head[i] === b)
  const data = head.length > LOTTIE_SNIFF_BYTES ? head.subarray(0, LOTTIE_SNIFF_BYTES) : head
  let first = -1
  for (let i = 0; i < data.length; i++) {
    if (!isJsonWhitespace(data[i])) {
      first = data[i]
      break
    }
  }
  if (first !== 0x7b) return false
  const text = new TextDecoder('utf-8', { fatal: false }).decode(data)
  return SIGNATURE_RES.every((re) => re.test(text))
}

/** Bodymovin composition (the fields the editor reads; lottie-web reads the rest). */
export interface LottieJson {
  v?: string
  w: number
  h: number
  fr: number
  ip: number
  op: number
  layers: unknown[]
  assets?: LottieAsset[]
  [key: string]: unknown
}

interface LottieAsset {
  id?: string
  u?: string
  p?: string
  e?: number
  [key: string]: unknown
}

export interface LottieMeta {
  width: number
  height: number
  /** Animation frame rate (`fr`). */
  fps: number
  ip: number
  op: number
  /** `max(1, round(op − ip))`. */
  frameCount: number
  /** `(op − ip) / fr` seconds. */
  duration: number
}

/** Swift `.rounded()` (half away from zero). */
const swiftRound = (v: number) => (v >= 0 ? Math.floor(v + 0.5) : -Math.floor(-v + 0.5))

export const lottieFrameCount = (ip: number, op: number) => Math.max(1, swiftRound(op - ip))

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** `LottieVideoGenerator.metadata(for:)`; throws when the composition lacks the required numbers. */
export function lottieMeta(anim: unknown): LottieMeta {
  const a = anim as Partial<LottieJson> | null
  if (!a || typeof a !== 'object' || Array.isArray(a) || !Array.isArray(a.layers)) throw new Error('not a Lottie animation.')
  const { w, h, fr, ip, op } = a
  if (!finite(w) || !finite(h) || !finite(fr) || !finite(ip) || !finite(op) || !(w > 0) || !(h > 0) || !(fr > 0)) throw new Error('not a Lottie animation.')
  return { width: w, height: h, fps: fr, ip, op, frameCount: lottieFrameCount(ip, op), duration: Math.max(0, (op - ip) / fr) }
}

/**
 * Animation frame (relative to `ip`) shown at source second `srcSec` (spec 07 §4.1): the baked movie holds frame `i`
 * from `i / max(1, fr)` s, and its last frame forever.
 */
export function lottieFrameIndex(srcSec: number, fps: number, frameCount: number): number {
  const rate = Math.max(1, Number.isFinite(fps) ? fps : 1)
  const i = Math.floor((Number.isFinite(srcSec) ? srcSec : 0) * rate + 1e-6)
  return Math.min(Math.max(1, frameCount) - 1, Math.max(0, i))
}

/** Even pixel size (`even`): `max(2, floor(v) − floor(v) % 2)`. */
const even = (v: number) => {
  const px = Math.floor(v)
  return Math.max(2, px - (px % 2))
}

/** `clampedForEncoder`: longest side ≤ 4096, then each side even. */
export function lottieRenderSize(width: number, height: number, maxSide = LOTTIE_MAX_SIDE): { width: number; height: number } {
  const w = Math.max(1, Number.isFinite(width) ? width : 1)
  const h = Math.max(1, Number.isFinite(height) ? height : 1)
  const longest = Math.max(w, h)
  const k = longest > maxSide ? maxSide / longest : 1
  return { width: even(w * k), height: even(h * k) }
}

/** `fit(_:longestSide:)`: scaled down (never up) so the longest side is at most `longest`. */
export function fitLongestSide(width: number, height: number, longest: number): { width: number; height: number } {
  const l = Math.max(width, height)
  if (!(l > longest) || !(l > 0)) return { width, height }
  const k = longest / l
  return { width: width * k, height: height * k }
}

/** Thumbnail / inspect frame size: fit within `side`, then clamped and even (`inspect`, `sampleFrames`). */
export function lottieThumbnailSize(width: number, height: number, side = LOTTIE_THUMBNAIL_SIDE): { width: number; height: number } {
  const f = fitLongestSide(width, height, side)
  return lottieRenderSize(f.width, f.height)
}

/** `sampleFrames`: `n = max(1, min(count, frameCount))` indices `round((frameCount − 1)·i/(n − 1))`. */
export function lottieSampleIndices(frameCount: number, count: number): number[] {
  const fc = Math.max(1, Math.trunc(frameCount))
  const n = Math.max(1, Math.min(Math.trunc(count), fc))
  return Array.from({ length: n }, (_, i) => swiftRound((fc - 1) * (n === 1 ? 0 : i / (n - 1))))
}

// ---------- dotLottie ----------

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export function base64(bytes: Uint8Array): string {
  let out = ''
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
    out += B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63]
  }
  if (i < bytes.length) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8)
    out += B64[n >> 18] + B64[(n >> 12) & 63] + (i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=') + '='
  }
  return out
}

const IMAGE_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml', bmp: 'image/bmp' }

const stripSlash = (p: string) => p.replace(/^\.?\/+/, '')

/**
 * The first animation of a dotLottie archive with its images inlined as data URIs (`e: 1`): `manifest.json` →
 * `animations[0].id` → `animations/<id>.json` (v1) or `a/<id>.json` (v2), images from `images/` or `i/`.
 */
export function extractDotLottie(zip: Uint8Array): LottieJson {
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(zip)
  } catch {
    throw new Error('not a Lottie animation.')
  }
  const names = Object.keys(files)
  const lookup = (p: string): Uint8Array | undefined => files[p] ?? files[stripSlash(p)]
  let animPath: string | undefined
  const manifestBytes = lookup('manifest.json')
  if (manifestBytes) {
    try {
      const manifest = JSON.parse(strFromU8(manifestBytes)) as { animations?: { id?: string }[] }
      const id = manifest.animations?.[0]?.id
      if (id) animPath = [`animations/${id}.json`, `a/${id}.json`].find((p) => lookup(p))
    } catch {
      // Fall back to the first animation in the archive.
    }
  }
  animPath ??= names.filter((n) => /^(animations|a)\/[^/]+\.json$/.test(n)).sort()[0]
  if (!animPath) throw new Error('not a Lottie animation.')
  let anim: LottieJson
  try {
    anim = JSON.parse(strFromU8(lookup(animPath)!)) as LottieJson
  } catch {
    throw new Error('not a Lottie animation.')
  }
  for (const asset of Array.isArray(anim.assets) ? anim.assets : []) {
    if (!asset || typeof asset.p !== 'string' || asset.e === 1 || asset.p.startsWith('data:')) continue
    const file = asset.p
    const candidates = [`${asset.u ?? ''}${file}`, `images/${file}`, `i/${file}`]
    const bytes = candidates.map(lookup).find((b): b is Uint8Array => !!b)
    if (!bytes) continue
    const ext = file.split('.').pop()?.toLowerCase() ?? ''
    asset.p = `data:${IMAGE_MIME[ext] ?? 'image/png'};base64,${base64(bytes)}`
    asset.u = ''
    asset.e = 1
  }
  return anim
}

/** Parses a `.json` Lottie or the first animation of a `.lottie` archive. */
export function parseLottie(ext: string, bytes: Uint8Array): LottieJson {
  if (ext.toLowerCase() === 'lottie') return extractDotLottie(bytes)
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as LottieJson
  } catch {
    throw new Error('not a Lottie animation.')
  }
}

/** `palmier-media://lottie/<path>`: the animation JSON of a `.json` or `.lottie` file, served by the main process. */
export function lottieMediaUrl(absPath: string): string {
  return `palmier-media://lottie${absPath.split('/').map(encodeURIComponent).join('/')}`
}

export const extensionOf = (file: string) => {
  const base = file.slice(file.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}
