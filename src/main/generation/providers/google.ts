/**
 * Google Gemini API adapter (spec 06 §B12.1, protocol `gemini-interactions`): Nano Banana images, Gemini TTS and
 * Lyria music through `POST /v1beta/interactions` (the shape ai.google.dev documents first as of 2026-10-14).
 *
 * Requests are synchronous; a response that is still `queued`/`in_progress` becomes a resumable handle polled with
 * `GET /interactions/{id}` and cancelled with `POST /interactions/{id}/cancel`. Inputs travel inline as base64.
 * Veo is not routed here: the Gemini API Veo 3.1 preview ids shut down on 2026-10-22 (it stays on fal).
 */
import fs from 'node:fs/promises'
import type { ByokRoute, CatalogEntry } from '../../../core/generation/catalog'
import { imageMode, type AudioGenerationParams, type ByokJobHandle, type GenerationParams, type ImageGenerationParams } from '../../../core/generation/params'
import { convertImageToJpeg } from '../preprocess'
import { inlineBytes, stashFile } from './inline'
import { ProviderError, type LocalInput, type Output, type PollResult, type ProviderAdapter } from './types'

export const GOOGLE_BASE = 'https://generativelanguage.googleapis.com/v1beta'
/** Images above this are re-encoded as JPEG before inlining (§B12.2: Gemini inline images ≤ 7 MB). */
export const GOOGLE_INLINE_IMAGE_MAX = 7 * 1024 * 1024
const INLINE_MAX = 20 * 1024 * 1024

export interface GoogleOptions {
  key: string
  base?: string
  fetch?: typeof fetch
}

/** `PALMIER_GOOGLE_BASE_URL=http://127.0.0.1:<port>` points the adapter at a fake server. Tests only. */
export function googleBaseFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.PALMIER_GOOGLE_BASE_URL?.replace(/\/+$/, '') || null
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Google's `{"error":{"code","message","status"}}` → its message. */
export function googleErrorMessage(status: number, text: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = undefined
  }
  const root = Array.isArray(parsed) ? parsed[0] : parsed
  const err = isObj(root) ? root.error : undefined
  if (isObj(err) && typeof err.message === 'string' && err.message) return err.message
  if (isObj(root) && typeof root.message === 'string' && root.message) return root.message
  if (status === 401 || status === 403) return `Google rejected the API key (HTTP ${status}).`
  if (status === 429) return 'Google rate limit or quota reached (HTTP 429). Try again later.'
  const trimmed = text.trim().slice(0, 300)
  return trimmed ? `Google returned HTTP ${status}: ${trimmed}` : `Google returned HTTP ${status}.`
}

/** RIFF/WAVE header around raw 16-bit little-endian PCM. */
export function wavFromPcm(pcm: Buffer, sampleRate = 24000, channels = 1): Buffer {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0)
  h.writeUInt32LE(36 + pcm.length, 4)
  h.write('WAVE', 8)
  h.write('fmt ', 12)
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(channels, 22)
  h.writeUInt32LE(sampleRate, 24)
  h.writeUInt32LE(sampleRate * channels * 2, 28)
  h.writeUInt16LE(channels * 2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36)
  h.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([h, pcm])
}

type MediaKind = 'image' | 'audio' | 'video'

interface Interaction {
  id?: string
  status?: string
  steps?: unknown[]
  outputs?: unknown[]
  error?: unknown
}

/** Media and text items of the model's output steps (also tolerates a flat `outputs` list). */
function contentItems(it: Interaction): Record<string, unknown>[] {
  const items: Record<string, unknown>[] = []
  for (const s of it.steps ?? []) {
    if (!isObj(s) || (s.type !== undefined && s.type !== 'model_output')) continue
    if (Array.isArray(s.content)) for (const c of s.content) if (isObj(c)) items.push(c)
  }
  for (const o of it.outputs ?? []) if (isObj(o)) items.push(o)
  return items
}

function interactionError(it: Interaction): string {
  const e = it.error
  if (isObj(e) && typeof e.message === 'string' && e.message) return e.message
  if (typeof e === 'string' && e) return e
  if (it.status === 'cancelled') return 'Generation cancelled'
  if (it.status === 'incomplete') return 'Google stopped before finishing the result.'
  return 'Google could not generate this.'
}

export class GoogleAdapter implements ProviderAdapter {
  private readonly base: string
  private readonly fetch: typeof fetch

  constructor(private readonly o: GoogleOptions) {
    this.base = (o.base ?? GOOGLE_BASE).replace(/\/+$/, '')
    this.fetch = o.fetch ?? fetch
  }

  private headers(): Record<string, string> {
    return { 'x-goog-api-key': this.o.key, 'Content-Type': 'application/json' }
  }

  private async request(method: string, path: string, body: unknown, signal?: AbortSignal): Promise<Interaction> {
    const res = await this.fetch(`${this.base}${path}`, { method, headers: this.headers(), body: body === undefined ? undefined : JSON.stringify(body), signal })
    const text = await res.text()
    if (!res.ok) throw new ProviderError(googleErrorMessage(res.status, text), res.status)
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new ProviderError('Google returned an unreadable response.')
    }
    if (!isObj(parsed)) throw new ProviderError('Google returned an unexpected response.')
    return parsed as Interaction
  }

  async prepareInput(file: LocalInput, signal?: AbortSignal): Promise<string> {
    if (file.mime.startsWith('image/') && file.size > GOOGLE_INLINE_IMAGE_MAX) {
      const jpg = await convertImageToJpeg(file.path, signal)
      try {
        const st = await fs.stat(jpg)
        return await stashFile({ path: jpg, mime: 'image/jpeg', size: st.size }, INLINE_MAX)
      } finally {
        await fs.rm(jpg, { force: true })
      }
    }
    return stashFile(file, INLINE_MAX)
  }

  async submit(entry: CatalogEntry, route: ByokRoute, params: GenerationParams, signal?: AbortSignal): Promise<{ handle: ByokJobHandle } | { outputs: Output[] }> {
    if (params.kind === 'image') return this.submitImages(entry, route, params, signal)
    if (params.kind === 'audio') return this.submitAudio(entry, route, params, signal)
    throw new ProviderError(`${entry.displayName} can't run this request on Google.`)
  }

  private endpoint(entry: CatalogEntry, route: ByokRoute, mode: string): string {
    const e = route.endpoints[mode]
    if (!e) throw new ProviderError(`${entry.displayName} can't run this request on Google.`)
    return e
  }

  private async submitImages(entry: CatalogEntry, route: ByokRoute, p: ImageGenerationParams, signal?: AbortSignal): Promise<{ handle: ByokJobHandle } | { outputs: Output[] }> {
    const model = this.endpoint(entry, route, imageMode(p))
    const input: Record<string, unknown>[] = [{ type: 'text', text: p.prompt }]
    for (const ref of p.imageURLs ?? []) {
      const f = inlineBytes(ref)
      input.push({ type: 'image', mime_type: f.mime, data: f.bytes.toString('base64') })
    }
    const responseFormat: Record<string, unknown> = { type: 'image', mime_type: 'image/png', aspect_ratio: p.aspectRatio }
    if (p.resolution) responseFormat.image_size = p.resolution
    const body = { model, input, response_format: responseFormat }
    const n = Math.max(1, Math.min(4, Math.trunc(p.numImages || 1)))
    // One image per call (§B12.0): N parallel calls, output k → outputIndex k.
    const results = await Promise.all(Array.from({ length: n }, () => this.request('POST', '/interactions', body, signal)))
    if (n === 1 && this.pending(results[0])) return { handle: this.handle(model, results[0]) }
    const outputs: Output[] = []
    for (const r of results) {
      const done = this.pending(r) ? await this.wait(r, signal) : r
      outputs.push(this.firstMedia(done, 'image'))
    }
    return { outputs }
  }

  private async submitAudio(entry: CatalogEntry, route: ByokRoute, p: AudioGenerationParams, signal?: AbortSignal): Promise<{ handle: ByokJobHandle } | { outputs: Output[] }> {
    let model: string
    let body: Record<string, unknown>
    if (route.endpoints.tts) {
      model = route.endpoints.tts
      const text: Record<string, unknown> = { type: 'text', text: p.prompt }
      if (p.styleInstructions?.trim()) text.annotations = [{ type: 'speech_metadata', style: p.styleInstructions.trim() }]
      body = { model, input: [{ type: 'user_input', content: [text] }], response_format: { type: 'audio' } }
      if (p.voice) body.generation_config = { speech_config: [{ voice: p.voice }] }
    } else {
      model = this.endpoint(entry, route, 'music')
      if (p.referenceImageURL) {
        const f = inlineBytes(p.referenceImageURL)
        body = { model, input: [{ type: 'text', text: p.prompt }, { type: 'image', mime_type: f.mime, data: f.bytes.toString('base64') }] }
      } else {
        body = { model, input: p.prompt }
      }
    }
    const r = await this.request('POST', '/interactions', body, signal)
    if (this.pending(r)) return { handle: this.handle(model, r) }
    return { outputs: [this.firstMedia(r, 'audio')] }
  }

  private pending(it: Interaction): boolean {
    return (it.status === 'queued' || it.status === 'in_progress') && typeof it.id === 'string' && !!it.id
  }

  private handle(model: string, it: Interaction): ByokJobHandle {
    return { provider: 'google', endpoint: model, requestId: it.id!, submittedAt: new Date().toISOString() }
  }

  private async wait(it: Interaction, signal?: AbortSignal): Promise<Interaction> {
    for (let i = 0; ; i++) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, i < 30 ? 2000 : 5000)
        signal?.addEventListener('abort', () => (clearTimeout(t), reject(new DOMException('Aborted', 'AbortError'))), { once: true })
      })
      const next = await this.request('GET', `/interactions/${encodeURIComponent(it.id!)}`, undefined, signal)
      if (!this.pending(next)) return next
    }
  }

  /** The first output of `kind`; throws the interaction's error (or its text, e.g. a safety refusal) otherwise. */
  private firstMedia(it: Interaction, kind: MediaKind): Output {
    if (it.status && it.status !== 'completed') throw new ProviderError(interactionError(it))
    const items = contentItems(it)
    const media = items.find((c) => c.type === kind && (typeof c.data === 'string' || typeof c.uri === 'string'))
    if (!media) {
      const text = items
        .filter((c) => c.type === 'text' && typeof c.text === 'string')
        .map((c) => (c.text as string).trim())
        .join(' ')
        .trim()
      throw new ProviderError(text ? `Google returned no ${kind}: ${text.slice(0, 300)}` : 'No URL in response')
    }
    const mime = typeof media.mime_type === 'string' ? media.mime_type.toLowerCase() : kind === 'image' ? 'image/png' : kind === 'audio' ? 'audio/wav' : 'video/mp4'
    if (typeof media.data !== 'string') return { url: media.uri as string, headers: { 'x-goog-api-key': this.o.key } }
    let bytes: Buffer = Buffer.from(media.data, 'base64')
    if (kind === 'audio' && (/l16|pcm/.test(mime) || (mime.includes('wav') && bytes.subarray(0, 4).toString('latin1') !== 'RIFF'))) {
      // Raw PCM (24 kHz, 16-bit, mono unless stated) → WAV (§B4.5 Linux addition).
      const rate = typeof media.sample_rate === 'number' ? media.sample_rate : Number(/rate=(\d+)/.exec(mime)?.[1] ?? 24000)
      const channels = typeof media.channels === 'number' ? media.channels : 1
      bytes = wavFromPcm(bytes, rate, channels)
      return { bytes, mime: 'audio/wav' }
    }
    return { bytes, mime: mime.split(';')[0] }
  }

  async poll(handle: ByokJobHandle, signal?: AbortSignal): Promise<PollResult> {
    let it: Interaction
    try {
      it = await this.request('GET', `/interactions/${encodeURIComponent(handle.requestId)}`, undefined, signal)
    } catch (e) {
      // Unknown ids and auth errors are terminal; other failures (network, 5xx, 429) keep polling.
      if (e instanceof ProviderError && e.status !== undefined && [400, 401, 403, 404].includes(e.status)) return { state: 'failed', message: e.message }
      throw e
    }
    if (it.status === 'queued') return { state: 'queued' }
    if (it.status === 'in_progress') return { state: 'running' }
    if (it.status !== 'completed') return { state: 'failed', message: interactionError(it) }
    const kind: MediaKind = /tts|lyria|music/.test(handle.endpoint) ? 'audio' : /omni|veo/.test(handle.endpoint) ? 'video' : 'image'
    try {
      return { state: 'succeeded', outputs: [this.firstMedia(it, kind)] }
    } catch (e) {
      return { state: 'failed', message: e instanceof Error ? e.message : String(e) }
    }
  }

  async cancel(handle: ByokJobHandle): Promise<void> {
    await this.fetch(`${this.base}/interactions/${encodeURIComponent(handle.requestId)}/cancel`, { method: 'POST', headers: this.headers(), body: '{}' })
      .then((r) => r.body?.cancel())
      .catch(() => undefined)
  }
}
