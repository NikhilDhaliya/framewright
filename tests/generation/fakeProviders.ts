/**
 * Local fakes of the Google Gemini Interactions API (under /google) and the ElevenLabs REST API (under /elevenlabs)
 * for tests and headless checks — never the real APIs. Shapes follow ai.google.dev / elevenlabs.io docs (2026-10-14).
 *
 * Prompt markers: "[fail]" → provider error, "[hold]" → the request hangs until the client aborts (cancel),
 * "[bg]" → Google answers `in_progress` and completes after polls, "[refuse]" → Google completes with text only,
 * "[pcm]" → Google TTS returns raw `audio/l16` PCM. Dubbing target language "xx" fails.
 *
 * CLI: `node tests/generation/fakeProviders.ts <port> [polls]` prints `FAKE_PROVIDERS_READY <baseUrl>`; then set
 * PALMIER_GOOGLE_BASE_URL=<base>/google and PALMIER_ELEVENLABS_BASE_URL=<base>/elevenlabs.
 */
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

export interface ProviderRequest {
  provider: 'google' | 'elevenlabs'
  method: string
  path: string
  /** Parsed JSON body, or for multipart the text fields plus `__files: {field: {name, type, bytes}}`. */
  body: Record<string, unknown>
  contentType: string
  auth: string | undefined
}

export interface FakeProviders {
  url: string
  googleBase: string
  elevenBase: string
  requests: ProviderRequest[]
  /** Requests whose client went away while held (cancels of synchronous calls). */
  aborted: string[]
  cancels: string[]
  close(): Promise<void>
}

export interface FakeProvidersOptions {
  port?: number
  googleKey?: string
  elevenKey?: string
  /** Non-terminal polls before a background interaction / dub completes. */
  polls?: number
}

// Self-contained (no import of fakeFal) so `node tests/generation/fakeProviders.ts` runs with plain type stripping.
function ffmpegBin(): string {
  try {
    const p = createRequire(import.meta.url)('ffmpeg-static') as string
    if (p && fs.existsSync(p)) return p
  } catch {
    // system ffmpeg
  }
  return 'ffmpeg'
}

let mediaDir: string | null = null
/** Real media files served as results (made once per process). */
function sampleMedia(): { image: string; audio: string; wav: string } {
  if (!mediaDir) {
    mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-providers-'))
    const q = ['-hide_banner', '-loglevel', 'error', '-y']
    execFileSync(ffmpegBin(), [...q, '-f', 'lavfi', '-i', 'testsrc2=s=320x180:d=1', '-frames:v', '1', path.join(mediaDir, 'result.png')])
    execFileSync(ffmpegBin(), [...q, '-f', 'lavfi', '-i', 'sine=f=330:d=3', '-c:a', 'libmp3lame', '-b:a', '64k', path.join(mediaDir, 'result.mp3')])
    execFileSync(ffmpegBin(), [...q, '-f', 'lavfi', '-i', 'sine=f=220:d=2', '-ar', '24000', '-ac', '1', '-c:a', 'pcm_s16le', path.join(mediaDir, 'speech.wav')])
  }
  return { image: path.join(mediaDir, 'result.png'), audio: path.join(mediaDir, 'result.mp3'), wav: path.join(mediaDir, 'speech.wav') }
}
const sampleWav = () => sampleMedia().wav

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/** Minimal multipart/form-data parser (fields + files). */
function parseMultipart(body: Buffer, contentType: string): Record<string, unknown> {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType)
  const out: Record<string, unknown> = {}
  const files: Record<string, { name: string; type: string; bytes: number }> = {}
  if (!boundary) return out
  const sep = Buffer.from(`--${boundary[1] ?? boundary[2]}`)
  let start = body.indexOf(sep)
  while (start >= 0) {
    const next = body.indexOf(sep, start + sep.length)
    if (next < 0) break
    const part = body.subarray(start + sep.length + 2, next - 2)
    const headEnd = part.indexOf('\r\n\r\n')
    if (headEnd > 0) {
      const head = part.subarray(0, headEnd).toString('utf8')
      const data = part.subarray(headEnd + 4)
      const name = /name="([^"]+)"/.exec(head)?.[1] ?? ''
      const filename = /filename="([^"]*)"/.exec(head)?.[1]
      if (filename !== undefined) files[name] = { name: filename, type: /Content-Type:\s*([^\r\n]+)/i.exec(head)?.[1] ?? '', bytes: data.length }
      else out[name] = data.toString('utf8')
    }
    start = next
  }
  out.__files = files
  return out
}

/** The prompt text of a Gemini Interactions `input` (string, content list or steps). */
export function interactionText(input: unknown): string {
  if (typeof input === 'string') return input
  const texts: string[] = []
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>
      if (o.type === 'text' && typeof o.text === 'string') texts.push(o.text)
      if (o.content) walk(o.content)
    }
  }
  walk(input)
  return texts.join(' ')
}

export async function startFakeProviders(o: FakeProvidersOptions = {}): Promise<FakeProviders> {
  const googleKey = o.googleKey ?? 'google-key'
  const elevenKey = o.elevenKey ?? 'eleven-key'
  const polls = o.polls ?? 2
  const requests: ProviderRequest[] = []
  const aborted: string[] = []
  const cancels: string[] = []
  const interactions = new Map<string, { model: string; polled: number; cancelled: boolean; content: unknown[] }>()
  const dubs = new Map<string, { lang: string; polled: number; deleted: boolean }>()
  const holds = new Set<http.ServerResponse>()

  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  const file = (res: http.ServerResponse, f: string, type: string) => {
    const data = fs.readFileSync(f)
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': String(data.length) })
    res.end(data)
  }
  const hold = (req: http.IncomingMessage, res: http.ServerResponse, label: string) => {
    holds.add(res)
    res.on('close', () => {
      holds.delete(res)
      aborted.push(label)
    })
  }

  const googleContent = (model: string, prompt: string): unknown[] => {
    const media = sampleMedia()
    if (prompt.includes('[refuse]')) return [{ type: 'text', text: 'I can’t create that image (fake refusal).' }]
    if (/tts/.test(model)) {
      const wav = fs.readFileSync(sampleWav())
      if (prompt.includes('[pcm]')) return [{ type: 'audio', mime_type: 'audio/l16;codec=pcm;rate=24000', data: wav.subarray(44).toString('base64') }]
      return [{ type: 'audio', mime_type: 'audio/wav', data: wav.toString('base64') }]
    }
    if (/lyria/.test(model)) return [{ type: 'text', text: '[Verse] la la' }, { type: 'audio', mime_type: 'audio/mpeg', data: fs.readFileSync(media.audio).toString('base64') }]
    return [{ type: 'text', text: 'Here you go.' }, { type: 'image', mime_type: 'image/png', data: fs.readFileSync(media.image).toString('base64') }]
  }

  async function google(req: http.IncomingMessage, res: http.ServerResponse, p: string, rec: ProviderRequest) {
    if (req.headers['x-goog-api-key'] !== googleKey) return json(res, 400, { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } })
    if (p === '/interactions' && req.method === 'POST') {
      const model = String(rec.body.model ?? '')
      const prompt = interactionText(rec.body.input)
      if (prompt.includes('[fail]')) return json(res, 400, { error: { code: 400, message: 'The request was blocked by safety filters (fake).', status: 'INVALID_ARGUMENT' } })
      if (prompt.includes('[hold]')) return hold(req, res, `google:${model}`)
      const id = `v1_${randomUUID().replace(/-/g, '')}`
      const content = googleContent(model, prompt)
      if (prompt.includes('[bg]')) {
        interactions.set(id, { model, polled: 0, cancelled: false, content })
        return json(res, 200, { id, object: 'interaction', model, status: 'in_progress', steps: [] })
      }
      return json(res, 200, { id, object: 'interaction', model, status: 'completed', created: new Date().toISOString(), steps: [{ type: 'model_output', content }] })
    }
    const m = /^\/interactions\/([^/]+)(\/cancel)?$/.exec(p)
    if (m) {
      const it = interactions.get(decodeURIComponent(m[1]))
      if (!it) return json(res, 404, { error: { code: 404, message: 'Interaction not found.', status: 'NOT_FOUND' } })
      if (m[2]) {
        cancels.push(m[1])
        it.cancelled = true
        return json(res, 200, { id: m[1], status: 'cancelled' })
      }
      it.polled++
      if (it.cancelled) return json(res, 200, { id: m[1], status: 'cancelled' })
      if (it.polled <= polls) return json(res, 200, { id: m[1], status: it.polled === 1 ? 'queued' : 'in_progress', steps: [] })
      return json(res, 200, { id: m[1], status: 'completed', steps: [{ type: 'model_output', content: it.content }] })
    }
    return json(res, 404, { error: { code: 404, message: 'Not found', status: 'NOT_FOUND' } })
  }

  const VOICES = [
    { voice_id: 'v-rachel', name: 'Rachel', category: 'premade' },
    { voice_id: 'v-adam', name: 'Adam - deep narrator', category: 'premade' },
    { voice_id: 'v-mine', name: 'My Clone', category: 'cloned' },
  ]

  async function eleven(req: http.IncomingMessage, res: http.ServerResponse, p: string, rec: ProviderRequest) {
    if (req.headers['xi-api-key'] !== elevenKey) return json(res, 401, { detail: { status: 'invalid_api_key', message: 'Invalid API key' } })
    const media = sampleMedia()
    const text = String(rec.body.text ?? rec.body.prompt ?? '')
    if (text.includes('[fail]')) return json(res, 400, { detail: { status: 'content_policy', message: 'This prompt was blocked (fake).' } })
    if (text.includes('[hold]')) return hold(req, res, `elevenlabs:${p}`)
    if (p === '/v2/voices' && req.method === 'GET') return json(res, 200, { voices: VOICES, has_more: false, total_count: VOICES.length, next_page_token: null })
    const tts = /^\/v1\/text-to-speech\/([^/]+)$/.exec(p)
    if (tts && req.method === 'POST') {
      if (!VOICES.some((v) => v.voice_id === decodeURIComponent(tts[1]))) return json(res, 404, { detail: { status: 'voice_not_found', message: `A voice with voice_id ${tts[1]} was not found.` } })
      return file(res, media.audio, 'audio/mpeg')
    }
    if ((p === '/v1/music/stream' || p === '/v1/music' || p === '/v1/sound-generation') && req.method === 'POST') return file(res, media.audio, 'audio/mpeg')
    if (p === '/v1/audio-isolation' && req.method === 'POST') {
      const files = rec.body.__files as Record<string, unknown> | undefined
      if (!files?.audio) return json(res, 422, { detail: [{ loc: ['body', 'audio'], msg: 'Field required', type: 'missing' }] })
      return file(res, media.audio, 'audio/mpeg')
    }
    if (p === '/v1/dubbing' && req.method === 'POST') {
      const files = rec.body.__files as Record<string, unknown> | undefined
      if (!files?.file || !rec.body.target_lang) return json(res, 422, { detail: [{ loc: ['body', 'target_lang'], msg: 'Field required', type: 'missing' }] })
      const id = `dub_${randomUUID().slice(0, 8)}`
      dubs.set(id, { lang: String(rec.body.target_lang), polled: 0, deleted: false })
      return json(res, 200, { dubbing_id: id, expected_duration_sec: 3 })
    }
    const dub = /^\/v1\/dubbing\/([^/]+)(\/audio\/([^/]+))?$/.exec(p)
    if (dub) {
      const d = dubs.get(decodeURIComponent(dub[1]))
      if (!d || d.deleted) return json(res, 404, { detail: { status: 'dubbing_not_found', message: 'Dubbing not found.' } })
      if (req.method === 'DELETE') {
        cancels.push(dub[1])
        d.deleted = true
        return json(res, 200, { status: 'ok' })
      }
      if (dub[2]) return d.lang === dub[3] ? file(res, media.audio, 'audio/mpeg') : json(res, 404, { detail: { status: 'language_not_found', message: 'Language not dubbed.' } })
      d.polled++
      if (d.lang === 'xx') return json(res, 200, { dubbing_id: dub[1], name: 'x', status: 'failed', target_languages: [d.lang], error: 'Unsupported target language (fake).' })
      return json(res, 200, { dubbing_id: dub[1], name: 'x', status: d.polled <= polls ? 'dubbing' : 'dubbed', target_languages: [d.lang] })
    }
    return json(res, 404, { detail: { status: 'not_found', message: 'Not found' } })
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://x')
      const raw = await readBody(req)
      const contentType = String(req.headers['content-type'] ?? '')
      let body: Record<string, unknown> = {}
      if (contentType.startsWith('multipart/')) body = parseMultipart(raw, contentType)
      else if (raw.length) body = JSON.parse(raw.toString('utf8')) as Record<string, unknown>
      const provider = url.pathname.startsWith('/google/') ? 'google' : url.pathname.startsWith('/elevenlabs/') ? 'elevenlabs' : null
      if (!provider) return json(res, 404, {})
      const p = url.pathname.slice(provider.length + 1)
      const rec: ProviderRequest = { provider, method: req.method ?? 'GET', path: p + url.search, body, contentType, auth: String(req.headers['x-goog-api-key'] ?? req.headers['xi-api-key'] ?? '') }
      requests.push(rec)
      if (provider === 'google') await google(req, res, p, rec)
      else await eleven(req, res, p, rec)
    } catch (e) {
      json(res, 500, { error: { code: 500, message: e instanceof Error ? e.message : String(e) } })
    }
  })
  await new Promise<void>((resolve) => server.listen(o.port ?? 0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  return {
    url: base,
    googleBase: `${base}/google`,
    elevenBase: `${base}/elevenlabs`,
    requests,
    aborted,
    cancels,
    close: () =>
      new Promise<void>((resolve) => {
        for (const r of holds) r.destroy()
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.argv[2] ?? 0)
  const polls = Number(process.argv[3] ?? 2)
  sampleMedia()
  sampleWav()
  void startFakeProviders({ port, polls, googleKey: process.env.FAKE_GOOGLE_KEY ?? 'google-key', elevenKey: process.env.FAKE_ELEVEN_KEY ?? 'eleven-key' }).then((f) => {
    console.log(`FAKE_PROVIDERS_READY ${f.url}`)
    setInterval(() => console.log(`[fake-providers] ${f.requests.map((r) => `${r.provider}:${r.method} ${r.path}`).join(', ')} aborted=${f.aborted.length} cancels=${f.cancels.length}`), 5000).unref()
  })
}
