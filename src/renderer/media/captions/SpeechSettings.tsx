/**
 * Settings ▸ Models & API Keys ▸ Speech-to-Text (Linux addition, spec 07 §0.5, §1.5, §2.7): the whisper model used
 * by Local transcription (with its download state and Remove), Local language auto-detection, and the BYOK cloud
 * provider. There is no Storage pane on Linux yet, so the "Speech model" row lives here.
 */
import { useEffect, useState } from 'react'
import type { AppSettings, ModelStateView } from '../../../shared/api'
import { updateSettings } from '../../state/settings'
import { Capsule } from '../../ui/buttons'
import { MenuValue, Switch } from '../../ui/controls'
import { t } from '../../i18n'

const MODELS: { name: string; id: string; label: string; bytes: number; hidden?: boolean }[] = [
  { name: 'large-v3-turbo-q5_0', id: 'whisper-large-v3-turbo-q5_0', label: t('Large v3 Turbo (best)'), bytes: 574_041_195 },
  { name: 'small', id: 'whisper-small', label: t('Small'), bytes: 487_601_967 },
  { name: 'base', id: 'whisper-base', label: t('Base (fastest)'), bytes: 147_951_465 },
  // Test/dev model, only listed while settings.json selects it.
  { name: 'tiny-q5_1', id: 'whisper-tiny-q5_1', label: t('Tiny (test)'), bytes: 32_152_673, hidden: true },
]
const PROVIDERS: { id: 'elevenlabs' | 'openai'; label: string }[] = [
  { id: 'elevenlabs', label: 'ElevenLabs Scribe' },
  { id: 'openai', label: 'OpenAI (whisper-1)' },
]

const mb = (bytes: number) => `${Math.round(bytes / 1e6)} MB`

function stateText(s: ModelStateView | null, bytes: number): string {
  switch (s?.kind) {
    case 'ready':
      return t('Downloaded · {0}', mb(bytes))
    case 'downloading':
      return t('Downloading… {0}%', Math.round(s.fraction * 100))
    case 'preparing':
      return t('Preparing…')
    case 'failed':
      return t('Download failed: {0}', s.message)
    default:
      return t('Not downloaded · {0} (downloads on first use)', mb(bytes))
  }
}

export function SpeechSettingsSection({ settings }: { settings: AppSettings }) {
  const tr = settings.transcription ?? {}
  const current = MODELS.find((m) => m.name === tr.localModel) ?? MODELS[0]
  const [state, setState] = useState<ModelStateView | null>(null)
  useEffect(() => {
    let live = true
    void window.palmier.ml.models.state(current.id).then((s) => live && setState(s))
    const off = window.palmier.ml.models.onState((e) => {
      if (e.id === current.id) setState(e.state)
    })
    return () => {
      live = false
      off()
    }
  }, [current.id])
  const set = (patch: NonNullable<AppSettings['transcription']>) => void updateSettings({ transcription: { ...tr, ...patch } })
  const keys = settings.apiKeys as Record<string, string | undefined>
  const provider = PROVIDERS.find((p) => p.id === tr.cloudProvider) ?? PROVIDERS.find((p) => keys[p.id]) ?? PROVIDERS[0]
  const busy = state?.kind === 'downloading' || state?.kind === 'preparing'
  return (
    <section className="pp-set-section">
      <div className="pp-set-section-title">{t('Speech-to-Text')}</div>
      <div className="pp-set-card">
        <div className="pp-set-toggle">
          <div className="pp-set-toggle-text">
            <span className="pp-set-row-title">{t('Local speech model')}</span>
            <span className="pp-set-row-sub">{stateText(state, current.bytes)}</span>
          </div>
          <MenuValue text={current.label} width={170} items={() => MODELS.filter((m) => !m.hidden || m.name === current.name).map((m) => ({ label: `${m.label} · ${mb(m.bytes)}`, checked: m.name === current.name, onSelect: () => set({ localModel: m.name }) }))} />
          {state?.kind === 'ready' ? (
            <Capsule onClick={() => void window.palmier.ml.models.remove(current.id)}>{t('Remove')}</Capsule>
          ) : (
            <Capsule disabled={busy} onClick={() => void window.palmier.ml.models.ensure(current.id)}>
              {t('Download')}
            </Capsule>
          )}
        </div>
        <div className="pp-set-toggle">
          <div className="pp-set-toggle-text">
            <span className="pp-set-row-title">{t('Detect spoken language')}</span>
            <span className="pp-set-row-sub">{t('When Language is Auto, Local detects the language instead of using your system language.')}</span>
          </div>
          <Switch on={tr.localAutoDetect === true} onChange={(localAutoDetect) => set({ localAutoDetect })} />
        </div>
        <div className="pp-set-toggle">
          <div className="pp-set-toggle-text">
            <span className="pp-set-row-title">{t('Cloud provider')}</span>
            <span className="pp-set-row-sub">{keys.elevenlabs || keys.openai ? t('Cloud transcription uses this provider with your API key.') : t('Add an ElevenLabs or OpenAI key to use Cloud transcription.')}</span>
          </div>
          <MenuValue text={provider.label} width={170} items={() => PROVIDERS.map((p) => ({ label: p.label, checked: p.id === provider.id, disabled: !keys[p.id], onSelect: () => set({ cloudProvider: p.id }) }))} />
        </div>
      </div>
    </section>
  )
}
