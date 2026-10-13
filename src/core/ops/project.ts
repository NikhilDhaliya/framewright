import { deepClone } from '../util'
import { endFrame } from '../clip'
import { isActive } from '../keyframes'
import {
  DEFAULTS,
  defaultTextStyle,
  fitTransform,
  newClip,
  newId,
  newTimeline,
  type MediaFolder,
  type MediaManifestEntry,
  type TextAnimation,
  type TextStyle,
  type Timeline,
  type Transform,
} from '../model'
import {
  EditRefusal,
  allClips,
  clearRegion,
  insertTrack,
  pruneEmptyTracks,
  regenerateTimelineIds,
  rescaleTimelineFrames,
  round,
  totalFrames,
} from '../timeline'
import { activeTimeline, timelineById, type Doc } from './context'

// ---------- Timelines ----------

export function uniqueTimelineName(doc: Doc, base = 'Timeline'): string {
  const used = new Set(doc.file.timelines.map((t) => t.name))
  let n = doc.file.timelines.length + 1
  while (used.has(`${base} ${n}`)) n++
  return `${base} ${n}`
}

export function createTimeline(doc: Doc, name?: string, activate = true): Timeline {
  const active = activeTimeline(doc)
  const t = newTimeline({
    name: name?.trim() || uniqueTimelineName(doc),
    fps: active.fps,
    width: active.width,
    height: active.height,
    settingsConfigured: active.settingsConfigured,
  })
  doc.file.timelines.push(t)
  if (activate) activateTimeline(doc, t.id)
  return t
}

export function duplicateTimeline(doc: Doc, id: string): Timeline {
  const src = timelineById(doc, id)
  if (!src) throw new EditRefusal('Timeline not found.')
  const copy: Timeline = deepClone(src)
  copy.id = newId()
  const used = new Set(doc.file.timelines.map((t) => t.name))
  let name = `${src.name} copy`
  for (let n = 2; used.has(name); n++) name = `${src.name} copy ${n}`
  copy.name = name
  regenerateTimelineIds(copy)
  doc.file.timelines.push(copy)
  const vs = doc.file.viewStates?.[id]
  if (vs) doc.file.viewStates = { ...doc.file.viewStates, [copy.id]: { ...vs } }
  activateTimeline(doc, copy.id)
  return copy
}

export function renameTimeline(doc: Doc, id: string, name: string): void {
  const t = timelineById(doc, id)
  if (!t) throw new EditRefusal('Timeline not found.')
  const trimmed = name.trim()
  if (!trimmed || trimmed === t.name) throw new EditRefusal('Unchanged.')
  t.name = trimmed
}

export function deleteTimeline(doc: Doc, id: string): void {
  if (doc.file.timelines.length <= 1) throw new EditRefusal("Can't delete every timeline — the project needs at least one.")
  const idx = doc.file.timelines.findIndex((t) => t.id === id)
  if (idx < 0) throw new EditRefusal('Timeline not found.')
  doc.file.timelines.splice(idx, 1)
  const open = (doc.file.openTimelineIds ?? []).filter((x) => x !== id)
  if (doc.file.activeTimelineId === id) doc.file.activeTimelineId = open[0] ?? doc.file.timelines[0].id
  if (!open.includes(doc.file.activeTimelineId!)) open.push(doc.file.activeTimelineId!)
  doc.file.openTimelineIds = open
  if (doc.file.viewStates) {
    const { [id]: _removed, ...rest } = doc.file.viewStates
    doc.file.viewStates = rest
  }
}

/** Not an undoable edit by itself; callers apply it outside history. */
export function activateTimeline(doc: Doc, id: string): void {
  if (!timelineById(doc, id)) throw new EditRefusal('Timeline not found.')
  doc.file.activeTimelineId = id
  const open = doc.file.openTimelineIds ?? []
  if (!open.includes(id)) doc.file.openTimelineIds = [...open, id]
}

export function closeTimelineTab(doc: Doc, id: string): void {
  const open = doc.file.openTimelineIds ?? []
  if (open.length <= 1 || !open.includes(id)) return
  const i = open.indexOf(id)
  const next = open.filter((x) => x !== id)
  doc.file.openTimelineIds = next
  if (doc.file.activeTimelineId === id) doc.file.activeTimelineId = next[Math.max(0, i - 1)]
}

// ---------- Project settings ----------

export function applyTimelineSettings(doc: Doc, fps: number, width: number, height: number): void {
  if (!Number.isSafeInteger(fps) || fps < 1 || fps > 240) throw new EditRefusal('Frame rate must be a whole number between 1 and 240.')
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 2 || height < 2 || width > 8192 || height > 8192) {
    throw new EditRefusal('Resolution must be between 2 and 8192 pixels per edge.')
  }
  const t = activeTimeline(doc)
  const prevFps = t.fps
  const prevW = t.width
  const prevH = t.height
  if (fps !== prevFps && prevFps > 0) {
    const s = fps / prevFps
    for (const tl of doc.file.timelines) rescaleTimelineFrames(tl, s)
    if (doc.file.viewStates) for (const vs of Object.values(doc.file.viewStates)) vs.playheadFrame = round(vs.playheadFrame * s)
  }
  if (width !== prevW || height !== prevH) {
    for (const c of allClips(t)) {
      const a = doc.manifest.entries.find((e) => e.id === c.mediaRef)
      const child = c.sourceClipType === 'sequence' ? timelineById(doc, c.mediaRef) : undefined
      const sw = a?.sourceWidth ?? child?.width
      const sh = a?.sourceHeight ?? child?.height
      if (!sw || !sh || c.mediaType === 'audio' || c.mediaType === 'text') continue
      const srcAspect = sw / sh
      const oldAspect = srcAspect / (prevW / prevH)
      const newAspect = srcAspect / (width / height)
      const oldFit = fitTransform(sw, sh, prevW, prevH)
      if (!isActive(c.scaleTrack) && Math.abs(c.transform.width - oldFit.width) < 1e-4 && Math.abs(c.transform.height - oldFit.height) < 1e-4) {
        const nf = fitTransform(sw, sh, width, height)
        c.transform.width = nf.width
        c.transform.height = nf.height
      } else {
        const k = oldAspect / newAspect
        c.transform.height *= k
        if (c.scaleTrack) c.scaleTrack = { keyframes: c.scaleTrack.keyframes.map((kf) => ({ ...kf, value: { a: kf.value.a, b: kf.value.b * k } })) }
      }
    }
  }
  for (const tl of doc.file.timelines) {
    tl.fps = fps
    tl.settingsConfigured = true
  }
  t.width = width
  t.height = height
}

export interface SettingsSuggestion {
  fps: number
  width: number
  height: number
}

/** First video media decides project settings; returns a suggestion when they differ. */
export function checkProjectSettings(doc: Doc, assetIds: string[]): { adoptSilently: boolean; suggestion: SettingsSuggestion } | null {
  const t = activeTimeline(doc)
  const v = assetIds.map((id) => doc.manifest.entries.find((e) => e.id === id)).find((e) => e?.type === 'video')
  if (!v) return null
  const canAdoptFps = doc.file.timelines.every((tl) => tl.tracks.every((tr) => tr.clips.length === 0))
  const fps = canAdoptFps && v.sourceFPS ? Math.round(v.sourceFPS) : t.fps
  const suggestion = { fps, width: v.sourceWidth ?? t.width, height: v.sourceHeight ?? t.height }
  if (!t.settingsConfigured) return { adoptSilently: true, suggestion }
  if (allClips(t).length) return null
  const mismatch = suggestion.fps !== t.fps || suggestion.width !== t.width || suggestion.height !== t.height
  return mismatch ? { adoptSilently: false, suggestion } : null
}

export const ASPECT_PRESETS = [
  { id: 'sixteenNine', label: '16:9', width: 1920, height: 1080 },
  { id: 'nineByFourteen', label: '9:14', width: 1080, height: 1680 },
  { id: 'nineSixteen', label: '9:16', width: 1080, height: 1920 },
  { id: 'oneOne', label: '1:1', width: 1080, height: 1080 },
  { id: 'fourThree', label: '4:3', width: 1440, height: 1080 },
  { id: 'twoPointFourOne', label: '2.4:1', width: 2592, height: 1080 },
] as const

export const QUALITY_PRESETS = [
  { label: '720p', shortEdge: 720 },
  { label: '1080p', shortEdge: 1080 },
  { label: '2K', shortEdge: 1440 },
  { label: '4K', shortEdge: 2160 },
] as const

export const FPS_PRESETS = [24, 25, 30, 50, 60] as const

export function qualityResolution(shortEdge: number, w: number, h: number): { width: number; height: number } {
  return w <= h ? { width: shortEdge, height: Math.trunc((shortEdge * h) / w) } : { width: Math.trunc((shortEdge * w) / h), height: shortEdge }
}

// ---------- Media library ----------

export function addMediaEntries(doc: Doc, entries: MediaManifestEntry[], folders: MediaFolder[] = []): void {
  doc.manifest.folders.push(...folders)
  doc.manifest.entries.push(...entries)
}

export function updateMediaEntry(doc: Doc, id: string, patch: Partial<MediaManifestEntry>): void {
  const e = doc.manifest.entries.find((x) => x.id === id)
  if (!e) throw new EditRefusal('Media not found.')
  Object.assign(e, patch)
  for (const k of Object.keys(patch) as (keyof MediaManifestEntry)[]) if (patch[k] === undefined) delete e[k]
}

export function renameMedia(doc: Doc, id: string, name: string): void {
  const e = doc.manifest.entries.find((x) => x.id === id)
  if (!e) throw new EditRefusal('Media not found.')
  const n = name.trim()
  if (!n || n === e.name) throw new EditRefusal('Unchanged.')
  e.name = n
}

function removeClipsReferencing(doc: Doc, ids: Set<string>): void {
  for (const t of doc.file.timelines) {
    let touched = false
    for (const tr of t.tracks) {
      const before = tr.clips.length
      tr.clips = tr.clips.filter((c) => !ids.has(c.mediaRef))
      if (tr.clips.length !== before) touched = true
    }
    if (touched) pruneEmptyTracks(t)
  }
}

export function deleteMedia(doc: Doc, ids: string[]): void {
  const set = new Set(ids)
  const before = doc.manifest.entries.length
  doc.manifest.entries = doc.manifest.entries.filter((e) => !set.has(e.id))
  if (doc.manifest.entries.length === before) throw new EditRefusal('Media not found.')
  removeClipsReferencing(doc, set)
}

export function createFolder(doc: Doc, name: string, parentFolderId?: string): MediaFolder {
  const f: MediaFolder = { id: newId(), name: name.trim() || 'New Folder' }
  if (parentFolderId) {
    if (!doc.manifest.folders.some((x) => x.id === parentFolderId)) throw new EditRefusal('Parent folder not found.')
    f.parentFolderId = parentFolderId
  }
  doc.manifest.folders.push(f)
  return f
}

export function renameFolder(doc: Doc, id: string, name: string): void {
  const f = doc.manifest.folders.find((x) => x.id === id)
  if (!f) throw new EditRefusal('Folder not found.')
  if (f.name === name) throw new EditRefusal('Unchanged.')
  f.name = name
}

export function folderDescendants(doc: Doc, ids: string[]): Set<string> {
  const all = new Set(ids)
  let grew = true
  while (grew) {
    grew = false
    for (const f of doc.manifest.folders) if (f.parentFolderId && all.has(f.parentFolderId) && !all.has(f.id)) {
      all.add(f.id)
      grew = true
    }
  }
  return all
}

export function deleteFolders(doc: Doc, ids: string[]): void {
  const all = folderDescendants(doc, ids)
  if (!doc.manifest.folders.some((f) => all.has(f.id))) throw new EditRefusal('Folder not found.')
  const assetIds = new Set(doc.manifest.entries.filter((e) => e.folderId && all.has(e.folderId)).map((e) => e.id))
  doc.manifest.entries = doc.manifest.entries.filter((e) => !assetIds.has(e.id))
  removeClipsReferencing(doc, assetIds)
  for (const t of doc.file.timelines) if (t.folderId && all.has(t.folderId)) delete t.folderId
  doc.manifest.folders = doc.manifest.folders.filter((f) => !all.has(f.id))
}

export function moveToFolder(doc: Doc, items: { assets?: string[]; timelines?: string[]; folders?: string[] }, folderId: string | null): number {
  if (folderId && !doc.manifest.folders.some((f) => f.id === folderId)) throw new EditRefusal('Folder not found.')
  let moved = 0
  for (const e of doc.manifest.entries) if (items.assets?.includes(e.id) && (e.folderId ?? null) !== folderId) {
    if (folderId) e.folderId = folderId
    else delete e.folderId
    moved++
  }
  for (const t of doc.file.timelines) if (items.timelines?.includes(t.id) && (t.folderId ?? null) !== folderId) {
    if (folderId) t.folderId = folderId
    else delete t.folderId
    moved++
  }
  for (const f of doc.manifest.folders) {
    if (!items.folders?.includes(f.id) || (f.parentFolderId ?? null) === folderId) continue
    if (folderId && folderDescendants(doc, [f.id]).has(folderId)) continue
    if (folderId) f.parentFolderId = folderId
    else delete f.parentFolderId
    moved++
  }
  if (!moved) throw new EditRefusal('Nothing to move.')
  return moved
}

// ---------- Text ----------

export interface TextBox {
  width: number
  height: number
}

export interface TextSpec {
  content: string
  startFrame: number
  durationFrames?: number
  style?: Partial<TextStyle>
  animation?: TextAnimation
  transform?: Partial<Transform>
  /** Normalized natural box size measured by the renderer. */
  box: TextBox
  trackIndex?: number
}

export function addTextClips(doc: Doc, specs: TextSpec[], newTrack = true): string[] {
  const t = activeTimeline(doc)
  if (!specs.length) throw new EditRefusal('No text to add.')
  let trackIdx: number
  if (newTrack || specs[0].trackIndex === undefined) trackIdx = insertTrack(t, 0, 'video')
  else trackIdx = specs[0].trackIndex
  const trackId = t.tracks[trackIdx].id
  const ids: string[] = []
  for (const s of specs) {
    const dur = Math.max(1, s.durationFrames ?? Math.trunc(DEFAULTS.textDurationSeconds * t.fps))
    const start = Math.max(0, s.startFrame)
    const ti = t.tracks.findIndex((x) => x.id === trackId)
    clearRegion(t, ti, start, start + dur)
    const style: TextStyle = { ...defaultTextStyle(), ...(s.style ?? {}) }
    const transform: Transform = {
      ...fitTransform(0, 0, 0, 0),
      width: s.box.width,
      height: s.box.height,
      ...(s.transform ?? {}),
    }
    const clip = newClip({ mediaRef: '', mediaType: 'text', sourceClipType: 'text', startFrame: start, durationFrames: dur, transform, textContent: s.content, textStyle: style })
    if (s.animation && s.animation.preset !== 'none') clip.textAnimation = s.animation
    t.tracks[ti].clips.push(clip)
    t.tracks[ti].clips.sort((a, b) => a.startFrame - b.startFrame)
    ids.push(clip.id)
  }
  pruneEmptyTracks(t)
  return ids
}

/** Resizes a text box to its measured content size, anchored by alignment. */
export function fitTextBox(c: { transform: Transform; textStyle?: TextStyle; scaleTrack?: { keyframes: { value: { a: number; b: number } }[] } }, box: TextBox): void {
  const cur = c.transform
  if (!(box.width > 0 && box.height > 0)) return
  const align = c.textStyle?.alignment ?? 'center'
  const left = cur.centerX - cur.width / 2
  const right = cur.centerX + cur.width / 2
  const rw = box.width / (cur.width || box.width)
  const rh = box.height / (cur.height || box.height)
  if (align === 'left') cur.centerX = left + box.width / 2
  else if (align === 'right') cur.centerX = right - box.width / 2
  cur.width = box.width
  cur.height = box.height
  if (c.scaleTrack) c.scaleTrack.keyframes = c.scaleTrack.keyframes.map((k) => ({ ...k, value: { a: k.value.a * rw, b: k.value.b * rh } }))
}

// ---------- Nesting ----------

export function nestSelectedClips(doc: Doc, clipIds: string[]): { childId: string; carrierIds: string[] } {
  const t = activeTimeline(doc)
  const ids = new Set(clipIds)
  const lanes = t.tracks
    .map((tr, index) => ({ index, type: tr.type, clips: tr.clips.filter((c) => ids.has(c.id)) }))
    .filter((l) => l.clips.length)
  if (!lanes.length) throw new EditRefusal('Select clips to nest.')
  const all = lanes.flatMap((l) => l.clips)
  const start = Math.min(...all.map((c) => c.startFrame))
  const duration = Math.max(...all.map(endFrame)) - start
  const used = new Set(doc.file.timelines.map((x) => x.name))
  let n = 1
  while (used.has(`Nest ${n}`)) n++
  const child = newTimeline({ name: `Nest ${n}`, fps: t.fps, width: t.width, height: t.height, settingsConfigured: t.settingsConfigured })
  child.tracks = lanes.map((l) => ({
    id: newId(),
    type: l.type === 'audio' ? 'audio' : 'video',
    muted: false,
    hidden: false,
    syncLocked: true,
    displayHeight: 44,
    clips: l.clips.map((c) => ({ ...deepClone(c), startFrame: c.startFrame - start })),
  }))
  regenerateTimelineIds(child)
  doc.file.timelines.push(child)
  for (const tr of t.tracks) tr.clips = tr.clips.filter((c) => !ids.has(c.id))
  let v: number | null = lanes.find((l) => l.type !== 'audio')?.index ?? null
  let a: number | null = lanes.find((l) => l.type === 'audio')?.index ?? null
  const overlaps = (i: number) => t.tracks[i].clips.some((c) => c.startFrame < start + duration && endFrame(c) > start)
  if (v !== null && overlaps(v)) {
    v = insertTrack(t, v, 'video')
    if (a !== null && a >= v) a++
  }
  if (a !== null && overlaps(a)) a = insertTrack(t, a + 1, 'audio')
  const carriers = insertNestCarriers(t, child, start, duration, v, a)
  pruneEmptyTracks(t)
  if (!doc.file.openTimelineIds?.includes(child.id)) doc.file.openTimelineIds = [...(doc.file.openTimelineIds ?? []), child.id]
  return { childId: child.id, carrierIds: carriers }
}

export function insertNestCarriers(t: Timeline, child: Timeline, start: number, duration: number, videoIdx: number | null, audioIdx: number | null): string[] {
  const gid = videoIdx !== null && audioIdx !== null ? newId() : undefined
  const ids: string[] = []
  const vId = videoIdx !== null ? t.tracks[videoIdx].id : null
  const aId = audioIdx !== null ? t.tracks[audioIdx].id : null
  if (vId) {
    clearRegion(t, t.tracks.findIndex((x) => x.id === vId), start, start + duration)
    const c = newClip({ mediaRef: child.id, mediaType: 'sequence', sourceClipType: 'sequence', startFrame: start, durationFrames: duration, transform: fitTransform(child.width, child.height, t.width, t.height) })
    if (gid) c.linkGroupId = gid
    t.tracks.find((x) => x.id === vId)!.clips.push(c)
    ids.push(c.id)
  }
  if (aId) {
    clearRegion(t, t.tracks.findIndex((x) => x.id === aId), start, start + duration)
    const c = newClip({ mediaRef: child.id, mediaType: 'audio', sourceClipType: 'sequence', startFrame: start, durationFrames: duration })
    if (gid) c.linkGroupId = gid
    t.tracks.find((x) => x.id === aId)!.clips.push(c)
    ids.push(c.id)
  }
  for (const tr of t.tracks) tr.clips.sort((x, y) => x.startFrame - y.startFrame)
  return ids
}

export { totalFrames }
