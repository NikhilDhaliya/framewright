import { defaultTextStyle, type Clip, type Timeline } from '@core/model'
import { clipOps } from '@core/ops'
import { nextMarkerName } from '@core/ops/tracks'
import { allClips, expandToLinkGroup, findClip } from '@core/timeline'
import { textMeasurer } from '../render/text'
import { editor, selectClips, setEditor, type MediaKey } from '../state/editor'
import { playheadFrame } from '../state/playback'
import { getDoc, getTimeline } from '../state/project'
import { runOp } from '../state/ops'
import { rippleMarkersEnabled } from '../state/settings'
import { usePreviewTabs } from '../state/previewTabs'
import { toast } from '../ui/toast'
import { mediaBridge } from '../editor/bridges'
import { t } from '../i18n'


function liveSelection(t: Timeline): string[] {
  const ids = new Set(allClips(t).map((c) => c.id))
  return editor().selectedClipIds.filter((id) => ids.has(id))
}

export function copySelection(): boolean {
  const t = getTimeline()
  if (!t) return false
  const entries = clipOps.copyClips(t, liveSelection(t))
  if (!entries.length) return false
  setEditor({ clipboard: entries })
  return true
}

export async function deleteSelectedClips(): Promise<void> {
  const t = getTimeline()
  if (!t) return
  const ids = liveSelection(t)
  if (!ids.length) return
  if ((await runOp('deleteClips', { ids })) !== undefined) selectClips([])
}

export async function cutSelection(): Promise<void> {
  if (copySelection()) await deleteSelectedClips()
}

export async function pasteAt(trackIndex: number | null, frame: number): Promise<void> {
  const { clipboard } = editor()
  if (!clipboard.length) return
  const ids = await runOp('pasteClips', { clipboard, trackIndex, frame })
  if (ids?.length) selectClips(ids)
}

export async function rippleDeleteSelection(): Promise<void> {
  const { selectedGap } = editor()
  if (selectedGap) {
    if ((await runOp('rippleDeleteGap', { gap: selectedGap, rippleMarkers: rippleMarkersEnabled() })) !== undefined) setEditor({ selectedGap: null })
    return
  }
  const t = getTimeline()
  const ids = t ? liveSelection(t) : []
  if (!ids.length) return
  if ((await runOp('rippleDeleteClips', { ids, rippleMarkers: rippleMarkersEnabled() })) !== undefined) selectClips([])
}

export async function deleteSelectedMarkers(): Promise<boolean> {
  const ids = editor().selectedMarkerIds
  const t = getTimeline()
  const live = ids.filter((id) => t?.markers.some((m) => m.id === id))
  if (!live.length) return false
  const label = live.length === 1 ? 'Delete Marker' : 'Delete Markers'
  if ((await runOp('changeMarkers', { deleteIds: live, label })) !== undefined) setEditor({ selectedMarkerIds: [] })
  return true
}

export async function splitAtPlayhead(): Promise<void> {
  const t = getTimeline()
  if (!t) return
  const ids = liveSelection(t)
  if (!ids.length) return
  await runOp('splitAtFrame', { ids, frame: playheadFrame() })
}

export async function splitClipAt(clipId: string, frame: number): Promise<void> {
  await runOp('splitClip', { id: clipId, frame })
}

export async function trimToPlayhead(edge: 'left' | 'right'): Promise<void> {
  const t = getTimeline()
  if (!t) return
  const ids = liveSelection(t)
  if (!ids.length) return
  await runOp('trimToFrame', { ids, frame: playheadFrame(), edge })
}

/** Selects every clip at or after the anchor (earliest selected, or `anchorId`) on its track, or on all tracks. */
export function selectForward(allTracks: boolean, anchorId?: string): void {
  const t = getTimeline()
  if (!t) return
  let anchor: { clip: Clip; trackIndex: number } | null = null
  if (anchorId) {
    const loc = findClip(t, anchorId)
    if (loc) anchor = { clip: loc.clip, trackIndex: loc.trackIndex }
  } else {
    for (const id of liveSelection(t)) {
      const loc = findClip(t, id)
      if (!loc) continue
      if (!anchor || loc.clip.startFrame < anchor.clip.startFrame || (loc.clip.startFrame === anchor.clip.startFrame && loc.trackIndex < anchor.trackIndex)) anchor = { clip: loc.clip, trackIndex: loc.trackIndex }
    }
  }
  if (!anchor) return
  const start = anchor.clip.startFrame
  const ids = t.tracks.flatMap((tr, i) => (allTracks || i === anchor!.trackIndex ? tr.clips.filter((c) => c.startFrame >= start).map((c) => c.id) : []))
  setEditor({ selectedClipIds: [...expandToLinkGroup(t, ids)], selectedGap: null, range: null, selectedMarkerIds: [] })
}

export function selectAllOnTrack(trackIndex: number): void {
  const t = getTimeline()
  const tr = t?.tracks[trackIndex]
  if (!tr) return
  setEditor({ selectedClipIds: tr.clips.map((c) => c.id), selectedGap: null, selectedMarkerIds: [] })
}

export function isTimelineTabActive(): boolean {
  return usePreviewTabs.getState().active === 'timeline'
}

/** M / toolbar flag: adds "Marker N" at the playhead or over the selected range, then opens its editor. */
export async function addMarker(): Promise<void> {
  if (!isTimelineTabActive()) {
    toast(t('Select the timeline to add a marker.'))
    return
  }
  const tl = getTimeline()
  if (!tl) return
  const r = editor().range
  const valid = r && r.end !== r.start ? { start: Math.min(r.start, r.end), end: Math.max(r.start, r.end) } : null
  const result = await runOp('changeMarkers', {
    creates: [{ name: nextMarkerName(tl.markers), startFrame: valid?.start ?? playheadFrame(), durationFrames: valid ? valid.end - valid.start : 0 }],
    label: 'Add Marker',
  })
  const id = result?.created[0]?.id
  if (id) setEditor({ selectedMarkerIds: [id], selectedClipIds: [], selectedGap: null, range: null, markerEditorId: id })
}

/** Toolbar "T": a 3 s "Text" clip on a new top track at the playhead, sized to its content. */
export async function addText(): Promise<void> {
  const t = getTimeline()
  if (!t) return
  const content = 'Text'
  const box = textMeasurer.measure(content, defaultTextStyle(), t.width, t.height)
  const ids = await runOp('addText', { specs: [{ content, startFrame: playheadFrame(), box }] })
  if (ids?.length) selectClips(ids)
}

export function markRange(edge: 'in' | 'out'): void {
  const f = Math.max(0, playheadFrame())
  const cur = editor().range
  setEditor({ range: edge === 'in' ? { start: f, end: cur?.end ?? f } : { start: cur?.start ?? f, end: f }, selectedMarkerIds: [] })
}

export async function linkSelection(): Promise<void> {
  await runOp('linkClips', { ids: editor().selectedClipIds })
}

export async function unlinkSelection(): Promise<void> {
  if ((await runOp('unlinkClips', { ids: editor().selectedClipIds })) !== undefined) selectClips([])
}

export async function nestSelection(): Promise<void> {
  const ids = editor().selectedClipIds
  if (!ids.length) return
  const result = await runOp('nestClips', { ids })
  if (result) selectClips(result.carrierIds)
}

export function revealAsset(assetId: string): void {
  const entry = getDoc()?.manifest.entries.find((e) => e.id === assetId)
  if (!entry) return
  const key: MediaKey = `asset:${assetId}`
  setEditor({ mediaFolderId: entry.folderId ?? null, mediaSelection: [key] })
  mediaBridge.current?.reveal(key)
}
