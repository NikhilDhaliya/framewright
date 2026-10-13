/**
 * Media-tab "Moments" and "Spoken" result sections (spec 07 §2.5, 05 §4.10; Mac `MediaTab+Search.swift`). The query
 * runs after the tab's 250 ms debounce: spoken first, then visual. Clicking selects the asset and seeks its source
 * preview to the hit; dragging carries the asset with the hit's source segment (stills drag as plain assets).
 */
import { useEffect, useState } from 'react'
import { create } from 'zustand'
import type { MediaManifestEntry } from '@core/model'
import type { MomentHit, SpokenHit } from '../../../shared/search'
import { useEditor, type MediaKey } from '../../state/editor'
import { Icon, type SFName } from '../../ui/Icon'
import { beginInternalDrag } from '../drag'
import { clickItem } from '../interactions'
import { cachedThumbnail, loadThumbnail } from '../thumbnails'
import { requestSourceSeek } from './sourceSeek'
import { searchTimecode, startSearchStatus, useSearchStatus } from './status'
import './search.css'
import { t, tk } from '../../i18n'

export interface SmartResults {
  query: string
  moments: MomentHit[]
  spoken: SpokenHit[]
}

const EMPTY: SmartResults = { query: '', moments: [], spoken: [] }

/** Collapsed result sections ("Moments" / "Spoken"), shared by the grid order and the headers. */
export const useSmartCollapsed = create<{ collapsed: string[] }>(() => ({ collapsed: [] }))

/** Runs spoken then visual search for the (already debounced, trimmed) query. */
export function useSmartSearch(query: string): SmartResults {
  const [results, setResults] = useState<SmartResults>(EMPTY)
  const status = useSearchStatus((s) => s.status)
  const ready = status?.model.kind === 'ready'
  const indexing = !!status?.indexing.active
  useEffect(startSearchStatus, [])
  useEffect(() => {
    const api = window.palmier?.search
    if (!query || !api) return setResults(EMPTY)
    let live = true
    void (async () => {
      const spoken = await api.spoken(query).catch(() => [] as SpokenHit[])
      const moments = ready ? await api.moments(query).catch(() => [] as MomentHit[]) : []
      if (live) setResults({ query, moments, spoken })
    })()
    return () => {
      live = false
    }
    // Re-run when the model becomes ready or an indexing batch finishes, so new shots show up.
  }, [query, ready, indexing])
  return results.query === query ? results : EMPTY
}

/** Keyboard/range order: moments, spoken, then the name sections; deduped; collapsed sections skipped (Mac `searchOrderedItemIds`). */
export function smartSearchOrder(r: SmartResults, rest: MediaKey[], collapsed: string[]): MediaKey[] {
  const keys: MediaKey[] = [
    ...(collapsed.includes('Moments') ? [] : r.moments.map((h): MediaKey => `asset:${h.assetId}`)),
    ...(collapsed.includes('Spoken') ? [] : r.spoken.map((h): MediaKey => `asset:${h.assetId}`)),
    ...rest,
  ]
  return [...new Set(keys)]
}

function useFrame(assetId: string, time: number, entry: MediaManifestEntry | undefined): string | null {
  const isImage = entry?.type === 'image'
  const [src, setSrc] = useState<string | null>(() => (isImage ? cachedThumbnail(assetId) : null))
  useEffect(() => {
    let live = true
    if (!entry || entry.type === 'audio') return setSrc(null)
    const p = isImage ? loadThumbnail(assetId) : window.palmier.search.frame(assetId, time)
    void p.then((u) => live && setSrc(u)).catch(() => undefined)
    return () => {
      live = false
    }
  }, [assetId, time, entry, isImage])
  return src
}

function Thumb({ assetId, time, entry, width }: { assetId: string; time: number; entry: MediaManifestEntry | undefined; width?: number }) {
  const src = useFrame(assetId, time, entry)
  return (
    <div className="pp-moment-thumb" style={width ? { width, height: (width * 9) / 16 } : undefined}>
      {src ? <img src={src} alt="" draggable={false} /> : entry?.type === 'image' ? <Icon sf="photo" size={14} className="tone-tertiary" /> : null}
    </div>
  )
}

function select(assetId: string, seconds: number, e: React.MouseEvent) {
  clickItem(`asset:${assetId}`, e)
  if (!e.shiftKey && !e.ctrlKey && !e.metaKey) requestSourceSeek(assetId, seconds)
}

function drag(e: React.DragEvent, assetId: string, segment: { lower: number; upper: number } | null) {
  beginInternalDrag(e, [segment ? { kind: 'asset', id: assetId, segment } : { kind: 'asset', id: assetId }])
}

function MomentCard({ hit, entry, selected }: { hit: MomentHit; entry: MediaManifestEntry | undefined; selected: boolean }) {
  const isImage = entry?.type === 'image'
  const lower = hit.shotStart
  const upper = Math.max(hit.shotEnd, hit.shotStart + 0.1)
  return (
    <div
      className="pp-moment-card"
      data-media-key={`asset:${hit.assetId}`}
      data-selected={selected || undefined}
      data-testid="moment-card"
      draggable
      onDragStart={(e) => drag(e, hit.assetId, isImage ? null : { lower, upper })}
      onClick={(e) => select(hit.assetId, lower, e)}
    >
      <Thumb assetId={hit.assetId} time={hit.time} entry={entry} />
      <span className="pp-moment-name ellipsis">{entry?.name ?? ''}</span>
      {!isImage && (
        <span className="pp-moment-range mono tnum">
          {searchTimecode(lower)}–{searchTimecode(upper)}
        </span>
      )}
    </div>
  )
}

function SpokenRow({ hit, entry, selected, size }: { hit: SpokenHit; entry: MediaManifestEntry | undefined; selected: boolean; size: number }) {
  const lower = hit.start
  const upper = Math.max(hit.end, hit.start + 0.1)
  return (
    <div className="pp-spoken-row" data-media-key={`asset:${hit.assetId}`} data-selected={selected || undefined} draggable onDragStart={(e) => drag(e, hit.assetId, { lower, upper })} onClick={(e) => select(hit.assetId, lower, e)}>
      <Thumb assetId={hit.assetId} time={hit.start} entry={entry} width={size * 1.4} />
      <div className="pp-spoken-text">
        <span className="text">{hit.text}</span>
        <span className="meta ellipsis">
          {entry?.name ?? ''} · {searchTimecode(hit.start)}
        </span>
      </div>
    </div>
  )
}

function Header({ icon, title, count }: { icon: SFName; title: 'Moments' | 'Spoken'; count: number }) {
  const collapsed = useSmartCollapsed((s) => s.collapsed.includes(title))
  const toggle = () => useSmartCollapsed.setState((s) => ({ collapsed: collapsed ? s.collapsed.filter((x) => x !== title) : [...s.collapsed, title] }))
  return (
    <button type="button" className="pp-media-results-header pp-smart-header" onClick={toggle}>
      <Icon sf="chevron.down" size={9} strokeWidth={2.5} className={`chev${collapsed ? ' collapsed' : ''}`} />
      <Icon sf={icon} size={10} />
      <span className="title">{t(title)}</span>
      <span className="count tnum">{count}</span>
    </button>
  )
}

/** Moments + Spoken, rendered above the tab's Folders/Timelines/Files sections. */
export function SmartSearchSections({ results, entries, cols, cellWidth, size }: { results: SmartResults; entries: Map<string, MediaManifestEntry>; cols: number; cellWidth: number; size: number }) {
  const selection = useEditor((s) => s.mediaSelection)
  const collapsed = useSmartCollapsed((s) => s.collapsed)
  const moments = results.moments.filter((h) => entries.has(h.assetId))
  const spoken = results.spoken.filter((h) => entries.has(h.assetId))
  const isSel = (id: string) => selection.includes(`asset:${id}`)
  return (
    <div className="pp-smart-sections">
      {moments.length > 0 && (
        <div className="pp-media-results-section" data-testid="moments-section">
          <Header icon="sparkle.magnifyingglass" title={tk('Moments')} count={moments.length} />
          {!collapsed.includes('Moments') && (
            <div className="pp-media-grid results pp-moment-grid" style={{ gridTemplateColumns: `repeat(${cols}, ${cellWidth}px)` }}>
              {moments.map((h, i) => (
                <MomentCard key={`${h.assetId}:${h.shotStart}:${i}`} hit={h} entry={entries.get(h.assetId)} selected={isSel(h.assetId)} />
              ))}
            </div>
          )}
        </div>
      )}
      {spoken.length > 0 && (
        <div className="pp-media-results-section" data-testid="spoken-section">
          <Header icon="waveform" title={tk('Spoken')} count={spoken.length} />
          {!collapsed.includes('Spoken') && (
            <div className="pp-spoken-list">
              {spoken.map((h, i) => (
                <SpokenRow key={`${h.assetId}:${h.start}:${i}`} hit={h} entry={entries.get(h.assetId)} selected={isSel(h.assetId)} size={size} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
