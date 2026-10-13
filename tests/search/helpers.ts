/** Shared fixtures for the smart-search tests: synthetic media, a deterministic fake embedder, a model manager seam. */
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { ffmpeg } from '../../src/main/media/ffmpeg'
import type { FetchLike } from '../../src/main/ml/download'
import { MANIFESTS, type ModelManifest } from '../../src/main/ml/manifests'
import { ModelManager } from '../../src/main/ml/models'
import { SEARCH_MODEL_ID } from '../../src/main/ml/search/model'
import type { Embedder, EmbedderSpec } from '../../src/main/ml/search/siglip'

export interface Scene {
  color: string
  seconds: number
}

/** H.264 video of solid-color scenes (Mac `FixtureVideo.write`), 320×180 @ 30 fps, keyframe every second. */
export async function writeSceneVideo(file: string, scenes: Scene[], opts: { audio?: boolean } = {}): Promise<string> {
  const inputs = scenes.flatMap((s) => ['-f', 'lavfi', '-i', `color=c=${s.color}:s=320x180:r=30:d=${s.seconds}`])
  const total = scenes.reduce((n, s) => n + s.seconds, 0)
  const audio = opts.audio ? ['-f', 'lavfi', '-i', `anullsrc=r=48000:cl=mono:d=${total}`] : []
  const concat = `${scenes.map((_, i) => `[${i}:v]`).join('')}concat=n=${scenes.length}:v=1:a=0[v]`
  await ffmpeg([
    '-y',
    ...inputs,
    ...audio,
    '-filter_complex',
    concat,
    '-map',
    '[v]',
    ...(opts.audio ? ['-map', `${scenes.length}:a`, '-c:a', 'aac', '-shortest'] : []),
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-g',
    '30',
    '-pix_fmt',
    'yuv420p',
    file,
  ])
  return file
}

export async function writePng(file: string, color: string, size = '64x64'): Promise<string> {
  await ffmpeg(['-y', '-f', 'lavfi', '-i', `color=c=${color}:s=${size}`, '-frames:v', '1', file])
  return file
}

export const FAKE_SPEC: EmbedderSpec = { model: 'fake-siglip', version: 7, embeddingDim: 8, imageSize: 256, contextLength: 64 }

const WORDS: Record<string, number> = { red: 0, green: 1, blue: 2 }

function normalize(v: Float32Array): Float32Array {
  const n = Math.hypot(...v)
  if (n > 0) for (let i = 0; i < v.length; i++) v[i] /= n
  return v
}

export interface FakeEmbedder extends Embedder {
  images: number
  texts: string[]
  disposed: boolean
  /** Optional hook run before every image encode (pause/fail injection). */
  beforeImage?: () => Promise<void> | void
}

/** Image → its mean RGB (normalized); text → one-hot over the color words it mentions. */
export function fakeEmbedder(spec: EmbedderSpec = FAKE_SPEC): FakeEmbedder {
  const e: FakeEmbedder = {
    spec,
    images: 0,
    texts: [],
    disposed: false,
    async encodeImage(rgba, width, height) {
      await e.beforeImage?.()
      e.images++
      const v = new Float32Array(spec.embeddingDim)
      const n = width * height
      for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) v[c] += rgba[i * 4 + c] / n
      return normalize(v)
    },
    async encodeText(text) {
      e.texts.push(text)
      const v = new Float32Array(spec.embeddingDim)
      for (const w of text.toLowerCase().split(/\W+/)) if (w in WORDS) v[WORDS[w]] = 1
      if (!v.some(Boolean)) v[7] = 1
      return normalize(v)
    },
    async dispose() {
      e.disposed = true
    },
  }
  return e
}

/** Model manager whose search manifest is one tiny file served by a fake fetch (progress events included). */
export function fakeModelManager(root: string, opts: { fail?: boolean } = {}): { models: ModelManager; fetches: string[] } {
  const body = Buffer.alloc(64 * 1024, 7)
  const sha256 = createHash('sha256').update(body).digest('hex')
  const real = MANIFESTS[SEARCH_MODEL_ID]
  const manifest: ModelManifest = { ...real, dir: 'search/fake-siglip-v7', files: [{ url: 'https://example.invalid/model.onnx', path: 'model.onnx', bytes: body.length, sha256 }] }
  const fetches: string[] = []
  const fetchLike: FetchLike = async (url) => {
    fetches.push(url)
    if (opts.fail) return new Response('nope', { status: 404 })
    const chunks = [body.subarray(0, body.length / 2), body.subarray(body.length / 2)]
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        const next = chunks.shift()
        if (next) c.enqueue(new Uint8Array(next))
        else c.close()
      },
    })
    return new Response(stream, { status: 200, headers: { 'content-length': String(body.length) } })
  }
  const models = new ModelManager({ root, manifests: { [SEARCH_MODEL_ID]: manifest }, fetch: fetchLike, retries: 0, retryDelayMs: 1 })
  return { models, fetches }
}

/** Polls `cond` (no fixed sleeps in assertions; bounded). */
export async function until(cond: () => boolean | Promise<boolean>, ms = 20_000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + ms
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

export async function listEmbeds(dir: string): Promise<string[]> {
  return (await fs.readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith('.embed')).map((n) => path.join(dir, n))
}
