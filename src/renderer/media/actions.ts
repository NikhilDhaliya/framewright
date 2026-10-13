import { mediaBridge } from '../editor/bridges'
import { editor, setEditor, type MediaKey } from '../state/editor'
import { runOp } from '../state/ops'
import { dismissToast, toast } from '../ui/toast'
import { t, plural } from '../i18n'

/** Imports files (or opens the picker when `paths` is omitted) into a folder; returns the new asset ids. */
export async function importMedia(paths?: string[], folderId: string | null = editor().mediaFolderId): Promise<string[]> {
  const progress = paths?.length ? toast(plural(paths.length, 'Importing 1 item…', 'Importing {0} items…'), 'progress') : null
  try {
    const result = await window.palmier.media.importFiles(paths, folderId ?? undefined)
    const last = result.rejected[result.rejected.length - 1]
    if (last) toast(last.reason, 'warning')
    return result.added
  } catch (e) {
    toast(e instanceof Error ? e.message : t('Import failed.'), 'error')
    return []
  } finally {
    if (progress !== null) dismissToast(progress)
  }
}

export async function newFolder(parentFolderId: string | null = editor().mediaFolderId): Promise<string | undefined> {
  const id = await runOp('createFolder', { name: 'New Folder', parentFolderId: parentFolderId ?? undefined })
  if (!id) return undefined
  const key: MediaKey = `folder:${id}`
  setEditor({ mediaSelection: [key] })
  mediaBridge.current?.beginRename(key)
  return id
}

const idsOf = (keys: MediaKey[], kind: 'asset' | 'folder' | 'timeline') => keys.filter((k) => k.startsWith(`${kind}:`)).map((k) => k.slice(kind.length + 1))

export async function deleteMediaItems(keys: MediaKey[] = editor().mediaSelection): Promise<void> {
  if (!keys.length) return
  const result = await runOp('deleteMediaItems', { assets: idsOf(keys, 'asset'), folders: idsOf(keys, 'folder'), timelines: idsOf(keys, 'timeline') })
  if (!result) return
  setEditor({ mediaSelection: [] })
  if (result.keptTimelines) toast(t('Kept one timeline — the project needs at least one.'))
}

/** ⌘V in the Media panel (`MediaTab.handleClipboardPaste`): copied files, else PNG/TIFF image data, into the current folder. */
export async function pasteMediaFromClipboard(folderId: string | null = editor().mediaFolderId): Promise<string[]> {
  try {
    const r = await window.palmier.media.pasteClipboard(folderId ?? undefined)
    if (r.kind === 'empty') return []
    const last = r.rejected[r.rejected.length - 1]
    if (last) toast(last.reason, 'warning')
    return r.added
  } catch (e) {
    toast(e instanceof Error ? e.message : t('Paste failed.'), 'error')
    return []
  }
}
