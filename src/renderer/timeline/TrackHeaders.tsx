import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { containsFrame } from '@core/clip'
import type { Clip, Timeline, Track } from '@core/model'
import { keyframeFrames, supportsKeyframes, type AnimatableProperty } from '@core/ops/properties'
import { firstAudioIndex, trackDisplayLabel } from '@core/timeline'
import { TrackSize } from '../theme/sizes'
import { clearPreview, commitOp, previewOp, runOp } from '../state/ops'
import { usePlayhead } from '../state/playback'
import { useTimeline } from '../state/project'
import { InlineRename } from '../ui/controls'
import { Icon, type SFName } from '../ui/Icon'
import { openMenu } from '../ui/Menu'
import { selectAllOnTrack } from './actions'
import { palette, readableForeground } from './colors'
import { layoutsFor, RULER_H, trackAt, type TrackLayout } from './geometry'
import { KeyframeStrip } from './KeyframeStrip'
import { AgentTrackGlows } from './AgentTrackGlows'
import { setHeaderWidth, toggleLanes, useTimelineView } from './view'
import { t } from '../i18n'

const LANE_NAMES: Record<AnimatableProperty, string> = { position: t('Position'), scale: t('Scale'), rotation: t('Rotation'), opacity: t('Opacity'), blur: t('Blur'), crop: t('Crop'), volume: t('Volume') }

const colorVar = (tl: Track) => `var(--pp-clip-${tl.type === 'audio' ? 'audio' : tl.type === 'lottie' ? 'animation' : tl.type === 'subtitle' ? 'text' : tl.type})`

function ToggleButton({ sf, on, tip, left, color, onClick }: { sf: SFName; on: boolean; tip: string; left: number; color?: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className="pp-tl-hbtn"
      style={{ left: left - 4, color: color ?? (on ? 'var(--pp-text-secondary)' : 'color-mix(in srgb, var(--pp-text-secondary) 30%, transparent)') }}
      data-tip={tip}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={onClick}
    >
      <Icon sf={sf} size={11} />
    </button>
  )
}

function AudioKeyButton({ track, left }: { track: Track; left: number }) {
  const clip = usePlayhead((s) => track.clips.find((c) => containsFrame(c, s.frame)) ?? null)
  const onKey = usePlayhead((s) => !!clip && keyframeFrames(clip, 'volume').includes(s.frame))
  const tip = !clip ? t('Move playhead inside the clip') : onKey ? t('Delete keyframe') : t('Add keyframe')
  return (
    <ToggleButton
      sf={onKey ? 'diamond.fill' : 'diamond'}
      on={!!clip}
      tip={tip}
      left={left}
      color={onKey || clip?.volumeTrack?.keyframes.length ? 'var(--pp-timecode)' : undefined}
      onClick={() => clip && void runOp('toggleKeyframe', { id: clip.id, property: 'volume', frame: usePlayhead.getState().frame })}
    />
  )
}

function LaneHeader({ tl, l, property, last }: { tl: Timeline; l: TrackLayout; property: AnimatableProperty; last: boolean }) {
  const track = tl.tracks[l.index]
  const targets = track.clips.filter((c) => supportsKeyframes(c, property))
  const active = usePlayhead((s) => targets.find((c) => containsFrame(c, s.frame)) ?? null)
  return (
    <div className={`pp-tl-lane-header${last ? ' last' : ''}`}>
      <span className="pp-tl-lane-name">{LANE_NAMES[property]}</span>
      <span style={{ flex: 1 }} />
      <KeyframeStrip targets={targets} active={active} property={property} />
    </div>
  )
}

interface RowProps {
  tl: Timeline
  l: TrackLayout
  width: number
  lanesOpen: boolean
  onReorderStart: (e: React.PointerEvent, l: TrackLayout) => void
  reordering: boolean
}

function TrackRow({ tl, l, width, lanesOpen, onReorderStart, reordering }: RowProps) {
  const track = tl.tracks[l.index]
  const [renaming, setRenaming] = useState(false)
  const label = trackDisplayLabel(tl, l.index)
  const isAudio = track.type === 'audio'
  const rightmost = width - 14 - 6
  const syncX = rightmost - 18
  const keyX = syncX - 18
  const labelW = keyX - 4 - 29
  const keyframable = isAudio ? track.clips.some((c) => c.mediaType === 'audio') : track.clips.some((c: Clip) => c.mediaType !== 'audio')
  const clipColor = palette().clip[track.type === 'audio' ? 'audio' : track.type]

  const onResizeDown = (e: React.PointerEvent) => {
    e.stopPropagation()
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    const startY = e.clientY
    const orig = track.displayHeight
    let h = orig
    const move = (ev: PointerEvent) => {
      h = Math.round(Math.min(TrackSize.maxHeight, Math.max(TrackSize.minHeight, orig + ev.clientY - startY)))
      if (h === orig) clearPreview()
      else previewOp('setTrackHeight', { trackIndex: l.index, height: h })
    }
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      if (h === orig) clearPreview()
      else void commitOp('setTrackHeight', { trackIndex: l.index, height: h })
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }

  return (
    <div
      className={`pp-tl-row${reordering ? ' reordering' : ''}`}
      style={{ top: l.top, height: l.height }}
      onContextMenu={(e) => {
        e.preventDefault()
        openMenu(
          [
            { label: t('Rename Track'), onSelect: () => setRenaming(true) },
            { kind: 'divider' },
            { label: t('Select All Clips on Track'), disabled: !track.clips.length, onSelect: () => selectAllOnTrack(l.index) },
          ],
          e.clientX,
          e.clientY,
        )
      }}
    >
      <span className="pp-tl-strip" style={{ background: colorVar(track) }} />
      <span className="pp-tl-grip" onPointerDown={(e) => onReorderStart(e, l)}>
        <Icon sf="line.3.horizontal" size={11} />
      </span>
      <div className="pp-tl-label" style={{ width: Math.max(0, labelW), height: Math.min(l.height - 8, 22) }} onDoubleClick={() => setRenaming(true)}>
        {renaming ? (
          <InlineRename
            value={track.name ?? ''}
            placeholder={label}
            maxLength={80}
            allowEmpty
            className="pp-tl-rename"
            onCommit={(name) => {
              setRenaming(false)
              void runOp('renameTrack', { trackId: track.id, name })
            }}
            onCancel={() => setRenaming(false)}
          />
        ) : (
          <>
            <span className="pp-tl-designation">{label}</span>
            {track.name && labelW - 30 > 16 && (
              <span className="pp-tl-name-pill ellipsis" style={{ background: `color-mix(in srgb, ${clipColor} 80%, transparent)`, color: readableForeground(clipColor) }}>
                {track.name}
              </span>
            )}
          </>
        )}
      </div>
      {keyframable &&
        (isAudio ? (
          <AudioKeyButton track={track} left={keyX} />
        ) : (
          <ToggleButton
            sf={lanesOpen ? 'diamond.fill' : 'diamond'}
            on={lanesOpen}
            color={lanesOpen ? 'var(--pp-timecode)' : undefined}
            tip={lanesOpen ? t('Hide clip keyframes') : t('Show clip keyframes')}
            left={keyX}
            onClick={() => toggleLanes(track.id)}
          />
        ))}
      <ToggleButton
        sf={track.syncLocked ? 'link' : 'personalhotspot.slash'}
        on={track.syncLocked}
        tip={track.syncLocked ? t('Sync Locked') : t('Sync Unlocked')}
        left={syncX}
        onClick={() => void runOp('setTrackFlag', { trackIndex: l.index, flag: 'syncLocked', value: !track.syncLocked })}
      />
      {isAudio ? (
        <ToggleButton sf={track.muted ? 'speaker.slash.fill' : 'speaker.wave.2.fill'} on={!track.muted} tip={track.muted ? t('Unmute Track') : t('Mute Track')} left={rightmost} onClick={() => void runOp('setTrackFlag', { trackIndex: l.index, flag: 'muted', value: !track.muted })} />
      ) : (
        <ToggleButton sf={track.hidden ? 'eye.slash' : 'eye'} on={!track.hidden} tip={track.hidden ? t('Show Track') : t('Hide Track')} left={rightmost} onClick={() => void runOp('setTrackFlag', { trackIndex: l.index, flag: 'hidden', value: !track.hidden })} />
      )}
      <span className="pp-tl-row-resize" style={{ top: l.bottom - l.top - 3 }} onPointerDown={onResizeDown} />
    </div>
  )
}

export function TrackHeaders() {
  const tl = useTimeline()
  const width = useTimelineView((s) => s.headerWidth)
  const lanes = useTimelineView((s) => s.lanes)
  const innerRef = useRef<HTMLDivElement>(null)
  const [reorderId, setReorderId] = useState<string | null>(null)
  const layouts = useMemo(() => (tl ? layoutsFor(tl, lanes) : []), [tl, lanes])

  useLayoutEffect(() => {
    const apply = (y: number) => {
      if (innerRef.current) innerRef.current.style.transform = `translateY(${-y}px)`
    }
    apply(useTimelineView.getState().scrollY)
    return useTimelineView.subscribe((s, p) => s.scrollY !== p.scrollY && apply(s.scrollY))
  }, [])

  if (!tl) return null
  const fa = firstAudioIndex(tl)

  const onReorderStart = (e: React.PointerEvent, l: TrackLayout) => {
    e.stopPropagation()
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    const id = l.id
    const rect = innerRef.current!.getBoundingClientRect()
    let target = l.index
    setReorderId(id)
    const move = (ev: PointerEvent) => {
      target = trackAt(layouts, ev.clientY - rect.top)
      if (target === l.index) clearPreview()
      else previewOp('reorderTrack', { id, targetIndex: target })
    }
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      setReorderId(null)
      if (target === l.index) clearPreview()
      else void commitOp('reorderTrack', { id, targetIndex: target }, { quiet: true })
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }

  const onResizeWidth = (e: React.PointerEvent) => {
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    const startX = e.clientX
    const orig = width
    const move = (ev: PointerEvent) => setHeaderWidth(orig + ev.clientX - startX)
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }

  return (
    <div className="pp-tl-headers" style={{ width }}>
      <div ref={innerRef} className="pp-tl-headers-inner">
        {layouts.length > 0 && <div className="pp-tl-hline" style={{ top: layouts[0].top }} />}
        {layouts.map((l) => (
          <div key={l.id}>
            <TrackRow tl={tl} l={l} width={width} lanesOpen={lanes.includes(l.id)} onReorderStart={onReorderStart} reordering={reorderId === l.id} />
            {l.lanes.map((p, i) => (
              <div key={p} className="pp-tl-lane-wrap" style={{ top: l.top + l.height + i * 24 }}>
                <LaneHeader tl={tl} l={l} property={p} last={i === l.lanes.length - 1} />
              </div>
            ))}
          </div>
        ))}
        {fa > 0 && fa < layouts.length && <div className="pp-tl-av-divider" style={{ top: layouts[fa].top - 1 }} />}
        <AgentTrackGlows layouts={layouts} />
      </div>
      <div className="pp-tl-ruler-cover" style={{ height: RULER_H }} />
      <div className="pp-tl-header-resize" onPointerDown={onResizeWidth} />
    </div>
  )
}
