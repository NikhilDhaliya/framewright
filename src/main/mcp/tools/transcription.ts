/**
 * NEEDS-ML tools on Linux (spec 02 §3.33, §3.34, §3.39; spec 07 §1): get_transcript, remove_words and add_captions,
 * plus the transcript part of inspect_media. Transcription is local whisper.cpp through `env.app.transcription`.
 *
 * Linux deviation: agent tools always transcribe locally. The Mac picks Cloud when the account has credits; on Linux
 * Cloud is the user's own (billed) API key — the OpenAI slot is shared with chat/generation — so the agent never
 * spends it implicitly. `transcriptionSource` therefore always reads "local".
 */
import fs from 'node:fs/promises'
import type { Clip, TextAnimation, TextStyle, Timeline } from '../../../core/model'
import { applyStylePatch, textCenterX } from '../../../core/ops/agent'
import { activeTimeline, type Doc } from '../../../core/ops/context'
import { rippleDeleteRanges } from '../../../core/ops/clips'
import { findClip, linkedPartnerIds, type FrameRange } from '../../../core/timeline'
import { endFrame } from '../../../core/clip'
import type { CaptionClipSpec } from '../../../core/captions/captionBuilder'
import { whisperLanguage } from '../../../core/captions/languages'
import { placeCaptionTrack } from '../../../core/captions/placement'
import { buildCaptionSpecs, buildCueSpecs, CAPTION_DEFAULT_CENTER, CAPTION_DEFAULT_GAP_SECONDS, CAPTION_MAX_TEXT_WIDTH_RATIO, captionTextStyle, validGapSeconds, type CaptionTarget as BuildTarget } from '../../../core/captions/specBuilder'
import { captionTargetsForIds, captionTargetsForTracks, captionUsesVideoAudio, dominantSpeechTrack, locateTargets, transcriptionTargetsForClips, type TargetContext } from '../../../core/captions/targets'
import { clipWordRows, spanFrames } from '../../../core/captions/timelineTranscript'
import { sourceUnion } from '../../../core/captions/transcriptMapper'
import { cutRanges, KEPT_GAP_MS, type CutAggressiveness } from '../../../core/captions/wordCutPlanner'
import { isCancellation, type TranscriptionResult } from '../../../core/captions/transcript'
import { swiftRound } from '../../../core/keyframes'
import { relabelWords } from '../../../core/audio/speakers'
import type { TranscriptionService } from '../../ml/transcribe/service'
import { ToolError, exactInt, lenient, validateUnknownKeys, type Obj } from './args'
import { mutate, okRawJson, type FeedbackState, type ToolEnv, type ToolResult } from './context'
import { mutationResult, snapshot } from './delta'
import { parseSubtitleFile } from './subtitles'
import { parseStylePatch, parseTextAnimation, parseTextTransform } from './text'
import { frameWindow, OPEN_END } from './timelineView'

export const TRANSCRIPT_WORD_LIMIT = 10_000
const INSPECT_MAX_SEGMENTS = 400

function service(env: ToolEnv): TranscriptionService {
  const s = env.app.transcription
  if (!s) throw new ToolError("On-device transcription isn't available in this context.")
  return s
}

const targetContext = (doc: Doc): TargetContext => ({ timeline: activeTimeline(doc), assets: doc.manifest.entries, multicamGroups: doc.file.multicamGroups ?? [] })
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** `parseLocale`: the language must map to a whisper language. Returns the BCP-47 tag (undefined = Auto). */
export function parseLanguage(args: Obj, path: string): string | undefined {
  const lang = lenient.string(args, 'language')
  if (lang === undefined) return undefined
  if (!whisperLanguage(lang)) throw new ToolError(`${path}: on-device transcription does not support language '${lang}'.`)
  return lang
}

// ---------- Scope and session ----------

export type TranscriptionScope = { kind: 'automatic' } | { kind: 'clips'; ids: string[] } | { kind: 'track'; id: string }

function scopeTargets(doc: Doc, scope: TranscriptionScope): Clip[] {
  const ctx = targetContext(doc)
  switch (scope.kind) {
    case 'automatic':
      return captionTargetsForIds(ctx, [])
    case 'clips':
      return transcriptionTargetsForClips(ctx, scope.ids)
    case 'track':
      return captionTargetsForTracks(ctx, [scope.id])
  }
}

function linkedAudioScope(doc: Doc, clipIds: string[]): TranscriptionScope | null {
  const t = activeTimeline(doc)
  const partners = clipIds.flatMap((id) => linkedPartnerIds(t, id))
  if (!partners.length) return null
  const scope: TranscriptionScope = { kind: 'clips', ids: partners }
  return scopeTargets(doc, scope).length ? scope : null
}

/** `resolveTranscriptionScope` (02 §3.33). */
export function resolveTranscriptionScope(doc: Doc, args: Obj, path: string): TranscriptionScope {
  const clipId = lenient.string(args, 'clipId')
  const t = activeTimeline(doc)
  if (args.trackIndex === undefined) {
    if (!clipId) return { kind: 'automatic' }
    if (!findClip(t, clipId)) throw new ToolError(`Clip ${clipId} not found.`)
    const scope: TranscriptionScope = { kind: 'clips', ids: [clipId] }
    if (scopeTargets(doc, scope).length) return scope
    const linked = linkedAudioScope(doc, [clipId])
    if (linked) return linked
    throw new ToolError(`Clip ${clipId} has no transcribable audio.`)
  }
  if (clipId) throw new ToolError(`${path}: pass either clipId or trackIndex, not both.`)
  const trackIndex = exactInt(args.trackIndex)
  if (trackIndex === undefined) throw new ToolError(`${path}: trackIndex must be an integer.`)
  if (!t.tracks[trackIndex]) {
    const valid = t.tracks.length ? `valid range: 0..${t.tracks.length - 1}` : 'the timeline has no tracks'
    throw new ToolError(`${path}: trackIndex ${trackIndex} is out of range (${valid}).`)
  }
  const track = t.tracks[trackIndex]
  const scope: TranscriptionScope = { kind: 'track', id: track.id }
  if (scopeTargets(doc, scope).length) return scope
  const linked = linkedAudioScope(
    doc,
    track.clips.map((c) => c.id),
  )
  if (linked) return linked
  throw new ToolError(`${path}: track ${trackIndex} has no transcribable audio.`)
}

interface TranscriptSession {
  locale?: string
  scope: TranscriptionScope
  timelineId: string
  fps: number
  /** Clip id, media, start, duration, trimStart, speed of every target. */
  targets: string
}

const targetSnapshot = (clips: Clip[]) => JSON.stringify(clips.map((c) => [c.id, c.mediaRef, c.startFrame, c.durationFrames, c.trimStartFrame, c.speed]))

function makeSession(doc: Doc, scope: TranscriptionScope, locale: string | undefined): TranscriptSession {
  const t = activeTimeline(doc)
  return { locale, scope, timelineId: t.id, fps: t.fps, targets: targetSnapshot(scopeTargets(doc, scope)) }
}

const sameWordMapping = (doc: Doc, s: TranscriptSession) => {
  const t = activeTimeline(doc)
  return s.timelineId === t.id && s.fps === t.fps && s.targets === targetSnapshot(scopeTargets(doc, s.scope))
}

/** `lastTranscriptSession`, per MCP session (keyed by the executor's feedback state). */
const lastSessions = new WeakMap<FeedbackState, TranscriptSession>()

// ---------- Timeline transcript ----------

interface TimelineWord {
  index: number
  clipId: string
  trackIndex: number
  clipStartFrame: number
  clipEndFrame: number
  text: string
  startFrame: number
  endFrame: number
  speaker?: string
}

interface TimelineTranscript {
  words: TimelineWord[]
  skipped: { file: string; reason: string }[]
}

async function timelineTranscript(env: ToolEnv, session: TranscriptSession): Promise<TimelineTranscript> {
  const doc = env.session.doc
  const t = activeTimeline(doc)
  const fps = t.fps
  const assets = new Map(doc.manifest.entries.map((e) => [e.id, e]))
  const fragments: { clip: Clip; trackIndex: number; file: string }[] = []
  const isVideo = new Map<string, boolean>()
  for (const clip of scopeTargets(doc, session.scope)) {
    const loc = findClip(t, clip.id)
    const asset = assets.get(clip.mediaRef)
    const file = asset ? env.session.resolveMedia(asset) : null
    if (!loc || !asset || !file) continue
    fragments.push({ clip, trackIndex: loc.trackIndex, file })
    isVideo.set(file, asset.type === 'video')
  }
  const stt = service(env)
  const results = new Map<string, TranscriptionResult>()
  const skipped: { file: string; reason: string }[] = []
  await Promise.all(
    [...new Set(fragments.map((f) => f.file))].map(async (file) => {
      try {
        results.set(file, await stt.transcribe({ file, isVideo: isVideo.get(file) ?? true, provider: 'local', locale: session.locale }))
      } catch (e) {
        if (isCancellation(e)) throw e
        skipped.push({ file: file.split('/').pop() ?? file, reason: errorText(e) })
      }
    }),
  )
  // Project-wide speaker labels (02 §3.33, 07 §3.5 step 10): the session's Identify masks, else cached voices.
  const speakerFiles = [...new Map(fragments.map((f) => [f.clip.mediaRef, { mediaRef: f.clip.mediaRef, file: f.file }])).values()]
  const runs = env.app.speakers ? await env.app.speakers.runsFor(env.session, speakerFiles) : {}
  const registry = doc.file.speakers ?? []
  const relabelled = new Map<string, TranscriptionResult>()
  const transcriptFor = (f: { clip: Clip; file: string }): TranscriptionResult | undefined => {
    const r = results.get(f.file)
    const mask = runs[f.clip.mediaRef]
    if (!r || !mask?.length) return r
    let out = relabelled.get(f.clip.mediaRef)
    if (!out) relabelled.set(f.clip.mediaRef, (out = { ...r, words: relabelWords(r.words, mask, registry) }))
    return out
  }
  const words: TimelineWord[] = []
  for (const f of [...fragments].sort((a, b) => a.clip.startFrame - b.clip.startFrame)) {
    const r = transcriptFor(f)
    if (!r) continue
    for (const row of clipWordRows(r, f.clip, fps)) {
      words.push({
        index: words.length,
        clipId: f.clip.id,
        trackIndex: f.trackIndex,
        clipStartFrame: f.clip.startFrame,
        clipEndFrame: endFrame(f.clip),
        text: row.text,
        startFrame: row.start,
        endFrame: row.end,
        ...(row.speaker !== undefined ? { speaker: row.speaker } : {}),
      })
    }
  }
  return { words, skipped }
}

interface WordGroup {
  clipId: string
  trackIndex: number
  clipStartFrame: number
  clipEndFrame: number
  words: TimelineWord[]
}

function groups(words: TimelineWord[], clipFilter?: Set<string>): WordGroup[] {
  const out: WordGroup[] = []
  let i = 0
  while (i < words.length) {
    let j = i + 1
    while (j < words.length && words[j].clipId === words[i].clipId) j++
    if (!clipFilter || clipFilter.has(words[i].clipId)) {
      const w = words[i]
      out.push({ clipId: w.clipId, trackIndex: w.trackIndex, clipStartFrame: w.clipStartFrame, clipEndFrame: w.clipEndFrame, words: words.slice(i, j) })
    }
    i = j
  }
  return out
}

function segmentRows(words: TimelineWord[], fps: number): unknown[][] {
  const rows: unknown[][] = []
  let run: TimelineWord[] = []
  const flush = () => {
    if (!run.length) return
    rows.push([run[0].index, run.map((w) => w.text).join(' '), run[0].startFrame, run[run.length - 1].endFrame])
    run = []
  }
  for (const w of words) {
    const last = run[run.length - 1]
    if (last && (last.speaker !== w.speaker || w.startFrame - last.endFrame > fps || run.length >= 48)) flush()
    run.push(w)
    if (/[.!?]$/.test(w.text)) flush()
  }
  flush()
  return rows
}

function transcriptPayload(tr: TimelineTranscript, fps: number, o: { clipIds?: Set<string>; start?: number; end?: number; segments: boolean }): Obj {
  const includesSpeakers = tr.words.some((w) => w.speaker !== undefined)
  const clipsOut: Obj[] = []
  let total = 0
  let remaining = TRANSCRIPT_WORD_LIMIT
  let lastEnd: number | undefined
  const speakerRuns: unknown[][] = []
  let current: string | null | undefined
  let started = false
  for (const g of groups(tr.words, o.clipIds)) {
    const visible: TimelineWord[] = []
    for (const w of g.words) {
      if (o.start !== undefined && w.endFrame <= o.start) continue
      if (o.end !== undefined && w.startFrame >= o.end) continue
      total++
      if (remaining <= 0) continue
      visible.push(w)
      remaining--
      lastEnd = w.endFrame
      const speaker = w.speaker ?? null
      if (includesSpeakers && (!started || current !== speaker)) {
        started = true
        current = speaker
        speakerRuns.push([w.index, speaker])
      }
    }
    if (!visible.length) continue
    const clip: Obj = { clipId: g.clipId, trackIndex: g.trackIndex, startFrame: g.clipStartFrame, endFrame: g.clipEndFrame }
    if (o.segments) clip.segments = segmentRows(visible, fps)
    else clip.words = visible.map((w) => [w.index, w.text, w.startFrame])
    clipsOut.push(clip)
  }
  const out: Obj = { fps, timing: 'projectFrames', transcriptionSource: 'local', clips: clipsOut }
  if (o.segments) out.segmentFormat = ['firstWordIndex', 'text', 'start', 'end']
  else out.wordFormat = ['index', 'text', 'start']
  if (includesSpeakers && speakerRuns.length) {
    out.speakers = speakerRuns
    out.speakersNote = '[firstWordIndex, speaker] — each run holds until the next entry.'
  }
  if (total > TRANSCRIPT_WORD_LIMIT) {
    out.totalWords = total
    if (lastEnd !== undefined) {
      out.nextStartFrame = lastEnd
      out.wordsNote = `First ${TRANSCRIPT_WORD_LIMIT} of ${total} words. Continue with startFrame = nextStartFrame.`
    }
  }
  if (tr.skipped.length) out.skipped = tr.skipped
  return out
}

// ---------- get_transcript ----------

export async function getTranscript(env: ToolEnv, args: Obj): Promise<ToolResult> {
  validateUnknownKeys(args, ['startFrame', 'endFrame', 'clipId', 'trackIndex', 'wordTimestamps', 'language', 'granularity'], 'get_transcript')
  const clipFilter = lenient.string(args, 'clipId')
  const window = frameWindow(args)
  const granularity = lenient.string(args, 'granularity') ?? 'words'
  if (granularity !== 'words' && granularity !== 'segments') throw new ToolError(`granularity must be 'words' or 'segments' (got '${granularity}')`)
  const doc = env.session.doc
  const scope = resolveTranscriptionScope(doc, args, 'get_transcript')
  const session = makeSession(doc, scope, parseLanguage(args, 'get_transcript'))
  service(env)
  const tr = await timelineTranscript(env, session)
  lastSessions.set(env.feedback, session)
  // A clip without audio of its own reads through its linked partners; report those (the Mac filters on the
  // original id and returns no words — a quirk not kept).
  const clipIds = clipFilter ? new Set(scope.kind === 'clips' && !scope.ids.includes(clipFilter) ? scope.ids : [clipFilter]) : undefined
  return okRawJson(
    transcriptPayload(tr, activeTimeline(env.session.doc).fps, {
      clipIds,
      start: window?.start,
      end: window && window.end !== OPEN_END ? window.end : undefined,
      segments: granularity === 'segments',
    }),
  )
}

// ---------- remove_words ----------

function parseWordSpans(raw: unknown[]): [number, number][] {
  const int = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && Math.round(v) === v ? v : undefined)
  return raw.map((el, i) => {
    const n = int(el)
    if (n !== undefined) return [n, n]
    if (Array.isArray(el) && el.length === 2) {
      const a = int(el[0])
      const b = int(el[1])
      if (a !== undefined && b !== undefined) return [a, b]
    }
    throw new ToolError(`words[${i}]: expected an integer index or an [start, end] pair.`)
  })
}

/** Trim whitespace and punctuation, lowercase (`normalizedWordMatch`). */
export const normalizedWordMatch = (text: string): string => text.replace(/^[\p{White_Space}\p{P}]+|[\p{White_Space}\p{P}]+$/gu, '').toLowerCase()

function parseWordMatches(raw: unknown[]): Set<string> {
  return new Set(
    raw.map((el, i) => {
      if (typeof el !== 'string') throw new ToolError(`matches[${i}]: expected a string.`)
      const n = normalizedWordMatch(el)
      if (!n) throw new ToolError(`matches[${i}]: expected a non-empty word.`)
      return n
    }),
  )
}

export async function removeWords(env: ToolEnv, args: Obj): Promise<ToolResult> {
  validateUnknownKeys(args, ['words', 'matches', 'cutAggressiveness', 'language'], 'remove_words')
  const rawWords = Array.isArray(args.words) ? (args.words as unknown[]) : undefined
  const rawMatches = Array.isArray(args.matches) ? (args.matches as unknown[]) : undefined
  if (rawWords?.length === 0 || rawMatches?.length === 0) throw new ToolError('remove_words: words or matches must not be empty.')
  if (!rawWords && !rawMatches) throw new ToolError(`Missing 'words' or 'matches'. Pass word indices from get_transcript, e.g. [5, [12, 18]], or exact words like ["um", "uh"].`)
  if (rawWords && rawMatches) throw new ToolError('remove_words: pass either words or matches, not both.')
  const rawAgg = lenient.string(args, 'cutAggressiveness')
  if (rawAgg !== undefined && !Object.hasOwn(KEPT_GAP_MS, rawAgg)) throw new ToolError('cutAggressiveness must be one of: tight, balanced, loose.')
  const aggressiveness = (rawAgg ?? 'balanced') as CutAggressiveness

  const doc = env.session.doc
  const t0 = activeTimeline(doc)
  const remembered = lastSessions.get(env.feedback)
  let session: TranscriptSession
  if (remembered && remembered.timelineId === t0.id) {
    if (rawWords && !sameWordMapping(doc, remembered)) throw new ToolError('The timeline sources from the previous get_transcript have changed. Call get_transcript again before remove_words.')
    session = remembered
  } else {
    if (rawWords && remembered) throw new ToolError('The previous get_transcript belongs to a different timeline. Call get_transcript again before remove_words.')
    session = makeSession(doc, { kind: 'automatic' }, parseLanguage(args, 'remove_words'))
  }
  service(env)
  const tr = await timelineTranscript(env, session)
  const all = tr.words
  if (!all.length) throw new ToolError('No transcribable speech on the timeline.')

  const selected = new Set<number>()
  const ignored: number[] = []
  const maxIndex = all.length - 1
  if (rawWords) {
    for (const [a, b] of parseWordSpans(rawWords)) {
      const lo = Math.min(a, b)
      const hi = Math.max(a, b)
      if (hi < 0 || lo > maxIndex) {
        ignored.push(lo)
        continue
      }
      if (lo < 0) ignored.push(lo)
      if (hi > maxIndex) ignored.push(hi)
      for (let i = Math.max(0, lo); i <= Math.min(maxIndex, hi); i++) selected.add(i)
    }
    if (!selected.size) throw new ToolError(`None of the requested word indices are in range 0...${maxIndex}. Re-read get_transcript.`)
  } else {
    const matches = parseWordMatches(rawMatches!)
    for (const w of all) if (matches.has(normalizedWordMatch(w.text))) selected.add(w.index)
    if (!selected.size) throw new ToolError(`No transcript words matched: ${[...matches].sort().join(', ')}. Re-read get_transcript or pass exact word indices.`)
  }

  const fps = activeTimeline(env.session.doc).fps
  const keepGapFrames = swiftRound((KEPT_GAP_MS[aggressiveness] / 1000) * fps)
  const removedTexts: string[] = []
  const rangesByTrack = new Map<number, FrameRange[]>()
  const involved: string[] = []
  for (const g of groups(all)) {
    if (!g.words.some((w) => selected.has(w.index))) continue
    removedTexts.push(...g.words.filter((w) => selected.has(w.index) && w.endFrame > w.startFrame).map((w) => w.text))
    const ranges = cutRanges(
      g.words.map((w) => ({ startFrame: w.startFrame, endFrame: w.endFrame, selected: selected.has(w.index) })),
      g.clipStartFrame,
      g.clipEndFrame,
      keepGapFrames,
    )
    if (ranges.length) {
      rangesByTrack.set(g.trackIndex, [...(rangesByTrack.get(g.trackIndex) ?? []), ...ranges])
      involved.push(g.clipId)
    }
  }
  if (!rangesByTrack.size) throw new ToolError('The selected words resolved to no removable frames. Re-read get_transcript.')

  const t = activeTimeline(env.session.doc)
  let primary: number
  if (rangesByTrack.size === 1) primary = [...rangesByTrack.keys()][0]
  else {
    const groupIds = involved.flatMap((id) => {
      const g = findClip(t, id)?.clip.linkGroupId
      return g ? [g] : []
    })
    if (groupIds.length !== involved.length || new Set(groupIds).size !== 1) {
      const tracks = [...rangesByTrack.keys()].sort((a, b) => a - b).join(', ')
      throw new ToolError(
        `Selected words span multiple unlinked tracks (${tracks}). Remove words one track at a time — linked video/audio is cut automatically. If these tracks are the same source (e.g. camera + mic), link them into one unit first.`,
      )
    }
    primary = Math.min(...rangesByTrack.keys())
  }
  const before = snapshot(env.session.doc)
  const rippleMarkers = env.app.settings().rippleTimelineMarkers
  let report: { removedFrames: number }
  try {
    report = mutate(env, 'Remove Words (Agent)', (d) => rippleDeleteRanges(d, primary, rangesByTrack.get(primary)!, { rippleMarkers }))
  } catch (e) {
    throw new ToolError(`Ripple delete refused: ${errorText(e)}`)
  }
  const extra: Obj = { removedWords: removedTexts.length, removedFrames: report.removedFrames, cutAggressiveness: aggressiveness, transcriptionSource: 'local' }
  const preview = removedTexts.slice(0, 24).join(' ')
  if (preview) extra.removedText = removedTexts.length > 24 ? `${preview} …` : preview
  if (ignored.length) extra.indicesIgnored = [...ignored].sort((a, b) => a - b)
  return mutationResult(env.session.doc, before, { extra, notes: ['Word indices shifted — re-read get_transcript before another remove_words.'] })
}

// ---------- Caption building with renderer text measurement ----------

/** Wide virtual canvas: the renderer wraps at 90 % of the canvas width, so this measures the unwrapped line. */
const UNWRAPPED_CANVAS = 1e6

/**
 * Runs the pure builder with renderer-measured `fits` and boxes. The measurer is async (render host), so unknown
 * texts are collected, measured in one batch and the build is repeated until every query is answered.
 */
export async function measuredBuild(env: ToolEnv, t: Timeline, style: TextStyle, build: (layout: { fits: (s: string) => boolean; box: (s: string) => { width: number; height: number } }) => CaptionClipSpec[]): Promise<CaptionClipSpec[]> {
  const fitsCache = new Map<string, boolean>()
  const boxCache = new Map<string, { width: number; height: number }>()
  const measure = (texts: string[], canvasWidth: number) => env.app.render.measureText(texts.map((content) => ({ content, style, canvasWidth, canvasHeight: t.height })))
  for (let pass = 0; pass < 64; pass++) {
    const needFits = new Set<string>()
    const needBox = new Set<string>()
    const specs = build({
      fits: (s) => {
        const v = fitsCache.get(s)
        if (v === undefined) needFits.add(s)
        return v ?? true
      },
      box: (s) => {
        const v = boxCache.get(s)
        if (!v) needBox.add(s)
        return v ?? { width: 0, height: 0 }
      },
    })
    if (needFits.size) {
      const texts = [...needFits]
      const boxes = await measure(texts, UNWRAPPED_CANVAS)
      texts.forEach((s, i) => fitsCache.set(s, boxes[i].width * UNWRAPPED_CANVAS <= t.width * CAPTION_MAX_TEXT_WIDTH_RATIO))
      continue
    }
    if (needBox.size) {
      const texts = [...needBox]
      const boxes = await measure(texts, t.width)
      texts.forEach((s, i) => boxCache.set(s, boxes[i]))
      continue
    }
    return specs
  }
  throw new ToolError('Caption layout did not converge.')
}

// ---------- add_captions ----------

function captionLimit(args: Obj, key: string): number | undefined {
  if (!(key in args)) return undefined
  const v = exactInt(args[key])
  if (v === undefined || v < 1) throw new ToolError(`add_captions: ${key} must be an integer >= 1.`)
  return v
}

async function addCaptionsFromSubtitle(env: ToolEnv, mediaRef: string): Promise<ToolResult> {
  const doc = env.session.doc
  const asset = doc.manifest.entries.find((e) => e.id === mediaRef)
  if (!asset) throw new ToolError(`add_captions: media asset not found: ${mediaRef}`)
  if (asset.type !== 'subtitle') throw new ToolError(`add_captions: '${mediaRef}' is ${asset.type}, not a subtitle file. Omit subtitleMediaRef to caption spoken audio.`)
  const file = env.session.resolveMedia(asset)
  const online = file ? await fs.access(file).then(
        () => true,
        () => false,
      )
    : false
  if (!file || !online) throw new ToolError(`add_captions: the subtitle file for '${mediaRef}' is offline.`)
  let cues
  try {
    cues = await parseSubtitleFile(file)
  } catch (e) {
    throw new ToolError(`add_captions: ${errorText(e)}`)
  }
  const t = activeTimeline(env.session.doc)
  const style = captionTextStyle()
  const specs = await measuredBuild(env, t, style, (layout) => buildCueSpecs(cues, t.fps, style, CAPTION_DEFAULT_CENTER, layout.box, 'pending'))
  const groupId = crypto.randomUUID().toUpperCase()
  if (activeTimeline(env.session.doc) !== t) throw new ToolError('The timeline changed while captions were being prepared. Try again.')
  if (!specs.length) throw new ToolError('The subtitle file contains no captions.')
  const before = snapshot(env.session.doc)
  mutate(env, 'Add Captions', (d) =>
    placeCaptionTrack(
      d,
      specs.map((s) => ({ ...s, captionGroupId: groupId })),
    ),
  )
  return mutationResult(env.session.doc, before)
}

export async function addCaptions(env: ToolEnv, args: Obj): Promise<ToolResult> {
  validateUnknownKeys(args, ['style', 'transform', 'censorProfanity', 'language', 'animation', 'highlightColor', 'maxWords', 'maxCharacters', 'trackIndex', 'maximumGapSeconds', 'subtitleMediaRef'], 'add_captions')
  if ('subtitleMediaRef' in args) {
    const ref = args.subtitleMediaRef
    if (typeof ref !== 'string' || !ref) throw new ToolError('add_captions: subtitleMediaRef must be a non-empty media asset id string.')
    const others = Object.keys(args)
      .filter((k) => k !== 'subtitleMediaRef')
      .sort()
    if (others.length) throw new ToolError(`add_captions: subtitleMediaRef uses the file's text, timing, and default styling as-is; remove ${others.join(', ')}.`)
    return addCaptionsFromSubtitle(env, ref)
  }
  const patch = parseStylePatch(args, 'add_captions')
  const style = patch ? applyStylePatch(captionTextStyle(), patch) : captionTextStyle()
  const transform = parseTextTransform(args.transform, 'add_captions.transform')
  const center = { x: transform?.x ?? CAPTION_DEFAULT_CENTER.x, y: transform?.y ?? CAPTION_DEFAULT_CENTER.y }
  const anim = parseTextAnimation(lenient.string(args, 'animation'), lenient.string(args, 'highlightColor'), 'add_captions')
  const animation: TextAnimation | undefined = anim ? { preset: anim.preset, perWordFrames: 6, ...(anim.highlight ? { highlight: anim.highlight } : {}) } : undefined
  const maxWords = captionLimit(args, 'maxWords')
  const maxCharacters = captionLimit(args, 'maxCharacters')
  let maximumGapSeconds = CAPTION_DEFAULT_GAP_SECONDS
  if (args.maximumGapSeconds !== undefined) {
    const v = typeof args.maximumGapSeconds === 'number' ? validGapSeconds(args.maximumGapSeconds) : null
    if (v === null) throw new ToolError('add_captions: maximumGapSeconds must be a finite number from 0.0 through 2.0.')
    maximumGapSeconds = v
  }
  const doc = env.session.doc
  const scope = resolveTranscriptionScope(doc, args, 'add_captions')
  const locale = parseLanguage(args, 'add_captions')
  const censorProfanity = lenient.bool(args, 'censorProfanity') ?? false
  const stt = service(env)

  // generateCaptions → prepareTranscript (EditorViewModel+Captions.swift:206-247, 428-472).
  const t = activeTimeline(doc)
  const ctx = targetContext(doc)
  const autoDetect = scope.kind === 'automatic'
  const candidates = autoDetect ? captionTargetsForIds(ctx, []) : captionTargetsForIds(ctx, scopeTargets(doc, scope).map((c) => c.id))
  let targets = locateTargets(t, candidates)
  if (!targets.length) throw new ToolError('No audio clips to caption.')
  const clips = targets.map((x) => x.clip)
  const results = new Map<string, TranscriptionResult>()
  let firstError: unknown = null
  const jobs = [...new Map(targets.map((x) => [x.clip.mediaRef, x.clip])).values()]
  await Promise.all(
    jobs.map(async (clip) => {
      const asset = doc.manifest.entries.find((e) => e.id === clip.mediaRef)
      const file = asset ? env.session.resolveMedia(asset) : null
      if (!file) return
      try {
        const range = sourceUnion(clip.mediaRef, clips, t.fps)
        results.set(clip.mediaRef, await stt.transcribe({ file, isVideo: captionUsesVideoAudio(ctx, clip), range, provider: 'local', locale, censorProfanity }))
      } catch (e) {
        if (isCancellation(e)) throw e
        firstError ??= e
      }
    }),
  )
  if (!results.size && firstError) throw new ToolError(errorText(firstError))
  if (activeTimeline(env.session.doc) !== t) throw new ToolError('The timeline changed while captions were being prepared. Try again.')
  if (autoDetect) {
    const winner = dominantSpeechTrack(targets, results, t.fps)
    targets = winner ? targets.filter((x) => x.trackId === winner) : []
  }
  const buildTargets: BuildTarget[] = targets.flatMap((x) => {
    const r = results.get(x.clip.mediaRef)
    return r ? [{ clip: x.clip, result: r }] : []
  })
  const groupId = crypto.randomUUID().toUpperCase()
  const total = Math.max(0, ...t.tracks.flatMap((tr) => tr.clips.map((c) => endFrame(c))))
  const specs = await measuredBuild(env, t, style, (layout) =>
    buildCaptionSpecs({
      targets: buildTargets,
      fps: t.fps,
      timelineEndFrame: total,
      style,
      center,
      textCase: 'auto',
      maxWords,
      maxCharacters,
      maximumGapSeconds,
      animation,
      layout: { canvasWidth: t.width, canvasHeight: t.height, ...layout },
      captionGroupId: groupId,
    }),
  )
  if (activeTimeline(env.session.doc) !== t) throw new ToolError('The timeline changed while captions were being prepared. Try again.')
  if (!specs.length) throw new ToolError('No speech detected to caption.')
  const adjust = transform && (transform.x !== undefined || transform.rotation !== undefined || transform.rotationX !== undefined || transform.rotationY !== undefined)
  const placed = adjust
    ? specs.map((s) => {
        if (!s.transform) return s
        const tf = { ...s.transform }
        if (transform!.x !== undefined) tf.centerX = textCenterX(transform!.x, tf.width, style.alignment)
        if (transform!.rotation !== undefined) tf.rotation = transform!.rotation
        if (transform!.rotationX !== undefined) tf.rotationX = transform!.rotationX
        if (transform!.rotationY !== undefined) tf.rotationY = transform!.rotationY
        return { ...s, transform: tf }
      })
    : specs
  const before = snapshot(env.session.doc)
  mutate(env, 'Generate Captions (Agent)', (d) => placeCaptionTrack(d, placed))
  return mutationResult(env.session.doc, before)
}

// ---------- inspect_media transcript ----------

const round2OrNull = (x: number | undefined): number | null => (x === undefined || !Number.isFinite(x) ? null : Number(x.toFixed(2)))

/** `transcriptionMeta` (02 §3.10). */
export function transcriptionMeta(r: TranscriptionResult, mapping: { clip: Clip; fps: number } | null, includeWords: boolean): Obj {
  const out: Obj = { timing: mapping ? 'projectFrames' : 'sourceSeconds' }
  if (r.language !== undefined) out.language = r.language
  const rows: { row: unknown[]; sourceEnd: number }[] = mapping
    ? r.segments.flatMap((s) => {
        const f = spanFrames(s.start, s.end, mapping.clip, mapping.fps)
        return f ? [{ row: [s.text, f.start, f.end], sourceEnd: s.end }] : []
      })
    : r.segments.map((s) => ({ row: [s.text, round2OrNull(s.start), round2OrNull(s.end)], sourceEnd: s.end }))
  const shown = rows.slice(0, INSPECT_MAX_SEGMENTS)
  out.segments = shown.map((x) => x.row)
  if (rows.length > INSPECT_MAX_SEGMENTS) {
    out.totalSegments = rows.length
    out.nextStartSeconds = round2OrNull(shown[shown.length - 1].sourceEnd)
    out.segmentsNote = `First ${INSPECT_MAX_SEGMENTS} of ${rows.length} segments. Continue with startSeconds = nextStartSeconds.`
  }
  if (includeWords) {
    const words: unknown[][] = mapping
      ? r.words.flatMap((w) => {
          if (w.start === undefined || w.end === undefined) return []
          const f = spanFrames(w.start, w.end, mapping.clip, mapping.fps)
          return f ? [[w.text, f.start, f.end]] : []
        })
      : r.words.map((w) => [w.text, round2OrNull(w.start), round2OrNull(w.end)])
    out.words = words.slice(0, TRANSCRIPT_WORD_LIMIT)
    if (words.length > TRANSCRIPT_WORD_LIMIT) {
      out.totalWords = words.length
      out.wordsNote = `First ${TRANSCRIPT_WORD_LIMIT} of ${words.length} words. Narrow with startSeconds/endSeconds.`
    }
  }
  return out
}

/** Local transcript of one asset for inspect_media: cached full file windowed to `range`; a language bypasses the cache. */
export function inspectTranscript(env: ToolEnv, file: string, isVideo: boolean, range: [number, number] | null, locale: string | undefined): Promise<TranscriptionResult> {
  return service(env).transcribe({ file, isVideo, range, provider: 'local', locale })
}

