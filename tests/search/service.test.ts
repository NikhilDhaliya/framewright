/**
 * Smart search end to end with a fake embedder (spec 07 §2.1, §2.5, §2.7; 02 §3.11): model state machine and download,
 * indexing triggers, export pause, transcripts during indexing, Storage actions and search_media's visual half over MCP.
 */
import '../mcp/env'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addMediaEntries, updateMediaEntry } from '../../src/core/ops/project'
import { SearchService } from '../../src/main/ml/search/service'
import { SEARCH_MODEL_ID } from '../../src/main/ml/search/model'
import { TEST_ROOT } from '../mcp/env'
import { audioEntry, call, connect, imageEntry, startHarness, videoEntry, type Harness } from '../mcp/harness'
import { fakeEmbedder, fakeModelManager, listEmbeds, until, writePng, writeSceneVideo, type FakeEmbedder } from './helpers'

const RED = '0xdc1e1e'
const GREEN = '0x1ec81e'
const BLUE = '0x1e1edc'
const media = path.join(TEST_ROOT, 'search-media')

let h: Harness
let client: Client
let service: SearchService
let embedders: FakeEmbedder[]
let exportActive = false
let enabled = true
const transcribed: string[] = []
const cacheRoot = path.join(TEST_ROOT, 'search-cache')
const modelsRoot = path.join(TEST_ROOT, 'search-models')
const { models, fetches } = fakeModelManager(modelsRoot)

const files = {
  scenes: path.join(media, 'scenes.mp4'),
  blue: path.join(media, 'blue.mp4'),
  still: path.join(media, 'green.png'),
  voice: path.join(media, 'voice.wav'),
}
const scenes = videoEntry({ name: 'Scenes', duration: 30, hasAudio: true, source: { external: { absolutePath: files.scenes } } })
const still = imageEntry({ name: 'Green still', source: { external: { absolutePath: files.still } } })
const voice = audioEntry({ name: 'Voice', source: { external: { absolutePath: files.voice } } })

beforeAll(async () => {
  await fs.mkdir(media, { recursive: true })
  await writeSceneVideo(files.scenes, [
    { color: RED, seconds: 10 },
    { color: GREEN, seconds: 10 },
    { color: BLUE, seconds: 10 },
  ], { audio: true })
  await writeSceneVideo(files.blue, [{ color: BLUE, seconds: 4 }])
  await writePng(files.still, GREEN)
  await fs.writeFile(files.voice, 'RIFF')
  // Another installed model, to prove "Remove model" only deletes Models/search/.
  await fs.mkdir(path.join(modelsRoot, 'whisper', 'base'), { recursive: true })
  await fs.writeFile(path.join(modelsRoot, 'whisper', 'base', 'ggml-base.bin'), 'x')
  embedders = []
  service = new SearchService({
    models,
    embeddingsDir: path.join(cacheRoot, 'Embeddings'),
    cacheRoot,
    clearableCacheDirs: [path.join(cacheRoot, 'thumbnails')],
    enabled: () => enabled,
    persistEnabled: (v) => void (enabled = v),
    loadEmbedder: async () => {
      const e = fakeEmbedder()
      embedders.push(e)
      return e
    },
    isExportActive: () => exportActive,
    exportPollMs: 20,
    transcriber: {
      needs: async (file) => !transcribed.includes(file),
      run: async (file) => void transcribed.push(file),
    },
  })
  h = await startHarness([scenes, still, voice])
  h.ctx.search = service
  client = await connect(h.url)
}, 60_000)

afterAll(async () => {
  await client?.close()
  await service?.shutdown()
  await h?.close()
})

/** MCP output compacts ids to their first 8 characters. */
const ref = (id: string) => id.slice(0, 8)
const coordinator = () => service.coordinator(h.session)
const idle = () => until(() => !coordinator().indexingActive, 30_000, 'indexing to finish')

describe('smart search service', () => {
  it('project open prepares without downloading: notInstalled', async () => {
    coordinator()
    await until(() => service.model.state.kind !== 'unknown', 5000, 'prepare')
    expect(service.model.state).toEqual({ kind: 'notInstalled' })
    expect(service.statusName(h.session)).toBe('modelNotInstalled')
    expect(fetches).toEqual([])
    const st = service.status(h.session)
    expect(st.enabled).toBe(true)
    expect(st.modelDownloadBytes).toBe(94_737_653 + 283_438_275)
    expect(st.indexing).toEqual({ active: false, completed: 0, total: 0, progress: 0 })
  })

  it('search_media reports the index state and auto-downloads the missing model', async () => {
    const states: string[] = []
    service.model.on('state', (s: { kind: string }) => states.push(s.kind))
    const r = await call(client, 'search_media', { query: 'red', scope: 'visual' })
    expect(r.isError).toBe(false)
    expect(r.json).toMatchObject({ timelineFps: 30, moments: [], index: { status: 'downloadingModel', indexableAssets: 2 } })
    expect(r.json.index).not.toHaveProperty('indexedAssets')
    await until(() => service.model.isReady, 10_000, 'model ready')
    expect(fetches).toEqual(['https://example.invalid/model.onnx'])
    expect(states.slice(0, 1)).toEqual(['downloading'])
    expect(states).toContain('preparing')
    expect(states[states.length - 1]).toBe('ready')
    expect(models.isInstalled(SEARCH_MODEL_ID)).toBe(true)
  })

  it('model ready sweeps: video frames + still indexed, transcripts made for video-with-audio and audio', async () => {
    await idle()
    const c = coordinator()
    expect(c.batchTotal).toBe(0)
    expect(await c.indexedCount([scenes.id, still.id])).toBe(2)
    expect((await listEmbeds(path.join(cacheRoot, 'Embeddings'))).length).toBe(2)
    expect(transcribed.sort()).toEqual([files.scenes, files.voice].sort())
  })

  it('queries rank best-per-shot hits and restrict to ids', async () => {
    const red = await service.search(h.session, 'red')
    expect(red.length).toBe(1)
    expect(red[0]).toMatchObject({ assetId: scenes.id, shotStart: 0 })
    expect(red[0].time).toBeLessThan(10)
    const green = await service.search(h.session, '  green ')
    expect(new Set(green.map((x) => x.assetId))).toEqual(new Set([scenes.id, still.id]))
    expect(await service.search(h.session, 'green', 20, new Set([still.id]))).toMatchObject([{ assetId: still.id, time: 0, shotStart: 0, shotEnd: 0 }])
    expect(await service.search(h.session, '   ')).toEqual([])
    expect(embedders[0].texts).not.toContain('   ')
  })

  it('search_media: moments with source ranges, image hits typed, no index key when complete', async () => {
    const r = await call(client, 'search_media', { query: 'a green thing', scope: 'visual' })
    expect(r.json).not.toHaveProperty('index')
    const moments = r.json.moments as Record<string, unknown>[]
    const video = moments.find((m) => m.mediaRef === ref(scenes.id))!
    expect(video).toMatchObject({ name: 'Scenes' })
    expect(video.startSeconds).toBeGreaterThanOrEqual(7.5)
    expect(video.endSeconds).toBeLessThanOrEqual(22.5)
    const img = moments.find((m) => m.mediaRef === ref(still.id))!
    expect(img).toMatchObject({ name: 'Green still', type: 'image' })
    expect(img).not.toHaveProperty('startSeconds')
    const one = await call(client, 'search_media', { query: 'green', scope: 'visual', mediaRef: still.id })
    expect((one.json.moments as unknown[]).length).toBe(1)
    const both = await call(client, 'search_media', { query: 'blue' })
    expect(both.json).toHaveProperty('spoken')
    expect((both.json.moments as { mediaRef: string }[])[0].mediaRef).toBe(ref(scenes.id))
  })

  it('new assets are indexed on import (document change), and exports pause the queue', async () => {
    exportActive = true
    const blue = videoEntry({ name: 'Blue', duration: 4, hasAudio: false, source: { external: { absolutePath: files.blue } } })
    const before = embedders[0].images
    h.session.transact('Import', (d) => addMediaEntries(d, [blue]))
    await until(() => coordinator().indexingActive, 2000, 'scheduled')
    expect(service.status(h.session).indexing).toMatchObject({ active: true, completed: 0, total: 1 })
    expect(service.statusName(h.session)).toBe('indexing')
    const r = await call(client, 'search_media', { query: 'blue', scope: 'visual' })
    expect(r.json.index).toMatchObject({ status: 'indexing', indexableAssets: 3, indexedAssets: 2 })
    await new Promise((res) => setTimeout(res, 120))
    expect(embedders[0].images).toBe(before)
    exportActive = false
    await idle()
    expect(embedders[0].images).toBeGreaterThan(before)
    expect((await service.search(h.session, 'blue')).map((x) => x.assetId)).toContain(blue.id)
  })

  it('generating assets are skipped until generation finishes', async () => {
    const png = await writePng(path.join(media, 'gen.png'), RED)
    const gen = imageEntry({ name: 'Gen', source: { external: { absolutePath: png } }, generationStatus: 'generating' })
    h.session.transact('Generate', (d) => addMediaEntries(d, [gen]))
    await new Promise((res) => setTimeout(res, 50))
    expect(coordinator().batchTotal).toBe(0)
    h.session.transact('Generated', (d) => updateMediaEntry(d, gen.id, { generationStatus: undefined }))
    await until(async () => (await coordinator().indexedCount([gen.id])) === 1, 10_000, 'generated asset indexed')
  })

  it('disable cancels and reports disabled; enable sweeps again', async () => {
    await service.setEnabled(false)
    expect(enabled).toBe(false)
    expect(service.statusName(h.session)).toBe('disabled')
    expect(embedders[0].disposed).toBe(true)
    const r = await call(client, 'search_media', { query: 'red', scope: 'visual' })
    expect(r.json.index).toMatchObject({ status: 'disabled' })
    expect(r.json.moments).toEqual([])
    await service.setEnabled(true)
    await until(() => service.model.isReady, 5000, 'ready again')
    expect(embedders.length).toBe(2)
    await idle()
    expect((await service.search(h.session, 'red')).length).toBeGreaterThan(0)
  })

  it('Clear index deletes Embeddings/ and re-indexes; storage reports sizes and rows', async () => {
    const st = await service.storage()
    expect(st.cachePath).toBe(cacheRoot)
    expect(st.indexBytes).toBeGreaterThan(0)
    expect(st.searchModelBytes).toBeGreaterThan(64 * 1024)
    expect(st.searchModelLabel).toBe('siglip2-base-patch16-256')
    const images = embedders[1].images
    await service.clearIndex()
    await until(() => coordinator().indexingActive || embedders[1].images > images, 2000, 'reindex start')
    await idle()
    expect(embedders[1].images).toBeGreaterThan(images)
    expect((await listEmbeds(path.join(cacheRoot, 'Embeddings'))).length).toBe(4)
    await fs.mkdir(path.join(cacheRoot, 'thumbnails'), { recursive: true })
    await fs.writeFile(path.join(cacheRoot, 'thumbnails', 't.jpg'), 'xx')
    expect((await service.storage()).cacheBytes).toBe(2)
    await service.clearCache()
    expect((await service.storage()).cacheBytes).toBe(0)
  })

  it('Remove model deletes only Models/search/ and returns to notInstalled', async () => {
    await service.removeSearchModel()
    expect(service.model.state).toEqual({ kind: 'notInstalled' })
    expect(await fs.stat(path.join(modelsRoot, 'search')).catch(() => null)).toBeNull()
    expect(await fs.readFile(path.join(modelsRoot, 'whisper', 'base', 'ggml-base.bin'), 'utf8')).toBe('x')
    expect(await service.search(h.session, 'red')).toEqual([])
    expect((await service.storage()).searchModelBytes).toBe(0)
    await expect(service.removeModel('nope')).rejects.toThrow('Unknown model nope')
  })

  it('a failed download reports failed with the error; Retry recovers', async () => {
    const bad = fakeModelManager(path.join(TEST_ROOT, 'bad-models'), { fail: true })
    const s2 = new SearchService({
      models: bad.models,
      embeddingsDir: path.join(TEST_ROOT, 'bad-emb'),
      cacheRoot,
      clearableCacheDirs: [],
      enabled: () => true,
      persistEnabled: () => undefined,
      loadEmbedder: async () => fakeEmbedder(),
      isExportActive: () => false,
    })
    s2.coordinator(h.session)
    await until(() => s2.model.state.kind === 'notInstalled', 5000, 'notInstalled')
    await s2.download()
    expect(s2.model.state).toMatchObject({ kind: 'failed', message: expect.stringContaining('HTTP 404') })
    expect(s2.statusName(h.session)).toBe('failed')
    await s2.shutdown()
  })
})
