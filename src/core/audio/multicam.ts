/**
 * Multicam analysis + creation (spec 07 §5.2, 03 §12.2): member sync over 2.5 ms envelopes with the correlator, and
 * `createMulticamGroup` (program track + one audio track per mic). Pure apart from the injected readers.
 */
import { sourceFramesConsumed } from '../clip'
import type { SourceTiming } from '../interchange/timecode'
import { timecodeSeconds } from '../interchange/timecode'
import { defaultTransform, fitTransform, newClip, newId, type Clip, type MulticamMember, type MulticamSource, type SyncMap } from '../model'
import { activeTimeline, placeableAsset, type Doc } from '../ops/context'
import { EditRefusal, insertTrack, round, sortAllClips, totalFrames } from '../timeline'
import { maxLagHops, seededCorrelate } from './correlator'
import { ENVELOPE_HOP_SECONDS } from './envelope'

export type MemberKind = MulticamMember['kind']

export interface MemberSpec {
  mediaRef: string
  kind: MemberKind
  angleLabel?: string
  pinnedOffsetSeconds?: number
}

/** `SyncDefaults`. */
export const SYNC_DEFAULTS = {
  minConfidence: 0.5,
  seedWindowHops: round(3 / ENVELOPE_HOP_SECONDS),
  minOverlapHops: Math.max(16, round(3 / ENVELOPE_HOP_SECONDS)),
  memberSearchWindowSeconds: 240,
  /** Multicam envelopes cover the first `window + 300` s of each file. */
  envelopeExtraSeconds: 300,
} as const

export interface MemberSyncDeps {
  timing(refs: string[]): Promise<Record<string, SourceTiming>>
  /** 2.5 ms loudness envelope of `[0, seconds)`; null/empty when the file has no readable audio. */
  envelope(ref: string, seconds: number): Promise<Float32Array | null>
  /** Correlation runner (a worker thread in the app; inline in tests). */
  correlate?: (a: Parameters<typeof seededCorrelate>[0]) => Promise<ReturnType<typeof seededCorrelate>>
  isCancelled?: () => boolean
}

export interface MemberSyncResult {
  maps: Record<string, SyncMap>
  failures: [string, string][]
}

const rebase = (maps: Record<string, SyncMap>): Record<string, SyncMap> => {
  const usable = Object.values(maps).filter((m) => m.confidence > 0 || m.locked)
  if (!usable.length) return maps
  const base = Math.min(...usable.map((m) => m.offsetSeconds))
  for (const m of usable) m.offsetSeconds -= base
  return maps
}

/** `syncMulticamMembers` (07 §5.2). Drift is ignored for members. */
export async function syncMulticamMembers(specs: MemberSpec[], masterRef: string, deps: MemberSyncDeps, searchWindowSeconds: number = SYNC_DEFAULTS.memberSearchWindowSeconds, doRebase = true): Promise<MemberSyncResult> {
  const maps: Record<string, SyncMap> = {}
  const failures: [string, string][] = []
  const pending: MemberSpec[] = []
  const finish = () => ({ maps: doRebase ? rebase(maps) : maps, failures })
  for (const s of specs) {
    if (s.pinnedOffsetSeconds !== undefined && s.pinnedOffsetSeconds !== null) maps[s.mediaRef] = { offsetSeconds: s.pinnedOffsetSeconds, confidence: 1, locked: true }
    else if (s.mediaRef === masterRef) maps[s.mediaRef] = { offsetSeconds: 0, confidence: 1, locked: false }
    else pending.push(s)
  }
  if (!pending.length) return finish()
  const timing = await deps.timing([masterRef, ...pending.map((p) => p.mediaRef)])
  const masterOffset = maps[masterRef]?.offsetSeconds ?? 0
  const resolveWithoutAudio = (ref: string, reason: string) => {
    const a = timing[masterRef]?.timecode
    const b = timing[ref]?.timecode
    if (a && b) maps[ref] = { offsetSeconds: masterOffset + timecodeSeconds(b) - timecodeSeconds(a), confidence: 1, locked: false }
    else {
      maps[ref] = { offsetSeconds: 0, confidence: 0, locked: false }
      failures.push([ref, reason])
    }
  }
  const span = searchWindowSeconds + SYNC_DEFAULTS.envelopeExtraSeconds
  const masterEnv = await deps.envelope(masterRef, span).catch(() => null)
  if (!masterEnv?.length) {
    failures.push([masterRef, 'Master has no readable audio.'])
    for (const p of pending) resolveWithoutAudio(p.mediaRef, 'No audio to sync with and no shared timecode.')
    return finish()
  }
  const envs = await Promise.all(pending.map((p) => deps.envelope(p.mediaRef, span).catch(() => null)))
  const withAudio: { spec: MemberSpec; samples: Float32Array }[] = []
  pending.forEach((p, i) => {
    const e = envs[i]
    if (!e?.length) resolveWithoutAudio(p.mediaRef, 'No readable audio to sync with.')
    else withAudio.push({ spec: p, samples: e })
  })
  const run = deps.correlate ?? (async (a) => seededCorrelate(a))
  const anchors: { offset: number; ref: string; samples: Float32Array }[] = [{ offset: masterOffset, ref: masterRef, samples: masterEnv }]
  const match = async (anchor: (typeof anchors)[number], ref: string, samples: Float32Array) => {
    const da = timing[anchor.ref]?.captureDate
    const db = timing[ref]?.captureDate
    const seed = da && db ? round((db.getTime() - da.getTime()) / 1000 / ENVELOPE_HOP_SECONDS) : null
    const r = await run({
      reference: anchor.samples,
      target: samples,
      seedHops: seed,
      seedWindowHops: SYNC_DEFAULTS.seedWindowHops,
      maxLagHops: maxLagHops(searchWindowSeconds, ENVELOPE_HOP_SECONDS, anchor.samples.length, samples.length),
      minOverlapHops: SYNC_DEFAULTS.minOverlapHops,
      minConfidence: SYNC_DEFAULTS.minConfidence,
      isCancelled: deps.isCancelled,
    })
    return r ? { offset: anchor.offset + r.exactLagHops * ENVELOPE_HOP_SECONDS, confidence: r.confidence } : null
  }
  const candidates = await Promise.all(withAudio.map(async (c) => ({ ...c, direct: await match(anchors[0], c.spec.mediaRef, c.samples) })))
  candidates.sort((a, b) => (b.direct?.confidence ?? 0) - (a.direct?.confidence ?? 0))
  for (const c of candidates) {
    if (deps.isCancelled?.()) break
    let best = c.direct
    for (const a of anchors.slice(1)) {
      const h = await match(a, c.spec.mediaRef, c.samples)
      if (h && h.confidence > (best?.confidence ?? 0)) best = h
    }
    if (!best) resolveWithoutAudio(c.spec.mediaRef, 'No confident alignment — pin an offset or re-sync with a wider window.')
    else {
      maps[c.spec.mediaRef] = { offsetSeconds: best.offset, confidence: round(best.confidence * 1000) / 1000, locked: false }
      anchors.push({ offset: best.offset, ref: c.spec.mediaRef, samples: c.samples })
    }
  }
  return finish()
}

/** `uniqueAngleLabel`: slug, deduped as x, x-2, x-3, … */
export function uniqueAngleLabel(raw: string, taken: Set<string>): string {
  let base = raw
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!base) base = 'angle'
  let label = base
  for (let n = 2; taken.has(label); n++) label = `${base}-${n}`
  taken.add(label)
  return label
}

export interface CreateMulticamResult {
  groupId: string
  clipIds: string[]
  members: MulticamMember[]
}

const providesVideo = (k: MemberKind) => k !== 'mic'
const providesAudio = (k: MemberKind) => k !== 'angle'
const usable = (m: SyncMap) => m.confidence > 0 || m.locked

/** `createMulticamGroup` (03 §12.2) on the active timeline. */
export function createMulticamGroup(doc: Doc, specs: MemberSpec[], maps: Record<string, SyncMap>, masterRef: string, name?: string, startFrame?: number): CreateMulticamResult {
  const t = activeTimeline(doc)
  const fps = t.fps
  const taken = new Set<string>()
  const members: MulticamMember[] = specs.map((s) => ({
    id: newId(),
    mediaRef: s.mediaRef,
    kind: s.kind,
    angleLabel: uniqueAngleLabel(s.angleLabel ?? placeableAsset(doc, s.mediaRef)?.name ?? s.mediaRef, taken),
    sync: maps[s.mediaRef] ?? { offsetSeconds: 0, confidence: 0, locked: false },
  }))
  const master = members.find((m) => m.mediaRef === masterRef)
  if (!master) throw new EditRefusal('The master member is missing.')
  const groups = doc.file.multicamGroups ?? []
  const groupName = name?.trim() || `Multicam ${groups.length + 1}`
  const at = startFrame ?? totalFrames(t)
  const duration = (m: MulticamMember) => placeableAsset(doc, m.mediaRef)?.duration
  const coverage = (m: MulticamMember): [number, number] | null => {
    const d = duration(m)
    if (d === undefined || !(d > 0)) return null
    const lo = round(m.sync.offsetSeconds * fps)
    return [lo, Math.max(lo, round((m.sync.offsetSeconds + d) * fps))]
  }
  const angles = members.filter((m) => providesVideo(m.kind) && usable(m.sync))
  const mics = members.filter((m) => providesAudio(m.kind) && usable(m.sync))
  const angleRanges = angles.map((m) => ({ m, r: coverage(m) })).filter((x): x is { m: MulticamMember; r: [number, number] } => !!x.r)
  const groupId = newId()
  const clipIds: string[] = []
  const videoStart = angleRanges.length ? Math.min(...angleRanges.map((a) => a.r[0])) : Math.min(...mics.map((m) => coverage(m)?.[0] ?? 0), 0)
  const groupOrigin = at - videoStart
  const memberClip = (m: MulticamMember, range: [number, number], type: 'video' | 'audio'): Clip | null => {
    const start = groupOrigin + range[0]
    const lo = Math.max(0, start)
    const hi = groupOrigin + range[1]
    if (!(hi > lo)) return null
    const asset = placeableAsset(doc, m.mediaRef)!
    const headCut = lo - start
    const c = newClip({
      mediaRef: m.mediaRef,
      startFrame: lo,
      durationFrames: hi - lo,
      mediaType: type,
      sourceClipType: asset.type === 'sequence' ? 'video' : (asset.type as Clip['sourceClipType']),
      multicamGroupId: groupId,
      trimStartFrame: round((range[0] / fps - m.sync.offsetSeconds) * fps) + headCut,
    })
    c.trimEndFrame = Math.max(0, round(asset.duration * fps) - c.trimStartFrame - sourceFramesConsumed(c))
    c.transform = type === 'video' && asset.sourceWidth && asset.sourceHeight ? fitTransform(asset.sourceWidth, asset.sourceHeight, t.width, t.height) : defaultTransform()
    return c
  }
  if (angleRanges.length) {
    const videoEnd = Math.max(...angleRanges.map((a) => a.r[1]))
    if (videoStart < videoEnd) {
      let holes: [number, number][] = [[videoStart, videoEnd]]
      const spans: { m: MulticamMember; r: [number, number] }[] = []
      for (const a of angleRanges) {
        const next: [number, number][] = []
        for (const h of holes) {
          const lo = Math.max(h[0], a.r[0])
          const hi = Math.min(h[1], a.r[1])
          if (!(hi > lo)) {
            next.push(h)
            continue
          }
          spans.push({ m: a.m, r: [lo, hi] })
          if (h[0] < lo) next.push([h[0], lo])
          if (hi < h[1]) next.push([hi, h[1]])
        }
        holes = next
        if (!holes.length) break
      }
      spans.sort((x, y) => x.r[0] - y.r[0])
      const v = insertTrack(t, 0, 'video')
      for (const s of spans) {
        const c = memberClip(s.m, s.r, 'video')
        if (c) {
          t.tracks[v].clips.push(c)
          clipIds.push(c.id)
        }
      }
    }
  }
  let ai = t.tracks.length
  for (const m of mics) {
    const r = coverage(m)
    if (!r) continue
    const c = memberClip(m, r, 'audio')
    if (!c) continue
    const idx = insertTrack(t, ai, 'audio')
    t.tracks[idx].clips.push(c)
    t.tracks[idx].syncLocked = true
    clipIds.push(c.id)
    ai = idx + 1
  }
  if (!clipIds.length) throw new EditRefusal('No member could be placed on the timeline.')
  for (const tr of t.tracks) if (tr.clips.some((c) => c.multicamGroupId === groupId)) tr.syncLocked = true
  sortAllClips(t)
  const group: MulticamSource = { id: groupId, name: groupName, members, masterMemberId: master.id }
  doc.file.multicamGroups = [...groups, group]
  return { groupId, clipIds, members }
}
