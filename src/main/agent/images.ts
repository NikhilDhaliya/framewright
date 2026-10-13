/** Inline image encoding for image mentions (spec 06 §A5.3; Utilities/ImageEncoder.swift), via ffmpeg. */
import fs from 'node:fs/promises'
import { ffmpeg } from '../media/ffmpeg'

export const MAX_INLINE_BYTES = 3_500_000
export const MAX_INLINE_EDGE = 1568
const JPEG_QUALITIES = [0.85, 0.7, 0.55, 0.4]
const CACHE_LIMIT = 32

export interface EncodedImage {
  mediaType: string
  data: Buffer
}

type Kind = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'

/** Real container type from the magic bytes (not the extension). */
export function sniffImageType(buf: Buffer): Kind | null {
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47) return 'image/png'
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf.length >= 6 && buf.toString('latin1', 0, 4) === 'GIF8') return 'image/gif'
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp'
  return null
}

/** Pixel size from the header of a PNG, JPEG, GIF or WebP file. */
export function sniffImageSize(buf: Buffer, kind: Kind): { width: number; height: number } | null {
  switch (kind) {
    case 'image/png':
      return buf.length >= 24 ? { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) } : null
    case 'image/gif':
      return buf.length >= 10 ? { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) } : null
    case 'image/webp': {
      if (buf.length < 30) return null
      const chunk = buf.toString('latin1', 12, 16)
      if (chunk === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) }
      if (chunk === 'VP8L') {
        const b = buf.readUInt32LE(21)
        return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 }
      }
      if (chunk === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff }
      return null
    }
    case 'image/jpeg': {
      let i = 2
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) {
          i++
          continue
        }
        const marker = buf[i + 1]
        if (marker === 0xff) {
          i++
          continue
        }
        const len = buf.readUInt16BE(i + 2)
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) }
        i += 2 + len
      }
      return null
    }
  }
}

async function reencode(file: string): Promise<EncodedImage | null> {
  // Fit the longest edge to 1568 (never upscale), keep the aspect, even sizes are not required for MJPEG.
  const fit = `scale='if(gte(iw,ih),min(${MAX_INLINE_EDGE},iw),-2)':'if(gte(iw,ih),-2,min(${MAX_INLINE_EDGE},ih))':flags=lanczos`
  for (const q of JPEG_QUALITIES) {
    const qv = Math.max(2, Math.min(31, Math.round(2 + (1 - q) * 10)))
    try {
      const data = await ffmpeg(['-i', file, '-frames:v', '1', '-vf', fit, '-c:v', 'mjpeg', '-pix_fmt', 'yuvj444p', '-q:v', String(qv), '-f', 'image2', 'pipe:1'])
      if (data.length && data.length <= MAX_INLINE_BYTES) return { mediaType: 'image/jpeg', data }
    } catch {
      return null
    }
  }
  return null
}

/** Encodes one image file for an inline image block; memoized by (path, size, mtime), 32 entries. */
export class InlineImageEncoder {
  private cache = new Map<string, EncodedImage | null>()

  async encode(file: string): Promise<EncodedImage | null> {
    let key: string
    try {
      const st = await fs.stat(file)
      key = `${file}\u0000${st.size}\u0000${st.mtimeMs}`
    } catch {
      return null
    }
    if (this.cache.has(key)) return this.cache.get(key)!
    const result = await this.encodeUncached(file)
    if (this.cache.size >= CACHE_LIMIT) this.cache.clear()
    this.cache.set(key, result)
    return result
  }

  private async encodeUncached(file: string): Promise<EncodedImage | null> {
    let bytes: Buffer
    try {
      bytes = await fs.readFile(file)
    } catch {
      return null
    }
    const kind = sniffImageType(bytes)
    if (kind && bytes.length <= MAX_INLINE_BYTES) {
      const size = sniffImageSize(bytes, kind)
      if (size && Math.max(size.width, size.height) <= MAX_INLINE_EDGE) return { mediaType: kind, data: bytes }
    }
    return reencode(file)
  }
}
