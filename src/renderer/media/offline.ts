/**
 * Offline media (Mac `missingMediaRefs` + `unprocessableMediaRefs`): asset ids whose source file is missing, or
 * present but unreadable. Main stats/probes the files; this store refreshes when the manifest's sources change and
 * when the window regains focus (files may have been moved or a drive re-mounted meanwhile).
 */
import { create } from 'zustand'
import type { MediaManifestEntry } from '@core/model'
import { useProject } from '../state/project'
import { toast } from '../ui/toast'
import { t } from '../i18n'

interface OfflineStore {
  missing: ReadonlySet<string>
  unprocessable: ReadonlySet<string>
  /** missing ∪ unprocessable (`isMediaOffline`). */
  offline: ReadonlySet<string>
}

const EMPTY: ReadonlySet<string> = new Set()
export const useOffline = create<OfflineStore>(() => ({ missing: EMPTY, unprocessable: EMPTY, offline: EMPTY }))

/** `isMediaOffline(id)`. */
export const isMediaOffline = (id: string): boolean => useOffline.getState().offline.has(id)
/** `isMediaUnprocessable(id)`: present but couldn't be prepared. */
export const isMediaUnprocessable = (id: string): boolean => {
  const s = useOffline.getState()
  return s.unprocessable.has(id) && !s.missing.has(id)
}

const sameSet = (a: ReadonlySet<string>, b: string[]) => a.size === b.length && b.every((x) => a.has(x))

let seq = 0
let timer: number | undefined

export async function refreshOffline(): Promise<void> {
  const mine = ++seq
  if (!useProject.getState().snapshot) {
    useOffline.setState({ missing: EMPTY, unprocessable: EMPTY, offline: EMPTY })
    return
  }
  const r = await window.palmier.media.offline().catch(() => null)
  if (!r || mine !== seq) return
  const cur = useOffline.getState()
  if (sameSet(cur.missing, r.missing) && sameSet(cur.unprocessable, r.unprocessable)) return
  useOffline.setState({ missing: new Set(r.missing), unprocessable: new Set(r.unprocessable), offline: new Set([...r.missing, ...r.unprocessable]) })
}

function scheduleRefresh(delay = 60): void {
  window.clearTimeout(timer)
  timer = window.setTimeout(() => void refreshOffline(), delay)
}

/** What decides offline-ness: project path plus every asset's source and generation status. */
function sourcesKey(path: string | undefined, entries: readonly MediaManifestEntry[] | undefined): string {
  let k = path ?? ''
  for (const e of entries ?? []) k += `\n${e.id}|${'external' in e.source ? e.source.external.absolutePath : e.source.project.relativePath}|${e.generationStatus ?? ''}`
  return k
}

let lastKey = ''
if (typeof window !== 'undefined') {
  useProject.subscribe((s, p) => {
    if (s.snapshot === p.snapshot) return
    const key = sourcesKey(s.snapshot?.path, s.snapshot?.doc.manifest.entries)
    if (key === lastKey) return
    lastKey = key
    scheduleRefresh()
  })
  window.addEventListener('focus', () => scheduleRefresh(0))
  const s = useProject.getState().snapshot
  if (s) {
    lastKey = sourcesKey(s.path, s.doc.manifest.entries)
    scheduleRefresh(0)
  }
}

/** `relinkAsset(id:to:)`: picks a file (unless given) and repoints the asset at it. */
export async function relinkAsset(id: string, path?: string): Promise<boolean> {
  const r = await window.palmier.media.relink(id, path).catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }))
  if (!r.ok) {
    if (r.error) toast(r.error, 'warning')
    return false
  }
  void refreshOffline()
  return true
}

/** "Relink Folder…" (`relinkOfflineAssets(fromFolder:)`): relinks every offline asset to a same-named file in a folder. */
export async function relinkFolder(folder?: string): Promise<void> {
  const r = await window.palmier.media.relinkFolder(folder).catch((e: unknown) => ({ relinked: 0, total: 0, error: e instanceof Error ? e.message : String(e) }))
  if (!r) return
  if (r.error) toast(r.error, 'error')
  toast(t('Relinked {0} of {1} offline clips.', r.relinked, r.total), 'warning')
  void refreshOffline()
}
