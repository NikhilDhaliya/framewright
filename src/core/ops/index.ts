import type { CaptionClipSpec } from '../captions/captionBuilder'
import { placeCaptionTrack } from '../captions/placement'
import type { Interpolation } from '../keyframes'
import type { BlendMode, Clip, ClipType, Crop, MediaFolder, MediaManifestEntry, TimelineMarker, TimelineViewState, Transform } from '../model'
import { defaultTextStyle as defaultStyle } from '../model'
import { EditRefusal, findClip, setBlurKeyframeTrack } from '../timeline'
import * as C from './clips'
import { applyClipSettingsFrom, swapClipMedia } from './agent'
import type { VideoLayout } from './layout'
import * as M from './multicam'
import * as N from './nest'
import { activeTimeline, placeableAsset, type Doc, type Segment } from './context'
import * as P from './project'
import * as Pr from './properties'
import * as T from './tracks'
import * as U from './ui'

interface OpDef<A, R> {
  label: string | ((a: A) => string)
  /** false: applies without an undo step (navigation/view state). */
  history?: boolean
  run: (doc: Doc, args: A) => R
}

const op = <A, R>(def: OpDef<A, R>) => def

function clipOf(doc: Doc, id: string): Clip {
  const loc = findClip(activeTimeline(doc), id)
  if (!loc) throw new EditRefusal(`Clip ${id} not found.`)
  return loc.clip
}

export interface ClipPropertyPatch {
  opacity?: number
  rotation?: number
  crop?: Crop
  blur?: number
  volumeDb?: number
  volume?: number
  topLeft?: { x?: number; y?: number }
  size?: { width: number; height: number }
  transform?: Transform
  flipHorizontal?: boolean
  flipVertical?: boolean
  fadeIn?: number
  fadeOut?: number
  fadeInInterpolation?: Interpolation
  fadeOutInterpolation?: Interpolation
  blendMode?: BlendMode
  edgeRounding?: number
  edgeSoftness?: number
  textContent?: string
  textStyle?: Partial<NonNullable<Clip['textStyle']>>
  textAnimation?: Clip['textAnimation'] | null
  textFillMode?: Clip['textFillMode']
  textBox?: P.TextBox
}

/** Shared by the inspector, canvas gizmos and agent tools; animation-aware at `frame`. */
export function applyClipPatch(c: Clip, frame: number, p: ClipPropertyPatch): void {
  if (p.opacity !== undefined) Pr.writeOpacity(c, frame, p.opacity)
  if (p.rotation !== undefined) Pr.writeRotation(c, frame, p.rotation)
  if (p.crop) Pr.writeCrop(c, frame, p.crop)
  if (p.blur !== undefined) Pr.writeBlur(c, frame, p.blur)
  if (p.volumeDb !== undefined) Pr.writeVolumeDb(c, frame, p.volumeDb)
  if (p.volume !== undefined && Number.isFinite(p.volume)) c.volume = Math.min(5.623, Math.max(0, p.volume))
  if (p.transform) Pr.writeTransform(c, frame, p.transform)
  if (p.size) Pr.writeSize(c, frame, p.size.width, p.size.height)
  if (p.topLeft) Pr.writeTopLeft(c, frame, p.topLeft.x, p.topLeft.y)
  if (p.flipHorizontal !== undefined) c.transform.flipHorizontal = p.flipHorizontal
  if (p.flipVertical !== undefined) c.transform.flipVertical = p.flipVertical
  if (p.fadeIn !== undefined) Pr.setFade(c, 'in', p.fadeIn, p.fadeInInterpolation)
  else if (p.fadeInInterpolation) c.fadeInInterpolation = p.fadeInInterpolation
  if (p.fadeOut !== undefined) Pr.setFade(c, 'out', p.fadeOut, p.fadeOutInterpolation)
  else if (p.fadeOutInterpolation) c.fadeOutInterpolation = p.fadeOutInterpolation
  if (p.blendMode) Pr.setBlendMode(c, p.blendMode)
  if (p.edgeRounding !== undefined) c.edgeRounding = Pr.clamp01(p.edgeRounding)
  if (p.edgeSoftness !== undefined) c.edgeSoftness = Pr.clamp01(p.edgeSoftness)
  if (c.mediaType === 'text') {
    if (p.textContent !== undefined) c.textContent = p.textContent
    if (p.textStyle) {
      const prevBlur = c.textStyle?.blur
      c.textStyle = { ...(c.textStyle ?? defaultStyle()), ...p.textStyle }
      if (p.textStyle.blur !== undefined && p.textStyle.blur !== prevBlur) setBlurKeyframeTrack(c, undefined)
    }
    if (p.textAnimation === null) delete c.textAnimation
    else if (p.textAnimation) c.textAnimation = p.textAnimation
    if (p.textFillMode !== undefined) {
      if (p.textFillMode === 'color') delete c.textFillMode
      else c.textFillMode = p.textFillMode
    }
    if (p.textBox) P.fitTextBox(c, p.textBox)
  }
}


export const OPS = {
  addClips: op({
    label: 'Add Clips',
    run: (d, a: { assetIds: string[]; trackIndex: number; startFrame: number; linkedAudioTrackIndex?: number; segments?: Record<string, Segment> }) =>
      C.addClips(d, a.assetIds, a.trackIndex, a.startFrame, a.linkedAudioTrackIndex, a.segments),
  }),
  dropAssets: op({
    label: (a: { ripple: boolean }) => (a.ripple ? 'Ripple Insert Clips' : 'Add Clips'),
    run: (d, a: { assetIds: string[]; target: C.DropTarget; atFrame: number; ripple: boolean; segments?: Record<string, Segment>; rippleMarkers?: boolean }) =>
      C.placeDroppedAssets(d, a.assetIds, a.target, a.atFrame, a.ripple, a.segments, { rippleMarkers: a.rippleMarkers ?? true }),
  }),
  rippleInsert: op({
    label: 'Ripple Insert Clips',
    run: (d, a: { assetIds: string[]; trackIndex: number; atFrame: number; rippleMarkers?: boolean }) =>
      C.rippleInsertAssets(d, a.assetIds, a.trackIndex, a.atFrame, {}, { rippleMarkers: a.rippleMarkers ?? true }),
  }),
  moveClips: op({ label: (a: { moves: C.ClipMove[] }) => (a.moves.length === 1 ? 'Move Clip' : 'Move Clips'), run: (d, a: { moves: C.ClipMove[] }) => C.moveClips(d, a.moves) }),
  moveClipsToNewTrack: op({
    label: 'Move Clip to New Track',
    run: (d, a: { moves: C.ClipMove[]; newTrackAt: number; type: ClipType; leadTrack: number; pinned: string[]; duplicate: boolean }) => {
      const newIdx = addTrackAt(d, a.newTrackAt, a.type)
      const pinned = new Set(a.pinned)
      const moves = a.moves.map((m) => ({
        clipId: m.clipId,
        toFrame: m.toFrame,
        toTrack: !pinned.has(m.clipId) && m.toTrack === a.leadTrack ? newIdx : m.toTrack >= newIdx ? m.toTrack + 1 : m.toTrack,
      }))
      return a.duplicate ? C.duplicateClipsToPositions(d, moves) : C.moveClips(d, moves)
    },
  }),
  duplicateClips: op({ label: 'Duplicate Clips', run: (d, a: { moves: C.ClipMove[] }) => C.duplicateClipsToPositions(d, a.moves) }),
  pasteClips: op({
    label: 'Paste Clips',
    run: (d, a: { clipboard: C.ClipboardEntry[]; trackIndex: number | null; frame: number }) => C.pasteClips(d, a.clipboard, a.trackIndex, a.frame),
  }),
  deleteClips: op({ label: 'Remove Clips', run: (d, a: { ids: string[] }) => C.deleteClips(d, a.ids) }),
  rippleDeleteClips: op({ label: 'Ripple Delete', run: (d, a: { ids: string[]; rippleMarkers?: boolean }) => C.rippleDeleteClips(d, a.ids, { rippleMarkers: a.rippleMarkers ?? true }) }),
  rippleDeleteGap: op({ label: 'Ripple Delete', run: (d, a: { gap: C.Gap; rippleMarkers?: boolean }) => C.rippleDeleteGap(d, a.gap, { rippleMarkers: a.rippleMarkers ?? true }) }),
  rippleDeleteRanges: op({
    label: 'Ripple Delete',
    run: (d, a: { trackIndex: number; ranges: { start: number; end: number }[]; rippleMarkers?: boolean }) =>
      C.rippleDeleteRanges(d, a.trackIndex, a.ranges, { rippleMarkers: a.rippleMarkers ?? true }),
  }),
  liftRange: op({ label: 'Lift', run: (d, a: { start: number; end: number; trackIndices?: number[] }) => C.liftRange(d, a.start, a.end, a.trackIndices) }),
  splitAtFrame: op({ label: 'Split Clips', run: (d, a: { ids: string[]; frame: number }) => C.splitAtFrame(d, a.ids, a.frame) }),
  splitClip: op({ label: 'Split Clip', run: (d, a: { id: string; frame: number }) => C.splitAtFrame(d, [a.id], a.frame) }),
  trimEdge: op({
    label: 'Trim Clip',
    run: (d, a: { id: string; edge: C.Edge; delta: number; linked?: boolean }) => C.trimEdge(d, a.id, a.edge, a.delta, a.linked ?? true),
  }),
  trimToFrame: op({ label: 'Trim Clips', run: (d, a: { ids: string[]; frame: number; edge: C.Edge }) => C.trimToFrame(d, a.ids, a.frame, a.edge) }),
  rippleTrim: op({
    label: 'Ripple Trim',
    run: (d, a: { id: string; edge: C.Edge; delta: number; linked?: boolean; rippleMarkers?: boolean }) =>
      C.rippleTrim(d, a.id, a.edge, a.delta, a.linked ?? true, { rippleMarkers: a.rippleMarkers ?? true }),
  }),
  slipClip: op({ label: 'Slip Clip', run: (d, a: { id: string; delta: number; linked?: boolean }) => C.slipClip(d, a.id, a.delta, a.linked ?? true) }),
  setSpeed: op({ label: 'Change Speed', run: (d, a: { ids: string[]; speed: number; ripple?: boolean }) => C.setClipSpeed(d, a.ids, a.speed, a.ripple ?? true) }),
  linkClips: op({ label: 'Link', run: (d, a: { ids: string[] }) => C.linkClips(d, a.ids) }),
  unlinkClips: op({ label: 'Unlink', run: (d, a: { ids: string[] }) => C.unlinkClips(d, a.ids) }),

  setClipProperties: op({
    label: (a: { label?: string }) => a.label ?? 'Change Clip Property',
    run: (d, a: { ids: string[]; frame: number; patch: ClipPropertyPatch; label?: string }) =>
      Pr.mutateClips(d, a.ids, (c) => applyClipPatch(c, a.frame, a.patch)),
  }),
  replaceClip: op({
    label: (a: { label?: string }) => a.label ?? 'Change Clip Property',
    run: (d, a: { clip: Clip; label?: string }) => {
      const loc = findClip(activeTimeline(d), a.clip.id)
      if (!loc) throw new EditRefusal('Clip not found.')
      if (JSON.stringify(loc.clip) === JSON.stringify(a.clip)) throw new EditRefusal('Nothing changed.')
      loc.track.clips[loc.clipIndex] = a.clip
    },
  }),
  stampKeyframe: op({ label: 'Add Keyframe', run: (d, a: { id: string; property: Pr.AnimatableProperty; frame: number }) => Pr.stampKeyframe(d, a.id, a.property, a.frame) }),
  toggleKeyframe: op({ label: 'Add Keyframe', run: (d, a: { id: string; property: Pr.AnimatableProperty; frame: number }) => Pr.toggleKeyframe(d, a.id, a.property, a.frame) }),
  deleteKeyframe: op({ label: 'Delete Keyframe', run: (d, a: { id: string; property: Pr.AnimatableProperty; frame: number }) => Pr.deleteKeyframe(d, a.id, a.property, a.frame) }),
  setKeyframeInterpolation: op({
    label: 'Change Interpolation',
    run: (d, a: { id: string; property: Pr.AnimatableProperty; frame: number; interpolation: Interpolation }) => Pr.setKeyframeInterpolation(d, a.id, a.property, a.frame, a.interpolation),
  }),
  moveKeyframe: op({
    label: 'Move Keyframe',
    run: (d, a: { id: string; property: Pr.AnimatableProperty; from: number; to: number }) => Pr.moveKeyframeTo(d, a.id, a.property, a.from, a.to),
  }),
  clearKeyframes: op({ label: 'Delete Keyframes', run: (d, a: { id: string; property: Pr.AnimatableProperty }) => Pr.clearKeyframes(d, a.id, a.property) }),
  addEffect: op({ label: 'Add Effect', run: (d, a: { id: string; type: string; params?: Record<string, number> }) => Pr.addEffect(clipOf(d, a.id), a.type, a.params).id }),
  removeEffect: op({ label: 'Remove Effect', run: (d, a: { id: string; effect: string }) => Pr.removeEffect(clipOf(d, a.id), a.effect) }),
  setEffectParam: op({
    label: 'Change Effect',
    run: (d, a: { id: string; effect: string; key: string; value: number | string }) => Pr.setEffectParam(clipOf(d, a.id), a.effect, a.key, a.value),
  }),
  setEffectEnabled: op({ label: 'Toggle Effect', run: (d, a: { id: string; effect: string; enabled: boolean }) => Pr.setEffectEnabled(clipOf(d, a.id), a.effect, a.enabled) }),

  addTrack: op({ label: 'Add Track', run: (d, a: { at: number; type: ClipType }) => T.addTrack(d, a.at, a.type) }),
  removeTracks: op({ label: 'Remove Tracks', run: (d, a: { ids: string[] }) => T.removeTracks(d, a.ids) }),
  reorderTrack: op({ label: 'Reorder Track', run: (d, a: { id: string; targetIndex: number }) => T.reorderTrack(d, a.id, a.targetIndex) }),
  setTrackFlag: op({
    label: (a: { flag: T.TrackFlag; value: boolean }) =>
      ({ muted: a.value ? 'Mute Track' : 'Unmute Track', hidden: a.value ? 'Hide Track' : 'Show Track', syncLocked: a.value ? 'Sync Lock Track' : 'Unlock Track Sync' })[a.flag],
    run: (d, a: { trackIndex: number; flag: T.TrackFlag; value: boolean }) => T.setTrackFlag(d, a.trackIndex, a.flag, a.value),
  }),
  setTrackHeight: op({ label: 'Resize Track', run: (d, a: { trackIndex: number; height: number }) => T.setTrackHeight(d, a.trackIndex, a.height) }),
  renameTrack: op({ label: 'Rename Track', run: (d, a: { trackId: string; name: string }) => T.renameTrack(d, a.trackId, a.name) }),
  changeMarkers: op({ label: (a: { label?: string }) => a.label ?? 'Edit Marker', run: (d, a: T.MarkerChange & { label?: string }) => T.changeMarkers(d, a) }),

  addText: op({ label: 'Add Text', run: (d, a: { specs: P.TextSpec[]; newTrack?: boolean }) => P.addTextClips(d, a.specs, a.newTrack ?? true) }),
  /** Captions tab / subtitle drops (spec 07 §1.7.8): "Generate Captions" or "Add Captions". */
  placeCaptions: op({ label: (a: { actionName?: string }) => a.actionName ?? 'Generate Captions', run: (d, a: { specs: CaptionClipSpec[]; actionName?: string }) => placeCaptionTrack(d, a.specs) }),
  nestClips: op({ label: 'Nest Clips', run: (d, a: { ids: string[] }) => P.nestSelectedClips(d, a.ids) }),
  decomposeNest: op({ label: 'Decompose Nested Timeline', run: (d, a: { clipId: string }) => N.decomposeNest(d, a.clipId) }),
  /** 03 §4.15: `source` is the single clipboard clip of the targets' media type; text boxes measured by the renderer. */
  pasteClipSettings: op({
    label: 'Paste Clip Settings',
    run: (d, a: { source: Clip; targetIds: string[]; boxes?: Record<string, P.TextBox> }) => {
      if (!a.targetIds.length) throw new EditRefusal('Select clips to paste settings onto.')
      return applyClipSettingsFrom(d, a.source, a.targetIds, new Map(Object.entries(a.boxes ?? {})))
    },
  }),
  /** 03 §10.6 Swap Media: the clip (and its same-source linked partners) take `assetId`'s media. */
  swapClipMedia: op({
    label: 'Replace Clip Source',
    run: (d, a: { clipId: string; assetId: string }) => {
      const asset = placeableAsset(d, a.assetId)
      if (!asset) throw new EditRefusal(`Media not found: ${a.assetId}`)
      return swapClipMedia(d, a.clipId, asset, activeTimeline(d).fps)
    },
  }),
  /** Multicam (03 §12.3 UI): range switch / layout, single-clip angle or mic swap, ungroup. */
  switchAngle: op({
    label: 'Switch Angle',
    run: (d, a: { groupId: string; start: number; end: number; angles: string[]; layout?: VideoLayout }) => M.switchAngleInRange(d, a.groupId, a.start, a.end, a.angles, a.layout ?? 'full'),
  }),
  switchClipMember: op({
    label: (a: { mic?: boolean }) => (a.mic ? 'Switch Mic' : 'Switch Angle'),
    run: (d, a: { clipId: string; angle: string; mic?: boolean }) => M.switchClipMember(d, a.clipId, a.angle),
  }),
  ungroupMulticam: op({ label: 'Ungroup Multicam', run: (d, a: { groupId: string }) => M.ungroupMulticam(d, a.groupId) }),

  createTimeline: op({ label: 'New Timeline', run: (d, a: { name?: string; activate?: boolean }) => P.createTimeline(d, a.name, a.activate ?? true).id }),
  duplicateTimeline: op({ label: 'Duplicate Timeline', run: (d, a: { id: string }) => P.duplicateTimeline(d, a.id).id }),
  renameTimeline: op({ label: 'Rename Timeline', run: (d, a: { id: string; name: string }) => P.renameTimeline(d, a.id, a.name) }),
  deleteTimeline: op({ label: 'Delete Timeline', run: (d, a: { id: string }) => P.deleteTimeline(d, a.id) }),
  activateTimeline: op({ label: 'Activate Timeline', history: false, run: (d, a: { id: string }) => P.activateTimeline(d, a.id) }),
  closeTimelineTab: op({ label: 'Close Tab', history: false, run: (d, a: { id: string }) => P.closeTimelineTab(d, a.id) }),
  setViewState: op({
    label: 'View',
    history: false,
    run: (d, a: { timelineId: string; state: TimelineViewState }) => {
      d.file.viewStates = { ...(d.file.viewStates ?? {}), [a.timelineId]: a.state }
    },
  }),
  applyProjectSettings: op({ label: 'Change Project Settings', run: (d, a: { fps: number; width: number; height: number }) => P.applyTimelineSettings(d, a.fps, a.width, a.height) }),

  addMedia: op({ label: 'Import Media', run: (d, a: { entries: MediaManifestEntry[]; folders?: MediaFolder[] }) => P.addMediaEntries(d, a.entries, a.folders) }),
  updateMedia: op({ label: 'Update Media', history: false, run: (d, a: { id: string; patch: Partial<MediaManifestEntry> }) => P.updateMediaEntry(d, a.id, a.patch) }),
  renameMedia: op({ label: 'Rename Asset', run: (d, a: { id: string; name: string }) => P.renameMedia(d, a.id, a.name) }),
  deleteMedia: op({ label: 'Delete Media', run: (d, a: { ids: string[] }) => P.deleteMedia(d, a.ids) }),
  createFolder: op({ label: 'New Folder', run: (d, a: { name: string; parentFolderId?: string }) => P.createFolder(d, a.name, a.parentFolderId).id }),
  renameFolder: op({ label: 'Rename Folder', run: (d, a: { id: string; name: string }) => P.renameFolder(d, a.id, a.name) }),
  deleteFolders: op({ label: 'Delete Folder', run: (d, a: { ids: string[] }) => P.deleteFolders(d, a.ids) }),
  moveToFolder: op({
    label: 'Move to Folder',
    run: (d, a: { assets?: string[]; timelines?: string[]; folders?: string[]; folderId: string | null }) => P.moveToFolder(d, a, a.folderId),
  }),
  deleteMediaItems: op({
    label: (a: U.MediaItems) => ((a.assets?.length ?? 0) + (a.folders?.length ?? 0) + (a.timelines?.length ?? 0) > 1 ? 'Delete Media Items' : a.folders?.length ? 'Delete Folder' : a.timelines?.length ? 'Delete Timeline' : 'Delete Media'),
    run: (d, a: U.MediaItems) => U.deleteMediaItems(d, a),
  }),
  editEffects: op({ label: (a: { label?: string }) => a.label ?? 'Change Effect', run: (d, a: { ids: string[]; edits: U.EffectEdit[]; label?: string }) => U.editEffects(d, a.ids, a.edits) }),
} satisfies Record<string, OpDef<never, unknown>>

function addTrackAt(d: Doc, at: number, type: ClipType): number {
  return T.addTrack(d, at, type)
}

export type OpName = keyof typeof OPS
export type OpArgs<N extends OpName> = Parameters<(typeof OPS)[N]['run']>[1]
export type OpResult<N extends OpName> = ReturnType<(typeof OPS)[N]['run']>

export function opLabel<N extends OpName>(name: N, args: OpArgs<N>): string {
  const l = OPS[name].label as string | ((a: OpArgs<N>) => string)
  return typeof l === 'function' ? l(args) : l
}

export type { TimelineMarker }
export { C as clipOps, P as projectOps, Pr as propertyOps, T as trackOps }
