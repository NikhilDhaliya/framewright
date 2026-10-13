import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { MediaFolder, MediaManifestEntry, Timeline } from '@core/model'
import type { Doc } from '@core/ops/context'
import { editor, useEditor, type MediaKey } from '../state/editor'
import { useDoc, useTimeline } from '../state/project'
import { Icon, type SFName } from '../ui/Icon'
import { importMedia } from './actions'
import { droppedPaths, isFileDrag } from './drag'
import { acceptsFolderDrop, backgroundContextMenu, dropIntoFolder, itemContextMenu, openItem, selectKeys, visibleOrder } from './interactions'
import { gridColumns, layoutItems, parseKey, searchItems, setMediaView, TYPE_COLOR, useMediaView, type GridSection } from './model'
import { compatibleAssets } from './mediaRules'
import { cancelMediaSwap, pendingSwapClip, useSwap } from './swap'
import { MiddleTruncate } from '../ui/controls'
import { AssetTile, FolderTile, TimelineTile } from './tiles'
import { MediaToolbar } from './Toolbar'
import { GeneratePanelDock } from '../generation/GeneratePanel'
import { SmartSearchSections, smartSearchOrder, useSmartCollapsed, useSmartSearch } from './search/SmartSearchSections'
import { t } from '../i18n'

const SEARCH_DEBOUNCE_MS = 250
const MARQUEE_THRESHOLD = 3

interface TileContext {
  entries: Map<string, MediaManifestEntry>
  folders: Map<string, MediaFolder>
  timelines: Map<string, Timeline>
  activeId: string | null
  used: Set<string>
  folderCounts: Map<string, number>
  posters: Map<string, string | null>
  selected: Set<MediaKey>
  renaming: MediaKey | null
  /** Assets that can replace the armed swap clip; null outside swap mode. */
  swapCompatible: Set<string> | null
}

function useTileContext(doc: Doc): Omit<TileContext, 'selected' | 'renaming' | 'swapCompatible'> {
  const active = useTimeline()
  const used = useMemo(() => new Set(active?.tracks.flatMap((tr) => tr.clips.map((c) => c.mediaRef)) ?? []), [active])
  const folderCounts = useMemo(() => {
    const m = new Map<string, number>()
    const bump = (id?: string) => id && m.set(id, (m.get(id) ?? 0) + 1)
    for (const f of doc.manifest.folders) bump(f.parentFolderId)
    for (const e of doc.manifest.entries) bump(e.folderId)
    return m
  }, [doc.manifest])
  const posters = useMemo(() => {
    const visual = new Set(doc.manifest.entries.filter((e) => e.type === 'video' || e.type === 'image').map((e) => e.id))
    const m = new Map<string, string | null>()
    const posterOf = (t: Timeline) => {
      for (const tr of t.tracks) {
        if (tr.type === 'audio') continue
        const c = tr.clips.find((x) => visual.has(x.mediaRef))
        if (c) return c.mediaRef
      }
      return null
    }
    for (const t of doc.file.timelines) m.set(t.id, posterOf(t))
    return m
  }, [doc.file.timelines, doc.manifest.entries])
  const entries = useMemo(() => new Map(doc.manifest.entries.map((e) => [e.id, e])), [doc.manifest.entries])
  const folders = useMemo(() => new Map(doc.manifest.folders.map((f) => [f.id, f])), [doc.manifest.folders])
  const timelines = useMemo(() => new Map(doc.file.timelines.map((t) => [t.id, t])), [doc.file.timelines])
  return { entries, folders, timelines, activeId: active?.id ?? null, used, folderCounts, posters }
}

function Tile({ k, width, ctx }: { k: MediaKey; width: number; ctx: TileContext }) {
  const { kind, id } = parseKey(k)
  const selected = ctx.selected.has(k)
  const renaming = ctx.renaming === k
  if (kind === 'asset') {
    const entry = ctx.entries.get(id)
    const swap = ctx.swapCompatible ? (ctx.swapCompatible.has(id) ? 'compatible' : 'dimmed') : null
    return entry ? <AssetTile entry={entry} width={width} selected={selected} renaming={renaming} onTimeline={ctx.used.has(id)} swap={swap} /> : null
  }
  if (kind === 'folder') {
    const folder = ctx.folders.get(id)
    return folder ? <FolderTile folder={folder} count={ctx.folderCounts.get(id) ?? 0} width={width} selected={selected} renaming={renaming} /> : null
  }
  const t = ctx.timelines.get(id)
  return t ? <TimelineTile timeline={t} posterAssetId={ctx.posters.get(id) ?? null} active={ctx.activeId === id} width={width} selected={selected} renaming={renaming} /> : null
}

function Grid({ keys, width, size, ctx, gap = 10, padding = '0 10px 10px' }: { keys: MediaKey[]; width: number; size: number; ctx: TileContext; gap?: number; padding?: string }) {
  const { cols, tile } = gridColumns(width, size)
  return (
    <div className="pp-media-grid" style={{ gridTemplateColumns: `repeat(${cols}, ${Math.floor(tile)}px)`, columnGap: gap, padding }}>
      {keys.map((k) => (
        <Tile key={k} k={k} width={Math.floor(tile)} ctx={ctx} />
      ))}
    </div>
  )
}

function Section({ section, width, size, ctx, collapsed }: { section: GridSection; width: number; size: number; ctx: TileContext; collapsed: boolean }) {
  const [hover, setHover] = useState(false)
  const key = section.folderId ?? 'root'
  const toggle = () => {
    const cur = useMediaView.getState().collapsedSections
    setMediaView({ collapsedSections: collapsed ? cur.filter((x) => x !== key) : [...cur, key] })
  }
  const leaf = section.path[section.path.length - 1]
  return (
    <div
      className={`pp-media-section${hover ? ' drop-hover' : ''}`}
      onDragOver={(e) => {
        if (!acceptsFolderDrop(e, section.folderId)) return
        e.preventDefault()
        e.stopPropagation()
        setHover(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHover(false)
      }}
      onDrop={(e) => {
        setHover(false)
        void dropIntoFolder(e, section.folderId)
      }}
    >
      <div className="pp-media-section-header">
        <button type="button" className={`pp-media-collapse hh${collapsed ? ' collapsed' : ''}`} data-tip={collapsed ? t('Expand') : t('Collapse')} onClick={toggle}>
          <Icon sf="chevron.down" size={9} strokeWidth={2.5} />
        </button>
        <button
          type="button"
          className="pp-media-section-folder hh"
          onClick={() => section.folderId && openItem(`folder:${section.folderId}`)}
          onContextMenu={(e) => section.folderId && itemContextMenu(`folder:${section.folderId}`, e)}
        >
          <Icon sf="folder.fill" size={10} className="pp-media-section-icon" />
          {leaf ? (
            <span className="pp-media-section-path">
              {section.path.slice(0, -1).map((f) => (
                <span key={f.id}>
                  <span className="parent">{f.name}</span>
                  <span className="sep"> / </span>
                </span>
              ))}
              <span className="leaf">{leaf.name}</span>
            </span>
          ) : (
            <span className="pp-media-section-path">
              <span className="leaf">{t('Library')}</span>
            </span>
          )}
        </button>
        <span className="pp-media-section-count tnum">{section.keys.length}</span>
      </div>
      {!collapsed && (
        <div className="pp-media-section-body">
          {section.keys.length ? <Grid keys={section.keys} width={width + 10} size={size} ctx={ctx} padding="6px 0 0" /> : <div className="pp-media-section-empty">{t('Empty')}</div>}
        </div>
      )}
    </div>
  )
}

function ResultSection({ icon, title, keys, children }: { icon: SFName; title: string; keys: MediaKey[]; children: ReactNode }) {
  if (!keys.length) return null
  return (
    <div className="pp-media-results-section">
      <div className="pp-media-results-header">
        <Icon sf={icon} size={10} />
        <span className="title">{title}</span>
        <span className="count tnum">{keys.length}</span>
      </div>
      {children}
    </div>
  )
}

/** Swap banner (§4.12): tinted with the clip's type colour. */
function SwapBanner({ doc, clipId }: { doc: Doc; clipId: string }) {
  const clip = pendingSwapClip(doc, clipId)
  const tint = TYPE_COLOR[clip?.mediaType ?? 'video']
  const name = (clip && doc.manifest.entries.find((e) => e.id === clip.mediaRef)?.name) ?? t('clip')
  return (
    <div
      className="pp-media-swap-banner"
      data-testid="swap-banner"
      style={{ background: `color-mix(in srgb, ${tint} 8%, transparent)`, boxShadow: `inset 0 -0.5px 0 color-mix(in srgb, ${tint} 15%, transparent)` }}
    >
      <Icon sf="arrow.left.arrow.right" size={12} strokeWidth={2.25} style={{ color: tint, flexShrink: 0 }} />
      <MiddleTruncate className="label" text={t('Pick a replacement for "{0}"', name)} />
      <button type="button" className="cancel" onClick={() => cancelMediaSwap()}>
        {t('Cancel')}
      </button>
    </div>
  )
}

interface MarqueeRect {
  x: number
  y: number
  w: number
  h: number
}

/** Grid area: content for the current view, marquee selection, background menu and OS-file drops. */
export function MediaTab() {
  const doc = useDoc()!
  const viewMode = useMediaView((s) => s.viewMode)
  const size = useMediaView((s) => s.thumbSize)
  const sort = useMediaView((s) => s.sort)
  const filters = useMediaView((s) => s.filters)
  const rawQuery = useMediaView((s) => s.query)
  const renaming = useMediaView((s) => s.renaming)
  const collapsedSections = useMediaView((s) => s.collapsedSections)
  const folderId = useEditor((s) => s.mediaFolderId)
  const selection = useEditor((s) => s.mediaSelection)
  const [query, setQuery] = useState('')
  const [width, setWidth] = useState(0)
  const [fileHover, setFileHover] = useState(false)
  const [marquee, setMarquee] = useState<MarqueeRect | null>(null)
  const areaRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const tabRef = useRef<HTMLDivElement>(null)
  const base = useTileContext(doc)

  useEffect(() => {
    const id = window.setTimeout(() => setQuery(rawQuery.trim()), SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(id)
  }, [rawQuery])

  useLayoutEffect(() => {
    const el = scrollRef.current!
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const layout = useMemo(() => layoutItems(doc, viewMode, folderId, sort, filters), [doc, viewMode, folderId, sort, filters])
  const results = useMemo(() => (query ? searchItems(doc, query, viewMode, sort, filters) : null), [doc, query, viewMode, sort, filters])
  const smart = useSmartSearch(query)
  const smartCollapsed = useSmartCollapsed((s) => s.collapsed)
  const swapClipId = useSwap((s) => s.clipId)
  const swapCompatible = useMemo(() => (swapClipId ? compatibleAssets(doc, swapClipId) : null), [doc, swapClipId])
  const ctx: TileContext = useMemo(() => ({ ...base, selected: new Set(selection), renaming, swapCompatible }), [base, selection, renaming, swapCompatible])

  const libraryEmpty = !doc.manifest.entries.length && !doc.manifest.folders.length
  const order = results
    ? smartSearchOrder(smart, [...results.folders, ...results.timelines, ...results.files], smartCollapsed)
    : libraryEmpty
      ? []
      : layout.sections
      ? layout.sections.filter((s) => !collapsedSections.includes(s.folderId ?? 'root')).flatMap((s) => s.keys)
      : layout.keys
  visibleOrder.keys = order
  const resultCols = Math.max(1, Math.floor((width - 20 + 6) / (size * 1.4 + 6)))
  useLayoutEffect(() => {
    setMediaView({ columns: results ? resultCols : gridColumns(width, size).cols })
  }, [results, resultCols, width, size])

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || (e.target as Element).closest('button, input, [data-media-key]')) return
    const area = areaRef.current!
    const r = area.getBoundingClientRect()
    const x0 = e.clientX
    const y0 = e.clientY
    const additive = e.shiftKey
    const baseSel = additive ? editor().mediaSelection : []
    let moved = false
    area.setPointerCapture(e.pointerId)
    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) <= MARQUEE_THRESHOLD) return
      moved = true
      const left = Math.min(x0, ev.clientX)
      const top = Math.min(y0, ev.clientY)
      const right = Math.max(x0, ev.clientX)
      const bottom = Math.max(y0, ev.clientY)
      setMarquee({ x: left - r.left, y: top - r.top, w: right - left, h: bottom - top })
      const hits: MediaKey[] = []
      for (const el of area.querySelectorAll<HTMLElement>('[data-media-key]')) {
        const b = el.getBoundingClientRect()
        if (b.right >= left && b.left <= right && b.bottom >= top && b.top <= bottom) hits.push(el.dataset.mediaKey as MediaKey)
      }
      selectKeys([...new Set([...baseSel, ...hits])], false)
    }
    const up = () => {
      area.removeEventListener('pointermove', move)
      area.removeEventListener('pointerup', up)
      area.removeEventListener('pointercancel', up)
      setMarquee(null)
      if (!moved && !additive) selectKeys([], false)
    }
    area.addEventListener('pointermove', move)
    area.addEventListener('pointerup', up)
    area.addEventListener('pointercancel', up)
  }

  let content: ReactNode
  if (results) {
    const resultWidth = Math.floor((width - 20 - (resultCols - 1) * 6) / resultCols)
    const grid = (keys: MediaKey[]) => (
      <div className="pp-media-grid results" style={{ gridTemplateColumns: `repeat(${resultCols}, ${resultWidth}px)` }}>
        {keys.map((k) => (
          <Tile key={k} k={k} width={resultWidth} ctx={ctx} />
        ))}
      </div>
    )
    content =
      results.folders.length + results.timelines.length + results.files.length + smart.moments.length + smart.spoken.length === 0 ? (
        <div className="pp-media-no-results">{t('No matches for “{0}”', query)}</div>
      ) : (
        <div className="pp-media-results">
          <SmartSearchSections results={smart} entries={ctx.entries} cols={resultCols} cellWidth={resultWidth} size={size} />
          <ResultSection icon="folder" title={t('Folders')} keys={results.folders}>
            {grid(results.folders)}
          </ResultSection>
          <ResultSection icon="film.stack" title={t('Timelines')} keys={results.timelines}>
            {grid(results.timelines)}
          </ResultSection>
          <ResultSection icon="doc" title={t('Files')} keys={results.files}>
            {grid(results.files)}
          </ResultSection>
        </div>
      )
  } else if (libraryEmpty) {
    content = (
      <div className="pp-media-empty">
        <Icon sf="photo.on.rectangle.angled" size={36} strokeWidth={1} className="tone-tertiary" />
        <div className="title">{t('No media yet')}</div>
        <div className="detail">{t('Drop files here or import from disk')}</div>
      </div>
    )
  } else if (layout.sections) {
    content = (
      <div className="pp-media-sections">
        {layout.sections.map((s) => (
          <Section key={s.folderId ?? 'root'} section={s} width={width - 20} size={size} ctx={ctx} collapsed={collapsedSections.includes(s.folderId ?? 'root')} />
        ))}
      </div>
    )
  } else if (!layout.keys.length) {
    content = <div className="pp-media-no-results">{t('This folder is empty')}</div>
  } else content = <Grid keys={layout.keys} width={width} size={size} ctx={ctx} />

  return (
    <div ref={tabRef} className="pp-media-tab">
      <MediaToolbar count={order.length} />
      {swapClipId && <SwapBanner doc={doc} clipId={swapClipId} />}
      <div
        ref={areaRef}
        className="pp-media-area"
        onPointerDown={onPointerDown}
        onContextMenu={backgroundContextMenu}
        onDragOver={(e) => {
          if (!isFileDrag(e)) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
          setFileHover(true)
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFileHover(false)
        }}
        onDrop={(e) => {
          setFileHover(false)
          if (!isFileDrag(e)) return
          e.preventDefault()
          const paths = droppedPaths(e)
          if (paths.length) void importMedia(paths, folderId)
        }}
      >
        <div ref={scrollRef} className="pp-media-scroll no-scrollbar">
          {content}
        </div>
        {marquee && <div className="pp-media-marquee" style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }} />}
        {fileHover && <div className="pp-media-drop-highlight" />}
      </div>
      <GeneratePanelDock containerRef={tabRef} />
    </div>
  )
}

