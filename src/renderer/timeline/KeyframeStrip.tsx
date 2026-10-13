import { containsFrame } from '@core/clip'
import type { Clip } from '@core/model'
import { keyframeFrames, type AnimatableProperty } from '@core/ops/properties'
import { runOp } from '../state/ops'
import { pause, seek, usePlayhead } from '../state/playback'
import { Icon } from '../ui/Icon'
import { t } from '../i18n'

interface KeyframeStripProps {
  /** Clips whose keyframes are navigable (the lane's track, or the inspected clip). */
  targets: Clip[]
  /** Clip that receives add/delete at the playhead. */
  active: Clip | null
  property: AnimatableProperty
}

/** Previous / toggle / next keyframe controls (34 px). Re-renders only when its derived state changes. */
export function KeyframeStrip({ targets, active, property }: KeyframeStripProps) {
  const frames = targets.flatMap((c) => keyframeFrames(c, property)).sort((a, b) => a - b)
  const key = usePlayhead((s) => {
    const f = s.frame
    const prev = frames.filter((x) => x < f).pop()
    const next = frames.find((x) => x > f)
    const activeFrames = active ? keyframeFrames(active, property) : []
    return `${prev ?? ''}|${next ?? ''}|${activeFrames.includes(f) ? 1 : 0}|${active && containsFrame(active, f) ? 1 : 0}|${activeFrames.length ? 1 : 0}`
  })
  const [prevS, nextS, onKeyS, insideS, hasS] = key.split('|')
  const prev = prevS === '' ? null : Number(prevS)
  const next = nextS === '' ? null : Number(nextS)
  const onKey = onKeyS === '1'
  const inside = insideS === '1'
  const lit = onKey || hasS === '1'
  const go = (f: number | null) => {
    if (f === null) return
    pause()
    seek(f)
  }
  return (
    <span className="pp-kf-strip">
      <button type="button" className="pp-kf-nav" disabled={prev === null} data-tip={t('Go to previous keyframe')} onClick={() => go(prev)}>
        <Icon sf="chevron.left" size={9} strokeWidth={2.5} />
      </button>
      <button
        type="button"
        className={`pp-kf-toggle${lit ? ' lit' : ''}`}
        disabled={!inside}
        data-tip={!inside ? t('Move playhead inside the clip') : onKey ? t('Delete keyframe') : t('Add keyframe')}
        onClick={() => active && void runOp('toggleKeyframe', { id: active.id, property, frame: usePlayhead.getState().frame })}
      >
        <Icon sf={onKey ? 'diamond.fill' : 'diamond'} size={10} />
      </button>
      <button type="button" className="pp-kf-nav" disabled={next === null} data-tip={t('Go to next keyframe')} onClick={() => go(next)}>
        <Icon sf="chevron.right" size={9} strokeWidth={2.5} />
      </button>
    </span>
  )
}
