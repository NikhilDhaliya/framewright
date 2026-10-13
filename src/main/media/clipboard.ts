/** Media panel paste (MediaTab+Drag.swift `handleClipboardPaste`): copied files or image data on the system clipboard. */
import { fileURLToPath } from 'node:url'
import { clipboard } from 'electron'

/** Raw OS clipboard format (Electron's `electron application/osclipboard` escape hatch). */
const rawFormat = (f: string) => `electron application/osclipboard;format="${f}"`
const FILE_LIST_FORMATS = ['text/uri-list', 'x-special/gnome-copied-files']
const IMAGE_FORMATS: [string, string][] = [['image/png', 'png'], ['image/tiff', 'tiff']]

async function blobText(item: Electron.ClipboardItem, type: string): Promise<string> {
  try {
    const b = await item.getType(type)
    return b instanceof Blob ? await b.text() : ''
  } catch {
    return ''
  }
}

/** Local paths from file:// URIs in `text/uri-list` / `x-special/gnome-copied-files` (first line "copy"/"cut"). */
export function fileUriPaths(text: string): string[] {
  const out: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const l = line.trim()
    if (!l.startsWith('file://')) continue
    try {
      out.push(fileURLToPath(l))
    } catch {
      // not a local file URI
    }
  }
  return out
}

/** `MediaTab.handleClipboardPaste` order: copied files first, then PNG, then TIFF image data. */
export async function readClipboardMedia(): Promise<{ files: string[] } | { image: Buffer; ext: string } | null> {
  const items = await clipboard.read().catch(() => [] as Electron.ClipboardItem[])
  for (const item of items) {
    for (const f of FILE_LIST_FORMATS) {
      const type = item.types.find((t) => t === f || t === rawFormat(f))
      const files = type ? fileUriPaths(await blobText(item, type)) : []
      if (files.length) return { files }
    }
  }
  for (const item of items) {
    for (const [type, ext] of IMAGE_FORMATS) {
      if (!item.types.includes(type)) continue
      try {
        const b = await item.getType(type)
        if (b instanceof Blob && b.size) return { image: Buffer.from(await b.arrayBuffer()), ext }
      } catch {
        // format vanished
      }
    }
  }
  return null
}
