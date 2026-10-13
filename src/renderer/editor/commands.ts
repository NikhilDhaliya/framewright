import type { MenuCommand, NativeEditAction, UiCommand } from '../../shared/api'
import { handleAgentUiCommand } from '../timeline/agentActivity'
import { importMedia, deleteMediaItems, newFolder, pasteMediaFromClipboard } from '../media/actions'
import { cancelMediaSwap } from '../media/swap'
import { openDialog, useDialogs } from '../state/dialogs'
import { editor, selectClips, setEditor } from '../state/editor'
import { useProject } from '../state/project'
import { updateSettings, useSettings } from '../state/settings'
import { showPanelFitting, togglePanelFitting } from './panelFit'
import {
  addMarker,
  addText,
  copySelection,
  cutSelection,
  deleteSelectedClips,
  deleteSelectedMarkers,
  pasteAt,
  revealAsset,
  rippleDeleteSelection,
  selectForward,
  splitAtPlayhead,
  trimToPlayhead,
} from '../timeline/actions'
import { zoomIn, zoomOut, zoomToFit } from '../timeline/view'
import { playheadFrame, seek } from '../state/playback'
import { toast } from '../ui/toast'
import { mediaBridge } from './bridges'
import { cancelChromaKeySampling } from '../extras/ChromaSampler'
import { openFeedback } from '../dialogs/FeedbackDialog'
import { startTour } from '../tour/store'

export function isTyping(): boolean {
  const el = document.activeElement as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
}

const hasProject = () => useProject.getState().snapshot !== null
const mediaFocused = () => editor().focusedPanel === 'mediaPanel'

/** Esc: the first applicable step wins (spec §10.1). */
export function escape(): void {
  const s = editor()
  if (cancelMediaSwap()) return
  if (cancelChromaKeySampling()) return
  if (s.cropEditing) return setEditor({ cropEditing: false })
  if (s.maximized) return setEditor({ maximized: null })
  if (mediaBridge.current?.collapseSearch()) return
  setEditor({ selectedClipIds: [], selectedGap: null, range: null, selectedMarkerIds: [], tool: 'pointer', markerEditorId: null })
}

export async function deleteKey(shift: boolean): Promise<void> {
  const s = editor()
  if (mediaFocused() && s.mediaSelection.length) return deleteMediaItems()
  if (s.selectedMarkerIds.length && (await deleteSelectedMarkers())) return
  if (shift) return rippleDeleteSelection()
  return deleteSelectedClips()
}

export function toggleMaximize(): void {
  const s = editor()
  if (s.maximized) setEditor({ maximized: null })
  else if (s.focusedPanel) setEditor({ maximized: s.focusedPanel })
}

const NATIVE: Partial<Record<MenuCommand, NativeEditAction>> = { undo: 'undo', redo: 'redo', cut: 'cut', copy: 'copy', paste: 'paste', 'select-all': 'selectAll' }

async function editorCommand(cmd: MenuCommand): Promise<void> {
  const timelineFocused = editor().focusedPanel === 'timelinePanel'
  switch (cmd) {
    case 'save':
      return window.palmier.project.save()
    case 'save-as':
      return window.palmier.project.saveAs()
    case 'close-project':
      return window.palmier.project.close()
    case 'import-media':
      await importMedia()
      return
    case 'export':
      return openDialog({ kind: 'export' })
    case 'undo':
      await window.palmier.project.undo()
      return
    case 'redo':
      await window.palmier.project.redo()
      return
    case 'cut':
      if (timelineFocused) await cutSelection()
      return
    case 'copy':
      if (timelineFocused) copySelection()
      return
    case 'paste':
      if (mediaFocused()) await pasteMediaFromClipboard()
      else await pasteAt(null, playheadFrame())
      return
    case 'delete':
      return deleteKey(false)
    case 'ripple-delete':
      return deleteKey(true)
    case 'select-all':
      if (mediaFocused()) mediaBridge.current?.selectAll()
      return
    case 'split':
      if (mediaFocused()) mediaBridge.current?.openSearch()
      else await splitAtPlayhead()
      return
    case 'trim-start':
      return trimToPlayhead('left')
    case 'trim-end':
      return trimToPlayhead('right')
    case 'select-forward-track':
      return selectForward(false)
    case 'select-forward-all':
      return selectForward(true)
    case 'add-marker':
      return addMarker()
    case 'add-text':
      return addText()
    case 'new-folder':
      await newFolder()
      return
    case 'toggle-media-panel':
      return togglePanelFitting('media')
    case 'toggle-inspector':
      return togglePanelFitting('inspector')
    case 'toggle-agent-panel':
      return togglePanelFitting('agent')
    case 'maximize-panel':
      return toggleMaximize()
    case 'zoom-in':
      return zoomIn()
    case 'zoom-out':
      return zoomOut()
    case 'zoom-fit':
      return zoomToFit()
    case 'tutorial':
      return startTour()
    default:
      return
  }
}

/** Menu accelerators arrive here from main (never bound in the renderer's key handler). */
export async function runMenuCommand(cmd: MenuCommand): Promise<void> {
  const native = NATIVE[cmd]
  if (native && isTyping()) return window.palmier.app.nativeEdit(native)
  switch (cmd) {
    case 'new-project':
      return openDialog({ kind: 'newProject' })
    case 'open-project': {
      const r = await window.palmier.home.openProject()
      if (!r.ok && r.error) toast(r.error, 'error')
      return
    }
    case 'settings':
      return openDialog({ kind: 'settings' })
    case 'shortcuts':
      return openDialog({ kind: 'shortcuts' })
    case 'mcp-instructions':
      return openDialog({ kind: 'mcp' })
    case 'about':
      return openDialog({ kind: 'about' })
    case 'feedback':
      return openFeedback()
    case 'layout-default':
    case 'layout-media':
    case 'layout-vertical':
      setEditor({ maximized: null })
      return updateSettings({ layoutPreset: cmd.slice(7) as 'default' | 'media' | 'vertical' })
    case 'toggle-ripple-markers':
      return updateSettings({ rippleTimelineMarkers: !(useSettings.getState().settings?.rippleTimelineMarkers ?? true) })
  }
  if (useDialogs.getState().dialog && cmd !== 'undo' && cmd !== 'redo') return
  if (hasProject()) await editorCommand(cmd)
}

export function handleUiCommand(cmd: UiCommand): void {
  switch (cmd.type) {
    case 'menu':
      void runMenuCommand(cmd.command)
      return
    case 'seek':
      seek(cmd.frame)
      return
    case 'select':
      selectClips(cmd.clipIds)
      return
    case 'toast':
      toast(cmd.message, cmd.kind === 'error' ? 'error' : 'info')
      return
    case 'agentActivity':
    case 'agentChanges':
      handleAgentUiCommand(cmd)
      return
    case 'revealAsset':
      showPanelFitting('media')
      revealAsset(cmd.assetId)
      return
  }
}

