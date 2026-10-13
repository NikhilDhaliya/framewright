import { useEffect, useRef, useState, type RefObject } from 'react'
import type { RGBA, TimelineMarker } from '@core/model'
import { formatTimecode, parseTimecode } from '@core/time'
import { MARKER_COLORS } from '../theme/sizes'
import { setEditor, useEditor } from '../state/editor'
import { clearPreview, commitOp, previewOp, runOp } from '../state/ops'
import { getTimeline, useProject, timelineOf } from '../state/project'
import { Capsule } from '../ui/buttons'
import { fromHex } from '../ui/ColorField'
import { Popover } from '../ui/Popover'
import { RULER_H } from './geometry'
import { useTimelineView } from './view'
import { t } from '../i18n'

const sameColor = (a: RGBA, b: RGBA) => Math.abs(a.r - b.r) < 0.004 && Math.abs(a.g - b.g) < 0.004 && Math.abs(a.b - b.b) < 0.004

function TimecodeField({ frames, fps, onChange }: { frames: number; fps: number; onChange: (f: number) => void }) {
  const [text, setText] = useState(formatTimecode(frames, fps))
  useEffect(() => setText(formatTimecode(frames, fps)), [frames, fps])
  const commit = () => {
    const f = parseTimecode(text.trim(), fps)
    if (f === null) setText(formatTimecode(frames, fps))
    else onChange(f)
  }
  return (
    <input
      className="pp-marker-tc mono"
      value={text}
      spellCheck={false}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.ctrlKey) commit()
      }}
    />
  )
}

function Editor({ marker, fps, anchorX, anchorY }: { marker: TimelineMarker; fps: number; anchorX: number; anchorY: number }) {
  const [draft, setDraft] = useState(marker)
  const committed = useRef(false)
  const commentRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const id = requestAnimationFrame(() => commentRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [])
  const update = (patch: Partial<TimelineMarker>) => {
    const next = { ...draft, ...patch }
    setDraft(next)
    if (!previewOp('changeMarkers', { updates: [next] })) clearPreview()
  }
  const close = () => setEditor({ markerEditorId: null })
  const done = async () => {
    committed.current = true
    close()
    if (JSON.stringify(draft) === JSON.stringify(marker)) return clearPreview()
    await commitOp('changeMarkers', { updates: [{ ...draft, name: draft.name.trim() || marker.name }], label: 'Edit Marker' })
  }
  useEffect(
    () => () => {
      if (!committed.current) clearPreview()
    },
    [],
  )
  return (
    <Popover anchor={{ left: anchorX, right: anchorX, top: anchorY, bottom: anchorY }} onClose={close} className="pp-marker-editor">
      <div
        className="pp-marker-grid"
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void done()
        }}
      >
        <span className="pp-marker-label">{t('Time')}</span>
        <TimecodeField frames={draft.startFrame} fps={fps} onChange={(f) => update({ startFrame: Math.max(0, f) })} />
        <span className="pp-marker-label right">{t('Duration')}</span>
        <TimecodeField frames={draft.durationFrames} fps={fps} onChange={(f) => update({ durationFrames: Math.max(0, f) })} />
        <span className="pp-marker-label">{t('Name')}</span>
        <input className="pp-marker-input span3" value={draft.name} placeholder={t('Marker name')} spellCheck={false} onChange={(e) => update({ name: e.target.value })} />
        <span className="pp-marker-label top">{t('Comments')}</span>
        <textarea ref={commentRef} className="pp-marker-input pp-marker-comments span3" value={draft.comment} placeholder={t('Add a comment')} spellCheck={false} onChange={(e) => update({ comment: e.target.value })} />
        <span className="pp-marker-label">{t('Color')}</span>
        <div className="pp-marker-swatches span3">
          {MARKER_COLORS.map((hex) => {
            const c = fromHex(hex)!
            const on = sameColor(c, draft.color)
            return (
              <button key={hex} type="button" className={`pp-marker-swatch${on ? ' on' : ''}`} onClick={() => update({ color: { ...c, a: draft.color.a } })}>
                <svg width="10" height="12" viewBox="0 0 10 12">
                  <path d="M 0 0 H 10 V 7 L 5 12 L 0 7 Z" fill={hex} />
                </svg>
              </button>
            )
          })}
        </div>
      </div>
      <div className="pp-marker-footer">
        <Capsule
          className="pp-marker-remove"
          onClick={() => {
            committed.current = true
            close()
            clearPreview()
            void runOp('changeMarkers', { deleteIds: [marker.id], label: 'Delete Marker' })
          }}
        >
          {t('Remove Marker')}
        </Capsule>
        <span style={{ flex: 1 }} />
        <Capsule variant="prominent" tip={t('Ctrl+Enter')} onClick={() => void done()}>
          {t('Done')}
        </Capsule>
      </div>
    </Popover>
  )
}

/** Marker editor popover anchored under the selected marker's flag (§6.8). */
export function MarkerEditor({ scrollEl }: { scrollEl: RefObject<HTMLDivElement | null> }) {
  const id = useEditor((s) => s.markerEditorId)
  const marker = useProject((s) => (id ? (timelineOf(s.snapshot?.doc)?.markers.find((m) => m.id === id) ?? null) : null))
  if (!id || !marker || !scrollEl.current) return null
  const v = useTimelineView.getState()
  const r = scrollEl.current.getBoundingClientRect()
  const x = Math.min(r.right - 8, Math.max(r.left + 8, r.left + marker.startFrame * v.zoom - v.scrollX))
  return <Editor key={id} marker={marker} fps={getTimeline()?.fps ?? 30} anchorX={x} anchorY={r.top + RULER_H - 14} />
}
