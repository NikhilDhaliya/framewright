/**
 * Embedding store codec (spec 07 §2.4, Mac `Search/Indexing/EmbeddingStore.swift`), byte-exact:
 *
 *   "PALMEMB1" | uint32 LE jsonLength | JSON header | N × (f64 time, f64 shotStart, f64 shotEnd, dim × f16)
 *
 * Pure: encode/decode bytes only. File IO and keys live in `src/main/ml/search/store.ts`.
 */

export interface EmbeddingHeader {
  model: string
  modelVersion: number
  samplerVersion: number
  dim: number
  count: number
}

export interface EmbeddingRow {
  time: number
  shotStart: number
  shotEnd: number
}

export interface AssetIndex {
  header: EmbeddingHeader
  rows: EmbeddingRow[]
  /** Flat count × dim. */
  vectors: Float32Array
}

export class CorruptEmbeddingFile extends Error {
  constructor(message = 'corrupt') {
    super(message)
    this.name = 'CorruptEmbeddingFile'
  }
}

const MAGIC = new TextEncoder().encode('PALMEMB1')
export const EMBED_PREFIX_BYTES = MAGIC.length + 4

// ---------- IEEE 754 half precision (no DataView.getFloat16 on Node 22) ----------

const f32 = new Float32Array(1)
const u32 = new Uint32Array(f32.buffer)

/** float32 → float16 bits, round to nearest even (same as Swift `Float16(Float)`). */
export function toHalf(value: number): number {
  f32[0] = value
  const x = u32[0]
  const sign = (x >>> 16) & 0x8000
  const exp = (x >>> 23) & 0xff
  let mant = x & 0x7fffff
  if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0) // inf / nan
  let e = exp - 127 + 15
  if (e >= 0x1f) return sign | 0x7c00 // overflow → inf
  if (e <= 0) {
    if (e < -10) return sign // underflow → ±0
    mant |= 0x800000
    const shift = 14 - e
    let half = mant >>> shift
    const rem = mant & ((1 << shift) - 1)
    const halfway = 1 << (shift - 1)
    if (rem > halfway || (rem === halfway && (half & 1))) half++
    return sign | half
  }
  let half = (e << 10) | (mant >>> 13)
  const rem = mant & 0x1fff
  if (rem > 0x1000 || (rem === 0x1000 && (half & 1))) half++ // may carry into the exponent: still correct
  return sign | half
}

export function fromHalf(h: number): number {
  const sign = h & 0x8000 ? -1 : 1
  const exp = (h >>> 10) & 0x1f
  const mant = h & 0x3ff
  if (exp === 0) return sign * mant * 2 ** -24
  if (exp === 0x1f) return mant ? NaN : sign * Infinity
  return sign * (1 + mant / 1024) * 2 ** (exp - 15)
}

// ---------- codec ----------

export function encodeEmbeddings(header: EmbeddingHeader, rows: EmbeddingRow[], vectors: ArrayLike<number>): Uint8Array {
  if (rows.length !== header.count || vectors.length !== header.count * header.dim) throw new Error('EmbeddingStore.save: rows/vectors do not match the header')
  const json = new TextEncoder().encode(
    JSON.stringify({ model: header.model, modelVersion: header.modelVersion, samplerVersion: header.samplerVersion, dim: header.dim, count: header.count }),
  )
  const rowBytes = 24 + header.dim * 2
  const out = new Uint8Array(EMBED_PREFIX_BYTES + json.length + header.count * rowBytes)
  const dv = new DataView(out.buffer)
  out.set(MAGIC, 0)
  dv.setUint32(MAGIC.length, json.length, true)
  out.set(json, EMBED_PREFIX_BYTES)
  let o = EMBED_PREFIX_BYTES + json.length
  for (let i = 0; i < rows.length; i++) {
    dv.setFloat64(o, rows[i].time, true)
    dv.setFloat64(o + 8, rows[i].shotStart, true)
    dv.setFloat64(o + 16, rows[i].shotEnd, true)
    o += 24
    for (let d = 0; d < header.dim; d++, o += 2) dv.setUint16(o, toHalf(vectors[i * header.dim + d]), true)
  }
  return out
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0

function parseHeader(json: Uint8Array): EmbeddingHeader {
  let h: unknown
  try {
    h = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(json))
  } catch {
    throw new CorruptEmbeddingFile()
  }
  const o = h as Record<string, unknown>
  if (!o || typeof o !== 'object' || typeof o.model !== 'string' || !isInt(o.modelVersion) || !isInt(o.samplerVersion) || !isInt(o.dim) || !isInt(o.count)) {
    throw new CorruptEmbeddingFile()
  }
  return { model: o.model, modelVersion: o.modelVersion, samplerVersion: o.samplerVersion, dim: o.dim, count: o.count }
}

/** Header from the first bytes of a file (prefix + JSON), or null when they are not an embed file. */
export function decodeEmbeddingHeader(bytes: Uint8Array): EmbeddingHeader | null {
  if (bytes.length < EMBED_PREFIX_BYTES || !MAGIC.every((b, i) => bytes[i] === b)) return null
  const len = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(MAGIC.length, true)
  if (bytes.length < EMBED_PREFIX_BYTES + len) return null
  try {
    return parseHeader(bytes.subarray(EMBED_PREFIX_BYTES, EMBED_PREFIX_BYTES + len))
  } catch {
    return null
  }
}

/** Length of the JSON header announced by the 12-byte prefix (for partial reads), or null. */
export function headerLength(prefix: Uint8Array): number | null {
  if (prefix.length < EMBED_PREFIX_BYTES || !MAGIC.every((b, i) => prefix[i] === b)) return null
  return new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength).getUint32(MAGIC.length, true)
}

export function decodeEmbeddings(bytes: Uint8Array): AssetIndex {
  if (bytes.length <= EMBED_PREFIX_BYTES || !MAGIC.every((b, i) => bytes[i] === b)) throw new CorruptEmbeddingFile()
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const len = dv.getUint32(MAGIC.length, true)
  if (bytes.length < EMBED_PREFIX_BYTES + len) throw new CorruptEmbeddingFile()
  const header = parseHeader(bytes.subarray(EMBED_PREFIX_BYTES, EMBED_PREFIX_BYTES + len))
  const rowBytes = 24 + header.dim * 2
  let o = EMBED_PREFIX_BYTES + len
  if (bytes.length !== o + header.count * rowBytes) throw new CorruptEmbeddingFile()
  const rows: EmbeddingRow[] = []
  const vectors = new Float32Array(header.count * header.dim)
  for (let i = 0; i < header.count; i++) {
    rows.push({ time: dv.getFloat64(o, true), shotStart: dv.getFloat64(o + 8, true), shotEnd: dv.getFloat64(o + 16, true) })
    o += 24
    for (let d = 0; d < header.dim; d++, o += 2) vectors[i * header.dim + d] = fromHalf(dv.getUint16(o, true))
  }
  return { header, rows, vectors }
}

/** "Current" = model, modelVersion and samplerVersion all match (spec 07 §2.4). */
export function isCurrentHeader(h: EmbeddingHeader | null, spec: { model: string; modelVersion: number; samplerVersion: number }): boolean {
  return !!h && h.model === spec.model && h.modelVersion === spec.modelVersion && h.samplerVersion === spec.samplerVersion
}
