/**
 * Export queue (spec 04 §11): one active job, FIFO. Video frames come from the render host's compositor
 * piped into an FFmpeg encoder; audio is an FFmpeg filtergraph mix; output is staged next to the
 * destination and renamed into place on success.
 */
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import path from 'node:path'
import { timelineById, type Doc } from '../../core/ops/context'
import type { Timeline } from '../../core/model'
import { audioPieces, denoiseRefs, withDenoise, type AudioPiece } from '../../renderer/render/audioPlan'
import { compositionFrames, mediaLayers, Planner, type MediaMap } from '../../renderer/render/plan'
import type { ExportFormat, ExportJob, ExportOptions } from '../../shared/api'
import { ffmpeg } from '../media/ffmpeg'
import { ffprobeJson } from '../media/probe'
import type { ProjectSession } from '../project/session'
import { buildMediaMap } from '../render/mediaMap'
import type { HostRenderService } from '../render/renderService'
import type { ExportService } from '../services'
import { buildMixGraph, mixArgs } from './audioMix'
import { gifEncodeArgs, gifIntermediateArgs, gifPaletteArgs, isHdrCodec, outputSize, videoCodecFor, videoEncoderArgs } from './encoders'
import { exportInterchange } from '../interchange/exportInterchange'
import { exportPalmierPackage } from './palmierExport'

const FORMATS: ExportFormat[] = ['mp4', 'mov', 'webm', 'gif', 'm4a', 'wav', 'png', 'fcpxml', 'xml', 'palmier']
const QUALITIES = new Set(['low', 'medium', 'high', 'max'])
const VIDEO = new Set<ExportFormat>(['mp4', 'mov', 'webm', 'gif'])

interface JobState {
  job: ExportJob
  session: ProjectSession
  doc: Doc
  abort: AbortController
  cancelRender: (() => void) | null
  waiters: ((j: ExportJob) => void)[]
}

const isTerminal = (s: ExportJob['status']) => s === 'completed' || s === 'failed' || s === 'cancelled'
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

function validate(o: ExportOptions, doc: Doc): ExportOptions {
  if (!o || typeof o !== 'object') throw new Error('Export options are required.')
  if (!FORMATS.includes(o.format)) throw new Error(`Unknown export format "${String(o.format)}".`)
  if (typeof o.outputPath !== 'string' || !path.isAbsolute(o.outputPath)) throw new Error('outputPath must be an absolute path.')
  if (o.format !== 'palmier' && !timelineById(doc, o.timelineId)) throw new Error(`Timeline ${o.timelineId} not found.`)
  for (const k of ['width', 'height'] as const) {
    const v = o[k]
    if (v !== undefined && !(finite(v) && v >= 2 && v <= 16384)) throw new Error(`${k} must be between 2 and 16384.`)
  }
  if (o.fps !== undefined && !(finite(o.fps) && o.fps >= 1 && o.fps <= 240)) throw new Error('fps must be between 1 and 240.')
  if (isHdrCodec(o.codec) && o.format !== 'mov') throw new Error('HEVC 10-bit HDR exports to QuickTime (.mov) only.')
  if (o.quality !== undefined && !QUALITIES.has(o.quality)) throw new Error('quality must be low, medium, high or max.')
  if (o.range !== undefined) {
    const { start, end } = o.range
    if (!(Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start)) throw new Error('range must be integer frames with 0 ≤ start < end.')
  }
  return { ...o, outputPath: path.resolve(o.outputPath) }
}

const tail = (e: unknown) => (e instanceof Error ? e.message : String(e))

async function rmQuiet(p: string): Promise<void> {
  await fs.rm(p, { recursive: true, force: true }).catch(() => undefined)
}

/** The denoise bake service (main/ml/audio/denoise.ts) as export needs it. */
export interface ExportDenoise {
  bake(mediaRef: string, file: string): Promise<string>
}

export interface ExportServiceOptions {
  /** Bakes missing denoise wet files before the audio mix (ExportService.swift); absent = dry only. */
  denoise?: ExportDenoise
}

/** Rejects as soon as `signal` aborts (the shared bake keeps running for preview). */
function untilAborted<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('aborted'))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('aborted'))
    signal.addEventListener('abort', onAbort, { once: true })
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

export function createExportService(
  render: HostRenderService,
  opts: ExportServiceOptions = {},
): Required<ExportService> & { dispose(): void } {
  const jobs = new Map<string, JobState>()
  const queue: string[] = []
  let active: string | null = null
  let disposed = false
  const events = new EventEmitter()
  const channelCache = new Map<string, Promise<number>>()

  const snapshot = (s: JobState): ExportJob => ({ ...s.job, options: { ...s.job.options } })
  const emit = (s: JobState) => events.emit('progress', snapshot(s))

  function channels(file: string): Promise<number> {
    let p = channelCache.get(file)
    if (!p) {
      p = ffprobeJson(file)
        .then((info) => {
          const a = info.streams.find((x) => x.codec_type === 'audio') as { channels?: number } | undefined
          return a ? Math.max(1, a.channels ?? 2) : 0
        })
        .catch(() => 0)
      channelCache.set(file, p)
    }
    return p
  }

  function finish(s: JobState, status: ExportJob['status'], error?: string): void {
    s.job.status = status
    s.job.finishedAt = new Date().toISOString()
    if (error) s.job.error = error
    if (status === 'completed') s.job.progress = 1
    emit(s)
    for (const w of s.waiters.splice(0)) w(snapshot(s))
  }

  function pump(): void {
    if (active || disposed) return
    const id = queue.shift()
    if (!id) return
    const s = jobs.get(id)
    if (!s || s.job.status !== 'queued') return pump()
    active = id
    s.job.status = 'running'
    emit(s)
    void run(s)
      .then(
        () => finish(s, 'completed'),
        (e) => finish(s, s.abort.signal.aborted ? 'cancelled' : 'failed', s.abort.signal.aborted ? 'Export cancelled.' : tail(e)),
      )
      .finally(() => {
        active = null
        pump()
      })
  }

  function progress(s: JobState, frames: number, fraction: number): void {
    s.job.framesRendered = frames
    s.job.progress = Math.min(0.999, Math.max(0, fraction))
    emit(s)
  }

  function stagingPath(dest: string, suffix: string): string {
    const ext = path.extname(dest)
    return path.join(path.dirname(dest), `.${path.basename(dest, ext)}-${randomUUID().toUpperCase()}.${suffix}${ext}`)
  }

  async function mixAudio(s: JobState, tl: Timeline, media: MediaMap, range: { start: number; end: number }, durationSec: number, codecArgs: string[], output: string, allowSilence: boolean): Promise<boolean> {
    const dry = audioPieces(tl, { fps: tl.fps, timelines: s.doc.file.timelines, media: (id) => media[id] })
    const wet = await bakeDenoise(s, dry)
    const pieces = withDenoise(dry, (ref) => wet.get(ref))
    const counts = new Map<string, number>()
    for (const p of pieces) if (!counts.has(p.path)) counts.set(p.path, await channels(p.path))
    const graph = buildMixGraph(pieces, { start: range.start, end: range.end, fps: tl.fps, durationSec }, (p) => counts.get(p) ?? 0)
    if (!graph && !allowSilence) return false
    await ffmpeg(mixArgs(graph, durationSec, codecArgs, output), { signal: s.abort.signal })
    return true
  }

  /**
   * Bakes the wet file of every denoised top-level clip first (ExportService.swift): a failed bake logs and
   * exports that clip's original audio; cancelling the export stops waiting.
   */
  async function bakeDenoise(s: JobState, pieces: AudioPiece[]): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    const d = opts.denoise
    if (!d) return out
    for (const ref of denoiseRefs(pieces)) {
      if (s.abort.signal.aborted) throw new Error('Export cancelled.')
      const file = s.session.resolveMedia(ref)
      if (!file || !existsSync(file)) continue
      try {
        out.set(ref, await untilAborted(d.bake(ref, file), s.abort.signal))
      } catch (e) {
        if (s.abort.signal.aborted) throw e
        console.warn(`[export] denoise bake failed — exporting original audio. mediaRef=${ref}: ${tail(e)}`)
      }
    }
    return out
  }

  function offlineWarning(tl: Timeline, media: MediaMap, doc: Doc, range: { start: number; end: number }): string[] {
    const planner = new Planner({ fps: tl.fps, timelines: doc.file.timelines, media: (id) => media[id], offlinePlaceholders: true })
    const missing = new Set<string>()
    const step = Math.max(1, Math.floor((range.end - range.start) / 200))
    for (let f = range.start; f < range.end; f += step) for (const l of mediaLayers(planner.layersAt(tl, f, tl.width, tl.height))) if (l.offline) missing.add(l.sourceId)
    return missing.size ? [`${missing.size} media file(s) are offline and were left out of the export.`] : []
  }

  async function run(s: JobState): Promise<void> {
    const o = s.job.options
    const dest = o.outputPath
    await fs.mkdir(path.dirname(dest), { recursive: true })
    if (o.format === 'palmier') {
      const res = await exportPalmierPackage(s.doc, s.session.path, (e) => s.session.resolveMedia(e), dest, s.abort.signal, (f) => progress(s, 0, f))
      if (res.missing) s.job.warnings = [`${res.missing} media file(s) were missing and could not be included.`]
      return
    }
    if (o.format === 'fcpxml' || o.format === 'xml') {
      const res = await exportInterchange(
        { doc: s.doc, resolveMedia: (id) => s.session.resolveMedia(id) },
        { timelineId: o.timelineId, format: o.format, outputPath: dest, fcpxmlVersion: o.fcpxmlVersion, fcpxmlTarget: o.fcpxmlTarget, signal: s.abort.signal },
      )
      if (res.missingMediaRefs.length) s.job.warnings = [`${res.missingMediaRefs.length} media file(s) are offline; their clips were left out.`]
      return
    }
    const tl = timelineById(s.doc, o.timelineId)!
    const media = await buildMediaMap(s.session)
    const N = compositionFrames(tl)
    const range = o.range ? { start: o.range.start, end: o.range.end } : { start: 0, end: N }
    if (range.end <= range.start) throw new Error('Nothing to export: the timeline is empty.')
    const outFps = o.fps ?? tl.fps
    const frameCount = Math.max(1, Math.round(((range.end - range.start) * outFps) / tl.fps))
    const durationSec = frameCount / outFps
    s.job.totalFrames = o.format === 'png' ? 1 : frameCount
    const warnings = offlineWarning(tl, media, s.doc, range)
    if (warnings.length) s.job.warnings = warnings
    emit(s)
    const temps: string[] = []
    try {
      if (o.format === 'png') {
        const { width } = outputSize(o, tl.width, tl.height, false)
        const png = await render.captureFrame(s.session, { timelineId: tl.id, frame: range.start, width, format: 'png' })
        const tmp = stagingPath(dest, 'partial')
        temps.push(tmp)
        await fs.writeFile(tmp, png)
        await fs.rename(tmp, dest)
        return
      }
      if (o.format === 'm4a' || o.format === 'wav') {
        const tmp = stagingPath(dest, 'partial')
        temps.push(tmp)
        const codec = o.format === 'm4a' ? ['-c:a', 'aac', '-b:a', '192k', '-f', 'ipod'] : ['-c:a', 'pcm_s16le', '-f', 'wav']
        await mixAudio(s, tl, media, range, durationSec, codec, tmp, true)
        await verify(tmp)
        await fs.rename(tmp, dest)
        return
      }
      if (!VIDEO.has(o.format)) throw new Error(`Unsupported format ${o.format}`)
      const size = outputSize(o, tl.width, tl.height)
      const isGif = o.format === 'gif'
      let audioPath: string | null = null
      if (!isGif && o.includeAudio !== false) {
        const mix = stagingPath(dest, 'mix').replace(/\.[^.]+$/, '.wav')
        temps.push(mix)
        if (await mixAudio(s, tl, media, range, durationSec, ['-c:a', 'pcm_f32le', '-f', 'wav'], mix, false)) audioPath = mix
      }
      if (s.abort.signal.aborted) throw new Error('cancelled')
      const tmp = stagingPath(dest, 'partial')
      temps.push(tmp)
      const encodeTarget = isGif ? stagingPath(dest, 'frames').replace(/\.[^.]+$/, '.mkv') : tmp
      if (isGif) temps.push(encodeTarget)
      const args = isGif
        ? gifIntermediateArgs(size.width, size.height, outFps, encodeTarget)
        : videoEncoderArgs({ format: o.format, codec: o.codec, width: size.width, height: size.height, fps: outFps, quality: o.quality, audioPath, output: tmp })
      if (!isGif && !videoCodecFor(o.format, o.codec)) throw new Error(`No video codec for ${o.format}`)
      const handle = render.renderVideo(
        { jobId: s.job.id, doc: s.doc, timelineId: tl.id, media, startFrame: range.start, frameCount, outFps, width: size.width, height: size.height, ffmpegArgs: args },
        (n) => progress(s, n, (n / frameCount) * (isGif ? 0.85 : 0.98)),
      )
      s.cancelRender = handle.cancel
      if (s.abort.signal.aborted) handle.cancel()
      await handle.done
      s.cancelRender = null
      if (isGif) {
        const palette = stagingPath(dest, 'palette').replace(/\.[^.]+$/, '.png')
        temps.push(palette)
        await ffmpeg(gifPaletteArgs(encodeTarget, palette), { signal: s.abort.signal })
        progress(s, frameCount, 0.92)
        await ffmpeg(gifEncodeArgs(encodeTarget, palette, tmp), { signal: s.abort.signal })
      }
      await verify(tmp)
      if (s.abort.signal.aborted) throw new Error('cancelled')
      await fs.rename(tmp, dest)
    } finally {
      s.cancelRender = null
      await Promise.all(temps.map(rmQuiet))
    }
  }

  async function verify(file: string): Promise<void> {
    const st = await fs.stat(file).catch(() => null)
    if (!st || st.size === 0) throw new Error('The encoder produced no output.')
    await ffprobeJson(file).catch((e) => {
      throw new Error(`The exported file is unreadable: ${tail(e)}`)
    })
  }

  return {
    start(session: ProjectSession, options: ExportOptions): ExportJob {
      if (disposed) throw new Error('The export service is shut down.')
      const doc = session.doc
      const o = validate(options, doc)
      for (const s of jobs.values()) {
        if (!isTerminal(s.job.status) && s.job.outputPath === o.outputPath) throw new Error(`An export to ${path.basename(o.outputPath)} is already waiting or in progress.`)
      }
      const job: ExportJob = {
        id: randomUUID().toUpperCase(),
        options: o,
        status: 'queued',
        progress: 0,
        framesRendered: 0,
        totalFrames: 0,
        startedAt: new Date().toISOString(),
        outputPath: o.outputPath,
        projectPath: session.path,
      }
      const s: JobState = { job, session, doc, abort: new AbortController(), cancelRender: null, waiters: [] }
      jobs.set(job.id, s)
      queue.push(job.id)
      emit(s)
      queueMicrotask(pump)
      return snapshot(s)
    },

    get(jobId: string) {
      const s = jobs.get(jobId)
      return s ? snapshot(s) : undefined
    },

    list() {
      return [...jobs.values()].map(snapshot)
    },

    cancel(jobId: string) {
      const s = jobs.get(jobId)
      if (!s || isTerminal(s.job.status)) return
      s.abort.abort()
      if (s.job.status === 'queued') {
        const i = queue.indexOf(jobId)
        if (i >= 0) queue.splice(i, 1)
        finish(s, 'cancelled', 'Export cancelled.')
        return
      }
      s.cancelRender?.()
    },

    /** ExportQueue.remove: drops one finished job from the list (no-op while it is waiting or running). Returns the dropped ids. */
    remove(jobId: string) {
      const s = jobs.get(jobId)
      if (!s || !isTerminal(s.job.status)) return []
      jobs.delete(jobId)
      return [jobId]
    },

    /** ExportQueue.clearFinished: drops every finished job of one project (all projects when omitted). */
    clearFinished(projectPath?: string) {
      const ids: string[] = []
      for (const [id, s] of jobs) if (isTerminal(s.job.status) && (projectPath === undefined || s.job.projectPath === projectPath)) ids.push(id)
      for (const id of ids) jobs.delete(id)
      return ids
    },

    wait(jobId: string) {
      const s = jobs.get(jobId)
      if (!s) return Promise.reject(new Error(`Unknown export job ${jobId}`))
      if (isTerminal(s.job.status)) return Promise.resolve(snapshot(s))
      return new Promise<ExportJob>((resolve) => s.waiters.push(resolve))
    },

    on(event: 'progress', cb: (job: ExportJob) => void) {
      events.on(event, cb)
    },

    dispose() {
      disposed = true
      for (const s of jobs.values()) {
        if (isTerminal(s.job.status)) continue
        s.abort.abort()
        s.cancelRender?.()
        if (s.job.status === 'queued') finish(s, 'cancelled', 'Export cancelled.')
      }
      queue.length = 0
    },
  }
}
