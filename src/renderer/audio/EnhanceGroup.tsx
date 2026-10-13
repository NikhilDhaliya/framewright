/** Inspector ▸ Audio ▸ Enhance ▸ Denoise (05 §7.5.3; spec 07 §3.6). */
import { DEFAULT_DENOISE_AMOUNT, DENOISE, denoiseOf } from '@core/audio/denoise'
import type { Clip } from '@core/model'
import { addEffect, removeEffect, setEffectEnabled, setEffectParam } from '@core/ops/properties'
import { commitMutation, common } from '../inspector/model'
import { Row, Spinner, Switch } from '../ui/controls'
import { Group } from '../ui/panels'
import { ScrubField } from '../ui/ScrubField'
import { denoiseStateOf, scheduleDenoise, useAudio } from './store'
import './audio.css'
import { t } from '../i18n'

function apply(c: Clip, on: boolean, amount: number): void {
  const has = c.effects?.some((e) => e.type === DENOISE)
  if (!on) {
    if (has) removeEffect(c, DENOISE)
    return
  }
  if (!has) addEffect(c, DENOISE, { amount })
  else {
    setEffectParam(c, DENOISE, 'amount', amount)
    setEffectEnabled(c, DENOISE, true)
  }
}

export function EnhanceGroup({ clips }: { clips: Clip[] }) {
  useAudio((s) => s.denoise)
  const audio = clips.filter((c) => c.mediaType === 'audio')
  if (!audio.length) return null
  const ids = audio.map((c) => c.id)
  const on = audio.every((c) => denoiseOf(c)?.enabled)
  const amount = common(audio, (c) => denoiseOf(c)?.amount ?? DEFAULT_DENOISE_AMOUNT)
  const states = on ? audio.map((c) => denoiseStateOf(c.mediaRef)) : []
  const baking = states.includes('baking')
  const failed = states.includes('failed')
  const commit = async (next: boolean, value: number, label: string) => {
    await commitMutation(ids, (c) => apply(c, next, value), label)
    if (next) for (const c of audio) scheduleDenoise(c.mediaRef)
  }
  return (
    <Group title={t('Enhance')} onReset={on ? () => void commit(false, DEFAULT_DENOISE_AMOUNT, 'Disable Denoise') : undefined}>
      <Row label={t('Denoise')} tip={t('Removes background noise from this audio using an on-device model.')}>
        {on && (
          <ScrubField
            value={amount === null ? null : amount}
            min={0}
            max={1}
            mult={100}
            decimals={0}
            suffix="%"
            sens={0.5}
            tip={t('Blends denoised and original audio — lower this if voices sound thin or over-compressed.')}
            onChange={() => undefined}
            onCommit={(v) => void commit(true, Math.min(1, Math.max(0, v)), 'Change Denoise Strength')}
          />
        )}
        <span style={{ flex: on ? 0 : 1 }} />
        <Switch on={on} onChange={(v) => void commit(v, amount ?? DEFAULT_DENOISE_AMOUNT, v ? 'Enable Denoise' : 'Disable Denoise')} />
      </Row>
      {on && baking && (
        <div className="pp-audio-status">
          <Spinner size={10} /> {t('Removing background noise…')}
        </div>
      )}
      {on && failed && !baking && <div className="pp-audio-status pp-audio-status-error">{t('Denoise failed. Playback uses the original audio — adjust Strength to retry.')}</div>}
    </Group>
  )
}
