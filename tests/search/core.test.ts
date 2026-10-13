/** Pure smart-search logic (spec 07 §2.2–2.5): preprocessing, sampler, ranking, the embedding codec. */
import { describe, expect, it } from 'vitest'
import { dot, imageToPixelValues, l2Normalize, padTokenIds, squashResizeRgb, toPixelValues } from '../../src/core/search/preprocess'
import { visualSearch, VISUAL_MATCH_COSINE_FLOOR } from '../../src/core/search/ranking'
import { candidateTimes, DEFAULT_SAMPLER_OPTIONS, lumaGrid, lumaMeanDiff, samplerInterval, samplerTolerance, shotRows, ShotDetector } from '../../src/core/search/sampler'
import {
  CorruptEmbeddingFile,
  decodeEmbeddingHeader,
  decodeEmbeddings,
  encodeEmbeddings,
  fromHalf,
  headerLength,
  isCurrentHeader,
  toHalf,
  type AssetIndex,
} from '../../src/core/search/store'

const solid = (w: number, h: number, rgba: [number, number, number, number]) => {
  const out = new Uint8Array(w * h * 4)
  for (let i = 0; i < w * h; i++) out.set(rgba, i * 4)
  return out
}

describe('preprocess', () => {
  it('maps bytes to NCHW planes with v/127.5 − 1', () => {
    const size = 2
    const rgb = new Uint8Array([0, 255, 127, 255, 0, 51, 10, 20, 30, 40, 50, 60])
    const px = toPixelValues(rgb, size)
    expect(px.length).toBe(12)
    // R plane, then G, then B.
    expect(px[0]).toBeCloseTo(-1, 6)
    expect(px[1]).toBeCloseTo(1, 6)
    expect(px[4]).toBeCloseTo(1, 6) // G of pixel 0
    expect(px[8]).toBeCloseTo(127 / 127.5 - 1, 6) // B of pixel 0
    expect(px[3]).toBeCloseTo(40 / 127.5 - 1, 6)
    expect(px[11]).toBeCloseTo(60 / 127.5 - 1, 6)
  })

  it('squash-resizes without cropping and composites alpha over black', () => {
    // Left half red, right half blue, 400×100 → the 256² output keeps both halves (no aspect crop).
    const w = 400
    const h = 100
    const img = new Uint8Array(w * h * 4)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) img.set(x < w / 2 ? [255, 0, 0, 255] : [0, 0, 255, 255], (y * w + x) * 4)
    const out = squashResizeRgb(img, w, h, 256)
    expect(Array.from(out.subarray(0, 3))).toEqual([255, 0, 0])
    const last = (256 * 256 - 1) * 3
    expect(Array.from(out.subarray(last, last + 3))).toEqual([0, 0, 255])
    const halfAlpha = squashResizeRgb(solid(10, 10, [200, 100, 50, 128]), 10, 10, 4)
    expect(Array.from(halfAlpha.subarray(0, 3))).toEqual([100, 50, 25])
    const transparent = imageToPixelValues(solid(8, 8, [255, 255, 255, 0]), 8, 8, 4)
    expect(Array.from(transparent).every((v) => v === -1)).toBe(true)
  })

  it('upscales small images and returns 3×256×256 values', () => {
    const px = imageToPixelValues(solid(3, 5, [255, 255, 255, 255]), 3, 5)
    expect(px.length).toBe(3 * 256 * 256)
    expect(Array.from(px.subarray(0, 100)).every((v) => v === 1)).toBe(true)
  })

  it('truncates to 64 and right-pads with 0 (no attention mask)', () => {
    const short = padTokenIds([5, 6, 1])
    expect(short.length).toBe(64)
    expect(short.slice(0, 4)).toEqual([5, 6, 1, 0])
    const long = padTokenIds(Array.from({ length: 80 }, (_, i) => i + 2))
    expect(long.length).toBe(64)
    expect(long[63]).toBe(65)
    expect(long.every((x) => x !== 0)).toBe(true)
  })

  it('L2-normalizes', () => {
    const v = l2Normalize(new Float32Array([3, 4]))
    expect(v[0]).toBeCloseTo(0.6, 6)
    expect(dot(v, v)).toBeCloseTo(1, 6)
    expect(Array.from(l2Normalize(new Float32Array([0, 0])))).toEqual([0, 0])
  })
})

describe('frame sampler v1', () => {
  it('candidate times, interval doubling and tolerance', () => {
    expect(samplerInterval(1920, 1080)).toBe(2)
    expect(samplerInterval(3840, 2160)).toBe(4)
    expect(samplerInterval(-3000, 10)).toBe(4)
    expect(candidateTimes(10, 2)).toEqual([1, 3, 5, 7, 9])
    expect(candidateTimes(0.6, 2)).toEqual([0.3])
    expect(candidateTimes(1, 2)).toEqual([0.5])
    expect(candidateTimes(0, 2)).toEqual([])
    expect(candidateTimes(-1, 2)).toEqual([])
    expect(candidateTimes(2, 2)).toEqual([1])
    expect(samplerTolerance(2)).toBe(1)
    expect(samplerTolerance(4)).toBe(2)
    expect(DEFAULT_SAMPLER_OPTIONS).toEqual({ candidateInterval: 2, coverageFloor: 8, promoteDiff: 12, maxSize: 512, highResEdge: 3000 })
  })

  it('luma grid: 8×8 area average, Rec.601 weights, alpha over black', () => {
    const g = lumaGrid(solid(16, 16, [255, 0, 0, 255]), 16, 16)
    expect(g.length).toBe(64)
    expect(g[0]).toBeCloseTo(0.299 * 255, 3)
    const white = lumaGrid(solid(9, 7, [255, 255, 255, 255]), 9, 7)
    expect(white[63]).toBeCloseTo(255, 3)
    expect(lumaGrid(solid(8, 8, [255, 255, 255, 0]), 8, 8)[0]).toBe(0)
    // Left half black, right half white: the columns split cleanly.
    const img = new Uint8Array(16 * 16 * 4)
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) img.set(x < 8 ? [0, 0, 0, 255] : [255, 255, 255, 255], (y * 16 + x) * 4)
    const split = lumaGrid(img, 16, 16)
    expect(split[3]).toBe(0)
    expect(split[4]).toBeCloseTo(255, 3)
    expect(lumaMeanDiff(split, new Float32Array(64))).toBeCloseTo(127.5, 3)
  })

  it('shot detector: new shots on > 12 luma jumps, coverage floor 8 s, monotonic times', () => {
    const grid = (v: number) => new Float32Array(64).fill(v)
    const d = new ShotDetector()
    expect(d.accept(1, grid(50))).toEqual({ keep: true, isNewShot: true })
    expect(d.accept(3, grid(55))).toEqual({ keep: false, isNewShot: false })
    expect(d.accept(3, grid(200))).toBeNull() // not after the previous decoded frame
    expect(d.accept(5, grid(62))).toEqual({ keep: false, isNewShot: false }) // diff 7 vs the last grid
    expect(d.accept(7, grid(74.5))).toEqual({ keep: true, isNewShot: true }) // diff 12.5
    expect(d.accept(9, grid(80))).toEqual({ keep: false, isNewShot: false })
    expect(d.accept(15, grid(80))).toEqual({ keep: true, isNewShot: false }) // 15 − 7 ≥ 8
    expect(d.accept(16, grid(92))).toEqual({ keep: false, isNewShot: false }) // diff exactly 12 is not a new shot
  })

  it('shot rows: first shot starts at 0, ends at the next start or the duration', () => {
    const rows = shotRows(
      [
        { time: 1, isNewShot: true },
        { time: 9, isNewShot: false },
        { time: 11, isNewShot: true },
        { time: 21, isNewShot: true },
        { time: 29, isNewShot: false },
      ],
      30,
    )
    expect(rows).toEqual([
      { time: 1, shotStart: 0, shotEnd: 11 },
      { time: 9, shotStart: 0, shotEnd: 11 },
      { time: 11, shotStart: 11, shotEnd: 21 },
      { time: 21, shotStart: 21, shotEnd: 30 },
      { time: 29, shotStart: 21, shotEnd: 30 },
    ])
    expect(shotRows([], 5)).toEqual([])
  })
})

// Ported from the Mac `VisualSearchTests.swift`.
function index(vectors: number[][], shots: [number, number, number][]): AssetIndex {
  return {
    header: { model: 'test', modelVersion: 1, samplerVersion: 1, dim: vectors[0].length, count: vectors.length },
    rows: shots.map(([time, shotStart, shotEnd]) => ({ time, shotStart, shotEnd })),
    vectors: Float32Array.from(vectors.flat()),
  }
}

describe('visual ranking', () => {
  it('ranks and cuts off', () => {
    const idx = index(
      [
        [1, 0, 0],
        [0.9, 0.1, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
      [
        [1, 0, 4],
        [5, 4, 8],
        [9, 8, 12],
        [13, 12, 16],
      ],
    )
    const hits = visualSearch([1, 0, 0], [{ assetId: 'a', index: idx }])
    expect(hits[0].time).toBe(1)
    expect(hits[0].score).toBe(1)
    expect(hits.some((h) => h.time === 9 || h.time === 13)).toBe(false)
    expect(hits.map((h) => h.time)).toEqual([1, 5])
    expect(hits[1]).toEqual({ assetId: 'a', time: 5, shotStart: 4, shotEnd: 8, score: Math.fround(0.9) })
  })

  it('best per shot dedupes', () => {
    const idx = index(
      [
        [1, 0, 0],
        [0.99, 0.01, 0],
        [0.5, 0.5, 0],
      ],
      [
        [1, 0, 10],
        [5, 0, 10],
        [9, 0, 10],
      ],
    )
    const hits = visualSearch([1, 0, 0], [{ assetId: 'a', index: idx }])
    expect(hits.length).toBe(1)
    expect(hits[0].time).toBe(1)
  })

  it('merges across assets', () => {
    const a = index([[1, 0, 0]], [[1, 0, 2]])
    const b = index([[0.95, 0.05, 0]], [[3, 2, 4]])
    expect(visualSearch([1, 0, 0], [{ assetId: 'a', index: a }, { assetId: 'b', index: b }]).map((h) => h.assetId)).toEqual(['a', 'b'])
  })

  it('empty and mismatched dims', () => {
    const idx = index([[1, 0]], [[1, 0, 2]])
    expect(visualSearch([1, 0, 0], [{ assetId: 'a', index: idx }])).toEqual([])
    expect(visualSearch([1, 0], [])).toEqual([])
  })

  it('cosine floor drops a weak top match', () => {
    const weak = index([[0.04, 0, 0]], [[1, 0, 2]])
    expect(visualSearch([1, 0, 0], [{ assetId: 'a', index: weak }], { minScore: VISUAL_MATCH_COSINE_FLOOR })).toEqual([])
    expect(visualSearch([1, 0, 0], [{ assetId: 'a', index: weak }]).length).toBe(1)
    const strong = index([[0.5, 0, 0]], [[1, 0, 2]])
    expect(visualSearch([1, 0, 0], [{ assetId: 'a', index: strong }], { minScore: VISUAL_MATCH_COSINE_FLOOR }).length).toBe(1)
  })

  it('non-positive top score → []; limit applies before the relative cutoff', () => {
    const neg = index([[-1, 0, 0]], [[1, 0, 2]])
    expect(visualSearch([1, 0, 0], [{ assetId: 'a', index: neg }])).toEqual([])
    const many = index(
      Array.from({ length: 30 }, (_, i) => [1 - i * 0.001, 0, 0]),
      Array.from({ length: 30 }, (_, i): [number, number, number] => [i, i, i + 1]),
    )
    expect(visualSearch([1, 0, 0], [{ assetId: 'a', index: many }]).length).toBe(20)
    expect(visualSearch([1, 0, 0], [{ assetId: 'a', index: many }], { limit: 5 }).map((h) => h.time)).toEqual([0, 1, 2, 3, 4])
  })
})

describe('embedding codec (PALMEMB1)', () => {
  const header = { model: 'test-model', modelVersion: 1, samplerVersion: 1, dim: 16, count: 3 }
  const rows = [
    { time: 1.25, shotStart: 0, shotEnd: 4.5 },
    { time: 6.0, shotStart: 4.5, shotEnd: 9.0 },
    { time: 12.5, shotStart: 9.0, shotEnd: 20.0 },
  ]
  const vectors = Array.from({ length: 48 }, (_, i) => i / 10)

  it('round-trips (Mac EmbeddingStoreTests.roundTrip)', () => {
    const bytes = encodeEmbeddings(header, rows, vectors)
    const loaded = decodeEmbeddings(bytes)
    expect(loaded.header).toEqual(header)
    expect(loaded.rows).toEqual(rows)
    for (let i = 0; i < vectors.length; i++) expect(Math.abs(loaded.vectors[i] - vectors[i])).toBeLessThan(0.01)
  })

  it('is byte-exact: magic, uint32 LE length, JSON, f64 rows, f16 LE vectors', () => {
    const bytes = encodeEmbeddings({ model: 'm', modelVersion: 101, samplerVersion: 1, dim: 2, count: 1 }, [{ time: 1.5, shotStart: 0, shotEnd: 3 }], [1, -2])
    const json = '{"model":"m","modelVersion":101,"samplerVersion":1,"dim":2,"count":1}'
    expect(new TextDecoder().decode(bytes.subarray(0, 8))).toBe('PALMEMB1')
    const dv = new DataView(bytes.buffer)
    expect(dv.getUint32(8, true)).toBe(json.length)
    expect(new TextDecoder().decode(bytes.subarray(12, 12 + json.length))).toBe(json)
    const o = 12 + json.length
    expect(bytes.length).toBe(o + 24 + 4)
    expect(dv.getFloat64(o, true)).toBe(1.5)
    expect(dv.getFloat64(o + 16, true)).toBe(3)
    expect(dv.getUint16(o + 24, true)).toBe(0x3c00)
    expect(dv.getUint16(o + 26, true)).toBe(0xc000)
    expect(headerLength(bytes)).toBe(json.length)
    expect(decodeEmbeddingHeader(bytes.subarray(0, o))).toEqual({ model: 'm', modelVersion: 101, samplerVersion: 1, dim: 2, count: 1 })
  })

  it('rejects corrupt files', () => {
    expect(() => decodeEmbeddings(new TextEncoder().encode('not an embed file'))).toThrow(CorruptEmbeddingFile)
    const good = encodeEmbeddings(header, rows, vectors)
    expect(() => decodeEmbeddings(good.subarray(0, good.length - 1))).toThrow(CorruptEmbeddingFile)
    const extra = new Uint8Array(good.length + 2)
    extra.set(good)
    expect(() => decodeEmbeddings(extra)).toThrow(CorruptEmbeddingFile)
    expect(decodeEmbeddingHeader(new TextEncoder().encode('PALMEMB1'))).toBeNull()
    expect(() => encodeEmbeddings(header, rows.slice(1), vectors)).toThrow()
  })

  it('versioning: current only when model, modelVersion and samplerVersion all match', () => {
    const spec = { model: 'test-model', modelVersion: 1, samplerVersion: 1 }
    expect(isCurrentHeader(header, spec)).toBe(true)
    expect(isCurrentHeader(header, { ...spec, modelVersion: 2 })).toBe(false)
    expect(isCurrentHeader(header, { ...spec, samplerVersion: 2 })).toBe(false)
    expect(isCurrentHeader(header, { ...spec, model: 'other' })).toBe(false)
    expect(isCurrentHeader(null, spec)).toBe(false)
  })

  it('float16: round to nearest even, subnormals, inf/nan', () => {
    expect(toHalf(1)).toBe(0x3c00)
    expect(toHalf(65504)).toBe(0x7bff)
    expect(toHalf(65520)).toBe(0x7c00)
    expect(toHalf(-0)).toBe(0x8000)
    expect(toHalf(2 ** -24)).toBe(1)
    expect(toHalf(2 ** -26)).toBe(0)
    expect(toHalf(Infinity)).toBe(0x7c00)
    expect(Number.isNaN(fromHalf(toHalf(NaN)))).toBe(true)
    expect(toHalf(1 + 2 ** -11)).toBe(0x3c00) // halfway → even
    expect(toHalf(1 + 3 * 2 ** -11)).toBe(0x3c02)
    for (const v of [0.1, -0.333, 0.7071, 1e-5, 12345]) expect(Math.abs(fromHalf(toHalf(v)) - v)).toBeLessThanOrEqual(Math.abs(v) * 2 ** -11 + 2 ** -25)
  })
})
