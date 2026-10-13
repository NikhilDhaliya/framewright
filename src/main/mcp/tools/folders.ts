/** Media folders are addressed by path ('B-roll/Sunset'): case-insensitive per segment, created on demand. */
import type { Doc } from '../../../core/ops/context'
import { createFolder } from '../../../core/ops/project'
import { ToolError } from './args'

export function folderPath(doc: Doc, folderId?: string): string | null {
  const names: string[] = []
  const seen = new Set<string>()
  let id = folderId
  while (id && !seen.has(id)) {
    seen.add(id)
    const f = doc.manifest.folders.find((x) => x.id === id)
    if (!f) break
    names.unshift(f.name)
    id = f.parentFolderId
  }
  return names.length ? names.join('/') : null
}

export function allFolderPaths(doc: Doc): string[] {
  return doc.manifest.folders
    .flatMap((f) => {
      const p = folderPath(doc, f.id)
      return p ? [p] : []
    })
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'accent' }))
}

export function folderSegments(path: string): string[] {
  const segments = path
    .split('/')
    .filter((s) => s.length)
    .map((s) => s.replace(/^[\p{Zs}\t]+|[\p{Zs}\t]+$/gu, ''))
  if (!segments.length || segments.some((s) => !s)) throw new ToolError(`Invalid folder path '${path}'. Use segment names joined by '/', e.g. 'B-roll/Sunset'.`)
  return segments
}

function childFolder(doc: Doc, name: string, parent: string | undefined, path: string): string | undefined {
  const matches = doc.manifest.folders.filter((f) => f.parentFolderId === parent && f.name.toLowerCase() === name.toLowerCase())
  if (matches.length > 1) {
    const exact = matches.find((f) => f.name === name)
    if (exact) return exact.id
    throw new ToolError(`Folder path '${path}' is ambiguous at '${name}' (${matches.length} matches). Rename one of the duplicates first.`)
  }
  return matches[0]?.id
}

/** Resolves an existing path (null when a segment is missing); throws on syntax errors and ambiguity. */
export function lookupFolder(doc: Doc, path: string): string | null {
  let parent: string | undefined
  for (const segment of folderSegments(path)) {
    const next = childFolder(doc, segment, parent, path)
    if (!next) return null
    parent = next
  }
  return parent ?? null
}

const folderList = (doc: Doc) => {
  const paths = allFolderPaths(doc)
  return paths.length ? paths.join(', ') : '(none yet)'
}

export function requireFolder(doc: Doc, path: string): string {
  const id = lookupFolder(doc, path)
  if (!id) throw new ToolError(`Folder not found: '${path}'. Folders: ${folderList(doc)}`)
  return id
}

export function notALibraryItem(doc: Doc, path: string, ref: string): ToolError {
  return new ToolError(`${path}: '${ref}' is not an asset id, timeline id, or folder path. Folders: ${folderList(doc)}`)
}

/** Resolves a path on a draft, creating missing segments; returns the id and the created paths. */
export function resolveOrCreateFolder(draft: Doc, path: string): { id: string; created: string[] } {
  let parent: string | undefined
  const walked: string[] = []
  const created: string[] = []
  for (const segment of folderSegments(path)) {
    walked.push(segment)
    const existing = childFolder(draft, segment, parent, path)
    if (existing) parent = existing
    else {
      parent = createFolder(draft, segment, parent).id
      created.push(walked.join('/'))
    }
  }
  return { id: parent!, created }
}

