/**
 * Settings ▸ Models & API Keys ▸ Models (05 §11.5, spec 06 §B1.4): every catalog model with an enable switch
 * (`disabledModelIds`). Models whose provider has no key stay listed but disabled with "Add <provider> key".
 */
import { useState } from 'react'
import type { AnyModel } from '@core/generation/models'
import type { ModelKind } from '@core/generation/catalog'
import { updateSettings, useSettings } from '../state/settings'
import { Switch } from '../ui/controls'
import { ProviderMark } from './GeneratePanel'
import { useModelSet } from './store'
import { t } from '../i18n'

const SECTIONS: { kind: ModelKind; title: string }[] = [
  { kind: 'image', title: t('Image') },
  { kind: 'video', title: t('Video') },
  { kind: 'audio', title: t('Audio') },
  { kind: 'upscale', title: t('Upscale') },
]

export function GenerationModelsSettings() {
  const set = useModelSet()
  const disabled = useSettings((s) => s.settings?.disabledModelIds) ?? []
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const matches = (m: AnyModel) => !q || m.displayName.toLowerCase().includes(q) || (m.providerName ?? '').toLowerCase().includes(q)
  const toggle = (id: string, on: boolean) => void updateSettings({ disabledModelIds: on ? disabled.filter((x) => x !== id) : [...new Set([...disabled, id])] })
  return (
    <div className="pp-gen-models">
      <input className="pp-gen-models-search" placeholder={t('Search models')} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
      {SECTIONS.map(({ kind, title }) => {
        const models = (set[kind] as AnyModel[]).filter(matches)
        if (!models.length) return null
        return (
          <div key={kind} className="pp-gen-models-card">
            <div className="pp-gen-models-card-title">{title}</div>
            {models.map((m) => (
              <div key={m.id} className={`pp-gen-models-row${m.hasKey ? '' : ' nokey'}`} data-tip={m.description}>
                <ProviderMark model={m} size={22} />
                <span className="pp-gen-models-name ellipsis">{m.displayName}</span>
                {!m.hasKey && <span className="pp-gen-models-hint">{t('Add {0} key', m.keyProviderName)}</span>}
                <Switch on={m.hasKey && !disabled.includes(m.id)} disabled={!m.hasKey} onChange={(on) => toggle(m.id, on)} />
              </div>
            ))}
          </div>
        )
      })}
    </div>
  )
}
