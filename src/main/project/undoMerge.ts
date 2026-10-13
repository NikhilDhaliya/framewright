/**
 * Undo/redo restore that leaves non-undoable media-library writes alone.
 *
 * Mac parity: timeline undo actions only restore timeline state, and media-library actions register their own
 * snapshots; assets added through `importMediaAsset` (generation results, Save as Media, mattes, …) register no
 * undo and are never removed by undoing an unrelated step. Linux keeps whole-document snapshots, so the manifest
 * is restored with a three-way merge instead: only entries/folders (and fields) that the undone step itself
 * changed go back to the target state; everything else keeps its current value.
 */
import type { MediaManifest } from '../../core/model'
import { structurallyEqual } from '../../core/util'

type Item = { id: string }

function mergeFields<T extends object>(cur: T, from: T, target: T): T {
  let out: Record<string, unknown> | null = null
  const f = from as Record<string, unknown>
  const t = target as Record<string, unknown>
  for (const k of new Set([...Object.keys(f), ...Object.keys(t)])) {
    if (structurallyEqual(f[k], t[k])) continue
    if (structurallyEqual((cur as Record<string, unknown>)[k], t[k])) continue
    out ??= { ...(cur as Record<string, unknown>) }
    if (t[k] === undefined) delete out[k]
    else out[k] = t[k]
  }
  return (out as T | null) ?? cur
}

/**
 * Three-way merge of an id-keyed list. `from` is the state the step left (its `after` for undo, `before` for redo),
 * `target` the state it restores, `cur` the live state (which may contain later non-undoable writes).
 */
export function mergeById<T extends Item>(cur: T[], from: T[], target: T[]): T[] {
  if (from === target) return cur
  const curById = new Map(cur.map((x) => [x.id, x]))
  const fromById = new Map(from.map((x) => [x.id, x]))
  const targetIds = new Set(target.map((x) => x.id))
  const out: T[] = []
  for (const t of target) {
    const f = fromById.get(t.id)
    const c = curById.get(t.id)
    if (!f) out.push(c ? mergeFields(c, c, t) : t) // the step removed it: bring it back
    else if (!c) {
      // Deleted outside undo since: stays deleted unless the step itself edited it.
      if (f !== t && !structurallyEqual(f, t)) out.push(t)
    } else out.push(f === t ? c : mergeFields(c, f, t))
  }
  // Items added outside the step (not known to either side) survive, after their current predecessor.
  for (let i = 0; i < cur.length; i++) {
    const c = cur[i]
    if (targetIds.has(c.id) || fromById.has(c.id)) continue
    let at = out.length
    for (let j = i - 1; j >= 0; j--) {
      const k = out.findIndex((x) => x.id === cur[j].id)
      if (k >= 0) {
        at = k + 1
        break
      }
    }
    out.splice(at, 0, c)
  }
  return out.length === cur.length && out.every((x, i) => x === cur[i]) ? cur : out
}

/** Manifest to install when restoring `target` from `from` while the live manifest is `cur`. */
export function mergeManifest(cur: MediaManifest, from: MediaManifest, target: MediaManifest): MediaManifest {
  if (from === target) return cur
  const entries = mergeById(cur.entries, from.entries, target.entries)
  const folders = mergeById(cur.folders, from.folders, target.folders)
  // Assets whose folder no longer exists fall back to the root (as the Mac does when a folder vanishes).
  const folderIds = new Set(folders.map((f) => f.id))
  const fixed = entries.map((e) => (e.folderId && !folderIds.has(e.folderId) ? (({ folderId: _drop, ...rest }) => rest)(e) : e))
  const changedEntries = fixed.some((e, i) => e !== entries[i])
  return { ...target, entries: changedEntries ? fixed : entries, folders }
}
