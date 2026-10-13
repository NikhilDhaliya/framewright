/**
 * Settings ▸ Storage (05 §11.8, spec 07 §2.7; Mac `StoragePane.swift`): temporary files, Media indexing, the index and
 * the search model ("Remove model" deletes only Models/search/), plus a row per downloaded speech/audio model (Linux).
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { AppSettings } from '../../../shared/api'
import type { StorageInfo } from '../../../shared/search'
import { Capsule } from '../../ui/buttons'
import { Switch } from '../../ui/controls'
import { formatFileBytes } from './status'
import './search.css'
import { t } from '../../i18n'

function SettingsSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="pp-set-section">
      <div className="pp-set-section-title">{title}</div>
      <div className="pp-set-card">{children}</div>
    </section>
  )
}

export function StoragePane({ settings }: { settings: AppSettings }) {
  const [info, setInfo] = useState<StorageInfo | null>(null)
  const [clearing, setClearing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [enabled, setEnabled] = useState(settings.searchIndexEnabled !== false)
  const refresh = useCallback(() => void window.palmier.search.storage().then(setInfo), [])
  useEffect(refresh, [refresh])
  useEffect(() => setEnabled(settings.searchIndexEnabled !== false), [settings.searchIndexEnabled])
  const act = (fn: () => Promise<void>) => {
    setBusy(true)
    void fn()
      .catch(() => undefined)
      .finally(() => {
        setBusy(false)
        refresh()
      })
  }
  const clearCache = () => {
    setClearing(true)
    void window.palmier.search
      .clearCache()
      .catch(() => undefined)
      .finally(() => {
        setClearing(false)
        refresh()
      })
  }
  return (
    <>
      <SettingsSection title={t('Cache')}>
        <div className="pp-set-toggle" data-testid="storage-cache">
          <div className="pp-set-toggle-text">
            <span className="pp-set-row-title">{t('Temporary files')}</span>
            <span className="pp-set-row-sub">{t('Playback previews, waveforms, filmstrip thumbnails, and transcripts. Safe to clear; files rebuild as needed.')}</span>
            <span className="pp-storage-path">
              <span className="path mono" title={info?.cachePath}>
                <bdi>{info?.cacheDisplayPath ?? ''}</bdi>
              </span>
              <span className="size">{clearing ? t('Clearing…') : info ? formatFileBytes(info.cacheBytes) : ''}</span>
            </span>
          </div>
          <Capsule disabled={clearing || !info || info.cacheBytes === 0} onClick={clearCache}>
            {t('Clear cache')}
          </Capsule>
        </div>
      </SettingsSection>
      <SettingsSection title={t('Search')}>
        <div className="pp-set-toggle">
          <div className="pp-set-toggle-text">
            <span className="pp-set-row-title">{t('Media indexing')}</span>
            <span className="pp-set-row-sub">{t('Indexes imported media for on-device search.')}</span>
          </div>
          <Switch
            on={enabled}
            onChange={(v) => {
              setEnabled(v)
              void window.palmier.search.setEnabled(v)
            }}
          />
        </div>
        <div className="pp-storage-row" data-testid="storage-index">
          <span className="k">{t('Index')}</span>
          <span className="v">{info ? formatFileBytes(info.indexBytes) : ''}</span>
          <span className="spacer" />
          <Capsule disabled={busy || !info || info.indexBytes === 0} onClick={() => act(() => window.palmier.search.clearIndex())}>
            {t('Clear index')}
          </Capsule>
        </div>
        {info && info.searchModelBytes > 0 && (
          <div className="pp-storage-row" data-testid="storage-model">
            <span className="k">{t('Model')}</span>
            <span className="v">
              {info.searchModelLabel} · {formatFileBytes(info.searchModelBytes)}
            </span>
            <span className="spacer" />
            <Capsule disabled={busy} onClick={() => act(() => window.palmier.search.removeSearchModel())}>
              {t('Remove model')}
            </Capsule>
          </div>
        )}
        {info?.otherModels.map((m) => (
          <div key={m.id} className="pp-storage-row">
            <span className="k">{m.kind}</span>
            <span className="v">
              {m.label} · {formatFileBytes(m.bytes)}
            </span>
            <span className="spacer" />
            <Capsule disabled={busy} onClick={() => act(() => window.palmier.search.removeModel(m.id))}>
              {t('Remove')}
            </Capsule>
          </div>
        ))}
      </SettingsSection>
    </>
  )
}
