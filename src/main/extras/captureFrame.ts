/**
 * Capture frame to media (spec 07 §6.4, `EditorViewModel+FrameCapture.swift`, `FrameCaptureRenderer.swift`).
 * One implementation for the preview transport camera button (IPC) and the MCP `capture_frame` tool.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import { newId, DEFAULTS, type MediaManifestEntry } from '../../core/model'
import { activeTimeline, timelineById } from '../../core/ops/context'
import { addMediaEntries } from '../../core/ops/project'
import { totalFrames } from '../../core/timeline'
import type { FrameCaptureSource } from '../../shared/extras'
import { ffmpegPath } from '../media/ffmpeg'
import { ffprobeJson } from '../media/probe'
import { sourceForPath } from '../project/packageIO'
import type { ProjectSession } from '../project/session'
import type { AppContext } from '../services'
import { commitStaged, hex8, removeQuietly, stagePath } from './stage'

export const CAPTURE_ERRORS = {
  noProject: 'No project is open.',
  timelineEmpty: 'The timeline is empty.',
  timelineNotFound: 'Timeline not found.',
  frameOutOfRange: (frame: number, total: number) => `Timeline frame ${frame} is outside 0..<${total}.`,
  mediaNotFound: (ref: string) => `Media asset not found: ${ref}`,
  mediaNotVideo: (ref: string) => `Media asset ${ref} is not a video.`,
  mediaPreparing: (ref: string) => `Media asset ${ref} is still preparing.`,
  mediaFailed: (ref: string, reason: string) => `Media asset ${ref} failed: ${reason}`,
  folderMissing: 'The destination media folder no longer exists.',
  noVideoTrack: 'No video track is available.',
  invalidDuration: 'The video has no finite duration.',
  sourceOutOfRange: (requested: number, duration: number) => `Source time ${requested.toFixed(3)}s is outside 0…${duration.toFixed(3)}s.`,
  renderFailed: (reason: string) => `Could not render the frame: ${reason}`,
  encodeFailed: 'Could not encode the captured frame as PNG.',
} as const

const MEDIA_DURATION_TOLERANCE = 0.001
const FAILED_PREFIX = 'failed: '

/** At most two renders app-wide (`FrameCaptureRenderer.renderGate`). */
class Gate {
  private active = 0
  private waiters: (() => void)[] = []
  constructor(private readonly limit: number) {}
  async use<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((r) => this.waiters.push(r))
    this.active++
    try {
      return await fn()
    } finally {
      this.active--
      this.waiters.shift()?.()
    }
  }
}
const renderGate = new Gate(2)

export interface CaptureReceipt {
  asset: MediaManifestEntry
  width: number
  height: number
  timelineId?: string
  actualSourceSeconds?: number
  destinationFolderWasRemoved: boolean
}

/** PNG IHDR size, or null when the bytes aren't a PNG. */
export function pngSize(buf: Buffer): { width: number; height: number } | null {
  return buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47 ? { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) } : null
}

/** `FrameCaptureRenderer.sourceFrameRequest`: validates the time and picks the request (last frame or nearest). */
export function sourceFrameRequest(sourceSeconds: number, duration: number, minFrameDuration: number): { time: number; capturesLastFrame: boolean } {
  if (!(Number.isFinite(duration) && duration > 0)) throw new Error(CAPTURE_ERRORS.invalidDuration)
  if (!(Number.isFinite(sourceSeconds) && sourceSeconds >= 0 && sourceSeconds <= duration + MEDIA_DURATION_TOLERANCE)) {
    throw new Error(CAPTURE_ERRORS.sourceOutOfRange(sourceSeconds, duration))
  }
  const capturesLastFrame = sourceSeconds >= duration - minFrameDuration
  return { time: capturesLastFrame ? Math.max(0, duration - minFrameDuration) : sourceSeconds, capturesLastFrame }
}

/** FFmpeg args for one source frame; `-copyts` keeps showinfo's `pts_time` in source time. Exported for tests. */
export function sourceFrameArgs(file: string, output: string, req: { time: number; capturesLastFrame: boolean }, minFrameDuration: number): string[] {
  const seek = req.capturesLastFrame
    ? // A few frames before the end; `-update 1` keeps overwriting the PNG so the last decoded frame wins.
      ['-sseof', `-${Math.max(4 * minFrameDuration, 0.25).toFixed(6)}`]
    : ['-ss', req.time.toFixed(6)]
  return ['-hide_banner', '-nostdin', '-loglevel', 'info', '-y', '-copyts', ...seek, '-i', file, '-map', '0:v:0', '-vf', 'showinfo', ...(req.capturesLastFrame ? ['-update', '1'] : ['-frames:v', '1']), '-c:v', 'png', '-f', 'image2', output]
}

/** Last `pts_time` that showinfo printed. */
export function lastPtsTime(stderr: string): number | null {
  let last: number | null = null
  for (const m of stderr.matchAll(/pts_time:\s*(-?[0-9.]+(?:e-?\d+)?)/g)) {
    const v = Number(m[1])
    if (Number.isFinite(v)) last = v
  }
  return last
}

function runFfmpeg(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    child.stderr.on('data', (d: Buffer) => {
      err += d.toString()
      if (err.length > 2_000_000) err = err.slice(-1_000_000)
    })
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve(err) : reject(new Error(err.trim().split('\n').slice(-2).join(' | ') || `ffmpeg exited with ${code}`))))
  })
}

const parseRate = (r?: string): number | undefined => {
  if (!r) return undefined
  const [n, d] = r.split('/').map(Number)
  const v = d ? n / d : n
  return Number.isFinite(v) && v > 0 ? v : undefined
}

/** `FrameCaptureRenderer.media`: one decoded source frame (display rotation applied) staged as PNG. */
async function renderMediaFrame(file: string, sourceSeconds: number): Promise<{ png: Buffer; actualSourceSeconds?: number }> {
  let info: Awaited<ReturnType<typeof ffprobeJson>>
  try {
    info = await ffprobeJson(file)
  } catch (e) {
    throw new Error(CAPTURE_ERRORS.renderFailed(e instanceof Error ? e.message : String(e)))
  }
  const v = info.streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic) as (typeof info.streams)[number] & { start_time?: string; nb_frames?: string }
  if (!v) throw new Error(CAPTURE_ERRORS.noVideoTrack)
  const start = Number(v.start_time ?? 0) || 0
  const duration = Number(v.duration ?? info.format.duration)
  const rate = parseRate(v.avg_frame_rate) ?? parseRate(v.r_frame_rate)
  const minFrame = rate ? 1 / rate : 1 / 600
  const req = sourceFrameRequest(sourceSeconds, duration, minFrame)
  const staged = stagePath('png')
  try {
    let stderr: string
    try {
      stderr = await runFfmpeg(sourceFrameArgs(file, staged, req, minFrame))
    } catch (e) {
      throw new Error(CAPTURE_ERRORS.renderFailed(e instanceof Error ? e.message : String(e)))
    }
    const png = await fs.readFile(staged).catch(() => null)
    if (!png || !pngSize(png)) throw new Error(CAPTURE_ERRORS.renderFailed('no frame decoded'))
    const pts = lastPtsTime(stderr)
    return { png, actualSourceSeconds: pts === null ? undefined : Math.max(0, pts - start) }
  } finally {
    await removeQuietly(staged)
  }
}

export interface CaptureOptions {
  name?: string
  folderId?: string | null
  /** Timeline to capture from (default: the active one). Used by Create AI Transition. */
  timelineId?: string
}

/** `captureFrameToMedia(source:name:folderId:)`: renders, commits `media/frame-<8 hex>.png`, adds the image asset (undo "Capture Frame"). */
export async function captureFrameToMedia(app: Pick<AppContext, 'render'>, session: ProjectSession | null, source: FrameCaptureSource, opts: CaptureOptions = {}): Promise<CaptureReceipt> {
  if (!session || session.closed) throw new Error(CAPTURE_ERRORS.noProject)
  const folderId = opts.folderId ?? undefined
  const folderExists = (id: string) => session.doc.manifest.folders.some((f) => f.id === id)
  if (folderId && !folderExists(folderId)) throw new Error(CAPTURE_ERRORS.folderMissing)

  let png: Buffer
  let defaultName: string
  let timelineId: string | undefined
  let actualSourceSeconds: number | undefined
  if (source.kind === 'timeline') {
    const t = opts.timelineId ? timelineById(session.doc, opts.timelineId) : activeTimeline(session.doc)
    if (!t) throw new Error(CAPTURE_ERRORS.timelineNotFound)
    const total = totalFrames(t)
    if (total <= 0) throw new Error(CAPTURE_ERRORS.timelineEmpty)
    if (!(Number.isInteger(source.frame) && source.frame >= 0 && source.frame < total)) throw new Error(CAPTURE_ERRORS.frameOutOfRange(source.frame, total))
    defaultName = `Frame ${source.frame}`
    timelineId = t.id
    png = await renderGate.use(() => app.render.captureFrame(session, { timelineId: t.id, frame: source.frame, format: 'png' }))
  } else {
    const ref = source.mediaRef
    const media = session.doc.manifest.entries.find((e) => e.id === ref)
    if (!media) throw new Error(CAPTURE_ERRORS.mediaNotFound(ref))
    if (media.type !== 'video') throw new Error(CAPTURE_ERRORS.mediaNotVideo(ref))
    const status = media.generationStatus
    if (status?.startsWith(FAILED_PREFIX)) throw new Error(CAPTURE_ERRORS.mediaFailed(ref, status.slice(FAILED_PREFIX.length)))
    if (status && status !== 'none') throw new Error(CAPTURE_ERRORS.mediaPreparing(ref))
    const file = session.resolveMedia(media)
    if (!file) throw new Error(CAPTURE_ERRORS.mediaPreparing(ref))
    defaultName = `${media.name} frame`
    const r = await renderGate.use(() => renderMediaFrame(file, source.sourceSeconds))
    png = r.png
    actualSourceSeconds = r.actualSourceSeconds
  }
  const size = pngSize(png)
  if (!size) throw new Error(CAPTURE_ERRORS.encodeFailed)
  if (session.closed) throw new Error(CAPTURE_ERRORS.noProject)

  const staged = stagePath('png')
  let dest: string
  try {
    await fs.writeFile(staged, png)
    dest = await commitStaged(session, staged, `frame-${hex8()}.png`)
  } finally {
    await removeQuietly(staged)
  }
  const stillThere = folderId ? folderExists(folderId) : true
  const asset: MediaManifestEntry = {
    id: newId(),
    name: opts.name ?? defaultName,
    type: 'image',
    source: sourceForPath(dest, session.path),
    duration: DEFAULTS.imageDurationSeconds,
    sourceWidth: size.width,
    sourceHeight: size.height,
    hasAudio: false,
  }
  if (folderId && stillThere) asset.folderId = folderId
  const out = session.transact('Capture Frame', (d) => addMediaEntries(d, [asset]))
  if (!out.ok) throw new Error(out.error)
  return { asset, width: size.width, height: size.height, timelineId, actualSourceSeconds, destinationFolderWasRemoved: !stillThere }
}
