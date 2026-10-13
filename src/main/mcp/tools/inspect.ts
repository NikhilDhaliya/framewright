/** Visual inspection tools: inspect_timeline (composited frames), inspect_media (assets) and capture_frame. */
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Clip, MediaManifestEntry, Timeline } from '../../../core/model'
import { activeTimeline } from '../../../core/ops/context'
import { endFrame } from '../../../core/clip'
import { totalFrames } from '../../../core/timeline'
import { ffmpeg } from '../../media/ffmpeg'
import { ToolError, decodeArgs, lenient, opt, validateUnknownKeys, type Obj } from './args'
import { image, ok, okJson, type Block, type ToolEnv, type ToolResult } from './context'
import { jsonString, round3, swiftDouble } from './json'
import { blit, chipLabel, decodeRgba, encodeImage, fitWithin, imageSize, overlayGrid, type Rgba, type Size } from './images'
import { isPending, truncatedPrompt } from './media'
import { parseSubtitleFile } from './subtitles'
import { lottieFileMeta } from '../../media/lottie'
import { LOTTIE_THUMBNAIL_SIDE, lottieSampleIndices } from '../../../shared/lottie'
import { inspectTranscript, parseLanguage, transcriptionMeta } from './transcription'
import { captureFrameToMedia } from '../../extras/captureFrame'
import type { FrameCaptureSource } from '../../../shared/extras'

const GRID_NOTE = '0-1, origin top-left'

/** Encoded frame → grid overlay (+ caption) → JPEG. */
async function gridJpeg(png: Buffer, size: Size, caption?: string): Promise<Buffer> {
  return encodeImage(overlayGrid(await decodeRgba(png, { size }), caption), 'jpeg', 0.7)
}

// ---------- inspect_timeline ----------

export function visibleClips(t: Timeline, frame: number): string[] {
  const ids: string[] = []
  const groups = new Set<string>()
  for (const tr of t.tracks) {
    if (tr.type !== 'video' || tr.hidden) continue
    for (const c of tr.clips) {
      if (!(c.startFrame <= frame && frame < endFrame(c))) continue
      if (c.captionGroupId) {
        if (!groups.has(c.captionGroupId)) {
          groups.add(c.captionGroupId)
          ids.push(c.captionGroupId)
        }
      } else ids.push(c.id)
    }
  }
  return ids
}

export async function inspectTimeline(env: ToolEnv, args: Obj): Promise<ToolResult> {
  validateUnknownKeys(args, ['startFrame', 'endFrame', 'maxFrames'], 'inspect_timeline')
  const t = activeTimeline(env.session.doc)
  const total = totalFrames(t)
  if (total <= 0) throw new ToolError('Timeline is empty — nothing to render.')
  const start = lenient.int(args, 'startFrame') ?? 0
  if (!(start >= 0 && start < total)) throw new ToolError(`startFrame ${start} out of range [0, ${total}).`)
  let frames = [start]
  const rawEnd = lenient.int(args, 'endFrame')
  if (rawEnd !== undefined && rawEnd !== 0) {
    const end = Math.min(rawEnd, total)
    if (!(end > start)) throw new ToolError(`endFrame must be greater than startFrame (${start}).`)
    const span = end - start
    const count = Math.max(1, Math.min(lenient.int(args, 'maxFrames') ?? 6, 12, span))
    frames = Array.from({ length: count }, (_, i) => start + Math.floor((span * (i + 0.5)) / count))
  }
  if (!t.tracks.some((tr) => tr.type !== 'audio')) throw new ToolError('No video track available in timeline.')
  const size = fitWithin({ width: t.width, height: t.height }, 512)
  const blocks: Block[] = []
  const rendered: number[] = []
  for (const frame of frames) {
    try {
      const png = await env.app.render.captureFrame(env.session, { timelineId: t.id, frame, width: size.width, format: 'png' })
      blocks.push(image(await gridJpeg(png, imageSize(png) ?? size, `f${frame}`), 'image/jpeg'))
      rendered.push(frame)
    } catch {
      continue
    }
  }
  if (!blocks.length) throw new ToolError('Failed to render timeline frames.')
  const meta = { fps: t.fps, width: size.width, height: size.height, totalFrames: total, coordinateGrid: GRID_NOTE, frames: rendered.map((frame) => ({ frame, clips: visibleClips(t, frame) })) }
  return { content: [...blocks, ok(jsonString(meta)).content[0]] }
}

// ---------- capture_frame ----------

export async function captureFrame(env: ToolEnv, args: Obj): Promise<ToolResult> {
  const input = decodeArgs<{ timelineFrame?: number; mediaRef?: string; sourceSeconds?: number; name?: string }>(args, 'capture_frame', {
    timelineFrame: opt('Int'),
    mediaRef: opt('String'),
    sourceSeconds: opt('Double'),
    name: opt('String'),
  })
  const usesTimeline = input.timelineFrame !== undefined
  const usesMedia = input.mediaRef !== undefined || input.sourceSeconds !== undefined
  if (usesTimeline === usesMedia) throw new ToolError('Provide exactly one capture mode: timelineFrame, or mediaRef with sourceSeconds.')
  const name = input.name?.trim()
  if (name !== undefined) {
    if (!name) throw new ToolError('name must not be empty.')
    if ([...name].length > 200) throw new ToolError('name must be 200 characters or fewer.')
  }
  if (usesMedia && (input.mediaRef === undefined || input.sourceSeconds === undefined)) throw new ToolError('mediaRef and sourceSeconds are both required for a source-video capture.')
  // Shared with the preview's camera button (spec 07 §6.4): src/main/extras/captureFrame.ts.
  const source: FrameCaptureSource = usesTimeline ? { kind: 'timeline', frame: input.timelineFrame! } : { kind: 'media', mediaRef: input.mediaRef!, sourceSeconds: input.sourceSeconds! }
  const receipt = await captureFrameToMedia(env.app, env.session, source, { name })
  const capturedFrom: Obj =
    source.kind === 'timeline' ? { timelineFrame: source.frame, ...(receipt.timelineId ? { timelineId: receipt.timelineId } : {}) } : { mediaRef: source.mediaRef, sourceSeconds: source.sourceSeconds }
  if (receipt.actualSourceSeconds !== undefined) capturedFrom.actualSourceSeconds = receipt.actualSourceSeconds
  return okJson({ status: 'ready', mediaRef: receipt.asset.id, name: receipt.asset.name, type: 'image', mimeType: 'image/png', width: receipt.width, height: receipt.height, capturedFrom })
}

// ---------- inspect_media ----------

function baseMeta(entry: MediaManifestEntry, file: string): Obj {
  const meta: Obj = { id: entry.id, name: entry.name, type: entry.type, durationSeconds: round3(entry.duration), fileName: path.basename(file) }
  if (isPending(entry.generationStatus)) meta.generationStatus = entry.generationStatus
  if (entry.sourceWidth !== undefined) meta.width = entry.sourceWidth
  if (entry.sourceHeight !== undefined) meta.height = entry.sourceHeight
  if (entry.sourceFPS !== undefined) meta.fps = entry.sourceFPS
  const prompt = truncatedPrompt((entry.generationInput as Obj | undefined)?.prompt)
  if (prompt) meta.prompt = prompt
  return meta
}

const exists = (p: string) =>
  fs.access(p).then(
    () => true,
    () => false,
  )

const MAX_INLINE_BYTES = 3.5 * 1024 * 1024

async function inspectImage(env: ToolEnv, entry: MediaManifestEntry, file: string): Promise<ToolResult> {
  const original = await env.app.media.extractFrame(file, 0, { format: 'png' }).catch(() => null)
  const sourceSize = original ? imageSize(original) : null
  if (!original || !sourceSize) throw new ToolError('Failed to read or decode image file')
  const overlaid = overlayGrid(await decodeRgba(original, { size: fitWithin(sourceSize, 1568) }))
  const alpha = (await env.app.media.probe(file).catch(() => null))?.hasAlpha === true
  let encoded: Buffer | null = alpha ? await encodeImage(overlaid, 'png') : null
  let mime = 'image/png'
  if (!encoded || encoded.length > MAX_INLINE_BYTES) {
    mime = 'image/jpeg'
    for (const q of [0.85, 0.7, 0.55, 0.4, 0.25]) {
      encoded = await encodeImage(overlaid, 'jpeg', q)
      if (encoded.length <= MAX_INLINE_BYTES) break
    }
  }
  const meta = baseMeta(entry, file)
  meta.mimeType = mime
  meta.byteSize = (await fs.stat(file)).size
  meta.encodedByteSize = encoded!.length
  meta.coordinateGrid = GRID_NOTE
  meta.imageProperties = { pixelWidth: sourceSize.width, pixelHeight: sourceSize.height }
  return { content: [image(encoded!, mime), okJson(meta).content[0]] }
}

function timeLabel(s: number): string {
  const total = Math.floor(s)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const sec = String(total % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

/** One storyboard of visually distinct moments: 16×16 luma change > 12 keeps a tile, at most 36 tiles. */
async function overview(env: ToolEnv, file: string, start: number, end: number): Promise<{ jpeg: Buffer; timestamps: number[] }> {
  const span = end - start
  const interval = Math.max(1, span / 120)
  const luma = await ffmpeg(['-ss', String(start), '-t', String(span), '-i', file, '-an', '-vf', `fps=1/${interval},scale=16:16,format=gray`, '-f', 'rawvideo', 'pipe:1']).catch(() => {
    throw new ToolError('Overview failed: Could not decode frames for overview')
  })
  const count = Math.floor(luma.length / 256)
  if (!count) throw new ToolError('Overview failed: Window too short for a overview')
  let kept: number[] = []
  let last: Buffer | null = null
  for (let i = 0; i < count; i++) {
    const tile = luma.subarray(i * 256, i * 256 + 256)
    let diff = 0
    if (last) for (let p = 0; p < 256; p++) diff += Math.abs(tile[p] - last[p])
    if (!last || diff / 256 > 12) {
      kept.push(Math.min(end, start + i * interval))
      last = tile
    }
  }
  if (kept.length > 36) kept = Array.from({ length: 36 }, (_, i) => kept[Math.floor((i * kept.length) / 36)])
  const [tw, th, cols] = [160, 90, 6]
  const rows = Math.ceil(kept.length / cols)
  const sheet: Rgba = { width: tw * cols, height: th * rows, data: Buffer.alloc(tw * cols * th * rows * 4) }
  const timestamps: number[] = []
  for (const ts of kept) {
    const png = await env.app.media.extractFrame(file, ts, { format: 'png' }).catch(() => null)
    if (!png) continue
    const tile = await decodeRgba(png, { size: { width: tw, height: th } }).catch(() => null)
    if (!tile) continue
    const n = timestamps.length
    const x = (n % cols) * tw
    const y = Math.floor(n / cols) * th
    blit(sheet, tile, x, y)
    chipLabel(sheet, timeLabel(ts), x + 2, y + th - 13, 1)
    timestamps.push(ts)
  }
  if (!timestamps.length) throw new ToolError('Overview failed: Could not decode frames for overview')
  const usedRows = Math.ceil(timestamps.length / cols)
  const cropped: Rgba = { width: sheet.width, height: usedRows * th, data: sheet.data.subarray(0, sheet.width * usedRows * th * 4) }
  return { jpeg: await encodeImage(cropped, 'jpeg', 0.7).catch(() => {
    throw new ToolError('Overview failed: Failed to compose overview')
  }), timestamps }
}

function sourceRange(args: Obj, duration: number): [number, number] | null {
  const start = lenient.double(args, 'startSeconds')
  const end = lenient.double(args, 'endSeconds')
  if (start === undefined && end === undefined) return null
  const s = Math.max(start ?? 0, 0)
  const e = Math.min(end ?? duration, duration)
  if (!(s < e)) throw new ToolError(`Invalid time range [${swiftDouble(s)}, ${swiftDouble(e)}] for media of duration ${swiftDouble(duration)}s`)
  return [s, e]
}


function mappingMeta(env: ToolEnv, clipId: string | undefined): Obj | null {
  if (!clipId) return null
  const t = activeTimeline(env.session.doc)
  const c = t.tracks.flatMap((tr) => tr.clips).find((x) => x.id === clipId)!
  return { clipId, clipStartFrame: c.startFrame, clipEndFrame: endFrame(c), fps: t.fps, note: 'transcription segments/words are project frames for this clip; out-of-range entries are dropped.' }
}

/** The clip (and project fps) transcript rows are mapped through when `clipId` is set. */
function clipMapping(env: ToolEnv, clipId: string | undefined): { clip: Clip; fps: number } | null {
  if (!clipId) return null
  const t = activeTimeline(env.session.doc)
  const clip = t.tracks.flatMap((tr) => tr.clips).find((x) => x.id === clipId)
  return clip ? { clip, fps: t.fps } : null
}

async function inspectVideo(env: ToolEnv, entry: MediaManifestEntry, file: string, args: Obj, clipId: string | undefined, locale: string | undefined): Promise<ToolResult> {
  if (!(entry.duration > 0)) throw new ToolError(`Video has zero duration: ${entry.name}`)
  const range = sourceRange(args, entry.duration)
  const [s, e] = range ?? [0, entry.duration]
  const meta = baseMeta(entry, file)
  meta.hasAudio = entry.hasAudio ?? false
  if (range) meta.timeRange = range
  // Visuals and transcription run concurrently; a transcription failure is not fatal.
  const transcript = entry.hasAudio
    ? inspectTranscript(env, file, true, range, locale).then(
        (r) => ({ ok: true as const, r }),
        (err: unknown) => ({ ok: false as const, message: err instanceof Error ? err.message : String(err) }),
      )
    : null
  let blocks: Block[]
  if (lenient.bool(args, 'overview') === true) {
    const sheet = await overview(env, file, s, e)
    meta.overview = { tileTimestamps: sheet.timestamps.map(round3) }
    blocks = [image(sheet.jpeg, 'image/jpeg')]
  } else {
    const probe = await env.app.media.probe(file).catch(() => null)
    if (probe && !probe.hasVideo) throw new ToolError(`No video track available in ${entry.name}`)
    const count = Math.max(1, Math.min(lenient.int(args, 'maxFrames') ?? 6, 12))
    const target = entry.sourceWidth && entry.sourceHeight ? fitWithin({ width: entry.sourceWidth, height: entry.sourceHeight }, 512) : { width: 512, height: 288 }
    blocks = []
    const timestamps: number[] = []
    for (let i = 0; i < count; i++) {
      const ts = s + ((e - s) * (i + 0.5)) / count
      try {
        const png = await env.app.media.extractFrame(file, ts, { width: target.width, format: 'png' })
        blocks.push(image(await gridJpeg(png, imageSize(png) ?? target), 'image/jpeg'))
        timestamps.push(ts)
      } catch {
        continue
      }
    }
    if (!blocks.length) throw new ToolError(`Failed to extract frames from ${entry.name}`)
    meta.frameTimestamps = timestamps.map(round3)
    meta.coordinateGrid = GRID_NOTE
  }
  const outcome = await transcript
  if (outcome?.ok) meta.transcription = transcriptionMeta(outcome.r, clipMapping(env, clipId), lenient.bool(args, 'wordTimestamps') ?? false)
  else if (outcome) meta.transcriptionError = outcome.message
  const mapping = mappingMeta(env, clipId)
  if (mapping) meta.timelineMapping = mapping
  return { content: [...blocks, okJson(meta).content[0]] }
}

async function inspectAudio(env: ToolEnv, entry: MediaManifestEntry, file: string, args: Obj, clipId: string | undefined, locale: string | undefined): Promise<ToolResult> {
  const range = sourceRange(args, entry.duration)
  let r
  try {
    r = await inspectTranscript(env, file, false, range, locale)
  } catch (err) {
    throw new ToolError(`Transcription failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  const meta = baseMeta(entry, file)
  if (range) meta.timeRange = range
  Object.assign(meta, transcriptionMeta(r, clipMapping(env, clipId), lenient.bool(args, 'wordTimestamps') ?? false))
  const mapping = mappingMeta(env, clipId)
  if (mapping) meta.timelineMapping = mapping
  return okJson(meta)
}

/** `readLottie`: `maxFrames` frames sampled evenly, fit-within 512, over 50% grey, with the grid, JPEG 0.7. */
async function inspectLottie(env: ToolEnv, entry: MediaManifestEntry, file: string, args: Obj): Promise<ToolResult> {
  const count = Math.max(1, Math.min(lenient.int(args, 'maxFrames') ?? 6, 12))
  const failed = () => new ToolError(`Failed to render Lottie frames from ${entry.name}`)
  const lottie = await lottieFileMeta(file).catch(() => {
    throw failed()
  })
  const indices = lottieSampleIndices(lottie.frameCount, count)
  const pngs = (await env.app.render.lottieFrames?.(file, { frames: indices, maxSide: LOTTIE_THUMBNAIL_SIDE, background: '#808080' }).catch(() => null)) ?? []
  if (!pngs.length) throw failed()
  const blocks: Block[] = []
  const sampled: number[] = []
  for (const [i, png] of pngs.entries()) {
    const size = imageSize(png)
    if (!size) continue
    try {
      blocks.push(image(await encodeImage(overlayGrid(await decodeRgba(png, { size })), 'jpeg', 0.7), 'image/jpeg'))
      sampled.push(indices[i])
    } catch {
      continue
    }
  }
  if (!blocks.length) throw new ToolError('Failed to encode Lottie frames')
  const meta = baseMeta(entry, file)
  meta.framerate = lottie.fps
  meta.frameCount = lottie.frameCount
  meta.durationSeconds = lottie.duration
  meta.sampledFrameIndices = sampled
  meta.coordinateGrid = GRID_NOTE
  meta.note = 'Lottie frames sampled evenly across the animation; transparent areas composited over gray.'
  return { content: [...blocks, okJson(meta).content[0]] }
}

async function inspectSubtitle(entry: MediaManifestEntry, file: string): Promise<ToolResult> {
  const cues = await parseSubtitleFile(file).catch((e: Error) => {
    throw new ToolError(`Failed to parse subtitle file: ${e.message}`)
  })
  const meta = baseMeta(entry, file)
  meta.cueCount = cues.length
  if (cues.length > 500) meta.note = `Showing the first 500 of ${cues.length} cues.`
  meta.cues = cues.slice(0, 500).map((c) => ({ startSeconds: c.startSeconds, endSeconds: c.endSeconds, text: c.text }))
  return okJson(meta)
}

export async function inspectMedia(env: ToolEnv, args: Obj): Promise<ToolResult> {
  validateUnknownKeys(args, ['mediaRef', 'clipId', 'maxFrames', 'startSeconds', 'endSeconds', 'wordTimestamps', 'overview', 'language'], 'inspect_media')
  const mediaRef = lenient.requireString(args, 'mediaRef')
  const doc = env.session.doc
  const entry = doc.manifest.entries.find((e) => e.id === mediaRef)
  if (!entry) throw new ToolError(`Media asset not found: ${mediaRef}`)
  const file = env.session.resolveMedia(entry)
  if (!file || !(await exists(file))) {
    const status = entry.generationStatus
    if (status?.startsWith('failed: ')) throw new ToolError(`Asset ${entry.id} failed: ${status.slice('failed: '.length)}`)
    if (isPending(status)) throw new ToolError(`Asset ${entry.id} is still ${status}. Poll get_media and retry once generationStatus becomes 'none'.`)
    throw new ToolError(`Media file not on disk: ${path.basename(file ?? entry.name)}`)
  }
  const clipId = lenient.string(args, 'clipId')
  if (clipId) {
    const clip = activeTimeline(doc).tracks.flatMap((tr) => tr.clips).find((c) => c.id === clipId)
    if (!clip) throw new ToolError(`Clip not found: ${clipId}`)
    if (clip.mediaRef !== mediaRef) throw new ToolError(`Clip ${clipId} does not reference mediaRef ${mediaRef} (it references ${clip.mediaRef})`)
  }
  const locale = parseLanguage(args, 'inspect_media')
  switch (entry.type) {
    case 'image':
      return inspectImage(env, entry, file)
    case 'video':
      return inspectVideo(env, entry, file, args, clipId, locale)
    case 'audio':
      return inspectAudio(env, entry, file, args, clipId, locale)
    case 'lottie':
      return inspectLottie(env, entry, file, args)
    case 'subtitle':
      return inspectSubtitle(entry, file)
    case 'text':
      throw new ToolError('Text clips are not stored as media assets.')
    case 'sequence':
      throw new ToolError('Sequences are timelines, not media assets. Use get_timeline.')
  }
}

