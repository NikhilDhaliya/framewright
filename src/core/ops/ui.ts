/** Editor-UI ops that bundle several primitives into one undo step. */
import { EditRefusal } from '../timeline'
import type { Doc } from './context'
import { applyEffectEntries } from './effects'
import { deleteFolders, deleteMedia, deleteTimeline, folderDescendants } from './project'
import { mutateClips } from './properties'

export interface MediaItems {
  assets?: string[]
  folders?: string[]
  timelines?: string[]
}

/** Media-panel delete: folders (with contents), loose assets and timelines; the last timeline is kept. */
export function deleteMediaItems(doc: Doc, items: MediaItems): { keptTimelines: number } {
  const folders = (items.folders ?? []).filter((id) => doc.manifest.folders.some((f) => f.id === id))
  const inside = folderDescendants(doc, folders)
  const assets = (items.assets ?? []).filter((id) => {
    const e = doc.manifest.entries.find((x) => x.id === id)
    return e && !(e.folderId && inside.has(e.folderId))
  })
  const timelines = (items.timelines ?? []).filter((id) => doc.file.timelines.some((t) => t.id === id))
  if (!folders.length && !assets.length && !timelines.length) throw new EditRefusal('Nothing to delete.')
  if (folders.length) deleteFolders(doc, folders)
  if (assets.length) deleteMedia(doc, assets)
  let kept = 0
  for (const id of timelines) {
    if (doc.file.timelines.length <= 1) kept++
    else deleteTimeline(doc, id)
  }
  if (!folders.length && !assets.length && kept === timelines.length) throw new EditRefusal("Can't delete every timeline — the project needs at least one.")
  return { keptTimelines: kept }
}

export interface EffectEdit {
  type: string
  /** Numeric params to merge (clamped to the registry range). */
  params?: Record<string, number>
  /** String params (curve JSON, LUT path). */
  strings?: Record<string, string>
  enabled?: boolean
  /** Removes the effect instead (e.g. every param is back at its default). */
  remove?: boolean
}

/** Adjust-tab edit over several clips: upserts or removes effects in canonical order. */
export function editEffects(doc: Doc, ids: string[], edits: EffectEdit[]): string[] {
  return mutateClips(doc, ids, (c) => {
    for (const e of edits) {
      if (e.remove) {
        applyEffectEntries(c, [], [e.type])
        continue
      }
      applyEffectEntries(c, [{ type: e.type, params: e.params, enabled: e.enabled }], [])
      if (!e.strings) continue
      const fx = c.effects?.find((x) => x.type === e.type)
      if (fx) fx.params = { ...fx.params, ...Object.fromEntries(Object.entries(e.strings).map(([k, v]) => [k, { ...fx.params[k], string: v }])) }
    }
  })
}
