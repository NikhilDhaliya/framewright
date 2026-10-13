/**
 * Project-open settlement of placeholders that were not created by AI generation (Mac
 * `VideoProject.finishRestoredMediaScan`): Save as Media / Extract Audio / Save Range / matte placeholders
 * (`generationStatus` set, no `generationInput`) and URL imports (`importInput`). Generated assets are left to
 * the generation service, which can resume them.
 *
 * - File present: an interrupted URL import is finished (importInput dropped, status cleared) unless it already
 *   failed; any other leftover status is cleared (`generationStatus != .none, !canResumeGeneration → .none`).
 * - File missing: a URL import becomes "failed: Import interrupted" (Mac). An extras placeholder that was still
 *   rendering becomes "failed: Interrupted" — the Mac leaves it spinning forever; Linux settles it so it can be
 *   deleted or retried (the job died with the previous process).
 */
import fs from 'node:fs/promises'
import type { MediaManifestEntry } from '../../core/model'
import { updateMediaEntry } from '../../core/ops/project'
import { failedStatus, isInFlight, parseStatus } from '../../core/generation/status'

export const IMPORT_INTERRUPTED = 'Import interrupted'
export const RENDER_INTERRUPTED = 'Interrupted'

type Patch = Partial<MediaManifestEntry>

/** Pure decision for one entry; `exists` = the media file is on disk. `null` = leave it alone. */
export function settlePlaceholder(e: MediaManifestEntry, exists: boolean): Patch | null {
  if (e.generationInput) return null
  const status = parseStatus(e.generationStatus)
  if (!e.importInput && status.kind === 'none') return null
  if (exists) {
    if (e.importInput) return status.kind === 'failed' ? null : { importInput: undefined, generationStatus: undefined }
    return { generationStatus: undefined }
  }
  if (e.importInput) return status.kind === 'failed' ? null : { generationStatus: failedStatus(IMPORT_INTERRUPTED) }
  return isInFlight(e.generationStatus) ? { generationStatus: failedStatus(RENDER_INTERRUPTED) } : null
}

async function isFile(p: string | null): Promise<boolean> {
  if (!p) return false
  return fs.stat(p).then((s) => s.isFile()).catch(() => false)
}

/** Computes the patches for every stale placeholder in a freshly opened document. */
export async function stalePlaceholderPatches(
  entries: readonly MediaManifestEntry[],
  resolve: (e: MediaManifestEntry) => string | null,
): Promise<Map<string, Patch>> {
  const out = new Map<string, Patch>()
  await Promise.all(
    entries.map(async (e) => {
      if (e.generationInput || (!e.importInput && parseStatus(e.generationStatus).kind === 'none')) return
      const patch = settlePlaceholder(e, await isFile(resolve(e)))
      if (patch) out.set(e.id, patch)
    }),
  )
  return out
}

export function applyPlaceholderPatches(d: { manifest: { entries: MediaManifestEntry[] } }, patches: Map<string, Patch>): void {
  for (const [id, patch] of patches) if (d.manifest.entries.some((e) => e.id === id)) updateMediaEntry(d as never, id, patch)
}
