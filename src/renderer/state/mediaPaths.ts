import type { MediaManifestEntry } from '@core/model'
import { useProject } from './project'

/** Absolute path of an asset's original file (package-relative sources resolve against the open project). */
export function originalPath(entry: MediaManifestEntry): string | null {
  if ('external' in entry.source) return entry.source.external.absolutePath
  const dir = useProject.getState().snapshot?.path
  return dir ? `${dir.replace(/\/+$/, '')}/${entry.source.project.relativePath}` : null
}

export function originalPathOf(assetId: string): string | null {
  const entry = useProject.getState().snapshot?.doc.manifest.entries.find((e) => e.id === assetId)
  return entry ? originalPath(entry) : null
}

const sourceListeners = new Set<(assetIds: string[]) => void>()
let sources = new Map<string, string>()

/** Fires with the ids of assets whose source file changed (e.g. relinked), so cached visuals can be dropped. */
export function onAssetSourceChange(cb: (assetIds: string[]) => void): () => void {
  sourceListeners.add(cb)
  return () => sourceListeners.delete(cb)
}

useProject.subscribe((s, p) => {
  if (s.snapshot === p.snapshot) return
  const next = new Map<string, string>()
  const changed: string[] = []
  for (const e of s.snapshot?.doc.manifest.entries ?? []) {
    const key = ('external' in e.source ? e.source.external.absolutePath : e.source.project.relativePath) + (e.generationStatus ? `|${e.generationStatus}` : '')
    const prev = sources.get(e.id)
    if (prev !== undefined && prev !== key) changed.push(e.id)
    next.set(e.id, key)
  }
  sources = next
  if (changed.length) for (const cb of sourceListeners) cb(changed)
})
