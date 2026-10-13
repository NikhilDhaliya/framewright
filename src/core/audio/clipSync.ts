/**
 * Clip "Synchronize" (03 §12.4; Mac `EditorViewModel+Sync.swift`, ported line by line): timecode or audio alignment
 * of target units to a reference clip, then planned moves (+ optional drift retimes). `planClipSync` reads a doc
 * snapshot and the injected readers; `applyClipSync` commits the plan to a doc (inside the caller's undo group).
 */
import { endFrame } from '../clip'
import { captionCanTranscribe, type TargetContext } from '../captions/targets'
import { timecodeSeconds, type SourceTimecode, type SourceTiming } from '../interchange/timecode'
import type { Clip, Timeline } from '../model'
import { activeTimeline, type Doc } from '../ops/context'
import { moveClips, retimedDurationFrames, setClipSpeed } from '../ops/clips'
import { allClips, findClip, linkedPartnerIds, round } from '../timeline'
import { MIN_OVERLAP, seededCorrelate, type SeededCorrelateArgs } from './correlator'
import { ENVELOPE_HOP_SECONDS } from './envelope'

export type SyncMode = 'auto' | 'audio' | 'timecode'
export type SyncMethod = 'timecode' | 'audio'

export interface SyncReport {
  synced: { clipId: string; offsetFrames: number; confidence: number; method: SyncMethod }[]
  failures: { clipId: string; message: string }[]
  shiftedFrames: number
  retimed: { clipId: string; driftPpm: number }[]
  retimeSkipped: { clipId: string; message: string }[]
}

export interface ClipSyncRequest {
  referenceClipId: string
  targetClipIds: string[]
  mode?: SyncMode
  searchWindowSeconds?: number | null
  minConfidence?: number
}

export interface ClipSyncDeps {
  timing(refs: string[]): Promise<Record<string, SourceTiming>>
  /** Envelope of `[start, end]` source seconds of `mediaRef`; null when unreadable. */
  envelope(mediaRef: string, start: number, end: number): Promise<Float32Array | null>
  correlate?: (a: SeededCorrelateArgs) => Promise<ReturnType<typeof seededCorrelate>>
  isCancelled?: () => boolean
}

export interface ClipSyncPlan {
  report: SyncReport
  moves: { clipId: string; toTrack: number; toFrame: number }[]
  retimes: { ids: string[]; speed: number }[]
}

const MIN_SPEED = 0.0001
const DATE_SEED_WINDOW_SECONDS = 3
const MIN_OVERLAP_SECONDS = 3

export class SyncCancelled extends Error {
  constructor() {
    super('Cancelled')
  }
}

/** `timecodeAlignedStart`. */
export function timecodeAlignedStart(ref: { startFrame: number; trimStartFrame: number; speed: number; tc: SourceTimecode }, tgt: { trimStartFrame: number; tc: SourceTimecode }, fps: number): number {
  const refClock = timecodeSeconds(ref.tc) + ref.trimStartFrame / fps
  const tgtClock = timecodeSeconds(tgt.tc) + tgt.trimStartFrame / fps
  return round(ref.startFrame + ((tgtClock - refClock) * fps) / Math.max(ref.speed, MIN_SPEED))
}

const isVisual = (c: Clip) => c.mediaType !== 'audio'
const targetCtx = (doc: Doc, t: Timeline): TargetContext => ({ timeline: t, assets: doc.manifest.entries, multicamGroups: doc.file.multicamGroups ?? [] })

/** `syncSelection`: (reference, targets) from selected non-multicam clips, or null (< 2 units). */
export function syncSelection(doc: Doc, selected: Iterable<string>): { referenceClipId: string; targetClipIds: string[] } | null {
  const t = activeTimeline(doc)
  const ids = new Set(selected)
  const ctx = targetCtx(doc, t)
  const units = new Map<string, Clip[]>()
  for (const c of allClips(t)) {
    if (!ids.has(c.id) || c.multicamGroupId) continue
    const k = c.linkGroupId ?? c.id
    units.set(k, [...(units.get(k) ?? []), c])
  }
  const bearers: { unit: Clip[]; clip: Clip }[] = []
  for (const unit of units.values()) {
    const clip = unit.find((c) => c.mediaType === 'audio' && captionCanTranscribe(ctx, c)) ?? unit.find((c) => captionCanTranscribe(ctx, c)) ?? unit.find((c) => c.mediaType === 'video')
    if (clip) bearers.push({ unit, clip })
  }
  if (bearers.length < 2) return null
  const rank = (b: { unit: Clip[] }) => [b.unit.some((c) => c.linkGroupId) ? 0 : 1, b.unit.some(isVisual) ? 0 : 1, Math.min(...b.unit.map((c) => c.startFrame))]
  const cmp = (a: number[], b: number[]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
  const ordered = [...bearers].sort((a, b) => cmp(rank(a), rank(b)))
  const targets = ordered
    .slice(1)
    .sort((a, b) => a.clip.startFrame - b.clip.startFrame)
    .map((b) => b.clip.id)
  return { referenceClipId: ordered[0].clip.id, targetClipIds: targets }
}

interface AudioClip {
  clipId: string
  samples: Float32Array
  speed: number
  mediaRef: string
  trimStartFrame: number
}

type Hit = { rawStart: number; confidence: number; driftRatio: number; retimedSpeed: number | null }

/** Plans a sync against `doc` (read-only). Throws `SyncCancelled` when cancelled. */
export async function planClipSync(doc: Doc, req: ClipSyncRequest, deps: ClipSyncDeps): Promise<ClipSyncPlan> {
  const t = activeTimeline(doc)
  const fps = t.fps
  const mode = req.mode ?? 'auto'
  const minConfidence = req.minConfidence ?? 0.5
  const referenceClipId = req.referenceClipId
  const targets = req.targetClipIds.filter((id) => id !== referenceClipId)
  const report: SyncReport = { synced: [], failures: [], shiftedFrames: 0, retimed: [], retimeSkipped: [] }
  const empty = (): ClipSyncPlan => ({ report, moves: [], retimes: [] })
  const check = () => {
    if (deps.isCancelled?.()) throw new SyncCancelled()
  }
  const live = (id: string) => findClip(t, id)?.clip ?? null
  const refClip = live(referenceClipId)
  if (!(fps > 0) || !refClip) {
    report.failures = targets.map((clipId) => ({ clipId, message: 'Reference clip unavailable.' }))
    return empty()
  }
  const ctx = targetCtx(doc, t)
  const refUnitKey = refClip.linkGroupId ?? refClip.id
  const unit = (c: Clip) => (c.linkGroupId ? allClips(t).filter((x) => x.linkGroupId === c.linkGroupId) : [c])
  const refs = new Set(unit(refClip).map((c) => c.mediaRef))
  for (const id of targets) {
    const c = live(id)
    if (c) for (const u of unit(c)) refs.add(u.mediaRef)
  }
  const timing = await deps.timing([...refs])
  const tcCarrier = (clips: Clip[]): { clip: Clip; tc: SourceTimecode } | null => {
    const hits = clips.flatMap((c) => (timing[c.mediaRef]?.timecode ? [{ clip: c, tc: timing[c.mediaRef].timecode! }] : []))
    return hits.find((h) => isVisual(h.clip)) ?? hits[0] ?? null
  }
  const refTC = mode === 'audio' ? null : tcCarrier(unit(refClip))
  const hop = ENVELOPE_HOP_SECONDS
  const seedWindow = Math.max(1, round(DATE_SEED_WINDOW_SECONDS / hop))
  const minOverlap = Math.max(MIN_OVERLAP, round(MIN_OVERLAP_SECONDS / hop))
  const run = deps.correlate ?? (async (a: SeededCorrelateArgs) => seededCorrelate(a))
  const envelopeOf = async (c: Clip): Promise<Float32Array | null> => {
    const start = c.trimStartFrame / fps
    const end = start + (c.durationFrames * Math.max(c.speed, MIN_SPEED)) / fps
    return deps.envelope(c.mediaRef, start, Math.max(start + hop, end)).catch(() => null)
  }

  const anchors: { rawStart: number; clip: AudioClip }[] = []
  const candidates: { clip: AudioClip; direct: Hit | null; tcRawStart: number | null }[] = []
  const placements: { clipId: string; rawStart: number; confidence: number; method: SyncMethod; driftRatio: number; retimedSpeed: number | null }[] = []
  let refAudioTried = false

  const match = async (anchor: { rawStart: number; clip: AudioClip }, target: AudioClip): Promise<Hit | null> => {
    let seedHops: number | null = null
    const ad = timing[anchor.clip.mediaRef]?.captureDate
    const td = timing[target.mediaRef]?.captureDate
    if (ad && td) seedHops = round(((td.getTime() - ad.getTime()) / 1000 + (target.trimStartFrame - anchor.clip.trimStartFrame) / fps) / hop)
    const maxLag = req.searchWindowSeconds ? Math.max(1, round(req.searchWindowSeconds / hop)) : Math.max(anchor.clip.samples.length, target.samples.length)
    const r = await run({ reference: anchor.clip.samples, target: target.samples, seedHops, seedWindowHops: seedWindow, maxLagHops: maxLag, minOverlapHops: minOverlap, minConfidence, isCancelled: deps.isCancelled })
    if (!r) return null
    const lagFrames = (r.exactLagHops * hop * fps) / Math.max(anchor.clip.speed, MIN_SPEED)
    let retimedSpeed: number | null = null
    if (r.driftRatio !== 0) {
      const corrected = anchor.clip.speed / (1 + r.driftRatio)
      if (Math.abs(corrected / Math.max(target.speed, MIN_SPEED) - 1) <= 0.001) retimedSpeed = corrected
    }
    return { rawStart: round(anchor.rawStart + lagFrames), confidence: r.confidence, driftRatio: r.driftRatio, retimedSpeed }
  }

  const seenUnits = new Set<string>()
  for (const targetId of targets) {
    check()
    const targetClip = live(targetId)
    if (!targetClip) {
      report.failures.push({ clipId: targetId, message: 'Clip not found.' })
      continue
    }
    const unitKey = targetClip.linkGroupId ?? targetClip.id
    if (unitKey === refUnitKey) {
      report.failures.push({ clipId: targetId, message: 'Clip is linked to the reference — they already move together.' })
      continue
    }
    if (seenUnits.has(unitKey)) continue
    seenUnits.add(unitKey)
    const unitClips = unit(targetClip)
    let tcHint: { clipId: string; rawStart: number } | null = null
    const carrier = refTC ? tcCarrier(unitClips) : null
    if (refTC && carrier) {
      const rawStart = timecodeAlignedStart({ ...refTC.clip, tc: refTC.tc }, { trimStartFrame: carrier.clip.trimStartFrame, tc: carrier.tc }, fps)
      if (mode === 'timecode') {
        placements.push({ clipId: carrier.clip.id, rawStart, confidence: 1, method: 'timecode', driftRatio: 0, retimedSpeed: null })
        continue
      }
      tcHint = { clipId: carrier.clip.id, rawStart }
    }
    if (mode === 'timecode') {
      report.failures.push({ clipId: targetId, message: refTC ? 'Clip has no source timecode.' : 'Reference has no source timecode.' })
      continue
    }
    const viaTimecode = () => {
      placements.push({ clipId: tcHint!.clipId, rawStart: tcHint!.rawStart, confidence: 1, method: 'timecode', driftRatio: 0, retimedSpeed: null })
    }
    const bearer = unitClips.find((c) => c.mediaType === 'audio' && captionCanTranscribe(ctx, c)) ?? unitClips.find((c) => captionCanTranscribe(ctx, c))
    if (!bearer) {
      if (tcHint) viaTimecode()
      else report.failures.push({ clipId: targetId, message: mode === 'auto' ? 'No source timecode, and clip has no audio.' : 'Clip has no audio.' })
      continue
    }
    const env = await envelopeOf(bearer)
    if (!env?.length) {
      if (tcHint) viaTimecode()
      else report.failures.push({ clipId: bearer.id, message: 'Clip has no audio.' })
      continue
    }
    if (!refAudioTried) {
      refAudioTried = true
      const refEnv = await envelopeOf(refClip)
      if (refEnv?.length) anchors.push({ rawStart: refClip.startFrame, clip: { clipId: refClip.id, samples: refEnv, speed: refClip.speed, mediaRef: refClip.mediaRef, trimStartFrame: refClip.trimStartFrame } })
    }
    const refAnchor = anchors[0]
    if (!refAnchor) {
      if (tcHint) viaTimecode()
      else report.failures.push({ clipId: bearer.id, message: mode === 'auto' && !refTC ? 'Reference has no source timecode or audio.' : 'Reference clip has no audio.' })
      continue
    }
    const clip: AudioClip = { clipId: bearer.id, samples: env, speed: bearer.speed, mediaRef: bearer.mediaRef, trimStartFrame: bearer.trimStartFrame }
    candidates.push({ clip, direct: await match(refAnchor, clip), tcRawStart: tcHint?.rawStart ?? null })
  }

  candidates.sort((a, b) => (b.direct?.confidence ?? 0) - (a.direct?.confidence ?? 0))
  for (const { clip, direct, tcRawStart } of candidates) {
    check()
    let best = direct
    for (const a of anchors.slice(1)) {
      const h = await match(a, clip)
      if (h && h.confidence > (best?.confidence ?? 0)) best = h
    }
    if (!best) {
      if (tcRawStart !== null) {
        placements.push({ clipId: clip.clipId, rawStart: tcRawStart, confidence: 1, method: 'timecode', driftRatio: 0, retimedSpeed: null })
        anchors.push({ rawStart: tcRawStart, clip })
        continue
      }
      report.failures.push({ clipId: clip.clipId, message: 'No confident alignment — clips may not overlap.' })
      continue
    }
    placements.push({ clipId: clip.clipId, rawStart: best.rawStart, confidence: best.confidence, method: 'audio', driftRatio: best.driftRatio, retimedSpeed: best.retimedSpeed })
    anchors.push({ rawStart: best.rawStart, clip })
  }
  check()

  // Move planning (validation before the group shift).
  type Move = { clipId: string; toTrack: number; toFrame: number }
  let allMoves: Move[] = []
  let movedIds = new Set<string>()
  let planned = new Map<string, number>()
  const plannedDuration = (id: string) => planned.get(id) ?? live(id)?.durationFrames ?? 0
  const refLoc = () => findClip(t, referenceClipId)
  const clobbersReference = (moves: Move[]) => {
    const loc = refLoc()
    if (!loc) return false
    return moves.some((m) => m.toTrack === loc.trackIndex && m.toFrame < endFrame(loc.clip) && loc.clip.startFrame < m.toFrame + plannedDuration(m.clipId))
  }
  const overlapsQueued = (moves: Move[]) =>
    moves.some((m) => {
      const end = m.toFrame + plannedDuration(m.clipId)
      return allMoves.some((o) => o.toTrack === m.toTrack && m.toFrame < o.toFrame + plannedDuration(o.clipId) && o.toFrame < end)
    })
  const queueMove = (clipId: string, rawStart: number): string | null => {
    const loc = findClip(t, clipId)
    if (!loc) return 'Clip not found.'
    const delta = rawStart - loc.clip.startFrame
    const moves: Move[] = [{ clipId, toTrack: loc.trackIndex, toFrame: rawStart }]
    for (const pid of linkedPartnerIds(t, clipId)) {
      if (pid === referenceClipId) continue
      const p = findClip(t, pid)
      if (p) moves.push({ clipId: pid, toTrack: p.trackIndex, toFrame: p.clip.startFrame + delta })
    }
    if (clipId !== referenceClipId && clobbersReference(moves)) return "Shares the reference's track — move it to its own track first."
    if (overlapsQueued(moves)) return 'Overlaps another clip being synced on the same track.'
    for (const m of moves) {
      if (movedIds.has(m.clipId)) continue
      movedIds.add(m.clipId)
      allMoves.push(m)
    }
    return null
  }
  const growthClobbers = (clipId: string, finalStart: number, newDuration: number) => {
    const loc = findClip(t, clipId)
    if (!loc) return false
    const grownStart = finalStart + loc.clip.durationFrames
    const grownEnd = finalStart + newDuration
    if (!(grownEnd > grownStart)) return false
    return loc.track.clips.some((c) => c.id !== clipId && !movedIds.has(c.id) && c.startFrame < grownEnd && endFrame(c) > grownStart)
  }

  let accepted: { clipId: string; rawStart: number; confidence: number; method: SyncMethod; currentStart: number }[] = []
  let retimes: { ids: string[]; speed: number; driftPpm: number; bearerId: string }[] = []
  let staged: { clipId: string; message: string }[] = []
  const skippedBearers: string[] = []
  let shift = 0
  for (;;) {
    allMoves = []
    movedIds = new Set()
    planned = new Map()
    accepted = []
    retimes = []
    staged = []
    for (const p of placements) {
      const clip = live(p.clipId)
      if (!clip) {
        staged.push({ clipId: p.clipId, message: 'Clip not found.' })
        continue
      }
      let retime: { ids: string[]; speed: number } | null = null
      if (p.retimedSpeed !== null && p.retimedSpeed !== clip.speed && !skippedBearers.includes(p.clipId)) {
        const ids = [p.clipId, ...linkedPartnerIds(t, p.clipId).filter((id) => id !== referenceClipId)]
        retime = { ids, speed: p.retimedSpeed }
        for (const id of ids) {
          const u = live(id)
          if (u) planned.set(id, retimedDurationFrames(u.durationFrames, u.speed, p.retimedSpeed))
        }
      }
      const failure = queueMove(p.clipId, p.rawStart)
      if (failure) {
        for (const id of retime?.ids ?? []) planned.delete(id)
        staged.push({ clipId: p.clipId, message: failure })
        continue
      }
      accepted.push({ clipId: p.clipId, rawStart: p.rawStart, confidence: p.confidence, method: p.method, currentStart: clip.startFrame })
      if (retime) retimes.push({ ...retime, driftPpm: p.driftRatio * 1_000_000, bearerId: p.clipId })
    }
    shift = Math.max(0, -Math.min(0, ...allMoves.map((m) => m.toFrame)))
    if (shift > 0) {
      const failure = live(referenceClipId) ? queueMove(referenceClipId, live(referenceClipId)!.startFrame) : 'Reference clip unavailable.'
      if (failure) {
        report.shiftedFrames = shift
        report.failures.push(...staged, ...accepted.map((a) => ({ clipId: a.clipId, message: failure })))
        return empty()
      }
    }
    const blocked = retimes
      .filter((r) =>
        r.ids.some((id) => {
          const m = allMoves.find((x) => x.clipId === id)
          const d = planned.get(id)
          return m && d !== undefined && growthClobbers(id, m.toFrame + shift, d)
        }),
      )
      .map((r) => r.bearerId)
    if (!blocked.length) break
    skippedBearers.push(...blocked)
  }
  report.shiftedFrames = shift
  report.failures.push(...staged)
  report.synced = accepted.map((a) => ({ clipId: a.clipId, offsetFrames: a.rawStart + shift - a.currentStart, confidence: a.confidence, method: a.method }))
  const acceptedIds = new Set(accepted.map((a) => a.clipId))
  report.retimeSkipped = skippedBearers.filter((id) => acceptedIds.has(id)).map((clipId) => ({ clipId, message: 'Drift correction skipped — it would overwrite an adjacent clip.' }))
  report.retimed = retimes.map((r) => ({ clipId: r.bearerId, driftPpm: r.driftPpm }))
  const retimedIds = new Set(retimes.flatMap((r) => r.ids))
  const moves = allMoves.flatMap((m) => {
    const c = live(m.clipId)
    return c && (m.toFrame + shift !== c.startFrame || retimedIds.has(m.clipId)) ? [{ ...m, toFrame: m.toFrame + shift }] : []
  })
  return { report, moves, retimes: retimes.map((r) => ({ ids: r.ids, speed: r.speed })) }
}

/** Commits a plan (`commitClipSpeed(…, ripple: false)` per retime, then one `moveClips`). */
export function applyClipSync(doc: Doc, plan: ClipSyncPlan): boolean {
  if (!plan.moves.length && !plan.retimes.length) return false
  for (const r of plan.retimes) {
    try {
      setClipSpeed(doc, r.ids, r.speed, false)
    } catch {
      // Unchanged speed: nothing to retime.
    }
  }
  if (plan.moves.length) moveClips(doc, plan.moves)
  return true
}
