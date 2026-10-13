/**
 * Index tab (spec 07 §1.11; Mac `MediaPanel/IndexTab/*`): Transcript browser with caption-group fallbacks, the
 * cached-transcript auto-load, and the transcript-only Captions tab as its empty state; Markers browser (MarkerBrowser.tsx).
 */
import { useEffect, useMemo, useRef } from 'react'
import { captionFallbacks, rowsMatching, TranscriptTimelineIndex, type TimelineTranscriptDocument, type TimelineTranscriptRow } from '@core/captions/timelineTranscript'
import { rgbaCss, speakerIdAt, speakerName } from '@core/audio/speakers'
import type { Timeline } from '@core/model'
import { formatTimecode } from '@core/time'
import { expandToLinkGroup, trackDisplayLabel } from '@core/timeline'
import { selectClips, setEditor, useEditor } from '../../state/editor'
import { seek, usePlayhead } from '../../state/playback'
import { activatePreviewTab } from '../../state/previewTabs'
import { getTimeline, useDoc, useTimeline } from '../../state/project'
import { MenuValue } from '../../ui/controls'
import { Icon } from '../../ui/Icon'
import type { MenuItem } from '../../ui/Menu'
import { SearchField } from '../../ui/panels'
import { useAudio } from '../../audio/store'
import { CaptionsTab } from '../captions/CaptionsTab'
import { cachedTimelineTranscript } from '../captions/pipeline'
import '../captions/captions.css'
import { setIndex, useIndex, type IndexMode } from './store'
import { MarkerBrowser } from './MarkerBrowser'
import { t } from '../../i18n'

function ModeTabs() {
  const mode = useIndex((s) => s.mode)
  return (
    <span className="pp-index-modes">
      {(['transcript', 'markers'] as IndexMode[]).map((m) => (
        <button key={m} type="button" className={`pp-index-mode${mode === m ? ' on' : ''}`} onClick={() => setIndex({ mode: m, query: '', searchExpanded: false })}>
          {m === 'transcript' ? t('Transcript') : t('Markers')}
        </button>
      ))}
    </span>
  )
}

function docLabel(doc: TimelineTranscriptDocument | null): string {
  const tl = getTimeline()
  const index = doc?.sourceTrackId && tl ? tl.tracks.findIndex((tr) => tr.id === doc.sourceTrackId) : -1
  return index >= 0 && tl ? t('Caption {0}', trackDisplayLabel(tl, index)) : t('Transcript')
}

/** `TranscriptSourceMenu` (max width 116), shown only when caption documents exist. */
function SourceMenu({ shown, captions }: { shown: TimelineTranscriptDocument | null; captions: TimelineTranscriptDocument[] }) {
  if (!captions.length) return null
  const items = (): MenuItem[] => [
    { label: t('Transcript'), checked: !shown?.sourceCaptionGroupId, onSelect: () => setIndex({ source: { kind: 'transcript' } }) },
    { kind: 'divider' },
    ...captions.map((c): MenuItem => ({ label: docLabel(c), checked: shown?.sourceCaptionGroupId === c.sourceCaptionGroupId, onSelect: () => setIndex({ source: { kind: 'captions', groupId: c.sourceCaptionGroupId! } }) })),
  ]
  return (
    <span style={{ maxWidth: 116, minWidth: 0, display: 'inline-flex' }}>
      <MenuValue text={docLabel(shown)} width={116} minWidth={140} items={items} />
    </span>
  )
}

function Search() {
  const query = useIndex((s) => s.query)
  const expanded = useIndex((s) => s.searchExpanded)
  return <SearchField value={query} onChange={(q) => setIndex({ query: q })} expanded={expanded} onExpandedChange={(v) => setIndex({ searchExpanded: v })} width={expanded ? 150 : undefined} />
}

interface RowSpeaker {
  name: string
  color: string
}

/**
 * [Linux addition — the Mac's TranscriptBrowser has no speakers] With Mark Speakers on, each row carries the colour of
 * the speaker identified at its midpoint (07 §3.5 session masks; the same lookup get_transcript uses).
 */
function useRowSpeakers(t: Timeline | null): (row: TimelineTranscriptRow) => RowSpeaker | null {
  const masks = useAudio((s) => s.speakerMasks)
  const on = useAudio((s) => s.markSpeakers)
  const registry = useDoc()?.file.speakers
  return useMemo(() => {
    if (!on || !t || !registry?.length) return (): RowSpeaker | null => null
    const clips = new Map(t.tracks.flatMap((tr) => tr.clips.map((c) => [c.id, c] as const)))
    return (row: TimelineTranscriptRow) => {
      const c = clips.get(row.clipId)
      const runs = c && masks[c.mediaRef]?.runs
      if (!c || !runs?.length) return null
      const mid = (row.startFrame + row.endFrame) / 2
      const id = speakerIdAt(runs, (c.trimStartFrame + (mid - c.startFrame) * c.speed) / t.fps)
      const sp = id >= 0 ? registry.find((r) => r.id === id) : undefined
      return sp ? { name: speakerName(id, registry), color: rgbaCss(sp.color) } : null
    }
  }, [masks, on, registry, t])
}

function Row({ row, fps, current, active, speaker }: { row: TimelineTranscriptRow; fps: number; current: boolean; active: boolean; speaker: RowSpeaker | null }) {
  const duration = row.endFrame - row.startFrame
  const select = () => {
    activatePreviewTab('timeline')
    setEditor({ selectedGap: null, range: null, selectedMarkerIds: [] })
    const t = getTimeline()
    if (t) selectClips([...expandToLinkGroup(t, [row.clipId])])
    seek(row.startFrame)
  }
  return (
    <div
      className={`pp-tr-row${current ? ' current' : ''}${active ? ' active' : ''}${speaker ? ' speaker' : ''}`}
      data-row-id={row.id}
      onClick={select}
      style={speaker ? { boxShadow: `inset 2px 0 0 ${speaker.color}` } : undefined}
      data-tip={speaker?.name}
      data-tip-align="leading"
    >
      <span className="pp-tr-time">{formatTimecode(row.startFrame, fps)}</span>
      <span className="pp-tr-dur">{duration > 0 && fps > 0 ? `${(duration / fps).toFixed(1)}s` : ''}</span>
      <span className="pp-tr-text">{row.text}</span>
    </div>
  )
}

function TranscriptBrowser({ doc, captions }: { doc: TimelineTranscriptDocument; captions: TimelineTranscriptDocument[] }) {
  const query = useIndex((s) => s.query)
  const expanded = useIndex((s) => s.searchExpanded)
  const frame = usePlayhead((s) => s.frame)
  const selected = useEditor((s) => s.selectedClipIds)
  const listRef = useRef<HTMLDivElement>(null)
  const speakerOf = useRowSpeakers(useTimeline())
  const index = useMemo(() => new TranscriptTimelineIndex(doc.rows), [doc])
  const rows = rowsMatching(doc.rows, query)
  const current = index.currentRow(frame)
  const jump = () => {
    if (!current) return
    setIndex({ query: '', searchExpanded: false })
    requestAnimationFrame(() => listRef.current?.querySelector(`[data-row-id="${CSS.escape(current.id)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }))
  }
  return (
    <>
      <div className="pp-index-header">
        {!expanded && <ModeTabs />}
        <span style={{ flex: 1 }} />
        {!expanded && <SourceMenu shown={doc} captions={captions} />}
        <Search />
        <button type="button" className={`pp-iconbtn hh ${current ? 'tone-secondary' : 'tone-muted'}`} style={{ width: 22, height: 22 }} disabled={!current} data-tip={t('Jump to Playhead')} data-tip-align="trailing" onClick={jump}>
          <Icon sf="timeline.selection" size={11} />
        </button>
      </div>
      <div className="pp-index-hairline" />
      <div className="pp-index-body" ref={listRef}>
        {rows.length ? (
          <div className="pp-tr-rows">
            {rows.map((r) => (
              <Row key={r.id} row={r} fps={doc.fps} current={current?.id === r.id} active={selected.includes(r.clipId)} speaker={speakerOf(r)} />
            ))}
          </div>
        ) : (
          <div className="pp-index-empty">{t('No matches for “{0}”', query.trim())}</div>
        )}
      </div>
    </>
  )
}

export function IndexTab() {
  const mode = useIndex((s) => s.mode)
  const transcript = useIndex((s) => s.transcript)
  const transcriptTimelineId = useIndex((s) => s.transcriptTimelineId)
  const source = useIndex((s) => s.source)
  const expanded = useIndex((s) => s.searchExpanded)
  const t = useTimeline()
  const doc = useDoc()
  const captions = useMemo(() => (t ? captionFallbacks(t) : []), [t])
  const ownTranscript = transcript && transcriptTimelineId === t?.id ? transcript : null

  // Cached transcript auto-load: on every timeline change while shown, filling only an empty slot.
  useEffect(() => {
    if (mode !== 'transcript' || ownTranscript || !t) return
    let live = true
    const id = t.id
    void cachedTimelineTranscript().then((cached) => {
      if (!live || !cached?.rows.length) return
      const s = useIndex.getState()
      if (s.transcript && s.transcriptTimelineId === id) return
      setIndex({ transcript: cached, transcriptTimelineId: id })
    })
    return () => {
      live = false
    }
  }, [doc, mode, ownTranscript, t])

  const shown = source.kind === 'automatic' ? (ownTranscript ?? captions[0] ?? null) : source.kind === 'transcript' ? ownTranscript : (captions.find((c) => c.sourceCaptionGroupId === source.groupId) ?? null)

  if (mode === 'markers') {
    return <div className="pp-index">{t && <MarkerBrowser timeline={t} modeTabs={<ModeTabs />} />}</div>
  }
  return (
    <div className="pp-index">
      {shown ? (
        <TranscriptBrowser doc={shown} captions={captions} />
      ) : (
        <>
          <div className="pp-index-header">
            {!expanded && <ModeTabs />}
            <span style={{ flex: 1 }} />
            {!expanded && <SourceMenu shown={null} captions={captions} />}
            <Search />
          </div>
          <div className="pp-index-hairline" />
          <div className="pp-index-body">
            <CaptionsTab mode="transcript" />
          </div>
        </>
      )}
    </div>
  )
}
