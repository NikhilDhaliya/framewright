/**
 * Renderer side of the caption pipeline (spec 07 §1.7; Mac `EditorViewModel+Captions.swift`): resolve targets,
 * transcribe each distinct media file through main, check freshness, then build specs with the compositor's own
 * text measurer and place them as one undo step ("Generate Captions").
 */
import type { TextAnimation, TextStyle, Timeline } from '@core/model'
import type { Doc } from '@core/ops/context'
import { totalFrames } from '@core/timeline'
import { buildCaptionSpecs, CAPTION_MAX_TEXT_WIDTH_RATIO, type CaptionCase } from '@core/captions/specBuilder'
import { captionTargetsForIds, captionTargetsForTracks, captionUsesVideoAudio, dominantSpeechTrack, locateTargets, type CaptionTarget, type TargetContext } from '@core/captions/targets'
import { makeTimelineTranscriptDocument, type TimelineTranscriptDocument } from '@core/captions/timelineTranscript'
import { sourceUnion } from '@core/captions/transcriptMapper'
import type { TranscriptionResult } from '@core/captions/transcript'
import type { TranscriptionProgress } from '../../../shared/api'
import { textMeasurer } from '../../render/text'
import { getBaseDoc, timelineOf } from '../../state/project'
import { runOp } from '../../state/ops'
import { tk, tx } from '../../i18n'

export interface CaptionRequest {
  /** [] = automatic. */
  sourceClipIds: string[]
  autoDetect: boolean
  style: TextStyle
  center: { x: number; y: number }
  textCase: CaptionCase
  censorProfanity: boolean
  locale?: string
  maxWords?: number
  maxCharacters?: number
  maximumGapSeconds: number
  provider: 'local' | 'cloud'
  animation?: TextAnimation
}

export class CaptionError extends Error {}
export const NO_SOURCE = tk('No audio clips to caption.')
export const TIMELINE_CHANGED = tk('The timeline changed while captions were being prepared. Try again.')

export const targetContext = (doc: Doc): TargetContext => ({ timeline: timelineOf(doc)!, assets: doc.manifest.entries, multicamGroups: doc.file.multicamGroups ?? [] })

/** `resolvedCaptionTargets`: Auto = every captionable clip; otherwise the given clip ids. */
export function resolvedTargets(doc: Doc, req: Pick<CaptionRequest, 'autoDetect' | 'sourceClipIds'>): CaptionTarget[] {
  const ctx = targetContext(doc)
  const clips = req.autoDetect ? captionTargetsForIds(ctx, []) : captionTargetsForIds(ctx, req.sourceClipIds)
  return locateTargets(ctx.timeline, clips)
}

export const trackTargets = (doc: Doc, trackId: string) => captionTargetsForTracks(targetContext(doc), [trackId])

interface Prepared {
  timeline: Timeline
  targets: CaptionTarget[]
  results: Map<string, TranscriptionResult>
}

const timelineKey = (t: Timeline | null) => (t ? JSON.stringify([t.id, t.fps, t.width, t.height, t.tracks]) : '')

let jobCounter = 0

/** `prepareTranscript`: one job per distinct media file, all concurrent; only an all-failed run throws. */
async function prepare(req: CaptionRequest, onProgress: (p: TranscriptionProgress) => void, jobs: string[]): Promise<Prepared> {
  const doc = getBaseDoc()
  const t = timelineOf(doc)
  if (!doc || !t) throw new CaptionError(NO_SOURCE)
  const before = timelineKey(t)
  let targets = resolvedTargets(doc, req)
  if (!targets.length) throw new CaptionError(NO_SOURCE)
  const clips = targets.map((x) => x.clip)
  const ctx = targetContext(doc)
  const unique = [...new Map(targets.map((x) => [x.clip.mediaRef, x.clip])).values()]
  const progress = new Map<string, TranscriptionProgress>()
  const off = window.palmier.ml.onProgress((p) => {
    if (!jobs.includes(p.jobId)) return
    progress.set(p.jobId, { phase: p.phase, fraction: p.fraction })
    const all = [...progress.values()]
    const downloading = all.find((x) => x.phase === 'downloading')
    onProgress(downloading ?? { phase: 'transcribing', fraction: all.reduce((n, x) => n + x.fraction, 0) / Math.max(1, unique.length) })
  })
  const results = new Map<string, TranscriptionResult>()
  let firstError: string | null = null
  try {
    await Promise.all(
      unique.map(async (clip) => {
        const jobId = `captions-${Date.now()}-${++jobCounter}`
        jobs.push(jobId)
        const out = await window.palmier.ml.transcribe({
          jobId,
          mediaRef: clip.mediaRef,
          isVideo: captionUsesVideoAudio(ctx, clip),
          range: sourceUnion(clip.mediaRef, clips, t.fps),
          provider: req.provider,
          locale: req.locale,
          censorProfanity: req.provider === 'local' && req.censorProfanity,
        })
        if (out.ok) results.set(clip.mediaRef, out.result)
        else if (out.cancelled) throw new CaptionError('Cancelled')
        else firstError ??= out.error
      }),
    )
  } finally {
    off()
  }
  if (!results.size && firstError) throw new CaptionError(firstError)
  if (timelineKey(timelineOf(getBaseDoc())) !== before) throw new CaptionError(TIMELINE_CHANGED)
  if (req.autoDetect) {
    const winner = dominantSpeechTrack(targets, results, t.fps)
    targets = winner ? targets.filter((x) => x.trackId === winner) : []
  }
  return { timeline: t, targets, results }
}

/** Unwrapped line width ≤ 90 % of the canvas, measured by the compositor's text layout (§1.7.5). */
const UNWRAPPED_CANVAS = 1e6
export function captionLayout(t: Timeline, style: TextStyle) {
  const fitsCache = new Map<string, boolean>()
  return {
    canvasWidth: t.width,
    canvasHeight: t.height,
    fits: (text: string) => {
      let v = fitsCache.get(text)
      if (v === undefined) {
        v = textMeasurer.measure(text, style, UNWRAPPED_CANVAS, t.height).width * UNWRAPPED_CANVAS <= t.width * CAPTION_MAX_TEXT_WIDTH_RATIO
        fitsCache.set(text, v)
      }
      return v
    },
    box: (text: string) => textMeasurer.measure(text, style, t.width, t.height),
  }
}

export interface GenerateHandle {
  promise: Promise<{ ids: string[]; groupId: string | null }>
  cancel(): void
}

/** `generateCaptions`: places the specs on a new top track as one undo step; resolves the created clip ids. */
export function generateCaptions(req: CaptionRequest, onProgress: (p: TranscriptionProgress) => void): GenerateHandle {
  const jobs: string[] = []
  let cancelled = false
  const promise = (async () => {
    const p = await prepare(req, onProgress, jobs)
    if (cancelled) throw new CaptionError('Cancelled')
    const groupId = crypto.randomUUID().toUpperCase()
    const specs = buildCaptionSpecs({
      targets: p.targets.flatMap((x) => {
        const r = p.results.get(x.clip.mediaRef)
        return r ? [{ clip: x.clip, result: r }] : []
      }),
      fps: p.timeline.fps,
      timelineEndFrame: totalFrames(p.timeline),
      style: req.style,
      center: req.center,
      textCase: req.textCase,
      maxWords: req.maxWords,
      maxCharacters: req.maxCharacters,
      maximumGapSeconds: req.maximumGapSeconds,
      animation: req.animation && req.animation.preset !== 'none' ? req.animation : undefined,
      layout: captionLayout(p.timeline, req.style),
      captionGroupId: groupId,
    })
    if (timelineKey(timelineOf(getBaseDoc())) !== timelineKey(p.timeline)) throw new CaptionError(TIMELINE_CHANGED)
    if (!specs.length) return { ids: [], groupId: null }
    const ids = await runOp('placeCaptions', { specs, actionName: 'Generate Captions' }, { quiet: true })
    return { ids: ids ?? [], groupId: ids?.length ? groupId : null }
  })()
  return {
    promise,
    cancel: () => {
      cancelled = true
      for (const id of jobs) window.palmier.ml.cancel(id)
    },
  }
}

/** `timelineTranscript`: the Index ▸ Transcript document for the request (no fit/word limits). */
export async function timelineTranscript(req: CaptionRequest, onProgress: (p: TranscriptionProgress) => void): Promise<TimelineTranscriptDocument> {
  const p = await prepare(req, onProgress, [])
  const doc = makeTimelineTranscriptDocument(p.targets, p.results, p.timeline.fps)
  if (timelineKey(timelineOf(getBaseDoc())) !== timelineKey(p.timeline)) throw new CaptionError(TIMELINE_CHANGED)
  return doc
}

/**
 * `cachedTimelineTranscript` (§1.11): cloud cache first, then local; a provider is used only when every target file
 * has a cached transcript. Never transcribes.
 */
export async function cachedTimelineTranscript(): Promise<TimelineTranscriptDocument | null> {
  const doc = getBaseDoc()
  const t = timelineOf(doc)
  if (!doc || !t) return null
  const key = timelineKey(t)
  let targets = resolvedTargets(doc, { autoDetect: true, sourceClipIds: [] })
  if (!targets.length) return null
  const clips = targets.map((x) => x.clip)
  const refs = [...new Set(targets.map((x) => x.clip.mediaRef))]
  for (const provider of ['cloud', 'local'] as const) {
    const results = new Map<string, TranscriptionResult>()
    let complete = true
    for (const ref of refs) {
      const range = sourceUnion(ref, clips, t.fps)
      const cached = provider === 'cloud' ? await window.palmier.ml.cachedCloudTranscript(ref, range, null) : await window.palmier.ml.cachedTranscript(ref, range)
      if (!cached) {
        complete = false
        break
      }
      results.set(ref, cached)
    }
    if (!complete) continue
    if (timelineKey(timelineOf(getBaseDoc())) !== key) return null
    const winner = dominantSpeechTrack(targets, results, t.fps)
    if (!winner) return null
    targets = targets.filter((x) => x.trackId === winner)
    return makeTimelineTranscriptDocument(targets, results, t.fps)
  }
  return null
}

export function errorText(e: unknown): string {
  return tx(e instanceof Error ? e.message : String(e))
}
