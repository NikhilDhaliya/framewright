/** FFmpeg frame sampling, the on-disk embedding store and one-asset indexing with a fake embedder (spec 07 §2.3–2.4). */
import { createHash } from 'node:crypto'
import { mkdtempSync, statSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { visualSearch } from '../../src/core/search/ranking'
import { SAMPLER_VERSION } from '../../src/core/search/sampler'
import { decodeStill, parsePam, sampleFrames, type SampledFrame } from '../../src/main/ml/search/frames'
import { indexImage, indexSpecOf, indexVideo } from '../../src/main/ml/search/indexer'
import { EmbeddingStore } from '../../src/main/ml/search/store'
import { FAKE_SPEC, fakeEmbedder, writePng, writeSceneVideo } from './helpers'

const tmp = mkdtempSync(path.join(os.tmpdir(), 'palmier-search-index-'))
afterAll(() => fs.rm(tmp, { recursive: true, force: true }))

const RED = '0xdc1e1e'
const GREEN = '0x1ec81e'
const BLUE = '0x1e1edc'
let threeScenes: string

beforeAll(async () => {
  threeScenes = await writeSceneVideo(path.join(tmp, 'scenes.mp4'), [
    { color: RED, seconds: 10 },
    { color: GREEN, seconds: 10 },
    { color: BLUE, seconds: 10 },
  ])
}, 60_000)

async function collect(it: AsyncIterable<SampledFrame>): Promise<SampledFrame[]> {
  const out: SampledFrame[] = []
  for await (const f of it) out.push(f)
  return out
}

describe('frame sampler (FFmpeg)', () => {
  it('detects scenes and honours the coverage floor (Mac FrameSamplerTests)', async () => {
    const frames = await collect(sampleFrames(threeScenes, 30))
    const starts = frames.filter((f) => f.isNewShot).map((f) => f.time)
    expect(starts.length).toBe(3)
    expect(frames[0].isNewShot).toBe(true)
    expect(starts.slice(1).every((t) => Math.abs(t - 10) <= 2.5 || Math.abs(t - 20) <= 2.5)).toBe(true)
    expect(frames.length).toBeGreaterThan(starts.length)
    for (let i = 1; i < frames.length; i++) expect(frames[i].time).toBeGreaterThan(frames[i - 1].time)
    // Frames fit within 512 px without upscaling; RGBA.
    expect(frames[0].width).toBe(320)
    expect(frames[0].rgba.length).toBe(320 * 180 * 4)
  }, 60_000)

  it('short clip gets one midpoint sample', async () => {
    const short = await writeSceneVideo(path.join(tmp, 'short.mp4'), [{ color: RED, seconds: 0.6 }])
    const frames = await collect(sampleFrames(short, 0.6))
    expect(frames.length).toBe(1)
    expect(frames[0].isNewShot).toBe(true)
    expect(await collect(sampleFrames(short, 0))).toEqual([])
  }, 30_000)

  it('undecodable input yields nothing; PAM parsing and stills', async () => {
    const bogus = path.join(tmp, 'bogus.mp4')
    await fs.writeFile(bogus, 'not a video')
    expect(await collect(sampleFrames(bogus, 5))).toEqual([])
    expect(parsePam(Buffer.from('P6\n1 1\n255\n'))).toBeNull()
    const rgb = parsePam(Buffer.concat([Buffer.from('P7\nWIDTH 1\nHEIGHT 1\nDEPTH 3\nMAXVAL 255\nTUPLTYPE RGB\nENDHDR\n'), Buffer.from([1, 2, 3])]))
    expect(rgb && Array.from(rgb.rgba)).toEqual([1, 2, 3, 255])
    const big = await writePng(path.join(tmp, 'big.png'), RED, '1600x900')
    const still = await decodeStill(big)
    expect(still && [still.width, still.height]).toEqual([512, 288])
    expect(await decodeStill(bogus)).toBeNull()
  }, 30_000)
})

describe('embedding store on disk', () => {
  const dir = path.join(tmp, 'Embeddings')
  const store = new EmbeddingStore(dir)
  const spec = { model: 'fake-siglip', modelVersion: 7, samplerVersion: SAMPLER_VERSION }

  it('keys files by SHA-256("<path>|<mtime>|<size>")[0..32] and re-keys on modification', async () => {
    const f = path.join(tmp, 'k.bin')
    await fs.writeFile(f, 'abc')
    const st = statSync(f)
    expect(store.key(f)).toBe(createHash('sha256').update(`${f}|${st.mtimeMs / 1000}|3`).digest('hex').slice(0, 32))
    expect(store.key(f)).toMatch(/^[0-9a-f]{32}$/)
    const before = store.key(f)
    await fs.utimes(f, new Date(), new Date(Date.now() + 5000))
    expect(store.key(f)).not.toBe(before)
    expect(store.key(path.join(tmp, 'missing.bin'))).toBeNull()
    expect(store.key(tmp)).toBeNull()
    expect(store.file('abc')).toBe(path.join(dir, 'abc.embed'))
  })

  it('saves atomically, reads headers, and versions by model/modelVersion/samplerVersion', async () => {
    const f = path.join(tmp, 'v.bin')
    await fs.writeFile(f, 'v')
    const key = store.key(f)!
    expect(await store.needsIndex(f, spec)).toBe(true)
    await store.save({ ...spec, dim: 2, count: 1 }, [{ time: 1, shotStart: 0, shotEnd: 2 }], [0.6, 0.8], key)
    expect(await fs.readdir(dir)).toEqual([`${key}.embed`])
    expect(await store.header(key)).toEqual({ ...spec, dim: 2, count: 1 })
    expect(await store.needsIndex(f, spec)).toBe(false)
    expect(await store.needsIndex(f, { ...spec, modelVersion: 8 })).toBe(true)
    expect(await store.needsIndex(f, { ...spec, samplerVersion: 2 })).toBe(true)
    expect(await store.needsIndex(f, { ...spec, model: 'siglip2-base-patch16-256' })).toBe(true)
    expect(await store.needsIndex(path.join(tmp, 'gone.bin'), spec)).toBe(false)
    const loaded = await store.load(key)
    expect(loaded.rows).toEqual([{ time: 1, shotStart: 0, shotEnd: 2 }])
    expect(await store.bytes()).toBeGreaterThan(12)
  })

  it('treats corrupt files as missing headers; load throws', async () => {
    await fs.writeFile(store.file('corrupt'), 'not an embed file')
    expect(await store.header('corrupt')).toBeNull()
    expect(await store.isCurrent('corrupt', spec)).toBe(false)
    await expect(store.load('corrupt')).rejects.toThrow()
    expect(await store.header('nonexistent')).toBeNull()
    await store.clearAll()
    expect(await fs.stat(dir).catch(() => null)).toBeNull()
  })
})

describe('indexing one asset (fake embedder)', () => {
  const store = new EmbeddingStore(path.join(tmp, 'Embeddings-idx'))
  const spec = indexSpecOf(FAKE_SPEC)

  it('video: frames → rows with shot ranges; a red query lands in the red scene', async () => {
    const embedder = fakeEmbedder()
    const progress: number[] = []
    await indexVideo(threeScenes, 30, { store, embedder }, (f) => progress.push(f))
    expect(await store.needsIndex(threeScenes, spec)).toBe(false)
    const index = await store.load(store.key(threeScenes)!)
    expect(index.header).toEqual({ model: 'fake-siglip', modelVersion: 7, samplerVersion: 1, dim: 8, count: index.rows.length })
    expect(index.rows.length).toBe(embedder.images)
    expect(index.rows.length).toBeGreaterThanOrEqual(3)
    expect(index.rows[0].shotStart).toBe(0)
    expect(index.rows[index.rows.length - 1].shotEnd).toBe(30)
    expect(progress.length).toBe(index.rows.length)
    expect(progress.every((p, i) => p > 0 && p <= 1 && (i === 0 || p >= progress[i - 1]))).toBe(true)
    const hits = visualSearch(await embedder.encodeText('red'), [{ assetId: 'v', index }], { minScore: 0.05 })
    expect(hits.length).toBe(1) // one hit per shot; green/blue fall below the relative cutoff
    expect(hits[0].shotStart).toBe(0)
    expect(hits[0].shotEnd).toBeGreaterThanOrEqual(7.5)
    expect(hits[0].shotEnd).toBeLessThanOrEqual(12.5)
    const green = visualSearch(await embedder.encodeText('green'), [{ assetId: 'v', index }])
    expect(green[0].time).toBeGreaterThanOrEqual(9)
    expect(green[0].time).toBeLessThan(21)
    // Current index: a second run does nothing.
    await indexVideo(threeScenes, 30, { store, embedder })
    expect(embedder.images).toBe(index.rows.length)
  }, 60_000)

  it('waits for exports before every frame; cancellation writes nothing', async () => {
    const short = await writeSceneVideo(path.join(tmp, 'short2.mp4'), [{ color: BLUE, seconds: 6 }])
    const embedder = fakeEmbedder()
    let waits = 0
    await indexVideo(short, 6, { store, embedder, waitWhileExportActive: async () => void waits++ })
    expect(waits).toBe(embedder.images)
    const other = await writeSceneVideo(path.join(tmp, 'short3.mp4'), [{ color: GREEN, seconds: 6 }])
    const controller = new AbortController()
    const e2 = fakeEmbedder()
    e2.beforeImage = () => controller.abort()
    await expect(indexVideo(other, 6, { store, embedder: e2, signal: controller.signal })).rejects.toThrow(/Abort/)
    expect(await store.needsIndex(other, spec)).toBe(true)
  }, 60_000)

  it('image: one zero-length row; undecodable files store an empty index and are not retried', async () => {
    const png = await writePng(path.join(tmp, 'still.png'), RED)
    const embedder = fakeEmbedder()
    await indexImage(png, { store, embedder })
    const index = await store.load(store.key(png)!)
    expect(index.rows).toEqual([{ time: 0, shotStart: 0, shotEnd: 0 }])
    expect(index.vectors.length).toBe(8)
    const bogusImg = path.join(tmp, 'bogus.png')
    await fs.writeFile(bogusImg, 'nope')
    await indexImage(bogusImg, { store, embedder })
    expect((await store.load(store.key(bogusImg)!)).header.count).toBe(0)
    expect(await store.needsIndex(bogusImg, spec)).toBe(false)
    const bogusVid = path.join(tmp, 'bogus2.mp4')
    await fs.writeFile(bogusVid, 'not a video')
    await indexVideo(bogusVid, 5, { store, embedder })
    expect((await store.load(store.key(bogusVid)!)).rows).toEqual([])
    expect(await store.needsIndex(bogusVid, spec)).toBe(false)
  }, 30_000)
})
