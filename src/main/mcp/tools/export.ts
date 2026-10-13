/** export_project (queue a video / XMEML / FCPXML / .palmier export) and manage_exports (list, cancel). */
import { existsSync, statSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { activeTimeline, timelineById, type Doc } from '../../../core/ops/context'
import { qualityResolution } from '../../../core/ops/project'
import { totalFrames } from '../../../core/timeline'
import type { ExportFormat, ExportJob, ExportOptions } from '../../../shared/api'
import { APP_NAME } from '../../../shared/brand'
import { ToolError, decodeArgs, opt, type Obj } from './args'
import { okRawJson, type ToolEnv, type ToolResult } from './context'
import { watchExport } from '../../notifications'

type Mode = 'video' | 'xml' | 'fcpxml' | 'palmier'
type Codec = 'H.264' | 'H.265' | 'ProRes'

const normalized = (raw: string) => raw.trim().toLowerCase().replace(/\s+/g, '').replace(/[-_]/g, '')

function parseMode(raw?: string): Mode {
  if (raw === undefined) return 'video'
  const m = normalized(raw)
  if (m === 'video' || m === 'xml' || m === 'fcpxml' || m === 'palmier') return m
  throw new ToolError('export_project: mode must be video, xml, fcpxml, or palmier')
}

function parseCodec(raw?: string): Codec {
  if (raw === undefined) return 'H.264'
  const c = normalized(raw)
  if (c === 'h.264' || c === 'h264') return 'H.264'
  if (c === 'h.265' || c === 'h265' || c === 'hevc') return 'H.265'
  if (c === 'prores') return 'ProRes'
  throw new ToolError('export_project: codec must be H.264, H.265, or ProRes')
}

const SHORT_EDGES: Record<string, number | null> = { '720p': 720, '1080p': 1080, '2k': 1440, '4k': 2160, matchtimeline: null }

function parseResolution(raw?: string): number | null {
  if (raw === undefined) return null
  const r = normalized(raw)
  if (!(r in SHORT_EDGES)) throw new ToolError('export_project: resolution must be 720p, 1080p, 2K, 4K, or Match Timeline')
  return SHORT_EDGES[r]
}

const extensionFor = (mode: Mode, codec: Codec): string => (mode === 'video' ? (codec === 'ProRes' ? 'mov' : 'mp4') : mode)
const labelFor = (mode: Mode, codec: Codec): string => (mode === 'video' ? codec : mode === 'xml' ? 'XML' : mode === 'fcpxml' ? 'FCPXML' : `${APP_NAME} Project`)

const isTerminal = (s: ExportJob['status']) => s === 'completed' || s === 'failed' || s === 'cancelled'

/** The XDG download directory (`XDG_DOWNLOAD_DIR`, else ~/Downloads). */
function downloadsDir(): string {
  const env = process.env.XDG_DOWNLOAD_DIR
  return env && path.isAbsolute(env) ? env : path.join(os.homedir(), 'Downloads')
}

function uniqueDestination(file: string, reserved: Set<string>): string {
  const taken = (p: string) => existsSync(p) || reserved.has(p)
  if (!taken(file)) return file
  const ext = path.extname(file)
  const base = file.slice(0, file.length - ext.length)
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}${ext}`
    if (!taken(candidate)) return candidate
  }
}

function directDestination(raw: string, mode: Mode, codec: Codec, overwrite: boolean): string {
  const expanded = raw.replace(/^~(?=$|\/)/, os.homedir())
  if (!expanded.startsWith('/')) throw new ToolError('export_project: outputPath must be absolute')
  const expected = extensionFor(mode, codec)
  const rawExt = path.extname(expanded).slice(1).toLowerCase()
  let file = expanded
  if (!rawExt) file = `${expanded}.${expected}`
  else if (rawExt !== expected) throw new ToolError(`export_project: ${labelFor(mode, codec)} exports must use .${expected}`)
  const st = statSync(expanded, { throwIfNoEntry: false })
  if (st?.isDirectory() && !(mode === 'palmier' && rawExt === expected)) throw new ToolError('export_project: outputPath must include a filename')
  if (!statSync(path.dirname(file), { throwIfNoEntry: false })?.isDirectory()) throw new ToolError('export_project: output directory does not exist')
  const resolved = path.resolve(file)
  if (!overwrite && existsSync(resolved)) throw new ToolError('export_project: output file already exists')
  return resolved
}

/** Jobs of this project: exports whose timeline belongs to it. */
function projectJobs(env: ToolEnv): ExportJob[] {
  const ids = new Set(env.session.doc.file.timelines.map((t) => t.id))
  return env.app.exporter.list().filter((j) => ids.has(j.options.timelineId))
}

function queuePosition(app: ToolEnv['app'], id: string): number {
  return app.exporter.list().filter((j) => j.status === 'queued').findIndex((j) => j.id === id) + 1
}

function nestWarnings(doc: Doc, timelineId: string): string[] {
  const t = timelineById(doc, timelineId)!
  const dropped = t.tracks
    .flatMap((tr) => tr.clips)
    .filter((c) => {
      const child = c.sourceClipType === 'sequence' && c.mediaType !== 'audio' ? timelineById(doc, c.mediaRef) : null
      return c.sourceClipType === 'sequence' && c.mediaType !== 'audio' && (!child || totalFrames(child) === 0)
    }).length
  if (!dropped) return []
  return [`${dropped} nested timeline ${dropped === 1 ? 'clip was' : 'clips were'} skipped because the source timeline is empty or missing.`]
}

interface ExportInput {
  mode?: string
  codec?: string
  resolution?: string
  outputPath?: string
  overwrite?: boolean
  fcpxmlTarget?: string
  timelineId?: string
}

export async function exportProject(env: ToolEnv, args: Obj): Promise<ToolResult> {
  const input = decodeArgs<ExportInput>(args, 'export_project', {
    mode: opt('String'),
    codec: opt('String'),
    resolution: opt('String'),
    outputPath: opt('String'),
    overwrite: opt('Bool'),
    fcpxmlTarget: opt('String'),
    timelineId: opt('String'),
  })
  const mode = parseMode(input.mode)
  if (mode !== 'video') {
    if (input.codec !== undefined) throw new ToolError('export_project: codec only applies to video mode')
    if (input.resolution !== undefined) throw new ToolError('export_project: resolution only applies to video mode')
  }
  const codec = parseCodec(mode === 'video' ? input.codec : undefined)
  const shortEdge = mode === 'video' ? parseResolution(input.resolution) : null
  const doc = env.session.doc
  let timeline = activeTimeline(doc)
  if (input.timelineId !== undefined) {
    if (mode === 'palmier') throw new ToolError("export_project: timelineId doesn't apply to palmier mode — the package carries every timeline")
    const t = timelineById(doc, input.timelineId)
    if (!t) throw new ToolError(`export_project: no timeline with id '${input.timelineId}'. get_timeline lists the project's timelines.`)
    timeline = t
  }
  let outputPath: string
  if (input.outputPath === undefined) {
    const dir = downloadsDir()
    await fs.mkdir(dir, { recursive: true })
    const reserved = new Set(env.app.exporter.list().filter((j) => !isTerminal(j.status)).map((j) => j.outputPath))
    outputPath = uniqueDestination(path.join(dir, `${env.session.name || 'Untitled Project'}.${extensionFor(mode, codec)}`), reserved)
  } else outputPath = directDestination(input.outputPath, mode, codec, input.overwrite ?? true)
  let target: 'resolve' | 'fcp' | undefined
  if (mode === 'fcpxml') {
    if (input.fcpxmlTarget !== undefined && input.fcpxmlTarget !== 'resolve' && input.fcpxmlTarget !== 'fcp') throw new ToolError("export_project: fcpxmlTarget must be 'resolve' or 'fcp'")
    target = (input.fcpxmlTarget as 'resolve' | 'fcp' | undefined) ?? 'resolve'
  }
  const total = totalFrames(timeline)
  if (mode === 'video' && total <= 0) throw new ToolError('export_project: timeline is empty')
  const formats: Record<Mode, ExportFormat> = { video: codec === 'ProRes' ? 'mov' : 'mp4', xml: 'xml', fcpxml: 'fcpxml', palmier: 'palmier' }
  const options: ExportOptions = { timelineId: timeline.id, format: formats[mode], outputPath }
  if (mode === 'video') {
    options.codec = codec === 'H.264' ? 'h264' : codec === 'H.265' ? 'hevc' : 'prores'
    if (shortEdge !== null) {
      const size = qualityResolution(shortEdge, timeline.width, timeline.height)
      options.width = size.width - (size.width % 2)
      options.height = size.height - (size.height % 2)
    }
  }
  if (target) options.fcpxmlTarget = target
  const warnings = mode === 'xml' || mode === 'fcpxml' ? nestWarnings(doc, timeline.id) : []
  let job: ExportJob
  try {
    job = env.app.exporter.start(env.session, options)
    watchExport(job.id, env.session, { size: mode === 'video' ? { width: options.width ?? timeline.width, height: options.height ?? timeline.height } : undefined, warnings: warnings.length })
  } catch (e) {
    throw new ToolError(`export_project: ${e instanceof Error ? e.message : String(e)}`)
  }
  const payload: Obj = {
    status: job.status === 'queued' ? 'queued' : 'started',
    jobId: job.id,
    queuePosition: queuePosition(env.app, job.id),
    mode,
    path: job.outputPath,
    note: 'The export is available in the Export dialog.',
  }
  if (mode !== 'palmier') {
    Object.assign(payload, { format: labelFor(mode, codec), timeline: timeline.name, durationFrames: total, durationSeconds: total / Math.max(1, timeline.fps), fps: timeline.fps })
    if (warnings.length) payload.warnings = warnings
  }
  return okRawJson(payload)
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function status(j: ExportJob): string {
  switch (j.status) {
    case 'running':
      return j.progress > 0 ? 'rendering' : 'preparing'
    case 'cancelled':
      return 'canceled'
    default:
      return j.status
  }
}

export function manageExports(env: ToolEnv, args: Obj): ToolResult {
  const input = decodeArgs<{ action: string; jobId?: string }>(args, 'manage_exports', { action: 'String', jobId: opt('String') })
  const jobs = projectJobs(env)
  switch (input.action) {
    case 'list': {
      if (input.jobId !== undefined) throw new ToolError('manage_exports: jobId only applies to cancel')
      const rows = [...jobs]
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .map((j) => {
          const row: Obj = { jobId: j.id, filename: path.basename(j.outputPath), path: j.outputPath, status: status(j), progress: Math.round(j.progress * 100) }
          const position = queuePosition(env.app, j.id)
          if (position) row.queuePosition = position
          if (j.error) row.error = j.error
          if (j.warnings?.length) row.warnings = j.warnings
          return row
        })
      return okRawJson({ exports: rows })
    }
    case 'cancel': {
      if (!input.jobId || !UUID_RE.test(input.jobId)) throw new ToolError('manage_exports: cancel requires a valid jobId')
      const job = jobs.find((j) => j.id.toLowerCase() === input.jobId!.toLowerCase())
      if (!job) throw new ToolError('manage_exports: export not found in the current project')
      let result: string
      let requested: boolean
      if (isTerminal(job.status)) {
        result = status(job)
        requested = false
      } else {
        result = job.status === 'queued' ? 'removed' : 'canceling'
        env.app.exporter.cancel(job.id)
        requested = true
      }
      return okRawJson({ jobId: job.id, filename: path.basename(job.outputPath), status: result, cancellationRequested: requested })
    }
    default:
      throw new ToolError('manage_exports: action must be list or cancel')
  }
}
