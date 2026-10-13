import { create } from 'zustand'
import type { ClipType, MediaFolder, MediaManifestEntry, Timeline } from '@core/model'
import { totalFrames } from '@core/timeline'
import type { Doc } from '@core/ops/context'
import type { SFName } from '../ui/Icon'
import type { MediaKey } from '../state/editor'

export type ViewMode = 'folders' | 'flat' | 'grouped'
export type SortOrder = 'name' | 'dateAdded' | 'duration' | 'type'
export type FilterType = 'video' | 'audio' | 'image' | 'subtitle'
export type MediaSection = 'media' | 'index' | 'captions' | 'audio'

interface MediaViewState {
  section: MediaSection
  viewMode: ViewMode
  thumbSize: number
  sort: SortOrder
  filters: FilterType[]
  query: string
  searchExpanded: boolean
  renaming: MediaKey | null
  /** Column count of the visible grid, for ↑/↓ navigation. */
  columns: number
  collapsedSections: string[]
}

const INITIAL: MediaViewState = {
  section: 'media',
  viewMode: 'folders',
  thumbSize: 80,
  sort: 'dateAdded',
  filters: [],
  query: '',
  searchExpanded: false,
  renaming: null,
  columns: 1,
  collapsedSections: [],
}

/** Local, unpersisted media-panel view state (resets whenever the panel is recreated). */
export const useMediaView = create<MediaViewState>(() => INITIAL)
export const mediaView = () => useMediaView.getState()
export const setMediaView = (patch: Partial<MediaViewState>) => useMediaView.setState(patch)
export const resetMediaView = () => useMediaView.setState(INITIAL)

export const TYPE_ICON: Record<ClipType, SFName> = {
  video: 'video',
  audio: 'waveform',
  image: 'photo',
  lottie: 'sparkles',
  subtitle: 'captions.bubble',
  text: 'textformat',
  sequence: 'film.stack',
}

export const TYPE_COLOR: Record<ClipType, string> = {
  video: 'var(--pp-clip-video)',
  audio: 'var(--pp-clip-audio)',
  image: 'var(--pp-clip-image)',
  lottie: 'var(--pp-clip-animation)',
  subtitle: 'var(--pp-clip-text)',
  text: 'var(--pp-clip-text)',
  sequence: 'var(--pp-clip-sequence)',
}

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })
export const byName = <T extends { name: string }>(a: T, b: T) => collator.compare(a.name, b.name)

/** `Ns` under a minute, `M:SS` under an hour, else `H:MM:SS`; rounded, at least 1 s. */
export function formatBadgeDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0s'
  const s = Math.max(1, Math.round(seconds))
  if (s < 60) return `${s}s`
  const pad = (n: number) => String(n).padStart(2, '0')
  if (s < 3600) return `${Math.floor(s / 60)}:${pad(s % 60)}`
  return `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`
}

export const timelineSeconds = (t: Timeline) => (t.fps > 0 ? totalFrames(t) / t.fps : 0)

export function sortAssets(entries: MediaManifestEntry[], sort: SortOrder): MediaManifestEntry[] {
  switch (sort) {
    case 'name':
      return [...entries].sort(byName)
    case 'duration':
      return [...entries].sort((a, b) => b.duration - a.duration)
    case 'type':
      return [...entries].sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0))
    case 'dateAdded':
      return entries
  }
}

export function filterAssets(entries: MediaManifestEntry[], filters: FilterType[]): MediaManifestEntry[] {
  return filters.length ? entries.filter((e) => (filters as string[]).includes(e.type)) : entries
}

export function folderPath(folders: MediaFolder[], id: string | null): MediaFolder[] {
  const byId = new Map(folders.map((f) => [f.id, f]))
  const out: MediaFolder[] = []
  const seen = new Set<string>()
  let cur = id ? byId.get(id) : undefined
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id)
    out.unshift(cur)
    cur = cur.parentFolderId ? byId.get(cur.parentFolderId) : undefined
  }
  return out
}

export interface GridSection {
  /** Folder id, or null for the Library root. */
  folderId: string | null
  path: MediaFolder[]
  keys: MediaKey[]
}

export interface MediaLayout {
  /** Items in visible order (folders → timelines → assets), used for range selection and arrows. */
  keys: MediaKey[]
  sections: GridSection[] | null
}

/** Visible items for the current view mode, folder, sort and filters. */
export function layoutItems(doc: Doc, mode: ViewMode, folderId: string | null, sort: SortOrder, filters: FilterType[]): MediaLayout {
  const { entries, folders } = doc.manifest
  const timelines = doc.file.timelines
  const assets = sortAssets(filterAssets(entries, filters), sort)
  const sortedTimelines = sort === 'name' ? [...timelines].sort(byName) : timelines
  const tKey = (t: Timeline): MediaKey => `timeline:${t.id}`
  const aKey = (e: MediaManifestEntry): MediaKey => `asset:${e.id}`
  if (mode === 'flat') return { keys: [...sortedTimelines.map(tKey), ...assets.map(aKey)], sections: null }
  if (mode === 'folders') {
    const sub = folders.filter((f) => (f.parentFolderId ?? null) === folderId).sort(byName)
    return {
      keys: [
        ...sub.map((f): MediaKey => `folder:${f.id}`),
        ...sortedTimelines.filter((t) => (t.folderId ?? null) === folderId).map(tKey),
        ...assets.filter((e) => (e.folderId ?? null) === folderId).map(aKey),
      ],
      sections: null,
    }
  }
  const sectionFor = (id: string | null): GridSection => ({
    folderId: id,
    path: folderPath(folders, id),
    keys: [...sortedTimelines.filter((t) => (t.folderId ?? null) === id).map(tKey), ...assets.filter((e) => (e.folderId ?? null) === id).map(aKey)],
  })
  const pathLabel = (s: GridSection) => s.path.map((f) => f.name).join(' / ')
  const rest = folders.map((f) => sectionFor(f.id)).sort((a, b) => collator.compare(pathLabel(a), pathLabel(b)))
  const sections = [sectionFor(null), ...rest]
  return { keys: sections.flatMap((s) => s.keys), sections }
}

export interface SearchResults {
  folders: MediaKey[]
  timelines: MediaKey[]
  files: MediaKey[]
}

const fold = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()

export function searchItems(doc: Doc, query: string, mode: ViewMode, sort: SortOrder, filters: FilterType[]): SearchResults {
  const q = fold(query.trim())
  const match = (name: string) => fold(name).includes(q)
  return {
    folders: mode === 'folders' ? doc.manifest.folders.filter((f) => match(f.name)).sort(byName).map((f): MediaKey => `folder:${f.id}`) : [],
    timelines: doc.file.timelines.filter((t) => match(t.name)).map((t): MediaKey => `timeline:${t.id}`),
    files: sortAssets(filterAssets(doc.manifest.entries, filters), sort)
      .filter((e) => match(e.name))
      .map((e): MediaKey => `asset:${e.id}`),
  }
}

export function parseKey(key: MediaKey): { kind: 'asset' | 'folder' | 'timeline'; id: string } {
  const i = key.indexOf(':')
  return { kind: key.slice(0, i) as 'asset' | 'folder' | 'timeline', id: key.slice(i + 1) }
}

/** Absolute path of an asset's source file. */
export function assetPath(entry: MediaManifestEntry, projectPath: string): string {
  if ('external' in entry.source) return entry.source.external.absolutePath
  return `${projectPath.replace(/\/+$/, '')}/${entry.source.project.relativePath}`
}

/** Grid column math from §4.4: spacing 10, usable = width − 20. */
export function gridColumns(width: number, size: number): { cols: number; tile: number } {
  const usable = Math.max(0, width - 20)
  const cols = Math.max(1, Math.floor((usable + 10) / (size + 10)))
  return { cols, tile: Math.max(size, (usable - (cols - 1) * 10) / cols) }
}
