/** Audio tab ▸ Speaker Detection / Silence Detection (spec 07 §3.3, §3.5; 05 §4.14; Mac `SpeechTab.swift`). */
import { useEffect } from 'react'
import { useDoc } from '../state/project'
import { Capsule } from '../ui/buttons'
import { Row, Switch } from '../ui/controls'
import { Group } from '../ui/panels'
import { ScrubField } from '../ui/ScrubField'
import { deadAirSections, identifySpeakers, removeDeadAir, requestSpeech, scheduleDenoise, setMarks, setSilenceSettings, updateSpeaker, useAudio } from './store'
import { rgbaCss } from '@core/audio/speakers'
import { Icon } from '../ui/Icon'
import { Spinner } from '../ui/controls'
import './audio.css'
import { t } from '../i18n'

const ms = (v: number) => `${(v * 1000).toFixed(0)} ms`

export function SpeechSections() {
  const doc = useDoc()
  const st = useAudio()
  // Analyse every audio-bearing asset in the background (the Mac runs VAD whenever a waveform is generated).
  useEffect(() => {
    if (!doc) return
    for (const e of doc.manifest.entries) if (e.type === 'audio' || (e.type === 'video' && e.hasAudio)) requestSpeech(e.id)
  }, [doc?.manifest])
  useEffect(() => {
    if (doc) scheduleDenoise()
  }, [!!doc])
  const count = st.quiet && doc ? deadAirSections(doc) : 0
  const speakers = doc?.file.speakers ?? []
  const detecting = st.speechInFlight > 0 ? (st.speechInFlight === 1 ? t('Detecting speech…') : t('Detecting speech in {0} files…', st.speechInFlight)) : null
  return (
    <>
      <Group title={t('Speaker Detection')} defaultExpanded={false}>
        <Row label={t('Mark Speakers')} tip={t('Tints waveforms by speaker. Voices are matched across clips.')}>
          <span style={{ flex: 1 }} />
          <Switch on={st.markSpeakers} onChange={(v) => setMarks({ markSpeakers: v })} />
        </Row>
        {st.speakerError && <div className="pp-audio-status pp-audio-status-error">{st.speakerError}</div>}
        {!!speakers.length && (
          <div className="pp-speaker-grid">
            {speakers.map((sp) => (
              <div key={sp.id} className="pp-speaker-label">
                <input type="color" className="pp-speaker-color" value={toHex(sp.color)} onChange={(e) => void updateSpeaker({ id: sp.id, color: fromHex(e.target.value) })} />
                <input className="pp-speaker-name" placeholder={t('Name')} defaultValue={sp.name} onBlur={(e) => e.target.value !== sp.name && void updateSpeaker({ id: sp.id, name: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
                <button className="pp-speaker-remove" title={t('Removes this label and tint. Identify recreates it if the voice is still present.')} onClick={() => void updateSpeaker({ id: sp.id, remove: true })}>
                  <Icon sf="xmark.circle.fill" size={11} />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="pp-audio-actions">
          {st.speakerPhase && (
            <span className="pp-audio-status">
              <Spinner size={10} /> {st.speakerPhase}
            </span>
          )}
          <span style={{ flex: 1 }} />
          <Capsule tip={t('Matches voices across clips, transcribing and detecting speakers on this computer first. Transcripts and voice fingerprints are cached, so re-runs are fast.')} disabled={!!st.speakerPhase} onClick={() => void identifySpeakers(false)}>
            {speakers.length ? t('Refresh') : t('Identify')}
          </Capsule>
        </div>
      </Group>
      <Group title={t('Silence Detection')} defaultExpanded={false}>
        <Row label={t('Mark Silence')} tip={t('Speech is detected on-device in the background. Dims quiet, speech-free spans on timeline waveforms.')}>
          <span style={{ flex: 1 }} />
          <Switch on={st.markDeadAir} onChange={(v) => setMarks({ markDeadAir: v })} />
        </Row>
        <Row label={t('Minimum Pause')} tip={t('Ignores speech-free pauses shorter than this.')} reset={() => setSilenceSettings({ minimumPause: 0.5 })}>
          <ScrubField
            value={st.silence.minimumPause}
            min={0.25}
            max={3}
            mult={1000}
            sens={10}
            format={ms}
            adjust={(v) => Math.round(v / 0.05) * 0.05}
            onChange={(v) => setSilenceSettings({ minimumPause: v })}
            onCommit={(v) => setSilenceSettings({ minimumPause: v })}
          />
        </Row>
        <Row label={t('Speech Padding')} tip={t('Keeps this much audio before and after detected speech.')} reset={() => setSilenceSettings({ speechPadding: 0.15 })}>
          <ScrubField
            value={st.silence.speechPadding}
            min={0}
            max={0.5}
            mult={1000}
            sens={10}
            format={ms}
            adjust={(v) => Math.round(v / 0.025) * 0.025}
            onChange={(v) => setSilenceSettings({ speechPadding: v })}
            onCommit={(v) => setSilenceSettings({ speechPadding: v })}
          />
        </Row>
        <div className="pp-audio-actions">
          {detecting && <span className="pp-audio-note">{detecting}</span>}
          <span style={{ flex: 1 }} />
          <span className="pp-audio-count">{count}</span>
          <Capsule tip={t('Ripple-deletes every silent section; downstream clips close the gaps.')} disabled={count === 0} onClick={() => void removeDeadAir()}>
            {t('Remove')}
          </Capsule>
        </div>
      </Group>
    </>
  )
}

function toHex(c: readonly number[]): string {
  const m = /rgba\((\d+),(\d+),(\d+)/.exec(rgbaCss(c))
  return m ? `#${[m[1], m[2], m[3]].map((x) => Number(x).toString(16).padStart(2, '0')).join('')}` : '#0a84ff'
}

function fromHex(hex: string): number[] {
  const n = parseInt(hex.slice(1), 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, 1]
}
