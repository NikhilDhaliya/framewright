/** Media-tab index status control (spec 07 §2.6, 05 §4.11; Mac `MediaTab+IndexStatus.swift`), strings verbatim. */
import { useEffect } from 'react'
import { useDoc } from '../../state/project'
import { Spinner } from '../../ui/controls'
import { Icon } from '../../ui/Icon'
import { formatFileBytes, startSearchStatus, useSearchStatus } from './status'
import './search.css'
import { t } from '../../i18n'

function Ring({ value }: { value: number }) {
  const r = 5.25
  const c = 2 * Math.PI * r
  const v = Math.max(Math.min(value, 1), 0.03)
  return (
    <svg className="pp-index-ring" width={12} height={12} viewBox="0 0 12 12" aria-hidden>
      <circle cx={6} cy={6} r={r} className="track" />
      <circle cx={6} cy={6} r={r} className="arc" strokeDasharray={`${c * v} ${c}`} transform="rotate(-90 6 6)" />
    </svg>
  )
}

function Indicator({ label, tip, progress }: { label: string; tip: string; progress?: number }) {
  return (
    <span className="pp-index-status" data-tip={tip} data-testid="search-index-status">
      {progress === undefined ? <Spinner size={10} /> : <Ring value={progress} />}
      <span className="label tnum">{label}</span>
    </span>
  )
}

function StatusButton({ sf, label, tip }: { sf: 'sparkle.magnifyingglass' | 'exclamationmark.triangle'; label: string; tip: string }) {
  return (
    <button type="button" className="pp-index-button hh" data-tour="smartSearch" data-tip={tip} data-testid="search-index-status" onClick={() => window.palmier.search.download()}>
      <Icon sf={sf} size={10} />
      <span>{label}</span>
    </button>
  )
}

export function MediaSearchIndexStatus() {
  const status = useSearchStatus((s) => s.status)
  const hasIndexable = useDoc()?.manifest.entries.some((e) => e.type === 'video' || e.type === 'image') ?? false
  useEffect(startSearchStatus, [])
  if (!status) return null
  const { model, enabled, indexing } = status
  switch (model.kind) {
    case 'notInstalled':
      if (!enabled || !hasIndexable) return null
      return <StatusButton sf="sparkle.magnifyingglass" label={t('Smart search')} tip={t('Downloads a {0} on-device model so you can search media visually.', formatFileBytes(status.modelDownloadBytes))} />
    case 'downloading':
      return <Indicator label={t('Downloading {0}%', Math.floor(model.fraction * 100))} tip={t('Downloading the on-device model that powers visual search.')} progress={model.fraction} />
    case 'preparing':
      return <Indicator label={t('Preparing…')} tip={t('Getting the search model ready.')} />
    case 'ready':
      if (!indexing.active) return null
      return <Indicator label={t('Indexing {0}/{1}', Math.min(indexing.completed + 1, indexing.total), indexing.total)} tip={t('Analyzing media so you can search it.')} progress={indexing.progress} />
    case 'failed':
      if (!enabled) return null
      return <StatusButton sf="exclamationmark.triangle" label={t('Retry')} tip={t('Visual search model download failed. Check your connection and try again.')} />
    default:
      return null
  }
}
