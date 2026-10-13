/**
 * REAL SigLIP 2 B/16-256 int8 ONNX towers (spec 07 §2.7) through onnxruntime-node: downloads the pinned 378 MB model
 * once through the model manager, then checks embedding sanity, text↔image ranking on synthetic images, and the Mac's
 * fixture-video e2e (`VisualIndexerTests.indexAndSearchFixture`).
 *
 * Opt-in (network + ~412 MB on first run): PALMIER_REAL_SIGLIP=1 npx vitest run tests/search/realSiglip.test.ts
 * Downloads are kept in PALMIER_TEST_MODELS_ROOT (default ~/.cache/palmier-pro-tests/Models).
 */
import { mkdtempSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { dot } from '../../src/core/search/preprocess'
import { visualSearch } from '../../src/core/search/ranking'
import { ModelManager } from '../../src/main/ml/models'
import { decodeStill } from '../../src/main/ml/search/frames'
import { indexImage, indexVideo } from '../../src/main/ml/search/indexer'
import { SEARCH_MODEL_ID } from '../../src/main/ml/search/model'
import { loadSiglip, SIGLIP_SPEC, type Embedder } from '../../src/main/ml/search/siglip'
import { EmbeddingStore } from '../../src/main/ml/search/store'
import { ffmpeg } from '../../src/main/media/ffmpeg'
import { writePng, writeSceneVideo } from './helpers'

const enabled = process.env.PALMIER_REAL_SIGLIP === '1'
const root = process.env.PALMIER_TEST_MODELS_ROOT ?? path.join(os.homedir(), '.cache', 'palmier-pro-tests', 'Models')
const tmp = mkdtempSync(path.join(os.tmpdir(), 'palmier-real-siglip-'))
afterAll(() => fs.rm(tmp, { recursive: true, force: true }))

const log = (m: string) => console.log(`[real-siglip] ${m}`)
const f3 = (x: number) => x.toFixed(3)

describe.skipIf(!enabled)('real SigLIP 2 (onnxruntime-node, int8)', () => {
  let model: Embedder
  const store = new EmbeddingStore(path.join(tmp, 'Embeddings'))
  const colors = { red: '0xdc1e1e', green: '0x1ec81e', blue: '0x1e1edc' } as const

  beforeAll(async () => {
    const models = new ModelManager({ root })
    let last = -1
    models.on('state', (_id: string, s: { kind: string; fraction?: number }) => {
      const pct = Math.floor((s.fraction ?? 0) * 10)
      if (s.kind === 'downloading' && pct !== last) log(`download ${pct * 10}%`)
      last = pct
    })
    const t0 = Date.now()
    const dir = await models.ensure(SEARCH_MODEL_ID)
    log(`model at ${dir} (${Date.now() - t0} ms incl. verify)`)
    const t1 = Date.now()
    model = await loadSiglip(dir)
    await model.encodeText('warm up')
    log(`loaded both towers + warm-up in ${Date.now() - t1} ms (intraOp threads = max(1, cpus/2) = ${Math.max(1, Math.floor(os.cpus().length / 2))})`)
  }, 900_000)

  afterAll(() => model?.dispose())

  it('produces L2-normalized 768-d vectors, deterministically', async () => {
    const a = await model.encodeText('a photo of a dog')
    const b = await model.encodeText('a photo of a dog')
    expect(a.length).toBe(768)
    expect(dot(a, a)).toBeCloseTo(1, 4)
    expect(dot(a, b)).toBeCloseTo(1, 5)
    expect(model.spec).toEqual(SIGLIP_SPEC)
  }, 60_000)

  it('text ↔ text: paraphrases are closer than unrelated captions', async () => {
    const dog = await model.encodeText('a photo of a dog')
    const puppy = await model.encodeText('a picture of a puppy')
    const city = await model.encodeText('a city skyline at night')
    const sDog = dot(dog, puppy)
    const sCity = dot(dog, city)
    log(`cos(dog, puppy) = ${f3(sDog)}, cos(dog, city skyline) = ${f3(sCity)}`)
    expect(sDog).toBeGreaterThan(sCity)
  }, 60_000)

  it('text → image: each color query ranks its own solid image first', async () => {
    const vecs: Record<string, Float32Array> = {}
    let ms = 0
    for (const [name, c] of Object.entries(colors)) {
      const img = (await decodeStill(await writePng(path.join(tmp, `${name}.png`), c, '320x180')))!
      const t = Date.now()
      vecs[name] = await model.encodeImage(img.rgba, img.width, img.height)
      ms += Date.now() - t
      expect(dot(vecs[name], vecs[name])).toBeCloseTo(1, 4)
    }
    log(`image encode ≈ ${(ms / 3).toFixed(0)} ms each`)
    for (const name of Object.keys(colors)) {
      const q = await model.encodeText(`a plain solid ${name} image`)
      const scores = Object.fromEntries(Object.entries(vecs).map(([k, v]) => [k, dot(q, v)]))
      log(`"a plain solid ${name} image": ${Object.entries(scores).map(([k, s]) => `${k}=${f3(s)}`).join(' ')}`)
      const best = Object.entries(scores).sort((x, y) => y[1] - x[1])[0][0]
      expect(best).toBe(name)
    }
  }, 120_000)

  it('text → image: a checkerboard vs a solid color', async () => {
    const checker = path.join(tmp, 'checker.png')
    await ffmpeg(['-y', '-f', 'lavfi', '-i', 'color=c=white:s=256x256', '-vf', "geq=lum='if(eq(mod(floor(X/32)+floor(Y/32),2),0),255,0)':cb=128:cr=128", '-frames:v', '1', checker])
    const img = (await decodeStill(checker))!
    const vChecker = await model.encodeImage(img.rgba, img.width, img.height)
    const red = (await decodeStill(path.join(tmp, 'red.png')))!
    const vRed = await model.encodeImage(red.rgba, red.width, red.height)
    const q = await model.encodeText('a black and white checkerboard pattern')
    log(`"a black and white checkerboard pattern": checker=${f3(dot(q, vChecker))} red=${f3(dot(q, vRed))}`)
    expect(dot(q, vChecker)).toBeGreaterThan(dot(q, vRed))
  }, 60_000)

  it('fixture video e2e: "a plain solid red image" hits the red scene (Mac VisualIndexerTests)', async () => {
    const video = await writeSceneVideo(path.join(tmp, 'fixture.mp4'), [
      { color: colors.blue, seconds: 10 },
      { color: colors.red, seconds: 10 },
      { color: colors.green, seconds: 10 },
    ])
    const t = Date.now()
    await indexVideo(video, 30, { store, embedder: model })
    const index = await store.load(store.key(video)!)
    log(`indexed 30 s fixture: ${index.rows.length} frames in ${Date.now() - t} ms; shots ${[...new Set(index.rows.map((r) => r.shotStart))].join(', ')}`)
    expect(index.header).toMatchObject({ model: 'siglip2-base-patch16-256', modelVersion: 101, samplerVersion: 1, dim: 768 })
    expect(index.rows.length).toBeGreaterThanOrEqual(3)
    const q = await model.encodeText('a plain solid red image')
    const hits = visualSearch(q, [{ assetId: 'fixture', index }], { minScore: 0.05 })
    log(`hits: ${hits.map((h) => `${h.time.toFixed(2)}s [${h.shotStart}–${h.shotEnd}] ${f3(h.score)}`).join('; ')}`)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].time).toBeGreaterThanOrEqual(9)
    expect(hits[0].time).toBeLessThan(21)
    expect(hits[0].shotStart).toBeGreaterThanOrEqual(7.5)
    expect(hits[0].shotEnd).toBeLessThanOrEqual(22.5)
  }, 300_000)

  it('still image index: one row, query finds it', async () => {
    const png = path.join(tmp, 'green.png')
    await indexImage(png, { store, embedder: model })
    const index = await store.load(store.key(png)!)
    expect(index.rows).toEqual([{ time: 0, shotStart: 0, shotEnd: 0 }])
    const hits = visualSearch(await model.encodeText('a plain solid green image'), [{ assetId: 'g', index }], { minScore: 0.05 })
    log(`still green score ${hits[0] ? f3(hits[0].score) : 'none'}`)
    expect(hits.length).toBe(1)
  }, 60_000)
})
