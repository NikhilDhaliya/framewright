/**
 * ElevenLabs adapter (spec 06 §B12.4.3, protocol `elevenlabs`), endpoints checked against elevenlabs.io/docs on
 * 2026-10-14: v4 TTS (`POST /v1/text-to-speech/{voice_id}`), music (`POST /v1/music/stream`), sound effects
 * (`POST /v1/sound-generation`), voice isolator (`POST /v1/audio-isolation`, multipart `audio`) — all synchronous,
 * binary MP3 — and dubbing (`POST /v1/dubbing` → `dubbing_id`, poll `GET /v1/dubbing/{id}`, download
 * `GET /v1/dubbing/{id}/audio/{lang}`, cancel = `DELETE /v1/dubbing/{id}`), which resumes after a restart.
 * Voices come from `GET /v2/voices` at runtime (default voice ids change; never hard-coded).
 */
import type { ByokRoute, CatalogEntry } from '../../../core/generation/catalog'
import type { AudioGenerationParams, ByokJobHandle, GenerationParams } from '../../../core/generation/params'
import { audioModeKey } from './falModels'
import { inlineBytes, stashFile } from './inline'
import { ProviderError, type LocalInput, type Output, type PollResult, type ProviderAdapter } from './types'

export const ELEVENLABS_BASE = 'https://api.elevenlabs.io'
const OUTPUT_FORMAT = 'mp3_44100_128'
/** Upload cap for isolator/dubbing sources (the extracted audio of a ≤ 1 h clip is far below this). */
const UPLOAD_MAX = 1024 * 1024 * 1024
const VOICE_CACHE_MS = 10 * 60 * 1000

export interface ElevenLabsOptions {
  key: string
  base?: string
  fetch?: typeof fetch
}

/** `PALMIER_ELEVENLABS_BASE_URL=http://127.0.0.1:<port>` points the adapter at a fake server. Tests only. */
export function elevenLabsBaseFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.PALMIER_ELEVENLABS_BASE_URL?.replace(/\/+$/, '') || null
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** ElevenLabs errors: `{detail:{status,message}}`, `{detail:[{msg}]}` (422) or `{detail:"…"}`. */
export function elevenLabsErrorMessage(status: number, text: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = undefined
  }
  if (isObj(parsed)) {
    const d = parsed.detail
    if (isObj(d) && typeof d.message === 'string' && d.message) return d.message
    if (Array.isArray(d) && isObj(d[0]) && typeof d[0].msg === 'string') return d[0].msg
    if (typeof d === 'string' && d) return d
    if (typeof parsed.message === 'string' && parsed.message) return parsed.message
  }
  if (status === 401 || status === 403) return `ElevenLabs rejected the API key (HTTP ${status}).`
  if (status === 429) return 'ElevenLabs rate limit or concurrency limit reached (HTTP 429). Try again later.'
  const trimmed = text.trim().slice(0, 300)
  return trimmed ? `ElevenLabs returned HTTP ${status}: ${trimmed}` : `ElevenLabs returned HTTP ${status}.`
}

export interface Voice {
  voice_id: string
  name: string
  category?: string
}

/** Per-key voice list cache (one fetch per 10 min). */
const voiceCache = new Map<string, { at: number; voices: Voice[] }>()

/** Resolves a voice by id, exact name, or the name before " - " (ElevenLabs names like "Rachel - calm"). */
export function findVoice(voices: Voice[], wanted: string | undefined): Voice | null {
  if (!wanted) return voices.find((v) => v.category === 'premade') ?? voices[0] ?? null
  const w = wanted.trim().toLowerCase()
  return (
    voices.find((v) => v.voice_id === wanted) ??
    voices.find((v) => v.name.toLowerCase() === w) ??
    voices.find((v) => v.name.split(' - ')[0].trim().toLowerCase() === w) ??
    null
  )
}

export class ElevenLabsAdapter implements ProviderAdapter {
  private readonly base: string
  private readonly fetch: typeof fetch

  constructor(private readonly o: ElevenLabsOptions) {
    this.base = (o.base ?? ELEVENLABS_BASE).replace(/\/+$/, '')
    this.fetch = o.fetch ?? fetch
  }

  private headers(json = true): Record<string, string> {
    return { 'xi-api-key': this.o.key, ...(json ? { 'Content-Type': 'application/json' } : null) }
  }

  private async fail(res: Response): Promise<never> {
    throw new ProviderError(elevenLabsErrorMessage(res.status, await res.text()), res.status)
  }

  private async json(res: Response): Promise<Record<string, unknown>> {
    if (!res.ok) await this.fail(res)
    const text = await res.text()
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new ProviderError('ElevenLabs returned an unreadable response.')
    }
    if (!isObj(parsed)) throw new ProviderError('ElevenLabs returned an unexpected response.')
    return parsed
  }

  /** A binary audio (or video) response as an output. */
  private async audio(res: Response): Promise<Output> {
    if (!res.ok) await this.fail(res)
    const type = (res.headers.get('content-type') ?? 'audio/mpeg').split(';')[0].trim().toLowerCase()
    if (type.includes('json')) throw new ProviderError(elevenLabsErrorMessage(res.status, await res.text()))
    const bytes = Buffer.from(await res.arrayBuffer())
    if (!bytes.length) throw new ProviderError('No URL in response')
    return { bytes, mime: type.startsWith('audio/') || type.startsWith('video/') ? type : 'audio/mpeg' }
  }

  async prepareInput(file: LocalInput): Promise<string> {
    return stashFile(file, UPLOAD_MAX)
  }

  /** Every voice the key can use (`GET /v2/voices`, paginated, cached). */
  async listVoices(signal?: AbortSignal): Promise<Voice[]> {
    const hit = voiceCache.get(this.o.key)
    if (hit && Date.now() - hit.at < VOICE_CACHE_MS) return hit.voices
    const voices: Voice[] = []
    let token: string | undefined
    for (let page = 0; page < 10; page++) {
      const q = new URLSearchParams({ page_size: '100' })
      if (token) q.set('next_page_token', token)
      const json = await this.json(await this.fetch(`${this.base}/v2/voices?${q}`, { headers: this.headers(false), signal }))
      for (const v of Array.isArray(json.voices) ? json.voices : []) {
        if (isObj(v) && typeof v.voice_id === 'string' && typeof v.name === 'string') voices.push({ voice_id: v.voice_id, name: v.name, category: typeof v.category === 'string' ? v.category : undefined })
      }
      token = typeof json.next_page_token === 'string' && json.next_page_token ? json.next_page_token : undefined
      if (json.has_more !== true || !token) break
    }
    voiceCache.set(this.o.key, { at: Date.now(), voices })
    return voices
  }

  async submit(entry: CatalogEntry, route: ByokRoute, params: GenerationParams, signal?: AbortSignal): Promise<{ handle: ByokJobHandle } | { outputs: Output[] }> {
    if (params.kind !== 'audio') throw new ProviderError(`${entry.displayName} can't run this request on ElevenLabs.`)
    const p: AudioGenerationParams = params
    const mode = audioModeKey(route, p)
    const model = route.endpoints[mode]
    if (!model) throw new ProviderError(`${entry.displayName} can't run this request on ElevenLabs.`)
    const post = (path: string, body: unknown) => this.fetch(`${this.base}${path}`, { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal })
    switch (mode) {
      case 'tts': {
        const voices = await this.listVoices(signal)
        const voice = findVoice(voices, p.voice)
        if (!voice) throw new ProviderError(p.voice ? `Voice '${p.voice}' isn't in your ElevenLabs voice library.` : 'Your ElevenLabs account has no voices.')
        return { outputs: [await this.audio(await post(`/v1/text-to-speech/${encodeURIComponent(voice.voice_id)}?output_format=${OUTPUT_FORMAT}`, { text: p.prompt, model_id: model }))] }
      }
      case 'music': {
        const body: Record<string, unknown> = { prompt: p.prompt, model_id: model }
        if (p.durationSeconds != null) body.music_length_ms = Math.round(Math.min(600, Math.max(3, p.durationSeconds)) * 1000)
        if (p.instrumental) body.force_instrumental = true
        // The streaming variant sends headers at once, so long songs don't hit the client's header timeout.
        return { outputs: [await this.audio(await post(`/v1/music/stream?output_format=${OUTPUT_FORMAT}`, body))] }
      }
      case 'sfx': {
        const body: Record<string, unknown> = { text: p.prompt, prompt_influence: 0.3, model_id: model }
        if (p.durationSeconds != null) body.duration_seconds = Math.min(30, Math.max(0.5, p.durationSeconds))
        return { outputs: [await this.audio(await post(`/v1/sound-generation?output_format=${OUTPUT_FORMAT}`, body))] }
      }
      case 'cleanup': {
        if (!p.sourceURL) throw new ProviderError('Choose an audio or video source.')
        const f = inlineBytes(p.sourceURL)
        const form = new FormData()
        form.append('audio', new Blob([new Uint8Array(f.bytes)], { type: f.mime }), f.name)
        const res = await this.fetch(`${this.base}/v1/audio-isolation`, { method: 'POST', headers: this.headers(false), body: form, signal })
        return { outputs: [await this.audio(res)] }
      }
      case 'dub': {
        if (!p.sourceURL) throw new ProviderError('Choose an audio or video source.')
        const lang = p.targetLanguage
        if (!lang) throw new ProviderError('Choose a target language.')
        const f = inlineBytes(p.sourceURL)
        const form = new FormData()
        form.append('file', new Blob([new Uint8Array(f.bytes)], { type: f.mime }), f.name)
        form.append('source_lang', 'auto')
        form.append('target_lang', lang)
        const json = await this.json(await this.fetch(`${this.base}/v1/dubbing`, { method: 'POST', headers: this.headers(false), body: form, signal }))
        const id = json.dubbing_id
        if (typeof id !== 'string' || !id) throw new ProviderError('ElevenLabs did not accept the dubbing job.')
        return { handle: { provider: 'elevenlabs', endpoint: `dubbing/${lang}`, requestId: id, submittedAt: new Date().toISOString() } }
      }
      default:
        throw new ProviderError(`${entry.displayName} can't run this request on ElevenLabs.`)
    }
  }

  async poll(handle: ByokJobHandle, signal?: AbortSignal): Promise<PollResult> {
    const id = encodeURIComponent(handle.requestId)
    const res = await this.fetch(`${this.base}/v1/dubbing/${id}`, { headers: this.headers(false), signal })
    if (!res.ok) {
      const message = elevenLabsErrorMessage(res.status, await res.text())
      // Unknown ids and auth errors are terminal; transient errors keep polling.
      if ([400, 401, 403, 404, 422].includes(res.status)) return { state: 'failed', message }
      throw new ProviderError(message, res.status)
    }
    const json = await this.json(res)
    const status = String(json.status ?? '')
    if (status === 'failed') return { state: 'failed', message: typeof json.error === 'string' && json.error ? json.error : 'Dubbing failed' }
    if (status !== 'dubbed') return { state: 'running' }
    const lang = handle.endpoint.split('/')[1] ?? (Array.isArray(json.target_languages) ? String(json.target_languages[0]) : '')
    const audio = await this.fetch(`${this.base}/v1/dubbing/${id}/audio/${encodeURIComponent(lang)}`, { headers: this.headers(false), signal })
    try {
      return { state: 'succeeded', outputs: [await this.audio(audio)] }
    } catch (e) {
      return { state: 'failed', message: e instanceof Error ? e.message : String(e) }
    }
  }

  async cancel(handle: ByokJobHandle): Promise<void> {
    await this.fetch(`${this.base}/v1/dubbing/${encodeURIComponent(handle.requestId)}`, { method: 'DELETE', headers: this.headers(false) })
      .then((r) => r.body?.cancel())
      .catch(() => undefined)
  }
}
