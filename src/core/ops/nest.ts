/** Decompose Nested Timeline (03 §8 `decomposeNest`): replace a nest carrier pair with its child's clips. */
import { blurKeyframeTrack, clampFadesToDuration, clampKeyframesToDuration, endFrame, freshenClipIds, lerpCrop, staticBlurRadius } from '../clip'
import { isActive, lerpNumber, lerpPair, rebaseTrack } from '../keyframes'
import { defaultCrop, fitTransform, type Clip, type ClipType, type Timeline } from '../model'
import { EditRefusal, findClip, insertTrack, pruneEmptyTracks, round, setBlurKeyframeTrack, sortClips } from '../timeline'
import { deepClone } from '../util'
import { activeTimeline, type Doc } from './context'

const isCarrier = (c: Clip) => c.sourceClipType === 'sequence'

/** NestFlattener.remap (04 §2.3.1): a child clip in parent frames, or null outside the carrier window. */
export function remapNestedClip(clip: Clip, carrier: Clip): Clip | null {
  const lo = carrier.trimStartFrame
  const hi = carrier.trimStartFrame + carrier.durationFrames
  const shift = carrier.startFrame - carrier.trimStartFrame
  const start = Math.max(clip.startFrame, lo)
  const end = Math.min(endFrame(clip), hi)
  if (end <= start) return null
  const c = deepClone(clip)
  const headCut = start - clip.startFrame
  if (headCut > 0) {
    c.trimStartFrame += round(headCut * c.speed)
    c.fadeInFrames = 0
    c.opacityTrack = rebaseTrack(c.opacityTrack, headCut, c.opacity, lerpNumber)
    c.volumeTrack = rebaseTrack(c.volumeTrack, headCut, 0, lerpNumber)
    c.positionTrack = rebaseTrack(c.positionTrack, headCut, { a: 0, b: 0 }, lerpPair)
    c.scaleTrack = rebaseTrack(c.scaleTrack, headCut, { a: 1, b: 1 }, lerpPair)
    c.rotationTrack = rebaseTrack(c.rotationTrack, headCut, 0, lerpNumber)
    c.cropTrack = rebaseTrack(c.cropTrack, headCut, c.crop, lerpCrop)
    setBlurKeyframeTrack(c, rebaseTrack(blurKeyframeTrack(c), headCut, staticBlurRadius(c), lerpNumber))
  }
  if (end < endFrame(clip)) c.fadeOutFrames = 0
  c.startFrame = start + shift
  c.durationFrames = end - start
  clampFadesToDuration(c)
  clampKeyframesToDuration(c)
  return c
}

/** Child lanes (visual: video && !hidden; audio: audio && !muted) remapped into parent frames; empty lanes dropped. */
export function flattenNestLanes(carrier: Clip, child: Timeline, visual: boolean): Clip[][] {
  const out: Clip[][] = []
  for (const track of child.tracks) {
    if (visual ? track.type !== 'video' || track.hidden : track.type !== 'audio' || track.muted) continue
    const clips = [...track.clips]
      .sort((a, b) => a.startFrame - b.startFrame)
      .map((c) => remapNestedClip(c, carrier))
      .filter((c): c is Clip => c !== null)
    if (clips.length) out.push(clips)
  }
  return out
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const anyKeyframes = (c: Clip) =>
  isActive(c.opacityTrack) || isActive(c.positionTrack) || isActive(c.scaleTrack) || isActive(c.rotationTrack) || isActive(c.cropTrack) || isActive(c.volumeTrack) || !!c.effects?.some((e) => Object.values(e.params).some((p) => p.track))

/** Video carrier settings that decompose can't carry over (the Mac's "group look"). */
function videoGroupLook(c: Clip, child: Timeline, t: Timeline): boolean {
  return (
    c.opacity !== 1 ||
    !same(c.crop, defaultCrop()) ||
    c.edgeRounding !== 0 ||
    c.edgeSoftness !== 0 ||
    !!c.effects?.length ||
    c.fadeInFrames > 0 ||
    c.fadeOutFrames > 0 ||
    (!!c.blendMode && c.blendMode !== 'normal') ||
    anyKeyframes(c) ||
    !same(c.transform, fitTransform(child.width, child.height, t.width, t.height))
  )
}

const audioGroupLook = (c: Clip) => c.fadeInFrames > 0 || c.fadeOutFrames > 0 || isActive(c.volumeTrack)

/** The carriers decompose would replace for `clipId` (its link-group carriers of the same child), or null. */
export function decomposeTargets(t: Timeline, doc: Doc, clipId: string): { video?: Clip; audio?: Clip; child: Timeline } | null {
  const clicked = findClip(t, clipId)?.clip
  if (!clicked || !isCarrier(clicked)) return null
  const child = doc.file.timelines.find((x) => x.id === clicked.mediaRef)
  if (!child || child.id === t.id) return null
  const members = clicked.linkGroupId ? t.tracks.flatMap((tr) => tr.clips.filter((c) => c.linkGroupId === clicked.linkGroupId)) : [clicked]
  const carriers = members.filter((c) => isCarrier(c) && c.mediaRef === child.id)
  return { video: carriers.find((c) => c.mediaType !== 'audio'), audio: carriers.find((c) => c.mediaType === 'audio'), child }
}

export interface DecomposeResult {
  clipIds: string[]
  /** True when carrier settings were dropped (toast "Nest settings discarded. Undo to restore."). */
  settingsDiscarded: boolean
}

export function decomposeNest(doc: Doc, clipId: string): DecomposeResult {
  const t = activeTimeline(doc)
  const targets = decomposeTargets(t, doc, clipId)
  if (!targets) throw new EditRefusal('Select a nested timeline clip to decompose.')
  const { child, video, audio } = targets
  const settingsDiscarded = (!!video && videoGroupLook(video, child, t)) || (!!audio && audioGroupLook(audio))
  const groups = new Map<string, string>()
  const clipIds: string[] = []
  const place = (carrier: Clip, lanes: Clip[][], type: ClipType, volumeScale: number) => {
    const loc = findClip(t, carrier.id)
    if (!loc) return
    loc.track.clips.splice(loc.clipIndex, 1)
    let idx = loc.trackIndex
    const lo = carrier.startFrame
    const hi = endFrame(carrier)
    for (const lane of lanes) {
      const tr = t.tracks[idx]
      const free = !!tr && tr.type === type && !tr.clips.some((c) => c.startFrame < hi && endFrame(c) > lo)
      if (!free) idx = insertTrack(t, idx, type)
      const track = t.tracks[idx]
      for (const c of lane) {
        freshenClipIds(c, groups)
        if (volumeScale !== 1) c.volume *= volumeScale
        track.clips.push(c)
        clipIds.push(c.id)
      }
      sortClips(track)
      idx++
    }
  }
  if (video) place(video, flattenNestLanes(video, child, true), 'video', 1)
  if (audio) place(audio, flattenNestLanes(audio, child, false), 'audio', audio.volume)
  pruneEmptyTracks(t)
  return { clipIds, settingsDiscarded }
}
