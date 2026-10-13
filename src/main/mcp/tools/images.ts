/** Raster helpers for inspection tools: size sniffing, ffmpeg decode/encode, and the 0–1 grid overlay. */
import { ffmpeg } from '../../media/ffmpeg'

export interface Size {
  width: number
  height: number
}

export interface Rgba extends Size {
  data: Buffer
}

/** Pixel size from a PNG or JPEG header. */
export function imageSize(buf: Buffer): Size | null {
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null
  let i = 2
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i++
      continue
    }
    const marker = buf[i + 1]
    const len = buf.readUInt16BE(i + 2)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) }
    i += 2 + len
  }
  return null
}

/** Longest edge capped at `max`, aspect preserved, rounded. */
export function fitWithin(size: Size, max: number): Size {
  const longest = Math.max(size.width, size.height)
  if (longest <= max) return size
  const s = max / longest
  return { width: Math.max(1, Math.round(size.width * s)), height: Math.max(1, Math.round(size.height * s)) }
}

export interface DecodeOptions {
  /** Output size (scaled to exactly this). */
  size: Size
  /** Source-pixel crop applied before scaling. */
  crop?: { x: number; y: number; width: number; height: number }
}

/** Decodes an image buffer or file to RGBA8 at an explicit size. */
export async function decodeRgba(input: Buffer | string, o: DecodeOptions): Promise<Rgba> {
  const filters = [
    ...(o.crop ? [`crop=${Math.max(1, Math.round(o.crop.width))}:${Math.max(1, Math.round(o.crop.height))}:${Math.round(o.crop.x)}:${Math.round(o.crop.y)}`] : []),
    `scale=${o.size.width}:${o.size.height}:flags=bilinear`,
  ]
  const src = typeof input === 'string' ? ['-i', input] : ['-f', 'image2pipe', '-i', 'pipe:0']
  const data = await ffmpeg([...src, '-frames:v', '1', '-vf', filters.join(','), '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], typeof input === 'string' ? {} : { input })
  if (data.length < o.size.width * o.size.height * 4) throw new Error('Image decode produced no pixels')
  return { data, width: o.size.width, height: o.size.height }
}

const codecArgs = (format: 'jpeg' | 'png', quality: number) =>
  format === 'png' ? ['-c:v', 'png'] : ['-c:v', 'mjpeg', '-pix_fmt', 'yuvj444p', '-q:v', String(Math.max(2, Math.min(31, Math.round(2 + (1 - quality) * 10))))]

export function encodeImage(img: Rgba, format: 'jpeg' | 'png', quality = 0.7): Promise<Buffer> {
  return ffmpeg(['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${img.width}x${img.height}`, '-i', 'pipe:0', '-frames:v', '1', ...codecArgs(format, quality), '-f', 'image2', 'pipe:1'], { input: img.data })
}

/** Re-encodes an encoded image (optionally cropped, in source pixels) without a raw round trip. */
export function transcodeImage(input: Buffer, format: 'jpeg' | 'png', quality: number, crop?: DecodeOptions['crop']): Promise<Buffer> {
  const vf = crop ? ['-vf', `crop=${Math.max(1, Math.round(crop.width))}:${Math.max(1, Math.round(crop.height))}:${Math.round(crop.x)}:${Math.round(crop.y)}`] : []
  return ffmpeg(['-f', 'image2pipe', '-i', 'pipe:0', '-frames:v', '1', ...vf, ...codecArgs(format, quality), '-f', 'image2', 'pipe:1'], { input })
}

// ---------- Grid overlay ----------

const GLYPHS: Record<string, string[]> = {
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
  f: ['00110', '01001', '01000', '11100', '01000', '01000', '01000'],
  ':': ['00000', '01100', '01100', '00000', '01100', '01100', '00000'],
}

function blend(img: Rgba, x: number, y: number, gray: number, alpha: number): void {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return
  const i = (y * img.width + x) * 4
  for (let c = 0; c < 3; c++) img.data[i + c] = Math.round(img.data[i + c] * (1 - alpha) + gray * 255 * alpha)
}

function fillRect(img: Rgba, x: number, y: number, w: number, h: number, gray: number, alpha: number): void {
  for (let yy = Math.max(0, Math.floor(y)); yy < Math.min(img.height, Math.ceil(y + h)); yy++)
    for (let xx = Math.max(0, Math.floor(x)); xx < Math.min(img.width, Math.ceil(x + w)); xx++) blend(img, xx, yy, gray, alpha)
}

const textWidth = (text: string, scale: number) => text.length * 6 * scale - scale

function drawText(img: Rgba, text: string, x: number, y: number, scale: number): void {
  ;[...text].forEach((ch, n) => {
    const rows = GLYPHS[ch]
    if (!rows) return
    rows.forEach((row, ry) => {
      for (let rx = 0; rx < 5; rx++) if (row[rx] === '1') fillRect(img, x + (n * 6 + rx) * scale, y + ry * scale, scale, scale, 1, 1)
    })
  })
}

export function chipLabel(img: Rgba, text: string, x: number, y: number, scale: number): void {
  const w = textWidth(text, scale)
  fillRect(img, x, y, w + 4 * scale, 7 * scale + 4 * scale, 0, 0.65)
  drawText(img, text, x + 2 * scale, y + 2 * scale, scale)
}

/** Burns the 0–1 coordinate grid (origin top-left), edge labels and an optional caption into `img`. */
export function overlayGrid(img: Rgba, caption?: string): Rgba {
  const { width: w, height: h } = img
  const line = (pos: number, vertical: boolean, lw: number, gray: number, alpha: number) => {
    const extent = vertical ? w : h
    const center = Math.min(Math.max(0.5, pos), extent - 0.5)
    const from = Math.round(center - lw / 2)
    const to = Math.max(from + 1, Math.round(center + lw / 2))
    if (vertical) fillRect(img, from, 0, to - from, h, gray, alpha)
    else fillRect(img, 0, from, w, to - from, gray, alpha)
  }
  for (const major of [false, true]) {
    for (let i = 0; i <= 20; i++) {
      if ((i % 10 === 0) !== major) continue
      const t = i / 20
      for (const [lw, gray, alpha] of major ? ([[2.5, 0, 0.65], [1.5, 1, 0.95]] as const) : ([[2, 0, 0.55], [1, 1, 0.75]] as const)) {
        line(t * w, true, lw, gray, alpha)
        line(t * h, false, lw, gray, alpha)
      }
    }
  }
  const scale = Math.min(w, h) >= 600 ? 2 : 1
  const chipH = 11 * scale
  for (let i = 0; i <= 10; i++) {
    const t = i / 10
    const label = i === 0 ? '0' : i === 10 ? '1' : t.toFixed(1)
    const cw = textWidth(label, scale) + 4 * scale
    if (i !== 10) chipLabel(img, label, Math.min(Math.max(0, t * w - cw / 2), w - cw - 2), h - chipH - 2, scale)
    chipLabel(img, label, w - cw - 2, Math.min(Math.max(2, t * h - chipH / 2), h - chipH - 2), scale)
  }
  if (caption) chipLabel(img, caption, 0, 0, scale)
  return img
}

/** Copies `src` into `dst` with its top-left at (x, y). */
export function blit(dst: Rgba, src: Rgba, x: number, y: number): void {
  for (let row = 0; row < src.height; row++) {
    const dy = y + row
    if (dy < 0 || dy >= dst.height) continue
    const from = row * src.width * 4
    const width = Math.min(src.width, dst.width - x)
    if (width > 0) src.data.copy(dst.data, (dy * dst.width + x) * 4, from, from + width * 4)
  }
}
