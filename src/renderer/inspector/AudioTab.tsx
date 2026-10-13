import { linearToDb, VOLUME_DB } from '@core/clip'
import { isActive, lerpNumber, sampleTrack } from '@core/keyframes'
import type { Clip } from '@core/model'
import { Row } from '../ui/controls'
import { Group } from '../ui/panels'
import { ScrubField } from '../ui/ScrubField'
import { KfSlot, PlaybackGroup } from './fields'
import { EnhanceGroup } from '../audio/EnhanceGroup'
import { commitMutation, common, patchHandlers, useInspectorFrame, useTimelineFps } from './model'
import { t } from '../i18n'

const volumeDbAt = (c: Clip, frame: number) => (isActive(c.volumeTrack) ? sampleTrack(c.volumeTrack, frame - c.startFrame, 0, lerpNumber) : linearToDb(c.volume))
const formatDb = (db: number) => (db <= VOLUME_DB.min ? '-∞ dB' : `${db.toFixed(1)} dB`)

export function AudioTab({ clips, showPlayback }: { clips: Clip[]; showPlayback: boolean }) {
  const frame = useInspectorFrame()
  const fps = useTimelineFps()
  if (!clips.length) return null
  const ids = clips.map((c) => c.id)
  const volume = common(clips, (c) => volumeDbAt(c, frame))
  const fadeIn = common(clips, (c) => c.fadeInFrames / fps)
  const fadeOut = common(clips, (c) => c.fadeOutFrames / fps)
  const maxFade = clips.length === 1 ? clips[0].durationFrames / fps : 60
  const fadeHandlers = (edge: 'in' | 'out') =>
    patchHandlers(ids, frame, edge === 'in' ? 'Change Fade In' : 'Change Fade Out', (s) => () => (edge === 'in' ? { fadeIn: Math.round(s * fps) } : { fadeOut: Math.round(s * fps) }))
  return (
    <>
      <Group title={t('Levels')}>
        <Row
          label={t('Volume')}
          reset={() => void commitMutation(ids, (c) => {
            c.volume = 1
            delete c.volumeTrack
          }, 'Change Volume')}
        >
          <ScrubField value={volume} min={VOLUME_DB.min} max={VOLUME_DB.max} sens={0.3} format={formatDb} decimals={1} suffix=" dB" {...patchHandlers(ids, frame, 'Change Volume', (v) => () => ({ volumeDb: v }))} />
          <KfSlot clips={clips} property="volume" />
        </Row>
        <Row label={t('Fade In')} gutter reset={() => void commitMutation(ids, (c) => void (c.fadeInFrames = 0), 'Change Fade In')}>
          <ScrubField value={fadeIn} min={0} max={maxFade} decimals={2} suffix=" s" sens={0.02} {...fadeHandlers('in')} />
        </Row>
        <Row label={t('Fade Out')} gutter reset={() => void commitMutation(ids, (c) => void (c.fadeOutFrames = 0), 'Change Fade Out')}>
          <ScrubField value={fadeOut} min={0} max={maxFade} decimals={2} suffix=" s" sens={0.02} {...fadeHandlers('out')} />
        </Row>
      </Group>
      <EnhanceGroup clips={clips} />
      {showPlayback && <PlaybackGroup clips={clips} />}
    </>
  )
}
