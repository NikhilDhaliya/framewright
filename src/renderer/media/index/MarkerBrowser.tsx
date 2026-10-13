/**
 * Index ▸ Markers (05 §4.14, 03 §6; Mac `MediaPanel/IndexTab/MarkerBrowser.swift`): every marker of the active
 * timeline, sorted by time, filterable by status and searchable by name/comment. Each row edits color, time, duration,
 * status and comment in place (one undo step each, Mac action names) and can delete the marker.
 */
import { useEffect, useRef, useState } from 'react'
import type { MarkerStatus, RGBA, Timeline, TimelineMarker } from '@core/model'
import { formatTimecode, parseTimecode } from '@core/time'
import { MARKER_COLORS } from '../../theme/sizes'
import { setEditor, useEditor } from '../../state/editor'
import { clearPreview, commitOp, previewOp, runOp } from '../../state/ops'
import { seek } from '../../state/playback'
import { activatePreviewTab } from '../../state/previewTabs'
import { getTimeline } from '../../state/project'
import { fromHex } from '../../ui/ColorField'
import { Icon } from '../../ui/Icon'
import { openMenuBelow, type MenuItem } from '../../ui/Menu'
import { SearchField } from '../../ui/panels'
import { Popover } from '../../ui/Popover'
import { ScrubField } from '../../ui/ScrubField'
import { toast } from '../../ui/toast'
import { markerThumbnailSize, MARKER_STATUSES, sortedMarkers, statusInfo } from './markers'
import { useMarkerThumbnail } from './markerThumbs'
import './markers.css'
import { setIndex, useIndex } from './store'
import { t } from '../../i18n'

const THUMB_H = 62
const TIME_W = 64
const DURATION_W = 32
const COMMENT_H = 36

const css = (c: RGBA) => `rgba(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)}, ${c.a})`
const sameColor = (a: RGBA, b: RGBA) => Math.abs(a.r - b.r) < 0.004 && Math.abs(a.g - b.g) < 0.004 && Math.abs(a.b - b.b) < 0.004
const liveMarker = (id: string) => getTimeline()?.markers.find((m) => m.id === id) ?? null

function Flag({ color, w = 10, h = 12 }: { color: string; w?: number; h?: number }) {
  return (
    <svg width={w} height={h} viewBox="0 0 10 12" aria-hidden>
      <path d="M 0.5 0.5 H 9.5 V 7 L 5 11.5 L 0.5 7 Z" fill={color} stroke="var(--pp-border-timeline-marker)" strokeWidth={1} />
    </svg>
  )
}

/** Mac `editor.changeTimelineMarkers(updates:)` with the refusal toast "Couldn't change marker." */
async function change(id: string, label: string, update: (m: TimelineMarker) => TimelineMarker): Promise<void> {
  const current = liveMarker(id)
  if (!current) return void toast(t('Couldn’t change marker.'), 'error')
  const r = await commitOp('changeMarkers', { updates: [update(current)], label }, { quiet: true })
  if (r === undefined && JSON.stringify(update(current)) !== JSON.stringify(current)) toast(t('Couldn’t change marker.'), 'error')
}

function select(marker: TimelineMarker, doSeek = true): void {
  if (!liveMarker(marker.id)) return
  activatePreviewTab('timeline')
  setEditor({ selectedClipIds: [], selectedGap: null, range: null, selectedMarkerIds: [marker.id] })
  if (doSeek) seek(marker.startFrame)
}

function Thumbnail({ timelineId, frame, size }: { timelineId: string; frame: number; size: { w: number; h: number } }) {
  const dpr = window.devicePixelRatio || 1
  const url = useMarkerThumbnail(timelineId, frame, Math.max(16, Math.round(size.w * dpr)))
  return (
    <div className="pp-mk-thumb" style={{ width: size.w, height: size.h }}>
      {url ? <img src={url} alt="" draggable={false} /> : url === undefined ? <span className="pp-mk-spinner" /> : null}
    </div>
  )
}

function ColorButton({ marker }: { marker: TimelineMarker }) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  return (
    <>
      <button
        type="button"
        className="pp-mk-color"
        aria-label={t('Color')}
        onClick={(e) => {
          e.stopPropagation()
          select(marker, false)
          setAnchor(e.currentTarget.getBoundingClientRect())
        }}
      >
        <Flag color={css(marker.color)} />
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} className="pp-mk-colors">
          <div className="pp-marker-swatches">
            {MARKER_COLORS.map((hex) => {
              const c = fromHex(hex)!
              return (
                <button
                  key={hex}
                  type="button"
                  className={`pp-marker-swatch${sameColor(c, marker.color) ? ' on' : ''}`}
                  onClick={() => {
                    setAnchor(null)
                    void change(marker.id, 'Change Marker Color', (m) => ({ ...m, color: { ...c, a: m.color.a } }))
                  }}
                >
                  <svg width="10" height="12" viewBox="0 0 10 12">
                    <path d="M 0 0 H 10 V 7 L 5 12 L 0 7 Z" fill={hex} />
                  </svg>
                </button>
              )
            })}
          </div>
        </Popover>
      )}
    </>
  )
}

function statusItems(selected: MarkerStatus | null, includesAll: boolean, action: (s: MarkerStatus | null) => void): MenuItem[] {
  return [
    ...(includesAll ? ([{ label: t('All Statuses'), checked: selected === null, onSelect: () => action(null) }, { kind: 'divider' }] as MenuItem[]) : []),
    ...MARKER_STATUSES.map((s): MenuItem => ({ label: t(s.title), checked: selected === s.status, onSelect: () => action(s.status) })),
  ]
}

function TimingField({ marker, fps, field }: { marker: TimelineMarker; fps: number; field: 'time' | 'duration' }) {
  const isDuration = field === 'duration'
  const key = isDuration ? 'durationFrames' : 'startFrame'
  const spf = fps > 0 ? 1 / fps : 1
  const preview = (v: number) => {
    const m = liveMarker(marker.id)
    if (!m || !previewOp('changeMarkers', { updates: [{ ...m, [key]: Math.round(v) }] })) clearPreview()
  }
  return (
    <ScrubField
      value={marker[key]}
      min={0}
      max={2 ** 31 - 1}
      mult={isDuration ? spf : 1}
      decimals={isDuration ? 1 : 0}
      suffix={isDuration ? 's' : ''}
      sens={isDuration ? spf : 1}
      width={isDuration ? DURATION_W : TIME_W}
      adjust={Math.round}
      tip={isDuration ? t('Duration') : t('Time')}
      format={(v) => (isDuration ? (v === 0 ? '-' : `${(v * spf).toFixed(1)}s`) : formatTimecode(Math.round(v), fps))}
      parse={isDuration ? undefined : (t) => parseTimecode(t, fps)}
      onInteraction={(active) => active && select(marker, false)}
      onChange={preview}
      onCancel={clearPreview}
      onCommit={(v) => void change(marker.id, isDuration ? 'Change Marker Duration' : 'Move Marker', (m) => ({ ...m, [key]: Math.round(v) }))}
    />
  )
}

function CommentField({ marker }: { marker: TimelineMarker }) {
  const [text, setText] = useState(marker.comment)
  const baseline = useRef(marker.comment)
  const focused = useRef(false)
  const removing = useRef(false)
  useEffect(() => {
    if (focused.current) return
    setText(marker.comment)
    baseline.current = marker.comment
  }, [marker.comment])
  const sync = () => {
    const c = liveMarker(marker.id)?.comment ?? marker.comment
    setText(c)
    baseline.current = c
  }
  const commit = () => {
    const current = liveMarker(marker.id)
    if (!current || removing.current) return
    if (current.comment !== baseline.current) {
      sync()
      return void toast(t('The marker comment changed while you were editing. Review it and try again.'), 'error')
    }
    if (current.comment === text) return
    const next = text
    baseline.current = next
    void change(marker.id, 'Change Marker Comment', (m) => ({ ...m, comment: next }))
  }
  return (
    <textarea
      className="pp-mk-comment"
      style={{ height: COMMENT_H }}
      value={text}
      rows={2}
      placeholder={t('Add a comment')}
      spellCheck={false}
      data-tip={text || undefined}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setText(e.target.value)}
      onFocus={() => {
        focused.current = true
        sync()
        select(marker)
      }}
      onBlur={() => {
        focused.current = false
        commit()
      }}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Escape') {
          sync()
          // Revert, then leave without committing.
          removing.current = true
          e.currentTarget.blur()
          removing.current = false
        } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault()
          e.currentTarget.blur()
        }
      }}
    />
  )
}

function Row({ marker, fps, thumb, timelineId, selected }: { marker: TimelineMarker; fps: number; thumb: { w: number; h: number }; timelineId: string; selected: boolean }) {
  const info = statusInfo(marker.status)
  return (
    <div className={`pp-mk-row${selected ? ' on' : ''}`} data-marker-id={marker.id} onClick={() => select(marker)}>
      <Thumbnail timelineId={timelineId} frame={marker.startFrame} size={thumb} />
      <div className="pp-mk-main">
        <div className="pp-mk-top">
          <span className="pp-mk-name-wrap">
            <ColorButton marker={marker} />
            <span className="pp-mk-name ellipsis">{marker.name}</span>
          </span>
          <span className="pp-mk-actions" onClick={(e) => e.stopPropagation()}>
            <TimingField marker={marker} fps={fps} field="time" />
            <TimingField marker={marker} fps={fps} field="duration" />
            <button
              type="button"
              className="pp-iconbtn hh pp-mk-action"
              data-tip={t('Status: {0}', t(info.title))}
              onClick={(e) =>
                openMenuBelow(
                  e.currentTarget,
                  statusItems(marker.status, false, (s) => s && void change(marker.id, 'Change Marker Status', (m) => ({ ...m, status: s }))),
                  { minWidth: 120, alignRight: true },
                )
              }
            >
              <Icon sf="circle.fill" size={10} style={{ color: info.color }} />
            </button>
            <button
              type="button"
              className="pp-iconbtn hh tone-tertiary pp-mk-action"
              data-tip={t('Delete Marker')}
              onClick={() => {
                void runOp('changeMarkers', { deleteIds: [marker.id], label: 'Delete Marker' }, { quiet: true }).then((r) => {
                  if (r === undefined) toast(t('Couldn’t delete marker.'), 'error')
                })
              }}
            >
              <Icon sf="trash" size={10} />
            </button>
          </span>
        </div>
        <CommentField marker={marker} />
      </div>
    </div>
  )
}

export function MarkerBrowser({ timeline, modeTabs }: { timeline: Timeline; modeTabs: React.ReactNode }) {
  const query = useIndex((s) => s.query)
  const expanded = useIndex((s) => s.searchExpanded)
  const selectedIds = useEditor((s) => s.selectedMarkerIds)
  const [status, setStatus] = useState<MarkerStatus | null>(null)
  const markers = sortedMarkers(timeline.markers, query, status)
  const thumb = markerThumbnailSize(timeline.width, timeline.height, THUMB_H)
  // Mac `.onAppear { editor.selectPreviewTab(id: PreviewTab.timeline.id) }`.
  useEffect(() => activatePreviewTab('timeline'), [])
  useEffect(() => () => clearPreview(), [])
  const filterColor = status ? statusInfo(status).color : undefined
  return (
    <>
      <div className="pp-index-header">
        {!expanded && modeTabs}
        <span style={{ flex: 1 }} />
        <SearchField value={query} onChange={(q) => setIndex({ query: q })} expanded={expanded} onExpandedChange={(v) => setIndex({ searchExpanded: v })} />
        {!expanded && (
          <button
            type="button"
            className={`pp-iconbtn hh${status ? '' : ' tone-tertiary'}`}
            style={{ width: 18, height: 18, color: filterColor }}
            aria-label={t('Status Filter')}
            data-tip={t('Filter markers by status')}
            data-tip-align="trailing"
            onClick={(e) => openMenuBelow(e.currentTarget, statusItems(status, true, setStatus), { minWidth: 140, alignRight: true })}
          >
            <Icon sf="line.3.horizontal.decrease" size={10} />
          </button>
        )}
      </div>
      <div className="pp-index-hairline" />
      {timeline.markers.length === 0 ? (
        <div className="pp-mk-empty">
          <Flag color="var(--pp-text-muted)" w={12} h={14} />
          <span className="title">{t('No markers')}</span>
          <span className="detail">{t('Press M in the timeline to add a marker.')}</span>
        </div>
      ) : (
        <div className="pp-index-body">
          {markers.length === 0 ? (
            <div className="pp-mk-nomatch">{query.trim() ? t('No matches for “{0}”', query.trim()) : t('No markers match this filter.')}</div>
          ) : (
            <div className="pp-mk-rows">
              {markers.map((m) => (
                <Row key={m.id} marker={m} fps={timeline.fps} thumb={thumb} timelineId={timeline.id} selected={selectedIds.includes(m.id)} />
              ))}
            </div>
          )}
        </div>
      )}
    </>
  )
}
