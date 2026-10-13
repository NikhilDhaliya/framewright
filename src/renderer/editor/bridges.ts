import type { MediaKey } from '../state/editor'

/** Imperative hooks a mounted panel exposes to global commands (menu, keyboard, other panels). */
export interface MediaBridge {
  /** Panel-scoped keys while the Media panel is focused; returns true when handled. */
  handleKey(e: KeyboardEvent): boolean
  selectAll(): void
  openSearch(): void
  /** Collapses an expanded search; returns false when there was nothing to collapse. */
  collapseSearch(): boolean
  /** Scrolls an item into view (after the folder/selection was set). */
  reveal(key: MediaKey): void
  /** Starts inline rename of an item (e.g. a folder just created). */
  beginRename(key: MediaKey): void
}

export const mediaBridge: { current: MediaBridge | null } = { current: null }
