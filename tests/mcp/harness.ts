import { TEST_ROOT } from './env'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { emptyManifest, newId, newProjectFile, type MediaManifestEntry } from '../../src/core/model'
import { addMediaEntries } from '../../src/core/ops/project'
import { ffmpeg } from '../../src/main/media/ffmpeg'
import { startMcpServer } from '../../src/main/mcp/server'
import { imageSize } from '../../src/main/mcp/tools/images'
import { installPackageMedia, sourceForPath } from '../../src/main/project/packageIO'
import { ProjectSession } from '../../src/main/project/session'
import type { AppContext, ExportService, MediaService, RenderService, SessionRegistry } from '../../src/main/services'
import type { AppSettings, ExportJob, ProbeResult, UiCommand } from '../../src/shared/api'

export function makePng(width: number, height: number, color = 'red'): Promise<Buffer> {
  return ffmpeg(['-f', 'lavfi', '-i', `color=c=${color}:s=${width}x${height}`, '-frames:v', '1', '-c:v', 'png', '-f', 'image2', 'pipe:1'])
}

export function videoEntry(partial: Partial<MediaManifestEntry> = {}): MediaManifestEntry {
  return {
    id: newId(),
    name: 'Interview',
    type: 'video',
    source: { external: { absolutePath: path.join(TEST_ROOT, `missing-${randomUUID()}.mp4`) } },
    duration: 10,
    hasAudio: true,
    sourceWidth: 1920,
    sourceHeight: 1080,
    sourceFPS: 30,
    ...partial,
  }
}

export const imageEntry = (partial: Partial<MediaManifestEntry> = {}) =>
  videoEntry({ name: 'Still', type: 'image', duration: 5, hasAudio: false, sourceFPS: undefined, sourceWidth: 1080, sourceHeight: 1080, ...partial })

export const audioEntry = (partial: Partial<MediaManifestEntry> = {}) =>
  videoEntry({ name: 'Music', type: 'audio', duration: 20, hasAudio: true, sourceWidth: undefined, sourceHeight: undefined, sourceFPS: undefined, ...partial })

class FakeSessions implements SessionRegistry {
  list: ProjectSession[] = []
  front: ProjectSession | null = null
  focused() {
    return this.front
  }
  all() {
    return this.list
  }
  async openPath(p: string) {
    const open = this.list.find((s) => path.resolve(s.path) === path.resolve(p))
    if (open) {
      this.front = open
      return open
    }
    const s = await ProjectSession.open(p)
    this.list.push(s)
    this.front = s
    return s
  }
  async create(name: string) {
    const s = await ProjectSession.create(path.join(settings.projectsDirectory, `${name}.palmier`), { file: newProjectFile(), manifest: emptyManifest() })
    this.list.push(s)
    this.front = s
    return s
  }
  async close(s: ProjectSession) {
    await s.close()
    this.list = this.list.filter((x) => x !== s)
    if (this.front === s) this.front = this.list[0] ?? null
  }
}

const settings: AppSettings = {
  projectsDirectory: path.join(TEST_ROOT, 'projects'),
  mcpEnabled: true,
  mcpPort: 0,
  rippleTimelineMarkers: true,
  theme: 'dark',
  apiKeys: {},
  panels: { media: true, inspector: true, agent: true },
  layoutPreset: 'default',
}

async function probe(file: string): Promise<ProbeResult> {
  const ext = path.extname(file).slice(1).toLowerCase()
  if (ext === 'png') {
    const size = imageSize(await fs.readFile(file))
    return { type: 'image', duration: 5, width: size?.width, height: size?.height, hasAudio: false, hasVideo: true }
  }
  if (ext === 'wav' || ext === 'mp3') return { type: 'audio', duration: 4, hasAudio: true, hasVideo: false }
  return { type: 'video', duration: 6, width: 1280, height: 720, fps: 25, hasAudio: true, hasVideo: true }
}

function fakeMedia(): MediaService {
  const entryFor = async (session: ProjectSession, file: string, name: string, folderId?: string): Promise<MediaManifestEntry> => {
    const p = await probe(file)
    const e: MediaManifestEntry = { id: newId(), name, type: p.type, source: sourceForPath(file, session.path), duration: p.duration, hasAudio: p.hasAudio }
    if (p.width) e.sourceWidth = p.width
    if (p.height) e.sourceHeight = p.height
    if (folderId) e.folderId = folderId
    return e
  }
  return {
    probe,
    async importPaths(session, paths, folderId) {
      const entries = await Promise.all(paths.map((p) => entryFor(session, p, path.basename(p, path.extname(p)), folderId)))
      session.transact('Import Media', (d) => addMediaEntries(d, entries))
      return { added: entries.map((e) => e.id), rejected: [] }
    },
    async importBytes(session, data, filename, opts = {}) {
      const ext = path.extname(filename)
      const dest = await installPackageMedia(session.path, `${opts.prefix ?? 'imported'}-${randomUUID().slice(0, 8)}${ext}`, data)
      const e = await entryFor(session, dest, opts.name ?? path.basename(filename, ext), opts.folderId)
      session.transact('Import Media', (d) => addMediaEntries(d, [e]))
      return e.id
    },
    playbackPath: async () => null,
    thumbnail: async () => null,
    filmstrip: async () => [],
    waveform: async () => null,
    extractFrame: async (file, _at, opts = {}) =>
      file.endsWith('.png') && (await fs.stat(file).catch(() => null)) ? fs.readFile(file) : makePng(opts.width ?? 320, Math.round(((opts.width ?? 320) * 9) / 16)),
  }
}

export interface Harness {
  url: string
  ctx: AppContext
  sessions: FakeSessions
  session: ProjectSession
  ui: UiCommand[]
  exports: ExportJob[]
  close(): Promise<void>
}

export async function startHarness(entries: MediaManifestEntry[] = []): Promise<Harness> {
  await fs.mkdir(settings.projectsDirectory, { recursive: true })
  const sessions = new FakeSessions()
  const manifest = emptyManifest()
  manifest.entries.push(...entries)
  const session = await ProjectSession.create(path.join(TEST_ROOT, `p-${randomUUID().slice(0, 8)}.palmier`), { file: newProjectFile(), manifest })
  sessions.list.push(session)
  sessions.front = session
  const ui: UiCommand[] = []
  const jobs: ExportJob[] = []
  const render: RenderService = {
    async captureFrame(s, req) {
      const t = s.doc.file.timelines.find((x) => x.id === req.timelineId)!
      const width = req.width ?? t.width
      return makePng(width, Math.max(2, Math.round((width * t.height) / t.width)))
    },
    async measureText(reqs) {
      return reqs.map((r) => ({ width: Math.min(0.9, (r.content.length * r.style.fontSize * 0.5) / r.canvasWidth), height: (r.style.fontSize * 1.2) / r.canvasHeight }))
    },
  }
  const exporter: ExportService = {
    start(_s, options) {
      const job: ExportJob = {
        id: randomUUID(),
        options,
        status: jobs.some((j) => j.status === 'running') ? 'queued' : 'running',
        progress: 0,
        framesRendered: 0,
        totalFrames: 0,
        startedAt: new Date(Date.now() + jobs.length).toISOString(),
        outputPath: options.outputPath,
      }
      jobs.push(job)
      return job
    },
    get: (id) => jobs.find((j) => j.id === id),
    list: () => jobs,
    cancel: (id) => {
      const j = jobs.find((x) => x.id === id)
      if (j) j.status = 'cancelled'
    },
    wait: async (id) => jobs.find((j) => j.id === id)!,
    on: () => undefined,
  }
  const ctx: AppContext = { sessions, media: fakeMedia(), render, exporter, settings: () => settings, ui: (_s, cmd) => ui.push(cmd) }
  const server = await startMcpServer(ctx, { port: 0 })
  return {
    url: server.url,
    ctx,
    sessions,
    session,
    ui,
    exports: jobs,
    async close() {
      await server.close()
      for (const s of sessions.list) await s.close()
    },
  }
}

export async function connect(url: string): Promise<Client> {
  const client = new Client({ name: 'palmier-test', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(url)))
  return client
}

export interface CallResult {
  text: string
  isError: boolean
  images: { data: string; mimeType: string }[]
  json: any
}

export async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<CallResult> {
  const r = (await client.callTool({ name, arguments: args })) as { content: { type: string; text?: string; data?: string; mimeType?: string }[]; isError?: boolean }
  const texts = r.content.filter((b) => b.type === 'text').map((b) => b.text!)
  const text = texts[texts.length - 1] ?? ''
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    json = undefined
  }
  return { text, isError: r.isError === true, images: r.content.filter((b) => b.type === 'image').map((b) => ({ data: b.data!, mimeType: b.mimeType! })), json }
}
