/** Multicam angle switching (the Mac's `MulticamEngine`) and program read-back over the active timeline. */
import { endFrame, sourceFramesConsumed } from '../clip'
import { defaultCrop, defaultTransform, fitTransform, newClip, newTrack, type Clip, type MulticamMember, type MulticamSource, type Timeline, type Track } from '../model'
import { EditRefusal, round, splitValues } from '../timeline'
import { activeTimeline, type Doc } from './context'
import { sourcePixelSize } from './agent'
import { layoutPlacement, layoutSlots, type VideoLayout } from './layout'

export interface AngleSwitch {
  start: number
  end: number
  /** Slot members in order; [0] fills the program slot. */
  slots: MulticamMember[]
  layout: VideoLayout
}

export interface SwitchOutcome {
  switched: number
  merged: number
  applied: [number, number][]
  clamped: { requested: [number, number]; applied: [number, number]; culprit: string }[]
  skipped: { range: [number, number]; reason: string }[]
  overlayClipIds: string[]
}

export const memberUsable = (m: MulticamMember) => m.sync.confidence > 0 || m.sync.locked
const offsetFrames = (m: MulticamMember, fps: number) => round(m.sync.offsetSeconds * fps)
const anchorFrame = (m: MulticamMember, c: Clip, fps: number) => c.startFrame - c.trimStartFrame - offsetFrames(m, fps)
const memberFor = (g: MulticamSource, mediaRef: string) => g.members.find((m) => m.mediaRef === mediaRef)
const overlaps = (c: Clip, s: number, e: number) => c.startFrame < e && endFrame(c) > s
const isProgram = (c: Clip, g: MulticamSource) => c.multicamGroupId === g.id && c.mediaType !== 'audio'
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

export function multicamGroup(doc: Doc, id: string): MulticamSource | undefined {
  return doc.file.multicamGroups?.find((g) => g.id === id)
}

/** Resolves an angle label to a usable video-providing member. */
export function resolveAngle(g: MulticamSource, label: string): MulticamMember {
  const member = g.members.find((m) => m.angleLabel.toLowerCase() === label.toLowerCase())
  if (!member || member.kind === 'mic') {
    const angles = g.members.filter((m) => m.kind !== 'mic' && memberUsable(m)).map((m) => m.angleLabel)
    throw new EditRefusal(`Unknown angle '${label}'. Angles: ${angles.join(', ')}.`)
  }
  if (!memberUsable(member)) throw new EditRefusal(`Angle '${label}' isn't synced — pin an offset or recreate the group.`)
  return member
}

function sourceDurations(doc: Doc, g: MulticamSource): Map<string, number> {
  const out = new Map<string, number>()
  for (const m of g.members) {
    const e = doc.manifest.entries.find((x) => x.id === m.mediaRef)
    if (e) out.set(m.mediaRef, e.duration)
  }
  return out
}

function splitTrack(track: Track, frame: number, groupId?: string): void {
  const i = track.clips.findIndex((c) => frame > c.startFrame && frame < endFrame(c) && (!groupId || c.multicamGroupId === groupId))
  if (i < 0) return
  const parts = splitValues(track.clips[i], frame)
  if (parts) track.clips.splice(i, 1, ...parts)
}

function rewrite(c: Clip, g: MulticamSource, to: MulticamMember, durations: Map<string, number>, fps: number): void {
  const current = memberFor(g, c.mediaRef)
  if (c.mediaRef === to.mediaRef || !current) return
  c.mediaRef = to.mediaRef
  c.trimStartFrame += round((current.sync.offsetSeconds - to.sync.offsetSeconds) * fps)
  const duration = durations.get(to.mediaRef)
  c.trimEndFrame = duration !== undefined ? Math.max(0, round(duration * fps) - c.trimStartFrame - sourceFramesConsumed(c)) : 0
}

const hasKeyframes = (c: Clip) =>
  !!(c.opacityTrack || c.positionTrack || c.scaleTrack || c.rotationTrack || c.cropTrack || c.volumeTrack) || !!c.effects?.some((e) => e.type === 'blur.gaussian' && e.params.radius?.track)

function isThroughEdit(a: Clip, b: Clip): boolean {
  return (
    a.mediaRef === b.mediaRef &&
    a.mediaType === b.mediaType &&
    a.multicamGroupId === b.multicamGroupId &&
    b.startFrame === endFrame(a) &&
    b.trimStartFrame === a.trimStartFrame + sourceFramesConsumed(a) &&
    a.speed === b.speed &&
    a.volume === b.volume &&
    a.opacity === b.opacity &&
    same(a.transform, b.transform) &&
    same(a.crop, b.crop) &&
    a.edgeRounding === b.edgeRounding &&
    a.edgeSoftness === b.edgeSoftness &&
    same(a.effects, b.effects) &&
    a.blendMode === b.blendMode &&
    a.fadeOutFrames === 0 &&
    b.fadeInFrames === 0 &&
    !hasKeyframes(a) &&
    !hasKeyframes(b)
  )
}

function joinThroughEdits(track: Track, start: number, end: number, groupId: string): number {
  const clips = [...track.clips].sort((a, b) => a.startFrame - b.startFrame)
  let merged = 0
  let i = 0
  while (i + 1 < clips.length) {
    const seam = endFrame(clips[i])
    if (clips[i].multicamGroupId === groupId && start <= seam && seam <= end && isThroughEdit(clips[i], clips[i + 1])) {
      clips[i] = { ...clips[i], durationFrames: clips[i].durationFrames + clips[i + 1].durationFrames, trimEndFrame: clips[i + 1].trimEndFrame, fadeOutFrames: clips[i + 1].fadeOutFrames }
      clips.splice(i + 1, 1)
      merged++
    } else i++
  }
  track.clips = clips
  return merged
}

function clearOverlays(t: Timeline, start: number, end: number, programIdx: number, groupId: string): number {
  let removed = 0
  for (const track of t.tracks.slice(0, programIdx)) {
    splitTrack(track, start, groupId)
    splitTrack(track, end, groupId)
    const before = track.clips.length
    track.clips = track.clips.filter((c) => !(c.multicamGroupId === groupId && c.startFrame >= start && endFrame(c) <= end))
    removed += before - track.clips.length
  }
  return removed
}

/** Applies angle switches in order (later entries win); each batch is one edit. */
export function switchMulticamAngles(doc: Doc, groupId: string, entries: AngleSwitch[]): SwitchOutcome {
  const t = activeTimeline(doc)
  const g = multicamGroup(doc, groupId)
  if (!g) throw new EditRefusal(`Not a multicam group: ${groupId}`)
  if (!t.tracks.some((tr) => tr.clips.some((c) => c.multicamGroupId === groupId))) throw new EditRefusal('The group has no clips on the active timeline.')
  const fps = t.fps
  const durations = sourceDurations(doc, g)
  const canvas = { width: t.width, height: t.height }
  const fit = (c: Clip) => {
    const size = sourcePixelSize(doc, c)
    return size ? fitTransform(size.width, size.height, t.width, t.height) : defaultTransform()
  }
  const out: SwitchOutcome = { switched: 0, merged: 0, applied: [], clamped: [], skipped: [], overlayClipIds: [] }
  for (const entry of entries) {
    if (!(entry.end > entry.start)) continue
    const target = entry.slots[0]
    const slots = layoutSlots(entry.layout)
    const program = [...t.tracks].reverse().find((tr) => tr.type === 'video' && tr.clips.some((c) => isProgram(c, g) && overlaps(c, entry.start, entry.end)))
    if (!program) {
      out.skipped.push({ range: [entry.start, entry.end], reason: 'no multicam clip in this range' })
      continue
    }
    const fragmentIds = program.clips.filter((c) => isProgram(c, g) && overlaps(c, entry.start, entry.end)).map((c) => c.id)
    for (const fid of fragmentIds) {
      const fragment = program.clips.find((c) => c.id === fid)
      const member = fragment && memberFor(g, fragment.mediaRef)
      if (!fragment || !member) continue
      const wanted: [number, number] = [Math.max(entry.start, fragment.startFrame), Math.min(entry.end, endFrame(fragment))]
      let range: [number, number] = wanted
      let culprit: string | null = null
      const duration = durations.get(target.mediaRef)
      if (duration !== undefined) {
        const groupStart = fragment.trimStartFrame / fps + member.sync.offsetSeconds
        const project = (s: number) => fragment.startFrame + round((s - groupStart) * fps)
        range = [Math.max(wanted[0], project(target.sync.offsetSeconds)), Math.min(wanted[1], project(target.sync.offsetSeconds + duration))]
        if (range[1] < range[0]) range = [range[0], range[0]]
        if (range[0] !== wanted[0] || range[1] !== wanted[1]) culprit = target.angleLabel
      }
      if (range[1] <= range[0]) {
        out.skipped.push({ range: wanted, reason: `${culprit ?? 'an angle'} wasn't recording here` })
        continue
      }
      if (culprit) out.clamped.push({ requested: wanted, applied: range, culprit })
      const [lo, hi] = range
      const hadLayout = clearOverlays(t, lo, hi, t.tracks.indexOf(program), g.id) > 0
      entry.slots.slice(1).forEach((slotMember, k) => {
        const rect = slots[k + 1]?.rect
        if (!rect) return
        const clip = newClip({ mediaRef: slotMember.mediaRef, startFrame: lo, durationFrames: hi - lo, multicamGroupId: g.id })
        clip.trimStartFrame = lo - anchorFrame(member, fragment, fps) - offsetFrames(slotMember, fps)
        const d = durations.get(slotMember.mediaRef)
        if (d !== undefined) clip.trimEndFrame = Math.max(0, round(d * fps) - clip.trimStartFrame - sourceFramesConsumed(clip))
        const placed = layoutPlacement(sourcePixelSize(doc, clip), canvas, rect, 'fill')
        clip.transform = placed.transform
        clip.crop = placed.crop
        const programIdx = t.tracks.indexOf(program)
        let idx = -1
        for (let i = programIdx - 1; i >= 0; i--) {
          if (t.tracks[i].type === 'video' && !t.tracks[i].clips.some((c) => overlaps(c, lo, hi))) {
            idx = i
            break
          }
        }
        if (idx < 0) {
          t.tracks.splice(programIdx, 0, newTrack('video'))
          idx = programIdx
        }
        t.tracks[idx].clips.push(clip)
        t.tracks[idx].clips.sort((a, b) => a.startFrame - b.startFrame)
        out.overlayClipIds.push(clip.id)
      })
      splitTrack(program, lo)
      splitTrack(program, hi)
      for (const c of program.clips) {
        if (!(isProgram(c, g) && c.startFrame >= lo && endFrame(c) <= hi)) continue
        const wasDefaultFit = same(c.transform, fit(c)) && same(c.crop, defaultCrop())
        rewrite(c, g, target, durations, fps)
        if (entry.layout !== 'full' && slots[0]) {
          const placed = layoutPlacement(sourcePixelSize(doc, c), canvas, slots[0].rect, 'fill')
          c.transform = placed.transform
          c.crop = placed.crop
        } else if (wasDefaultFit || hadLayout) {
          c.transform = fit(c)
          if (hadLayout) c.crop = defaultCrop()
        }
        out.switched++
      }
      out.merged += joinThroughEdits(program, lo, hi, g.id)
      out.applied.push(range)
    }
  }
  return out
}

/** Run-length `[angle, start, end]` rows of the program track, optionally clamped to a window. */
export function programRows(doc: Doc, groupId: string, window?: { start: number; end: number } | null): [string, number, number][] {
  const g = multicamGroup(doc, groupId)
  const t = activeTimeline(doc)
  if (!g) return []
  const programIdx = t.tracks.reduce((best, tr, i) => (tr.type === 'video' && tr.clips.some((c) => isProgram(c, g)) ? i : best), -1)
  if (programIdx < 0) return []
  const rows: [string, number, number][] = []
  for (const c of [...t.tracks[programIdx].clips].filter((c) => isProgram(c, g)).sort((a, b) => a.startFrame - b.startFrame)) {
    let [s, e] = [c.startFrame, endFrame(c)]
    if (window) [s, e] = [Math.min(Math.max(s, window.start), window.end), Math.min(Math.max(e, window.start), window.end)]
    if (e <= s) continue
    const label = memberFor(g, c.mediaRef)?.angleLabel ?? ''
    const last = rows[rows.length - 1]
    if (last && last[0] === label && last[2] === s) last[2] = e
    else rows.push([label, s, e])
  }
  return rows
}

export function multicamTrackIndexes(doc: Doc, groupId: string): number[] {
  return activeTimeline(doc).tracks.flatMap((tr, i) => (tr.clips.some((c) => c.multicamGroupId === groupId) ? [i] : []))
}

// ---------- Timeline UI (05 §6.14 Multicam group, 03 §12.3 "UI") ----------

/** Usable picture members (`kind ≠ mic`), in group order. */
export const angleMembers = (g: MulticamSource): MulticamMember[] => g.members.filter((m) => m.kind !== 'mic' && memberUsable(m))

/** Usable audio bearers: `kind ≠ angle`, or an angle whose asset has audio. */
export function micMembers(doc: Doc, g: MulticamSource): MulticamMember[] {
  return g.members.filter((m) => {
    if (!memberUsable(m)) return false
    if (m.kind !== 'angle') return true
    const e = doc.manifest.entries.find((x) => x.id === m.mediaRef)
    return !!e && (e.type === 'audio' || !!e.hasAudio)
  })
}

export const memberOfClip = (g: MulticamSource, c: Clip): MulticamMember | undefined => memberFor(g, c.mediaRef)

/** Index of the program track over [start, end): the bottom-most video track with a group fragment there. */
export function programTrackIndex(t: Timeline, g: MulticamSource, start: number, end: number): number {
  for (let i = t.tracks.length - 1; i >= 0; i--) {
    const tr = t.tracks[i]
    if (tr.type === 'video' && tr.clips.some((c) => isProgram(c, g) && overlaps(c, start, end))) return i
  }
  return -1
}

/** True when `clipId` is a program fragment (not an audio clip and not a layout overlay). */
export function isProgramFragment(doc: Doc, clipId: string): boolean {
  const t = activeTimeline(doc)
  const i = t.tracks.findIndex((tr) => tr.clips.some((c) => c.id === clipId))
  const c = i >= 0 ? t.tracks[i].clips.find((x) => x.id === clipId) : undefined
  const g = c?.multicamGroupId ? multicamGroup(doc, c.multicamGroupId) : undefined
  return !!c && !!g && isProgram(c, g) && programTrackIndex(t, g, c.startFrame, endFrame(c)) === i
}

/** Ids of the multicam groups with a clip overlapping [start, end) on the active timeline. */
export function groupsInRange(doc: Doc, start: number, end: number): string[] {
  const ids = new Set<string>()
  for (const tr of activeTimeline(doc).tracks) for (const c of tr.clips) if (c.multicamGroupId && overlaps(c, start, end) && multicamGroup(doc, c.multicamGroupId)) ids.add(c.multicamGroupId)
  return [...ids]
}

/**
 * Range switch from the UI (Switch Angle on a program fragment, Layout ▸, Switch Angle in Range ▸):
 * `labels[0]` fills the program slot, the rest fill the layout's other slots in order.
 */
export function switchAngleInRange(doc: Doc, groupId: string, start: number, end: number, labels: string[], layout: VideoLayout = 'full'): SwitchOutcome {
  const g = multicamGroup(doc, groupId)
  if (!g) throw new EditRefusal(`Not a multicam group: ${groupId}`)
  if (!labels.length) throw new EditRefusal('Pick an angle.')
  const slots = labels.slice(0, layoutSlots(layout).length).map((l) => resolveAngle(g, l))
  const out = switchMulticamAngles(doc, groupId, [{ start, end, slots, layout }])
  if (!out.applied.length) throw new EditRefusal(out.skipped[0] ? `Couldn't switch: ${out.skipped[0].reason}.` : 'Nothing to switch here.')
  return out
}

/** Single-clip member swap: audio clips (Switch Mic) and layout overlays (Switch Angle). */
export function switchClipMember(doc: Doc, clipId: string, label: string): void {
  const t = activeTimeline(doc)
  const c = t.tracks.flatMap((tr) => tr.clips).find((x) => x.id === clipId)
  const g = c?.multicamGroupId ? multicamGroup(doc, c.multicamGroupId) : undefined
  if (!c || !g) throw new EditRefusal('Not a multicam clip.')
  const audio = c.mediaType === 'audio'
  const pool = audio ? micMembers(doc, g) : angleMembers(g)
  const to = pool.find((m) => m.angleLabel.toLowerCase() === label.toLowerCase())
  if (!to) {
    if (!audio) resolveAngle(g, label)
    throw new EditRefusal(`Unknown mic '${label}'. Mics: ${pool.map((m) => m.angleLabel).join(', ')}.`)
  }
  if (!memberFor(g, c.mediaRef)) throw new EditRefusal("This clip's member is no longer in the group.")
  if (c.mediaRef === to.mediaRef) throw new EditRefusal('Already on that angle.')
  rewrite(c, g, to, sourceDurations(doc, g), t.fps)
}

/** "Ungroup Multicam": clears the group id on the active timeline; drops the group once nothing references it. */
export function ungroupMulticam(doc: Doc, groupId: string): void {
  if (!multicamGroup(doc, groupId)) throw new EditRefusal(`Not a multicam group: ${groupId}`)
  for (const tr of activeTimeline(doc).tracks) for (const c of tr.clips) if (c.multicamGroupId === groupId) delete c.multicamGroupId
  const referenced = doc.file.timelines.some((t) => t.tracks.some((tr) => tr.clips.some((c) => c.multicamGroupId === groupId)))
  if (!referenced && doc.file.multicamGroups) doc.file.multicamGroups = doc.file.multicamGroups.filter((g) => g.id !== groupId)
}
