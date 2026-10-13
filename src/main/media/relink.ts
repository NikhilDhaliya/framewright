/**
 * Reconnecting offline media (EditorViewModel+Relink.swift): find missing / unreadable assets, repoint one asset at
 * a chosen file, or match every offline asset to a same-named file under a folder.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { clipTypeForExtension, type MediaManifestEntry } from '../../core/model'
import { isInFlight } from '../../core/generation/status'
import type { ProbeResult } from '../../shared/api'
import { tm } from '../i18n'

/** Upper bound on files indexed by "Relink Folder…" so picking a huge tree can't stall the app. */
export const FOLDER_INDEX_LIMIT = 200_000

/** `ClipType.localizedTrackLabel`. */
const TYPE_LABEL: Record<string, () => string> = {
  video: () => tm('Video'), sequence: () => tm('Video'), audio: () => tm('Audio'), image: () => tm('Image'), text: () => tm('Text'), lottie: () => 'Lottie', subtitle: () => tm('Subtitle'),
}
export const typeLabel = (t: string): string => TYPE_LABEL[t]?.() ?? t

export const relinkTypeMismatch = (file: string, required: string, selected: string): string =>
  tm('Can\'t relink "{0}". Required media type: {1}. Selected media type: {2}.', path.basename(file), typeLabel(required), typeLabel(selected))

/** Type implied by the file's extension, or null when the extension is unknown (Mac `ClipType(fileExtension:)`). */
export const extensionType = (file: string): string | null => clipTypeForExtension(path.extname(file).slice(1).toLowerCase())

/** Offline assets: files that are missing, plus files that exist but can't be read. Generating placeholders are skipped. */
export interface OfflineReport {
  missing: string[]
  unprocessable: string[]
}

export async function offlineReport(
  entries: readonly MediaManifestEntry[],
  resolve: (e: MediaManifestEntry) => string | null,
  probe: (file: string) => Promise<unknown>,
): Promise<OfflineReport> {
  const missing: string[] = []
  const unprocessable: string[] = []
  await Promise.all(
    entries.map(async (e) => {
      // `refreshMissingMediaCache` subtracts assets that are still generating / recovering.
      if (isInFlight(e.generationStatus)) return
      const file = resolve(e)
      const st = file ? await fs.stat(file).catch(() => null) : null
      if (!file || !st || !st.isFile()) {
        missing.push(e.id)
        return
      }
      try {
        await probe(file)
      } catch {
        unprocessable.push(e.id)
      }
    }),
  )
  const order = new Map(entries.map((e, i) => [e.id, i]))
  const byOrder = (a: string, b: string) => order.get(a)! - order.get(b)!
  return { missing: missing.sort(byOrder), unprocessable: unprocessable.sort(byOrder) }
}

/** Lowercased file name → path for regular files under `dir` (depth-first, names sorted, first match wins). */
export async function fileIndex(dir: string, limit = FOLDER_INDEX_LIMIT): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  let seen = 0
  const walk = async (d: string): Promise<void> => {
    const items = await fs.readdir(d, { withFileTypes: true }).catch(() => [])
    items.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const it of items) {
      if (seen >= limit) return
      const p = path.join(d, it.name)
      if (it.isDirectory()) await walk(p)
      else if (it.isFile()) {
        seen++
        const key = it.name.toLowerCase()
        if (!map.has(key)) map.set(key, p)
      }
    }
  }
  await walk(dir)
  return map
}

/** Offline asset id → replacement path, matched by the expected file's name (case-insensitive). */
export function matchOffline(
  entries: readonly MediaManifestEntry[],
  offline: ReadonlySet<string>,
  resolve: (e: MediaManifestEntry) => string | null,
  index: ReadonlyMap<string, string>,
): Map<string, string> {
  const out = new Map<string, string>()
  for (const e of entries) {
    if (!offline.has(e.id)) continue
    const expected = resolve(e)
    if (!expected) continue
    const hit = index.get(path.basename(expected).toLowerCase())
    if (hit) out.set(e.id, hit)
  }
  return out
}

/** Manifest patch for a relinked asset; metadata refreshes when the new file could be probed. */
export function relinkPatch(source: MediaManifestEntry['source'], probe: ProbeResult | null): Partial<MediaManifestEntry> {
  if (!probe) return { source }
  const patch: Partial<MediaManifestEntry> = { source, duration: probe.duration, hasAudio: probe.type === 'audio' ? true : probe.type === 'video' ? probe.hasAudio : false }
  if (probe.width) patch.sourceWidth = probe.width
  if (probe.height) patch.sourceHeight = probe.height
  if (probe.fps && (probe.type === 'video' || probe.type === 'lottie')) patch.sourceFPS = probe.fps
  return patch
}
