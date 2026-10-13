import { create } from 'zustand'
import { setEditor } from './editor'

export type PreviewTabId = 'timeline' | `media_${string}`

interface PreviewTabsState {
  tabs: PreviewTabId[]
  active: PreviewTabId
  history: PreviewTabId[]
  cursor: number
}

export const usePreviewTabs = create<PreviewTabsState>(() => ({ tabs: ['timeline'], active: 'timeline', history: ['timeline'], cursor: 0 }))

const set = usePreviewTabs.setState
const get = usePreviewTabs.getState

export const assetTabId = (assetId: string): PreviewTabId => `media_${assetId}`

/** Activates (opening if needed) a tab and records it in the back/forward history. */
export function activatePreviewTab(id: PreviewTabId): void {
  const s = get()
  if (s.active === id) return
  const tabs = s.tabs.includes(id) ? s.tabs : [...s.tabs, id]
  const history = [...s.history.slice(0, s.cursor + 1), id]
  set({ tabs, active: id, history, cursor: history.length - 1 })
}

/**
 * Mac `syncSelectionToActiveTab`: the Main (timeline) tab drops the media selection so the inspector stops showing
 * the asset; a media tab selects its asset and clears clip/marker selection.
 */
function syncSelectionToActiveTab(): void {
  const active = get().active
  if (active === 'timeline') setEditor({ mediaSelection: [] })
  else setEditor({ selectedClipIds: [], selectedMarkerIds: [], selectedGap: null, mediaSelection: [`asset:${active.slice(6)}`] })
}

/** Mac `selectPreviewTab(id:)` (tab click, Ctrl+Tab): activate, then sync the selection to it. */
export function selectPreviewTab(id: PreviewTabId): void {
  if (get().active === id || !get().tabs.includes(id)) return
  activatePreviewTab(id)
  syncSelectionToActiveTab()
}

export function closePreviewTab(id: PreviewTabId): void {
  if (id === 'timeline') return
  const s = get()
  const tabs = s.tabs.filter((t) => t !== id)
  const history = s.history.filter((t) => t !== id)
  const cursor = Math.min(s.cursor, history.length - 1)
  set({ tabs, history: history.length ? history : ['timeline'], cursor: Math.max(0, cursor), active: s.active === id ? (history[cursor] ?? 'timeline') : s.active })
}

export function closeAllPreviewTabs(): void {
  set({ tabs: ['timeline'], active: 'timeline', history: ['timeline'], cursor: 0 })
}

export function navigatePreviewHistory(delta: -1 | 1): void {
  const s = get()
  const cursor = s.cursor + delta
  if (cursor < 0 || cursor >= s.history.length) return
  const changed = s.history[cursor] !== s.active
  set({ cursor, active: s.history[cursor] })
  if (changed) syncSelectionToActiveTab()
}

export function cyclePreviewTab(delta: -1 | 1): void {
  const s = get()
  const i = s.tabs.indexOf(s.active)
  selectPreviewTab(s.tabs[(i + delta + s.tabs.length) % s.tabs.length])
}

/** Drops tabs whose asset no longer exists. */
export function prunePreviewTabs(assetIds: Set<string>): void {
  for (const t of get().tabs) if (t !== 'timeline' && !assetIds.has(t.slice(6))) closePreviewTab(t)
}
