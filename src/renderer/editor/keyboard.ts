import { useEffect } from 'react'
import { openDialog, useDialogs } from '../state/dialogs'
import { editor, setEditor } from '../state/editor'
import { step, togglePlay } from '../state/playback'
import { cyclePreviewTab, usePreviewTabs } from '../state/previewTabs'
import { sourcePlayer } from '../preview/sourcePlayer'
import { isMenuOpen } from '../ui/Menu'
import { addMarker, markRange, selectForward, trimToPlayhead } from '../timeline/actions'
import { cycleTimelineTab } from '../timeline/tabs'
import { mediaBridge } from './bridges'
import type { MenuCommand } from '../../shared/api'
import { deleteKey, escape, isTyping, runMenuCommand, toggleMaximize } from './commands'

/**
 * Ctrl+C/X/V/A outside text fields. Chromium on Linux runs these as page edit commands (DOM copy/cut/paste,
 * select all) before the app menu sees them, so their menu accelerators never fire; run the menu command here.
 */
const EDIT_KEYS: Record<string, MenuCommand> = { c: 'copy', x: 'cut', v: 'paste', a: 'select-all' }

function editCommand(e: KeyboardEvent): MenuCommand | undefined {
  if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return undefined
  const letter = /^[a-z]$/i.test(e.key) ? e.key.toLowerCase() : e.code.startsWith('Key') ? e.code.slice(3).toLowerCase() : ''
  return EDIT_KEYS[letter]
}

/** Single-key editor shortcuts (§10.3). Other Ctrl accelerators belong to the app menu and arrive as commands. */
function onKeyDown(e: KeyboardEvent): void {
  if (e.defaultPrevented || isTyping() || isMenuOpen() || useDialogs.getState().dialog || document.querySelector('.pp-popover')) return
  const s = editor()
  if (s.focusedPanel === 'mediaPanel' && mediaBridge.current?.handleKey(e)) {
    e.preventDefault()
    return
  }
  const edit = editCommand(e)
  if (edit) {
    e.preventDefault()
    void runMenuCommand(edit)
    return
  }
  if (e.ctrlKey || e.metaKey) return
  const plain = !e.altKey
  const key = e.key
  const source = usePreviewTabs.getState().active !== 'timeline' ? sourcePlayer.current : null
  const handled = (() => {
    switch (key) {
      case 'F1':
        openDialog({ kind: 'shortcuts' })
        return true
      case ' ':
        if (source) source.toggle()
        else togglePlay()
        return true
      case 'ArrowLeft':
      case 'ArrowRight': {
        if (e.altKey) return false
        const delta = (key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 5 : 1)
        if (source) source.step(delta)
        else step(delta)
        return true
      }
      case 'Backspace':
      case 'Delete':
        void deleteKey(e.shiftKey)
        return true
      case 'Escape':
        escape()
        return true
      case 'Enter':
        if (s.cropEditing) {
          setEditor({ cropEditing: false })
          return true
        }
        return false
      case '`':
        if (!plain) return false
        toggleMaximize()
        return true
      case '[':
        void trimToPlayhead('left')
        return true
      case ']':
        void trimToPlayhead('right')
        return true
      case 'Tab':
        if (!plain) return false
        if (s.focusedPanel === 'timelinePanel') cycleTimelineTab(e.shiftKey ? -1 : 1)
        else if (s.focusedPanel === 'previewPanel') cyclePreviewTab(e.shiftKey ? -1 : 1)
        else return false
        return true
    }
    if (!plain) return false
    switch (key.toLowerCase()) {
      case 'v':
        setEditor({ tool: 'pointer' })
        return true
      case 'c':
        setEditor({ tool: 'razor' })
        return true
      case 't':
        setEditor({ tool: 'trim' })
        return true
      case 'a':
        if (s.focusedPanel !== 'timelinePanel') return false
        selectForward(e.shiftKey)
        return true
      case 'q':
        void trimToPlayhead('left')
        return true
      case 'w':
        void trimToPlayhead('right')
        return true
      case 'm':
        void addMarker()
        return true
      case 'i':
        markRange('in')
        return true
      case 'o':
        markRange('out')
        return true
    }
    return false
  })()
  if (handled) e.preventDefault()
}

/** Blurs a stale focused control when clicking elsewhere, so single-key shortcuts work again. */
function onPointerDown(e: PointerEvent): void {
  const t = e.target as HTMLElement
  if (t.closest('input, textarea, select, [contenteditable="true"]')) return
  const active = document.activeElement as HTMLElement | null
  if (active && active !== document.body && !t.closest('.pp-popover, .pp-sheet')) active.blur()
}

export function useEditorKeys(): void {
  useEffect(() => {
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [])
}
