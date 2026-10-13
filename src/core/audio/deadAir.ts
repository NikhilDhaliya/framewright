/**
 * Dead air (spec 07 §3.3; Mac `SpeechMaskStore.buildQuietNonSpeechMask`, `SilenceRemovalPlanner`,
 * `EditorViewModel+DeadAir.swift`): quiet non-speech cells → removable cells → clip-visible source ranges →
 * timeline ranges, plus the multicam group mask and the ripple-delete passes. Pure.
 */
import { endFrame, sourceFramesConsumed } from '../clip'
import type { Clip, MulticamSource, Timeline } from '../model'
import { activeTimeline, type Doc } from '../ops/context'
import { rippleDeleteRanges } from '../ops/clips'
import { EditRefusal, findClip, mergeRanges, round, type FrameRange } from '../timeline'
import { CELL_SECONDS, maskFromRuns } from './vad'

export interface SilenceSettings {
  minimumPause: number
  speechPadding: number
}

export const DEFAULT_SILENCE_SETTINGS: SilenceSettings = { minimumPause: 0.5, speechPadding: 0.15 }
export const MINIMUM_PAUSE_RANGE: [number, number] = [0.25, 3]
export const SPEECH_PADDING_RANGE: [number, number] = [0, 0.5]

/** `SilenceRemovalSettings.init?`: null when either value is out of range or not finite. */
export function validSilenceSettings(minimumPause: number, speechPadding: number): SilenceSettings | null {
  const ok = (v: number, [lo, hi]: [number, number]) => Number.isFinite(v) && v >= lo && v <= hi
  return ok(minimumPause, MINIMUM_PAUSE_RANGE) && ok(speechPadding, SPEECH_PADDING_RANGE) ? { minimumPause, speechPadding } : null
}

/** Quiet non-speech cells of one file, shipped between processes as runs. */
export interface QuietMaskData {
  count: number
  runs: [number, number][]
}

export type QuietMasks = Readonly<Record<string, QuietMaskData | undefined>>

/** ≈ −28 dBFS on the 0 (loud) … 1 (silent) waveform scale. */
const NO_SPEECH_FLOOR = 0.56
/** 12 dB on the same scale. */
const SPEECH_GAP = 0.24

/**
 * `buildQuietNonSpeechMask`: `speech` = VAD cells, `samples` = peak envelope (0 = loud … 1 = silent).
 * A non-speech run is dead when its median cell peak sits at or below the quiet floor (≥ on this inverted scale).
 */
export function quietNonSpeechMask(speech: readonly boolean[], samples: ArrayLike<number>): boolean[] {
  const n = speech.length
  const S = samples.length
  if (!n || !S) return []
  const peaks = new Float64Array(n)
  for (let c = 0; c < n; c++) {
    const s0 = Math.floor((c * S) / n)
    const s1 = Math.min(S, Math.max(s0 + 1, Math.floor(((c + 1) * S) / n)))
    let peak = 1
    for (let s = s0; s < s1; s++) if (samples[s] < peak) peak = samples[s]
    peaks[c] = peak
  }
  const median = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)]
  const speechPeaks: number[] = []
  for (let c = 0; c < n; c++) if (speech[c]) speechPeaks.push(peaks[c])
  const floor = speechPeaks.length ? Math.min(0.8, Math.max(0.44, median(speechPeaks) + SPEECH_GAP)) : NO_SPEECH_FLOOR
  const dead = new Array<boolean>(n).fill(false)
  let i = 0
  while (i < n) {
    if (speech[i]) {
      i++
      continue
    }
    let j = i
    while (j < n && !speech[j]) j++
    const run: number[] = []
    for (let c = i; c < j; c++) run.push(peaks[c])
    if (median(run) >= floor) for (let c = i; c < j; c++) dead[c] = true
    i = j
  }
  return dead
}

function cellCount(seconds: number, maximum: number, cell = CELL_SECONDS): number {
  const c = Math.ceil(seconds / cell)
  return Number.isFinite(c) && c < maximum ? Math.max(0, c) : maximum
}

/** `SilenceRemovalPlanner.removableMask`. */
export function removableMask(quiet: readonly boolean[], s: SilenceSettings): boolean[] {
  const n = quiet.length
  if (!n) return []
  const minCells = cellCount(s.minimumPause, n + 1)
  const pad = cellCount(s.speechPadding, n)
  const out = new Array<boolean>(n).fill(false)
  let i = 0
  while (i < n) {
    if (!quiet[i]) {
      i++
      continue
    }
    let j = i + 1
    while (j < n && quiet[j]) j++
    if (j - i >= minCells) {
      const start = i + (i > 0 ? pad : 0)
      const end = j - (j < n ? pad : 0)
      for (let c = start; c < end; c++) out[c] = true
    }
    i = j
  }
  return out
}

type Span = [number, number]
const overlaps = (a: Span, b: Span) => a[0] < b[1] && b[0] < a[1] && a[0] < a[1] && b[0] < b[1]

/** `visibleRemovableRanges`: removable runs as source-frame spans within `[visibleLo, visibleHi)` (exposed edges unpadded). */
export function visibleRemovableRanges(mask: readonly boolean[], visible: Span, fps: number, s: SilenceSettings): Span[] {
  const cellFrames = CELL_SECONDS * Math.max(1, fps)
  if (!mask.length || !(visible[0] < visible[1]) || !Number.isFinite(visible[0]) || !Number.isFinite(visible[1])) return []
  const vis: Span = [visible[0] / cellFrames, visible[1] / cellFrames]
  const edgePad = cellCount(s.speechPadding, mask.length)
  const scanStart = Math.trunc(Math.max(0, Math.min(mask.length, Math.floor(vis[0] - edgePad))))
  const scanEnd = Math.trunc(Math.max(scanStart, Math.min(mask.length, Math.ceil(vis[1] + edgePad))))
  const out: Span[] = []
  let i = scanStart
  while (i < scanEnd) {
    if (!mask[i]) {
      i++
      continue
    }
    let j = i + 1
    while (j < scanEnd && mask[j]) j++
    const start = j > vis[0] && i <= vis[0] + edgePad ? vis[0] : i
    const end = i < vis[1] && j >= vis[1] - edgePad ? vis[1] : j
    if (start < end && overlaps([start, end], vis)) {
      const a = Math.max(start, vis[0])
      const b = Math.min(end, vis[1])
      if (a < b) out.push([a * cellFrames, b * cellFrames])
    }
    i = j
  }
  return out
}

/** `timelineRange(clip:sourceStart:sourceEnd:)`. */
export function sourceToTimelineRange(c: Clip, src: Span): FrameRange | null {
  const consumed = sourceFramesConsumed(c)
  const s0 = Math.max(src[0], c.trimStartFrame)
  const s1 = Math.min(src[1], c.trimStartFrame + consumed)
  if (!(s1 > s0) || !(c.speed > 0)) return null
  const t0 = round(c.startFrame + (s0 - c.trimStartFrame) / c.speed)
  const t1 = round(c.startFrame + (s1 - c.trimStartFrame) / c.speed)
  return t1 - t0 > 0 ? { start: t0, end: t1 } : null
}

const usable = (m: MulticamSource['members'][number]) => m.sync.confidence > 0 || m.sync.locked
const micsOf = (g: MulticamSource) => g.members.filter((m) => m.kind !== 'angle' && usable(m))

/** `DeadAirMaskResolver.mask`: group-wide AND of every usable mic's quiet cells, seen from `clip`'s member. */
export function multicamRemovableMask(clip: Clip, group: MulticamSource, s: SilenceSettings, quietFor: (ref: string) => boolean[] | null): boolean[] | null {
  const member = group.members.find((m) => m.mediaRef === clip.mediaRef)
  if (!member || clip.mediaType !== 'audio') return null
  const mics = micsOf(group)
  if (!mics.length) return null
  const aligned: { values: boolean[]; offset: number }[] = []
  for (const mic of mics) {
    const values = quietFor(mic.mediaRef)
    if (!values?.length) return null
    aligned.push({ values, offset: round(mic.sync.offsetSeconds / CELL_SECONDS) })
  }
  const count = aligned.reduce((m, a) => Math.max(m, a.values.length + a.offset), 0)
  const groupMask = new Array<boolean>(Math.max(0, count)).fill(true)
  for (let i = 0; i < count; i++) {
    for (const a of aligned) {
      const k = i - a.offset
      if (k >= 0 && k < a.values.length && !a.values[k]) {
        groupMask[i] = false
        break
      }
    }
  }
  const shift = round(member.sync.offsetSeconds / CELL_SECONDS)
  const memberMask = shift > 0 ? groupMask.slice(shift) : shift < 0 ? [...new Array<boolean>(-shift).fill(false), ...groupMask] : groupMask
  return removableMask(memberMask, s)
}

/** Resolves masks for clips; caches decoded masks per mediaRef and multicam keys (the Mac's `DeadAirMaskCache`). */
export class DeadAirResolver {
  private readonly quiet = new Map<string, boolean[] | null>()
  private readonly removable = new Map<string, boolean[] | null>()

  constructor(
    private readonly masks: QuietMasks,
    private readonly settings: SilenceSettings,
    private readonly groups: readonly MulticamSource[] = [],
  ) {}

  quietFor(ref: string): boolean[] | null {
    if (!this.quiet.has(ref)) {
      const m = this.masks[ref]
      this.quiet.set(ref, m && m.count > 0 ? maskFromRuns(m.runs, m.count) : null)
    }
    return this.quiet.get(ref) ?? null
  }

  maskFor(c: Clip): boolean[] | null {
    const group = c.multicamGroupId ? this.groups.find((g) => g.id === c.multicamGroupId) : undefined
    const key = group ? `g:${group.id}:${c.mediaRef}` : `m:${c.mediaRef}`
    if (!this.removable.has(key)) {
      let mask: boolean[] | null
      if (group) mask = group.members.some((m) => m.mediaRef === c.mediaRef) ? multicamRemovableMask(c, group, this.settings, (r) => this.quietFor(r)) : null
      else {
        const q = this.quietFor(c.mediaRef)
        mask = q ? removableMask(q, this.settings) : null
      }
      this.removable.set(key, mask)
    }
    return this.removable.get(key) ?? null
  }

  /** `deadAirSourceRanges`: source-frame spans of dead air visible in `c`. */
  sourceRanges(c: Clip, fps: number): Span[] {
    if (c.mediaType !== 'audio') return []
    const mask = this.maskFor(c)
    if (!mask?.length) return []
    return visibleRemovableRanges(mask, [c.trimStartFrame, c.trimStartFrame + sourceFramesConsumed(c)], fps, this.settings)
  }

  /** `deadAirRanges(for:)`: timeline ranges. */
  ranges(c: Clip, fps: number): FrameRange[] {
    return this.sourceRanges(c, fps)
      .map((r) => sourceToTimelineRange(c, r))
      .filter((r): r is FrameRange => !!r)
  }

  /** `allDeadAir`: merged ranges per audio track (only tracks with some). */
  all(t: Timeline): { trackIndex: number; ranges: FrameRange[] }[] {
    const out: { trackIndex: number; ranges: FrameRange[] }[] = []
    t.tracks.forEach((tr, i) => {
      if (tr.type !== 'audio') return
      const ranges = mergeRanges(tr.clips.flatMap((c) => this.ranges(c, t.fps)))
      if (ranges.length) out.push({ trackIndex: i, ranges })
    })
    return out
  }
}

export interface DeadAirOutcome {
  sections: number
  removedFrames: number
  refusal?: string
}

const resolverFor = (doc: Doc, masks: QuietMasks, s: SilenceSettings) => new DeadAirResolver(masks, s, doc.file.multicamGroups ?? [])

/** Total dead-air section count on the active timeline (the Audio tab's count). */
export function deadAirCount(doc: Doc, masks: QuietMasks, s: SilenceSettings): number {
  return resolverFor(doc, masks, s)
    .all(activeTimeline(doc))
    .reduce((n, t) => n + t.ranges.length, 0)
}

/**
 * `removeAllDeadAir`: up to trackCount passes, each ripple-deleting the first audio track that still has dead air
 * (ranges recomputed after every pass). A refusal on the first pass throws; a later one keeps earlier edits.
 */
export function removeAllDeadAir(doc: Doc, masks: QuietMasks, s: SilenceSettings): DeadAirOutcome {
  let sections = 0
  let removedFrames = 0
  let refusal: string | undefined
  const passes = activeTimeline(doc).tracks.length
  for (let p = 0; p < passes; p++) {
    const next = resolverFor(doc, masks, s).all(activeTimeline(doc))[0]
    if (!next) break
    try {
      const r = rippleDeleteRanges(doc, next.trackIndex, next.ranges)
      sections += next.ranges.length
      removedFrames += r.removedFrames
    } catch (e) {
      if (!(e instanceof EditRefusal)) throw e
      if (sections === 0) throw new EditRefusal(e.message, true)
      refusal = e.message
      break
    }
  }
  if (sections === 0) throw new EditRefusal('No dead air on the timeline.')
  return { sections, removedFrames, ...(refusal ? { refusal } : {}) }
}

/** Selection validation of `removeDeadAir(clipIds:settings:)` (`DeadAirSelectionError` messages). */
export function deadAirSelection(t: Timeline, clipIds: string[]): { anchorTrack: number; audio: Clip[] } {
  const targets = clipIds.map((id) => findClip(t, id)).filter((l): l is NonNullable<typeof l> => !!l)
  if (targets.length !== clipIds.length || !targets.length) throw new EditRefusal('Selected clips could not be resolved.')
  const audio = targets.filter((l) => l.clip.mediaType === 'audio')
  if (!audio.length) throw new EditRefusal('Selected clips must include at least one audio clip.')
  if (new Set(targets.map((l) => l.trackIndex)).size > 1) {
    const groups = targets.map((l) => l.clip.linkGroupId).filter((g): g is string => !!g)
    if (groups.length !== targets.length || new Set(groups).size !== 1) throw new EditRefusal('Selected clips must share one track or belong to one linked A/V unit.')
  }
  const audioTracks = new Set(audio.map((l) => l.trackIndex))
  if (audioTracks.size !== 1) throw new EditRefusal('Selected audio clips must come from one track.')
  return { anchorTrack: [...audioTracks][0], audio: audio.map((l) => l.clip) }
}

/** Scoped removal (`removeDeadAir(clipIds:)`): one ripple over the selection's merged ranges. */
export function removeDeadAirInClips(doc: Doc, clipIds: string[], masks: QuietMasks, s: SilenceSettings): DeadAirOutcome {
  const t = activeTimeline(doc)
  const sel = deadAirSelection(t, clipIds)
  const resolver = resolverFor(doc, masks, s)
  const ranges = mergeRanges(sel.audio.flatMap((c) => resolver.ranges(c, t.fps)))
  if (!ranges.length) throw new EditRefusal('No dead air in the selected clips.')
  try {
    const r = rippleDeleteRanges(doc, sel.anchorTrack, ranges)
    return { sections: ranges.length, removedFrames: r.removedFrames }
  } catch (e) {
    if (e instanceof EditRefusal) throw new EditRefusal(e.message, true)
    throw e
  }
}

/** Context menu "Remove Dead Air" on one span: the dead-air range of `clipId` under `frame`. */
export function deadAirSpanAt(doc: Doc, clipId: string, frame: number, masks: QuietMasks, s: SilenceSettings): { trackIndex: number; range: FrameRange } | null {
  const t = activeTimeline(doc)
  const loc = findClip(t, clipId)
  if (!loc) return null
  const range = resolverFor(doc, masks, s)
    .ranges(loc.clip, t.fps)
    .find((r) => r.start <= frame && frame < r.end)
  return range ? { trackIndex: loc.trackIndex, range } : null
}

export function removeDeadAirAt(doc: Doc, clipId: string, frame: number, masks: QuietMasks, s: SilenceSettings): DeadAirOutcome {
  const span = deadAirSpanAt(doc, clipId, frame, masks, s)
  if (!span) throw new EditRefusal('No dead air here.')
  try {
    const r = rippleDeleteRanges(doc, span.trackIndex, [span.range])
    return { sections: 1, removedFrames: r.removedFrames }
  } catch (e) {
    if (e instanceof EditRefusal) throw new EditRefusal(e.message, true)
    throw e
  }
}

/** Clip-local dead-air spans for drawing, in clip-relative timeline frames. */
export function clipDeadAirSpans(c: Clip, fps: number, resolver: DeadAirResolver): FrameRange[] {
  return resolver.ranges(c, fps).map((r) => ({ start: r.start - c.startFrame, end: Math.min(r.end, endFrame(c)) - c.startFrame }))
}
