import { allClips, totalFrames } from '@core/timeline'
import type { ProjectState } from '../../shared/api'
import { enterTimeline } from '../timeline/view'
import { assetIdsOf, editor, setEditor, useEditor, type EditorState } from './editor'
import { pause, seek } from './playback'
import { prunePreviewTabs, closeAllPreviewTabs } from './previewTabs'
import { timelineOf, useProject } from './project'

const RESET: Partial<EditorState> = {
  selectedClipIds: [],
  selectedMarkerIds: [],
  selectedGap: null,
  range: null,
  marqueeCount: null,
  cropEditing: false,
  markerEditorId: null,
}

/** Applies a snapshot from main and keeps renderer-local state consistent with it. */
export function syncWithSnapshot(s: ProjectState | null): void {
  const prev = useProject.getState().snapshot
  if (!s) {
    pause()
    useProject.setState({ snapshot: null, preview: null })
    setEditor({ ...RESET, mediaSelection: [], mediaFolderId: null, maximized: null })
    closeAllPreviewTabs()
    return
  }
  useProject.setState({ snapshot: s })
  const t = timelineOf(s.doc)
  const prevTimelineId = prev ? timelineOf(prev.doc)?.id : null
  if (!prev) {
    setEditor({ ...RESET, mediaSelection: [], mediaFolderId: null, maximized: null })
    closeAllPreviewTabs()
  }
  if (t && t.id !== prevTimelineId) {
    const vs = s.doc.file.viewStates?.[t.id]
    pause()
    setEditor(RESET)
    enterTimeline(t, vs)
    seek(Math.min(vs?.playheadFrame ?? 0, totalFrames(t)))
    return
  }
  if (!t || s.doc === prev?.doc) return
  const ids = new Set(allClips(t).map((c) => c.id))
  const ed = editor()
  const patch: Partial<EditorState> = {}
  if (ed.selectedClipIds.some((id) => !ids.has(id))) patch.selectedClipIds = ed.selectedClipIds.filter((id) => ids.has(id))
  if (ed.selectedMarkerIds.some((id) => !t.markers.some((m) => m.id === id))) patch.selectedMarkerIds = ed.selectedMarkerIds.filter((id) => t.markers.some((m) => m.id === id))
  const assets = new Set(s.doc.manifest.entries.map((e) => e.id))
  const folders = new Set(s.doc.manifest.folders.map((f) => f.id))
  const timelines = new Set(s.doc.file.timelines.map((x) => x.id))
  const alive = (k: string) => (k.startsWith('asset:') ? assets.has(k.slice(6)) : k.startsWith('folder:') ? folders.has(k.slice(7)) : timelines.has(k.slice(9)))
  if (ed.mediaSelection.some((k) => !alive(k))) patch.mediaSelection = ed.mediaSelection.filter(alive)
  if (ed.mediaFolderId && !folders.has(ed.mediaFolderId)) patch.mediaFolderId = null
  if (Object.keys(patch).length) setEditor(patch)
  prunePreviewTabs(assets)
}

/** Mirrors the selection to main so agents (MCP) can read it. */
export function installSelectionReporting(): void {
  useEditor.subscribe((s, p) => {
    if (s.selectedClipIds !== p.selectedClipIds || s.mediaSelection !== p.mediaSelection || s.range !== p.range) {
      const r = s.range && s.range.start !== s.range.end ? { start: Math.min(s.range.start, s.range.end), end: Math.max(s.range.start, s.range.end) } : null
      window.palmier.project.setUi({ selectedClipIds: s.selectedClipIds, selectedMediaIds: assetIdsOf(s.mediaSelection), rangeIn: r?.start ?? null, rangeOut: r?.end ?? null })
    }
  })
}
