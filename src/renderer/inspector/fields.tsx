import type { Clip } from '@core/model'
import { supportsRetiming } from '@core/clip'
import type { AnimatableProperty } from '@core/ops/properties'
import { clearPreview, commitOp, previewOp } from '../state/ops'
import { Row } from '../ui/controls'
import { Icon, type SFName } from '../ui/Icon'
import { Group } from '../ui/panels'
import { ScrubField } from '../ui/ScrubField'
import { KeyframeStrip } from '../timeline/KeyframeStrip'
import { common } from './model'
import { t } from '../i18n'

/** Keyframe strip for a single clip; a 34 px spacer for multi-selection keeps fields aligned. */
export function KfSlot({ clips, property }: { clips: Clip[]; property: AnimatableProperty }) {
  if (clips.length !== 1) return <span className="pp-kf-gutter" />
  return <KeyframeStrip targets={clips} active={clips[0]} property={property} />
}

export function IconToggle({ sf, on, tip, onClick, disabled }: { sf: SFName; on: boolean; tip: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" className={`pp-insp-icon-toggle hh${on ? ' on' : ''}`} data-tip={tip} disabled={disabled} onClick={onClick}>
      <Icon sf={sf} size={11} />
    </button>
  )
}

export const SPEED_RANGE = { min: 0.25, max: 4 }

/** Playback ▸ Speed (§7.5.1): retimes selected clips that support it, rippling the contiguous chain. */
export function PlaybackGroup({ clips }: { clips: Clip[] }) {
  const retimable = clips.filter(supportsRetiming)
  if (!retimable.length) return null
  const ids = retimable.map((c) => c.id)
  const speed = common(retimable, (c) => c.speed)
  return (
    <Group title={t('Playback')}>
      <Row label={t('Speed')} reset={() => void commitOp('setSpeed', { ids, speed: 1 }, { quiet: true })}>
        <ScrubField
          value={speed}
          min={SPEED_RANGE.min}
          max={SPEED_RANGE.max}
          decimals={2}
          suffix="x"
          sens={0.01}
          onChange={(v) => {
            if (!previewOp('setSpeed', { ids, speed: v })) clearPreview()
          }}
          onCommit={(v) => void commitOp('setSpeed', { ids, speed: v })}
          onCancel={clearPreview}
        />
      </Row>
    </Group>
  )
}
