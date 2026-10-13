/**
 * A local fake of fal.ai's queue + storage REST (spec 06 §B12.1) for tests and headless checks — never the real API.
 * Queue under /queue, storage under /rest, result files under /files. Results are real media made with ffmpeg.
 *
 * CLI: `node tests/generation/fakeFal.ts <port> [polls]` prints `FAKE_FAL_READY <baseUrl>`; prompts with "[fail]" / "[hold]" fail / hang.
 */
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export type OutputKind = 'video' | 'image' | 'audio'

export interface Behavior {
  /** Non-terminal status polls before COMPLETED (default: server option, 1). */
  polls?: number
  /** COMPLETED with this `error` (fal's failed run). */
  error?: string
  /** Result GET answers this status/body (e.g. 422 `{detail:[{msg}]}`). */
  resultStatus?: number
  resultBody?: unknown
  /** Submit answers this status/body instead of accepting the job. */
  submitStatus?: number
  submitBody?: unknown
  /** Override the output kind / count. */
  output?: OutputKind
  count?: number
  /** Stay IN_PROGRESS until `release()` (or cancel). */
  hold?: boolean
  /** Extra keys merged into the result JSON (e.g. draft_cache). */
  extra?: Record<string, unknown>
}

export interface FakeFalOptions {
  port?: number
  key?: string
  polls?: number
  behavior?: (endpoint: string, body: Record<string, unknown>) => Behavior | undefined
}

export interface SubmittedRequest {
  id: string
  endpoint: string
  body: Record<string, unknown>
  auth: string | undefined
}

interface Job extends SubmittedRequest {
  behavior: Behavior
  polled: number
  released: boolean
  cancelled: boolean
}

export interface FakeFal {
  url: string
  submissions: SubmittedRequest[]
  uploads: { name: string; contentType: string; bytes: number; multipart: boolean }[]
  cancels: string[]
  statusPolls: number
  release(id?: string): void
  close(): Promise<void>
}

let mediaDir: string | null = null

function ffmpegBin(): string {
  try {
    const p = createRequire(import.meta.url)('ffmpeg-static') as string
    if (p && fs.existsSync(p)) return p
  } catch {
    // system ffmpeg
  }
  return 'ffmpeg'
}

/** Real media files the fake serves as results (made once per process). */
function sampleMedia(): Record<OutputKind, string> {
  if (!mediaDir) {
    mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-fal-media-'))
    const ff = ffmpegBin()
    const q = ['-hide_banner', '-loglevel', 'error', '-y']
    execFileSync(ff, [...q, '-f', 'lavfi', '-i', 'testsrc2=s=320x180:d=2:r=24', '-f', 'lavfi', '-i', 'sine=f=440:d=2', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path.join(mediaDir, 'result.mp4')])
    execFileSync(ff, [...q, '-f', 'lavfi', '-i', 'testsrc2=s=320x180:d=1', '-frames:v', '1', path.join(mediaDir, 'result.png')])
    execFileSync(ff, [...q, '-f', 'lavfi', '-i', 'sine=f=330:d=3', '-c:a', 'libmp3lame', '-b:a', '64k', path.join(mediaDir, 'result.mp3')])
  }
  return { video: path.join(mediaDir, 'result.mp4'), image: path.join(mediaDir, 'result.png'), audio: path.join(mediaDir, 'result.mp3') }
}

export function outputKindFor(endpoint: string): OutputKind {
  if (/upscale\/image|nano-banana|seedream|gpt-image|grok-imagine-image|ideogram|recraft|reve\/|text-to-image/.test(endpoint)) return 'image'
  if (/audio|tts|music|sound|lyria|sonilo|mirelo|dubbing|isolation/.test(endpoint)) return 'audio'
  return 'video'
}

const EXT: Record<OutputKind, string> = { video: 'mp4', image: 'png', audio: 'mp3' }

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

export async function startFakeFal(o: FakeFalOptions = {}): Promise<FakeFal> {
  const key = o.key ?? 'test-key'
  const jobs = new Map<string, Job>()
  const submissions: SubmittedRequest[] = []
  const uploads: FakeFal['uploads'] = []
  const cancels: string[] = []
  const pendingMultipart = new Map<string, { name: string; contentType: string; parts: number; bytes: number }>()
  const stats = { statusPolls: 0 }
  let base = ''

  const send = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
    res.end(typeof body === 'string' ? body : JSON.stringify(body))
  }
  const authorized = (req: http.IncomingMessage) => req.headers.authorization === `Key ${key}`

  const resultJson = (job: Job): Record<string, unknown> => {
    const kind = job.behavior.output ?? outputKindFor(job.endpoint)
    const file = (n: number) => ({ url: `${base}/files/${job.id}-${n}.${EXT[kind]}`, content_type: kind === 'image' ? 'image/png' : kind === 'audio' ? 'audio/mpeg' : 'video/mp4' })
    const count = job.behavior.count ?? (typeof job.body.num_images === 'number' ? job.body.num_images : 1)
    const out: Record<string, unknown> =
      kind === 'image' ? { images: Array.from({ length: count }, (_, i) => file(i)) } : kind === 'audio' ? { audio: file(0) } : { video: file(0), seed: 42 }
    return { ...out, ...job.behavior.extra }
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', base)
      const p = url.pathname
      const body = await readBody(req)
      if (p.startsWith('/files/')) {
        const name = p.slice('/files/'.length)
        const kind: OutputKind = name.endsWith('.png') ? 'image' : name.endsWith('.mp3') ? 'audio' : 'video'
        const data = fs.readFileSync(sampleMedia()[kind])
        res.writeHead(200, { 'Content-Type': kind === 'image' ? 'image/png' : kind === 'audio' ? 'audio/mpeg' : 'video/mp4', 'Content-Length': String(data.length) })
        return res.end(data)
      }
      if (p.startsWith('/rest/')) {
        if (!authorized(req)) return send(res, 401, { detail: 'Unauthorized' })
        const json = JSON.parse(body.toString('utf8') || '{}') as { content_type?: string; file_name?: string }
        const id = randomUUID()
        if (p === '/rest/storage/upload/initiate') {
          return send(res, 200, { upload_url: `${base}/upload/${id}?name=${encodeURIComponent(json.file_name ?? 'file')}`, file_url: `${base}/cdn/${id}/${json.file_name ?? 'file'}` })
        }
        if (p === '/rest/storage/upload/initiate-multipart') {
          pendingMultipart.set(id, { name: json.file_name ?? 'file', contentType: json.content_type ?? '', parts: 0, bytes: 0 })
          return send(res, 200, { upload_url: `${base}/multipart/${id}?token=t`, file_url: `${base}/cdn/${id}/${json.file_name ?? 'file'}` })
        }
        return send(res, 404, { detail: 'Not found' })
      }
      if (p.startsWith('/upload/') && req.method === 'PUT') {
        uploads.push({ name: url.searchParams.get('name') ?? '', contentType: String(req.headers['content-type'] ?? ''), bytes: body.length, multipart: false })
        return send(res, 200, {})
      }
      if (p.startsWith('/multipart/')) {
        const [, , id, part] = p.split('/')
        const mp = pendingMultipart.get(id)
        if (!mp || url.searchParams.get('token') !== 't') return send(res, 404, { detail: 'Not found' })
        if (part === 'complete' && req.method === 'POST') {
          uploads.push({ name: mp.name, contentType: mp.contentType, bytes: mp.bytes, multipart: true })
          pendingMultipart.delete(id)
          return send(res, 200, {})
        }
        mp.parts++
        mp.bytes += body.length
        return send(res, 200, {}, { ETag: `"etag-${part}"` })
      }
      if (p.startsWith('/cdn/')) return send(res, 200, {})
      if (!p.startsWith('/queue/')) return send(res, 404, { detail: 'Not found' })
      if (!authorized(req)) return send(res, 401, { detail: 'Unauthorized' })
      const rest = p.slice('/queue/'.length)
      const m = /^(.*)\/requests\/([^/]+)(\/status|\/cancel)?$/.exec(rest)
      if (m) {
        const job = jobs.get(m[2])
        if (!job) return send(res, 404, { detail: 'Request not found' })
        if (m[3] === '/cancel') {
          cancels.push(job.id)
          if (job.released && job.polled > (job.behavior.polls ?? o.polls ?? 1)) return send(res, 400, { status: 'ALREADY_COMPLETED' })
          job.cancelled = true
          return send(res, 202, { status: 'CANCELLATION_REQUESTED' })
        }
        if (m[3] === '/status') {
          stats.statusPolls++
          job.polled++
          const needed = job.behavior.polls ?? o.polls ?? 1
          if (job.cancelled) return send(res, 200, { status: 'COMPLETED', error: 'Request was cancelled', error_type: 'request_cancelled' })
          if (job.behavior.hold && !job.released) return send(res, 200, { status: 'IN_PROGRESS', logs: [] })
          if (job.polled <= needed) return send(res, 200, job.polled === 1 ? { status: 'IN_QUEUE', queue_position: 0 } : { status: 'IN_PROGRESS', logs: [] })
          if (job.behavior.error) return send(res, 200, { status: 'COMPLETED', error: job.behavior.error, error_type: 'internal' })
          return send(res, 200, { status: 'COMPLETED' })
        }
        if (job.behavior.resultStatus) return send(res, job.behavior.resultStatus, job.behavior.resultBody ?? {})
        return send(res, 200, resultJson(job))
      }
      if (req.method !== 'POST') return send(res, 405, { detail: 'Method not allowed' })
      const endpoint = rest
      const input = JSON.parse(body.toString('utf8') || '{}') as Record<string, unknown>
      const behavior = o.behavior?.(endpoint, input) ?? {}
      if (behavior.submitStatus) return send(res, behavior.submitStatus, behavior.submitBody ?? {})
      const id = randomUUID()
      const sub: SubmittedRequest = { id, endpoint, body: input, auth: req.headers.authorization }
      submissions.push(sub)
      jobs.set(id, { ...sub, behavior, polled: 0, released: false, cancelled: false })
      const app = endpoint.split('/').slice(0, 2).join('/')
      const reqUrl = `${base}/queue/${app}/requests/${id}`
      return send(res, 200, { request_id: id, response_url: reqUrl, status_url: `${reqUrl}/status`, cancel_url: `${reqUrl}/cancel`, queue_position: 0 })
    } catch (e) {
      send(res, 500, { detail: e instanceof Error ? e.message : String(e) })
    }
  })
  await new Promise<void>((resolve) => server.listen(o.port ?? 0, '127.0.0.1', resolve))
  const addr = server.address() as { port: number }
  base = `http://127.0.0.1:${addr.port}`
  return {
    url: base,
    submissions,
    uploads,
    cancels,
    get statusPolls() {
      return stats.statusPolls
    },
    release(id?: string) {
      for (const j of jobs.values()) if (!id || j.id === id) j.released = true
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.argv[2] ?? 0)
  const polls = Number(process.argv[3] ?? 3)
  sampleMedia()
  // Headless checks steer jobs from the prompt: "[fail]" → provider error, "[hold]" → stays in progress until cancelled.
  const behavior = (_endpoint: string, body: Record<string, unknown>): Behavior | undefined => {
    const prompt = typeof body.prompt === 'string' ? body.prompt : ''
    if (prompt.includes('[fail]')) return { error: 'Content policy violation (fake)' }
    if (prompt.includes('[hold]')) return { hold: true }
    return undefined
  }
  void startFakeFal({ port, polls, behavior, key: process.env.FAKE_FAL_KEY ?? 'test-key' }).then((f) => {
    console.log(`FAKE_FAL_READY ${f.url}`)
    setInterval(() => console.log(`[fake-fal] submissions=${f.submissions.map((s) => s.endpoint).join(',')} uploads=${f.uploads.length} cancels=${f.cancels.length}`), 5000).unref()
  })
}
