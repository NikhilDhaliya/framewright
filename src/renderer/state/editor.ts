import { create } from 'zustand'
import type { ClipboardEntry, Gap } from '@core/ops/clips'
import { croppableClip } from '../preview/geometry'
import { getTimeline } from './project'

export type PanelId = 'mediaPanel' | 'previewPanel' | 'inspectorPanel' | 'timelinePanel'
export type ToolMode = 'pointer' | 'razor' | 'trim'

export interface FrameRangeSel {
  start: number
  end: number
}

/** Media-panel items are keyed "asset:<id>", "folder:<id>" or "timeline:<id>". */
export type MediaKey = `${'asset' | 'folder' | 'timeline'}:${string}`

/** Live slip drag (03 §4.11 SlipPreviewState): the video clip shown and its new in/out source frames. */
export interface SlipPreview {
  clipId: string
  /** Source frame shown at the clip's start (`trimStart - applied`). */
  startFrame: number
  /** Source frame shown at the clip's last frame. */
  endFrame: number
}

/**
 * Inspector crop-aspect lock (Mac `CropAspectLock`: free / original / fixed ratio). Editor-wide, not per clip; a fixed
 * lock makes on-canvas corner drags keep its pixel aspect (05 §5.8).
 */
export type CropAspectLock = { kind: 'free' } | { kind: 'original' } | { kind: 'fixed'; ratio: number; label: string }

export interface EditorState {
  selectedClipIds: string[]
  selectedMarkerIds: string[]
  selectedGap: Gap | null
  range: FrameRangeSel | null
  tool: ToolMode
  focusedPanel: PanelId | null
  maximized: PanelId | null
  mediaSelection: MediaKey[]
  mediaFolderId: string | null
  /** Number of clips under a live marquee, shown by the inspector. */
  marqueeCount: number | null
  cropEditing: boolean
  clipboard: ClipboardEntry[]
  markerEditorId: string | null
  /** Set only while a timeline slip drag is live (read by the preview's slip two-up). */
  slipPreview: SlipPreview | null
  cropAspectLock: CropAspectLock
}

export const useEditor = create<EditorState>(() => ({
  selectedClipIds: [],
  selectedMarkerIds: [],
  selectedGap: null,
  range: null,
  tool: 'pointer',
  focusedPanel: 'timelinePanel',
  maximized: null,
  mediaSelection: [],
  mediaFolderId: null,
  marqueeCount: null,
  cropEditing: false,
  clipboard: [],
  markerEditorId: null,
  slipPreview: null,
  cropAspectLock: { kind: 'free' },
}))

export const editor = () => useEditor.getState()
export const setEditor = (patch: Partial<EditorState> | ((s: EditorState) => Partial<EditorState>)) => useEditor.setState(patch)

export function selectClips(ids: string[]): void {
  const t = getTimeline()
  setEditor({ selectedClipIds: ids, selectedGap: null, cropEditing: editor().cropEditing && !!t && !!croppableClip(t, ids) })
}

export function focusPanel(panel: PanelId): void {
  const s = editor()
  if (s.focusedPanel === panel) return
  const patch: Partial<EditorState> = { focusedPanel: panel }
  if (panel === 'mediaPanel' && s.selectedClipIds.length) patch.selectedClipIds = []
  if (panel === 'timelinePanel' && s.mediaSelection.length) patch.mediaSelection = []
  setEditor(patch)
}

export const assetIdsOf = (keys: MediaKey[]): string[] => keys.filter((k) => k.startsWith('asset:')).map((k) => k.slice(6))
