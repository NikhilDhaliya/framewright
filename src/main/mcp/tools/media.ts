/** get_media (library inventory) and organize_media (folders, moves, renames, deletes in one undo step). */
import { activeTimeline, timelineById, type Doc } from '../../../core/ops/context'
import { deleteFolders, deleteMedia, deleteTimeline, folderDescendants, moveToFolder, renameFolder, renameMedia, renameTimeline } from '../../../core/ops/project'
import { ToolError, isObj, lenient, validateUnknownKeys, type Obj } from './args'
import { mutate, okJson, okRawJson, type ToolEnv, type ToolResult } from './context'
import { mutationResult, snapshot } from './delta'
import { allFolderPaths, folderPath, folderSegments, lookupFolder, notALibraryItem, requireFolder, resolveOrCreateFolder } from './folders'
import { ignoringNoop } from './timeline'
import { timelineEntries } from './timelineView'

const PROMPT_LIMIT = 100

export function truncatedPrompt(prompt: unknown): string | undefined {
  if (typeof prompt !== 'string' || !prompt) return undefined
  const chars = [...prompt]
  return chars.length > PROMPT_LIMIT ? chars.slice(0, PROMPT_LIMIT).join('') + '…' : prompt
}

export const isPending = (status?: string): status is string => !!status && status !== 'none'

export function getMedia(env: ToolEnv, args: Obj): ToolResult {
  validateUnknownKeys(args, ['ids', 'folder', 'pending'], 'get_media')
  const doc = env.session.doc
  const ids = new Set(lenient.stringArray(args, 'ids'))
  const pendingOnly = args.pending === true
  const folder = lenient.string(args, 'folder')
  const scope = folder !== undefined ? folderDescendants(doc, [requireFolder(doc, folder)]) : null
  const assets = doc.manifest.entries.flatMap((e) => {
    if (ids.size && !ids.has(e.id)) return []
    const pending = isPending(e.generationStatus)
    if (pendingOnly && !pending) return []
    if (scope && !(e.folderId && scope.has(e.folderId))) return []
    const a: Obj = { id: e.id, name: e.name, type: e.type }
    if (e.duration > 0) a.durationSeconds = e.duration
    if (e.sourceWidth !== undefined && e.sourceHeight !== undefined) {
      a.width = e.sourceWidth
      a.height = e.sourceHeight
    }
    if (e.sourceFPS !== undefined) a.fps = e.sourceFPS
    if (e.hasAudio && e.type === 'video') a.hasAudio = true
    const path = folderPath(doc, e.folderId)
    if (path) a.folder = path
    if (pending) a.generationStatus = e.generationStatus
    if (ids.size && e.generationStatus?.startsWith('failed: ')) env.feedback.lastError = e.generationStatus.slice('failed: '.length)
    const input = e.generationInput as Obj | undefined
    if (input?.draft === true) {
      a.draft = true
      if (!pending && input.backendJobId !== undefined && Array.isArray(input.resultURLs) && input.resultURLs.length >= 2) a.canEnhanceDraft = true
    }
    const prompt = truncatedPrompt(input?.prompt)
    if (prompt) a.prompt = prompt
    return [a]
  })
  const payload: Obj = { assets }
  if (!ids.size && !pendingOnly && !scope) {
    const folders = allFolderPaths(doc)
    if (folders.length) payload.folders = folders
    payload.timelines = timelineEntries(doc, true, (id) => folderPath(doc, id))
  }
  return okJson(payload)
}

// ---------- organize_media ----------

type LibraryItem = { kind: 'asset'; id: string } | { kind: 'timeline'; id: string } | { kind: 'folder'; id: string; path: string }

function libraryItem(doc: Doc, ref: string, path: string): LibraryItem {
  if (doc.manifest.entries.some((e) => e.id === ref)) return { kind: 'asset', id: ref }
  if (timelineById(doc, ref)) return { kind: 'timeline', id: ref }
  let folder: string | null = null
  try {
    folder = lookupFolder(doc, ref)
  } catch {
    folder = null
  }
  if (folder) return { kind: 'folder', id: folder, path: ref }
  throw notALibraryItem(doc, path, ref)
}

function organizeEntries(args: Obj, key: string): Obj[] {
  if (args[key] === undefined) return []
  const raw = args[key]
  if (!Array.isArray(raw) || !raw.length) throw new ToolError(`'${key}' must be a non-empty array`)
  return raw.map((e, i) => {
    if (!isObj(e)) throw new ToolError(`${key}[${i}] must be an object`)
    return e
  })
}

const split = (items: LibraryItem[]) => ({
  assets: items.filter((i) => i.kind === 'asset').map((i) => i.id),
  timelines: items.filter((i) => i.kind === 'timeline').map((i) => i.id),
  folders: items.filter((i) => i.kind === 'folder').map((i) => i.id),
})

const clipCount = (d: Doc) => d.file.timelines.reduce((n, t) => n + t.tracks.reduce((m, tr) => m + tr.clips.length, 0), 0)

export function organizeMedia(env: ToolEnv, args: Obj): ToolResult {
  validateUnknownKeys(args, ['createFolders', 'moves', 'renames', 'deletes'], 'organize_media')
  const doc = env.session.doc
  const createPaths = lenient.stringArray(args, 'createFolders')
  const moves = organizeEntries(args, 'moves').map((entry, i) => {
    const path = `moves[${i}]`
    validateUnknownKeys(entry, ['items', 'into'], path)
    const refs = lenient.stringArray(entry, 'items')
    if (!refs.length) throw new ToolError(`${path}: items is required`)
    const items = refs.map((r) => libraryItem(doc, r, path))
    const into = lenient.string(entry, 'into')
    if (into !== undefined) {
      const target = folderSegments(into).map((s) => s.toLowerCase())
      for (const item of items) {
        if (item.kind !== 'folder') continue
        const current = (folderPath(doc, item.id) ?? item.path).split('/').map((s) => s.trim().toLowerCase())
        if (current.every((s, k) => target[k] === s)) throw new ToolError(`Can't move folder '${item.path}' into itself or its own subfolder.`)
      }
    }
    return { items, into }
  })
  const renames = organizeEntries(args, 'renames').map((entry, i) => {
    const path = `renames[${i}]`
    validateUnknownKeys(entry, ['item', 'name'], path)
    const ref = lenient.requireString(entry, 'item')
    const name = lenient.requireString(entry, 'name')
    return { item: libraryItem(doc, ref, path), name }
  })
  const deletes = lenient.stringArray(args, 'deletes').map((r) => libraryItem(doc, r, 'deletes'))
  if (!createPaths.length && !moves.length && !renames.length && !deletes.length) {
    throw new ToolError('Nothing to do — pass at least one of createFolders, moves, renames, deletes.')
  }
  const del = split(deletes)
  const assetIds = [...new Set(del.assets)]
  const timelineIds = [...new Set(del.timelines)]
  const folderIds = [...new Set(del.folders)]
  if (timelineIds.length >= doc.file.timelines.length) throw new ToolError("Can't delete every timeline — the project needs at least one.")
  for (const p of [...createPaths, ...moves.flatMap((m) => (m.into !== undefined ? [m.into] : []))]) lookupFolder(doc, p)
  const before = snapshot(doc)
  const activeBefore = activeTimeline(doc).id
  const result = mutate(env, 'Organize Media', (d) => {
    const createdFolders: string[] = []
    let moved = 0
    for (const p of createPaths) createdFolders.push(...resolveOrCreateFolder(d, p).created)
    for (const m of moves) {
      let dest: string | null = null
      if (m.into !== undefined) {
        const r = resolveOrCreateFolder(d, m.into)
        dest = r.id
        createdFolders.push(...r.created)
      }
      ignoringNoop(() => moveToFolder(d, split(m.items), dest))
      moved += m.items.length
    }
    for (const r of renames) {
      const item = r.item
      ignoringNoop(() => (item.kind === 'asset' ? renameMedia(d, item.id, r.name) : item.kind === 'timeline' ? renameTimeline(d, item.id, r.name) : renameFolder(d, item.id, r.name)))
    }
    const clipsBefore = clipCount(d)
    if (assetIds.length) deleteMedia(d, assetIds)
    if (folderIds.length) deleteFolders(d, folderIds)
    const clipsRemoved = clipsBefore - clipCount(d)
    for (const id of timelineIds) deleteTimeline(d, id)
    return { createdFolders, moved, clipsRemoved }
  })
  const after = env.session.doc
  const payload: Obj = {}
  if (result.createdFolders.length) payload.createdFolders = result.createdFolders
  if (result.moved) payload.moved = result.moved
  if (renames.length) payload.renamed = renames.length
  if (deletes.length) {
    const deleted: Obj = {}
    if (assetIds.length) deleted.assets = assetIds.length
    if (folderIds.length) deleted.folders = folderIds.length
    if (timelineIds.length) deleted.timelines = timelineIds.length
    payload.deleted = deleted
  }
  if (result.clipsRemoved > 0) payload.clipsRemoved = result.clipsRemoved
  if (timelineIds.length) {
    const refs = after.file.timelines.flatMap((t) => t.tracks.flatMap((tr) => tr.clips)).filter((c) => timelineIds.includes(c.mediaRef)).length
    if (refs) payload.warnings = [`${refs} nest clip(s) still reference deleted timeline(s) and will render black.`]
  }
  if (activeTimeline(after).id !== activeBefore) {
    payload.notes = ['Active timeline changed — re-read get_timeline.']
    return okRawJson(payload)
  }
  return mutationResult(after, before, { extra: payload })
}
