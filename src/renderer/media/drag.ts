/** Internal drag payloads (plain text, one item per line) shared by media-panel sources and drop targets. */
export type DragItem = { kind: 'asset'; id: string; segment?: { lower: number; upper: number } } | { kind: 'timeline'; id: string } | { kind: 'folder'; id: string }

const SCHEMES = { asset: 'palmier-asset://', timeline: 'palmier-timeline://', folder: 'palmier-folder://' } as const

export function encodeDragItems(items: DragItem[]): string {
  return items
    .map((it) => {
      const base = SCHEMES[it.kind] + it.id
      return it.kind === 'asset' && it.segment ? `${base}#${it.segment.lower.toFixed(3)}-${it.segment.upper.toFixed(3)}` : base
    })
    .join('\n')
}

export function decodeDragItems(text: string): DragItem[] {
  const out: DragItem[] = []
  for (const line of text.split('\n')) {
    const s = line.trim()
    if (s.startsWith(SCHEMES.asset)) {
      const [id, frag] = s.slice(SCHEMES.asset.length).split('#')
      const m = frag ? /^([\d.]+)-([\d.]+)$/.exec(frag) : null
      out.push(m ? { kind: 'asset', id, segment: { lower: Number(m[1]), upper: Number(m[2]) } } : { kind: 'asset', id })
    } else if (s.startsWith(SCHEMES.timeline)) out.push({ kind: 'timeline', id: s.slice(SCHEMES.timeline.length) })
    else if (s.startsWith(SCHEMES.folder)) out.push({ kind: 'folder', id: s.slice(SCHEMES.folder.length) })
  }
  return out
}

/**
 * Items of the drag in progress that started inside this window. dataTransfer contents are unreadable
 * during dragover, so drop targets (timeline ghosts, folder highlights) read this instead.
 */
export const activeDrag: { items: DragItem[] | null } = { items: null }

export function beginInternalDrag(e: React.DragEvent, items: DragItem[]): void {
  e.dataTransfer.setData('text/plain', encodeDragItems(items))
  e.dataTransfer.effectAllowed = 'copyMove'
  activeDrag.items = items
  const end = () => {
    activeDrag.items = null
    window.removeEventListener('dragend', end, true)
  }
  window.addEventListener('dragend', end, true)
}

export const isFileDrag = (e: React.DragEvent | DragEvent) => !!e.dataTransfer?.types.includes('Files') && !activeDrag.items

/** Absolute paths of OS files dropped on the window. */
export function droppedPaths(e: React.DragEvent | DragEvent): string[] {
  return Array.from(e.dataTransfer?.files ?? [])
    .map((f) => window.palmierFiles.pathForFile(f))
    .filter(Boolean)
}
